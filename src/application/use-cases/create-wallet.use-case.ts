import { Wallet } from '../../domain/entities/wallet.entity';
import { Money } from '../../domain/value-objects/money.vo';
import { DuplicateWalletError, InvalidWagerOperationError } from '../../domain/errors/domain.error';
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
    if (!dto || typeof dto !== 'object') {
      throw new InvalidWagerOperationError('CreateWalletDto must be an object');
    }
    if (!dto.playerId || typeof dto.playerId !== 'string' || !dto.playerId.trim()) {
      throw new InvalidWagerOperationError('PlayerId is mandatory and must be a non-empty string');
    }

    const currency = dto.initialBalance?.currency ? dto.initialBalance.currency.trim().toUpperCase() : 'BRL';
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
      const extractErrorCode = (target: unknown): string => {
        if (!target || typeof target !== 'object') return '';
        const rec = target as Record<string, unknown>;
        if (typeof rec.code === 'string') return rec.code;
        if (rec.cause && typeof (rec.cause as any).code === 'string') return (rec.cause as any).code;
        if (rec.originalError && typeof (rec.originalError as any).code === 'string') return (rec.originalError as any).code;
        if (rec.driverException && typeof (rec.driverException as any).code === 'string') return (rec.driverException as any).code;
        if (rec.driverError && typeof (rec.driverError as any).code === 'string') return (rec.driverError as any).code;
        return '';
      };

      const code = extractErrorCode(error);
      const msg = String(error?.message || '') + ' ' + String(error?.cause?.message || '');
      if (code === '23505' || msg.includes('23505') || msg.includes('uq_wallets_player_currency')) {
        throw new DuplicateWalletError(dto.playerId, currency);
      }
      throw error;
    }
  }
}
