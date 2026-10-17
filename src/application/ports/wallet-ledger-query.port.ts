import { LedgerKeysetCursor, WalletLedgerEntryQueryResponseDto } from '../dto/query-wallet-ledger.dto';

export interface WalletLedgerQueryResult {
  items: WalletLedgerEntryQueryResponseDto[];
  hasMore: boolean;
  nextCursorData?: LedgerKeysetCursor;
}

export interface WalletLedgerQueryPort {
  queryLedgerKeyset(params: {
    walletId: string;
    limit: number;
    cursor?: LedgerKeysetCursor;
  }): Promise<WalletLedgerQueryResult>;
}
