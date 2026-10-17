import {
  OutboxRepositoryPort,
  WagerTransactionRepositoryPort,
  WalletLedgerRepositoryPort,
  WalletRepositoryPort,
} from '../ports/ports';
import { Wallet } from '../../domain/entities/wallet.entity';
import { WagerTransaction } from '../../domain/entities/wager-transaction.entity';
import { Money } from '../../domain/value-objects/money.vo';
import {
  WagerTransactionPendingReferenceEvent,
  WagerTransactionProcessedEvent,
  WagerTransactionRejectedEvent,
  WalletBalanceChangedEvent,
} from '../../domain/events/events';
import { WagerResponseDto } from '../dto/wager.dto';
import { InvalidWagerOperationError } from '../../domain/errors/domain.error';

export interface ProcessWinParams {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  money: Money;
  referenceExternalTransactionId?: string | null;
  idempotencyKey?: string | null;
  payloadHash?: string | null;
  correlationId: string;
  existingPendingTx?: WagerTransaction;
  maxAttempts?: number;
}

export interface ProcessWinResult {
  outcome: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE' | 'RESCHEDULED';
  response: WagerResponseDto;
}

export class WinProcessor {
  constructor(
    private readonly walletRepo: WalletRepositoryPort,
    private readonly wagerRepo: WagerTransactionRepositoryPort,
    private readonly ledgerRepo: WalletLedgerRepositoryPort,
    private readonly outboxRepo: OutboxRepositoryPort
  ) {}

