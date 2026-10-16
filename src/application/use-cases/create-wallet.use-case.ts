import { Wallet } from '../../domain/entities/wallet.entity';
import { Money } from '../../domain/value-objects/money.vo';
import { DuplicateWalletError } from '../../domain/errors/domain.error';
import {
  WagerTransactionProcessedEvent,
  WalletBalanceChangedEvent,
} from '../../domain/events/events';
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
    const currency = 'BRL';
    const initialAmount = dto.initialBalance?.amount ?? '0.00';
    const initialMoney = Money.create(initialAmount, currency);

    try {
      return await this.uow.runInTransaction(async () => {
        const existing = await this.walletRepo.findByPlayerIdAndCurrency(dto.playerId, currency);
        if (existing) {
          throw new DuplicateWalletError(dto.playerId, currency);
        }

        const walletId = crypto.randomUUID();
        const creationResult = Wallet.create({
          id: walletId,
          playerId: dto.playerId,
          currency,
          initialBalance: initialMoney,
        });

        await this.walletRepo.save(creationResult.wallet);

        if (creationResult.openingTransaction) {
          await this.wagerRepo.save(creationResult.openingTransaction);
        }

        if (creationResult.ledgerEntry) {
          await this.ledgerRepo.save(creationResult.ledgerEntry);

          // Outbox events for positive initial opening balance
          const openingProcessedEvent = new WagerTransactionProcessedEvent({
            aggregateId: walletId,
            correlationId: creationResult.openingTransaction!.id,
            data: {
              transactionId: creationResult.openingTransaction!.id,
              walletId,
              playerId: dto.playerId,
              providerId: 'SYSTEM',
              externalTransactionId: `OPENING_${walletId}`,
              roundId: 'OPENING',
              gameId: 'OPENING',
              kind: 'OPENING',
              amount: {
                amount: initialMoney.getAmount(),
                currency,
              },
              balance: {
                amount: initialMoney.getAmount(),
                currency,
              },
            },
          });
          await this.outboxRepo.save(openingProcessedEvent);

          const balanceChangedEvent = new WalletBalanceChangedEvent({
            aggregateId: walletId,
            correlationId: creationResult.openingTransaction!.id,
            data: {
              walletId,
              playerId: dto.playerId,
              currency,
              previousBalance: {
                amount: '0.00',
                currency,
              },
              currentBalance: {
                amount: initialMoney.getAmount(),
                currency,
              },
              version: 1,
              triggerTransactionId: creationResult.openingTransaction!.id,
            },
          });
          await this.outboxRepo.save(balanceChangedEvent);
        }

        return {
          id: creationResult.wallet.id,
          playerId: creationResult.wallet.playerId,
          balance: {
            amount: creationResult.wallet.balance.getAmount(),
            currency: creationResult.wallet.currency,
          },
          version: creationResult.wallet.version,
        };
      });
    } catch (error: any) {
      const pgError = error?.cause ?? error;
      if (pgError?.code === '23505') {
        const constraint = String(pgError.constraint || '');
        if (constraint.includes('uq_wallets_player_currency') || constraint.includes('wallets_pkey')) {
          throw new DuplicateWalletError(dto.playerId, currency);
        }
      }
      throw error;
    }
  }
}
