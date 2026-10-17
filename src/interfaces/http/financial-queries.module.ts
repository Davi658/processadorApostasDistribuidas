import { Module, type OnApplicationShutdown } from '@nestjs/common';
import pg from 'pg';
import { FinancialQueriesPort } from '../../application/ports/financial-queries.port';
import { getAppDatabaseConfig } from '../../infrastructure/config/database.config';
import { PostgresFinancialQueries } from '../../infrastructure/persistence/postgres/financial-queries';
import { FinancialQueriesController } from './controllers/financial-queries.controller';

class ManagedFinancialQueries extends PostgresFinancialQueries implements OnApplicationShutdown {
  constructor(private readonly ownedPool: pg.Pool) { super(ownedPool); }
  async onApplicationShutdown() { await this.ownedPool.end(); }
}

@Module({
  controllers: [FinancialQueriesController],
  providers: [{
    provide: FinancialQueriesPort,
    useFactory: () => new ManagedFinancialQueries(new pg.Pool({
      ...getAppDatabaseConfig(),
      options: '-c default_transaction_read_only=on',
    })),
  }],
})
export class FinancialQueriesModule {}
