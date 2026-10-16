import { MoneyObjectDto } from './common.dto';

export interface CreateWalletDto {
  playerId: string;
  initialBalance?: MoneyObjectDto;
}

export interface WalletResponseDto {
  id: string;
  playerId: string;
  balance: MoneyObjectDto;
  version: number;
}

export interface ReconciliationResponseDto {
  walletId: string;
  storedBalance: MoneyObjectDto;
  calculatedBalance: MoneyObjectDto;
  difference: MoneyObjectDto;
  consistent: boolean;
  checkedEntries: number;
}
