import { beforeAll, afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { SQSClient, CreateQueueCommand, DeleteQueueCommand, SendMessageCommand, ReceiveMessageCommand, ChangeMessageVisibilityCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from '../test-db-helper';
import { MikroOrmUnitOfWork, MikroOrmWalletRepository, MikroOrmWagerTransactionRepository, MikroOrmWalletLedgerRepository, MikroOrmOutboxRepository, type FailureHookPoint } from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-adapter';
import { MikroOrmInboxRepository } from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-inbox-repository';
import { ProcessWagerUseCase } from '../../src/application/use-cases/process-wager.use-case';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import { ConsumeWagerCommand } from '../../src/application/messaging/consume-wager-command';
import { parseWagerCommand } from '../../src/application/messaging/wager-command';
import { SqsWagerConsumer } from '../../src/infrastructure/messaging/sqs-wager-consumer.service';
import { HttpValidator } from '../../src/interfaces/http/validation/http-validator';

let db: IsolatedTestDatabase, sql: pg.Pool, uow: MikroOrmUnitOfWork, processWager: ProcessWagerUseCase, createWallet: CreateWalletUseCase, consume: ConsumeWagerCommand;
const processProofs: Array<{ pid: number | undefined; commandId: string; http: boolean; cut?: string; race: boolean }> = [];
async function financialState(walletId: string) {
  const wallet = (await sql.query('select * from wallets where id=$1', [walletId])).rows;
  const transactions = (await sql.query('select * from wager_transactions where wallet_id=$1 order by id', [walletId])).rows;
  const ledger = (await sql.query('select * from wallet_ledger_entries where wallet_id=$1 order by id', [walletId])).rows;
  const events = (await sql.query('select * from outbox_messages where aggregate_id=$1 order by id', [walletId])).rows;
  return { wallet, transactions, ledger, events };
}
let sqs: SQSClient, queueUrl: string, consumer: SqsWagerConsumer;
beforeAll(async () => {
  db = await createIsolatedTestDatabase('m15_'); sql = new pg.Pool(db.adminConfig);
  uow = new MikroOrmUnitOfWork(); await uow.init();
  const wallets = new MikroOrmWalletRepository(uow), wagers = new MikroOrmWagerTransactionRepository(uow), ledger = new MikroOrmWalletLedgerRepository(uow), outbox = new MikroOrmOutboxRepository(uow);
  processWager = new ProcessWagerUseCase(wallets, wagers, ledger, outbox, uow);
  createWallet = new CreateWalletUseCase(wallets, wagers, ledger, outbox, uow);
  consume = new ConsumeWagerCommand(uow, new MikroOrmInboxRepository(uow), wagers, processWager);
  sqs = new SQSClient({ endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:45615', region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: `m15-${crypto.randomUUID()}.fifo`, Attributes: { FifoQueue: 'true', VisibilityTimeout: '1' } }))).QueueUrl!;
  consumer = new SqsWagerConsumer(consume, { client: sqs, queueUrl });
});
afterAll(async () => {
  if (process.env.M15_CAPTURE_EVIDENCE === '1' && sql) {
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const audit: Record<string, unknown> = { database: db.dbName, queueUrl, platform: process.platform, processProofs };
    for (const table of ['command_inbox', 'wallets', 'wager_transactions', 'wallet_ledger_entries', 'outbox_messages']) {
      audit[table] = (await sql.query(`select * from ${table}`)).rows;
    }
    writeFileSync(join(import.meta.dir, '../../docs/evidence/m15/audit.json'), JSON.stringify(audit, null, 2) + '\n');
  }
  await consumer?.beforeApplicationShutdown(); if (queueUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl })); sqs?.destroy(); await uow?.close(); await sql?.end(); await db?.closeAndDrop();
});
async function command(kind = 'BET', amount = '10.00', reference?: string) {
  const playerId = crypto.randomUUID();
  const wallet = await createWallet.execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
  return { version: 1, commandType: 'ProcessWager', commandId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), data: { providerId: 'm15', externalTransactionId: crypto.randomUUID(), playerId, walletId: wallet.id, roundId: 'round', gameId: 'game', kind, money: { amount, currency: 'BRL' }, ...(reference ? { referenceExternalTransactionId: reference } : {}) } };
}
function parsed(e: any) { return parseWagerCommand(JSON.stringify(e), { MessageGroupId: e.data.walletId, MessageDeduplicationId: e.commandId }); }
async function deliver(e: any) {
  await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(e), MessageGroupId: e.data.walletId, MessageDeduplicationId: e.commandId }));
  const m = (await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MessageSystemAttributeNames: ['All'], WaitTimeSeconds: 1 }))).Messages?.[0];
  expect(m).toBeDefined(); return m!;
}
async function audit(id: string) {
  return (await sql.query(`select t.*, i.command_id, i.fingerprint from wager_transactions t join command_inbox i on i.transaction_id=t.id where i.command_id=$1`, [id])).rows[0];
}
test('A: five operations via actual receive/delete, ledger and outbox identities', async () => {
  const bet = await command(); const win = { ...bet, commandId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), data: { ...bet.data, kind: 'WIN', externalTransactionId: crypto.randomUUID(), money: { amount: '20.00', currency: 'BRL' } } };
  const loss = { ...win, commandId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), data: { ...win.data, kind: 'LOSS', externalTransactionId: crypto.randomUUID() } };
  const refund = { ...bet, commandId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), data: { ...bet.data, kind: 'REFUND', externalTransactionId: crypto.randomUUID(), referenceExternalTransactionId: bet.data.externalTransactionId } };
  const rollback = { ...win, commandId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), data: { ...win.data, kind: 'ROLLBACK', externalTransactionId: crypto.randomUUID(), referenceExternalTransactionId: win.data.externalTransactionId } };
  const balances = ['90.00', '110.00', '110.00', '120.00', '100.00'];
  for (const e of [bet, win, loss, refund, rollback]) {
    const before = (await financialState(e.data.walletId)).wallet[0];
    const m = await deliver(e); expect(await consumer.processMessage(m)).toBe(true);
    const tx = await audit(e.commandId); expect(tx.status).toBe('PROCESSED'); expect(tx.idempotency_key).toBe(e.idempotencyKey); expect(tx.wallet_id).toBe(e.data.walletId); expect(tx.external_transaction_id).toBe(e.data.externalTransactionId); expect(tx.response_snapshot.transactionId).toBe(tx.id); expect(tx.amount).toBe(e.data.money.amount);
    const ledger = (await sql.query('select * from wallet_ledger_entries where transaction_id=$1', [tx.id])).rows;
    expect(ledger.length).toBe(e.data.kind === 'LOSS' ? 0 : 1);
    if (ledger.length) { expect(ledger[0].wallet_id).toBe(e.data.walletId); expect(ledger[0].amount).toBe(e.data.money.amount); expect(ledger[0].entry_type).toBe(['BET', 'ROLLBACK'].includes(e.data.kind) ? 'DEBIT' : 'CREDIT'); }
    const events = (await sql.query('select * from outbox_messages where payload->>\'transactionId\'=$1', [tx.id])).rows;
    expect(events.length).toBe(1); expect(events[0].event_type).toBe('WagerTransactionProcessed'); expect(events[0].payload.walletId).toBe(e.data.walletId); expect(events[0].payload.amount).toEqual(e.data.money);
    const movements = (await sql.query("select * from outbox_messages where payload->>'triggerTransactionId'=$1", [tx.id])).rows;
    expect(movements.length).toBe(e.data.kind === 'LOSS' ? 0 : 1);
    const after = (await financialState(e.data.walletId)).wallet[0];
    const balance = balances.shift()!;
    expect(after.balance).toBe(balance); expect(tx.response_snapshot.balance.amount).toBe(balance);
    if (e.data.kind === 'LOSS') expect(after).toEqual(before);
    else {
      expect(after.version).toBe(before.version + 1);
      expect(ledger[0].balance_before).toBe(before.balance); expect(ledger[0].balance_after).toBe(balance);
      expect(movements[0].event_type).toBe('WalletBalanceChanged'); expect(movements[0].payload.currentBalance.amount).toBe(balance);
    }
  }
  expect((await sql.query('select balance from wallets where id=$1', [bet.data.walletId])).rows[0].balance).toBe('100.00');
});
test('B: normalization and hash match HTTP; FIFO and malformed input fail closed', async () => {
  const e = await command(); e.data.providerId = ' m15 '; e.data.kind = ' bet '; e.data.money.currency = ' brl ';
  const p = parsed(e), h = HttpValidator.validateProcessWager(e.data, e.idempotencyKey);
  expect(p.dto).toEqual(h.dto); expect(ProcessWagerUseCase.computePayloadHash(p.dto, p.idempotencyKey)).toBe(ProcessWagerUseCase.computePayloadHash(h.dto, h.idempotencyKey));
  expect(parsed({ ...e, correlationId: 'other-trace', causationId: 'other-cause' }).fingerprint).toBe(p.fingerprint);
  expect(parsed({ ...e, idempotencyKey: ` ${e.idempotencyKey} ` }).fingerprint).toBe(p.fingerprint);
  expect(() => parseWagerCommand(JSON.stringify(e))).toThrow();
  expect(() => parsed({ ...e, data: { ...e.data, money: { amount: 10, currency: 'BRL' } } })).toThrow();
});
test('C/E/F/G: atomic external commit, replay and original preservation', async () => {
  const e = await command(); let release!: () => void, entered!: () => void;
  const before = await financialState(e.data.walletId);
  const barrier = new Promise<void>(r => release = r), reached = new Promise<void>(r => entered = r);
  uow.setTestHook('before_commit', async () => { entered(); await barrier; });
  const execution = consume.execute(parsed(e), 'transport-1'); await reached;
  try { expect(await audit(e.commandId)).toBeUndefined(); expect(await financialState(e.data.walletId)).toEqual(before); }
  finally { release(); }
  const first = await execution; uow.clearTestHooks();
  const committed = await financialState(e.data.walletId);
  expect((await audit(e.commandId)).id).toBe(first.transactionId);
  expect((await consume.execute(parsed(e), 'transport-2')).transactionId).toBe(first.transactionId);
  const other = { ...e, commandId: crypto.randomUUID() };
  expect((await consume.execute(parsed(other), 'transport-3')).transactionId).toBe(first.transactionId);
  await expect(consume.execute(parsed({ ...e, idempotencyKey: 'divergent' }), 'transport-4')).rejects.toThrow();
  await expect(consume.execute(parsed({ ...other, commandId: crypto.randomUUID(), data: { ...e.data, money: { amount: '11.00', currency: 'BRL' } } }), 'transport-5')).rejects.toThrow();
  await expect(consume.execute(parsed({ ...other, commandId: crypto.randomUUID(), idempotencyKey: 'other-key' }), 'transport-6')).rejects.toThrow();
  expect((await audit(e.commandId)).id).toBe(first.transactionId);
  expect(await financialState(e.data.walletId)).toEqual(committed);
});
test('D: rejected and pending accepted without ledger movement', async () => {
  for (const e of [await command('BET', '101.00'), await command('WIN', '10.00', 'missing')]) {
    const before = (await financialState(e.data.walletId)).wallet;
    expect(await consumer.processMessage(await deliver(e))).toBe(true);
    const tx = await audit(e.commandId); expect(['REJECTED', 'PENDING_REFERENCE']).toContain(tx.status);
    expect((await sql.query('select * from wallet_ledger_entries where transaction_id=$1', [tx.id])).rows).toEqual([]);
    expect((await financialState(e.data.walletId)).wallet).toEqual(before);
    if (tx.status === 'REJECTED') expect(tx.response_snapshot.failureCode).toBe('INSUFFICIENT_FUNDS');
    const events = (await sql.query("select * from outbox_messages where payload->>'transactionId'=$1", [tx.id])).rows;
    expect(events.map(x => x.event_type)).toEqual([tx.status === 'REJECTED' ? 'WagerTransactionRejected' : 'WagerTransactionPendingReference']);
  }
});
test('I: all write failure cuts roll back whole unit', async () => {
  for (const point of ['after_inbox_save', 'after_wallet_save', 'after_tx_save', 'after_ledger_save', 'after_outbox_save'] as FailureHookPoint[]) {
    const e = await command(); const before = await financialState(e.data.walletId); uow.setTestHook(point);
    try { await expect(consume.execute(parsed(e), 'fault')).rejects.toThrow(); } finally { uow.clearTestHooks(); }
    expect(await audit(e.commandId)).toBeUndefined();
    expect(await financialState(e.data.walletId)).toEqual(before);
    expect((await sql.query('select * from wager_transactions where idempotency_key=$1', [e.idempotencyKey])).rows).toEqual([]);
    expect((await sql.query('select balance from wallets where id=$1', [e.data.walletId])).rows[0].balance).toBe('100.00');
    await consume.execute(parsed(e), 'recovery'); expect((await audit(e.commandId)).status).toBe('PROCESSED');
  }
});
test('J/M: lost delete or commit confirmation leaves durable result recoverable', async () => {
  const e = await command(); const m = await deliver(e);
  uow.setTestHook('after_commit', () => { throw new Error('LOST_CONFIRMATION'); });
  expect(await consumer.processMessage(m)).toBe(false); uow.clearTestHooks();
  const original = await audit(e.commandId); expect(original.status).toBe('PROCESSED');
  await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle, VisibilityTimeout: 0 }));
  const redelivered = (await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MessageSystemAttributeNames: ['All'], WaitTimeSeconds: 1 }))).Messages![0];
  expect(await consumer.processMessage(redelivered)).toBe(true);
  expect((await audit(e.commandId)).id).toBe(original.id);
  expect((await sql.query('select * from wallet_ledger_entries where transaction_id=$1', [original.id])).rows.length).toBe(1);
});


