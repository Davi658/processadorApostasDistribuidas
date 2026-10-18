import { beforeAll, afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from '../test-db-helper';
import { MikroOrmUnitOfWork, MikroOrmWalletRepository, MikroOrmWagerTransactionRepository, MikroOrmWalletLedgerRepository, MikroOrmOutboxRepository } from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-adapter';
import { MikroOrmInboxRepository } from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-inbox-repository';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import { ProcessWagerUseCase } from '../../src/application/use-cases/process-wager.use-case';
import { ConsumeWagerCommand } from '../../src/application/messaging/consume-wager-command';
import { parseWagerCommand } from '../../src/application/messaging/wager-command';
let db: IsolatedTestDatabase, uow: MikroOrmUnitOfWork, sql: pg.Pool, consume: ConsumeWagerCommand, create: CreateWalletUseCase;
beforeAll(async () => {
  db = await createIsolatedTestDatabase('delivery_external_'); sql = new pg.Pool(db.adminConfig);
  uow = new MikroOrmUnitOfWork(); await uow.init();
  const wallets = new MikroOrmWalletRepository(uow), wagers = new MikroOrmWagerTransactionRepository(uow), ledger = new MikroOrmWalletLedgerRepository(uow), outbox = new MikroOrmOutboxRepository(uow);
  create = new CreateWalletUseCase(wallets, wagers, ledger, outbox, uow);
  consume = new ConsumeWagerCommand(uow, new MikroOrmInboxRepository(uow), wagers, new ProcessWagerUseCase(wallets, wagers, ledger, outbox, uow));
});
test('real SQS redelivery after process death at committed external inbox barrier preserves exact records', async () => {
  const { SQSClient, CreateQueueCommand, SendMessageCommand, ReceiveMessageCommand, DeleteQueueCommand } = await import('@aws-sdk/client-sqs');
  const { SqsWagerConsumer } = await import('../../src/infrastructure/messaging/sqs-wager-consumer.service');
  const { spawn } = await import('node:child_process');
  const { join } = await import('node:path');
  const client = new SQSClient({ endpoint: process.env.SQS_ENDPOINT, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const queue = (await client.send(new CreateQueueCommand({ QueueName: `delivery-crash-${crypto.randomUUID()}.fifo`, Attributes: { FifoQueue: 'true', VisibilityTimeout: '3' } }))).QueueUrl!;
  const consumer = new SqsWagerConsumer(consume, { client, queueUrl: queue, visibilitySeconds: 3, renewalMs: 400, requestTimeoutMs: 1500 });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const wallet = await create.execute({ playerId: crypto.randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } });
    const envelope = { messageId: `external-crash-${crypto.randomUUID()}`, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: {
      providerId: 'delivery-crash', externalTransactionId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), walletId: wallet.id, playerId: wallet.playerId,
      roundId: 'r', gameId: 'g', kind: 'BET', money: { amount: '10.00', currency: 'BRL' } } };
    await client.send(new SendMessageCommand({ QueueUrl: queue, MessageBody: JSON.stringify(envelope), MessageGroupId: wallet.id, MessageDeduplicationId: crypto.randomUUID() }));
    const receive = async () => (await client.send(new ReceiveMessageCommand({ QueueUrl: queue, MessageSystemAttributeNames: ['All'], WaitTimeSeconds: 1 }))).Messages?.[0];
    const delivery = await receive(); expect(delivery).toBeDefined();
    child = spawn(process.execPath, ['run', join(import.meta.dir, '../concurrency/consumer-shutdown-m16-runner.ts')], { env: { ...process.env, M16_QUEUE: queue, M16_CUT: 'after_commit', M16_DELIVERY: JSON.stringify(delivery) } });
    let output = ''; child.stdout!.on('data', d => output += d); child.stderr!.on('data', d => output += d);
    const exited = new Promise<void>((resolve, reject) => { child!.once('close', () => resolve()); child!.once('error', reject); });
    const deadline = Date.now() + 15000;
    while (!output.includes('BARRIER')) { if (child.exitCode !== null || Date.now() > deadline) throw new Error(`CRASH_BARRIER_FAILED: ${output}`); await Bun.sleep(20); }
    const snapshot = async () => {
      const rows: unknown[] = [];
      for (const table of ['wallets','wager_transactions','wallet_ledger_entries','outbox_messages','command_inbox']) rows.push((await sql.query(`select to_jsonb(t) row from ${table} t order by to_jsonb(t)::text`)).rows);
      return rows;
    };
    const accepted = (await sql.query('select * from command_inbox where command_id=$1', [envelope.messageId])).rows[0];
    expect(accepted.transaction_id).toBeDefined();
    const committed = await snapshot();
    child.kill('SIGKILL'); await exited;
    let redelivery;
    const recoveryDeadline = Date.now() + 12000;
    while (!redelivery && Date.now() < recoveryDeadline) redelivery = await receive();
    expect(redelivery?.MessageId).toBe(delivery!.MessageId);
    expect(redelivery?.ReceiptHandle).not.toBe(delivery!.ReceiptHandle);
    expect(await consumer.processMessage(redelivery!)).toBe(true);
    expect(await snapshot()).toEqual(committed);
    const reconciliation = (await sql.query(`select w.balance::text as balance, w.balance=coalesce(sum(case when l.entry_type='CREDIT' then l.amount else -l.amount end),0) as consistent from wallets w join wallet_ledger_entries l on l.wallet_id=w.id where w.id=$1 group by w.id`, [wallet.id])).rows[0];
    expect(reconciliation).toEqual({ balance: '90.00', consistent: true });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child!.once('close', resolve)); }
    await consumer.beforeApplicationShutdown(); await client.send(new DeleteQueueCommand({ QueueUrl: queue })); client.destroy();
  }
}, 30000);
afterAll(async () => { await uow?.close(); await sql?.end(); await db?.closeAndDrop(); });
test('external logical identity, financial replay, content conflict and rollback preserve exact records', async () => {
  const wallet = await create.execute({ playerId: crypto.randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } });
  const e = { messageId: 'msg-123', type: 'WagerTransactionRequested', occurredAt: '2026-07-29T15:00:00.000Z', data: {
    providerId: 'provider-a', externalTransactionId: 'transaction-123', idempotencyKey: 'provider-a:transaction-123', playerId: wallet.playerId,
    walletId: wallet.id, roundId: 'round-987', gameId: 'fortune-chimp', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } } };
  const parse = (value = e) => parseWagerCommand(JSON.stringify(value));
  const first = await consume.execute(parse(), 'SQS-transport-1');
  const snapshot = async () => {
    const state: unknown[] = [];
    for (const table of ['wallets','wager_transactions','wallet_ledger_entries','outbox_messages','command_inbox']) state.push((await sql.query(`select to_jsonb(t) row from ${table} t order by to_jsonb(t)::text`)).rows);
    return state;
  };
  const before = await snapshot();
  const replay = await consume.execute(parse(), 'different-SQS-transport-2');
  expect(replay.transactionId).toBe(first.transactionId); expect(replay.idempotentReplay).toBe(true);
  expect(await snapshot()).toEqual(before);
  await expect(consume.execute(parse({ ...e, data: { ...e.data, money: { amount: '26.00', currency: 'BRL' } } }), 'transport-3')).rejects.toThrow('COMMAND_CONTENT_CONFLICT');
  expect(await snapshot()).toEqual(before);
  const secondIdentity = await consume.execute(parse({ ...e, messageId: 'msg-456' }), 'transport-4');
  expect(secondIdentity.transactionId).toBe(first.transactionId);
  const accepted = (await sql.query('select * from command_inbox where transaction_id=$1 order by command_id', [first.transactionId])).rows;
  expect(accepted.map(r => r.command_id)).toEqual(['msg-123','msg-456']);
  expect(accepted.every(r => r.consumer_name === 'wager-transaction-requested-v1' && r.transaction_id === first.transactionId)).toBe(true);
  expect(accepted[0].message_id).toBe('SQS-transport-1');
  const beforeRollback = await snapshot();
  uow.setTestHook('before_commit', () => { throw new Error('ROLLBACK'); });
  try {
    await expect(consume.execute(parse({ ...e, messageId: 'msg-rollback', data: { ...e.data, externalTransactionId: 'rollback', idempotencyKey: 'rollback' } }), 'transport-5')).rejects.toThrow('ROLLBACK');
  } finally { uow.clearTestHooks(); }
  expect(await snapshot()).toEqual(beforeRollback);
  expect((await sql.query('select balance::text from wallets where id=$1', [wallet.id])).rows[0].balance).toBe('75.00');
});
