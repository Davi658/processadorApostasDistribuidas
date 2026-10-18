import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, rmSync } from 'node:fs';
import pg from 'pg';
import { createIsolatedTestDatabase } from '../test-db-helper';
import { MikroOrmUnitOfWork, MikroOrmWalletRepository, MikroOrmWagerTransactionRepository, MikroOrmWalletLedgerRepository, MikroOrmOutboxRepository } from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-adapter';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import { ReconcileWalletUseCase } from '../../src/application/use-cases/reconcile-wallet.use-case';
test('three independent wallets hold financial locks concurrently in three OS processes, reconcile and match transaction IDs', async () => {
  const db = await createIsolatedTestDatabase('delivery_parallel_');
  const uow = new MikroOrmUnitOfWork(); const sql = new pg.Pool(db.adminConfig);
  const barrier = join(tmpdir(), `delivery-${crypto.randomUUID()}`), commit = `${barrier}.commit`;
  const children: ReturnType<typeof spawn>[] = [];
  try {
    await uow.init();
    const wallets = new MikroOrmWalletRepository(uow), wagers = new MikroOrmWagerTransactionRepository(uow), ledger = new MikroOrmWalletLedgerRepository(uow), outbox = new MikroOrmOutboxRepository(uow);
    const create = new CreateWalletUseCase(wallets, wagers, ledger, outbox, uow), reconcile = new ReconcileWalletUseCase(wallets, ledger, uow);
    const fixtures = await Promise.all(Array.from({ length: 3 }, () => create.execute({ playerId: crypto.randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } })));
    const workers = fixtures.map(wallet => {
      let ready!: () => void, locked!: () => void;
      const readyPromise = new Promise<void>(r => ready = r), lockedPromise = new Promise<void>(r => locked = r);
      const payload = { providerId: 'delivery-parallel', externalTransactionId: crypto.randomUUID(), playerId: wallet.playerId, walletId: wallet.id, roundId: 'r', gameId: 'g', kind: 'BET', money: { amount: '10.00', currency: 'BRL' } };
      const child = spawn(process.execPath, ['run', join(import.meta.dir, 'worker.ts'), crypto.randomUUID(), JSON.stringify(payload), barrier], { env: { ...process.env, DB_NAME: db.dbName, WORKER_COMMIT_BARRIER: commit, WORKER_SUBMISSIONS: '1' } });
      children.push(child); let stdout = '', stderr = '';
      child.stdout!.on('data', d => { stdout += d; if (stdout.includes('READY')) ready(); if (stdout.includes('LOCKED')) locked(); });
      child.stderr!.on('data', d => stderr += d);
      const result = new Promise<any>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => {
          if (code !== 0) return reject(new Error(`Worker exit ${code}: ${stderr}`));
          try { resolve(JSON.parse(stdout.split('\n').find(line => line.startsWith('{'))!)); } catch (e) { reject(e); }
        });
      });
      return { readyPromise, lockedPromise, result };
    });
    const deadline = <T>(promise: Promise<T>) => Promise.race([promise, Bun.sleep(18000).then(() => { throw new Error('BARRIER_TIMEOUT'); })]);
    await deadline(Promise.all(workers.map(w => w.readyPromise)));
    writeFileSync(barrier, 'GO');
    await deadline(Promise.all(workers.map(w => w.lockedPromise)));
    // All processes hold different wallet locks before any can commit.
    writeFileSync(commit, 'COMMIT');
    const results = await deadline(Promise.all(workers.map(w => w.result)));
    expect(results.every(r => r.ok && r.data.status === 'PROCESSED')).toBe(true);
    expect(new Set(results.map(r => r.data.transactionId)).size).toBe(3);
    for (const [index, wallet] of fixtures.entries()) {
      const check = await reconcile.execute(wallet.id);
      expect(check.consistent).toBe(true); expect(check.storedBalance.amount).toBe('90.00');
      const rows = (await sql.query('select t.id, l.transaction_id from wager_transactions t join wallet_ledger_entries l on l.transaction_id=t.id where t.wallet_id=$1 and t.kind=\'BET\'', [wallet.id])).rows;
      expect(rows).toEqual([{ id: results[index].data.transactionId, transaction_id: results[index].data.transactionId }]);
    }
  } finally {
    for (const child of children) { if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('close', resolve)); } }
    rmSync(barrier, { force: true }); rmSync(commit, { force: true });
    await uow.close(); await sql.end(); await db.closeAndDrop();
  }
}, 30000);
