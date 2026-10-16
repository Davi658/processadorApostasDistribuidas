import { createHash } from 'node:crypto';
import { Money } from '../../domain/value-objects/money.vo';
import { WagerTransaction } from '../../domain/entities/wager-transaction.entity';
import {
  WagerTransactionProcessedEvent,
  WagerTransactionRejectedEvent,
  WalletBalanceChangedEvent,
} from '../../domain/events/events';
import {
  CurrencyMismatchError,
  IdempotencyConflictError,
  InvalidMoneyError,
  InvalidWagerOperationError,
  WalletNotFoundError,
} from '../../domain/errors/domain.error';
import { ProcessBetDto, WagerResponseDto } from '../dto/wager.dto';
import {
  OutboxRepositoryPort,
  UnitOfWorkPort,
  WalletLedgerRepositoryPort,
  WalletRepositoryPort,
  WagerTransactionRepositoryPort,
} from '../ports/ports';

export class ProcessBetUseCase {
  constructor(
    private readonly walletRepo: WalletRepositoryPort,
    private readonly wagerRepo: WagerTransactionRepositoryPort,
    private readonly ledgerRepo: WalletLedgerRepositoryPort,
    private readonly outboxRepo: OutboxRepositoryPort,
    private readonly uow: UnitOfWorkPort
  ) {}

  public static computePayloadHash(dto: ProcessBetDto): string {
    const canonicalBusinessPayload = {
      amount: dto.money.amount,
      currency: dto.money.currency,
      externalTransactionId: dto.externalTransactionId,
      gameId: dto.gameId,
      kind: dto.kind,
      playerId: dto.playerId,
      providerId: dto.providerId,
      roundId: dto.roundId,
      walletId: dto.walletId,
    };

    const canonicalJson = JSON.stringify(canonicalBusinessPayload);
    return createHash('sha256').update(canonicalJson).digest('hex');
  }

