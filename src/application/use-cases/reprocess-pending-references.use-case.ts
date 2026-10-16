import {
  OutboxRepositoryPort,
  UnitOfWorkPort,
  WagerTransactionRepositoryPort,
  WalletLedgerRepositoryPort,
  WalletRepositoryPort,
} from '../ports/ports';
import {
  WagerTransactionProcessedEvent,
  WagerTransactionRejectedEvent,
  WalletBalanceChangedEvent,
} from '../../domain/events/events';
import { WagerResponseDto } from '../dto/wager.dto';

export interface ReprocessResult {
  processed: number;
  rejected: number;
  rescheduled: number;
}

export class ReprocessPendingReferencesUseCase {
  constructor(
    private readonly walletRepo: WalletRepositoryPort,
    private readonly wagerRepo: WagerTransactionRepositoryPort,
    private readonly ledgerRepo: WalletLedgerRepositoryPort,
    private readonly outboxRepo: OutboxRepositoryPort,
    private readonly uow: UnitOfWorkPort,
    private readonly maxAttempts = 5
  ) {}

  public async execute(limit = 20): Promise<ReprocessResult> {
    const pendingList = await this.wagerRepo.listPendingReferences(limit);
    let processed = 0;
    let rejected = 0;
    let rescheduled = 0;

    for (const pending of pendingList) {
      await this.uow.runInTransaction(async () => {
        // Fetch fresh state under transaction
        const tx = await this.wagerRepo.findById(pending.id);
        if (!tx || tx.status !== 'PENDING_REFERENCE') {
          return;
        }

        const refId = tx.referenceExternalTransactionId;
        if (!refId) {
          const rejectedTx = tx.markRejected('REFERENCE_NOT_FOUND');
          await this.wagerRepo.save(rejectedTx);
          rejected++;
          return;
        }

        const refTx = await this.wagerRepo.findByProviderAndExternalId(tx.providerId, refId);

        // Case A: Reference found and PROCESSED
        if (refTx && refTx.status === 'PROCESSED') {
          const wallet = await this.walletRepo.findById(tx.walletId, true);
          if (!wallet) return;

          const correlationId = crypto.randomUUID();

          if (tx.kind === 'REFUND') {
            const previousBalance = wallet.balance.getAmount();
            const ledgerEntryId = crypto.randomUUID();
            const ledgerEntry = wallet.credit({
              transactionId: tx.id,
              amount: tx.money,
              ledgerEntryId,
            });
            await this.walletRepo.save(wallet);

            const response: WagerResponseDto = {
              transactionId: tx.id,
              status: 'PROCESSED',
              balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
              idempotentReplay: false,
            };

            const processedTx = tx.markProcessed(response);
            await this.wagerRepo.save(processedTx);
            await this.ledgerRepo.save(ledgerEntry);

            await this.outboxRepo.save(
              new WagerTransactionProcessedEvent({
                aggregateId: wallet.id,
                correlationId,
                causationId: tx.idempotencyKey ?? undefined,
                data: {
                  transactionId: tx.id,
                  walletId: wallet.id,
                  playerId: wallet.playerId,
                  providerId: tx.providerId,
                  externalTransactionId: tx.externalTransactionId,
                  roundId: tx.roundId,
                  gameId: tx.gameId,
                  kind: 'REFUND',
                  amount: { amount: tx.money.getAmount(), currency: wallet.currency },
                  balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
                  referenceExternalTransactionId: refId,
                },
              })
            );

            await this.outboxRepo.save(
              new WalletBalanceChangedEvent({
                aggregateId: wallet.id,
                correlationId,
                causationId: tx.idempotencyKey ?? undefined,
                data: {
                  walletId: wallet.id,
                  playerId: wallet.playerId,
                  currency: wallet.currency,
                  previousBalance: { amount: previousBalance, currency: wallet.currency },
                  currentBalance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
                  version: wallet.version,
                  triggerTransactionId: tx.id,
                },
              })
            );

            processed++;
            return;
          }

          if (tx.kind === 'ROLLBACK') {
            const isDebit = refTx.kind === 'WIN' || refTx.kind === 'REFUND';

            if (isDebit && wallet.balance.lessThan(tx.money)) {
              const response: WagerResponseDto = {
                transactionId: tx.id,
                status: 'REJECTED',
                failureCode: 'REVERSAL_INSUFFICIENT_FUNDS',
                balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
                idempotentReplay: false,
              };

              const rejectedTx = tx.markRejected('REVERSAL_INSUFFICIENT_FUNDS', response);
              await this.wagerRepo.save(rejectedTx);

              await this.outboxRepo.save(
                new WagerTransactionRejectedEvent({
                  aggregateId: wallet.id,
                  correlationId,
                  causationId: tx.idempotencyKey ?? undefined,
                  data: {
                    transactionId: tx.id,
                    walletId: wallet.id,
                    playerId: wallet.playerId,
                    providerId: tx.providerId,
                    externalTransactionId: tx.externalTransactionId,
                    roundId: tx.roundId,
                    gameId: tx.gameId,
                    kind: 'ROLLBACK',
                    amount: { amount: tx.money.getAmount(), currency: wallet.currency },
                    balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
                    failureCode: 'REVERSAL_INSUFFICIENT_FUNDS',
                    referenceExternalTransactionId: refId,
                  },
                })
              );

              rejected++;
              return;
            }

            const previousBalance = wallet.balance.getAmount();
            const ledgerEntryId = crypto.randomUUID();
            const ledgerEntry = isDebit
              ? wallet.debit({ transactionId: tx.id, amount: tx.money, ledgerEntryId })
              : wallet.credit({ transactionId: tx.id, amount: tx.money, ledgerEntryId });
            await this.walletRepo.save(wallet);

            const response: WagerResponseDto = {
              transactionId: tx.id,
              status: 'PROCESSED',
              balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
              idempotentReplay: false,
            };

            const processedTx = tx.markProcessed(response);
            await this.wagerRepo.save(processedTx);
            await this.ledgerRepo.save(ledgerEntry);

            await this.outboxRepo.save(
              new WagerTransactionProcessedEvent({
                aggregateId: wallet.id,
                correlationId,
                causationId: tx.idempotencyKey ?? undefined,
                data: {
                  transactionId: tx.id,
                  walletId: wallet.id,
                  playerId: wallet.playerId,
                  providerId: tx.providerId,
                  externalTransactionId: tx.externalTransactionId,
                  roundId: tx.roundId,
                  gameId: tx.gameId,
                  kind: 'ROLLBACK',
                  amount: { amount: tx.money.getAmount(), currency: wallet.currency },
                  balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
                  referenceExternalTransactionId: refId,
                },
              })
            );

            await this.outboxRepo.save(
              new WalletBalanceChangedEvent({
                aggregateId: wallet.id,
                correlationId,
                causationId: tx.idempotencyKey ?? undefined,
                data: {
                  walletId: wallet.id,
                  playerId: wallet.playerId,
                  currency: wallet.currency,
                  previousBalance: { amount: previousBalance, currency: wallet.currency },
                  currentBalance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
                  version: wallet.version,
                  triggerTransactionId: tx.id,
                },
              })
            );

            processed++;
            return;
          }
        }

        // Case B: Reference found but is REJECTED or FAILED
        if (refTx && (refTx.status === 'REJECTED' || refTx.status === 'FAILED')) {
          const wallet = await this.walletRepo.findById(tx.walletId, false);
          const balance = wallet ? wallet.balance.getAmount() : '0.00';
          const currency = wallet ? wallet.currency : tx.money.getCurrency();

          const response: WagerResponseDto = {
            transactionId: tx.id,
            status: 'REJECTED',
            failureCode: 'REFERENCE_NOT_PROCESSED',
            balance: { amount: balance, currency },
            idempotentReplay: false,
          };

          const rejectedTx = tx.markRejected('REFERENCE_NOT_PROCESSED', response);
          await this.wagerRepo.save(rejectedTx);

          await this.outboxRepo.save(
            new WagerTransactionRejectedEvent({
              aggregateId: tx.walletId,
              correlationId: crypto.randomUUID(),
              causationId: tx.idempotencyKey ?? undefined,
              data: {
                transactionId: tx.id,
                walletId: tx.walletId,
                playerId: tx.playerId,
                providerId: tx.providerId,
                externalTransactionId: tx.externalTransactionId,
                roundId: tx.roundId,
                gameId: tx.gameId,
                kind: tx.kind as any,
                amount: { amount: tx.money.getAmount(), currency },
                balance: { amount: balance, currency },
                failureCode: 'REFERENCE_NOT_PROCESSED',
                referenceExternalTransactionId: refId,
              },
            })
          );

          rejected++;
          return;
        }

        // Case C: Reference still missing or still PENDING
        if (tx.attempts >= this.maxAttempts) {
          // TTL/Attempts exhausted -> terminal REJECTED
          const wallet = await this.walletRepo.findById(tx.walletId, false);
          const balance = wallet ? wallet.balance.getAmount() : '0.00';
          const currency = wallet ? wallet.currency : tx.money.getCurrency();

          const response: WagerResponseDto = {
            transactionId: tx.id,
            status: 'REJECTED',
            failureCode: 'REFERENCE_NOT_FOUND',
            balance: { amount: balance, currency },
            idempotentReplay: false,
          };

          const rejectedTx = tx.markRejected('REFERENCE_NOT_FOUND', response);
          await this.wagerRepo.save(rejectedTx);

          await this.outboxRepo.save(
            new WagerTransactionRejectedEvent({
              aggregateId: tx.walletId,
              correlationId: crypto.randomUUID(),
              causationId: tx.idempotencyKey ?? undefined,
              data: {
                transactionId: tx.id,
                walletId: tx.walletId,
                playerId: tx.playerId,
                providerId: tx.providerId,
                externalTransactionId: tx.externalTransactionId,
                roundId: tx.roundId,
                gameId: tx.gameId,
                kind: tx.kind as any,
                amount: { amount: tx.money.getAmount(), currency },
                balance: { amount: balance, currency },
                failureCode: 'REFERENCE_NOT_FOUND',
                referenceExternalTransactionId: refId,
              },
            })
          );

          rejected++;
          return;
        }

        // Apply exponential backoff and reschedule
        const backoffMs = Math.min(500 * Math.pow(2, tx.attempts), 10000);
        const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();
        const updatedTx = tx.markPendingReference(nextAttemptAt);
        await this.wagerRepo.save(updatedTx);
        rescheduled++;
      });
    }

    return { processed, rejected, rescheduled };
  }
}
