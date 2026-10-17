import type { MoneyObjectDto } from '../dto/common.dto';

export interface TransactionQueryDto {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  gameId: string;
  kind: string;
  status: string;
  money: MoneyObjectDto;
  referenceExternalTransactionId: string | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerQueryDto {
  id: string;
  walletId: string;
  transactionId: string;
  entryType: 'CREDIT' | 'DEBIT';
  money: MoneyObjectDto;
  balanceBefore: MoneyObjectDto;
  balanceAfter: MoneyObjectDto;
  createdAt: string;
}

export interface LedgerPosition { createdAt: string; id: string }

/** Read projection only: no financial repositories or unit of work. */
export abstract class FinancialQueriesPort {
  abstract transactionById(id: string): Promise<TransactionQueryDto | null>;
  abstract transactionByExternal(providerId: string, externalId: string): Promise<TransactionQueryDto | null>;
  abstract walletExists(walletId: string): Promise<boolean>;
  abstract ledger(walletId: string, limit: number, after?: LedgerPosition): Promise<LedgerQueryDto[]>;
}
