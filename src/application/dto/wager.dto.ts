import { MoneyObjectDto } from './common.dto';

export interface ProcessBetDto {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: 'BET';
  money: MoneyObjectDto;
}

export interface WagerResponseDto {
  transactionId: string;
  status: 'PROCESSED' | 'REJECTED';
  balance: MoneyObjectDto;
  failureCode?: string;
  idempotentReplay: boolean;
}
