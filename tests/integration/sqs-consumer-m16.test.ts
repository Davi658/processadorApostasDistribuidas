import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { beforeAll, afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { SQSClient, CreateQueueCommand, DeleteQueueCommand, SendMessageCommand, ReceiveMessageCommand, ChangeMessageVisibilityCommand, DeleteMessageCommand, GetQueueAttributesCommand, type Message } from '@aws-sdk/client-sqs';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from '../test-db-helper';
import { MikroOrmUnitOfWork, MikroOrmWalletRepository, MikroOrmWagerTransactionRepository, MikroOrmWalletLedgerRepository, MikroOrmOutboxRepository } from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-adapter';
import { MikroOrmInboxRepository } from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-inbox-repository';
import { ProcessWagerUseCase } from '../../src/application/use-cases/process-wager.use-case';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import { ConsumeWagerCommand } from '../../src/application/messaging/consume-wager-command';
import { parseWagerCommand } from '../../src/application/messaging/wager-command';
import { SqsWagerConsumer } from '../../src/infrastructure/messaging/sqs-wager-consumer.service';

let db: IsolatedTestDatabase, sql: pg.Pool, uow: MikroOrmUnitOfWork, processWager: ProcessWagerUseCase, createWallet: CreateWalletUseCase, consume: ConsumeWagerCommand;
const snapshots: Array<Record<string, unknown>> = [];
const brokerProofs: Array<Record<string, unknown>> = [];
async function financialState(walletId: string) {
  const wallet = (await sql.query('select * from wallets where id=$1', [walletId])).rows;
  const transactions = (await sql.query('select * from wager_transactions where wallet_id=$1 order by id', [walletId])).rows;
  const ledger = (await sql.query('select * from wallet_ledger_entries where wallet_id=$1 order by id', [walletId])).rows;
  const events = (await sql.query('select * from outbox_messages where aggregate_id=$1 order by id', [walletId])).rows;
  const inbox = (await sql.query('select i.* from command_inbox i join wager_transactions t on t.id=i.transaction_id where t.wallet_id=$1 order by i.command_id', [walletId])).rows;
  const state = { wallet, transactions, ledger, events, inbox };
  snapshots.push({ walletId, transactionIds: transactions.map(t => t.id), ledgerIds: ledger.map(t => t.id), eventIds: events.map(t => t.id), commandIds: inbox.map(t => t.command_id), fullStateSha256: createHash('sha256').update(JSON.stringify(state)).digest('hex') });
  return state;
}
let sqs: SQSClient, queueUrl: string, consumer: SqsWagerConsumer;
beforeAll(async () => {
  db = await createIsolatedTestDatabase('m16_'); sql = new pg.Pool(db.adminConfig);
  uow = new MikroOrmUnitOfWork(); await uow.init();
  const wallets = new MikroOrmWalletRepository(uow), wagers = new MikroOrmWagerTransactionRepository(uow), ledger = new MikroOrmWalletLedgerRepository(uow), outbox = new MikroOrmOutboxRepository(uow);
  processWager = new ProcessWagerUseCase(wallets, wagers, ledger, outbox, uow);
  createWallet = new CreateWalletUseCase(wallets, wagers, ledger, outbox, uow);
  consume = new ConsumeWagerCommand(uow, new MikroOrmInboxRepository(uow), wagers, processWager);
  sqs = new SQSClient({ endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:45616', region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: `m16-${crypto.randomUUID()}.fifo`, Attributes: { FifoQueue: 'true', VisibilityTimeout: '3' } }))).QueueUrl!;
  consumer = new SqsWagerConsumer(consume, { client: sqs, queueUrl, visibilitySeconds: 3, renewalMs: 400, requestTimeoutMs: 1500, retryBaseSeconds: 1, retryMaxSeconds: 2 });
});
afterAll(async () => {
  const directory = `docs/evidence/m16/${process.platform}`; mkdirSync(directory, { recursive: true });
  writeFileSync(`${directory}/broker-financial-audit.json`, JSON.stringify({ platform: process.platform, database: db?.dbName, queueUrl, activeTransactionsBeforeClose: uow?.getActiveTransactionsCount(), snapshots, brokerProofs }, null, 2) + '\n');
  await consumer?.beforeApplicationShutdown(); if (queueUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl })); sqs?.destroy(); await uow?.close(); await sql?.end(); await db?.closeAndDrop();
});
async function command(kind = 'BET', amount = '10.00', reference?: string) {
  const playerId = crypto.randomUUID();
  const wallet = await createWallet.execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
  return { version: 1, commandType: 'ProcessWager', commandId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), data: { providerId: 'm16', externalTransactionId: crypto.randomUUID(), playerId, walletId: wallet.id, roundId: 'round', gameId: 'game', kind, money: { amount, currency: 'BRL' }, ...(reference ? { referenceExternalTransactionId: reference } : {}) } };
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

async function receive(url = queueUrl) {
  return (await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MessageSystemAttributeNames: ['All'], WaitTimeSeconds: 1 }))).Messages?.[0];
}
function barrier() {
  let release!: () => void;
  return { promise: new Promise<void>(r => release = r), release: () => release() };
}
function instance(client = sqs, drainTimeoutMs = 10000) {
  return new SqsWagerConsumer(consume, { client, queueUrl, visibilitySeconds: 3, renewalMs: 400, requestTimeoutMs: 1500, retryBaseSeconds: 1, retryMaxSeconds: 2, drainTimeoutMs });
}
function faultClient(fail: (command: any) => boolean, observed?: (command: any) => void) {
  return { send: async (command: any, options: any) => {
    observed?.(command);
    if (fail(command)) throw Object.assign(new Error('INJECTED'), { code: 'ECONNRESET' });
    return sqs.send(command, options);
  }, destroy: () => { throw new Error('BORROWED_CLIENT_DESTROYED'); } } as unknown as SQSClient;
}
test('A: broker renewal holds a long transaction; duplicate preserves complete financial state', async () => {
  const e = await command(), entered = barrier(), release = barrier(), renewed = barrier();
  let renewals = 0;
  uow.setTestHook('before_commit', async () => { entered.release(); await release.promise; });
  const client = faultClient(() => false, c => { if (c instanceof ChangeMessageVisibilityCommand && ++renewals >= 8) renewed.release(); });
  const c = instance(client), work = c.processMessage(await deliver(e));
  try {
    await entered.promise; await renewed.promise;
    expect(await receive()).toBeUndefined();
  } finally { release.release(); }
  expect(await work).toBe(true); uow.clearTestHooks();
  const committed = await financialState(e.data.walletId);
  await consume.execute(parsed(e), 'replay');
  expect(await financialState(e.data.walletId)).toEqual(committed);
  const tx = await audit(e.commandId);
  expect(committed.transactions.filter(t => t.id === tx.id)).toHaveLength(1);
  expect(committed.ledger.filter(t => t.transaction_id === tx.id)).toHaveLength(1);
  await c.beforeApplicationShutdown();
});
test('B: failed renewal permits real redelivery while inbox lock preserves one result', async () => {
  const e = await command(), entered = barrier(), release = barrier();
  let first = true;
  uow.setTestHook('before_commit', async () => { if (first) { first = false; entered.release(); await release.promise; } });
  const c = instance(faultClient(c => c instanceof ChangeMessageVisibilityCommand));
  const m = await deliver(e), work = c.processMessage(m); await entered.promise;
  let redelivery: Message | undefined;
  try {
    for (let i = 0; i < 7 && !redelivery; i++) redelivery = await receive();
    expect(redelivery?.MessageId).toBe(m.MessageId);
    const second = consumer.processMessage(redelivery!);
    release.release(); await work; expect(await second).toBe(true);
    uow.clearTestHooks();
    const state = await financialState(e.data.walletId);
    const tx = await audit(e.commandId);
    expect(state.transactions.filter(t => t.id === tx.id)).toHaveLength(1); expect(state.ledger.filter(t => t.transaction_id === tx.id)).toHaveLength(1);
    expect(state.wallet[0].balance).toBe('90.00');
    await consume.execute(parsed(e), 'replay'); expect(await financialState(e.data.walletId)).toEqual(state);
  } finally { release.release(); await work; uow.clearTestHooks(); await c.beforeApplicationShutdown(); }
});
test('C: broker retry backs off to configured cap without financial reference attempts', async () => {
  const e = await command('WIN', '10.00', 'missing');
  const before = await financialState(e.data.walletId), delays: number[] = [];
  const c = instance(faultClient(() => false, cmd => {
    if (cmd instanceof ChangeMessageVisibilityCommand) delays.push(cmd.input.VisibilityTimeout!);
  }));
  uow.setTestHook('after_begin', () => { throw Object.assign(new Error('serialization'), { code: '40001' }); });
  const original = await deliver(e); let delivery = original;
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(Number(delivery.Attributes?.ApproximateReceiveCount)).toBe(attempt);
      expect(await c.processMessage(delivery)).toBe(false);
      expect(await financialState(e.data.walletId)).toEqual(before);
      expect((await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 0 }))).Messages ?? []).toEqual([]);
      let next: Message | undefined; for (let i = 0; i < 4 && !next; i++) next = await receive();
      expect(next?.MessageId).toBe(original.MessageId); delivery = next!;
    }
    expect(delays).toEqual([1, 2, 2]); uow.clearTestHooks();
    expect(await consumer.processMessage(delivery)).toBe(true);
    const tx = await audit(e.commandId); expect(tx.status).toBe('PENDING_REFERENCE'); expect(tx.attempts).toBe(1);
    const accepted = await financialState(e.data.walletId); await consume.execute(parsed(e), 'accepted-replay');
    expect(await financialState(e.data.walletId)).toEqual(accepted);
  } finally { uow.clearTestHooks(); await c.beforeApplicationShutdown(); }
});
test('D/E: native FIFO redrive preserves original body; persisted rejection is deleted', async () => {
  const dlq = (await sqs.send(new CreateQueueCommand({ QueueName: `m16-dlq-${crypto.randomUUID()}.fifo`, Attributes: { FifoQueue: 'true' } }))).QueueUrl!;
  const arn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }))).Attributes!.QueueArn!;
  const source = (await sqs.send(new CreateQueueCommand({ QueueName: `m16-source-${crypto.randomUUID()}.fifo`, Attributes: { FifoQueue: 'true', VisibilityTimeout: '1', RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 2 }) } }))).QueueUrl!;
  const c = new SqsWagerConsumer(consume, { client: sqs, queueUrl: source, visibilitySeconds: 3, renewalMs: 400, requestTimeoutMs: 1500, retryBaseSeconds: 1, retryMaxSeconds: 1 });
  try {
    const attrs = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: source, AttributeNames: ['FifoQueue', 'RedrivePolicy'] }))).Attributes!;
    brokerProofs.push({ source, dlq, attributes: attrs });
    expect(attrs.FifoQueue).toBe('true'); expect(JSON.parse(attrs.RedrivePolicy!).deadLetterTargetArn).toBe(arn);
    for (const persistent of [false, true]) {
      const e = await command(); const body = persistent ? JSON.stringify(e) : '{invalid';
      await sqs.send(new SendMessageCommand({ QueueUrl: source, MessageBody: body, MessageGroupId: e.data.walletId, MessageDeduplicationId: e.commandId }));
      if (persistent) uow.setTestHook('after_begin', () => { throw new Error('PERSISTENT'); });
      let dead: Message | undefined;
      try {
        for (let i = 0; i < 10 && !dead; i++) {
          const m = await receive(source); if (m) expect(await c.processMessage(m)).toBe(false);
          dead = await receive(dlq);
        }
        expect(dead?.Body).toBe(body);
        brokerProofs.push({ persistent, dlqMessageId: dead?.MessageId, originalBodySha256: createHash('sha256').update(body).digest('hex'), deadBodySha256: createHash('sha256').update(dead?.Body ?? '').digest('hex') });
        expect(await audit(e.commandId)).toBeUndefined();
        await sqs.send(new DeleteMessageCommand({ QueueUrl: dlq, ReceiptHandle: dead!.ReceiptHandle }));
      } finally { uow.clearTestHooks(); }
    }
    const rejected = await command('BET', '101.00');
    await sqs.send(new SendMessageCommand({ QueueUrl: source, MessageBody: JSON.stringify(rejected), MessageGroupId: rejected.data.walletId, MessageDeduplicationId: rejected.commandId }));
    expect(await c.processMessage((await receive(source))!)).toBe(true);
    expect((await audit(rejected.commandId)).status).toBe('REJECTED'); expect(await receive(dlq)).toBeUndefined();
    const receiveStarted = barrier(); let receives = 0, cancelled = false;
    const borrowed = { send: (cmd: any, options: any) => {
      if (cmd instanceof ReceiveMessageCommand) {
        receives++; options.abortSignal.addEventListener('abort', () => { cancelled = true; }, { once: true });
        const pending = sqs.send(cmd, options); receiveStarted.release(); return pending;
      }
      return sqs.send(cmd, options);
    }, destroy: () => { throw new Error('BORROWED_CLIENT_DESTROYED'); } } as unknown as SQSClient;
    const automatic = new SqsWagerConsumer(consume, { client: borrowed, queueUrl: source, enabled: true });
    try {
      await automatic.onApplicationBootstrap(); await receiveStarted.promise;
      await automatic.beforeApplicationShutdown();
      expect(cancelled).toBe(true); const stopped = receives;
      await automatic.receiveOnce(); expect(await automatic.processMessage({ Body: '{' })).toBe(false);
      expect(receives).toBe(stopped);
      brokerProofs.push({ pendingLongPollCancelled: cancelled, receivesBeforeStop: stopped, receivesAfterStop: receives });
    } finally { await automatic.beforeApplicationShutdown(); }

  } finally { await c.beforeApplicationShutdown(); await sqs.send(new DeleteQueueCommand({ QueueUrl: source })); await sqs.send(new DeleteQueueCommand({ QueueUrl: dlq })); }
}, 30000);
test('F/J: delete failure redelivery and accepted pending never repeat financial work', async () => {
  for (const e of [await command(), await command('WIN', '10.00', 'missing')]) {
    const c = instance(faultClient(c => c instanceof DeleteMessageCommand));
    const m = await deliver(e); expect(await c.processMessage(m)).toBe(false);
    const state = await financialState(e.data.walletId), tx = await audit(e.commandId);
    let next: Message | undefined;
    for (let i = 0; i < 4 && !next; i++) next = await receive();
    expect(next?.MessageId).toBe(m.MessageId); expect(await consumer.processMessage(next!)).toBe(true);
    expect(await financialState(e.data.walletId)).toEqual(state); expect(await audit(e.commandId)).toEqual(tx);
    await c.beforeApplicationShutdown();
  }
});
test('H: drain deadline cancels captured UoW waiting on a real PostgreSQL lock', async () => {
  const e = await command(), entered = barrier(), aborted = barrier();
  const c = instance(sqs, 50), blocker = await sql.connect();
  await blocker.query('begin'); await blocker.query('select pg_advisory_xact_lock(160016)');
  const originalExecute = consume.execute.bind(consume);
  consume.execute = (command, messageId, signal) => {
    signal?.addEventListener('abort', () => aborted.release(), { once: true });
    return originalExecute(command, messageId, signal);
  };
  uow.setTestHook('after_begin', async () => { entered.release(); await uow.getEntityManager().execute('select pg_advisory_xact_lock(160016)'); });
  const before = await financialState(e.data.walletId);
  const work = c.processMessage(await deliver(e)); await entered.promise;
  const closing = c.beforeApplicationShutdown();
  try {
    await aborted.promise;
    expect(uow.getActiveTransactionsCount()).toBe(1); expect(uow.isClosed()).toBe(false);
    await blocker.query('rollback'); await closing; expect(await work).toBe(false);
    uow.clearTestHooks();
    expect(uow.getActiveTransactionsCount()).toBe(0); expect(await financialState(e.data.walletId)).toEqual(before);
    let next: Message | undefined; for (let i = 0; i < 4 && !next; i++) next = await receive();
    expect(await consumer.processMessage(next!)).toBe(true);
  } finally { await blocker.query('rollback'); blocker.release(); uow.clearTestHooks(); consume.execute = originalExecute; await work; await closing; }
});
test('I: shutdown waits for in-flight visibility request and clears future renewals', async () => {
  const e = await command(), commit = barrier(), releaseCommit = barrier(), renewal = barrier(), releaseRenewal = barrier(), deleted = barrier();
  let changes = 0;
  const client = { send: async (cmd: any, options: any) => {
    if (cmd instanceof ChangeMessageVisibilityCommand) { changes++; renewal.release(); await releaseRenewal.promise; }
    const result = await sqs.send(cmd, options);
    if (cmd instanceof DeleteMessageCommand) deleted.release();
    return result;
  }, destroy: () => { throw new Error('BORROWED_CLIENT_DESTROYED'); } } as unknown as SQSClient;
  const c = instance(client);
  uow.setTestHook('after_commit', async () => { commit.release(); await releaseCommit.promise; });
  const work = c.processMessage(await deliver(e));
  try {
    await commit.promise; await renewal.promise; releaseCommit.release(); await deleted.promise;
    let closed = false; const closing = c.beforeApplicationShutdown().then(() => { closed = true; });
    await Promise.resolve(); await Promise.resolve(); expect(closed).toBe(false);
    releaseRenewal.release(); expect(await work).toBe(true); await closing;
    const count = changes; expect(await receive()).toBeUndefined(); expect(changes).toBe(count);
    expect(uow.getActiveTransactionsCount()).toBe(0);
  } finally { releaseCommit.release(); releaseRenewal.release(); await work; uow.clearTestHooks(); await c.beforeApplicationShutdown(); }
});

