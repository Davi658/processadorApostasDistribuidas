import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import pg from 'pg';
import {
  MikroOrmOutboxRepository,
  MikroOrmUnitOfWork,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletLedgerRepository,
  MikroOrmWalletRepository,
} from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-adapter';
import { DatabaseMigrator } from '../../src/infrastructure/persistence/migrator';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import { GetWalletUseCase } from '../../src/application/use-cases/get-wallet.use-case';
import { ProcessBetUseCase } from '../../src/application/use-cases/process-bet.use-case';
import { ReconcileWalletUseCase } from '../../src/application/use-cases/reconcile-wallet.use-case';
import {
  CurrencyMismatchError,
  DuplicateWalletError,
  IdempotencyConflictError,
  WalletNotFoundError,
} from '../../src/domain/errors/domain.error';
import {
  getAppDatabaseConfig,
  getMigrationDatabaseConfig,
} from '../../src/infrastructure/config/database.config';

describe('PostgreSQL Real Integration & Financial Invariants Tests', () => {
  let migrator: DatabaseMigrator;
  let testPool: pg.Pool;
  let appPool: pg.Pool;
  let uow: MikroOrmUnitOfWork;
  let walletRepo: MikroOrmWalletRepository;
  let wagerRepo: MikroOrmWagerTransactionRepository;
  let ledgerRepo: MikroOrmWalletLedgerRepository;
  let outboxRepo: MikroOrmOutboxRepository;

  let createWalletUseCase: CreateWalletUseCase;
  let getWalletUseCase: GetWalletUseCase;
  let processBetUseCase: ProcessBetUseCase;
  let reconcileWalletUseCase: ReconcileWalletUseCase;

  beforeAll(async () => {
    migrator = new DatabaseMigrator();
    await migrator.up();

    const migConfig = getMigrationDatabaseConfig();
    testPool = new pg.Pool({
      host: migConfig.host,
      port: migConfig.port,
      database: migConfig.database,
      user: migConfig.user,
      password: migConfig.password,
    });

    const appConfig = getAppDatabaseConfig();
    appPool = new pg.Pool({
      host: appConfig.host,
      port: appConfig.port,
      database: appConfig.database,
      user: appConfig.user,
      password: appConfig.password,
    });

    uow = new MikroOrmUnitOfWork();
    await uow.init();

    walletRepo = new MikroOrmWalletRepository(uow);
    wagerRepo = new MikroOrmWagerTransactionRepository(uow);
    ledgerRepo = new MikroOrmWalletLedgerRepository(uow);
    outboxRepo = new MikroOrmOutboxRepository(uow);

    createWalletUseCase = new CreateWalletUseCase(walletRepo, wagerRepo, ledgerRepo, outboxRepo, uow);
    getWalletUseCase = new GetWalletUseCase(walletRepo);
    processBetUseCase = new ProcessBetUseCase(walletRepo, wagerRepo, ledgerRepo, outboxRepo, uow);
    reconcileWalletUseCase = new ReconcileWalletUseCase(walletRepo, ledgerRepo, uow);
  });

  afterAll(async () => {
    await uow.close();
    await testPool.end();
    await appPool.end();
    await migrator.close();
  });

  it('should create wallet with zero balance without ledger or opening transaction', async () => {
    const playerId = `player-zero-${crypto.randomUUID()}`;
    const res = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });

    expect(res.id).toBeDefined();
    expect(res.playerId).toBe(playerId);
    expect(res.balance.amount).toBe('0.00');
    expect(res.balance.currency).toBe('BRL');
    expect(res.version).toBe(1);

    const ledgerRes = await testPool.query(
      'SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = $1;',
      [res.id]
    );
    expect(Number(ledgerRes.rows[0].count)).toBe(0);

    const txRes = await testPool.query(
      'SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = $1;',
      [res.id]
    );
    expect(Number(txRes.rows[0].count)).toBe(0);
  });

  it('should create wallet with positive balance, generating OPENING tx, CREDIT ledger, outbox events, with version 1', async () => {
    const playerId = `player-positive-${crypto.randomUUID()}`;
    const res = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    expect(res.id).toBeDefined();
    expect(res.playerId).toBe(playerId);
    expect(res.balance.amount).toBe('100.00');
    expect(res.version).toBe(1);

    const ledgerRes = await testPool.query(
      'SELECT * FROM wallet_ledger_entries WHERE wallet_id = $1;',
      [res.id]
    );
    expect(ledgerRes.rows.length).toBe(1);
    expect(ledgerRes.rows[0].entry_type).toBe('CREDIT');
    expect(ledgerRes.rows[0].amount).toBe('100.00');
    expect(ledgerRes.rows[0].balance_after).toBe('100.00');

    const txRes = await testPool.query(
      'SELECT * FROM wager_transactions WHERE wallet_id = $1;',
      [res.id]
    );
    expect(txRes.rows.length).toBe(1);
    expect(txRes.rows[0].kind).toBe('OPENING');
    expect(txRes.rows[0].status).toBe('PROCESSED');

    const outboxRes = await testPool.query(
      'SELECT * FROM outbox_messages WHERE aggregate_id = $1 ORDER BY event_type ASC;',
      [res.id]
    );
    expect(outboxRes.rows.length).toBe(2);
    expect(outboxRes.rows[0].event_type).toBe('WagerTransactionProcessed');
    expect(outboxRes.rows[1].event_type).toBe('WalletBalanceChanged');
  });

  it('should return DuplicateWalletError when creating duplicate wallet for same player and currency', async () => {
    const playerId = `player-dup-${crypto.randomUUID()}`;
    await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '50.00', currency: 'BRL' },
    });

    await expect(
      createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '50.00', currency: 'BRL' },
      })
    ).rejects.toThrow(DuplicateWalletError);
  });

  it('should process BET, deduct balance, increment version, and record DEBIT ledger entry and outbox', async () => {
    const playerId = `bettor-${crypto.randomUUID()}`;
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '200.00', currency: 'BRL' },
    });

    const betRes = await processBetUseCase.execute(`idemp-${crypto.randomUUID()}`, {
      providerId: 'prv-1',
      externalTransactionId: `tx-ext-${crypto.randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'rnd-1',
      gameId: 'gm-1',
      kind: 'BET',
      money: { amount: '50.00', currency: 'BRL' },
    });

    expect(betRes.status).toBe('PROCESSED');
    expect(betRes.balance.amount).toBe('150.00');
    expect(betRes.balance.currency).toBe('BRL');
    expect(betRes.idempotentReplay).toBe(false);

    const reloaded = await getWalletUseCase.execute(wallet.id);
    expect(reloaded.balance.amount).toBe('150.00');
    expect(reloaded.version).toBe(2);

    const recon = await reconcileWalletUseCase.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe('150.00');
    expect(recon.calculatedBalance.amount).toBe('150.00');
    expect(recon.difference.amount).toBe('0.00');
    expect(recon.checkedEntries).toBe(2);
  });

  it('should reject BET on insufficient funds without balance mutation or ledger entry', async () => {
    const playerId = `poor-bettor-${crypto.randomUUID()}`;
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '30.00', currency: 'BRL' },
    });

    const rejectRes = await processBetUseCase.execute(`idemp-${crypto.randomUUID()}`, {
      providerId: 'prv-1',
      externalTransactionId: `tx-ext-${crypto.randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'rnd-1',
      gameId: 'gm-1',
      kind: 'BET',
      money: { amount: '50.00', currency: 'BRL' },
    });

    expect(rejectRes.status).toBe('REJECTED');
    expect(rejectRes.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(rejectRes.balance.amount).toBe('30.00');
    expect(rejectRes.idempotentReplay).toBe(false);

    const reloaded = await getWalletUseCase.execute(wallet.id);
    expect(reloaded.balance.amount).toBe('30.00');
    expect(reloaded.version).toBe(1); // Version not changed

    const ledgerRes = await testPool.query(
      'SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = $1;',
      [wallet.id]
    );
    expect(Number(ledgerRes.rows[0].count)).toBe(1); // Only the initial opening entry
  });

  it('should replay saved result with original observed balance when same idempotency key and payload are submitted', async () => {
    const playerId = `replay-player-${crypto.randomUUID()}`;
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const idempKey = `idemp-replay-${crypto.randomUUID()}`;
    const extId = `ext-${crypto.randomUUID()}`;

    const first = await processBetUseCase.execute(idempKey, {
      providerId: 'prv-1',
      externalTransactionId: extId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'r-1',
      gameId: 'g-1',
      kind: 'BET',
      money: { amount: '40.00', currency: 'BRL' },
    });

    expect(first.status).toBe('PROCESSED');
    expect(first.balance.amount).toBe('60.00');
    expect(first.idempotentReplay).toBe(false);

    // Another bet changes the balance to 30.00
    await processBetUseCase.execute(`idemp-other-${crypto.randomUUID()}`, {
      providerId: 'prv-1',
      externalTransactionId: `ext-other-${crypto.randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'r-2',
      gameId: 'g-1',
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
    });

    const currentWallet = await getWalletUseCase.execute(wallet.id);
    expect(currentWallet.balance.amount).toBe('30.00');

    // Replay of first BET: MUST preserve original observed balance 60.00!
    const replay = await processBetUseCase.execute(idempKey, {
      providerId: 'prv-1',
      externalTransactionId: extId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'r-1',
      gameId: 'g-1',
      kind: 'BET',
      money: { amount: '40.00', currency: 'BRL' },
    });

    expect(replay.status).toBe('PROCESSED');
    expect(replay.balance.amount).toBe('60.00');
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.idempotentReplay).toBe(true);
  });

  it('should throw IdempotencyConflictError when same idempotency key is submitted with different payload', async () => {
    const playerId = `conflict-player-${crypto.randomUUID()}`;
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const idempKey = `idemp-conflict-${crypto.randomUUID()}`;
    await processBetUseCase.execute(idempKey, {
      providerId: 'prv-1',
      externalTransactionId: `ext-${crypto.randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'r-1',
      gameId: 'g-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });

    await expect(
      processBetUseCase.execute(idempKey, {
        providerId: 'prv-1',
        externalTransactionId: `ext-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'r-1',
        gameId: 'g-1',
        kind: 'BET',
        money: { amount: '20.00', currency: 'BRL' }, // Different amount
      })
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('should throw IdempotencyConflictError when same key is disputed by different wallets', async () => {
    const wallet1 = await createWalletUseCase.execute({
      playerId: `p1-${crypto.randomUUID()}`,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const wallet2 = await createWalletUseCase.execute({
      playerId: `p2-${crypto.randomUUID()}`,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const idempKey = `idemp-dispute-${crypto.randomUUID()}`;

    await processBetUseCase.execute(idempKey, {
      providerId: 'prv-1',
      externalTransactionId: `ext-${crypto.randomUUID()}`,
      playerId: wallet1.playerId,
      walletId: wallet1.id,
      roundId: 'r-1',
      gameId: 'g-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });

    await expect(
      processBetUseCase.execute(idempKey, {
        providerId: 'prv-1',
        externalTransactionId: `ext-${crypto.randomUUID()}`,
        playerId: wallet2.playerId,
        walletId: wallet2.id, // Different wallet
        roundId: 'r-1',
        gameId: 'g-1',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      })
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('should throw IdempotencyConflictError when different key is submitted for same provider and externalTransactionId', async () => {
    const playerId = `dup-ext-player-${crypto.randomUUID()}`;
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const extId = `shared-ext-${crypto.randomUUID()}`;

    await processBetUseCase.execute(`key-1-${crypto.randomUUID()}`, {
      providerId: 'prv-dup',
      externalTransactionId: extId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'r-1',
      gameId: 'g-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });

    await expect(
      processBetUseCase.execute(`key-2-${crypto.randomUUID()}`, {
        providerId: 'prv-dup',
        externalTransactionId: extId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'r-1',
        gameId: 'g-1',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      })
    ).rejects.toThrow(IdempotencyConflictError);
  });

  describe('Atomic Fault Injections (Requirement 8)', () => {
    it('should rollback completely when failure injected after wallet save, leaving no changes, then succeed on retry', async () => {
      const playerId = `fault-w-${crypto.randomUUID()}`;
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const idempKey = `fault-idemp-${crypto.randomUUID()}`;
      const extId = `fault-ext-${crypto.randomUUID()}`;
      const dto = {
        providerId: 'p-fault',
        externalTransactionId: extId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'r-1',
        gameId: 'g-1',
        kind: 'BET' as const,
        money: { amount: '30.00', currency: 'BRL' },
      };

      // Set fault point after wallet save
      uow.setTestFailurePoint('after_wallet_save');

      await expect(processBetUseCase.execute(idempKey, dto)).rejects.toThrow();

      // Verify ZERO changes remained
      const reloaded = await getWalletUseCase.execute(wallet.id);
      expect(reloaded.balance.amount).toBe('100.00');
      expect(reloaded.version).toBe(1);

      const txRes = await testPool.query(
        'SELECT COUNT(*) FROM wager_transactions WHERE idempotency_key = $1;',
        [idempKey]
      );
      expect(Number(txRes.rows[0].count)).toBe(0);

      // Clear failure point and resend same operation
      uow.clearTestFailurePoints();
      const res = await processBetUseCase.execute(idempKey, dto);
      expect(res.status).toBe('PROCESSED');
      expect(res.balance.amount).toBe('70.00');

      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('70.00');
      expect(finalWallet.version).toBe(2);
    });

    it('should rollback completely when failure injected after tx save, leaving no changes, then succeed on retry', async () => {
      const playerId = `fault-tx-${crypto.randomUUID()}`;
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const idempKey = `fault-tx-idemp-${crypto.randomUUID()}`;
      const dto = {
        providerId: 'p-fault',
        externalTransactionId: `fault-tx-ext-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'r-1',
        gameId: 'g-1',
        kind: 'BET' as const,
        money: { amount: '40.00', currency: 'BRL' },
      };

      uow.setTestFailurePoint('after_tx_save');
      await expect(processBetUseCase.execute(idempKey, dto)).rejects.toThrow();

      // Verify no changes
      const reloaded = await getWalletUseCase.execute(wallet.id);
      expect(reloaded.balance.amount).toBe('100.00');

      uow.clearTestFailurePoints();
      const res = await processBetUseCase.execute(idempKey, dto);
      expect(res.status).toBe('PROCESSED');
      expect(res.balance.amount).toBe('60.00');
    });

    it('should rollback completely when failure injected after ledger save', async () => {
      const playerId = `fault-ld-${crypto.randomUUID()}`;
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const idempKey = `fault-ld-idemp-${crypto.randomUUID()}`;
      const dto = {
        providerId: 'p-fault',
        externalTransactionId: `fault-ld-ext-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'r-1',
        gameId: 'g-1',
        kind: 'BET' as const,
        money: { amount: '20.00', currency: 'BRL' },
      };

      uow.setTestFailurePoint('after_ledger_save');
      await expect(processBetUseCase.execute(idempKey, dto)).rejects.toThrow();

      const reloaded = await getWalletUseCase.execute(wallet.id);
      expect(reloaded.balance.amount).toBe('100.00');

      uow.clearTestFailurePoints();
      const res = await processBetUseCase.execute(idempKey, dto);
      expect(res.status).toBe('PROCESSED');
      expect(res.balance.amount).toBe('80.00');
    });

    it('should rollback completely when failure injected after outbox save', async () => {
      const playerId = `fault-outbox-${crypto.randomUUID()}`;
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const idempKey = `fault-ob-idemp-${crypto.randomUUID()}`;
      const dto = {
        providerId: 'p-fault',
        externalTransactionId: `fault-ob-ext-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'r-1',
        gameId: 'g-1',
        kind: 'BET' as const,
        money: { amount: '25.00', currency: 'BRL' },
      };

      uow.setTestFailurePoint('after_outbox_save');
      await expect(processBetUseCase.execute(idempKey, dto)).rejects.toThrow();

      const reloaded = await getWalletUseCase.execute(wallet.id);
      expect(reloaded.balance.amount).toBe('100.00');

      uow.clearTestFailurePoints();
      const res = await processBetUseCase.execute(idempKey, dto);
      expect(res.status).toBe('PROCESSED');
      expect(res.balance.amount).toBe('75.00');
    });
  });

  describe('Database Guarantees & Constraints (Requirement 6)', () => {
    it('should enforce database-level immutability preventing UPDATE or DELETE on ledger', async () => {
      const playerId = `ledger-protect-${crypto.randomUUID()}`;
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '80.00', currency: 'BRL' },
      });

      const ledgerRes = await testPool.query(
        'SELECT id FROM wallet_ledger_entries WHERE wallet_id = $1 LIMIT 1;',
        [wallet.id]
      );
      const entryId = ledgerRes.rows[0].id;

      // Attempting UPDATE must fail via trigger
      let updateFailed = false;
      try {
        await testPool.query('UPDATE wallet_ledger_entries SET amount = 999.00 WHERE id = $1;', [entryId]);
      } catch {
        updateFailed = true;
      }
      expect(updateFailed).toBe(true);

      // Attempting DELETE must fail via trigger
      let deleteFailed = false;
      try {
        await testPool.query('DELETE FROM wallet_ledger_entries WHERE id = $1;', [entryId]);
      } catch {
        deleteFailed = true;
      }
      expect(deleteFailed).toBe(true);
    });

    it('should enforce terminal transaction status protection via database trigger', async () => {
      const playerId = `term-protect-${crypto.randomUUID()}`;
      const wallet = await createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '80.00', currency: 'BRL' },
      });

      const txRes = await testPool.query(
        'SELECT id FROM wager_transactions WHERE wallet_id = $1 LIMIT 1;',
        [wallet.id]
      );
      const txId = txRes.rows[0].id;

      // Attempting to alter terminal status must fail via trigger
      let termFailed = false;
      try {
        await testPool.query("UPDATE wager_transactions SET status = 'REJECTED' WHERE id = $1;", [txId]);
      } catch {
        termFailed = true;
      }
      expect(termFailed).toBe(true);
    });

    it('should enforce application user least-privilege security (TRUNCATE forbidden)', async () => {
      let truncateFailed = false;
      try {
        await appPool.query('TRUNCATE TABLE wallets;');
      } catch {
        truncateFailed = true;
      }
      expect(truncateFailed).toBe(true);
    });

    it('should reject invalid arithmetic on ledger via database CHECK constraint', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: `chk-arith-${crypto.randomUUID()}`,
        initialBalance: { amount: '50.00', currency: 'BRL' },
      });

      let checkFailed = false;
      try {
        await testPool.query(`
          INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, entry_type, amount, currency, balance_before, balance_after, created_at)
          VALUES (
            '${crypto.randomUUID()}',
            '${wallet.id}',
            (SELECT id FROM wager_transactions WHERE wallet_id = '${wallet.id}' LIMIT 1),
            'CREDIT',
            10.00,
            'BRL',
            50.00,
            70.00,
            NOW()
          );
        `);
      } catch {
        checkFailed = true;
      }
      expect(checkFailed).toBe(true);
    });
  });
});