async function child(e: any, options: { cut?: string; http?: boolean; race?: boolean } = {}) {
  const { spawn } = await import('node:child_process');
  const { join } = await import('node:path');
  const p = spawn(process.execPath, ['run', join(import.meta.dir, '../concurrency/inbox-worker-runner.ts')], {
    env: { ...process.env, M15_COMMAND: JSON.stringify(e), M15_CUT: options.cut ?? '', M15_HTTP: options.http ? '1' : '0', M15_RACE: options.race ? '1' : '0' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  processProofs.push({ pid: p.pid, commandId: e.commandId, http: options.http ?? false, cut: options.cut, race: options.race ?? false });
  let output = ''; p.stdout.on('data', x => output += x.toString()); p.stderr.on('data', x => output += x.toString());
  const exited = new Promise<void>((resolve, reject) => { p.once('exit', () => resolve()); p.once('error', reject); });
  async function until(marker: string) {
    const limit = Date.now() + 15000;
    while (!output.includes(marker)) { if (Date.now() > limit || p.exitCode !== null) throw new Error(`Child missing ${marker}: ${output}`); await new Promise(r => setTimeout(r, 20)); }
  }
  await until('READY');
  return { p, until, exited, output: () => output };
}
test('H: separate processes duplicate commands and HTTP/queue global key race', async () => {
  for (const mode of ['same-command', 'other-command', 'http']) {
    const e = await command();
    const second = mode === 'same-command' ? e : { ...e, commandId: crypto.randomUUID() };
    const a = await child(e), b = await child(second, { http: mode === 'http' });
    try { a.p.stdin.write('go'); b.p.stdin.write('go'); await Promise.all([a.exited, b.exited]); }
    finally { a.p.kill(); b.p.kill(); }
    const result = await consume.execute(parsed(e), 'reconcile');
    const tx = await audit(e.commandId); expect(tx.id).toBe(result.transactionId);
    if (mode === 'other-command') expect((await audit(second.commandId)).id).toBe(result.transactionId);
    expect((await sql.query('select * from wallet_ledger_entries where transaction_id=$1', [tx.id])).rows.length).toBe(1);
    expect((await sql.query('select balance from wallets where id=$1', [e.data.walletId])).rows[0].balance).toBe('90.00');
  }
});
test('K: real process crash with explicit pre/post commit barriers and recovery', async () => {
  for (const cut of ['before_commit', 'after_commit']) {
    const e = await command(); const delivery = await deliver(e); const c = await child(e, { cut });
    try {
      c.p.stdin.write('go'); await c.until('BARRIER');
      expect(Boolean(await audit(e.commandId))).toBe(cut === 'after_commit');
    } finally { c.p.kill('SIGKILL'); await c.exited; }
    await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: delivery.ReceiptHandle, VisibilityTimeout: 0 }));
    const again = (await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MessageSystemAttributeNames: ['All'], WaitTimeSeconds: 1 }))).Messages![0];
    expect(await consumer.processMessage(again)).toBe(true);
    const result = await consume.execute(parsed(e), 'after-crash');
    expect((await audit(e.commandId)).id).toBe(result.transactionId);
    expect((await sql.query('select * from wallet_ledger_entries where transaction_id=$1', [result.transactionId])).rows.length).toBe(1);
  }
});

