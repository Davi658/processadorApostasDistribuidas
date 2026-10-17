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

export interface ProcessReversalParams {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: 'REFUND' | 'ROLLBACK';
  money: Money;
  referenceExternalTransactionId: string;
  idempotencyKey?: string | null;
  payloadHash?: string | null;
  correlationId: string;
  existingPendingTx?: WagerTransaction;
  maxAttempts?: number;
}

export interface ProcessReversalResult {
  outcome: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE' | 'RESCHEDULED';
  response: WagerResponseDto;
}

export class ReversalProcessor {
  constructor(
    private readonly walletRepo: WalletRepositoryPort,
    private readonly wagerRepo: WagerTransactionRepositoryPort,
    private readonly ledgerRepo: WalletLedgerRepositoryPort,
    private readonly outboxRepo: OutboxRepositoryPort
  ) {}

  public async processReversal(
    wallet: Wallet,
    params: ProcessReversalParams
  ): Promise<ProcessReversalResult> {
    const refId = params.referenceExternalTransactionId;

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
        kind: params.kind,
        money: params.money,
        idempotencyKey: params.idempotencyKey ?? '',
        payloadHash: params.payloadHash ?? '',
        referenceExternalTransactionId: refId,
      });
    };

    const rejectReversal = async (failureCode: string): Promise<ProcessReversalResult> => {
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
          kind: params.kind,
          amount: { amount: params.money.getAmount(), currency: wallet.currency },
          balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
          failureCode,
          referenceExternalTransactionId: refId,
        },
      });
      await this.outboxRepo.save(rejectedEvent);

      return { outcome: 'REJECTED', response };
    };

    // 1. Resolve reference by providerId + externalTransactionId
    const refTx = await this.wagerRepo.findByProviderAndExternalId(params.providerId, refId);

    // 2. Reference missing or pending
    if (!refTx || refTx.status === 'PENDING' || refTx.status === 'PENDING_REFERENCE') {
      if (params.existingPendingTx) {
        // Reprocessing flow
        const maxAttempts = params.maxAttempts ?? 5;
        if (params.existingPendingTx.attempts >= maxAttempts) {
          return await rejectReversal('REFERENCE_NOT_FOUND');
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
        const pendingRefTx = WagerTransaction.createPendingReference({
          id: params.transactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          providerId: params.providerId,
          externalTransactionId: params.externalTransactionId,
          roundId: params.roundId,
          gameId: params.gameId,
          kind: params.kind,
          money: params.money,
          idempotencyKey: params.idempotencyKey ?? '',
          payloadHash: params.payloadHash ?? '',
          referenceExternalTransactionId: refId,
          nextAttemptAt,
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
            kind: params.kind,
            amount: { amount: params.money.getAmount(), currency: wallet.currency },
            referenceExternalTransactionId: refId,
            attempts: 1,
            nextAttemptAt,
          },
        });
        await this.outboxRepo.save(pendingEvent);

        return {
          outcome: 'PENDING_REFERENCE',
          response: {
            transactionId: params.transactionId,
            status: 'PENDING_REFERENCE',
            balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
            idempotentReplay: false,
          },
        };
      }
    }

    // 3. Status must be PROCESSED; REJECTED or FAILED rejects with REFERENCE_NOT_PROCESSED
    if (refTx.status === 'REJECTED' || refTx.status === 'FAILED') {
      return await rejectReversal('REFERENCE_NOT_PROCESSED');
    }

    if (refTx.status !== 'PROCESSED') {
      return await rejectReversal('REFERENCE_NOT_PROCESSED');
    }

    // 4. Validate reference compatibility
    // - mesmo provider, player, wallet, moeda e rodada
    // - valor integral idêntico
    // - REFUND referencia somente BET
    // - ROLLBACK referencia BET, WIN ou REFUND
    const isSameProvider = refTx.providerId.trim() === params.providerId.trim();
    const isSamePlayer = refTx.playerId.trim().toLowerCase() === params.playerId.trim().toLowerCase();
    const isSameWallet = refTx.walletId.trim().toLowerCase() === params.walletId.trim().toLowerCase();
    const isSameCurrency = refTx.currency === params.money.getCurrency();
    const isSameRound = refTx.roundId.trim() === params.roundId.trim();
    const isSameAmount = refTx.money.getAmount() === params.money.getAmount();

    let isValidKindForRef = false;
    if (params.kind === 'REFUND') {
      isValidKindForRef = refTx.kind === 'BET';
    } else if (params.kind === 'ROLLBACK') {
      isValidKindForRef = refTx.kind === 'BET' || refTx.kind === 'WIN' || refTx.kind === 'REFUND';
    }

    if (
      !isSameProvider ||
      !isSamePlayer ||
      !isSameWallet ||
      !isSameCurrency ||
      !isSameRound ||
      !isSameAmount ||
      !isValidKindForRef
    ) {
      return await rejectReversal('REFERENCE_INCOMPATIBLE');
    }

    // 5. Nenhuma reversão PROCESSED anterior do mesmo tipo
    const existingReversal = await this.wagerRepo.findByProviderAndReference(
      params.providerId,
      refId,
      params.kind
    );
    if (existingReversal && existingReversal.id !== params.transactionId) {
      return await rejectReversal('REVERSAL_ALREADY_PROCESSED');
    }

    // 6. Débito de reversão não pode produzir saldo negativo
    // REFUND (reverses BET): credits wallet
    // ROLLBACK: if ref was BET -> credit (+); if ref was WIN or REFUND -> debit (-)
    const isDebit = params.kind === 'ROLLBACK' && (refTx.kind === 'WIN' || refTx.kind === 'REFUND');

    if (isDebit && wallet.balance.lessThan(params.money)) {
      return await rejectReversal('REVERSAL_INSUFFICIENT_FUNDS');
    }

    // 7. Apply financial movement
    const previousBalanceAmount = wallet.balance.getAmount();
    const ledgerEntryId = crypto.randomUUID();

    const ledgerEntry = isDebit
      ? wallet.debit({ transactionId: params.transactionId, amount: params.money, ledgerEntryId })
      : wallet.credit({ transactionId: params.transactionId, amount: params.money, ledgerEntryId });

    await this.walletRepo.save(wallet);

    const response: WagerResponseDto = {
      transactionId: params.transactionId,
      status: 'PROCESSED',
      balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
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
        kind: params.kind,
        amount: { amount: params.money.getAmount(), currency: wallet.currency },
        balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
        referenceExternalTransactionId: refId,
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
