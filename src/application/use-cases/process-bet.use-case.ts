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
    // Canonical business fields in strict alphabetical order, excluding any transport metadata
    const canonicalBusinessPayload = {
      amount: dto.money.amount.trim(),
      currency: dto.money.currency.trim().toUpperCase(),
      externalTransactionId: dto.externalTransactionId.trim(),
      gameId: dto.gameId.trim(),
      kind: dto.kind.trim(),
      playerId: dto.playerId.trim(),
      providerId: dto.providerId.trim(),
      roundId: dto.roundId.trim(),
      walletId: dto.walletId.trim(),
    };

    const canonicalJson = JSON.stringify(canonicalBusinessPayload);
    return createHash('sha256').update(canonicalJson).digest('hex');
  }

  public async execute(idempotencyKey: string, dto: ProcessBetDto): Promise<WagerResponseDto> {
    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      throw new InvalidWagerOperationError('Idempotency-Key header is mandatory and cannot be empty');
    }
    const cleanIdempotencyKey = idempotencyKey.trim();

    if (!dto.kind || dto.kind !== 'BET') {
      throw new InvalidWagerOperationError(
        `Unsupported wager operation kind: "${dto.kind}". Only kind="BET" is supported in this delivery.`
      );
    }

    if (!dto.walletId || !dto.playerId || !dto.providerId || !dto.externalTransactionId || !dto.roundId || !dto.gameId) {
      throw new InvalidWagerOperationError('All wager business fields are required');
    }

    if (!dto.money || typeof dto.money.amount !== 'string' || typeof dto.money.currency !== 'string') {
      throw new InvalidMoneyError('money with string amount and currency is required');
    }

    const betCurrency = dto.money.currency.trim().toUpperCase();
    if (betCurrency !== 'BRL') {
      throw new InvalidMoneyError('Only BRL currency is currently supported');
    }

    const betMoney = Money.create(dto.money.amount, betCurrency);
    if (!betMoney.isPositive()) {
      throw new InvalidWagerOperationError('BET amount must be strictly greater than zero');
    }

    const payloadHash = ProcessBetUseCase.computePayloadHash(dto);

    return this.uow.runInTransaction(async () => {
      // 1. Lock wallet row explicitly for the current transaction
      const wallet = await this.walletRepo.findById(dto.walletId.trim(), true);
      if (!wallet) {
        throw new WalletNotFoundError(dto.walletId.trim());
      }

      if (wallet.playerId !== dto.playerId.trim()) {
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
          // Replay original response snapshot with original observed balance
          return existingByIdempotency.responseSnapshot as WagerResponseDto;
        } else {
          throw new IdempotencyConflictError(
            `Idempotency key "${cleanIdempotencyKey}" was previously submitted with a different payload`
          );
        }
      }

      const existingByProvider = await this.wagerRepo.findByProviderAndExternalId(
        dto.providerId.trim(),
        dto.externalTransactionId.trim()
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
        const responseSnapshot: WagerResponseDto = {
          status: 'REJECTED',
          transactionId,
          walletId: wallet.id,
          providerId: dto.providerId.trim(),
          externalTransactionId: dto.externalTransactionId.trim(),
          amount: betMoney.getAmount(),
          currency: betCurrency,
          observedBalance: wallet.balance.getAmount(),
          reason: 'INSUFFICIENT_FUNDS',
        };

        const rejectedTx = WagerTransaction.createBet({
          id: transactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          providerId: dto.providerId.trim(),
          externalTransactionId: dto.externalTransactionId.trim(),
          roundId: dto.roundId.trim(),
          gameId: dto.gameId.trim(),
          money: betMoney,
          status: 'REJECTED',
          rejectionReason: 'INSUFFICIENT_FUNDS',
          idempotencyKey: cleanIdempotencyKey,
          payloadHash,
          responseSnapshot,
        });

        await this.wagerRepo.save(rejectedTx);

        const rejectedEvent = new WagerTransactionRejectedEvent({
          transactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          providerId: dto.providerId.trim(),
          externalTransactionId: dto.externalTransactionId.trim(),
          roundId: dto.roundId.trim(),
          gameId: dto.gameId.trim(),
          kind: 'BET',
          amount: betMoney.getAmount(),
          currency: betCurrency,
          reason: 'INSUFFICIENT_FUNDS',
          observedBalance: wallet.balance.getAmount(),
        });
        await this.outboxRepo.save(rejectedEvent);

        return responseSnapshot;
      }

      // Sufficient funds: Process debit, increment version, create ledger entry, and save outbox events
      const previousBalanceStr = wallet.balance.getAmount();
      const ledgerEntryId = crypto.randomUUID();
      const ledgerEntry = wallet.debit({
        transactionId,
        amount: betMoney,
        ledgerEntryId,
      });

      const responseSnapshot: WagerResponseDto = {
        status: 'PROCESSED',
        transactionId,
        walletId: wallet.id,
        providerId: dto.providerId.trim(),
        externalTransactionId: dto.externalTransactionId.trim(),
        amount: betMoney.getAmount(),
        currency: betCurrency,
        observedBalance: wallet.balance.getAmount(),
        reason: null,
      };

      const processedTx = WagerTransaction.createBet({
        id: transactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: dto.providerId.trim(),
        externalTransactionId: dto.externalTransactionId.trim(),
        roundId: dto.roundId.trim(),
        gameId: dto.gameId.trim(),
        money: betMoney,
        status: 'PROCESSED',
        rejectionReason: null,
        idempotencyKey: cleanIdempotencyKey,
        payloadHash,
        responseSnapshot,
      });

      // Atomically persist wallet, wager transaction, ledger entry and outbox messages
      await this.walletRepo.save(wallet);
      await this.wagerRepo.save(processedTx);
      await this.ledgerRepo.save(ledgerEntry);

      const processedEvent = new WagerTransactionProcessedEvent({
        transactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: dto.providerId.trim(),
        externalTransactionId: dto.externalTransactionId.trim(),
        roundId: dto.roundId.trim(),
        gameId: dto.gameId.trim(),
        kind: 'BET',
        amount: betMoney.getAmount(),
        currency: betCurrency,
        observedBalance: wallet.balance.getAmount(),
      });
      await this.outboxRepo.save(processedEvent);

      const balanceChangedEvent = new WalletBalanceChangedEvent({
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: betCurrency,
        previousBalance: previousBalanceStr,
        currentBalance: wallet.balance.getAmount(),
        version: wallet.version,
        triggerTransactionId: transactionId,
      });
      await this.outboxRepo.save(balanceChangedEvent);

      return responseSnapshot;
    });
  }
}
