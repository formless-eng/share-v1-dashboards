import {
  IDashboardManager,
  ITransaction,
  WindowSize,
} from "./IDashboardManager";
import pRetry from "p-retry";
import regression from "regression";
import { formatUnits } from "viem";

const _MAX_TRANSACTION_GRAPH_BFS_DEPTH = 3;
const _USDC_DECIMALS = 6;
const _MAX_TRANSFERS_PER_PAGE = "0x3e8"; // 1000, the API maximum
const _DEFAULT_MAX_TRANSFERS_PAGE_COUNT = 1000;

export const USDC_TOKEN_ADDRESSES: Record<number, string> = {
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  137: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
  10: "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
};

type TransferDirection = "IN" | "OUT";

/**
 * A single ERC20 transfer as returned by the
 * `alchemy_getAssetTransfers` JSON-RPC method.
 */
interface IAssetTransfer {
  hash: string;
  from: string;
  to: string | null;
  rawContract: {
    value: string | null;
    address: string | null;
    decimal: string | null;
  };
  metadata: {
    blockTimestamp: string;
  };
}

interface IAssetTransfersResult {
  transfers: IAssetTransfer[];
  pageKey?: string;
}

/**
 * Analytics that can be used to measure the performance of an asset
 * or assets.
 */
export interface IKeyPerformanceIndicators {
  totalRevenue: number;
  totalTransactions: number;
}

