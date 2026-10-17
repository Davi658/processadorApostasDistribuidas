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

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CreateWalletUseCase {
  constructor(
    private readonly walletRepo: WalletRepositoryPort,
    private readonly wagerRepo: WagerTransactionRepositoryPort,
    private readonly ledgerRepo: WalletLedgerRepositoryPort,
    private readonly outboxRepo: OutboxRepositoryPort,
    private readonly uow: UnitOfWorkPort
  ) {}

  public async execute(dto: CreateWalletDto): Promise<WalletResponseDto> {
    // 1. Defesa de entrada básica
    if (!dto || typeof dto !== 'object' || Array.isArray(dto)) {
      throw new InvalidWagerOperationError('CreateWalletDto must be an object');
    }

    if (typeof dto.playerId !== 'string') {
      throw new InvalidWagerOperationError('PlayerId is mandatory and must be a string');
    }

    const trimmedPlayerId = dto.playerId.trim();
    if (!trimmedPlayerId || !UUID_REGEX.test(trimmedPlayerId)) {
      throw new InvalidWagerOperationError('PlayerId must be a valid canonical UUID string');
    }

    const normalizedPlayerId = trimmedPlayerId.toLowerCase();
    const currency = 'BRL';
    let initialMoney: Money;

    // 2. Defesa rigorosa de initialBalance (sem importar validador HTTP)
    const hasInitialBalance = 'initialBalance' in dto && dto.initialBalance !== undefined;
    if (!hasInitialBalance) {
      initialMoney = Money.zero(currency);
    } else {
      const ib = (dto as any).initialBalance;
      if (ib === null || typeof ib !== 'object' || Array.isArray(ib)) {
        throw new InvalidWagerOperationError(
          'initialBalance cannot be null, empty, false, or 0. To open with zero balance, omit initialBalance or explicitly specify { "amount": "0.00", "currency": "BRL" }'
        );
      }

      if (typeof ib.amount !== 'string' || typeof ib.currency !== 'string') {
        throw new InvalidWagerOperationError(
          'initialBalance must be an object containing string properties "amount" and "currency"'
        );
      }

      const rawCurrency = ib.currency.trim().toUpperCase();

      if (rawCurrency !== 'BRL') {
        throw new InvalidWagerOperationError(
          `Only BRL currency is supported operationally, received: "${ib.currency}"`
        );
      }

      // Não aplicar trim no amount. Encaminhar a string original para Money.create, rejeitando espaços conforme a regra monetária
      initialMoney = Money.create(ib.amount, currency);
    }

    try {
      return await this.uow.runInTransaction(async () => {
        const existing = await this.walletRepo.findByPlayerIdAndCurrency(normalizedPlayerId, currency);
        if (existing) {
          throw new DuplicateWalletError(normalizedPlayerId, currency);
        }

        const walletId = crypto.randomUUID();
        const creationResult = Wallet.create({
          id: walletId,
          playerId: normalizedPlayerId,
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
              playerId: normalizedPlayerId,
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
              playerId: normalizedPlayerId,
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
      if (this.isDuplicateWalletConstraintViolation(error)) {
        throw new DuplicateWalletError(normalizedPlayerId, currency);
      }
      throw error;
    }
  }

  private isDuplicateWalletConstraintViolation(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const visited = new Set<unknown>();
    const queue: unknown[] = [error];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || typeof current !== 'object' || visited.has(current)) {
        continue;
      }
      visited.add(current);

      const rec = current as Record<string, unknown>;

      const constraint = typeof rec.constraint === 'string' ? rec.constraint : '';
      const message = typeof rec.message === 'string' ? rec.message : '';
      const detail = typeof rec.detail === 'string' ? rec.detail : '';

      if (constraint === 'uq_wallets_player_currency') {
        return true;
      }

      const fullText = `${constraint} ${message} ${detail}`;
      if (fullText.includes('uq_wallets_player_currency')) {
        return true;
      }

      if (rec.cause) queue.push(rec.cause);
      if (rec.originalError) queue.push(rec.originalError);
      if (rec.driverException) queue.push(rec.driverException);
      if (rec.driverError) queue.push(rec.driverError);
    }

    return false;
  }
}
