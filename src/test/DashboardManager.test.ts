import { describe } from "@jest/globals";
import {
  DashboardManager,
  USDC_TOKEN_ADDRESSES,
} from "../lib/DashboardManager";
import { WindowSize } from "../lib/IDashboardManager";

const _PFA_TRANSFERS_OUT = require("./fixtures/usdc_transfers/pfa_transfers_out.json");
const _SPLIT_TRANSFERS_OUT = require("./fixtures/usdc_transfers/split_transfers_out.json");
const _WALLET_WITH_BATCH_SPLITS_TRANSFERS_IN = require("./fixtures/usdc_transfers/wallet_with_batch_splits_transfers_in.json");
const _WALLET_WITH_BATCH_SPLITS_AGGREGATED_TXNS = require("./fixtures/usdc_transfers/wallet_with_batch_splits_aggregated_txns.json");

const NETWORK_ID_BASE = 8453;
const _PFA_CONTRACT_ADDRESS =
  "0x1d7e1d5f2d5d6bd685f1401b7885dc14ab70d4dc";
const _SPLIT_CONTRACT_ADDRESS =
  "0xd077635d8c035f96f858e93de0ada78719122719";
const _USER_WALLET_ADDRESS_1 =
  "0x99bc0db717adbcfe35020b8ae6a0f736389052c2";
const _USER_WALLET_ADDRESS_2 =
  "0xF6f3AA6Cf487b6ccFF2899B6e9f466223B7C206A";

const _silentLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
};

function makeDashboardManager() {
  return new DashboardManager({
    fetchRPCEndpoint: async () => "http://localhost",
    log: _silentLogger,
  });
}

