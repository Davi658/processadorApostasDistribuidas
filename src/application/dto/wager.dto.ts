import { MoneyObjectDto } from './common.dto';

export type WagerOperationKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

export interface ProcessWagerDto {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerOperationKind;
  money: MoneyObjectDto;
  referenceExternalTransactionId?: string;
  correlationId?: string;
}

export type ProcessBetDto = ProcessWagerDto;

export interface WagerResponseDto {
  transactionId: string;
  status: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE';
  balance: MoneyObjectDto;
  failureCode?: string;
  idempotentReplay: boolean;
}
