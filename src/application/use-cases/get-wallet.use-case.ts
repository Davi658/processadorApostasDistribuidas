import { WalletNotFoundError } from '../../domain/errors/domain.error';
import { WalletResponseDto } from '../dto/wallet.dto';
import { WalletRepositoryPort } from '../ports/ports';

export class GetWalletUseCase {
  constructor(private readonly walletRepo: WalletRepositoryPort) {}

  public async execute(walletId: string): Promise<WalletResponseDto> {
    if (!walletId || typeof walletId !== 'string' || walletId.trim() === '') {
      throw new WalletNotFoundError(walletId);
    }

    const wallet = await this.walletRepo.findById(walletId.trim(), false);
    if (!wallet) {
      throw new WalletNotFoundError(walletId.trim());
    }

    return {
      walletId: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.getAmount(),
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }
}
