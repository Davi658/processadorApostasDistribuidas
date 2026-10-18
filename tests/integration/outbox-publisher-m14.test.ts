import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import {
  SQSClient,
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';

import { AppModule } from '../../src/interfaces/http/app.module';
import { DomainExceptionFilter } from '../../src/interfaces/http/filters/domain-exception.filter';
import {
  MikroOrmOutboxRepository,
  MikroOrmUnitOfWork,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletLedgerRepository,
  MikroOrmWalletRepository,
} from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-adapter';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import { ProcessWagerUseCase } from '../../src/application/use-cases/process-wager.use-case';
import { PublishOutboxEventsUseCase } from '../../src/application/use-cases/publish-outbox-events.use-case';
import { OutboxPublisherWorkerService } from '../../src/infrastructure/workers/outbox-publisher-worker.service';
import { SqsOutboxQueuePublisher } from '../../src/infrastructure/messaging/sqs-outbox-queue-publisher.service';
import { createIsolatedTestDatabase, IsolatedTestDatabase } from '../test-db-helper';

describe('M14: Publisher Concorrente da Outbox e SQS FIFO LocalStack (PostgreSQL Real Descartável)', () => {
  let isolatedDb: IsolatedTestDatabase;
  let adminPool: pg.Pool;
  let app: INestApplication;
  let sqsClient: SQSClient;
  let queueUrl: string;

  let uow: MikroOrmUnitOfWork;
  let walletRepo: MikroOrmWalletRepository;
  let wagerRepo: MikroOrmWagerTransactionRepository;
  let ledgerRepo: MikroOrmWalletLedgerRepository;
  let outboxRepo: MikroOrmOutboxRepository;

  let createWalletUseCase: CreateWalletUseCase;
  let processWagerUseCase: ProcessWagerUseCase;
  let publishUseCase: PublishOutboxEventsUseCase;
  let workerService: OutboxPublisherWorkerService;
  let queuePublisher: SqsOutboxQueuePublisher;

  // Drain and clean all messages from the SQS queue
  async function purgeQueue(): Promise<void> {
    try {
      while (true) {
        const res = await sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
            AttributeNames: ['All'],
            MessageAttributeNames: ['All'],
          })
        );
        if (!res.Messages || res.Messages.length === 0) break;
        for (const m of res.Messages) {
          await sqsClient.send(
            new DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: m.ReceiptHandle!,
            })
          );
        }
      }
    } catch {
      // Ignore queue drain errors
    }
  }

  // Poll messages from SQS up to expected count
  async function receiveMessages(expectedCount: number, timeoutMs = 8000): Promise<any[]> {
    const messages: any[] = [];
    const start = Date.now();
    while (messages.length < expectedCount && Date.now() - start < timeoutMs) {
      const res = await sqsClient.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          AttributeNames: ['All'],
          MessageAttributeNames: ['All'],
        })
      );
      if (res.Messages && res.Messages.length > 0) {
        for (const m of res.Messages) {
          messages.push(m);
          await sqsClient.send(
            new DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: m.ReceiptHandle!,
            })
          );
        }
      }
    }
    return messages;
  }

  function spawnWorkerWithMilestone(
    envOverrides: Record<string, string>,
    batchSize = '10',
    leaseDurationMs = '30000'
  ) {
    const runnerScript = join(import.meta.dir, '..', 'concurrency', 'outbox-worker-runner.ts');
    const proc = spawn('bun', ['run', runnerScript, '', batchSize, leaseDurationMs], {
      env: {
        ...process.env,
        DB_NAME: isolatedDb.dbName,
        APP_DB_NAME: isolatedDb.dbName,
        ...envOverrides,
      },
    });

    let stdout = '';
    let milestoneResolve: (value: string) => void;
    const milestonePromise = new Promise<string>((resolve) => {
      milestoneResolve = resolve;
    });

    proc.stdout.on('data', (d) => {
      const str = d.toString();
      stdout += str;
      if (str.includes('MILESTONE:')) {
        const match = str.match(/MILESTONE:([^\r\n]+)/);
        if (match && milestoneResolve) {
          milestoneResolve(match[1]);
        }
      }
    });

    return {
      proc,
      milestonePromise,
      getStdout: () => stdout,
    };
  }

  beforeAll(async () => {
    isolatedDb = await createIsolatedTestDatabase('m14_publisher_');

    adminPool = new pg.Pool({
      ...isolatedDb.adminConfig,
      max: 65,
    });
    adminPool.on('error', () => {});

    // Ensure background tick polling doesn't start automatically
    process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
    process.env.PENDING_WORKER_ENABLED = 'false';

    const sqsEndpoint = process.env.SQS_ENDPOINT || 'http://127.0.0.1:4566';

    sqsClient = new SQSClient({
      endpoint: sqsEndpoint,
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
      },
    });

    const created = await sqsClient.send(new CreateQueueCommand({ QueueName: `m14-${uuidv4()}.fifo`, Attributes: { FifoQueue: 'true' } }));
    queueUrl = created.QueueUrl!;
    process.env.OUTBOX_EVENTS_QUEUE_URL = queueUrl;

    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0);

    uow = app.get(MikroOrmUnitOfWork);
    walletRepo = app.get(MikroOrmWalletRepository);
    wagerRepo = app.get(MikroOrmWagerTransactionRepository);
    ledgerRepo = app.get(MikroOrmWalletLedgerRepository);
    outboxRepo = app.get(MikroOrmOutboxRepository);

    createWalletUseCase = app.get(CreateWalletUseCase);
    processWagerUseCase = app.get(ProcessWagerUseCase);
    publishUseCase = app.get(PublishOutboxEventsUseCase);
    workerService = app.get(OutboxPublisherWorkerService);
    queuePublisher = app.get(SqsOutboxQueuePublisher);
  }, 60000);

  beforeEach(async () => {
    publishUseCase.clearTestHooks();
    await adminPool.query('DELETE FROM outbox_messages');
    await purgeQueue();
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
      if (sqsClient) { if (queueUrl) await sqsClient.send(new DeleteQueueCommand({ QueueUrl: queueUrl })); sqsClient.destroy(); }
      if (adminPool) await adminPool.end();
      if (isolatedDb) await isolatedDb.closeAndDrop();
    } catch {
      // ignore
    }
  });

  it('A. Evento de transação não confirmada não é publicado', async () => {
    const uncommittedClient = await adminPool.connect();
    const eventId = uuidv4();
    const walletId = uuidv4();

    try {
      await uncommittedClient.query('BEGIN');
      await uncommittedClient.query(
        `INSERT INTO outbox_messages
         (id, aggregate_type, aggregate_id, event_type, version, correlation_id, causation_id, occurred_at, payload, created_at)
         VALUES ($1, 'Wallet', $2::text, 'WalletBalanceChanged', 1, 'corr-a', NULL, NOW(), json_build_object('walletId', $2::text, 'playerId', 'player-fixture', 'currency', 'BRL', 'previousBalance', json_build_object('amount','0.00','currency','BRL'), 'currentBalance', json_build_object('amount','1.00','currency','BRL'), 'version',1,'triggerTransactionId','fixture-tx'), NOW());`,
        [eventId, walletId]
      );

      // Publisher runs while transaction is uncommitted: MVCC isolation prevents visibility
      const result = await publishUseCase.execute(10, 30000, 'worker-a');
      expect(result.claimed).toBe(0);
      expect(result.published).toBe(0);

      // Queue remains completely empty
      const messages = await receiveMessages(1, 1000);
      expect(messages.length).toBe(0);

      // Roll back uncommitted transaction
      await uncommittedClient.query('ROLLBACK');
    } finally {
      await uncommittedClient.query('ROLLBACK');
      uncommittedClient.release();
    }

    // After rollback, message is definitely not present or published
    const afterRollbackResult = await publishUseCase.execute(10, 30000, 'worker-a');
    expect(afterRollbackResult.claimed).toBe(0);
    expect(afterRollbackResult.published).toBe(0);

    const checkDb = await adminPool.query('SELECT COUNT(*) FROM outbox_messages WHERE id = $1', [eventId]);
    expect(parseInt(checkDb.rows[0].count, 10)).toBe(0);
  });

  it('B. Publicação preserva integralmente o envelope e os identificadores FIFO', async () => {
    const eventId = uuidv4();
    const aggregateId = uuidv4();
    const correlationId = `corr-b-${uuidv4()}`;
    const causationId = `caus-b-${uuidv4()}`;
    const occurredAt = new Date().toISOString();
    const payload = { walletId: aggregateId, playerId: 'fixture-player', currency: 'BRL',
      previousBalance: { amount: '0.00', currency: 'BRL' }, currentBalance: { amount: '50.00', currency: 'BRL' },
      version: 1, triggerTransactionId: 'fixture-tx' };

    await adminPool.query(
      `INSERT INTO outbox_messages
       (id, aggregate_type, aggregate_id, event_type, version, correlation_id, causation_id, occurred_at, payload, created_at)
       VALUES ($1, 'Wallet', $2::text, 'WalletBalanceChanged', 1, $3, $4, $5, $6, NOW());`,
      [eventId, aggregateId, correlationId, causationId, occurredAt, JSON.stringify(payload)]
    );

    const result = await publishUseCase.execute(10, 30000, 'worker-b');
    expect(result.claimed).toBe(1);
    expect(result.published).toBe(1);
    expect(result.failed).toBe(0);

    // Consume from SQS and verify envelope and FIFO attributes
    const messages = await receiveMessages(1, 5000);
    expect(messages.length).toBe(1);
    const msg = messages[0];

    expect(msg.Attributes.MessageGroupId).toBe(aggregateId);
    expect(msg.Attributes.MessageDeduplicationId).toBe(eventId);

    const body = JSON.parse(msg.Body);
    expect(body.eventId).toBe(eventId);
    expect(body.eventType).toBe('WalletBalanceChanged');
    expect(body.version).toBe(1);
    expect(body.occurredAt).toBe(occurredAt);
    expect(body.aggregateId).toBe(aggregateId);
    expect(body.correlationId).toBe(correlationId);
    expect(body.causationId).toBe(causationId);
    expect(body.data).toEqual(payload);

    // Verify PostgreSQL state
    const dbRes = await adminPool.query(
      'SELECT published_at, lease_token, lease_owner, lease_expires_at, attempts FROM outbox_messages WHERE id = $1',
      [eventId]
    );
    expect(dbRes.rows[0].published_at).not.toBeNull();
    expect(dbRes.rows[0].lease_token).toBeNull();
    expect(dbRes.rows[0].lease_owner).toBeNull();
    expect(dbRes.rows[0].lease_expires_at).toBeNull();
    expect(dbRes.rows[0].attempts).toBe(0);
  });

  it('C. Dois publishers concorrentes não possuem simultaneamente o mesmo claim válido', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = uuidv4();
      ids.push(id);
      await adminPool.query(
        `INSERT INTO outbox_messages
         (id, aggregate_type, aggregate_id, event_type, version, correlation_id, causation_id, occurred_at, payload, created_at)
         VALUES ($1, 'Wallet', $2::text, 'WalletBalanceChanged', 1, 'corr-c', NULL, NOW(), $3, NOW());`,
        [id, `wallet-${i}`, JSON.stringify({ walletId: `wallet-${i}`, playerId: 'player', currency: 'BRL', previousBalance: { amount: '0.00', currency: 'BRL' }, currentBalance: { amount: '1.00', currency: 'BRL' }, version: 1, triggerTransactionId: 'tx' })]
      );
    }

    // Run two claims concurrently with SKIP LOCKED
    const [claimedA, claimedB] = await Promise.all([
      outboxRepo.claimUnpublishedEvents(4, 30000, 'worker-c1'),
      outboxRepo.claimUnpublishedEvents(4, 30000, 'worker-c2'),
    ]);

    expect(claimedA.length).toBeGreaterThan(0);
    expect(claimedB.length).toBeGreaterThan(0);
    expect(claimedA.length + claimedB.length).toBe(6);

    const setA = new Set(claimedA.map((x) => x.id));
    for (const item of claimedB) {
      expect(setA.has(item.id)).toBe(false);
    }

    // Check PostgreSQL state for claim tokens
    const rows = await adminPool.query(
      'SELECT id, lease_owner, lease_token FROM outbox_messages WHERE id = ANY($1)',
      [ids]
    );
    for (const row of rows.rows) {
      expect(['worker-c1', 'worker-c2']).toContain(row.lease_owner);
      expect(row.lease_token).not.toBeNull();
    }
  });

  it('D. Falha antes do envio permite recuperação', async () => {
    const eventId = uuidv4();
    await adminPool.query(
      `INSERT INTO outbox_messages
       (id, aggregate_type, aggregate_id, event_type, version, correlation_id, causation_id, occurred_at, payload, created_at)
       VALUES ($1, 'Wallet', $2::text, 'WalletBalanceChanged', 1, 'corr-d', NULL, NOW(), json_build_object('walletId', $2::text, 'playerId', 'player-fixture', 'currency', 'BRL', 'previousBalance', json_build_object('amount','0.00','currency','BRL'), 'currentBalance', json_build_object('amount','1.00','currency','BRL'), 'version',1,'triggerTransactionId','fixture-tx'), NOW());`,
      [eventId, uuidv4()]
    );

    publishUseCase.setTestHook('before_sqs_send', () => {
      throw new Error('SIMULATED_TRANSIENT_NETWORK_FAULT');
    });

    const failedResult = await publishUseCase.execute(10, 30000, 'worker-d');
    expect(failedResult.failed).toBe(1);
    expect(failedResult.published).toBe(0);

    const intermediate = await adminPool.query(
      'SELECT published_at, attempts, next_attempt_at, last_error, lease_token FROM outbox_messages WHERE id = $1',
      [eventId]
    );
    expect(intermediate.rows[0].published_at).toBeNull();
    expect(intermediate.rows[0].attempts).toBe(1);
    expect(intermediate.rows[0].lease_token).toBeNull();
    expect(intermediate.rows[0].last_error).toContain('SIMULATED_TRANSIENT_NETWORK_FAULT');
    expect(new Date(intermediate.rows[0].next_attempt_at).getTime()).toBeGreaterThan(Date.now() - 5000);

    // Clear failure hook and simulate backoff expiration
    publishUseCase.clearTestHooks();
    await adminPool.query(
      "UPDATE outbox_messages SET next_attempt_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1",
      [eventId]
    );

    const recoveredResult = await publishUseCase.execute(10, 30000, 'worker-d-recovery');
    expect(recoveredResult.published).toBe(1);
    expect(recoveredResult.failed).toBe(0);

    const finalState = await adminPool.query(
      'SELECT published_at, attempts FROM outbox_messages WHERE id = $1',
      [eventId]
    );
    expect(finalState.rows[0].published_at).not.toBeNull();
  });

  it('E. Crash real após claim: outro processo retoma após expiração', async () => {
    const eventId = uuidv4();
    await adminPool.query(
      `INSERT INTO outbox_messages
       (id, aggregate_type, aggregate_id, event_type, version, correlation_id, causation_id, occurred_at, payload, created_at)
       VALUES ($1, 'Wallet', $2::text, 'WalletBalanceChanged', 1, 'corr-e', NULL, NOW(), json_build_object('walletId', $2::text, 'playerId', 'player-fixture', 'currency', 'BRL', 'previousBalance', json_build_object('amount','0.00','currency','BRL'), 'currentBalance', json_build_object('amount','1.00','currency','BRL'), 'version',1,'triggerTransactionId','fixture-tx'), NOW());`,
      [eventId, uuidv4()]
    );

    const child = spawnWorkerWithMilestone({ CRASH_POINT: 'AFTER_CLAIM_BEFORE_SEND' }, '1', '30000');

    try {
      const milestone = await child.milestonePromise;
      expect(milestone).toContain('CLAIM_CONFIRMED');

      const claimedDb = await adminPool.query(
        'SELECT lease_token, lease_owner, published_at FROM outbox_messages WHERE id = $1',
        [eventId]
      );
      expect(claimedDb.rows[0].published_at).toBeNull();
      expect(claimedDb.rows[0].lease_token).not.toBeNull();
      expect(claimedDb.rows[0].lease_owner).toContain('runner-');

      // Abruptly kill the real child process
      const terminated = new Promise<void>((resolve) => child.proc.once('exit', () => resolve()));
      child.proc.kill('SIGKILL');
      await terminated;

      // Another worker attempts to claim immediately: cannot claim because lease is still active in Postgres
      const intermediateResult = await publishUseCase.execute(1, 30000, 'worker-e-interm');
      expect(intermediateResult.claimed).toBe(0);

      // Fast-forward PostgreSQL clock lease expiration
      await adminPool.query(
        "UPDATE outbox_messages SET lease_expires_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1",
        [eventId]
      );

      // Now recovery worker can resume and publish
      const recoveryResult = await publishUseCase.execute(1, 30000, 'worker-e-recovery');
      expect(recoveryResult.claimed).toBe(1);
      expect(recoveryResult.published).toBe(1);

      const finalDb = await adminPool.query(
        'SELECT published_at, lease_token FROM outbox_messages WHERE id = $1',
        [eventId]
      );
      expect(finalDb.rows[0].published_at).not.toBeNull();
      expect(finalDb.rows[0].lease_token).toBeNull();

      const messages = await receiveMessages(1, 5000);
      expect(messages.length).toBe(1);
      expect(JSON.parse(messages[0].Body).eventId).toBe(eventId);
    } finally {
      try {
        child.proc.kill('SIGKILL');
      } catch {}
    }
  });

  it('F. Crash real após confirmação SQS e antes de marcar published_at: recuperação republica sem perda, preservando eventId', async () => {
    const eventId = uuidv4();
    const aggregateId = uuidv4();
    await adminPool.query(
      `INSERT INTO outbox_messages
       (id, aggregate_type, aggregate_id, event_type, version, correlation_id, causation_id, occurred_at, payload, created_at)
       VALUES ($1, 'Wallet', $2::text, 'WalletBalanceChanged', 1, 'corr-f', NULL, NOW(), json_build_object('walletId', $2::text, 'playerId', 'player-fixture', 'currency', 'BRL', 'previousBalance', json_build_object('amount','0.00','currency','BRL'), 'currentBalance', json_build_object('amount','1.00','currency','BRL'), 'version',1,'triggerTransactionId','fixture-tx'), NOW());`,
      [eventId, aggregateId]
    );

    const child = spawnWorkerWithMilestone(
      { CRASH_POINT: 'AFTER_SQS_SEND_BEFORE_MARK_PUBLISHED' },
      '1',
      '30000'
    );

    try {
      const milestone = await child.milestonePromise;
      expect(milestone).toContain('SQS_CONFIRMED');

      // Verify that SQS received the message
      const firstDelivery = await receiveMessages(1, 5000);
      expect(firstDelivery.length).toBe(1);
      expect(JSON.parse(firstDelivery[0].Body).eventId).toBe(eventId);

      // In PostgreSQL, published_at is STILL NULL because the worker died before marking it
      const dbStateBeforeKill = await adminPool.query(
        'SELECT published_at, lease_token FROM outbox_messages WHERE id = $1',
        [eventId]
      );
      expect(dbStateBeforeKill.rows[0].published_at).toBeNull();

      // Kill the child worker abruptly
      const terminated = new Promise<void>((resolve) => child.proc.once('exit', () => resolve()));
      child.proc.kill('SIGKILL');
      await terminated;

      // Fast-forward PostgreSQL lease expiration
      await adminPool.query(
        "UPDATE outbox_messages SET lease_expires_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1",
        [eventId]
      );

      let republishedEnvelope: any = null;
      publishUseCase.setTestHook('before_sqs_send', ({ envelope }) => {
        republishedEnvelope = envelope;
      });

      // Recovery worker resumes: republishes without eventId loss
      const recoveryResult = await publishUseCase.execute(1, 30000, 'worker-f-recovery');
      expect(recoveryResult.claimed).toBe(1);
      expect(recoveryResult.published).toBe(1);

      // Verify that the republish preserved the EXACT same eventId and envelope fields
      expect(republishedEnvelope).not.toBeNull();
      expect(republishedEnvelope.eventId).toBe(eventId);
      expect(republishedEnvelope.aggregateId).toBe(aggregateId);

      // In PostgreSQL, now marked published and lease released
      const finalDb = await adminPool.query(
        'SELECT published_at, lease_token FROM outbox_messages WHERE id = $1',
        [eventId]
      );
      expect(finalDb.rows[0].published_at).not.toBeNull();
      expect(finalDb.rows[0].lease_token).toBeNull();
    } finally {
      try {
        child.proc.kill('SIGKILL');
      } catch {}
    }
  });

  it('G. Token obsoleto não confirma publicação nem modifica a posse atual', async () => {
    const eventId = uuidv4();
    await adminPool.query(
      `INSERT INTO outbox_messages
       (id, aggregate_type, aggregate_id, event_type, version, correlation_id, causation_id, occurred_at, payload, created_at)
       VALUES ($1, 'Wallet', $2::text, 'WalletBalanceChanged', 1, 'corr-g', NULL, NOW(), json_build_object('walletId', $2::text, 'playerId', 'player-fixture', 'currency', 'BRL', 'previousBalance', json_build_object('amount','0.00','currency','BRL'), 'currentBalance', json_build_object('amount','1.00','currency','BRL'), 'version',1,'triggerTransactionId','fixture-tx'), NOW());`,
      [eventId, uuidv4()]
    );

    // Worker 1 claims item
    const claimedW1 = await outboxRepo.claimUnpublishedEvents(1, 30000, 'worker-g1');
    expect(claimedW1.length).toBe(1);
    const token1 = claimedW1[0].leaseToken;

    // Simulate expiration of Worker 1's lease in PostgreSQL
    await adminPool.query(
      "UPDATE outbox_messages SET lease_expires_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1",
      [eventId]
    );

    // Worker 2 claims the expired item
    const claimedW2 = await outboxRepo.claimUnpublishedEvents(1, 30000, 'worker-g2');
    expect(claimedW2.length).toBe(1);
    const token2 = claimedW2[0].leaseToken;
    expect(token1).not.toBe(token2);

    // Worker 1 attempts to mark published using obsolete token1
    const markedByW1 = await outboxRepo.markPublished(eventId, token1);
    expect(markedByW1).toBe(false);

    // PostgreSQL state is completely untouched by the stale worker
    const checkDb = await adminPool.query(
      'SELECT published_at, lease_token, lease_owner FROM outbox_messages WHERE id = $1',
      [eventId]
    );
    expect(checkDb.rows[0].published_at).toBeNull();
    expect(checkDb.rows[0].lease_token).toBe(token2);
    expect(checkDb.rows[0].lease_owner).toBe('worker-g2');

    // Worker 2 marks published with valid token2: succeeds
    const markedByW2 = await outboxRepo.markPublished(eventId, token2);
    expect(markedByW2).toBe(true);

    const finalDb = await adminPool.query(
      'SELECT published_at, lease_token FROM outbox_messages WHERE id = $1',
      [eventId]
    );
    expect(finalDb.rows[0].published_at).not.toBeNull();
    expect(finalDb.rows[0].lease_token).toBeNull();
  });

  it('H. Falha/indisponibilidade do SQS mantém evento não publicado e reagenda', async () => {
    const eventId = uuidv4();
    await adminPool.query(
      `INSERT INTO outbox_messages
       (id, aggregate_type, aggregate_id, event_type, version, correlation_id, causation_id, occurred_at, payload, created_at)
       VALUES ($1, 'Wallet', $2::text, 'WalletBalanceChanged', 1, 'corr-h', NULL, NOW(), json_build_object('walletId', $2::text, 'playerId', 'player-fixture', 'currency', 'BRL', 'previousBalance', json_build_object('amount','0.00','currency','BRL'), 'currentBalance', json_build_object('amount','1.00','currency','BRL'), 'version',1,'triggerTransactionId','fixture-tx'), NOW());`,
      [eventId, uuidv4()]
    );

    // Temporary publisher pointing to unavailable port
    const brokenQueuePublisher = new SqsOutboxQueuePublisher({
      endpoint: 'http://127.0.0.1:49999',
      requestTimeoutMs: 1000,
    });
    const brokenUseCase = new PublishOutboxEventsUseCase(outboxRepo, brokenQueuePublisher, {
      baseDelayMs: 2500,
      retryFactor: 2,
    });

    const result = await brokenUseCase.execute(1, 30000, 'worker-h');
    expect(result.failed).toBe(1);
    expect(result.published).toBe(0);

    const dbRes = await adminPool.query(
      'SELECT published_at, attempts, next_attempt_at, last_error, lease_token FROM outbox_messages WHERE id = $1',
      [eventId]
    );
    expect(dbRes.rows[0].published_at).toBeNull();
    expect(dbRes.rows[0].attempts).toBe(1);
    expect(dbRes.rows[0].lease_token).toBeNull();
    expect(dbRes.rows[0].last_error).not.toBeNull();
    expect(new Date(dbRes.rows[0].next_attempt_at).getTime()).toBeGreaterThan(Date.now());

    await brokenQueuePublisher.beforeApplicationShutdown();
  });

  it('I. Evento inválido não impede publicação dos demais', async () => {
    const idValid1 = uuidv4();
    const idInvalid = 'invalid-not-a-uuid-format';
    const idValid2 = uuidv4();

    // 1. Valid event 1
    await adminPool.query(
      `INSERT INTO outbox_messages
       (id, aggregate_type, aggregate_id, event_type, version, correlation_id, causation_id, occurred_at, payload, created_at)
       VALUES ($1, 'Wallet', $2::text, 'WalletBalanceChanged', 1, 'corr-i1', NULL, NOW(), json_build_object('walletId', $2::text, 'playerId', 'player-fixture', 'currency', 'BRL', 'previousBalance', json_build_object('amount','0.00','currency','BRL'), 'currentBalance', json_build_object('amount','1.00','currency','BRL'), 'version',1,'triggerTransactionId','fixture-tx'), NOW());`,
      [idValid1, uuidv4()]
    );

    // 2. Corrupt / invalid event (we can insert directly via admin SQL bypassing ORM validation, e.g. using a dummy UUID with empty aggregateId)
    const idInvalidUuid = uuidv4();
    await adminPool.query(
      `INSERT INTO outbox_messages
       (id, aggregate_type, aggregate_id, event_type, version, correlation_id, causation_id, occurred_at, payload, created_at)
       VALUES ($1, 'Wallet', '', 'WalletBalanceChanged', 1, 'corr-i2', NULL, NOW(), '{}', NOW());`,
      [idInvalidUuid]
    );

    // 3. Valid event 2
    await adminPool.query(
      `INSERT INTO outbox_messages
       (id, aggregate_type, aggregate_id, event_type, version, correlation_id, causation_id, occurred_at, payload, created_at)
       VALUES ($1, 'Wallet', $2::text, 'WalletBalanceChanged', 1, 'corr-i3', NULL, NOW(), json_build_object('walletId', $2::text, 'playerId', 'player-fixture', 'currency', 'BRL', 'previousBalance', json_build_object('amount','0.00','currency','BRL'), 'currentBalance', json_build_object('amount','1.00','currency','BRL'), 'version',1,'triggerTransactionId','fixture-tx'), NOW());`,
      [idValid2, uuidv4()]
    );

    const result = await publishUseCase.execute(10, 30000, 'worker-i');
    expect(result.claimed).toBe(3);
    expect(result.published).toBe(2);
    expect(result.blocked).toBe(1);
    expect(result.failed).toBe(0);

    // SQS received only the 2 valid events
    const messages = await receiveMessages(2, 5000);
    expect(messages.length).toBe(2);
    const deliveredIds = messages.map((m) => JSON.parse(m.Body).eventId);
    expect(deliveredIds).toContain(idValid1);
    expect(deliveredIds).toContain(idValid2);
    expect(deliveredIds).not.toContain(idInvalidUuid);

    // In DB, invalid event is isolated and operationally blocked
    const blockedDb = await adminPool.query(
      'SELECT is_operationally_blocked, operational_block_reason, published_at FROM outbox_messages WHERE id = $1',
      [idInvalidUuid]
    );
    expect(blockedDb.rows[0].is_operationally_blocked).toBe(true);
    expect(blockedDb.rows[0].operational_block_reason).toBe('MISSING_AGGREGATE_ID');
    expect(blockedDb.rows[0].published_at).toBeNull();
  });

  for (const phase of ['send', 'cancel', 'ack'] as const) {
    it(`J. Real Nest shutdown: ${phase}, execution ends before SQS and ORM`, async () => {
      const barrier = () => {
        let resolve!: () => void;
        const promise = new Promise<void>(r => { resolve = r; });
        return { promise, resolve };
      };
      const entered = barrier(), release = barrier(), stopping = barrier(), cancelled = barrier();
      const order: string[] = [];
      const testApp = await NestFactory.create(AppModule, { logger: false });
      await testApp.init();
      const useCase = testApp.get(PublishOutboxEventsUseCase);
      const worker = testApp.get(OutboxPublisherWorkerService);
      const publisher = testApp.get(SqsOutboxQueuePublisher);
      const orm = testApp.get(MikroOrmUnitOfWork);
      const client = (publisher as any).client as SQSClient;
      const originalSend = client.send.bind(client) as any;
      const destroy = client.destroy.bind(client);
      client.destroy = () => { order.push('client.destroy'); destroy(); };
      const close = orm.close.bind(orm);
      orm.close = async () => { order.push('ORM close'); await close(); };
      const shutdown = worker.onModuleDestroy.bind(worker);
      worker.onModuleDestroy = async () => { const p = shutdown(); stopping.resolve(); await p; };
      if (phase === 'cancel') Object.defineProperty(worker, 'drainTimeoutMs', { value: 0 });
      if (phase === 'send') client.middlewareStack.add(next => async args => {
        // The real SDK send is in progress, before broker acceptance.
        entered.resolve(); await release.promise; return next(args);
      }, { step: 'initialize', name: 'shutdownSendBarrier' });
      (client as any).send = async (command: any, options: any) => {
        const response = await originalSend(command, options);
        // Real SQS has accepted the send, while the caller is still awaiting its result.
        if (phase === 'cancel') {
          options.abortSignal.addEventListener('abort', () => cancelled.resolve(), { once: true });
          entered.resolve();
          await release.promise;
          if (options.abortSignal.aborted) throw new Error('CANCELLED_AFTER_BROKER_ACCEPTED');
        }
        return response;
      };
      if (phase === 'ack') useCase.setTestHook('before_mark_published', async () => {
        entered.resolve(); await release.promise;
      });
      const eventId = uuidv4(), walletId = uuidv4();
      await adminPool.query(`INSERT INTO outbox_messages
        (id,aggregate_type,aggregate_id,event_type,version,correlation_id,occurred_at,payload,created_at)
        VALUES ($1,'Wallet',$2,'WalletBalanceChanged',1,'shutdown',NOW(),$3,NOW())`,
        [eventId, walletId, JSON.stringify({ walletId, playerId: 'player', currency: 'BRL',
          previousBalance: { amount: '0.00', currency: 'BRL' }, currentBalance: { amount: '1.00', currency: 'BRL' },
          version: 1, triggerTransactionId: 'tx' })]);
      const execution = worker.executeBatch(1).finally(() => order.push('execution-ended'));
      await entered.promise;
      const closing = testApp.close();
      await stopping.promise;
      expect(worker.isShuttingDownStatus()).toBe(true);
      expect((await worker.executeBatch()).claimed).toBe(0);
      expect(order).toEqual([]);
      if (phase === 'cancel') { await cancelled.promise; expect(worker.isAbortRequested()).toBe(true); expect(order).toEqual([]); }
      const pending = await adminPool.query('SELECT published_at FROM outbox_messages WHERE id=$1', [eventId]);
      expect(pending.rows[0].published_at).toBeNull();
      release.resolve();
      await Promise.all([execution, closing]);
      expect(order).toEqual(['execution-ended', 'client.destroy', 'ORM close']);
      const final = await adminPool.query('SELECT published_at FROM outbox_messages WHERE id=$1', [eventId]);
      if (phase === 'cancel') {
        expect(final.rows[0].published_at).toBeNull();
        const recovered = await publishUseCase.execute(1);
        expect(recovered.published).toBe(1);
      } else expect(final.rows[0].published_at).not.toBeNull();
      expect((await receiveMessages(1)).map(m => JSON.parse(m.Body).eventId)).toContain(eventId);
    });
  }

  for (const operation of ['markPublished', 'recordFailure', 'markOperationallyBlocked'] as const) {
    for (const state of ['valid', 'wrong', 'expired', 'reclaimed', 'published', 'blocked'] as const) {
      it(`L. PostgreSQL authorization ${operation}/${state}: unauthorized updates mutate nothing`, async () => {
        const id = uuidv4();
        await adminPool.query(`INSERT INTO outbox_messages
          (id,aggregate_type,aggregate_id,event_type,version,correlation_id,occurred_at,payload,created_at)
          VALUES ($1,'Wallet','wallet','WalletBalanceChanged',1,'corr',NOW(),'{}',NOW())`, [id]);
        const [claim] = await outboxRepo.claimUnpublishedEvents(1, 30000, 'fencing');
        let token = claim.leaseToken;
        if (state === 'wrong') token = uuidv4();
        if (state === 'expired' || state === 'reclaimed') await adminPool.query(
          "UPDATE outbox_messages SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1", [id]);
        if (state === 'reclaimed') await outboxRepo.claimUnpublishedEvents(1, 30000, 'new-owner');
        // Retain token deliberately to prove state eligibility independently from fencing.
        if (state === 'published') await adminPool.query('UPDATE outbox_messages SET published_at=clock_timestamp() WHERE id=$1', [id]);
        if (state === 'blocked') await adminPool.query('UPDATE outbox_messages SET is_operationally_blocked=true WHERE id=$1', [id]);
        const before = (await adminPool.query('SELECT * FROM outbox_messages WHERE id=$1', [id])).rows;
        const result = operation === 'markPublished' ? await outboxRepo.markPublished(id, token) :
          operation === 'recordFailure' ? await outboxRepo.recordFailure(id, token, 1000, 'failure') :
          await outboxRepo.markOperationallyBlocked(id, token, 'reason', 'error');
        expect(result).toBe(state === 'valid');
        if (state !== 'valid') expect((await adminPool.query('SELECT * FROM outbox_messages WHERE id=$1', [id])).rows).toEqual(before);
      });
    }
  }

  it('M. Send accepted after lease expiry stays unpublished and republishes identical identity', async () => {
    const wallet = await createWalletUseCase.execute({ playerId: uuidv4(), initialBalance: { amount: '1.00', currency: 'BRL' } });
    let original: any;
    publishUseCase.setTestHook('after_sqs_send', async ({ event, envelope }) => {
      original = envelope;
      await adminPool.query("UPDATE outbox_messages SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1", [event.id]);
    });
    expect((await publishUseCase.execute(1)).staleLease).toBe(1);
    expect((await adminPool.query('SELECT published_at FROM outbox_messages WHERE id=$1', [original.eventId])).rows[0].published_at).toBeNull();
    publishUseCase.clearTestHooks();
    let replay: any;
    publishUseCase.setTestHook('before_sqs_send', ({ envelope }) => { if (envelope.eventId === original.eventId) replay = envelope; });
    expect((await publishUseCase.execute(20)).published).toBe(2);
    expect(replay).toEqual(original);
  });

  it('N. releaseLease permits expired matching token only, without authorizing publication', async () => {
    const wallet = await createWalletUseCase.execute({ playerId: uuidv4(), initialBalance: { amount: '1.00', currency: 'BRL' } });
    const [claim] = await outboxRepo.claimUnpublishedEvents(1);
    await adminPool.query("UPDATE outbox_messages SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1", [claim.id]);
    expect(await outboxRepo.markPublished(claim.id, claim.leaseToken)).toBe(false);
    expect(await outboxRepo.releaseLease(claim.id, 'wrong')).toBe(false);
    expect(await outboxRepo.releaseLease(claim.id, claim.leaseToken)).toBe(true);
    expect(await outboxRepo.markPublished(claim.id, claim.leaseToken)).toBe(false);
    const [next] = await outboxRepo.claimUnpublishedEvents(1);
    expect(await outboxRepo.releaseLease(next.id, claim.leaseToken)).toBe(false);
  });

  for (const corruption of ['payload', 'money', 'currency', 'type', 'version', 'metadata'] as const) {
    it(`O. Persisted invalid ${corruption} blocks only its event and preserves data`, async () => {
      await createWalletUseCase.execute({ playerId: uuidv4(), initialBalance: { amount: '1.00', currency: 'BRL' } });
      const { rows: [invalid] } = await adminPool.query("SELECT id FROM outbox_messages WHERE event_type='WalletBalanceChanged'");
      if (corruption === 'payload') await adminPool.query("UPDATE outbox_messages SET payload='{}' WHERE id=$1", [invalid.id]);
      if (corruption === 'money') await adminPool.query(`UPDATE outbox_messages SET payload=jsonb_set(payload::jsonb, '{currentBalance,amount}', '1') WHERE id=$1`, [invalid.id]);
      if (corruption === 'currency') await adminPool.query(`UPDATE outbox_messages SET payload=jsonb_set(payload::jsonb, '{currentBalance,currency}', '"USD"') WHERE id=$1`, [invalid.id]);
      if (corruption === 'type') await adminPool.query("UPDATE outbox_messages SET event_type='FutureEvent' WHERE id=$1", [invalid.id]);
      if (corruption === 'version') await adminPool.query('UPDATE outbox_messages SET version=2 WHERE id=$1', [invalid.id]);
      if (corruption === 'metadata') await adminPool.query("UPDATE outbox_messages SET correlation_id='' WHERE id=$1", [invalid.id]);
      const before = (await adminPool.query('SELECT payload, occurred_at FROM outbox_messages WHERE id=$1', [invalid.id])).rows[0];
      const result = await publishUseCase.execute(20);
      expect(result.blocked).toBe(1); expect(result.published).toBe(1);
      const after = (await adminPool.query('SELECT payload, occurred_at, published_at, is_operationally_blocked FROM outbox_messages WHERE id=$1', [invalid.id])).rows[0];
      expect(after.published_at).toBeNull(); expect(after.is_operationally_blocked).toBe(true);
      expect(after.payload).toEqual(before.payload); expect(after.occurred_at).toEqual(before.occurred_at);
    });
  }

  it('K. Publicação não altera saldo, versão, transações ou ledger', async () => {
    // 1. Create wallet with 100.00 BRL
    const playerId = uuidv4();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    // 2. Perform a BET of 25.00 BRL
    const betTxId = `bet-k-${uuidv4()}`;
    await processWagerUseCase.execute(uuidv4(), {
      providerId: 'EVOLUTION',
      externalTransactionId: betTxId,
      playerId,
      walletId: wallet.id,
      roundId: 'round-k',
      gameId: 'roulette',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    });

    // Capture financial state BEFORE publishing
    const walletBefore = await adminPool.query('SELECT balance, version FROM wallets WHERE id = $1', [wallet.id]);
    const txBefore = await adminPool.query(
      'SELECT id, status, amount, attempts, response_snapshot FROM wager_transactions WHERE wallet_id = $1 AND external_transaction_id = $2',
      [wallet.id, betTxId]
    );
    const ledgerBefore = await adminPool.query(
      'SELECT id, entry_type, amount, balance_before, balance_after FROM wallet_ledger_entries WHERE wallet_id = $1 ORDER BY created_at ASC',
      [wallet.id]
    );
    const outboxBefore = await adminPool.query(
      'SELECT COUNT(*) FROM outbox_messages WHERE aggregate_id = $1 AND published_at IS NULL',
      [wallet.id]
    );
    expect(parseInt(outboxBefore.rows[0].count, 10)).toBeGreaterThan(0);

    // 3. Run publisher to publish all outbox events
    const pubResult = await publishUseCase.execute(20, 30000, 'worker-k');
    expect(pubResult.published).toBe(parseInt(outboxBefore.rows[0].count, 10));

    // Capture financial state AFTER publishing
    const walletAfter = await adminPool.query('SELECT balance, version FROM wallets WHERE id = $1', [wallet.id]);
    const txAfter = await adminPool.query(
      'SELECT id, status, amount, attempts, response_snapshot FROM wager_transactions WHERE wallet_id = $1 AND external_transaction_id = $2',
      [wallet.id, betTxId]
    );
    const ledgerAfter = await adminPool.query(
      'SELECT id, entry_type, amount, balance_before, balance_after FROM wallet_ledger_entries WHERE wallet_id = $1 ORDER BY created_at ASC',
      [wallet.id]
    );
    const outboxAfter = await adminPool.query(
      'SELECT COUNT(*) FROM outbox_messages WHERE aggregate_id = $1 AND published_at IS NULL',
      [wallet.id]
    );

    // Assert strictly immutable financial invariant:
    expect(walletAfter.rows[0].balance).toBe(walletBefore.rows[0].balance);
    expect(walletAfter.rows[0].version).toBe(walletBefore.rows[0].version);
    expect(txAfter.rows[0].status).toBe(txBefore.rows[0].status);
    expect(txAfter.rows[0].amount).toBe(txBefore.rows[0].amount);
    expect(txAfter.rows[0].attempts).toBe(txBefore.rows[0].attempts);
    expect(txAfter.rows[0].response_snapshot).toEqual(txBefore.rows[0].response_snapshot);
    expect(ledgerAfter.rows).toEqual(ledgerBefore.rows);

    // Only outbox unpublished count changed
    expect(parseInt(outboxAfter.rows[0].count, 10)).toBe(0);
  });
});
