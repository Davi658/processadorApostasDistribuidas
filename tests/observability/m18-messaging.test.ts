import { ReprocessPendingReferencesUseCase } from '../../src/application/use-cases/reprocess-pending-references.use-case';
import 'reflect-metadata';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { SQSClient, CreateQueueCommand, DeleteQueueCommand, SendMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import pg from 'pg';
import { AppModule } from '../../src/interfaces/http/app.module';
import { DomainExceptionFilter } from '../../src/interfaces/http/filters/domain-exception.filter';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from '../test-db-helper';
import { HttpObservability } from '../../src/infrastructure/observability/http-observability';
import { SqsOutboxQueuePublisher } from '../../src/infrastructure/messaging/sqs-outbox-queue-publisher.service';
import { SqsWagerConsumer } from '../../src/infrastructure/messaging/sqs-wager-consumer.service';
import { OutboxPublisherWorkerService } from '../../src/infrastructure/workers/outbox-publisher-worker.service';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import { PublishOutboxEventsUseCase } from '../../src/application/use-cases/publish-outbox-events.use-case';
import { ConsumeWagerCommand } from '../../src/application/messaging/consume-wager-command';
import { MikroOrmInboxRepository } from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-inbox-repository';
import { MikroOrmUnitOfWork, MikroOrmWagerTransactionRepository } from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-adapter';
import { ProcessWagerUseCase } from '../../src/application/use-cases/process-wager.use-case';

let db: IsolatedTestDatabase, app: INestApplication, sql: pg.Pool, url: string, client: SQSClient;
let queueUrl: string, commandQueue: string, publisher: PublishOutboxEventsUseCase, consumer: SqsWagerConsumer;
const lines: string[] = [], telemetry = new HttpObservability(line => lines.push(line));
const queueName = `m18-${crypto.randomUUID()}.fifo`;
const events = () => lines.map(line => JSON.parse(line));
const count = (component: string, operation: string, result: string) => events().filter(e => e.component === component && e.operation === operation && e.result === result).length;
beforeAll(async () => {
  db = await createIsolatedTestDatabase('m18_broker_'); sql = new pg.Pool(db.adminConfig);
  client = new SQSClient({ endpoint: process.env.SQS_ENDPOINT, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  queueUrl = (await client.send(new CreateQueueCommand({ QueueName: queueName, Attributes: { FifoQueue: 'true' } }))).QueueUrl!;
  commandQueue = (await client.send(new CreateQueueCommand({ QueueName: `m18-command-${crypto.randomUUID()}.fifo`, Attributes: { FifoQueue: 'true' } }))).QueueUrl!;
  process.env.OUTBOX_PUBLISHER_ENABLED = 'true'; process.env.PENDING_WORKER_ENABLED = 'false'; process.env.SQS_CONSUMER_ENABLED = 'false';
  const transport = new SqsOutboxQueuePublisher({ sqsClient: client, queueUrl, requestTimeoutMs: 500 });
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(HttpObservability).useValue(telemetry)
    .overrideProvider(SqsOutboxQueuePublisher).useValue(transport)
    .overrideProvider(OutboxPublisherWorkerService).useValue({}).compile();
  app = module.createNestApplication({ logger: false }); app.useGlobalFilters(new DomainExceptionFilter());
  await app.listen(0, '127.0.0.1'); url = await app.getUrl();
  publisher = app.get(PublishOutboxEventsUseCase);
  const uow = app.get(MikroOrmUnitOfWork);
  consumer = new SqsWagerConsumer(new ConsumeWagerCommand(uow, new MikroOrmInboxRepository(uow),
    app.get(MikroOrmWagerTransactionRepository), app.get(ProcessWagerUseCase)), { client, queueUrl: commandQueue, telemetry, retryBaseSeconds: 1 });
}, 30000);
afterAll(async () => {
  await consumer?.beforeApplicationShutdown(); await app?.close();
  if (queueUrl) await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
  if (commandQueue) await client.send(new DeleteQueueCommand({ QueueUrl: commandQueue }));
  client?.destroy(); await sql?.end(); await db?.closeAndDrop();
});

test('broker confirmation survives failed local mark; retry is distinct from confirmed local result', async () => {
  await app.get(CreateWalletUseCase).execute({ playerId: crypto.randomUUID(), initialBalance: { amount: '123.45', currency: 'BRL' } });
  publisher.setTestHook('before_mark_published', () => { throw new Error('secret-value-123.45'); });
  const first = await publisher.execute(); expect(first.published).toBe(0); expect(first.failed).toBe(2);
  expect(count('publisher', 'send', 'broker_confirmed')).toBe(2); expect(count('publisher', 'mark', 'local_confirmed')).toBe(0);
  publisher.clearTestHooks();
  await sql.query('update outbox_messages set next_attempt_at=now()');
  const retry = await publisher.execute(); expect(retry.published).toBe(2);
  expect(count('publisher', 'send', 'attempt')).toBe(4); expect(count('publisher', 'mark', 'local_confirmed')).toBe(2);
});

test('rollback produces no durable result, commit and inbox replay preserve all financial state', async () => {
  const wallet = await app.get(CreateWalletUseCase).execute({ playerId: crypto.randomUUID(), initialBalance: { amount: '123.45', currency: 'BRL' } });
  const command = { version: 1, commandType: 'ProcessWager', commandId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
    data: { providerId: 'm18', externalTransactionId: crypto.randomUUID(), playerId: wallet.playerId, walletId: wallet.id,
      roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '1.23', currency: 'BRL' } } };
  // FIFO identity validation uses commandId, so send the canonical deduplication id.
  const message = async () => {
    await client.send(new SendMessageCommand({ QueueUrl: commandQueue, MessageBody: JSON.stringify(command), MessageGroupId: wallet.id, MessageDeduplicationId: command.commandId }));
    return (await client.send(new ReceiveMessageCommand({ QueueUrl: commandQueue, MessageSystemAttributeNames: ['All'], WaitTimeSeconds: 1 }))).Messages![0]!;
  };
  const m = await message();
  const uow = app.get(MikroOrmUnitOfWork);
  uow.setTestHook('before_commit', () => { throw new Error('secret-rollback-123.45'); });
  try { expect(await consumer.processMessage(m)).toBe(false); } finally { uow.clearTestHooks(); }
  expect(count('consumer', 'transaction', 'durable')).toBe(0);
  expect((await sql.query('select count(*)::int n from command_inbox')).rows[0].n).toBe(0);
  expect(await consumer.processMessage(m)).toBe(true);
  const snapshot = async () => (await sql.query(`select jsonb_build_object(
    'wallets', (select jsonb_agg(t) from wallets t), 'tx', (select jsonb_agg(t) from wager_transactions t),
    'ledger', (select jsonb_agg(t) from wallet_ledger_entries t), 'inbox', (select jsonb_agg(t) from command_inbox t),
    'outbox', (select jsonb_agg(t) from outbox_messages t)) s`)).rows[0].s;
  const before = await snapshot();
  // Same committed command remains replayable even if the prior ack was lost.
  expect(await consumer.processMessage(m)).toBe(true);
  expect(await snapshot()).toEqual(before);
  expect(await consumer.processMessage({ ...m, Body: JSON.stringify({ ...command, correlationId: 'm18-explicit' }) })).toBe(true);
  expect(await snapshot()).toEqual(before);
  expect(events().some(e => e.correlationId === 'm18-explicit')).toBe(true);
  expect(count('consumer', 'inbox', 'accepted')).toBe(1); expect(count('consumer', 'inbox', 'duplicate')).toBe(2);
  expect(events().some(e => e.correlationId === command.idempotencyKey)).toBe(true);
  expect(lines.join('')).not.toMatch(/123\.45|secret|ReceiptHandle|MessageBody|balance/);
  const metrics = await (await fetch(`${url}/metrics`)).text();
  expect(metrics).toContain('component="consumer",operation="inbox",result="duplicate"} 2');
  expect(metrics).toContain('financial_transactions_total{status="PROCESSED",kind="BET"}');
  expect(metrics).toContain('financial_transaction_duration_seconds');
  expect(metrics).toContain('sqs_dlq_messages_visible{queue="wager-transactions-dlq.fifo"} 0');
  expect(metrics).toContain('outbox_delay_seconds');
  expect(metrics).toContain('outbox_pending_events_total');
  expect(metrics).not.toContain(command.commandId); expect(metrics).not.toContain(command.idempotencyKey);
  const inboxEvents = events().filter(e => e.component === 'consumer' && e.operation === 'inbox');
  expect(inboxEvents.some(e => e.walletId === wallet.id)).toBe(true);
  expect(inboxEvents.some(e => e.providerId === 'm18')).toBe(true);
  expect(inboxEvents.some(e => typeof e.messageId === 'string')).toBe(true);
});

test('reference metrics count confirmed resolutions only and disclose missing historical correlation', async () => {
  const wallet = await app.get(CreateWalletUseCase).execute({ playerId: crypto.randomUUID(), initialBalance: { amount: '123.45', currency: 'BRL' } });
  const reference = crypto.randomUUID();
  const dto = { providerId: 'm18-ref', externalTransactionId: crypto.randomUUID(), playerId: wallet.playerId,
    walletId: wallet.id, roundId: 'round', gameId: 'game', kind: 'WIN' as const, money: { amount: '1.23', currency: 'BRL' },
    referenceExternalTransactionId: reference, correlationId: 'historical-trace-not-persisted' };
  const pending = await app.get(ProcessWagerUseCase).execute(crypto.randomUUID(), dto);
  expect(pending.status).toBe('PENDING_REFERENCE');
  await sql.query('update wager_transactions set next_attempt_at=now() where id=$1', [pending.transactionId]);
  const worker = app.get(ReprocessPendingReferencesUseCase), uow = app.get(MikroOrmUnitOfWork);
  uow.setTestHook('before_commit', () => { throw new Error('secret-reference-123.45'); });
  try { expect((await worker.execute()).failed).toBe(1); } finally { uow.clearTestHooks(); }
  expect(count('references', 'reprocess', 'processed')).toBe(0);
  expect(count('references', 'reprocess', 'rescheduled')).toBe(0);
  expect((await worker.execute()).rescheduled).toBe(1);
  expect(count('references', 'reprocess', 'rescheduled')).toBe(1);
  await app.get(ProcessWagerUseCase).execute(crypto.randomUUID(), { ...dto, kind: 'BET', externalTransactionId: reference, referenceExternalTransactionId: undefined });
  await sql.query('update wager_transactions set next_attempt_at=now() where id=$1', [pending.transactionId]);
  expect((await worker.execute()).processed).toBe(1);
  const resolved = events().find(e => e.component === 'references' && e.result === 'processed');
  expect(resolved.correlationId).toBeNull(); expect(resolved.transactionId).toBe(pending.transactionId);
  expect(lines.join('')).not.toMatch(/123\.45|secret-reference|historical-trace-not-persisted/);
  expect((await sql.query('select balance::text from wallets where id=$1', [wallet.id])).rows[0].balance).toBe('123.45');
});

test('real SQS unavailability returns generic 503 while liveness stays up, recovers and disabled dependencies skip probing', async () => {
  expect((await fetch(`${url}/health/ready`)).status).toBe(200);
  await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
  const response = await fetch(`${url}/health/ready`); expect(response.status).toBe(503); expect(await response.json()).toEqual({ status: 'unavailable' });
  expect((await fetch(`${url}/health/live`)).status).toBe(200);
  process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
  expect((await fetch(`${url}/health/ready`)).status).toBe(200);
  queueUrl = (await client.send(new CreateQueueCommand({ QueueName: queueName, Attributes: { FifoQueue: 'true' } }))).QueueUrl!;
  process.env.OUTBOX_PUBLISHER_ENABLED = 'true';
  expect((await fetch(`${url}/health/ready`)).status).toBe(200);
});
