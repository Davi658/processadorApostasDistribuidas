import { MoneyObjectDto } from './common.dto';

export interface WagerTransactionQueryResponseDto {
  id: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyObjectDto;
  status: string;
  rejectionReason: string | null;
  referenceExternalTransactionId: string | null;
  createdAt: string;
  updatedAt: string;
}
