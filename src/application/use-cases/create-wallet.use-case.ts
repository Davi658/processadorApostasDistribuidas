import { Wallet } from '../../domain/entities/wallet.entity';
import { Money } from '../../domain/value-objects/money.vo';
import { DuplicateWalletError, InvalidMoneyError } from '../../domain/errors/domain.error';
import { CreateWalletDto, WalletResponseDto } from '../dto/wallet.dto';
import {
  OutboxRepositoryPort,
  UnitOfWorkPort,
  WalletLedgerRepositoryPort,
  WalletRepositoryPort,
  WagerTransactionRepositoryPort,
} from '../ports/ports';

export class CreateWalletUseCase {
  constructor(
    private readonly walletRepo: WalletRepositoryPort,
    private readonly wagerRepo: WagerTransactionRepositoryPort,
    private readonly ledgerRepo: WalletLedgerRepositoryPort,
    private readonly outboxRepo: OutboxRepositoryPort,
    private readonly uow: UnitOfWorkPort
  ) {}

  public async execute(dto: CreateWalletDto): Promise<WalletResponseDto> {
    if (!dto.playerId || typeof dto.playerId !== 'string' || dto.playerId.trim() === '') {
      throw new InvalidMoneyError('playerId is required and must be a non-empty string');
    }

    const currency = (dto.currency ?? 'BRL').trim().toUpperCase();
    if (currency !== 'BRL') {
      throw new InvalidMoneyError('Only BRL currency is currently supported');
    }

    const initialMoney = dto.initialBalance ? Money.create(dto.initialBalance, currency) : Money.zero(currency);

    return this.uow.runInTransaction(async () => {
      const existing = await this.walletRepo.findByPlayerIdAndCurrency(dto.playerId.trim(), currency);
      if (existing) {
        throw new DuplicateWalletError(dto.playerId.trim(), currency);
      }

      const walletId = crypto.randomUUID();
      const creationResult = Wallet.create({
        id: walletId,
        playerId: dto.playerId.trim(),
        currency,
        initialBalance: initialMoney,
      });

      await this.walletRepo.save(creationResult.wallet);

      if (creationResult.openingTransaction) {
        await this.wagerRepo.save(creationResult.openingTransaction);
      }

      if (creationResult.ledgerEntry) {
        await this.ledgerRepo.save(creationResult.ledgerEntry);
      }

      return {
        walletId: creationResult.wallet.id,
        playerId: creationResult.wallet.playerId,
        currency: creationResult.wallet.currency,
        balance: creationResult.wallet.balance.getAmount(),
        version: creationResult.wallet.version,
        createdAt: creationResult.wallet.createdAt,
        updatedAt: creationResult.wallet.updatedAt,
      };
    });
  }
}
