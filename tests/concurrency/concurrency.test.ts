import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
import { ProcessBetUseCase } from '../../src/application/use-cases/process-bet.use-case';
import { ReconcileWalletUseCase } from '../../src/application/use-cases/reconcile-wallet.use-case';
import { DatabaseMigrator } from '../../src/infrastructure/persistence/migrator';
import { getMigrationDatabaseConfig } from '../../src/infrastructure/config/database.config';
import { ProcessBetDto } from '../../src/application/dto/wager.dto';

describe('High-Concurrency Invariants with Real PostgreSQL', () => {
  let migrator: DatabaseMigrator;
  let testPool: pg.Pool;
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
      max: 60, // Sized for 50 concurrent transactions
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
    await migrator.close();
  });

  it('50 simultaneous submissions of the same BET produces exactly ONE debit and consistent reconciliation', async () => {
    // 1. Setup wallet with 100.00
    const wallet = await createWalletUseCase.execute({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const payload: ProcessBetDto = {
      providerId: 'provider-p1',
      externalTransactionId: `ext-50-${crypto.randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-50',
      gameId: 'game-50',
      kind: 'BET',
      money: {
        amount: '30.00',
        currency: 'BRL',
      },
    };

    const idempotencyKey = `idemp-50-${crypto.randomUUID()}`;

    // 2. Fire 50 simultaneous submissions in parallel
    const promises = Array.from({ length: 50 }, () =>
      processBetUseCase.execute(idempotencyKey, payload)
    );

    const results = await Promise.all(promises);

    // 3. Verify all 50 calls succeeded with valid result and observed balance 70.00
    expect(results.length).toBe(50);
    for (const r of results) {
      expect(r.status).toBe('PROCESSED');
      expect(r.balance.amount).toBe('70.00');
      expect(r.balance.currency).toBe('BRL');
    }

    // Exactly 1 must have idempotentReplay = false, and 49 must have idempotentReplay = true
    const freshExecutions = results.filter((r) => r.idempotentReplay === false).length;
    const replayExecutions = results.filter((r) => r.idempotentReplay === true).length;
    expect(freshExecutions).toBe(1);
    expect(replayExecutions).toBe(49);

    // 4. Verify wallet balance in DB is strictly 70.00 and version is exactly 2
    const finalWallet = await getWalletUseCase.execute(wallet.id);
    expect(finalWallet.balance.amount).toBe('70.00');
    expect(finalWallet.version).toBe(2);

    // 5. Verify exactly 1 BET transaction exists in DB
    const txCount = await testPool.query(
      "SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET';",
      [wallet.id]
    );
    expect(Number(txCount.rows[0].count)).toBe(1);

    // 6. Verify ledger entries: exactly 2 (1 OPENING credit + 1 BET debit)
    const ledgerCount = await testPool.query(
      'SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = $1;',
      [wallet.id]
    );
    expect(Number(ledgerCount.rows[0].count)).toBe(2);

    // 7. Verify outbox: 2 for opening + 2 for BET (Processed + BalanceChanged) = 4 messages
    const outboxCount = await testPool.query(
      'SELECT COUNT(*) FROM outbox_messages WHERE aggregate_id = $1;',
      [wallet.id]
    );
    expect(Number(outboxCount.rows[0].count)).toBe(4);

    // 8. Reconcile endpoint: stored balance equals calculated balance
    const recon = await reconcileWalletUseCase.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe('70.00');
    expect(recon.calculatedBalance.amount).toBe('70.00');
    expect(recon.difference.amount).toBe('0.00');
    expect(recon.checkedEntries).toBe(2);
  }, 30000);

  it('Two concurrent BETs of 80.00 on 100.00 balance: exactly ONE processed, ONE rejected, final balance 20.00', async () => {
    const wallet = await createWalletUseCase.execute({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const bet1: ProcessBetDto = {
      providerId: 'provider-race',
      externalTransactionId: `ext-race-1-${crypto.randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-race-1',
      gameId: 'game-race',
      kind: 'BET',
      money: { amount: '80.00', currency: 'BRL' },
    };

    const bet2: ProcessBetDto = {
      providerId: 'provider-race',
      externalTransactionId: `ext-race-2-${crypto.randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-race-2',
      gameId: 'game-race',
      kind: 'BET',
      money: { amount: '80.00', currency: 'BRL' },
    };

    const [res1, res2] = await Promise.all([
      processBetUseCase.execute(`idemp-race-1-${crypto.randomUUID()}`, bet1),
      processBetUseCase.execute(`idemp-race-2-${crypto.randomUUID()}`, bet2),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);

    const rejectedRes = res1.status === 'REJECTED' ? res1 : res2;
    expect(rejectedRes.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(rejectedRes.balance.amount).toBe('20.00');

    // Final balance must be exactly 20.00, version 2
    const finalWallet = await getWalletUseCase.execute(wallet.id);
    expect(finalWallet.balance.amount).toBe('20.00');
    expect(finalWallet.version).toBe(2);

    // Ledger has exactly 2 entries (OPENING credit + 1 single BET debit)
    const ledgerCount = await testPool.query(
      'SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = $1;',
      [wallet.id]
    );
    expect(Number(ledgerCount.rows[0].count)).toBe(2);

    // Reconcile
    const recon = await reconcileWalletUseCase.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe('20.00');
    expect(recon.calculatedBalance.amount).toBe('20.00');
    expect(recon.difference.amount).toBe('0.00');
    expect(recon.checkedEntries).toBe(2);
  }, 30000);

  it('Repeat concurrency scenarios with at least THREE independent OS application processes sharing PostgreSQL using synchronization barrier', async () => {
    const wallet = await createWalletUseCase.execute({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const bunBin = process.execPath;
    const workerScript = join(import.meta.dir, 'worker.ts');
    const barrierPath = join(tmpdir(), `barrier_${Date.now()}_${Math.random().toString(36).substring(7)}.tmp`);

    const spawnWorker = (idempKey: string, payload: ProcessBetDto): Promise<any> => {
      return new Promise((resolve, reject) => {
        const child = spawn(bunBin, ['run', workerScript, idempKey, JSON.stringify(payload), barrierPath], {
          env: process.env,
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (d) => (stdout += d.toString()));
        child.stderr.on('data', (d) => (stderr += d.toString()));

        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`Worker timed out after 15000ms: stdout="${stdout}" stderr="${stderr}"`));
        }, 15000);

        child.on('close', (code) => {
          clearTimeout(timer);
          if (code !== 0) {
            reject(new Error(`Worker exited with code ${code}: ${stderr}`));
            return;
          }
          try {
            const parsed = JSON.parse(stdout.trim());
            resolve(parsed);
          } catch {
            reject(new Error(`Worker output invalid JSON: "${stdout}"`));
          }
        });
      });
    };

    const betPayloads: ProcessBetDto[] = [
      {
        providerId: 'provider-multi',
        externalTransactionId: `ext-proc-1-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-mp-1',
        gameId: 'game-mp',
        kind: 'BET',
        money: { amount: '80.00', currency: 'BRL' },
      },
      {
        providerId: 'provider-multi',
        externalTransactionId: `ext-proc-2-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-mp-2',
        gameId: 'game-mp',
        kind: 'BET',
        money: { amount: '80.00', currency: 'BRL' },
      },
      {
        providerId: 'provider-multi',
        externalTransactionId: `ext-proc-3-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-mp-3',
        gameId: 'game-mp',
        kind: 'BET',
        money: { amount: '80.00', currency: 'BRL' },
      },
    ];

    // Start all 3 workers
    const workerPromises = Promise.all([
      spawnWorker(`idemp-proc-1-${crypto.randomUUID()}`, betPayloads[0]),
      spawnWorker(`idemp-proc-2-${crypto.randomUUID()}`, betPayloads[1]),
      spawnWorker(`idemp-proc-3-${crypto.randomUUID()}`, betPayloads[2]),
    ]);

    // Give child processes 500ms to spin up and reach the barrier loop
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Release the barrier so all 3 workers trigger at the exact same millisecond
    writeFileSync(barrierPath, 'RELEASE');

    try {
      const results = await workerPromises;
      expect(results.length).toBe(3);
      for (const r of results) {
        if (!r.ok) {
          throw new Error(`Worker returned error: ${r.error} (code: ${r.code})`);
        }
      }

      const statuses = results.map((r) => r.data.status);
      const processedCount = statuses.filter((s) => s === 'PROCESSED').length;
      const rejectedCount = statuses.filter((s) => s === 'REJECTED').length;

      expect(processedCount).toBe(1);
      expect(rejectedCount).toBe(2);

      // Verify wallet in DB is exactly 20.00 and version 2
      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('20.00');
      expect(finalWallet.version).toBe(2);

      // Verify ledger has exactly 2 entries (OPENING + 1 debit)
      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('20.00');
      expect(recon.calculatedBalance.amount).toBe('20.00');
      expect(recon.difference.amount).toBe('0.00');
      expect(recon.checkedEntries).toBe(2);
    } finally {
      if (existsSync(barrierPath)) {
        unlinkSync(barrierPath);
      }
    }
  }, 30000);
});
