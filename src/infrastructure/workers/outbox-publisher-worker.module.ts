import { HttpObservability } from '../observability/http-observability';
import { ObservabilityModule } from '../observability/observability.module';
import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module';
import { MikroOrmOutboxRepository } from '../persistence/mikro-orm/mikro-orm-adapter';
import { SqsOutboxQueuePublisher } from '../messaging/sqs-outbox-queue-publisher.service';
import { PublishOutboxEventsUseCase } from '../../application/use-cases/publish-outbox-events.use-case';
import { OutboxPublisherWorkerService } from './outbox-publisher-worker.service';

@Module({
  imports: [PersistenceModule, ObservabilityModule],
  providers: [
    SqsOutboxQueuePublisher,
    {
      provide: PublishOutboxEventsUseCase,
      useFactory: (
        outboxRepo: MikroOrmOutboxRepository,
        queuePublisher: SqsOutboxQueuePublisher,
        telemetry: HttpObservability
      ) => {
        return new PublishOutboxEventsUseCase(outboxRepo, queuePublisher, undefined, telemetry);
      },
      inject: [MikroOrmOutboxRepository, SqsOutboxQueuePublisher, HttpObservability],
    },
    {
      provide: OutboxPublisherWorkerService,
      useFactory: (publishUseCase: PublishOutboxEventsUseCase, telemetry: HttpObservability) => {
        return new OutboxPublisherWorkerService(publishUseCase, { telemetry });
      },
      inject: [PublishOutboxEventsUseCase, HttpObservability],
    },
  ],
  exports: [
    SqsOutboxQueuePublisher,
    PublishOutboxEventsUseCase,
    OutboxPublisherWorkerService,
  ],
})
export class OutboxPublisherWorkerModule {}
