import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import pg from 'pg';
import {
  PostgresOutboxRepository,
  PostgresUnitOfWork,
  PostgresWagerTransactionRepository,
  PostgresWalletLedgerRepository,
  PostgresWalletRepository,
} from '../../src/infrastructure/persistence/postgres/postgres-adapter';
import { DatabaseMigrator } from '../../src/infrastructure/persistence/migrator';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import { GetWalletUseCase } from '../../src/application/use-cases/get-wallet.use-case';
import { ProcessBetUseCase } from '../../src/application/use-cases/process-bet.use-case';
import { ReconcileWalletUseCase } from '../../src/application/use-cases/reconcile-wallet.use-case';
import {
  CurrencyMismatchError,
  DuplicateWalletError,
  IdempotencyConflictError,
  InvalidMoneyError,
  InvalidWagerOperationError,
  WalletNotFoundError,
} from '../../src/domain/errors/domain.error';

describe('PostgreSQL Real Integration Tests', () => {
  let migrator: DatabaseMigrator;
  let testPool: pg.Pool;
  let uow: PostgresUnitOfWork;
  let walletRepo: PostgresWalletRepository;
  let wagerRepo: PostgresWagerTransactionRepository;
  let ledgerRepo: PostgresWalletLedgerRepository;
  let outboxRepo: PostgresOutboxRepository;

  let createWalletUseCase: CreateWalletUseCase;
  let getWalletUseCase: GetWalletUseCase;
  let processBetUseCase: ProcessBetUseCase;
  let reconcileWalletUseCase: ReconcileWalletUseCase;

  beforeAll(async () => {
    migrator = new DatabaseMigrator();
    await migrator.up();

    testPool = new pg.Pool({
      host: '127.0.0.1',
      port: 5432,
      database: 'betting_db',
      user: 'postgres',
      password: '',
      max: 20,
    });

    uow = new PostgresUnitOfWork(testPool);
    walletRepo = new PostgresWalletRepository(uow);
    wagerRepo = new PostgresWagerTransactionRepository(uow);
    ledgerRepo = new PostgresWalletLedgerRepository(uow);
    outboxRepo = new PostgresOutboxRepository(uow);

    createWalletUseCase = new CreateWalletUseCase(walletRepo, wagerRepo, ledgerRepo, outboxRepo, uow);
    getWalletUseCase = new GetWalletUseCase(walletRepo);
    processBetUseCase = new ProcessBetUseCase(walletRepo, wagerRepo, ledgerRepo, outboxRepo, uow);
    reconcileWalletUseCase = new ReconcileWalletUseCase(walletRepo, ledgerRepo, uow);

    await testPool.query('TRUNCATE TABLE outbox_messages, wallet_ledger_entries, wager_transactions, wallets CASCADE');
  });

  afterAll(async () => {
    await testPool.end();
    await migrator.close();
  });

  it('should create wallet with zero balance without ledger or opening transaction', async () => {
    const res = await createWalletUseCase.execute({
      playerId: `player-zero-${crypto.randomUUID()}`,
      currency: 'BRL',
    });

    expect(res.walletId).toBeDefined();
    expect(res.balance).toBe('0.00');
    expect(res.version).toBe(1);

    const txs = await testPool.query('SELECT * FROM wager_transactions WHERE wallet_id = $1', [res.walletId]);
    expect(txs.rows.length).toBe(0);

    const ledgers = await testPool.query('SELECT * FROM wallet_ledger_entries WHERE wallet_id = $1', [res.walletId]);
    expect(ledgers.rows.length).toBe(0);
  });

  it('should create wallet with positive balance, generating OPENING tx and CREDIT ledger, with version 1', async () => {
    const res = await createWalletUseCase.execute({
      playerId: `player-positive-${crypto.randomUUID()}`,
      currency: 'BRL',
      initialBalance: '100.00',
    });

    expect(res.balance).toBe('100.00');
    expect(res.version).toBe(1);

    const txs = await testPool.query('SELECT * FROM wager_transactions WHERE wallet_id = $1', [res.walletId]);
    expect(txs.rows.length).toBe(1);
    expect(txs.rows[0].kind).toBe('OPENING');
    expect(txs.rows[0].amount).toBe('100.00');
    expect(txs.rows[0].status).toBe('PROCESSED');

    const ledgers = await testPool.query('SELECT * FROM wallet_ledger_entries WHERE wallet_id = $1', [res.walletId]);
    expect(ledgers.rows.length).toBe(1);
    expect(ledgers.rows[0].entry_type).toBe('CREDIT');
    expect(ledgers.rows[0].amount).toBe('100.00');
    expect(ledgers.rows[0].balance_before).toBe('0.00');
    expect(ledgers.rows[0].balance_after).toBe('100.00');

    const reconciliation = await reconcileWalletUseCase.execute(res.walletId);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.storedBalance).toBe('100.00');
    expect(reconciliation.calculatedBalance).toBe('100.00');
    expect(reconciliation.difference).toBe('0.00');
    expect(reconciliation.checkedEntries).toBe(1);
  });

  it('should return DuplicateWalletError when creating duplicate wallet for same player and currency', async () => {
    const playerId = `player-dup-${crypto.randomUUID()}`;
    await createWalletUseCase.execute({
      playerId,
      currency: 'BRL',
    });

    await expect(
      createWalletUseCase.execute({
        playerId,
        currency: 'BRL',
      })
    ).rejects.toThrow(DuplicateWalletError);
  });

  it('should process BET, deduct balance, increment version, and record DEBIT ledger entry and outbox', async () => {
    const wallet = await createWalletUseCase.execute({
      playerId: `player-bet-1-${crypto.randomUUID()}`,
      currency: 'BRL',
      initialBalance: '100.00',
    });

    const betRes = await processBetUseCase.execute(`idemp-bet-${crypto.randomUUID()}`, {
      providerId: 'provider-1',
      externalTransactionId: `ext-tx-${crypto.randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: {
        amount: '80.00',
        currency: 'BRL',
      },
    });

    expect(betRes.status).toBe('PROCESSED');
    expect(betRes.observedBalance).toBe('20.00');

    const updatedWallet = await getWalletUseCase.execute(wallet.walletId);
    expect(updatedWallet.balance).toBe('20.00');
    expect(updatedWallet.version).toBe(2);

    const ledgers = await testPool.query(
      'SELECT * FROM wallet_ledger_entries WHERE wallet_id = $1 ORDER BY created_at ASC',
      [wallet.walletId]
    );
    expect(ledgers.rows.length).toBe(2);
    expect(ledgers.rows[1].entry_type).toBe('DEBIT');
    expect(ledgers.rows[1].amount).toBe('80.00');
    expect(ledgers.rows[1].balance_before).toBe('100.00');
    expect(ledgers.rows[1].balance_after).toBe('20.00');

    const reconciliation = await reconcileWalletUseCase.execute(wallet.walletId);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.storedBalance).toBe('20.00');
    expect(reconciliation.calculatedBalance).toBe('20.00');
    expect(reconciliation.difference).toBe('0.00');
    expect(reconciliation.checkedEntries).toBe(2);
  });

  it('should reject BET on insufficient funds without balance mutation or ledger entry', async () => {
    const wallet = await createWalletUseCase.execute({
      playerId: `player-bet-poor-${crypto.randomUUID()}`,
      currency: 'BRL',
      initialBalance: '50.00',
    });

    const idempKey = `idemp-bet-fail-${crypto.randomUUID()}`;
    const betRes = await processBetUseCase.execute(idempKey, {
      providerId: 'provider-1',
      externalTransactionId: `ext-tx-fail-${crypto.randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-fail',
      gameId: 'game-fail',
      kind: 'BET',
      money: {
        amount: '80.00',
        currency: 'BRL',
      },
    });

    expect(betRes.status).toBe('REJECTED');
    expect(betRes.reason).toBe('INSUFFICIENT_FUNDS');
    expect(betRes.observedBalance).toBe('50.00');

    const unchangedWallet = await getWalletUseCase.execute(wallet.walletId);
    expect(unchangedWallet.balance).toBe('50.00');
    expect(unchangedWallet.version).toBe(1);

    const ledgers = await testPool.query('SELECT * FROM wallet_ledger_entries WHERE wallet_id = $1', [wallet.walletId]);
    expect(ledgers.rows.length).toBe(1);

    const txs = await testPool.query(
      'SELECT status, rejection_reason FROM wager_transactions WHERE idempotency_key = $1',
      [idempKey]
    );
    expect(txs.rows.length).toBe(1);
    expect(txs.rows[0].status).toBe('REJECTED');
    expect(txs.rows[0].rejection_reason).toBe('INSUFFICIENT_FUNDS');
  });

  it('should replay saved result with original observed balance when same idempotency key and payload are submitted', async () => {
    const wallet = await createWalletUseCase.execute({
      playerId: `player-replay-${crypto.randomUUID()}`,
      currency: 'BRL',
      initialBalance: '100.00',
    });

    const payload = {
      providerId: 'prov-rep',
      externalTransactionId: `ext-rep-1-${crypto.randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-rep',
      gameId: 'game-rep',
      kind: 'BET',
      money: {
        amount: '30.00',
        currency: 'BRL',
      },
    };

    const idempKey = `idemp-replay-${crypto.randomUUID()}`;
    const firstResult = await processBetUseCase.execute(idempKey, payload);
    expect(firstResult.status).toBe('PROCESSED');
    expect(firstResult.observedBalance).toBe('70.00');

    await processBetUseCase.execute(`idemp-other-${crypto.randomUUID()}`, {
      ...payload,
      externalTransactionId: `ext-rep-2-${crypto.randomUUID()}`,
      money: { amount: '30.00', currency: 'BRL' },
    });

    const currentWallet = await getWalletUseCase.execute(wallet.walletId);
    expect(currentWallet.balance).toBe('40.00');

    const replayResult = await processBetUseCase.execute(idempKey, payload);
    expect(replayResult.status).toBe('PROCESSED');
    expect(replayResult.observedBalance).toBe('70.00');
  });

  it('should throw IdempotencyConflictError when same idempotency key is submitted with different payload', async () => {
    const wallet = await createWalletUseCase.execute({
      playerId: `player-conflict-${crypto.randomUUID()}`,
      currency: 'BRL',
      initialBalance: '100.00',
    });

    const idempKey = `idemp-conf-key-${crypto.randomUUID()}`;
    const payload1 = {
      providerId: 'prov-conf',
      externalTransactionId: `ext-conf-1-${crypto.randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-conf',
      gameId: 'game-conf',
      kind: 'BET',
      money: { amount: '50.00', currency: 'BRL' },
    };

    await processBetUseCase.execute(idempKey, payload1);

    const payload2 = {
      ...payload1,
      money: { amount: '60.00', currency: 'BRL' },
    };

    await expect(
      processBetUseCase.execute(idempKey, payload2)
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('should throw IdempotencyConflictError when different key is submitted for same provider and externalTransactionId', async () => {
    const wallet = await createWalletUseCase.execute({
      playerId: `player-ext-conflict-${crypto.randomUUID()}`,
      currency: 'BRL',
      initialBalance: '100.00',
    });

    const basePayload = {
      providerId: 'prov-shared',
      externalTransactionId: `ext-shared-${crypto.randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-ext',
      gameId: 'game-ext',
      kind: 'BET',
      money: { amount: '20.00', currency: 'BRL' },
    };

    await processBetUseCase.execute(`key-alpha-${crypto.randomUUID()}`, basePayload);

    await expect(
      processBetUseCase.execute(`key-beta-${crypto.randomUUID()}`, basePayload)
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('should rollback transaction completely if an error occurs before commit', async () => {
    const wallet = await createWalletUseCase.execute({
      playerId: `player-rollback-${crypto.randomUUID()}`,
      currency: 'BRL',
      initialBalance: '100.00',
    });

    try {
      await uow.runInTransaction(async () => {
        const w = await walletRepo.findById(wallet.walletId, true);
        w!.debit({
          transactionId: crypto.randomUUID(),
          amount: (await import('../../src/domain/value-objects/money.vo')).Money.create('50.00', 'BRL'),
          ledgerEntryId: crypto.randomUUID(),
        });
        await walletRepo.save(w!);
        throw new Error('Simulated database write failure before commit');
      });
    } catch (err: any) {
      expect(err.message).toBe('Simulated database write failure before commit');
    }

    const freshWallet = await getWalletUseCase.execute(wallet.walletId);
    expect(freshWallet.balance).toBe('100.00');
    expect(freshWallet.version).toBe(1);
  });

  it('should enforce database-level immutability preventing UPDATE or DELETE on ledger', async () => {
    const wallet = await createWalletUseCase.execute({
      playerId: `player-immutable-${crypto.randomUUID()}`,
      currency: 'BRL',
      initialBalance: '50.00',
    });

    await expect(
      testPool.query("UPDATE wallet_ledger_entries SET amount = 999.00 WHERE wallet_id = $1", [wallet.walletId])
    ).rejects.toThrow(/Modifications and deletions are strictly prohibited/);

    await expect(
      testPool.query("DELETE FROM wallet_ledger_entries WHERE wallet_id = $1", [wallet.walletId])
    ).rejects.toThrow(/Modifications and deletions are strictly prohibited/);
  });
});
