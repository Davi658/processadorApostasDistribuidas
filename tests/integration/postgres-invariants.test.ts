import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import pg from 'pg';
import {
  MikroOrmOutboxRepository,
  MikroOrmUnitOfWork,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletLedgerRepository,
  MikroOrmWalletRepository,
} from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-adapter';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import { GetWalletUseCase } from '../../src/application/use-cases/get-wallet.use-case';
import { ProcessWagerUseCase } from '../../src/application/use-cases/process-wager.use-case';
import { ReconcileWalletUseCase } from '../../src/application/use-cases/reconcile-wallet.use-case';
import {
  CurrencyMismatchError,
  DuplicateWalletError,
  IdempotencyConflictError,
  InvalidMoneyError,
  InvalidWagerOperationError,
  WalletNotFoundError,
} from '../../src/domain/errors/domain.error';
import { ProcessWagerDto } from '../../src/application/dto/wager.dto';
import { Money } from '../../src/domain/value-objects/money.vo';
import { createIsolatedTestDatabase, IsolatedTestDatabase } from '../test-db-helper';

describe('PostgreSQL Real Integration & Financial Invariants Tests', () => {
  let isolatedDb: IsolatedTestDatabase;
  let testPool: pg.Pool;
  let appPool: pg.Pool;
  let uow: MikroOrmUnitOfWork;
  let walletRepo: MikroOrmWalletRepository;
  let wagerRepo: MikroOrmWagerTransactionRepository;
  let ledgerRepo: MikroOrmWalletLedgerRepository;
  let outboxRepo: MikroOrmOutboxRepository;

  let createWalletUseCase: CreateWalletUseCase;
  let getWalletUseCase: GetWalletUseCase;
  let processWagerUseCase: ProcessWagerUseCase;
  let reconcileWalletUseCase: ReconcileWalletUseCase;

  beforeAll(async () => {
    // 1. Create dedicated disposable test database for complete test isolation
    isolatedDb = await createIsolatedTestDatabase('invariants_');

    testPool = new pg.Pool(isolatedDb.adminConfig);
    appPool = new pg.Pool(isolatedDb.appConfig);

    uow = new MikroOrmUnitOfWork();
    await uow.init();

    walletRepo = new MikroOrmWalletRepository(uow);
    wagerRepo = new MikroOrmWagerTransactionRepository(uow);
    ledgerRepo = new MikroOrmWalletLedgerRepository(uow);
    outboxRepo = new MikroOrmOutboxRepository(uow);

    createWalletUseCase = new CreateWalletUseCase(walletRepo, wagerRepo, ledgerRepo, outboxRepo, uow);
    getWalletUseCase = new GetWalletUseCase(walletRepo);
    processWagerUseCase = new ProcessWagerUseCase(walletRepo, wagerRepo, ledgerRepo, outboxRepo, uow);
    reconcileWalletUseCase = new ReconcileWalletUseCase(walletRepo, ledgerRepo, uow);
  }, 30000);

  afterAll(async () => {
    await uow.close();
    await appPool.end();
    await testPool.end();
    await isolatedDb.closeAndDrop();
  }, 30000);

  it('should create wallet with zero balance without ledger or opening transaction', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });

    expect(wallet.id).toBeDefined();
    expect(wallet.playerId).toBe(playerId);
    expect(wallet.balance.amount).toBe('0.00');
    expect(wallet.balance.currency).toBe('BRL');
    expect(wallet.version).toBe(1);

    const reloaded = await getWalletUseCase.execute(wallet.id);
    expect(reloaded.balance.amount).toBe('0.00');
    expect(reloaded.version).toBe(1);

    const txRes = await testPool.query(
      'SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = $1;',
      [wallet.id]
    );
    expect(Number(txRes.rows[0].count)).toBe(0);

    const ledgerRes = await testPool.query(
      'SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = $1;',
      [wallet.id]
    );
    expect(Number(ledgerRes.rows[0].count)).toBe(0);

    const outboxRes = await testPool.query(
      'SELECT COUNT(*) FROM outbox_messages WHERE aggregate_id = $1;',
      [wallet.id]
    );
    expect(Number(outboxRes.rows[0].count)).toBe(0);
  });

  it('should create wallet with positive balance, generating OPENING tx, CREDIT ledger, outbox events, with version 1', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    expect(wallet.id).toBeDefined();
    expect(wallet.playerId).toBe(playerId);
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.balance.currency).toBe('BRL');
    expect(wallet.version).toBe(1);

    const txRes = await testPool.query(
      "SELECT * FROM wager_transactions WHERE wallet_id = $1 AND kind = 'OPENING';",
      [wallet.id]
    );
    expect(txRes.rows.length).toBe(1);
    expect(Number(txRes.rows[0].amount)).toBe(100.0);
    expect(txRes.rows[0].status).toBe('PROCESSED');

    const ledgerRes = await testPool.query(
      "SELECT * FROM wallet_ledger_entries WHERE wallet_id = $1 AND entry_type = 'CREDIT';",
      [wallet.id]
    );
    expect(ledgerRes.rows.length).toBe(1);
    expect(Number(ledgerRes.rows[0].amount)).toBe(100.0);
    expect(Number(ledgerRes.rows[0].balance_before)).toBe(0.0);
    expect(Number(ledgerRes.rows[0].balance_after)).toBe(100.0);

    const outboxRes = await testPool.query(
      'SELECT * FROM outbox_messages WHERE aggregate_id = $1 ORDER BY created_at ASC;',
      [wallet.id]
    );
    expect(outboxRes.rows.length).toBe(2);
    expect(outboxRes.rows[0].event_type).toBe('WagerTransactionProcessed');
    expect(outboxRes.rows[1].event_type).toBe('WalletBalanceChanged');
  });

  it('should return DuplicateWalletError when creating duplicate wallet for same player and currency', async () => {
    const playerId = crypto.randomUUID();
    await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '50.00', currency: 'BRL' },
    });

    await expect(
      createWalletUseCase.execute({
        playerId,
        initialBalance: { amount: '10.00', currency: 'BRL' },
      })
    ).rejects.toThrow(DuplicateWalletError);
  });

  it('should process BET, deduct balance, increment version, and record DEBIT ledger entry and outbox', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const idempKey = `idemp-${crypto.randomUUID()}`;
    const betDto: ProcessWagerDto = {
      providerId: 'provider-1',
      externalTransactionId: `tx-ext-${crypto.randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };

    const res = await processWagerUseCase.execute(idempKey, betDto);
    expect(res.transactionId).toBeDefined();
    expect(res.status).toBe('PROCESSED');
    expect(res.balance.amount).toBe('75.00');
    expect(res.balance.currency).toBe('BRL');
    expect(res.idempotentReplay).toBe(false);

    const updatedWallet = await getWalletUseCase.execute(wallet.id);
    expect(updatedWallet.balance.amount).toBe('75.00');
    expect(updatedWallet.version).toBe(2);

    const ledgerRes = await testPool.query(
      "SELECT * FROM wallet_ledger_entries WHERE transaction_id = $1 AND entry_type = 'DEBIT';",
      [res.transactionId]
    );
    expect(ledgerRes.rows.length).toBe(1);
    expect(Number(ledgerRes.rows[0].amount)).toBe(25.0);
    expect(Number(ledgerRes.rows[0].balance_before)).toBe(100.0);
    expect(Number(ledgerRes.rows[0].balance_after)).toBe(75.0);
  });

  it('should reject BET on insufficient funds without balance mutation or ledger entry', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '30.00', currency: 'BRL' },
    });

    const rejectRes = await processWagerUseCase.execute(`idemp-${crypto.randomUUID()}`, {
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
    expect(reloaded.version).toBe(1);

    const ledgerRes = await testPool.query(
      'SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = $1;',
      [wallet.id]
    );
    expect(Number(ledgerRes.rows[0].count)).toBe(1);
  });

  it('should replay saved result with original observed balance when same idempotency key and payload are submitted', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const idempKey = `idemp-replay-${crypto.randomUUID()}`;
    const extId = `ext-${crypto.randomUUID()}`;

    const first = await processWagerUseCase.execute(idempKey, {
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

    await processWagerUseCase.execute(`idemp-other-${crypto.randomUUID()}`, {
      providerId: 'prv-1',
      externalTransactionId: `ext-other-${crypto.randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'r-2',
      gameId: 'g-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });

    const walletAfterOther = await getWalletUseCase.execute(wallet.id);
    expect(walletAfterOther.balance.amount).toBe('50.00');

    const replay = await processWagerUseCase.execute(idempKey, {
      providerId: 'prv-1',
      externalTransactionId: extId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'r-1',
      gameId: 'g-1',
      kind: 'BET',
      money: { amount: '40.00', currency: 'BRL' },
    });

    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.status).toBe('PROCESSED');
    expect(replay.balance.amount).toBe('60.00');
    expect(replay.idempotentReplay).toBe(true);

    const walletFinal = await getWalletUseCase.execute(wallet.id);
    expect(walletFinal.balance.amount).toBe('50.00');
  });

  it('should throw IdempotencyConflictError when same idempotency key is submitted with different payload', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const idempKey = `idemp-conflict-${crypto.randomUUID()}`;
    await processWagerUseCase.execute(idempKey, {
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
      processWagerUseCase.execute(idempKey, {
        providerId: 'prv-1',
        externalTransactionId: `ext-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'r-1',
        gameId: 'g-1',
        kind: 'BET',
        money: { amount: '20.00', currency: 'BRL' },
      })
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('should throw IdempotencyConflictError when different key is submitted for same provider and externalTransactionId', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const extId = `ext-dup-${crypto.randomUUID()}`;

    await processWagerUseCase.execute(`key-1-${crypto.randomUUID()}`, {
      providerId: 'prv-uniq',
      externalTransactionId: extId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'r-1',
      gameId: 'g-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });

    await expect(
      processWagerUseCase.execute(`key-2-${crypto.randomUUID()}`, {
        providerId: 'prv-uniq',
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

  describe('Correlation ID and Idempotency Key Limits (Requirement 1)', () => {
    it('should support Idempotency-Key lengths of 128, 129, and 255 characters without outbox persistence errors', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '300.00', currency: 'BRL' },
      });

      const key128 = 'a'.repeat(128);
      const key129 = 'b'.repeat(129);
      const key255 = 'c'.repeat(255);

      const res128 = await processWagerUseCase.execute(key128, {
        providerId: 'prv-key-len',
        externalTransactionId: `ext-128-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-len',
        gameId: 'gm-len',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      });
      expect(res128.status).toBe('PROCESSED');

      const res129 = await processWagerUseCase.execute(key129, {
        providerId: 'prv-key-len',
        externalTransactionId: `ext-129-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-len',
        gameId: 'gm-len',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      });
      expect(res129.status).toBe('PROCESSED');

      const res255 = await processWagerUseCase.execute(key255, {
        providerId: 'prv-key-len',
        externalTransactionId: `ext-255-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-len',
        gameId: 'gm-len',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      });
      expect(res255.status).toBe('PROCESSED');

      // Verify all outbox messages were safely persisted with independent correlationId
      const outboxMessages = await outboxRepo.listUnpublished(10);
      expect(outboxMessages.length).toBeGreaterThanOrEqual(6);
      for (const msg of outboxMessages) {
        expect(typeof msg.correlationId).toBe('string');
        expect(msg.correlationId.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Composite Foreign Key: Ledger to WagerTransaction (Requirement 3)', () => {
    it('should reject ledger insertion referencing a transaction of another wallet', async () => {
      const walletA = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      const walletB = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const txA = await processWagerUseCase.execute(`key-txA-${crypto.randomUUID()}`, {
        providerId: 'prv-fk',
        externalTransactionId: `ext-txA-${crypto.randomUUID()}`,
        playerId: walletA.playerId,
        walletId: walletA.id,
        roundId: 'rnd-fk',
        gameId: 'gm-fk',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      });

      // Attempt inserting ledger for wallet B referencing transaction of wallet A
      let fkFailed = false;
      try {
        await testPool.query(`
          INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, entry_type, amount, currency, balance_before, balance_after, created_at)
          VALUES ('${crypto.randomUUID()}', '${walletB.id}', '${txA.transactionId}', 'DEBIT', 10.00, 'BRL', 100.00, 90.00, NOW());
        `);
      } catch (err: any) {
        fkFailed = true;
      }
      expect(fkFailed).toBe(true);
    });

    it('should reject ledger insertion referencing transaction with different currency', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const tx = await processWagerUseCase.execute(`key-tx-curr-${crypto.randomUUID()}`, {
        providerId: 'prv-fk',
        externalTransactionId: `ext-tx-curr-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-fk',
        gameId: 'gm-fk',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      });

      let currMismatchFailed = false;
      try {
        await testPool.query(`
          INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, entry_type, amount, currency, balance_before, balance_after, created_at)
          VALUES ('${crypto.randomUUID()}', '${wallet.id}', '${tx.transactionId}', 'DEBIT', 10.00, 'USD', 100.00, 90.00, NOW());
        `);
      } catch {
        currMismatchFailed = true;
      }
      expect(currMismatchFailed).toBe(true);
    });

    it('should reject ledger insertion referencing non-existent transaction', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      let nonExistentFailed = false;
      try {
        await testPool.query(`
          INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, entry_type, amount, currency, balance_before, balance_after, created_at)
          VALUES ('${crypto.randomUUID()}', '${wallet.id}', '${crypto.randomUUID()}', 'DEBIT', 10.00, 'BRL', 100.00, 90.00, NOW());
        `);
      } catch {
        nonExistentFailed = true;
      }
      expect(nonExistentFailed).toBe(true);
    });
  });

  describe('Terminal Transaction Trigger Protection (Requirement 2)', () => {
    it('should prevent altering protected fields of PROCESSED or REJECTED transactions as application user', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      const tx = await processWagerUseCase.execute(`key-prot-${crypto.randomUUID()}`, {
        providerId: 'prv-prot',
        externalTransactionId: `ext-prot-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'rnd-prot',
        gameId: 'gm-prot',
        kind: 'BET',
        money: { amount: '20.00', currency: 'BRL' },
      });

      // Attempt altering amount on PROCESSED tx
      let amountModFailed = false;
      try {
        await appPool.query(
          'UPDATE wager_transactions SET amount = 50.00 WHERE id = $1;',
          [tx.transactionId]
        );
      } catch (err: any) {
        amountModFailed = true;
      }
      expect(amountModFailed).toBe(true);

      // Attempt altering status on PROCESSED tx
      let statusModFailed = false;
      try {
        await appPool.query(
          "UPDATE wager_transactions SET status = 'REJECTED' WHERE id = $1;",
          [tx.transactionId]
        );
      } catch (err: any) {
        statusModFailed = true;
      }
      expect(statusModFailed).toBe(true);

      // Attempt altering idempotency_key on PROCESSED tx
      let idempModFailed = false;
      try {
        await appPool.query(
          "UPDATE wager_transactions SET idempotency_key = 'hacked' WHERE id = $1;",
          [tx.transactionId]
        );
      } catch {
        idempModFailed = true;
      }
      expect(idempModFailed).toBe(true);
    });
  });

  describe('Independent Domain & Use Case Invariants (Requirement 4)', () => {
    it('should reject BET with non-positive amount in domain without depending on HTTP', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      await expect(
        processWagerUseCase.execute(`key-zero-${crypto.randomUUID()}`, {
          providerId: 'prv-val',
          externalTransactionId: `ext-zero-${crypto.randomUUID()}`,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'rnd-val',
          gameId: 'gm-val',
          kind: 'BET',
          money: { amount: '0.00', currency: 'BRL' },
        })
      ).rejects.toThrow(InvalidWagerOperationError);
    });

    it('should reject non-canonical representations like "00.00" in Money.create', () => {
      expect(() => Money.create('00.00', 'BRL')).toThrow(InvalidMoneyError);
      expect(() => Money.create('01.50', 'BRL')).toThrow(InvalidMoneyError);
    });

    it('should reject player-wallet mismatch in use case', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      await expect(
        processWagerUseCase.execute(`key-p-mismatch-${crypto.randomUUID()}`, {
          providerId: 'prv-val',
          externalTransactionId: `ext-p-${crypto.randomUUID()}`,
          playerId: crypto.randomUUID(), // Different player
          walletId: wallet.id,
          roundId: 'rnd-val',
          gameId: 'gm-val',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        })
      ).rejects.toThrow(InvalidWagerOperationError);
    });

    it('should reject empty or missing idempotency key', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      await expect(
        processWagerUseCase.execute('   ', {
          providerId: 'prv-val',
          externalTransactionId: `ext-${crypto.randomUUID()}`,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'rnd-val',
          gameId: 'gm-val',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        })
      ).rejects.toThrow(InvalidWagerOperationError);
    });
  });

  describe('Atomic Fault Injections (Requirement 8)', () => {
    it('should rollback completely when failure injected after wallet save, leaving no changes, then succeed on retry', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      uow.setTestHook('after_wallet_save', () => {
        throw new Error('SIMULATED_FAILURE_AFTER_WALLET_SAVE');
      });

      const idempKey = `fail-w-${crypto.randomUUID()}`;
      const extId = `ext-fail-w-${crypto.randomUUID()}`;
      const betDto: ProcessWagerDto = {
        providerId: 'prv-fail',
        externalTransactionId: extId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'r-fail',
        gameId: 'g-fail',
        kind: 'BET',
        money: { amount: '30.00', currency: 'BRL' },
      };

      await expect(processWagerUseCase.execute(idempKey, betDto)).rejects.toThrow('SIMULATED_FAILURE_AFTER_WALLET_SAVE');

      // Verify zero partial changes remained
      const checkWallet = await getWalletUseCase.execute(wallet.id);
      expect(checkWallet.balance.amount).toBe('100.00');
      expect(checkWallet.version).toBe(1);

      uow.clearTestHooks();

      // Retry should succeed cleanly
      const retryRes = await processWagerUseCase.execute(idempKey, betDto);
      expect(retryRes.status).toBe('PROCESSED');
      expect(retryRes.balance.amount).toBe('70.00');
    });

    it('should rollback completely when failure injected after tx save, leaving no changes, then succeed on retry', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      uow.setTestHook('after_tx_save', () => {
        throw new Error('SIMULATED_FAILURE_AFTER_TX_SAVE');
      });

      const idempKey = `fail-tx-${crypto.randomUUID()}`;
      const extId = `ext-fail-tx-${crypto.randomUUID()}`;
      const betDto: ProcessWagerDto = {
        providerId: 'prv-fail',
        externalTransactionId: extId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'r-fail',
        gameId: 'g-fail',
        kind: 'BET',
        money: { amount: '30.00', currency: 'BRL' },
      };

      await expect(processWagerUseCase.execute(idempKey, betDto)).rejects.toThrow('SIMULATED_FAILURE_AFTER_TX_SAVE');

      const checkWallet = await getWalletUseCase.execute(wallet.id);
      expect(checkWallet.balance.amount).toBe('100.00');

      uow.clearTestHooks();

      const retryRes = await processWagerUseCase.execute(idempKey, betDto);
      expect(retryRes.status).toBe('PROCESSED');
      expect(retryRes.balance.amount).toBe('70.00');
    });

    it('should rollback completely when failure injected after ledger save', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      uow.setTestHook('after_ledger_save', () => {
        throw new Error('SIMULATED_FAILURE_AFTER_LEDGER_SAVE');
      });

      await expect(
        processWagerUseCase.execute(`fail-ledger-${crypto.randomUUID()}`, {
          providerId: 'prv-fail',
          externalTransactionId: `ext-fail-l-${crypto.randomUUID()}`,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'r-fail',
          gameId: 'g-fail',
          kind: 'BET',
          money: { amount: '30.00', currency: 'BRL' },
        })
      ).rejects.toThrow('SIMULATED_FAILURE_AFTER_LEDGER_SAVE');

      uow.clearTestHooks();
      const checkWallet = await getWalletUseCase.execute(wallet.id);
      expect(checkWallet.balance.amount).toBe('100.00');
    });

    it('should rollback completely when failure injected after outbox save', async () => {
      const wallet = await createWalletUseCase.execute({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      uow.setTestHook('after_outbox_save', () => {
        throw new Error('SIMULATED_FAILURE_AFTER_OUTBOX_SAVE');
      });

      await expect(
        processWagerUseCase.execute(`fail-outbox-${crypto.randomUUID()}`, {
          providerId: 'prv-fail',
          externalTransactionId: `ext-fail-o-${crypto.randomUUID()}`,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'r-fail',
          gameId: 'g-fail',
          kind: 'BET',
          money: { amount: '30.00', currency: 'BRL' },
        })
      ).rejects.toThrow('SIMULATED_FAILURE_AFTER_OUTBOX_SAVE');

      uow.clearTestHooks();
      const checkWallet = await getWalletUseCase.execute(wallet.id);
      expect(checkWallet.balance.amount).toBe('100.00');
    });
  });

  describe('Security & Privileges', () => {
    it('should enforce application user least-privilege security (TRUNCATE forbidden)', async () => {
      let truncateFailed = false;
      try {
        await appPool.query('TRUNCATE TABLE wallets;');
      } catch {
        truncateFailed = true;
      }
      expect(truncateFailed).toBe(true);
    });
  });
});