  public async processWin(
    wallet: Wallet,
    params: ProcessWinParams
  ): Promise<ProcessWinResult> {
    if (!params.money.isPositive()) {
      throw new InvalidWagerOperationError('WIN amount must be strictly greater than zero');
    }

    const refId = params.referenceExternalTransactionId?.trim();

    const getPendingTx = (): WagerTransaction => {
      if (params.existingPendingTx) {
        return params.existingPendingTx;
      }
      return WagerTransaction.createPending({
        id: params.transactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: params.providerId,
        externalTransactionId: params.externalTransactionId,
        roundId: params.roundId,
        gameId: params.gameId,
        kind: 'WIN',
        money: params.money,
        idempotencyKey: params.idempotencyKey ?? '',
        payloadHash: params.payloadHash ?? '',
        referenceExternalTransactionId: refId ?? null,
      });
    };

    const rejectWin = async (failureCode: string): Promise<ProcessWinResult> => {
      const response: WagerResponseDto = {
        transactionId: params.transactionId,
        status: 'REJECTED',
        failureCode,
        balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
        idempotentReplay: false,
      };

      const pendingTx = getPendingTx();
      const rejectedTx = pendingTx.markRejected(failureCode, response);
      await this.wagerRepo.save(rejectedTx);

      const rejectedEvent = new WagerTransactionRejectedEvent({
        aggregateId: wallet.id,
        correlationId: params.correlationId,
        causationId: params.idempotencyKey ?? undefined,
        data: {
          transactionId: params.transactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          providerId: params.providerId,
          externalTransactionId: params.externalTransactionId,
          roundId: params.roundId,
          gameId: params.gameId,
          kind: 'WIN',
          amount: { amount: params.money.getAmount(), currency: wallet.currency },
          balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
          failureCode,
          referenceExternalTransactionId: refId ?? null,
        },
      });
      await this.outboxRepo.save(rejectedEvent);

      return { outcome: 'REJECTED', response };
    };

    // 1. If reference is informed, validate or schedule pending
    if (refId) {
      const refTx = await this.wagerRepo.findByProviderAndExternalId(params.providerId, refId);

      // Reference missing or still pending
      if (!refTx || refTx.status === 'PENDING' || refTx.status === 'PENDING_REFERENCE') {
        if (params.existingPendingTx) {
          // Reprocessing flow
          const maxAttempts = params.maxAttempts ?? 5;
          if (params.existingPendingTx.attempts >= maxAttempts) {
            return await rejectWin('REFERENCE_NOT_FOUND');
          }

          const backoffMs = Math.min(500 * Math.pow(2, params.existingPendingTx.attempts), 10000);
          const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();
          const updatedTx = params.existingPendingTx.markPendingReference(nextAttemptAt);
          await this.wagerRepo.save(updatedTx);

          return {
            outcome: 'RESCHEDULED',
            response: {
              transactionId: params.transactionId,
              status: 'PENDING_REFERENCE',
              balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
              idempotentReplay: false,
            },
          };
        } else {
          // Immediate flow
          const nextAttemptAt = new Date(Date.now() + 500).toISOString();
          const response: WagerResponseDto = {
            transactionId: params.transactionId,
            status: 'PENDING_REFERENCE',
            balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
            idempotentReplay: false,
          };

          const pendingRefTx = WagerTransaction.createPendingReference({
            id: params.transactionId,
            walletId: wallet.id,
            playerId: wallet.playerId,
            providerId: params.providerId,
            externalTransactionId: params.externalTransactionId,
            roundId: params.roundId,
            gameId: params.gameId,
            kind: 'WIN',
            money: params.money,
            idempotencyKey: params.idempotencyKey ?? '',
            payloadHash: params.payloadHash ?? '',
            referenceExternalTransactionId: refId,
            nextAttemptAt,
            responseSnapshot: response,
          });

          await this.wagerRepo.save(pendingRefTx);

          const pendingEvent = new WagerTransactionPendingReferenceEvent({
            aggregateId: wallet.id,
            correlationId: params.correlationId,
            causationId: params.idempotencyKey ?? undefined,
            data: {
              transactionId: params.transactionId,
              walletId: wallet.id,
              playerId: wallet.playerId,
              providerId: params.providerId,
              externalTransactionId: params.externalTransactionId,
              roundId: params.roundId,
              gameId: params.gameId,
              kind: 'WIN',
              amount: { amount: params.money.getAmount(), currency: wallet.currency },
              referenceExternalTransactionId: refId,
              attempts: 1,
              nextAttemptAt,
            },
          });
          await this.outboxRepo.save(pendingEvent);

          return {
            outcome: 'PENDING_REFERENCE',
            response,
          };
        }
      }

      // Reference exists with REJECTED or FAILED status
      if (refTx.status === 'REJECTED' || refTx.status === 'FAILED') {
        return await rejectWin('REFERENCE_NOT_PROCESSED');
      }

      if (refTx.status !== 'PROCESSED') {
        return await rejectWin('REFERENCE_NOT_PROCESSED');
      }

      // Reference is PROCESSED: validate compatibility
      const isBet = refTx.kind === 'BET';
      const isSameProvider = refTx.providerId.trim() === params.providerId.trim();
      const isSamePlayer = refTx.playerId.trim().toLowerCase() === params.playerId.trim().toLowerCase();
      const isSameWallet = refTx.walletId.trim().toLowerCase() === params.walletId.trim().toLowerCase();
      const isSameCurrency = refTx.currency === params.money.getCurrency();
      const isSameRound = refTx.roundId.trim() === params.roundId.trim();

      if (!isBet || !isSameProvider || !isSamePlayer || !isSameWallet || !isSameCurrency || !isSameRound) {
        return await rejectWin('REFERENCE_INCOMPATIBLE');
      }
      // Note: amount equality is NOT required because WIN amount is independent of BET amount.
    }

    // 2. Apply financial movement (Credit)
    const previousBalanceAmount = wallet.balance.getAmount();
    const ledgerEntryId = crypto.randomUUID();
    const ledgerEntry = wallet.credit({
      transactionId: params.transactionId,
      amount: params.money,
      ledgerEntryId,
    });
    await this.walletRepo.save(wallet);

    const response: WagerResponseDto = {
      transactionId: params.transactionId,
      status: 'PROCESSED',
      balance: {
        amount: wallet.balance.getAmount(),
        currency: wallet.currency,
      },
      idempotentReplay: false,
    };

    const pendingTx = getPendingTx();
    const processedTx = pendingTx.markProcessed(response);
    await this.wagerRepo.save(processedTx);
    await this.ledgerRepo.save(ledgerEntry);

    const processedEvent = new WagerTransactionProcessedEvent({
      aggregateId: wallet.id,
      correlationId: params.correlationId,
      causationId: params.idempotencyKey ?? undefined,
      data: {
        transactionId: params.transactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: params.providerId,
        externalTransactionId: params.externalTransactionId,
        roundId: params.roundId,
        gameId: params.gameId,
        kind: 'WIN',
        amount: { amount: params.money.getAmount(), currency: wallet.currency },
        balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
        referenceExternalTransactionId: refId ?? null,
      },
    });
    await this.outboxRepo.save(processedEvent);

    const balanceChangedEvent = new WalletBalanceChangedEvent({
      aggregateId: wallet.id,
      correlationId: params.correlationId,
      causationId: params.idempotencyKey ?? undefined,
      data: {
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        previousBalance: { amount: previousBalanceAmount, currency: wallet.currency },
        currentBalance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
        version: wallet.version,
        triggerTransactionId: params.transactionId,
      },
    });
    await this.outboxRepo.save(balanceChangedEvent);

    return { outcome: 'PROCESSED', response };
  }
}
