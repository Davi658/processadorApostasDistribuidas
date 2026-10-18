import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module';
import { MikroOrmOutboxRepository } from '../persistence/mikro-orm/mikro-orm-adapter';
import { SqsOutboxQueuePublisher } from '../messaging/sqs-outbox-queue-publisher.service';
import { PublishOutboxEventsUseCase } from '../../application/use-cases/publish-outbox-events.use-case';
import { OutboxPublisherWorkerService } from './outbox-publisher-worker.service';

@Module({
  imports: [PersistenceModule],
  providers: [
    SqsOutboxQueuePublisher,
    {
      provide: PublishOutboxEventsUseCase,
      useFactory: (
        outboxRepo: MikroOrmOutboxRepository,
        queuePublisher: SqsOutboxQueuePublisher
      ) => {
        return new PublishOutboxEventsUseCase(outboxRepo, queuePublisher);
      },
      inject: [MikroOrmOutboxRepository, SqsOutboxQueuePublisher],
    },
    {
      provide: OutboxPublisherWorkerService,
      useFactory: (publishUseCase: PublishOutboxEventsUseCase) => {
        return new OutboxPublisherWorkerService(publishUseCase);
      },
      inject: [PublishOutboxEventsUseCase],
    },
  ],
  exports: [
    SqsOutboxQueuePublisher,
    PublishOutboxEventsUseCase,
    OutboxPublisherWorkerService,
  ],
})
export class OutboxPublisherWorkerModule {}
