import { createHash } from 'node:crypto';
import {
  CurrencyMismatchError,
  IdempotencyConflictError,
  InvalidMoneyError,
  InvalidWagerOperationError,
  WalletNotFoundError,
} from '../../domain/errors/domain.error';
import {
  OutboxRepositoryPort,
  UnitOfWorkPort,
  WagerTransactionRepositoryPort,
  WalletLedgerRepositoryPort,
  WalletRepositoryPort,
} from '../ports/ports';
import { ProcessWagerDto, WagerResponseDto } from '../dto/wager.dto';
import { WagerTransaction } from '../../domain/entities/wager-transaction.entity';
import { Money } from '../../domain/value-objects/money.vo';
import {
  WagerTransactionPendingReferenceEvent,
  WagerTransactionProcessedEvent,
  WagerTransactionRejectedEvent,
  WalletBalanceChangedEvent,
} from '../../domain/events/events';

export class ProcessWagerUseCase {
  constructor(
    protected readonly walletRepo: WalletRepositoryPort,
    protected readonly wagerRepo: WagerTransactionRepositoryPort,
    protected readonly ledgerRepo: WalletLedgerRepositoryPort,
    protected readonly outboxRepo: OutboxRepositoryPort,
    protected readonly uow: UnitOfWorkPort
  ) {}