test('J: DeleteMessage failure after commit followed by actual redelivery', async () => {
  const e = await command(), m = await deliver(e);
  let fail = true;
  const borrowed = { send: async (c: any, options: any) => {
    if (c instanceof DeleteMessageCommand && fail) { fail = false; throw new Error('DELETE_FAILED'); }
    return sqs.send(c, options);
  }, destroy: () => { throw new Error('BORROWED_CLIENT_DESTROYED'); } } as unknown as SQSClient;
  const faulty = new SqsWagerConsumer(consume, { client: borrowed, queueUrl });
  expect(await faulty.processMessage(m)).toBe(false);
  const first = await audit(e.commandId); expect(first.status).toBe('PROCESSED');
  await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle, VisibilityTimeout: 0 }));
  const again = (await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MessageSystemAttributeNames: ['All'], WaitTimeSeconds: 1 }))).Messages![0];
  expect(await faulty.processMessage(again)).toBe(true);
  expect((await audit(e.commandId)).id).toBe(first.id);
  expect((await sql.query('select * from wallet_ledger_entries where transaction_id=$1', [first.id])).rows.length).toBe(1);
  await faulty.beforeApplicationShutdown();
});
test('L: worker resolves pending and inbox replay returns terminal snapshot', async () => {
  const { ReprocessPendingReferencesUseCase } = await import('../../src/application/use-cases/reprocess-pending-references.use-case');
  const e = await command('WIN', '20.00', crypto.randomUUID());
  const initial = await consume.execute(parsed(e), 'pending'); expect(initial.status).toBe('PENDING_REFERENCE');
  const acceptedPending = await financialState(e.data.walletId);
  expect((await consume.execute(parsed(e), 'pending-replay')).status).toBe('PENDING_REFERENCE');
  expect(await financialState(e.data.walletId)).toEqual(acceptedPending);
  const bet = { ...e, commandId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), data: { ...e.data, money: { amount: '10.00', currency: 'BRL' }, kind: 'BET', externalTransactionId: e.data.referenceExternalTransactionId! } };
  delete (bet.data as any).referenceExternalTransactionId;
  await consume.execute(parsed(bet), 'reference');
  await sql.query('update wager_transactions set next_attempt_at=now() where id=$1', [initial.transactionId]);
  const worker = new ReprocessPendingReferencesUseCase(new MikroOrmWalletRepository(uow), new MikroOrmWagerTransactionRepository(uow), new MikroOrmWalletLedgerRepository(uow), new MikroOrmOutboxRepository(uow), uow);
  await worker.execute();
  const terminal = await consume.execute(parsed(e), 'resolved'); expect(terminal.status).toBe('PROCESSED'); expect(terminal.transactionId).toBe(initial.transactionId); expect(terminal.balance.amount).toBe('110.00');
});
test('N: normal Nest shutdown drains transaction before ORM/client closure', async () => {
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../../src/interfaces/http/app.module');
  const old = process.env.WAGER_TRANSACTIONS_QUEUE_URL; process.env.WAGER_TRANSACTIONS_QUEUE_URL = queueUrl;
  process.env.SQS_CONSUMER_ENABLED = 'false'; process.env.OUTBOX_PUBLISHER_ENABLED = 'false'; process.env.PENDING_WORKER_ENABLED = 'false';
  const app = await NestFactory.create(AppModule, { logger: false }); await app.init();
  const managed = app.get(SqsWagerConsumer), managedUow = app.get(MikroOrmUnitOfWork);
  const e = await command(); await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(e), MessageGroupId: e.data.walletId, MessageDeduplicationId: e.commandId }));
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>(r => release=r), reached = new Promise<void>(r => entered=r);
  managedUow.setTestHook('before_commit', async () => { entered(); await barrier; });
  const processing = managed.receiveOnce(); expect(managed.receiveOnce()).toBe(processing); await reached;
  const closing = app.close(); await new Promise(r => setTimeout(r, 50));
  expect(managedUow.isClosed()).toBe(false); expect(await audit(e.commandId)).toBeUndefined(); release();
  await processing; await closing; expect(managedUow.isClosed()).toBe(true); expect((await audit(e.commandId)).status).toBe('PROCESSED');
  if (old === undefined) delete process.env.WAGER_TRANSACTIONS_QUEUE_URL; else process.env.WAGER_TRANSACTIONS_QUEUE_URL = old;
});


