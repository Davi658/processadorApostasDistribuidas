import { ObservabilityModule } from '../../infrastructure/observability/observability.module';
import { SqsOutboxQueuePublisher } from '../../infrastructure/messaging/sqs-outbox-queue-publisher.service';
import { HttpObservability } from '../../infrastructure/observability/http-observability';
import { ObservabilityController, PostgresReadiness } from '../../infrastructure/observability/observability.controller';
import { ConsumeWagerCommand } from '../../application/messaging/consume-wager-command';
import { MikroOrmInboxRepository } from '../../infrastructure/persistence/mikro-orm/mikro-orm-inbox-repository';
import { SqsWagerConsumer } from '../../infrastructure/messaging/sqs-wager-consumer.service';
import { PersistenceModule } from '../../infrastructure/persistence/persistence.module';
import { WageringQueryModule } from './wagering-query.module';
import { MiddlewareConsumer, NestModule, Module, Optional } from '@nestjs/common';
import {
  MikroOrmOutboxRepository,
  MikroOrmUnitOfWork,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletLedgerRepository,
  MikroOrmWalletRepository,
} from '../../infrastructure/persistence/mikro-orm/mikro-orm-adapter';
import { CreateWalletUseCase } from '../../application/use-cases/create-wallet.use-case';
import { GetWalletUseCase } from '../../application/use-cases/get-wallet.use-case';
import { ProcessWagerUseCase } from '../../application/use-cases/process-wager.use-case';
import { ProcessBetUseCase } from '../../application/use-cases/process-bet.use-case';
import { ReconcileWalletUseCase } from '../../application/use-cases/reconcile-wallet.use-case';
import { ReprocessPendingReferencesUseCase } from '../../application/use-cases/reprocess-pending-references.use-case';
import { PendingReferenceWorkerService } from '../../infrastructure/workers/pending-reference-worker.service';
import { WalletController } from './controllers/wallet.controller';
import { WageringController } from './controllers/wagering.controller';
import { OutboxPublisherWorkerModule } from '../../infrastructure/workers/outbox-publisher-worker.module';