  public async execute(idempotencyKey: string, dto: ProcessBetDto): Promise<WagerResponseDto> {
    const cleanIdempotencyKey = idempotencyKey.trim();
    const betCurrency = dto.money.currency;
    const betMoney = Money.create(dto.money.amount, betCurrency);
    const payloadHash = ProcessBetUseCase.computePayloadHash(dto);

    try {
      return await this.uow.runInTransaction(async () => {
        // 1. Lock wallet row explicitly for the current transaction
        const wallet = await this.walletRepo.findById(dto.walletId, true);
        if (!wallet) {
          throw new WalletNotFoundError(dto.walletId);
        }

        if (wallet.playerId !== dto.playerId) {
          throw new InvalidWagerOperationError(
            `Wallet "${dto.walletId}" does not belong to player "${dto.playerId}"`
          );
        }

        if (wallet.currency !== betCurrency) {
          throw new CurrencyMismatchError(
            `Transaction currency "${betCurrency}" does not match wallet currency "${wallet.currency}"`
          );
        }

        // 2. Persistent Idempotency & Provider deduplication checks
        const existingByIdempotency = await this.wagerRepo.findByIdempotencyKey(cleanIdempotencyKey);
        if (existingByIdempotency) {
          if (existingByIdempotency.payloadHash === payloadHash) {
            const snapshot = existingByIdempotency.responseSnapshot as WagerResponseDto;
            return {
              ...snapshot,
              idempotentReplay: true,
            };
          } else {
            throw new IdempotencyConflictError(
              `Idempotency key "${cleanIdempotencyKey}" was previously submitted with a different payload`
            );
          }
        }

        const existingByProvider = await this.wagerRepo.findByProviderAndExternalId(
          dto.providerId,
          dto.externalTransactionId
        );
        if (existingByProvider) {
          throw new IdempotencyConflictError(
            `Provider transaction "${dto.providerId}/${dto.externalTransactionId}" was already processed under another idempotency key`
          );
        }

        const transactionId = crypto.randomUUID();

        // 3. Balance verification and atomic ledger application
        if (wallet.balance.lessThan(betMoney)) {
          // Insufficient funds: Persist audited REJECTED transaction without ledger entry or balance mutation
          const response: WagerResponseDto = {
            transactionId,
            status: 'REJECTED',
            failureCode: 'INSUFFICIENT_FUNDS',
            balance: {
              amount: wallet.balance.getAmount(),
              currency: wallet.currency,
            },
            idempotentReplay: false,
          };

          const rejectedTx = WagerTransaction.createBet({
            id: transactionId,
            walletId: wallet.id,
            playerId: wallet.playerId,
            providerId: dto.providerId,
            externalTransactionId: dto.externalTransactionId,
            roundId: dto.roundId,
            gameId: dto.gameId,
            money: betMoney,
            status: 'REJECTED',
            rejectionReason: 'INSUFFICIENT_FUNDS',
            idempotencyKey: cleanIdempotencyKey,
            payloadHash,
            responseSnapshot: response,
          });

          await this.wagerRepo.save(rejectedTx);

          const rejectedEvent = new WagerTransactionRejectedEvent({
            aggregateId: wallet.id,
            correlationId: cleanIdempotencyKey,
            data: {
              transactionId,
              walletId: wallet.id,
              playerId: wallet.playerId,
              providerId: dto.providerId,
              externalTransactionId: dto.externalTransactionId,
              roundId: dto.roundId,
              gameId: dto.gameId,
              kind: 'BET',
              amount: {
                amount: betMoney.getAmount(),
                currency: betCurrency,
              },
              balance: {
                amount: wallet.balance.getAmount(),
                currency: wallet.currency,
              },
              failureCode: 'INSUFFICIENT_FUNDS',
            },
          });
          await this.outboxRepo.save(rejectedEvent);

          return response;
        }

        // Sufficient funds: Process debit, increment version, create ledger entry, and save outbox events
        const previousBalanceAmount = wallet.balance.getAmount();
        const ledgerEntryId = crypto.randomUUID();
        const ledgerEntry = wallet.debit({
          transactionId,
          amount: betMoney,
          ledgerEntryId,
        });

        const response: WagerResponseDto = {
          transactionId,
          status: 'PROCESSED',
          balance: {
            amount: wallet.balance.getAmount(),
            currency: wallet.currency,
          },
          idempotentReplay: false,
        };

        const processedTx = WagerTransaction.createBet({
          id: transactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          providerId: dto.providerId,
          externalTransactionId: dto.externalTransactionId,
          roundId: dto.roundId,
          gameId: dto.gameId,
          money: betMoney,
          status: 'PROCESSED',
          rejectionReason: null,
          idempotencyKey: cleanIdempotencyKey,
          payloadHash,
          responseSnapshot: response,
        });

        // Atomically persist wallet, wager transaction, ledger entry and outbox messages
        await this.walletRepo.save(wallet);
        await this.wagerRepo.save(processedTx);
        await this.ledgerRepo.save(ledgerEntry);

        const processedEvent = new WagerTransactionProcessedEvent({
          aggregateId: wallet.id,
          correlationId: cleanIdempotencyKey,
          data: {
            transactionId,
            walletId: wallet.id,
            playerId: wallet.playerId,
            providerId: dto.providerId,
            externalTransactionId: dto.externalTransactionId,
            roundId: dto.roundId,
            gameId: dto.gameId,
            kind: 'BET',
            amount: {
              amount: betMoney.getAmount(),
              currency: betCurrency,
            },
            balance: {
              amount: wallet.balance.getAmount(),
              currency: wallet.currency,
            },
          },
        });
        await this.outboxRepo.save(processedEvent);

        const balanceChangedEvent = new WalletBalanceChangedEvent({
          aggregateId: wallet.id,
          correlationId: cleanIdempotencyKey,
          data: {
            walletId: wallet.id,
            playerId: wallet.playerId,
            currency: betCurrency,
            previousBalance: {
              amount: previousBalanceAmount,
              currency: betCurrency,
            },
            currentBalance: {
              amount: wallet.balance.getAmount(),
              currency: betCurrency,
            },
            version: wallet.version,
            triggerTransactionId: transactionId,
          },
        });
        await this.outboxRepo.save(balanceChangedEvent);

        return response;
      });
    } catch (error: any) {
      const pgError = error?.cause ?? error;
      if (pgError?.code === '23505') {
        const constraint = String(pgError.constraint || '');
        if (constraint.includes('uq_wager_transactions_idempotency_key')) {
          // Look up committed transaction in a fresh read transaction
          const existing = await this.wagerRepo.findByIdempotencyKey(cleanIdempotencyKey);
          if (existing) {
            if (existing.payloadHash === payloadHash) {
              const snapshot = existing.responseSnapshot as WagerResponseDto;
              return {
                ...snapshot,
                idempotentReplay: true,
              };
            } else {
              throw new IdempotencyConflictError(
                `Idempotency key "${cleanIdempotencyKey}" was previously submitted with a different payload`
              );
            }
          }
        }
        if (constraint.includes('uq_wager_transactions_provider_external')) {
          throw new IdempotencyConflictError(
            `Provider transaction "${dto.providerId}/${dto.externalTransactionId}" was already processed under another idempotency key`
          );
        }
        if (constraint.includes('uq_wallet_ledger_entries_tx_wallet')) {
          throw new IdempotencyConflictError(
            `Ledger entry already exists for transaction "${cleanIdempotencyKey}"`
          );
        }
      }
      throw error;
    }
  }
}
