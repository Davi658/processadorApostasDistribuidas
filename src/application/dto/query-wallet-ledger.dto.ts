import { MoneyObjectDto } from './common.dto';

export interface WalletLedgerEntryQueryResponseDto {
  id: string;
  walletId: string;
  transactionId: string;
  entryType: 'CREDIT' | 'DEBIT';
  amount: MoneyObjectDto;
  balanceBefore: MoneyObjectDto;
  balanceAfter: MoneyObjectDto;
  createdAt: string;
}

export interface WalletLedgerPageResponseDto {
  items: WalletLedgerEntryQueryResponseDto[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

export interface LedgerKeysetCursor {
  walletId: string;
  createdAt: string;
  id: string;
}

export interface GetWalletLedgerQueryDto {
  walletId: string;
  limit: number;
  cursor?: LedgerKeysetCursor;
}