test('H: different wallets contend on global key in separate HTTP/queue processes', async () => {
  const e = await command(), other = await command(); other.idempotencyKey = e.idempotencyKey;
  const a = await child(e, { race: true }), b = await child(other, { http: true, race: true });
  try {
    a.p.stdin.write('go'); b.p.stdin.write('go');
    await Promise.all([a.until('RACE_BARRIER'), b.until('RACE_BARRIER')]);
    a.p.stdin.write('continue'); b.p.stdin.write('continue');
    await Promise.all([a.exited, b.exited]);
  }
  finally { a.p.kill(); b.p.kill(); }
  const rows = (await sql.query('select * from wager_transactions where idempotency_key=$1', [e.idempotencyKey])).rows;
  expect(rows.length).toBe(1); const tx = rows[0];
  const winner = tx.wallet_id === e.data.walletId ? e : other;
  const loser = winner === e ? other : e;
  expect((await consume.execute(parsed(winner), 'winner-redelivery')).transactionId).toBe(tx.id);
  await expect(consume.execute(parsed(loser), 'loser-redelivery')).rejects.toThrow();
  expect(await audit(loser.commandId)).toBeUndefined();
  expect((await financialState(loser.data.walletId)).wallet[0].balance).toBe('100.00');
  expect((await sql.query('select * from wallet_ledger_entries where transaction_id=$1', [tx.id])).rows.length).toBe(1);
});
test('snapshot corruption fails closed without changing historical state', async () => {
  const e = await command('WIN', '10.00', 'not-present');
  const result = await consume.execute(parsed(e), 'first');
  await sql.query('update wager_transactions set response_snapshot=null where id=$1', [result.transactionId]);
  const before = await financialState(e.data.walletId);
  await expect(consume.execute(parsed(e), 'invalid-snapshot')).rejects.toThrow();
  expect(await financialState(e.data.walletId)).toEqual(before);
});

test('automatic enabled polling consumes, stops new receives and drains its loop', async () => {
  const e = await command();
  await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(e), MessageGroupId: e.data.walletId, MessageDeduplicationId: e.commandId }));
  let receives = 0;
  const borrowed = { send: (c: any, options: any) => {
    if (c instanceof ReceiveMessageCommand) receives++;
    return sqs.send(c, options);
  }, destroy: () => { throw new Error('BORROWED_CLIENT_DESTROYED'); } } as unknown as SQSClient;
  const automatic = new SqsWagerConsumer(consume, { client: borrowed, queueUrl, enabled: true });
  automatic.onApplicationBootstrap();
  try {
    const deadline = Date.now() + 10000;
    while (!(await audit(e.commandId))) {
      if (Date.now() > deadline) throw new Error('AUTOMATIC_POLL_TIMEOUT');
      await new Promise(r => setTimeout(r, 20));
    }
  } finally { await automatic.beforeApplicationShutdown(); }
  const stoppedAt = receives; await new Promise(r => setTimeout(r, 50));
  expect(receives).toBe(stoppedAt); expect(receives).toBeGreaterThan(0);
  expect(uow.isClosed()).toBe(false); expect((await audit(e.commandId)).status).toBe('PROCESSED');
});