function mockTransfersByAddress() {
  return jest
    .spyOn(DashboardManager.prototype, "_fetchAssetTransfers")
    .mockImplementation(async (_chainId, requestParams) => {
      const params = requestParams as Record<string, string>;
      const address = (
        params.fromAddress ?? params.toAddress
      ).toLowerCase();
      if (params.fromAddress && address === _PFA_CONTRACT_ADDRESS) {
        return { transfers: _PFA_TRANSFERS_OUT };
      } else if (
        params.fromAddress &&
        address === _SPLIT_CONTRACT_ADDRESS
      ) {
        return { transfers: _SPLIT_TRANSFERS_OUT };
      } else if (
        params.toAddress &&
        address === _USER_WALLET_ADDRESS_2.toLowerCase()
      ) {
        return { transfers: _WALLET_WITH_BATCH_SPLITS_TRANSFERS_IN };
      }
      return { transfers: [] };
    });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("DashboardManager USDC transfer fetching", () => {
  test("fetchContractTxHistoryByRecipient with song revenue returns 10 USDC payments received via SL2RD with batching enabled", async () => {
    mockTransfersByAddress();
    const dashboardManager = makeDashboardManager();
    const transactionHistory =
      await dashboardManager.fetchContractTxHistoryByRecipient(
        _PFA_CONTRACT_ADDRESS,
        NETWORK_ID_BASE,
        _USER_WALLET_ADDRESS_1,
        Infinity
      );
    expect(transactionHistory).toHaveLength(10);
    transactionHistory.forEach((transaction) => {
      expect(transaction).toStrictEqual({
        tx_hash:
          "0x0d1ec49e98e4997da1a6a17546c05f66346be563f15bf0b7cf0312b01b7ec947",
        block_signed_at: "2025-01-31T12:53:43.000Z",
        value_quote: 0.1,
        successful: true,
        to_address: _USER_WALLET_ADDRESS_1,
        value: "100000",
      });
    });
  });

  test("fetchSplitRevenueByRecipient sums USDC paid to the recipient through the splits contract", async () => {
    mockTransfersByAddress();
    const dashboardManager = makeDashboardManager();
    expect(
      await dashboardManager.fetchSplitRevenueByRecipient(
        _PFA_CONTRACT_ADDRESS,
        NETWORK_ID_BASE,
        _USER_WALLET_ADDRESS_1
      )
    ).toBeCloseTo(1.0);
  });

  test("fetchMultiChainTxHistoryByRecipient with collection revenue returns 14 aggregated USDC payments received via SL2RD with batching enabled", async () => {
    mockTransfersByAddress();
    const dashboardManager = makeDashboardManager();
    const transactionHistory =
      await dashboardManager.fetchMultiChainTxHistoryByRecipient(
        _USER_WALLET_ADDRESS_2,
        [NETWORK_ID_BASE],
        Infinity
      );
    expect(
      transactionHistory.map((transaction) => ({
        tx_hash: transaction.tx_hash,
        block_signed_at: transaction.block_signed_at,
        value: transaction.value,
      }))
    ).toEqual(_WALLET_WITH_BATCH_SPLITS_AGGREGATED_TXNS);
    transactionHistory.forEach((transaction) => {
      expect(Number(transaction.value_quote)).toBeCloseTo(
        Number(transaction.value) / 1e6
      );
      expect(transaction.network_id).toBe(NETWORK_ID_BASE);
    });
  });

  test("_fetchUSDCTransfers requests USDC transfers and pages until the window is exceeded", async () => {
    const recentTransfer = {
      ..._SPLIT_TRANSFERS_OUT[0],
      metadata: { blockTimestamp: new Date().toISOString() },
    };
    const fetchSpy = jest
      .spyOn(DashboardManager.prototype, "_fetchAssetTransfers")
      .mockResolvedValueOnce({
        transfers: [recentTransfer],
        pageKey: "page-2",
      })
      .mockResolvedValueOnce({
        transfers: _SPLIT_TRANSFERS_OUT,
        pageKey: "page-3",
      });
    const dashboardManager = makeDashboardManager();
    const transactions = await dashboardManager._fetchUSDCTransfers(
      _SPLIT_CONTRACT_ADDRESS,
      NETWORK_ID_BASE,
      30,
      "OUT"
    );
    // The second page reaches transfers older than 30 days, so the
    // third page is never requested and the older transfers, which
    // may be an incomplete batch, are dropped.
    expect(transactions).toHaveLength(1);
    expect(transactions[0].block_signed_at).toBe(
      recentTransfer.metadata.blockTimestamp
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({
      fromAddress: _SPLIT_CONTRACT_ADDRESS,
      contractAddresses: [USDC_TOKEN_ADDRESSES[NETWORK_ID_BASE]],
      category: ["erc20"],
      withMetadata: true,
      order: "desc",
    });
    expect(fetchSpy.mock.calls[0][1]).not.toHaveProperty("toAddress");
    expect(fetchSpy.mock.calls[1][1]).toMatchObject({
      pageKey: "page-2",
    });
  });
});

describe("DashboardManager chart buckets", () => {
  function localISOString(daysAgo: number, hour: number) {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    date.setHours(hour, 0, 0, 0);
    return date.toISOString();
  }

  test("bucketTransactionsByTime puts a transaction in the bucket labeled with its local date", () => {
    const dashboardManager = makeDashboardManager();
    const earlyMorning = new Date(localISOString(19, 0));
    earlyMorning.setMinutes(30);
    const lateNight = new Date(localISOString(19, 23));
    const buckets = dashboardManager.bucketTransactionsByTime(
      [
        {
          block_signed_at: earlyMorning.toISOString(),
          value_quote: "0.005",
        },
        {
          block_signed_at: lateNight.toISOString(),
          value_quote: "0.002",
        },
      ] as never,
      WindowSize.MONTH
    ) as { name: string; revenue: number }[];
    const label = earlyMorning.toLocaleDateString("en-US", {
      month: "numeric",
      day: "numeric",
    });
    const labeledBuckets = buckets.filter(
      (bucket) => bucket.name === label
    );
    expect(labeledBuckets).toHaveLength(1);
    // Sub-cent revenue is preserved rather than rounded per bucket.
    expect(labeledBuckets[0].revenue).toBeCloseTo(0.007);
    expect(
      buckets.reduce((total, bucket) => total + bucket.revenue, 0)
    ).toBeCloseTo(0.007);
  });

  test("the most recent bucket for each window contains a transaction made now", () => {
    const dashboardManager = makeDashboardManager();
    [
      WindowSize.DAY,
      WindowSize.WEEK,
      WindowSize.MONTH,
      WindowSize.YEAR,
    ].forEach((windowSize) => {
      const buckets = dashboardManager.bucketTransactionsByTime(
        [
          {
            block_signed_at: new Date().toISOString(),
            value_quote: "1",
          },
        ] as never,
        windowSize
      ) as { revenue: number }[];
      expect(buckets[buckets.length - 1].revenue).toBe(1);
    });
  });
});

describe("DashboardManager split payment graph traversal", () => {
  // Mirrors a PFA collection on Base: the collection pays its owner
  // (a wallet with no outgoing USDC) and each item's PFA many times,
  // and the item PFA forwards to an SL2RD splits contract that pays
  // several payees, including the recipient.
  const _COLLECTION = "0xc011ec7100000000000000000000000000000000";
  const _OWNER = "0x0000000000000000000000000000000000000a11";
  const _ITEM_PFA = "0x1000000000000000000000000000000000000001";
  const _OTHER_ITEM_PFA = "0x1000000000000000000000000000000000000002";
  const _SPLITS = "0x5000000000000000000000000000000000000005";
  const _OTHER_PAYEE = "0x0000000000000000000000000000000000000b0b";
  const _RECIPIENT = "0x0000000000000000000000000000000000000c0c";

  function transfer(from: string, to: string, value: string) {
    return {
      hash: `0x${from.slice(2, 10)}${to.slice(2, 10)}`,
      from,
      to,
      rawContract: { value, address: null, decimal: "0x6" },
      metadata: { blockTimestamp: "2026-05-10T13:28:55.000Z" },
    };
  }

  const _OUTGOING_TRANSFERS: Record<string, object[]> = {
    [_COLLECTION]: [
      ...Array(39).fill(transfer(_COLLECTION, _OWNER, "0x2dc6c0")),
      ...Array(13).fill(transfer(_COLLECTION, _ITEM_PFA, "0x1e8480")),
      ...Array(13).fill(transfer(_COLLECTION, _OTHER_ITEM_PFA, "0x1e8480")),
    ],
    [_ITEM_PFA]: Array(13).fill(transfer(_ITEM_PFA, _SPLITS, "0x1e8480")),
    [_SPLITS]: [
      // A payment to another payee is listed before the recipient's.
      ...Array(13).fill(transfer(_SPLITS, _OTHER_PAYEE, "0x30d40")),
      ...Array(39).fill(transfer(_SPLITS, _RECIPIENT, "0x30d40")),
    ],
  };

  test("fetchContractTxHistoryByRecipient finds split payments 3 hops from a collection and fetches each address once", async () => {
    const fetchSpy = jest
      .spyOn(DashboardManager.prototype, "_fetchAssetTransfers")
      .mockImplementation(async (_chainId, requestParams) => {
        const params = requestParams as Record<string, string>;
        return {
          transfers: (_OUTGOING_TRANSFERS[params.fromAddress] ??
            []) as never,
        };
      });
    const dashboardManager = makeDashboardManager();
    const transactions =
      await dashboardManager.fetchContractTxHistoryByRecipient(
        _COLLECTION,
        NETWORK_ID_BASE,
        _RECIPIENT
      );
    expect(transactions).toHaveLength(39);
    expect(
      transactions.every((txn) => txn.to_address === _RECIPIENT)
    ).toBe(true);
    const fetchedAddresses = fetchSpy.mock.calls.map(
      (call) => (call[1] as Record<string, string>).fromAddress
    );
    expect(new Set(fetchedAddresses).size).toBe(fetchedAddresses.length);
    // Payees of the splits contract are 4 hops away and not fetched.
    expect(fetchedAddresses).not.toContain(_OTHER_PAYEE);
  });
});