@Module({
  imports: [ObservabilityModule, PersistenceModule, WageringQueryModule, OutboxPublisherWorkerModule],
  controllers: [WalletController, WageringController, ObservabilityController],
  providers: [
    { provide: PostgresReadiness, useFactory: (uow: MikroOrmUnitOfWork, publisher: SqsOutboxQueuePublisher, consumer: SqsWagerConsumer) =>
      new PostgresReadiness(uow, 500, [() => publisher.checkReadiness(), () => consumer.checkReadiness()]),
      inject: [MikroOrmUnitOfWork, SqsOutboxQueuePublisher, SqsWagerConsumer] },
    {
      provide: SqsWagerConsumer,
      useFactory: (uow: MikroOrmUnitOfWork, wagers: MikroOrmWagerTransactionRepository, process: ProcessWagerUseCase, telemetry: HttpObservability) =>
        new SqsWagerConsumer(new ConsumeWagerCommand(uow, new MikroOrmInboxRepository(uow), wagers, process), { telemetry }),
      inject: [MikroOrmUnitOfWork, MikroOrmWagerTransactionRepository, ProcessWagerUseCase, HttpObservability],
    },
    {
      provide: CreateWalletUseCase,
      useFactory: (
        walletRepo: MikroOrmWalletRepository,
        wagerRepo: MikroOrmWagerTransactionRepository,
        ledgerRepo: MikroOrmWalletLedgerRepository,
        outboxRepo: MikroOrmOutboxRepository,
        uow: MikroOrmUnitOfWork
      ) => new CreateWalletUseCase(walletRepo, wagerRepo, ledgerRepo, outboxRepo, uow),
      inject: [
        MikroOrmWalletRepository,
        MikroOrmWagerTransactionRepository,
        MikroOrmWalletLedgerRepository,
        MikroOrmOutboxRepository,
        MikroOrmUnitOfWork,
      ],
    },
    {
      provide: GetWalletUseCase,
      useFactory: (walletRepo: MikroOrmWalletRepository) => new GetWalletUseCase(walletRepo),
      inject: [MikroOrmWalletRepository],
    },
    {
      provide: ProcessWagerUseCase,
      useFactory: (
        walletRepo: MikroOrmWalletRepository,
        wagerRepo: MikroOrmWagerTransactionRepository,
        ledgerRepo: MikroOrmWalletLedgerRepository,
        outboxRepo: MikroOrmOutboxRepository,
        uow: MikroOrmUnitOfWork,
        telemetry: HttpObservability
      ) => new ProcessWagerUseCase(walletRepo, wagerRepo, ledgerRepo, outboxRepo, uow, undefined, undefined, telemetry),
      inject: [
        MikroOrmWalletRepository,
        MikroOrmWagerTransactionRepository,
        MikroOrmWalletLedgerRepository,
        MikroOrmOutboxRepository,
        MikroOrmUnitOfWork,
        HttpObservability,
      ],
    },
    {
      provide: ProcessBetUseCase,
      useFactory: (
        walletRepo: MikroOrmWalletRepository,
        wagerRepo: MikroOrmWagerTransactionRepository,
        ledgerRepo: MikroOrmWalletLedgerRepository,
        outboxRepo: MikroOrmOutboxRepository,
        uow: MikroOrmUnitOfWork,
        telemetry: HttpObservability
      ) => new ProcessBetUseCase(walletRepo, wagerRepo, ledgerRepo, outboxRepo, uow, undefined, undefined, telemetry),
      inject: [
        MikroOrmWalletRepository,
        MikroOrmWagerTransactionRepository,
        MikroOrmWalletLedgerRepository,
        MikroOrmOutboxRepository,
        MikroOrmUnitOfWork,
        HttpObservability,
      ],
    },
    {
      provide: ReconcileWalletUseCase,
      useFactory: (
        walletRepo: MikroOrmWalletRepository,
        ledgerRepo: MikroOrmWalletLedgerRepository,
        uow: MikroOrmUnitOfWork
      ) => new ReconcileWalletUseCase(walletRepo, ledgerRepo, uow),
      inject: [MikroOrmWalletRepository, MikroOrmWalletLedgerRepository, MikroOrmUnitOfWork],
    },
    {
      provide: ReprocessPendingReferencesUseCase,
      useFactory: (
        walletRepo: MikroOrmWalletRepository,
        wagerRepo: MikroOrmWagerTransactionRepository,
        ledgerRepo: MikroOrmWalletLedgerRepository,
        outboxRepo: MikroOrmOutboxRepository,
        uow: MikroOrmUnitOfWork,
        telemetry: HttpObservability
      ) => new ReprocessPendingReferencesUseCase(walletRepo, wagerRepo, ledgerRepo, outboxRepo, uow, 5, undefined, undefined, telemetry),
      inject: [
        MikroOrmWalletRepository,
        MikroOrmWagerTransactionRepository,
        MikroOrmWalletLedgerRepository,
        MikroOrmOutboxRepository,
        MikroOrmUnitOfWork,
        HttpObservability,
      ],
    },
    {
      provide: PendingReferenceWorkerService,
      useFactory: (reprocessUseCase: ReprocessPendingReferencesUseCase, telemetry: HttpObservability) => {
        return new PendingReferenceWorkerService(reprocessUseCase, { telemetry });
      },
      inject: [ReprocessPendingReferencesUseCase, HttpObservability],
    },
  ],
})
export class AppModule implements NestModule {
  constructor(
    private readonly http: HttpObservability,
    @Optional() private readonly uow?: MikroOrmUnitOfWork,
    @Optional() private readonly consumer?: SqsWagerConsumer
  ) {
    if (this.consumer) {
      this.http.registerCollector(async () => {
        await this.consumer?.probeDlqMetrics();
      });
    }

    if (this.uow) {
      this.http.registerCollector(async () => {
        try {
          const knex = this.uow?.getOrm().em.getConnection().getKnex();
          if (!knex) return;
          const financial = await knex.raw('SELECT kind, status, COUNT(*)::int AS count FROM wager_transactions GROUP BY kind, status').timeout(500, { cancel: true });
          this.http.recordPersistedFinancial(financial.rows);
          const result = await knex.raw(`
            SELECT 
              COALESCE(EXTRACT(EPOCH FROM (now() - min(occurred_at))), 0)::float AS oldest_age,
              COUNT(*)::int AS pending_count
            FROM outbox_messages
            WHERE published_at IS NULL AND is_operationally_blocked = false
          `).timeout(500, { cancel: true });
          const row = result?.rows?.[0];
          if (row) {
            this.http.recordOutboxLag(
              Number(row.oldest_age ?? 0),
              Number(row.pending_count ?? 0)
            );
          }
        } catch {
          /* Metric probe must not fail scrape */
        }
      });
    }
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(this.http.middleware).forRoutes('{*path}');
  }
}
