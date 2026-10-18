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
import { ProcessBetDto } from '../../src/application/dto/wager.dto';
import { IdempotencyConflictError } from '../../src/domain/errors/domain.error';
import { createIsolatedTestDatabase, IsolatedTestDatabase } from '../test-db-helper';
import ormConfig from '../../src/infrastructure/persistence/mikro-orm/mikro-orm.config';

describe('High-Concurrency Invariants with Real PostgreSQL', () => {
  let isolatedDb: IsolatedTestDatabase;
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
    isolatedDb = await createIsolatedTestDatabase('concurr_');

    testPool = new pg.Pool({
      ...isolatedDb.adminConfig,
      max: 60, // Sized for 50 concurrent transactions
    });

    // The 50 submitted operations queue behind ten real connections. The old
    // 1s acquisition budget made host scheduling a financial test assertion.
    // Keep concurrency and all financial assertions; bound admission to 10s.
    uow = new MikroOrmUnitOfWork({ ...ormConfig, pool: { min: 0, max: 10, acquireTimeoutMillis: 10000 } });
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
    await isolatedDb.closeAndDrop();
  });

  it('50 simultaneous submissions of the same BET produces exactly ONE debit and consistent reconciliation', async () => {
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

    // Fire 50 simultaneous submissions in parallel
    const promises = Array.from({ length: 50 }, () =>
      processBetUseCase.execute(idempotencyKey, payload)
    );

    const results = await Promise.all(promises);

    expect(results.length).toBe(50);
    for (const res of results) {
      expect(res.status).toBe('PROCESSED');
      expect(res.balance.amount).toBe('70.00');
      expect(res.balance.currency).toBe('BRL');
    }

    const firstProcessed = results.filter((r) => !r.idempotentReplay);
    const replays = results.filter((r) => r.idempotentReplay);
    expect(firstProcessed.length).toBe(1);
    expect(replays.length).toBe(49);

    const updatedWallet = await getWalletUseCase.execute(wallet.id);
    expect(updatedWallet.balance.amount).toBe('70.00');
    expect(updatedWallet.version).toBe(2);

    const txCount = await testPool.query(
      "SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET';",
      [wallet.id]
    );
    expect(Number(txCount.rows[0].count)).toBe(1);

    const ledgerCount = await testPool.query(
      'SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = $1;',
      [wallet.id]
    );
    expect(Number(ledgerCount.rows[0].count)).toBe(2);

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

    const finalWallet = await getWalletUseCase.execute(wallet.id);
    expect(finalWallet.balance.amount).toBe('20.00');
    expect(finalWallet.version).toBe(2);

    const recon = await reconcileWalletUseCase.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe('20.00');
    expect(recon.calculatedBalance.amount).toBe('20.00');
    expect(recon.difference.amount).toBe('0.00');
    expect(recon.checkedEntries).toBe(2);
  }, 30000);

  it('Disputed idempotency key between different wallets in parallel race: exactly one processed, one conflict, loser wallet unaffected', async () => {
    const wallet1 = await createWalletUseCase.execute({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const wallet2 = await createWalletUseCase.execute({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const sharedIdempKey = `shared-key-race-${crypto.randomUUID()}`;

    const req1 = processBetUseCase.execute(sharedIdempKey, {
      providerId: 'prv-race',
      externalTransactionId: `ext-race-w1-${crypto.randomUUID()}`,
      playerId: wallet1.playerId,
      walletId: wallet1.id,
      roundId: 'rnd-race',
      gameId: 'gm-race',
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
    });

    const req2 = processBetUseCase.execute(sharedIdempKey, {
      providerId: 'prv-race',
      externalTransactionId: `ext-race-w2-${crypto.randomUUID()}`,
      playerId: wallet2.playerId,
      walletId: wallet2.id,
      roundId: 'rnd-race',
      gameId: 'gm-race',
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
    });

    const [settled1, settled2] = await Promise.allSettled([req1, req2]);

    const fulfilled = [settled1, settled2].filter((s) => s.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    const rejected = [settled1, settled2].filter((s) => s.status === 'rejected') as PromiseRejectedResult[];

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0].reason).toBeInstanceOf(IdempotencyConflictError);

    const winnerWalletId = settled1.status === 'fulfilled' ? wallet1.id : wallet2.id;
    const loserWalletId = winnerWalletId === wallet1.id ? wallet2.id : wallet1.id;

    // Winner wallet had debit applied
    const winnerWallet = await getWalletUseCase.execute(winnerWalletId);
    expect(winnerWallet.balance.amount).toBe('70.00');
    expect(winnerWallet.version).toBe(2);

    // Loser wallet was NOT modified: balance 100.00, version 1
    const loserWallet = await getWalletUseCase.execute(loserWalletId);
    expect(loserWallet.balance.amount).toBe('100.00');
    expect(loserWallet.version).toBe(1);

    // Loser wallet has no debit in ledger
    const loserLedger = await testPool.query(
      "SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = $1 AND entry_type = 'DEBIT';",
      [loserWalletId]
    );
    expect(Number(loserLedger.rows[0].count)).toBe(0);

    // Outbox has no duplicate or leaked events for loser wallet
    const loserOutbox = await testPool.query(
      "SELECT COUNT(*) FROM outbox_messages WHERE aggregate_id = $1 AND event_type = 'WagerTransactionProcessed';",
      [loserWalletId]
    );
    expect(Number(loserOutbox.rows[0].count)).toBe(1); // Only initial opening

    const reconWinner = await reconcileWalletUseCase.execute(winnerWalletId);
    expect(reconWinner.consistent).toBe(true);

    const reconLoser = await reconcileWalletUseCase.execute(loserWalletId);
    expect(reconLoser.consistent).toBe(true);
  });

  it('Repeat concurrency scenarios with at least THREE independent OS application processes using synchronization barrier', async () => {
    const wallet = await createWalletUseCase.execute({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const bunBin = process.execPath;
    const workerScript = join(import.meta.dir, 'worker.ts');
    const barrierPath = join(tmpdir(), `barrier_${Date.now()}_${Math.random().toString(36).substring(7)}.tmp`);

    const spawnWorker = (idempKey: string, payload: ProcessBetDto) => {
      let markReady: () => void;
      const readyPromise = new Promise<void>((resolve) => {
        markReady = resolve;
      });

      const resultPromise = new Promise<any>((resolve, reject) => {
        let child: any;
        try {
          child = spawn(bunBin, ['run', workerScript, idempKey, JSON.stringify(payload), barrierPath], {
            env: {
              ...process.env,
              DB_NAME: isolatedDb.dbName,
            },
          });
        } catch (err) {
          return reject(err);
        }

        child.on('error', (err: any) => reject(err));

        let stdout = '';
        let stderr = '';
        let signaledReady = false;

        child.stdout.on('data', (d: any) => {
          stdout += d.toString();
          if (!signaledReady && stdout.includes('READY')) {
            signaledReady = true;
            markReady();
          }
        });

        child.stderr.on('data', (d: any) => (stderr += d.toString()));

        const timer = setTimeout(() => {
          try { child.kill(); } catch {}
          reject(new Error(`Worker timed out after 20000ms: stdout="${stdout}" stderr="${stderr}"`));
        }, 20000);

        child.on('close', (code: any) => {
          clearTimeout(timer);
          if (code !== 0) {
            reject(new Error(`Worker exited with code ${code}: ${stderr}`));
            return;
          }
          try {
            const jsonLine = stdout.split('\n').filter((l) => l.trim().startsWith('{')).pop();
            if (!jsonLine) throw new Error('No JSON output found in stdout');
            const parsed = JSON.parse(jsonLine.trim());
            resolve(parsed);
          } catch {
            reject(new Error(`Worker output invalid JSON: "${stdout}"`));
          }
        });
      });

      return { readyPromise, resultPromise };
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

    const w1 = spawnWorker(`idemp-proc-1-${crypto.randomUUID()}`, betPayloads[0]);
    const w2 = spawnWorker(`idemp-proc-2-${crypto.randomUUID()}`, betPayloads[1]);
    const w3 = spawnWorker(`idemp-proc-3-${crypto.randomUUID()}`, betPayloads[2]);

    // 1. Wait until ALL 3 workers announce READY (no arbitrary sleep!)
    await Promise.all([w1.readyPromise, w2.readyPromise, w3.readyPromise]);

    // 2. Release barrier simultaneously for all 3 workers
    writeFileSync(barrierPath, 'RELEASE');

    try {
      const results = await Promise.all([w1.resultPromise, w2.resultPromise, w3.resultPromise]);
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

      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('20.00');
      expect(finalWallet.version).toBe(2);

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

  it('50 duplicate submissions across THREE independent OS application processes using synchronization barrier', async () => {
    const wallet = await createWalletUseCase.execute({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const bunBin = process.execPath;
    const workerScript = join(import.meta.dir, 'worker.ts');
    const barrierPath = join(tmpdir(), `barrier_dup_${Date.now()}_${Math.random().toString(36).substring(7)}.tmp`);

    const spawnWorker = (idempKey: string, payload: ProcessBetDto, submissions: number) => {
      let markReady: () => void;
      const readyPromise = new Promise<void>((resolve) => {
        markReady = resolve;
      });

      const resultPromise = new Promise<any>((resolve, reject) => {
        let child: any;
        try {
          child = spawn(bunBin, ['run', workerScript, idempKey, JSON.stringify(payload), barrierPath], {
            env: {
              ...process.env,
              DB_NAME: isolatedDb.dbName,
              WORKER_SUBMISSIONS: String(submissions),
            },
          });
        } catch (err) {
          return reject(err);
        }

        child.on('error', (err: any) => reject(err));

        let stdout = '';
        let stderr = '';
        let signaledReady = false;

        child.stdout.on('data', (d: any) => {
          stdout += d.toString();
          if (!signaledReady && stdout.includes('READY')) {
            signaledReady = true;
            markReady();
          }
        });

        child.stderr.on('data', (d: any) => (stderr += d.toString()));

        const timer = setTimeout(() => {
          try { child.kill(); } catch {}
          reject(new Error(`Worker timed out after 20000ms: stdout="${stdout}" stderr="${stderr}"`));
        }, 20000);

        child.on('close', (code: any) => {
          clearTimeout(timer);
          if (code !== 0) {
            reject(new Error(`Worker exited with code ${code}: ${stderr}`));
            return;
          }
          try {
            const jsonLine = stdout.split('\n').filter((l) => l.trim().startsWith('{')).pop();
            if (!jsonLine) throw new Error('No JSON output found in stdout');
            const parsed = JSON.parse(jsonLine.trim());
            resolve(parsed);
          } catch {
            reject(new Error(`Worker output invalid JSON: "${stdout}"`));
          }
        });
      });

      return { readyPromise, resultPromise };
    };

    const sharedIdempKey = `idemp-dup-3p-${crypto.randomUUID()}`;
    const sharedPayload: ProcessBetDto = {
      providerId: 'provider-dup-3p',
      externalTransactionId: `ext-dup-3p-${crypto.randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-dup-3p',
      gameId: 'game-dup-3p',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };

    const w1 = spawnWorker(sharedIdempKey, sharedPayload, 17);
    const w2 = spawnWorker(sharedIdempKey, sharedPayload, 17);
    const w3 = spawnWorker(sharedIdempKey, sharedPayload, 16);

    await Promise.all([w1.readyPromise, w2.readyPromise, w3.readyPromise]);

    writeFileSync(barrierPath, 'RELEASE');

    try {
      const processes = await Promise.all([w1.resultPromise, w2.resultPromise, w3.resultPromise]);
      for (const process of processes) {
        if (!process.ok) throw new Error(`Worker failed: ${process.code}: ${process.error}`);
      }
      const results = processes.flatMap(r => r.results.map((data: any) => ({ ok: true, data })));
      expect(results.length).toBe(50);
      expect(new Set(results.map(r => r.data.transactionId)).size).toBe(1);
      for (const r of results) {
        if (!r.ok) {
          throw new Error(`Worker returned error: ${r.error} (code: ${r.code})`);
        }
      }

      for (const r of results) {
        expect(r.data.status).toBe('PROCESSED');
        expect(r.data.balance.amount).toBe('75.00');
      }

      const firstProcessed = results.filter((r) => !r.data.idempotentReplay);
      const replays = results.filter((r) => r.data.idempotentReplay);
      expect(firstProcessed.length).toBe(1);
      expect(replays.length).toBe(49);

      const finalWallet = await getWalletUseCase.execute(wallet.id);
      expect(finalWallet.balance.amount).toBe('75.00');
      expect(finalWallet.version).toBe(2);

      const txRows = await testPool.query(
        "SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET';",
        [wallet.id]
      );
      expect(Number(txRows.rows[0].count)).toBe(1);

      const ledgerDebitRows = await testPool.query(
        "SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = $1 AND entry_type = 'DEBIT';",
        [wallet.id]
      );
      expect(Number(ledgerDebitRows.rows[0].count)).toBe(1);

      const recon = await reconcileWalletUseCase.execute(wallet.id);
      expect(recon.consistent).toBe(true);
      expect(recon.storedBalance.amount).toBe('75.00');
      expect(recon.calculatedBalance.amount).toBe('75.00');
    } finally {
      if (existsSync(barrierPath)) {
        unlinkSync(barrierPath);
      }
    }
  }, 30000);

  it('mesmo identificador externo com chaves distintas em corrida paralela: um efeito e um conflito 409', async () => {
    const wallet = await createWalletUseCase.execute({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const sharedExtTxId = `ext-shared-${crypto.randomUUID()}`;
    const key1 = `idemp-ext-1-${crypto.randomUUID()}`;
    const key2 = `idemp-ext-2-${crypto.randomUUID()}`;

    const bet1: ProcessBetDto = {
      providerId: 'prv-ext-shared',
      externalTransactionId: sharedExtTxId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-ext-shared',
      gameId: 'game-ext-shared',
      kind: 'BET',
      money: { amount: '35.00', currency: 'BRL' },
    };

    const bet2: ProcessBetDto = {
      providerId: 'prv-ext-shared',
      externalTransactionId: sharedExtTxId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-ext-shared',
      gameId: 'game-ext-shared',
      kind: 'BET',
      money: { amount: '35.00', currency: 'BRL' },
    };

    const [settled1, settled2] = await Promise.allSettled([
      processBetUseCase.execute(key1, bet1),
      processBetUseCase.execute(key2, bet2),
    ]);

    const fulfilled = [settled1, settled2].filter((s) => s.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    const rejected = [settled1, settled2].filter((s) => s.status === 'rejected') as PromiseRejectedResult[];

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0].reason).toBeInstanceOf(IdempotencyConflictError);

    const updatedWallet = await getWalletUseCase.execute(wallet.id);
    expect(updatedWallet.balance.amount).toBe('65.00');
    expect(updatedWallet.version).toBe(2);

    const txRows = await testPool.query(
      "SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = $1 AND kind = 'BET';",
      [wallet.id]
    );
    expect(Number(txRows.rows[0].count)).toBe(1);

    const ledgerDebitRows = await testPool.query(
      "SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = $1 AND entry_type = 'DEBIT';",
      [wallet.id]
    );
    expect(Number(ledgerDebitRows.rows[0].count)).toBe(1);

    const recon = await reconcileWalletUseCase.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe('65.00');
  });
});