test.skipIf(process.platform !== 'linux')('G: Linux Nest SIGTERM drains at real pre/post commit barriers before ORM close', async () => {
  const { spawn } = await import('node:child_process');
  const { join } = await import('node:path');
  for (const cut of ['before_commit', 'after_commit']) {
    const e = await command(), m = await deliver(e), before = await financialState(e.data.walletId);
    const child = spawn(process.execPath, ['run', join(import.meta.dir, '../concurrency/consumer-shutdown-m16-runner.ts')], {
      env: { ...process.env, M16_QUEUE: queueUrl, M16_CUT: cut, M16_DELIVERY: JSON.stringify(m) }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = ''; child.stdout.on('data', x => output += x.toString()); child.stderr.on('data', x => output += x.toString());
    const exited = new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject); });
    async function until(marker: string) {
      const deadline = Date.now() + 10000;
      while (!output.includes(marker)) {
        if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Missing ${marker}`);
        await new Promise(r => setTimeout(r, 20));
      }
    }
    try {
      await until('BARRIER'); child.kill('SIGTERM'); await until('STOPPING');
      // Observe deadline through the UoW cancellation hook, without releasing the work early.
      await until('CANCEL_REQUESTED'); child.stdin.write('release'); await exited;
      brokerProofs.push({ childPid: child.pid, cut, signalSent: 'SIGTERM', exitCode: child.exitCode, signalCode: child.signalCode, cancellationObserved: output.includes('CANCEL_REQUESTED'), drainedBeforeClosed: output.indexOf('DRAINED') < output.indexOf('CLOSED') });
      expect(output).toContain('DRAINED'); expect(output).toContain('CLOSED');
      expect(output.indexOf('DRAINED')).toBeLessThan(output.indexOf('CLOSED'));
      if (cut === 'before_commit') {
        expect(await financialState(e.data.walletId)).toEqual(before);
        let next: Message | undefined; for (let i = 0; i < 4 && !next; i++) next = await receive();
        expect(await consumer.processMessage(next!)).toBe(true);
      }
      const state = await financialState(e.data.walletId);
      const tx = await audit(e.commandId);
    expect(state.transactions.filter(t => t.id === tx.id)).toHaveLength(1); expect(state.ledger.filter(t => t.transaction_id === tx.id)).toHaveLength(1);
      await consume.execute(parsed(e), 'reconcile'); expect(await financialState(e.data.walletId)).toEqual(state);
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); await exited; }
  }
});

test('K: failed and stopped consumer leaves publisher and reference worker operational', async () => {
  const { ReprocessPendingReferencesUseCase } = await import('../../src/application/use-cases/reprocess-pending-references.use-case');
  const { SqsOutboxQueuePublisher } = await import('../../src/infrastructure/messaging/sqs-outbox-queue-publisher.service');
  const { PublishOutboxEventsUseCase } = await import('../../src/application/use-cases/publish-outbox-events.use-case');
  const e = await command('WIN', '20.00', crypto.randomUUID());
  const initial = await consume.execute(parsed(e), 'pending');
  const failed = instance(faultClient(() => true));
  expect(await failed.processMessage({ MessageId: 'invalid', ReceiptHandle: 'invalid', Body: '{' })).toBe(false);
  await failed.beforeApplicationShutdown();
  const bet = { ...e, commandId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), data: { ...e.data, money: { amount: '10.00', currency: 'BRL' }, kind: 'BET', externalTransactionId: e.data.referenceExternalTransactionId! } };
  delete (bet.data as any).referenceExternalTransactionId;
  await consume.execute(parsed(bet), 'reference');
  await sql.query('update wager_transactions set next_attempt_at=now() where id=$1', [initial.transactionId]);
  const worker = new ReprocessPendingReferencesUseCase(new MikroOrmWalletRepository(uow), new MikroOrmWagerTransactionRepository(uow), new MikroOrmWalletLedgerRepository(uow), new MikroOrmOutboxRepository(uow), uow);
  await worker.execute(); expect((await consume.execute(parsed(e), 'resolved')).status).toBe('PROCESSED');
  const eventsQueue = (await sqs.send(new CreateQueueCommand({ QueueName: `m16-events-${crypto.randomUUID()}.fifo`, Attributes: { FifoQueue: 'true' } }))).QueueUrl!;
  const publisher = new SqsOutboxQueuePublisher({ sqsClient: sqs, queueUrl: eventsQueue });
  try {
    const publish = new PublishOutboxEventsUseCase(new MikroOrmOutboxRepository(uow), publisher);
    const result = await publish.execute(1, 30000, 'm16');
    expect(result.published).toBe(1); expect(result.failed).toBe(0);
    expect(await receive(eventsQueue)).toBeDefined();
    expect((await sql.query('select balance from wallets where id=$1', [e.data.walletId])).rows[0].balance).toBe('110.00');
  } finally { await publisher.beforeApplicationShutdown(); await sqs.send(new DeleteQueueCommand({ QueueUrl: eventsQueue })); }
});

test('all M16 wallets reconcile exactly against complete signed ledger movements', async () => {
  const mismatches = await sql.query(`select w.id from wallets w left join wallet_ledger_entries l on l.wallet_id=w.id
    group by w.id, w.balance having w.balance <> coalesce(sum(case when l.entry_type='CREDIT' then l.amount else -l.amount end),0)`);
  expect(mismatches.rows).toEqual([]);
});

test('enabled consumer fails closed if the real command FIFO has no redrive policy', async () => {
  const c = new SqsWagerConsumer(consume, { client: sqs, queueUrl, enabled: true });
  try { await expect(c.onApplicationBootstrap()).rejects.toThrow('INVALID_COMMAND_REDRIVE'); }
  finally { await c.beforeApplicationShutdown(); }
});

test('commit already dispatched survives shutdown cancellation and unknown acknowledgement reconciles', async () => {
  const e = await command(), committed = barrier(), release = barrier(), aborted = barrier();
  let context: ReturnType<MikroOrmUnitOfWork['getTransactionContext']>;
  const originalExecute = consume.execute.bind(consume);
  consume.execute = (command, messageId, signal) => {
    signal?.addEventListener('abort', () => aborted.release(), { once: true });
    return originalExecute(command, messageId, signal);
  };
  uow.setTestHook('before_commit', () => {
    context = uow.getTransactionContext()!;
    const transaction = uow.getEntityManager().getTransactionContext<any>()!;
    const confirmation = transaction.executionPromise;
    transaction.executionPromise = confirmation.then(async () => {
      committed.release(); await release.promise; throw new Error('COMMIT_CONFIRMATION_LOST');
    });
  });
  const c = instance(sqs, 50), work = c.processMessage(await deliver(e));
  try {
    await committed.promise; const durable = await financialState(e.data.walletId);
    const closing = c.beforeApplicationShutdown(); await aborted.promise;
    expect(context!.phase).toBe('committing'); expect(context!.rollbackOnly).toBe(false);
    release.release(); expect(await work).toBe(false); await closing;
    expect(context!.phase).toBe('commit_unknown'); expect(uow.getActiveTransactionsCount()).toBe(0);
    uow.clearTestHooks(); consume.execute = originalExecute;
    expect(await financialState(e.data.walletId)).toEqual(durable);
    let next: Message | undefined; for (let i = 0; i < 4 && !next; i++) next = await receive();
    expect(await consumer.processMessage(next!)).toBe(true);
    expect(await financialState(e.data.walletId)).toEqual(durable);
  } finally { release.release(); uow.clearTestHooks(); consume.execute = originalExecute; await work; await c.beforeApplicationShutdown(); }
});
