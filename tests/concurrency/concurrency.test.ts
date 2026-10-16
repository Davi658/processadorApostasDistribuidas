import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import pg from 'pg';
import {
  PostgresOutboxRepository,
  PostgresUnitOfWork,
  PostgresWagerTransactionRepository,
  PostgresWalletLedgerRepository,
  PostgresWalletRepository,
} from '../../src/infrastructure/persistence/postgres/postgres-adapter';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import { GetWalletUseCase } from '../../src/application/use-cases/get-wallet.use-case';
import { ProcessBetUseCase } from '../../src/application/use-cases/process-bet.use-case';
import { ReconcileWalletUseCase } from '../../src/application/use-cases/reconcile-wallet.use-case';
import { DatabaseMigrator } from '../../src/infrastructure/persistence/migrator';

describe('High-Concurrency Invariants with Real PostgreSQL', () => {
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
      max: 60, // Sized for 50 concurrent connections
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

  it('50 simultaneous submissions of the same BET produces exactly ONE debit and consistent reconciliation', async () => {
    // 1. Setup wallet with 100.00
    const wallet = await createWalletUseCase.execute({
      playerId: `player-concurrent-50-${crypto.randomUUID()}`,
      currency: 'BRL',
      initialBalance: '100.00',
    });

    const payload = {
      providerId: 'provider-p1',
      externalTransactionId: `ext-50-${crypto.randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
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

    // 3. Verify all 50 calls succeeded with identical result
    expect(results.length).toBe(50);
    for (const r of results) {
      expect(r.status).toBe('PROCESSED');
      expect(r.amount).toBe('30.00');
      expect(r.observedBalance).toBe('70.00');
    }

    // 4. Verify wallet state in DB
    const finalWallet = await getWalletUseCase.execute(wallet.walletId);
    expect(finalWallet.balance).toBe('70.00'); // Exactly ONE debit occurred
    expect(finalWallet.version).toBe(2); // Initial version was 1, incremented by 1

    // 5. Verify ledger entries: exactly 2 entries (OPENING + 1 DEBIT)
    const ledgers = await testPool.query(
      'SELECT * FROM wallet_ledger_entries WHERE wallet_id = $1 ORDER BY created_at ASC',
      [wallet.walletId]
    );
    expect(ledgers.rows.length).toBe(2);
    expect(ledgers.rows[0].entry_type).toBe('CREDIT');
    expect(ledgers.rows[0].amount).toBe('100.00');
    expect(ledgers.rows[1].entry_type).toBe('DEBIT');
    expect(ledgers.rows[1].amount).toBe('30.00');

    // 6. Reconciliation must be 100% consistent with 0.00 difference
    const recon = await reconcileWalletUseCase.execute(wallet.walletId);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance).toBe('70.00');
    expect(recon.calculatedBalance).toBe('70.00');
    expect(recon.difference).toBe('0.00');
    expect(recon.checkedEntries).toBe(2);
  }, 30000);

  it('Two concurrent BETs of 80.00 on 100.00 balance: exactly ONE processed, ONE rejected, final balance 20.00', async () => {
    // 1. Setup wallet with 100.00
    const wallet = await createWalletUseCase.execute({
      playerId: `player-two-bets-${crypto.randomUUID()}`,
      currency: 'BRL',
      initialBalance: '100.00',
    });

    const payloadA = {
      providerId: 'provider-p1',
      externalTransactionId: `ext-bet-a-${crypto.randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-race-1',
      gameId: 'game-race',
      kind: 'BET',
      money: {
        amount: '80.00',
        currency: 'BRL',
      },
    };

    const payloadB = {
      providerId: 'provider-p1',
      externalTransactionId: `ext-bet-b-${crypto.randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-race-2',
      gameId: 'game-race',
      kind: 'BET',
      money: {
        amount: '80.00',
        currency: 'BRL',
      },
    };

    // 2. Execute both bets concurrently
    const [resA, resB] = await Promise.all([
      processBetUseCase.execute(`idemp-race-a-${crypto.randomUUID()}`, payloadA),
      processBetUseCase.execute(`idemp-race-b-${crypto.randomUUID()}`, payloadB),
    ]);

    const statuses = [resA.status, resB.status];
    expect(statuses).toContain('PROCESSED');
    expect(statuses).toContain('REJECTED');

    const processed = resA.status === 'PROCESSED' ? resA : resB;
    const rejected = resA.status === 'REJECTED' ? resA : resB;

    expect(processed.observedBalance).toBe('20.00');
    expect(rejected.reason).toBe('INSUFFICIENT_FUNDS');

    // 3. Final wallet balance in DB must be exactly 20.00
    const finalWallet = await getWalletUseCase.execute(wallet.walletId);
    expect(finalWallet.balance).toBe('20.00');
    expect(finalWallet.version).toBe(2);

    // 4. Ledger entries: exactly 2 entries (OPENING + single DEBIT of 80.00)
    const ledgers = await testPool.query(
      'SELECT * FROM wallet_ledger_entries WHERE wallet_id = $1 ORDER BY created_at ASC',
      [wallet.walletId]
    );
    expect(ledgers.rows.length).toBe(2);
    expect(ledgers.rows[0].entry_type).toBe('CREDIT');
    expect(ledgers.rows[0].amount).toBe('100.00');
    expect(ledgers.rows[1].entry_type).toBe('DEBIT');
    expect(ledgers.rows[1].amount).toBe('80.00');

    // 5. Reconciliation must match perfectly
    const recon = await reconcileWalletUseCase.execute(wallet.walletId);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance).toBe('20.00');
    expect(recon.calculatedBalance).toBe('20.00');
    expect(recon.difference).toBe('0.00');
    expect(recon.checkedEntries).toBe(2);
  }, 30000);

  it('Repeat concurrency scenarios with at least THREE independent OS application processes sharing PostgreSQL', async () => {
    // 1. Setup wallet for multi-process test with 100.00
    const wallet = await createWalletUseCase.execute({
      playerId: `player-multi-proc-${crypto.randomUUID()}`,
      currency: 'BRL',
      initialBalance: '100.00',
    });

    const bunBin = join(process.env.USERPROFILE || '', '.bun', 'bin', 'bun.exe');
    const workerScript = join(import.meta.dir, 'worker.ts');

    const spawnWorker = (idempKey: string, payload: any): Promise<any> => {
      return new Promise((resolve, reject) => {
        const child = spawn(bunBin, ['run', workerScript, idempKey, JSON.stringify(payload)], {
          env: process.env,
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (d) => (stdout += d.toString()));
        child.stderr.on('data', (d) => (stderr += d.toString()));

        child.on('close', (code) => {
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

    // Scenario 1 across 3 OS processes: 3 distinct worker processes racing with 80.00 BETs on 100.00
    // Only ONE process can debit, the other two must be rejected for insufficient balance!
    const betPayloads = [
      {
        providerId: 'provider-multi',
        externalTransactionId: `ext-proc-1-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: 'round-mp-1',
        gameId: 'game-mp',
        kind: 'BET',
        money: { amount: '80.00', currency: 'BRL' },
      },
      {
        providerId: 'provider-multi',
        externalTransactionId: `ext-proc-2-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: 'round-mp-2',
        gameId: 'game-mp',
        kind: 'BET',
        money: { amount: '80.00', currency: 'BRL' },
      },
      {
        providerId: 'provider-multi',
        externalTransactionId: `ext-proc-3-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: 'round-mp-3',
        gameId: 'game-mp',
        kind: 'BET',
        money: { amount: '80.00', currency: 'BRL' },
      },
    ];

    const results = await Promise.all([
      spawnWorker(`idemp-proc-1-${crypto.randomUUID()}`, betPayloads[0]),
      spawnWorker(`idemp-proc-2-${crypto.randomUUID()}`, betPayloads[1]),
      spawnWorker(`idemp-proc-3-${crypto.randomUUID()}`, betPayloads[2]),
    ]);

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

    // Verify wallet in DB is exactly 20.00
    const finalWallet = await getWalletUseCase.execute(wallet.walletId);
    expect(finalWallet.balance).toBe('20.00');
    expect(finalWallet.version).toBe(2);

    // Verify ledger has exactly 2 entries (OPENING + 1 debit)
    const recon = await reconcileWalletUseCase.execute(wallet.walletId);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance).toBe('20.00');
    expect(recon.calculatedBalance).toBe('20.00');
    expect(recon.difference).toBe('0.00');
    expect(recon.checkedEntries).toBe(2);
  }, 30000);
});
