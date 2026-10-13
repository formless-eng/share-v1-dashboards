export enum WindowSize {
  DAY = "day",
  WEEK = "week",
  MONTH = "month",
  YEAR = "year",
}

export interface ITransaction {
  tx_hash?: string;
  block_signed_at?: string;
  value_quote: string | number;
  successful: boolean;
  to_address?: string;
  value: string;
  // Set on multi-chain results so that each transaction can be
  // linked to the right block explorer.
  network_id?: number;
}

export interface IDashboardManager {
  fetchContractTxHistoryByRecipient(
    contractAddress: string,
    chainId: number,
    recipientAddress: string
  ): Promise<ITransaction[]>;

  fetchSingleChainTxHistoryByRecipient(
    recipientAddress: string,
    chainId: number
  ): Promise<ITransaction[]>;

  fetchMultiChainTxHistoryByRecipient(
    recipientAddress: string,
    chainIds: number[],
    windowDays: number
  ): Promise<ITransaction[]>;

  bucketTransactionsByTime(
    transactions: ITransaction[],
    windowSize: WindowSize
  ): {};

  sumKeyMetricsUsingTransactions(
    transactions: { value_quote: string }[],
    timestampLowerBound: number
  ): { revenue: number; transactions: number };

  analyzeDataTrendUsingBuckets(
    buckets: {
      revenue: number;
      transactions: { value_quote: string }[];
    }[]
  ): { revenueTrend: number; transactionTrend: number };

  fetchSplitRevenueByRecipient(
    contractAddress: string,
    chainId: number,
    recipientAddress: string
  ): Promise<number>;
}
