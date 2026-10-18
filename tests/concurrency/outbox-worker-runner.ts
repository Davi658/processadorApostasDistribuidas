import { existsSync } from 'node:fs';
import {
  MikroOrmOutboxRepository,
  MikroOrmUnitOfWork,
} from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-adapter';
import { PublishOutboxEventsUseCase } from '../../src/application/use-cases/publish-outbox-events.use-case';
import { OutboxPublisherWorkerService } from '../../src/infrastructure/workers/outbox-publisher-worker.service';
import { SqsOutboxQueuePublisher } from '../../src/infrastructure/messaging/sqs-outbox-queue-publisher.service';

async function main() {
  const [, , barrierFilePath, batchSizeStr, leaseDurationMsStr] = process.argv;

  const batchSize = batchSizeStr ? Number(batchSizeStr) : 10;
  const leaseDurationMs = leaseDurationMsStr ? Number(leaseDurationMsStr) : 30000;
  const crashPoint = process.env.CRASH_POINT;

  const uow = new MikroOrmUnitOfWork();
  await uow.init();

  const outboxRepo = new MikroOrmOutboxRepository(uow);
  const queuePublisher = new SqsOutboxQueuePublisher();
  const publishUseCase = new PublishOutboxEventsUseCase(outboxRepo, queuePublisher);

  const workerId = `runner-${process.pid}`;
  const workerService = new OutboxPublisherWorkerService(publishUseCase, {
    enabled: false,
    batchSize,
    leaseDurationMs,
    workerId,
  });

  try {
    // Mode A: Process crashes right after claim in Postgres and before sending to broker
    if (crashPoint === 'AFTER_CLAIM_BEFORE_SEND') {
      const claimed = await outboxRepo.claimUnpublishedEvents(batchSize, leaseDurationMs, workerId);
      if (claimed.length > 0) {
        console.log(`MILESTONE:CLAIM_CONFIRMED:${claimed[0].id}:${claimed[0].leaseToken}`);
        // Pause indefinitely waiting for parent coordinator to kill this process
        await new Promise(() => {});
      }
      return;
    }

    // Mode B: Process crashes right after SQS confirms send and before marking published_at in Postgres
    if (crashPoint === 'AFTER_SQS_SEND_BEFORE_MARK_PUBLISHED') {
      publishUseCase.setTestHook('after_sqs_send', ({ event }) => {
        console.log(`MILESTONE:SQS_CONFIRMED:${event.id}:${event.leaseToken}`);
        // Synchronous pause so process remains alive until coordinator issues SIGKILL
        const start = Date.now();
        while (Date.now() - start < 60000) {
          // busy wait keeping process alive for kill
        }
      });
    }

    if (barrierFilePath) {
      console.log('READY');
      const startWait = Date.now();
      while (!existsSync(barrierFilePath)) {
        if (Date.now() - startWait > 15000) {
          throw new Error('Timed out waiting for synchronization barrier');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    const result = await workerService.executeBatch(batchSize, leaseDurationMs);
    console.log(JSON.stringify({ ok: true, data: result }));
  } catch (err: any) {
    console.log(JSON.stringify({ ok: false, error: err?.message, code: err?.code }));
  } finally {
    await queuePublisher.onModuleDestroy();
    await uow.close();
  }
}

main();