  public async execute(idempotencyKey: string, dto: ProcessWagerDto): Promise<WagerResponseDto> {
    // 1. Independent Domain Validation (decoupled from HTTP transport)
    this.validateDomainRules(idempotencyKey, dto);

    const cleanIdempotencyKey = idempotencyKey.trim();
    const currency = dto.money.currency.trim().toUpperCase();
    const money = Money.create(dto.money.amount, currency);
    const correlationId = dto.correlationId?.trim() || cleanIdempotencyKey;

    // Canonical payload hash computed on normalized values
    const payloadHash = ProcessWagerUseCase.computePayloadHash(dto, cleanIdempotencyKey);

    try {
      return await this.uow.runInTransaction(async () => {
        // 2. Pessimistic lock on the target wallet
        const wallet = await this.walletRepo.findById(dto.walletId, true);
        if (!wallet) {
          throw new WalletNotFoundError(dto.walletId);
        }

        if (wallet.playerId !== dto.playerId) {
          throw new InvalidWagerOperationError(
            `Wallet "${dto.walletId}" does not belong to player "${dto.playerId}"`
          );
        }

        if (wallet.currency !== currency) {
          throw new CurrencyMismatchError(
            `Transaction currency "${currency}" does not match wallet currency "${wallet.currency}"`
          );
        }

        // 3. Persistent Idempotency check by key
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

        // 4. Provider deduplication check
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

        // 5. Operation branch
        switch (dto.kind) {
          case 'BET':
            return this.handleBet(transactionId, cleanIdempotencyKey, correlationId, payloadHash, wallet, dto, money);
          case 'WIN':
            return this.handleWin(transactionId, cleanIdempotencyKey, correlationId, payloadHash, wallet, dto, money);
          case 'LOSS':
            return this.handleLoss(transactionId, cleanIdempotencyKey, correlationId, payloadHash, wallet, dto, money);
          case 'REFUND':
            return this.handleRefund(transactionId, cleanIdempotencyKey, correlationId, payloadHash, wallet, dto, money);
          case 'ROLLBACK':
            return this.handleRollback(transactionId, cleanIdempotencyKey, correlationId, payloadHash, wallet, dto, money);
          default:
            throw new InvalidWagerOperationError(`Unsupported operation kind: "${dto.kind}"`);
        }
      });
    } catch (err: any) {
      // 6. Safe 23505 race resolution outside aborted PostgreSQL transaction
      const uniqueConstraintCause = this.identifyWagerUniqueConstraint(err);

      if (uniqueConstraintCause === 'IDEMPOTENCY_KEY') {
        let committedTx: WagerTransaction | null = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          committedTx = await this.uow.runInTransaction(async () => {
            return this.wagerRepo.findByIdempotencyKey(cleanIdempotencyKey);
          });
          if (committedTx) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }

        if (committedTx) {
          if (committedTx.payloadHash === payloadHash) {
            const snapshot = committedTx.responseSnapshot as WagerResponseDto;
            return {
              ...snapshot,
              idempotentReplay: true,
            };
          } else {
            throw new IdempotencyConflictError(
              `Concurrent conflict: Idempotency key "${cleanIdempotencyKey}" was registered by a racing request with a different payload`
            );
          }
        }

        throw new IdempotencyConflictError(
          `Concurrent conflict: Idempotency key "${cleanIdempotencyKey}" collided during transaction processing`
        );
      }

      if (uniqueConstraintCause === 'PROVIDER_EXTERNAL') {
        throw new IdempotencyConflictError(
          `Concurrent conflict: Provider transaction "${dto.providerId}/${dto.externalTransactionId}" was registered by a racing request`
        );
      }

      if (uniqueConstraintCause === 'REVERSAL_REFERENCE') {
        throw new IdempotencyConflictError(
          `Concurrent conflict: A reversal of type "${dto.kind}" for reference "${dto.referenceExternalTransactionId}" was already processed`
        );
      }

      // Unrelated 23505 or other database error: rethrow without transforming into IdempotencyConflictError
      throw err;
    }
  }

  private async handleBet(
    transactionId: string,
    idempotencyKey: string,
    correlationId: string,
    payloadHash: string,
    wallet: any,
    dto: ProcessWagerDto,
    betMoney: Money
  ): Promise<WagerResponseDto> {
    if (!betMoney.isPositive()) {
      throw new InvalidWagerOperationError('BET amount must be strictly greater than zero');
    }

    if (wallet.balance.lessThan(betMoney)) {
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

      const pendingTx = WagerTransaction.createPending({
        id: transactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: dto.providerId,
        externalTransactionId: dto.externalTransactionId,
        roundId: dto.roundId,
        gameId: dto.gameId,
        kind: 'BET',
        money: betMoney,
        idempotencyKey,
        payloadHash,
      });

      const rejectedTx = pendingTx.markRejected('INSUFFICIENT_FUNDS', response);
      await this.wagerRepo.save(rejectedTx);

      const rejectedEvent = new WagerTransactionRejectedEvent({
        aggregateId: wallet.id,
        correlationId,
        causationId: idempotencyKey,
        data: {
          transactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          providerId: dto.providerId,
          externalTransactionId: dto.externalTransactionId,
          roundId: dto.roundId,
          gameId: dto.gameId,
          kind: 'BET',
          amount: { amount: betMoney.getAmount(), currency: wallet.currency },
          balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
          failureCode: 'INSUFFICIENT_FUNDS',
        },
      });
      await this.outboxRepo.save(rejectedEvent);

      return response;
    }

    const previousBalanceAmount = wallet.balance.getAmount();
    const ledgerEntryId = crypto.randomUUID();
    const ledgerEntry = wallet.debit({
      transactionId,
      amount: betMoney,
      ledgerEntryId,
    });
    await this.walletRepo.save(wallet);

    const response: WagerResponseDto = {
      transactionId,
      status: 'PROCESSED',
      balance: {
        amount: wallet.balance.getAmount(),
        currency: wallet.currency,
      },
      idempotentReplay: false,
    };

    const pendingTx = WagerTransaction.createPending({
      id: transactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: 'BET',
      money: betMoney,
      idempotencyKey,
      payloadHash,
    });

    const processedTx = pendingTx.markProcessed(response);
    await this.wagerRepo.save(processedTx);
    await this.ledgerRepo.save(ledgerEntry);

    const processedEvent = new WagerTransactionProcessedEvent({
      aggregateId: wallet.id,
      correlationId,
      causationId: idempotencyKey,
      data: {
        transactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: dto.providerId,
        externalTransactionId: dto.externalTransactionId,
        roundId: dto.roundId,
        gameId: dto.gameId,
        kind: 'BET',
        amount: { amount: betMoney.getAmount(), currency: wallet.currency },
        balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
      },
    });
    await this.outboxRepo.save(processedEvent);

    const balanceChangedEvent = new WalletBalanceChangedEvent({
      aggregateId: wallet.id,
      correlationId,
      causationId: idempotencyKey,
      data: {
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        previousBalance: { amount: previousBalanceAmount, currency: wallet.currency },
        currentBalance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
        version: wallet.version,
        triggerTransactionId: transactionId,
      },
    });
    await this.outboxRepo.save(balanceChangedEvent);

    return response;
  }

  private async handleWin(
    transactionId: string,
    idempotencyKey: string,
    correlationId: string,
    payloadHash: string,
    wallet: any,
    dto: ProcessWagerDto,
    winMoney: Money
  ): Promise<WagerResponseDto> {
    if (!winMoney.isPositive()) {
      throw new InvalidWagerOperationError('WIN amount must be strictly greater than zero');
    }

    const previousBalanceAmount = wallet.balance.getAmount();
    const ledgerEntryId = crypto.randomUUID();
    const ledgerEntry = wallet.credit({
      transactionId,
      amount: winMoney,
      ledgerEntryId,
    });
    await this.walletRepo.save(wallet);

    const response: WagerResponseDto = {
      transactionId,
      status: 'PROCESSED',
      balance: {
        amount: wallet.balance.getAmount(),
        currency: wallet.currency,
      },
      idempotentReplay: false,
    };

    const pendingTx = WagerTransaction.createPending({
      id: transactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: 'WIN',
      money: winMoney,
      idempotencyKey,
      payloadHash,
    });

    const processedTx = pendingTx.markProcessed(response);
    await this.wagerRepo.save(processedTx);
    await this.ledgerRepo.save(ledgerEntry);

    const processedEvent = new WagerTransactionProcessedEvent({
      aggregateId: wallet.id,
      correlationId,
      causationId: idempotencyKey,
      data: {
        transactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: dto.providerId,
        externalTransactionId: dto.externalTransactionId,
        roundId: dto.roundId,
        gameId: dto.gameId,
        kind: 'WIN',
        amount: { amount: winMoney.getAmount(), currency: wallet.currency },
        balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
      },
    });
    await this.outboxRepo.save(processedEvent);

    const balanceChangedEvent = new WalletBalanceChangedEvent({
      aggregateId: wallet.id,
      correlationId,
      causationId: idempotencyKey,
      data: {
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        previousBalance: { amount: previousBalanceAmount, currency: wallet.currency },
        currentBalance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
        version: wallet.version,
        triggerTransactionId: transactionId,
      },
    });
    await this.outboxRepo.save(balanceChangedEvent);

    return response;
  }

  private async handleLoss(
    transactionId: string,
    idempotencyKey: string,
    correlationId: string,
    payloadHash: string,
    wallet: any,
    dto: ProcessWagerDto,
    lossMoney: Money
  ): Promise<WagerResponseDto> {
    // LOSS does not mutate wallet balance, does not increment version, and generates no ledger entry
    const response: WagerResponseDto = {
      transactionId,
      status: 'PROCESSED',
      balance: {
        amount: wallet.balance.getAmount(),
        currency: wallet.currency,
      },
      idempotentReplay: false,
    };

    const pendingTx = WagerTransaction.createPending({
      id: transactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: 'LOSS',
      money: lossMoney,
      idempotencyKey,
      payloadHash,
    });

    const processedTx = pendingTx.markProcessed(response);
    await this.wagerRepo.save(processedTx);

    const processedEvent = new WagerTransactionProcessedEvent({
      aggregateId: wallet.id,
      correlationId,
      causationId: idempotencyKey,
      data: {
        transactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: dto.providerId,
        externalTransactionId: dto.externalTransactionId,
        roundId: dto.roundId,
        gameId: dto.gameId,
        kind: 'LOSS',
        amount: { amount: lossMoney.getAmount(), currency: wallet.currency },
        balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
      },
    });
    await this.outboxRepo.save(processedEvent);

    return response;
  }

  private async handleRefund(
    transactionId: string,
    idempotencyKey: string,
    correlationId: string,
    payloadHash: string,
    wallet: any,
    dto: ProcessWagerDto,
    refundMoney: Money
  ): Promise<WagerResponseDto> {
    if (!refundMoney.isPositive()) {
      throw new InvalidWagerOperationError('REFUND amount must be strictly greater than zero');
    }

    const refId = dto.referenceExternalTransactionId!;
    const refTx = await this.wagerRepo.findByProviderAndExternalId(dto.providerId, refId);

    // Out-of-order reference handling
    if (!refTx || refTx.status === 'PENDING' || refTx.status === 'PENDING_REFERENCE') {
      const nextAttemptAt = new Date(Date.now() + 500).toISOString();
      const pendingRefTx = WagerTransaction.createPendingReference({
        id: transactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: dto.providerId,
        externalTransactionId: dto.externalTransactionId,
        roundId: dto.roundId,
        gameId: dto.gameId,
        kind: 'REFUND',
        money: refundMoney,
        idempotencyKey,
        payloadHash,
        referenceExternalTransactionId: refId,
        nextAttemptAt,
      });

      await this.wagerRepo.save(pendingRefTx);

      const pendingEvent = new WagerTransactionPendingReferenceEvent({
        aggregateId: wallet.id,
        correlationId,
        causationId: idempotencyKey,
        data: {
          transactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          providerId: dto.providerId,
          externalTransactionId: dto.externalTransactionId,
          roundId: dto.roundId,
          gameId: dto.gameId,
          kind: 'REFUND',
          amount: { amount: refundMoney.getAmount(), currency: wallet.currency },
          referenceExternalTransactionId: refId,
          attempts: 1,
          nextAttemptAt,
        },
      });
      await this.outboxRepo.save(pendingEvent);

      return {
        transactionId,
        status: 'PENDING_REFERENCE',
        balance: {
          amount: wallet.balance.getAmount(),
          currency: wallet.currency,
        },
        idempotentReplay: false,
      };
    }

    // Policy: Cannot refund a rejected or failed transaction
    if (refTx.status === 'REJECTED' || refTx.status === 'FAILED') {
      const response: WagerResponseDto = {
        transactionId,
        status: 'REJECTED',
        failureCode: 'REFERENCE_NOT_PROCESSED',
        balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
        idempotentReplay: false,
      };

      const pendingTx = WagerTransaction.createPending({
        id: transactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: dto.providerId,
        externalTransactionId: dto.externalTransactionId,
        roundId: dto.roundId,
        gameId: dto.gameId,
        kind: 'REFUND',
        money: refundMoney,
        idempotencyKey,
        payloadHash,
        referenceExternalTransactionId: refId,
      });

      const rejectedTx = pendingTx.markRejected('REFERENCE_NOT_PROCESSED', response);
      await this.wagerRepo.save(rejectedTx);

      const rejectedEvent = new WagerTransactionRejectedEvent({
        aggregateId: wallet.id,
        correlationId,
        causationId: idempotencyKey,
        data: {
          transactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          providerId: dto.providerId,
          externalTransactionId: dto.externalTransactionId,
          roundId: dto.roundId,
          gameId: dto.gameId,
          kind: 'REFUND',
          amount: { amount: refundMoney.getAmount(), currency: wallet.currency },
          balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
          failureCode: 'REFERENCE_NOT_PROCESSED',
          referenceExternalTransactionId: refId,
        },
      });
      await this.outboxRepo.save(rejectedEvent);

      return response;
    }

    // Validate reference compatibility
    if (refTx.kind !== 'BET') {
      throw new InvalidWagerOperationError(
        `REFUND can only reference a BET transaction (referenced transaction is "${refTx.kind}")`
      );
    }

    this.assertReferenceCompatibility(refTx, wallet, dto, refundMoney);

    // Check unique processed refund for this reference
    const existingRefund = await this.wagerRepo.findByProviderAndReference(dto.providerId, refId, 'REFUND');
    if (existingRefund) {
      throw new IdempotencyConflictError(
        `A REFUND for reference transaction "${refId}" has already been processed`
      );
    }

    // REFUND credits the wallet (reversing the BET debit)
    const previousBalanceAmount = wallet.balance.getAmount();
    const ledgerEntryId = crypto.randomUUID();
    const ledgerEntry = wallet.credit({
      transactionId,
      amount: refundMoney,
      ledgerEntryId,
    });
    await this.walletRepo.save(wallet);

    const response: WagerResponseDto = {
      transactionId,
      status: 'PROCESSED',
      balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
      idempotentReplay: false,
    };

    const pendingTx = WagerTransaction.createPending({
      id: transactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: 'REFUND',
      money: refundMoney,
      idempotencyKey,
      payloadHash,
      referenceExternalTransactionId: refId,
    });

    const processedTx = pendingTx.markProcessed(response);
    await this.wagerRepo.save(processedTx);
    await this.ledgerRepo.save(ledgerEntry);

    const processedEvent = new WagerTransactionProcessedEvent({
      aggregateId: wallet.id,
      correlationId,
      causationId: idempotencyKey,
      data: {
        transactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: dto.providerId,
        externalTransactionId: dto.externalTransactionId,
        roundId: dto.roundId,
        gameId: dto.gameId,
        kind: 'REFUND',
        amount: { amount: refundMoney.getAmount(), currency: wallet.currency },
        balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
        referenceExternalTransactionId: refId,
      },
    });
    await this.outboxRepo.save(processedEvent);

    const balanceChangedEvent = new WalletBalanceChangedEvent({
      aggregateId: wallet.id,
      correlationId,
      causationId: idempotencyKey,
      data: {
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        previousBalance: { amount: previousBalanceAmount, currency: wallet.currency },
        currentBalance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
        version: wallet.version,
        triggerTransactionId: transactionId,
      },
    });
    await this.outboxRepo.save(balanceChangedEvent);

    return response;
  }

  private async handleRollback(
    transactionId: string,
    idempotencyKey: string,
    correlationId: string,
    payloadHash: string,
    wallet: any,
    dto: ProcessWagerDto,
    rollbackMoney: Money
  ): Promise<WagerResponseDto> {
    if (!rollbackMoney.isPositive()) {
      throw new InvalidWagerOperationError('ROLLBACK amount must be strictly greater than zero');
    }

    const refId = dto.referenceExternalTransactionId!;
    const refTx = await this.wagerRepo.findByProviderAndExternalId(dto.providerId, refId);

    // Out-of-order reference handling
    if (!refTx || refTx.status === 'PENDING' || refTx.status === 'PENDING_REFERENCE') {
      const nextAttemptAt = new Date(Date.now() + 500).toISOString();
      const pendingRefTx = WagerTransaction.createPendingReference({
        id: transactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: dto.providerId,
        externalTransactionId: dto.externalTransactionId,
        roundId: dto.roundId,
        gameId: dto.gameId,
        kind: 'ROLLBACK',
        money: rollbackMoney,
        idempotencyKey,
        payloadHash,
        referenceExternalTransactionId: refId,
        nextAttemptAt,
      });

      await this.wagerRepo.save(pendingRefTx);

      const pendingEvent = new WagerTransactionPendingReferenceEvent({
        aggregateId: wallet.id,
        correlationId,
        causationId: idempotencyKey,
        data: {
          transactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          providerId: dto.providerId,
          externalTransactionId: dto.externalTransactionId,
          roundId: dto.roundId,
          gameId: dto.gameId,
          kind: 'ROLLBACK',
          amount: { amount: rollbackMoney.getAmount(), currency: wallet.currency },
          referenceExternalTransactionId: refId,
          attempts: 1,
          nextAttemptAt,
        },
      });
      await this.outboxRepo.save(pendingEvent);

      return {
        transactionId,
        status: 'PENDING_REFERENCE',
        balance: {
          amount: wallet.balance.getAmount(),
          currency: wallet.currency,
        },
        idempotentReplay: false,
      };
    }

    // Policy: Cannot rollback a rejected or failed transaction
    if (refTx.status === 'REJECTED' || refTx.status === 'FAILED') {
      const response: WagerResponseDto = {
        transactionId,
        status: 'REJECTED',
        failureCode: 'REFERENCE_NOT_PROCESSED',
        balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
        idempotentReplay: false,
      };

      const pendingTx = WagerTransaction.createPending({
        id: transactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: dto.providerId,
        externalTransactionId: dto.externalTransactionId,
        roundId: dto.roundId,
        gameId: dto.gameId,
        kind: 'ROLLBACK',
        money: rollbackMoney,
        idempotencyKey,
        payloadHash,
        referenceExternalTransactionId: refId,
      });

      const rejectedTx = pendingTx.markRejected('REFERENCE_NOT_PROCESSED', response);
      await this.wagerRepo.save(rejectedTx);

      const rejectedEvent = new WagerTransactionRejectedEvent({
        aggregateId: wallet.id,
        correlationId,
        causationId: idempotencyKey,
        data: {
          transactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          providerId: dto.providerId,
          externalTransactionId: dto.externalTransactionId,
          roundId: dto.roundId,
          gameId: dto.gameId,
          kind: 'ROLLBACK',
          amount: { amount: rollbackMoney.getAmount(), currency: wallet.currency },
          balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
          failureCode: 'REFERENCE_NOT_PROCESSED',
          referenceExternalTransactionId: refId,
        },
      });
      await this.outboxRepo.save(rejectedEvent);

      return response;
    }

    // ROLLBACK can reference BET, WIN or REFUND
    const allowedRefKinds = ['BET', 'WIN', 'REFUND'];
    if (!allowedRefKinds.includes(refTx.kind)) {
      throw new InvalidWagerOperationError(
        `ROLLBACK cannot reference kind "${refTx.kind}". Allowed kinds to rollback: ${allowedRefKinds.join(', ')}`
      );
    }

    this.assertReferenceCompatibility(refTx, wallet, dto, rollbackMoney);

    // Check unique processed rollback for this reference
    const existingRollback = await this.wagerRepo.findByProviderAndReference(dto.providerId, refId, 'ROLLBACK');
    if (existingRollback) {
      throw new IdempotencyConflictError(
        `A ROLLBACK for reference transaction "${refId}" has already been processed`
      );
    }

    // Inverse movement calculation:
    // If ref was BET: inverse is CREDIT (+)
    // If ref was WIN or REFUND: inverse is DEBIT (-)
    const isDebit = refTx.kind === 'WIN' || refTx.kind === 'REFUND';

    if (isDebit && wallet.balance.lessThan(rollbackMoney)) {
      // Distinct failure code for reversal insufficient balance
      const response: WagerResponseDto = {
        transactionId,
        status: 'REJECTED',
        failureCode: 'REVERSAL_INSUFFICIENT_FUNDS',
        balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
        idempotentReplay: false,
      };

      const pendingTx = WagerTransaction.createPending({
        id: transactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: dto.providerId,
        externalTransactionId: dto.externalTransactionId,
        roundId: dto.roundId,
        gameId: dto.gameId,
        kind: 'ROLLBACK',
        money: rollbackMoney,
        idempotencyKey,
        payloadHash,
        referenceExternalTransactionId: refId,
      });

      const rejectedTx = pendingTx.markRejected('REVERSAL_INSUFFICIENT_FUNDS', response);
      await this.wagerRepo.save(rejectedTx);

      const rejectedEvent = new WagerTransactionRejectedEvent({
        aggregateId: wallet.id,
        correlationId,
        causationId: idempotencyKey,
        data: {
          transactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          providerId: dto.providerId,
          externalTransactionId: dto.externalTransactionId,
          roundId: dto.roundId,
          gameId: dto.gameId,
          kind: 'ROLLBACK',
          amount: { amount: rollbackMoney.getAmount(), currency: wallet.currency },
          balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
          failureCode: 'REVERSAL_INSUFFICIENT_FUNDS',
          referenceExternalTransactionId: refId,
        },
      });
      await this.outboxRepo.save(rejectedEvent);

      return response;
    }

    const previousBalanceAmount = wallet.balance.getAmount();
    const ledgerEntryId = crypto.randomUUID();
    const ledgerEntry = isDebit
      ? wallet.debit({ transactionId, amount: rollbackMoney, ledgerEntryId })
      : wallet.credit({ transactionId, amount: rollbackMoney, ledgerEntryId });
    await this.walletRepo.save(wallet);

    const response: WagerResponseDto = {
      transactionId,
      status: 'PROCESSED',
      balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
      idempotentReplay: false,
    };

    const pendingTx = WagerTransaction.createPending({
      id: transactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: 'ROLLBACK',
      money: rollbackMoney,
      idempotencyKey,
      payloadHash,
      referenceExternalTransactionId: refId,
    });

    const processedTx = pendingTx.markProcessed(response);
    await this.wagerRepo.save(processedTx);
    await this.ledgerRepo.save(ledgerEntry);

    const processedEvent = new WagerTransactionProcessedEvent({
      aggregateId: wallet.id,
      correlationId,
      causationId: idempotencyKey,
      data: {
        transactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: dto.providerId,
        externalTransactionId: dto.externalTransactionId,
        roundId: dto.roundId,
        gameId: dto.gameId,
        kind: 'ROLLBACK',
        amount: { amount: rollbackMoney.getAmount(), currency: wallet.currency },
        balance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
        referenceExternalTransactionId: refId,
      },
    });
    await this.outboxRepo.save(processedEvent);

    const balanceChangedEvent = new WalletBalanceChangedEvent({
      aggregateId: wallet.id,
      correlationId,
      causationId: idempotencyKey,
      data: {
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        previousBalance: { amount: previousBalanceAmount, currency: wallet.currency },
        currentBalance: { amount: wallet.balance.getAmount(), currency: wallet.currency },
        version: wallet.version,
        triggerTransactionId: transactionId,
      },
    });
    await this.outboxRepo.save(balanceChangedEvent);

    return response;
  }

  private assertReferenceCompatibility(
    refTx: WagerTransaction,
    wallet: any,
    dto: ProcessWagerDto,
    operationMoney: Money
  ): void {
    if (refTx.playerId !== dto.playerId) {
      throw new InvalidWagerOperationError(
        `Reference player mismatch: expected "${refTx.playerId}", got "${dto.playerId}"`
      );
    }
    if (refTx.walletId !== wallet.id) {
      throw new InvalidWagerOperationError(
        `Reference wallet mismatch: expected "${refTx.walletId}", got "${wallet.id}"`
      );
    }
    if (refTx.currency !== operationMoney.getCurrency()) {
      throw new CurrencyMismatchError(
        `Reference currency mismatch: expected "${refTx.currency}", got "${operationMoney.getCurrency()}"`
      );
    }
    if (refTx.roundId !== dto.roundId) {
      throw new InvalidWagerOperationError(
        `Reference round mismatch: expected "${refTx.roundId}", got "${dto.roundId}"`
      );
    }
    if (refTx.money.getAmount() !== operationMoney.getAmount()) {
      throw new InvalidWagerOperationError(
        `Reference amount mismatch: reversal must equal the full original amount "${refTx.money.getAmount()}", got "${operationMoney.getAmount()}"`
      );
    }
  }

  private validateDomainRules(idempotencyKey: string, dto: ProcessWagerDto): void {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
      throw new InvalidWagerOperationError('Idempotency key is mandatory');
    }
    if (idempotencyKey.trim().length > 255) {
      throw new InvalidWagerOperationError('Idempotency key exceeds maximum length of 255 characters');
    }

    const allowedKinds = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'];
    if (!allowedKinds.includes(dto.kind)) {
      throw new InvalidWagerOperationError(`Operation kind "${dto.kind}" is not permitted`);
    }

    if (!dto.providerId || !dto.externalTransactionId || !dto.playerId || !dto.walletId || !dto.roundId || !dto.gameId) {
      throw new InvalidWagerOperationError('Missing required business fields');
    }

    if ((dto.kind === 'REFUND' || dto.kind === 'ROLLBACK') && !dto.referenceExternalTransactionId) {
      throw new InvalidWagerOperationError(`Operation "${dto.kind}" requires referenceExternalTransactionId`);
    }
  }

  public static canonicalStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
      const items = value.map((item) => ProcessWagerUseCase.canonicalStringify(item));
      return `[${items.join(',')}]`;
    }

    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const entries: string[] = [];
    for (const key of sortedKeys) {
      const val = obj[key];
      if (val !== undefined) {
        entries.push(`${JSON.stringify(key)}:${ProcessWagerUseCase.canonicalStringify(val)}`);
      }
    }
    return `{${entries.join(',')}}`;
  }

  public static computePayloadHash(dto: ProcessWagerDto, _cleanKey?: string): string {
    const money = Money.create(dto.money.amount, dto.money.currency);
    const normalized: Record<string, any> = {
      externalTransactionId: dto.externalTransactionId.trim(),
      gameId: dto.gameId.trim(),
      kind: dto.kind,
      money: {
        amount: money.getAmount(),
        currency: money.getCurrency(),
      },
      playerId: dto.playerId.trim().toLowerCase(),
      providerId: dto.providerId.trim(),
      roundId: dto.roundId.trim(),
      walletId: dto.walletId.trim().toLowerCase(),
    };

    if (dto.referenceExternalTransactionId) {
      normalized.referenceExternalTransactionId = dto.referenceExternalTransactionId.trim();
    }

    const canonicalJson = ProcessWagerUseCase.canonicalStringify(normalized);
    return createHash('sha256').update(canonicalJson).digest('hex');
  }

  private identifyWagerUniqueConstraint(
    error: unknown
  ): 'IDEMPOTENCY_KEY' | 'PROVIDER_EXTERNAL' | 'REVERSAL_REFERENCE' | 'OTHER' | null {
    if (!error || typeof error !== 'object') {
      return null;
    }

    const visited = new Set<unknown>();
    const queue: unknown[] = [error];
    let has23505 = false;

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || typeof current !== 'object' || visited.has(current)) {
        continue;
      }
      visited.add(current);

      const rec = current as Record<string, unknown>;

      const code = typeof rec.code === 'string' ? rec.code : '';
      const constraint = typeof rec.constraint === 'string' ? rec.constraint : '';
      const message = typeof rec.message === 'string' ? rec.message : '';
      const detail = typeof rec.detail === 'string' ? rec.detail : '';

      const is23505 = code === '23505' || message.includes('23505');

      if (is23505) {
        has23505 = true;

        if (constraint === 'uq_wager_transactions_idempotency_key') {
          return 'IDEMPOTENCY_KEY';
        }
        if (constraint === 'uq_wager_transactions_provider_external') {
          return 'PROVIDER_EXTERNAL';
        }
        if (constraint === 'uq_processed_reversal_per_reference') {
          return 'REVERSAL_REFERENCE';
        }

        const fullText = `${constraint} ${message} ${detail}`;
        if (
          fullText.includes('uq_wager_transactions_idempotency_key') ||
          detail.includes('(idempotency_key)=') ||
          detail.includes('Key (idempotency_key)')
        ) {
          return 'IDEMPOTENCY_KEY';
        }
        if (
          fullText.includes('uq_wager_transactions_provider_external') ||
          detail.includes('(provider_id, external_transaction_id)=') ||
          detail.includes('Key (provider_id, external_transaction_id)')
        ) {
          return 'PROVIDER_EXTERNAL';
        }
        if (fullText.includes('uq_processed_reversal_per_reference')) {
          return 'REVERSAL_REFERENCE';
        }
      }

      if (rec.cause) queue.push(rec.cause);
      if (rec.originalError) queue.push(rec.originalError);
      if (rec.driverException) queue.push(rec.driverException);
      if (rec.driverError) queue.push(rec.driverError);
    }

    if (has23505) {
      return 'OTHER';
    }

    return null;
  }
}