export interface IDashboardLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * App specific dependencies, supplied by each app that uses the
 * dashboard (see the app's managers/DashboardManager.ts).
 */
export interface IDashboardManagerConfig {
  // Resolves the JSON-RPC endpoint (which must support
  // `alchemy_getAssetTransfers`) for a chain.
  fetchRPCEndpoint: (chainId: number) => Promise<string>;
  log?: IDashboardLogger;
  // Upper bound on the transfer pages requested per address.
  maxTransfersPageCount?: number;
}

function _timestampFromISOString(ISOTimestamp: string): number {
  return new Date(ISOTimestamp).getTime();
}

function _unixTimestampSeconds(): number {
  return Date.now() / 1000;
}

// Cache the RPC endpoint lookup per chain, the transaction graph
// traversal can otherwise request it dozens of times per page load.
const _rpcEndpointsByChainId = new Map<number, Promise<string>>();

function _getRPCEndpoint(
  chainId: number,
  fetchRPCEndpoint: (chainId: number) => Promise<string>
): Promise<string> {
  let endpoint = _rpcEndpointsByChainId.get(chainId);
  if (!endpoint) {
    endpoint = fetchRPCEndpoint(chainId).catch((error) => {
      _rpcEndpointsByChainId.delete(chainId);
      throw error;
    });
    _rpcEndpointsByChainId.set(chainId, endpoint);
  }
  return endpoint;
}

/**
 * Builds dashboard analytics from USDC transfers, read from the
 * chain's JSON-RPC node via `alchemy_getAssetTransfers`. All
 * payments on SHARE are made in USDC, so incoming USDC transfers are
 * the complete revenue history for a wallet or contract.
 */
export class DashboardManager implements IDashboardManager {
  _config: IDashboardManagerConfig;
  _log: IDashboardLogger;

  constructor(config: IDashboardManagerConfig) {
    this._config = config;
    this._log = config.log ?? console;
  }

  async _fetchAssetTransfers(
    chainId: number,
    params: object
  ): Promise<IAssetTransfersResult> {
    const rpcEndpoint = await _getRPCEndpoint(
      chainId,
      this._config.fetchRPCEndpoint
    );
    const run = async () => {
      const response = await fetch(rpcEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "alchemy_getAssetTransfers",
          params: [params],
        }),
      });
      const responseJSON = await response.json();
      if (responseJSON.error) {
        throw new Error(JSON.stringify(responseJSON.error));
      }
      return responseJSON.result as IAssetTransfersResult;
    };
    return pRetry(run, {
      onFailedAttempt: async (error) => {
        this._log.debug(
          `Attempt ${error.attemptNumber} failed. ${error.retriesLeft} retries left.`
        );
      },
      retries: 10,
      minTimeout: 20,
      maxTimeout: 1000,
      randomize: true,
    });
  }

  _transferToTransaction(transfer: IAssetTransfer): ITransaction {
    const value = BigInt(transfer.rawContract.value ?? 0);
    return {
      tx_hash: transfer.hash,
      block_signed_at: transfer.metadata.blockTimestamp,
      value_quote: Number(formatUnits(value, _USDC_DECIMALS)),
      successful: true,
      to_address: transfer.to ?? undefined,
      value: value.toString(),
    };
  }

  /**
   * Fetches USDC transfers into (IN) or out of (OUT) an address,
   * most recent first, paging until transfers are older than
   * `windowDays`.
   */
  async _fetchUSDCTransfers(
    address: string,
    chainId: number,
    windowDays: number = Infinity,
    direction: TransferDirection = "IN"
  ): Promise<ITransaction[]> {
    if (process.env.REACT_APP_CI === "true") {
      this._log.info("Bypassing transfers request for CI.");
      return [];
    }
    const usdcAddress =
USDC_TOKEN_ADDRESSES[chainId];
    if (!usdcAddress) {
      return [];
    }
    const lowerBoundSeconds =
      _unixTimestampSeconds() - windowDays * 24 * 3600;
    const transfers: IAssetTransfer[] = [];
    let pageKey: string | undefined = undefined;
    let pageCount = 0;
    do {
      const result: IAssetTransfersResult =
        await this._fetchAssetTransfers(chainId, {
          fromBlock: "0x0",
          toBlock: "latest",
          [direction === "IN" ? "toAddress" : "fromAddress"]: address,
          contractAddresses: [usdcAddress],
          category: ["erc20"],
          withMetadata: true,
          excludeZeroValue: true,
          order: "desc",
          maxCount: _MAX_TRANSFERS_PER_PAGE,
          ...(pageKey ? { pageKey } : {}),
        });
      transfers.push(...(result?.transfers ?? []));
      pageKey = result?.pageKey;
      pageCount += 1;

      const oldestTransfer = transfers[transfers.length - 1];
      if (
        oldestTransfer &&
        _timestampFromISOString(oldestTransfer.metadata.blockTimestamp) /
          1000 <
          lowerBoundSeconds
      ) {
        break;
      }
    } while (pageKey && pageCount <
        (this._config.maxTransfersPageCount ??
          _DEFAULT_MAX_TRANSFERS_PAGE_COUNT));
    // Drop transfers outside the window. Paging stops mid-way through
    // the history, so the oldest transaction on the last page may be
    // missing some of its transfers (e.g. batched split payments).
    return transfers
      .filter(
        (transfer) =>
          _timestampFromISOString(transfer.metadata.blockTimestamp) /
            1000 >=
          lowerBoundSeconds
      )
      .map((transfer) => this._transferToTransaction(transfer));
  }

  /**
   * Combines multiple transfers within the same transaction (e.g.
   * batched split payments) into a single transaction.
   */
  aggregateUSDCTransactions(
    transactions: ITransaction[]
  ): ITransaction[] {
    const txMap = new Map<string, ITransaction>();
    transactions.forEach((transaction) => {
      const knownTx = txMap.get(transaction.tx_hash as string);
      if (knownTx) {
        txMap.set(transaction.tx_hash as string, {
          ...knownTx,
          value: (
            BigInt(knownTx.value) + BigInt(transaction.value)
          ).toString(),
          value_quote: String(
            Number(knownTx.value_quote) +
              Number(transaction.value_quote)
          ),
        });
      } else {
        txMap.set(transaction.tx_hash as string, transaction);
      }
    });
    return Array.from(txMap.values());
  }

  async fetchSingleChainTxHistoryByRecipient(
    recipientAddress: string,
    chainId: number,
    windowDays: number = Infinity
  ): Promise<ITransaction[]> {
    try {
      return this.aggregateUSDCTransactions(
        await this._fetchUSDCTransfers(
          recipientAddress,
          chainId,
          windowDays
        )
      );
    } catch (error) {
      // NOTE: This error is monitored in GCP,
      // do not change the message unless you are
      // also going to update the trigger.
      // -brandon 2024-10-30
      // https://console.cloud.google.com/monitoring/alerting/policies/188561432001037140?project=share-336018
      this._log.error(
        "fetchSingleChainTxHistoryByRecipient error",
        JSON.stringify({
          error: error,
          arguments: {
            recipient_address: recipientAddress,
            chain_id: chainId,
            window: windowDays,
          },
        })
      );
      return [];
    }
  }

  async fetchMultiChainTxHistoryByRecipient(
    recipientAddress: string,
    chainIds: number[],
    windowDays: number = 365
  ): Promise<ITransaction[]> {
    const results = await Promise.all(
      chainIds.map((chainId) =>
        this.fetchSingleChainTxHistoryByRecipient(
          recipientAddress,
          chainId,
          windowDays
        )
      )
    );
    // Tag each transaction with the chain it was fetched from so that
    // it can be linked to the right block explorer.
    return results.flatMap((transactions, i) =>
      transactions.map((transaction) => ({
        ...transaction,
        network_id: chainIds[i],
      }))
    );
  }

  /**
   * Finds USDC paid to `recipientAddress` that originated from
   * `contractAddress`, following outgoing transfers through
   * intermediate contracts (e.g. PFA collection -> PFA -> SL2RD
   * splits -> recipient), up to _MAX_TRANSACTION_GRAPH_BFS_DEPTH
   * hops from the contract.
   */
  async fetchContractTxHistoryByRecipient(
    contractAddress: string,
    chainId: number,
    recipientAddress: string,
    windowDays: number = Infinity
  ): Promise<ITransaction[]> {
    try {
      const recipient = recipientAddress?.toLowerCase();
      const visited = new Set<string>([contractAddress.toLowerCase()]);
      const usdcTransactions: ITransaction[] = [];
      let frontier: string[] = [contractAddress];
      for (
        let depth = 0;
        depth < _MAX_TRANSACTION_GRAPH_BFS_DEPTH && frontier.length > 0;
        depth++
      ) {
        const transfersByNode = await Promise.all(
          frontier.map((node) =>
            this._fetchUSDCTransfers(node, chainId, windowDays, "OUT")
          )
        );
        const nextFrontier: string[] = [];
        for (const txn of transfersByNode.flat()) {
          const to = txn.to_address?.toLowerCase();
          if (!to) continue;
          if (to === recipient) {
            usdcTransactions.push(txn);
          } else if (!visited.has(to)) {
            visited.add(to);
            nextFrontier.push(to);
          }
        }
        frontier = nextFrontier;
      }
      return usdcTransactions;
    } catch (error) {
      this._log.error("fetchContractTxHistoryByRecipient error", error);
      throw error;
    }
  }

  async fetchSplitRevenueByRecipient(
    contractAddress: string,
    chainId: number,
    recipientAddress: string
  ): Promise<number> {
    const transactions = await this.fetchContractTxHistoryByRecipient(
      contractAddress,
      chainId,
      recipientAddress
    );
    return transactions.reduce(
      (total, transaction) => total + Number(transaction.value_quote),
      0
    );
  }

  _makeBucket(start: Date, end: Date, name: string) {
    return {
      name: name,
      lower_bound: start.getTime() / 1000,
      upper_bound: end.getTime() / 1000,
      transactions: [],
      revenue: 0,
    };
  }

  /**
   * Buckets are aligned to local calendar boundaries (hour starts,
   * midnight) so that a bucket labeled with a date contains exactly
   * the transactions made on that date. The most recent bucket is
   * the current hour, day or week, which is still in progress.
   */
  _makeTransactionBuckets(windowSize: WindowSize) {
    const buckets = [];
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    switch (windowSize) {
      case WindowSize.DAY:
        {
          const startOfHour = new Date();
          startOfHour.setMinutes(0, 0, 0);
          for (let i = 0; i < 24; i++) {
            const start = new Date(startOfHour);
            start.setHours(startOfHour.getHours() - (23 - i));
            const end = new Date(start);
            end.setHours(start.getHours() + 1);
            const name = start.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });
            buckets.push(this._makeBucket(start, end, name));
          }
        }
        break;

      case WindowSize.WEEK:
      case WindowSize.MONTH:
        {
          const days = windowSize === WindowSize.WEEK ? 7 : 30;
          for (let i = 0; i < days; i++) {
            const start = new Date(startOfToday);
            start.setDate(startOfToday.getDate() - (days - 1 - i));
            const end = new Date(start);
            end.setDate(start.getDate() + 1);
            const name = start.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
            buckets.push(this._makeBucket(start, end, name));
          }
        }
        break;

      case WindowSize.YEAR:
        {
          // 52 weeks, the last of which ends at the end of today.
          for (let i = 0; i < 52; i++) {
            const start = new Date(startOfToday);
            start.setDate(startOfToday.getDate() - 7 * (51 - i) - 6);
            const end = new Date(start);
            end.setDate(start.getDate() + 7);
            const name = start.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
            buckets.push(this._makeBucket(start, end, name));
          }
        }
        break;

      default:
        {
          const _LOWER_BOUND = 0;
          for (let i = 0; i < 52; i++) {
            const timestamp = (_LOWER_BOUND + i * 30 * 86400) * 1000;
            const date = new Date(timestamp);
            const name = date.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
            buckets.push({
              name: name,
              lower_bound: _LOWER_BOUND + i * 30 * 86400,
              upper_bound: _LOWER_BOUND + (i + 1) * 30 * 86400,
              transactions: [],
              revenue: 0,
            });
          }
        }
        break;
    }
    return buckets;
  }

  _getBucketNumber(
    timestamp: number,
    buckets: [{ lower_bound: number; upper_bound: number }]
  ) {
    for (let i = 0; i < buckets.length; i++) {
      const bucket = buckets[i];
      if (
        timestamp >= bucket.lower_bound &&
        timestamp < bucket.upper_bound
      ) {
        return i;
      }
    }
    return -1;
  }

  bucketTransactionsByTime(transactions: [], windowSize: WindowSize) {
    if (!transactions) return [];
    const buckets = this._makeTransactionBuckets(windowSize);
    const sortedTransactions = transactions.sort(
      (
        a: { block_signed_at: string },
        b: { block_signed_at: string }
      ): number => {
        return _timestampFromISOString(a.block_signed_at) >
          _timestampFromISOString(b.block_signed_at)
          ? -1
          : 1;
      }
    );
    sortedTransactions.forEach(
      (transaction: {
        block_signed_at: string;
        value_quote: string;
      }) => {
        const bucketNumber = this._getBucketNumber(
          _timestampFromISOString(transaction.block_signed_at) / 1000,
          // @ts-ignore
          buckets
        );
        if (bucketNumber >= 0) {
          // @ts-ignore
          buckets[bucketNumber].transactions?.push(transaction);
          // Keep full precision, sub-cent payments would otherwise
          // round to $0. Rounding happens when the value is displayed.
          buckets[bucketNumber].revenue += +transaction?.value_quote;
        }
      }
    );
    return buckets;
  }

  sumKeyMetricsUsingTransactions(
    transactions: {
      value_quote: string;
      block_signed_at: string;
      tx_hash?: string;
    }[],
    timestampLowerBound: number
  ) {
    let totalRevenue = 0;
    let totalTransactions = 0;
    const sortedTransactions = transactions.sort(
      (
        a: { block_signed_at: string },
        b: { block_signed_at: string }
      ): number => {
        return _timestampFromISOString(a.block_signed_at) >
          _timestampFromISOString(b.block_signed_at)
          ? -1
          : 1;
      }
    );
    sortedTransactions.forEach((transaction) => {
      if (
        _timestampFromISOString(transaction.block_signed_at) >=
        timestampLowerBound
      ) {
        totalRevenue += +transaction.value_quote;
        totalTransactions += 1;
      }
    });
    return {
      revenue: totalRevenue,
      transactions: totalTransactions,
    };
  }

  analyzeDataTrendUsingBuckets(
    buckets: {
      revenue: number;
      transactions: { value_quote: string }[];
    }[]
  ) {
    const revenueAnalysis = regression.linear([
      ...buckets.map((bucket, index) => [index, +bucket.revenue]),
    ]);
    const transactionAnalysis = regression.linear([
      ...buckets.map((bucket, index) => [
        index,
        bucket.transactions.length,
      ]),
    ]);
    return {
      revenueTrend: revenueAnalysis.equation[0] * 100.0,
      transactionTrend: transactionAnalysis.equation[0] * 100.0,
    };
  }
}
