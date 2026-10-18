import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroOrmUnitOfWork, MikroOrmWalletRepository, MikroOrmWagerTransactionRepository, MikroOrmWalletLedgerRepository, MikroOrmOutboxRepository, type FailureHookPoint } from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-adapter';
import { MikroOrmInboxRepository } from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-inbox-repository';
import { ConsumeWagerCommand } from '../../src/application/messaging/consume-wager-command';
import { ProcessWagerUseCase } from '../../src/application/use-cases/process-wager.use-case';
import { SqsWagerConsumer } from '../../src/infrastructure/messaging/sqs-wager-consumer.service';
const uow = new MikroOrmUnitOfWork(); await uow.init();
const wagers = new MikroOrmWagerTransactionRepository(uow);
const consume = new ConsumeWagerCommand(uow, new MikroOrmInboxRepository(uow), wagers,
  new ProcessWagerUseCase(new MikroOrmWalletRepository(uow), wagers, new MikroOrmWalletLedgerRepository(uow), new MikroOrmOutboxRepository(uow), uow));
const execute = consume.execute.bind(consume);
consume.execute = (command, messageId, signal) => {
  signal?.addEventListener('abort', () => console.log('CANCEL_REQUESTED'), { once: true });
  return execute(command, messageId, signal);
};
const sqs = new SQSClient({ endpoint: process.env.SQS_ENDPOINT, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
const consumer = new SqsWagerConsumer(consume, { client: sqs, queueUrl: process.env.M16_QUEUE, visibilitySeconds: 3, renewalMs: 400, requestTimeoutMs: 1500, drainTimeoutMs: 50, retryBaseSeconds: 1, retryMaxSeconds: 1 });
uow.setTestHook(process.env.M16_CUT as FailureHookPoint, async () => {
  console.log('BARRIER'); await new Promise<void>(r => process.stdin.once('data', () => r()));
});
const drain = consumer.onModuleDestroy.bind(consumer);
consumer.onModuleDestroy = async () => { console.log('STOPPING'); await drain(); console.log('DRAINED'); };
const close = uow.onApplicationShutdown.bind(uow);
uow.onApplicationShutdown = async () => {
  if (uow.getActiveTransactionsCount()) throw new Error('CLOSE_BEFORE_TERMINATION');
  await close(); sqs.destroy(); console.log('CLOSED'); process.stdin.destroy();
};
@Module({ providers: [{ provide: MikroOrmUnitOfWork, useValue: uow }, { provide: SqsWagerConsumer, useValue: consumer }] })
class TestModule {}
const app = await NestFactory.createApplicationContext(TestModule, { logger: false });
app.enableShutdownHooks(['SIGTERM']);
await consumer.processMessage(JSON.parse(process.env.M16_DELIVERY!));
console.log('WORK_ENDED');
