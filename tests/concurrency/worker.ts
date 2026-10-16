import pg from 'pg';
import {
  PostgresOutboxRepository,
  PostgresUnitOfWork,
  PostgresWagerTransactionRepository,
  PostgresWalletLedgerRepository,
  PostgresWalletRepository,
} from '../../src/infrastructure/persistence/postgres/postgres-adapter';
import { ProcessBetUseCase } from '../../src/application/use-cases/process-bet.use-case';
import { ProcessBetDto } from '../../src/application/dto/wager.dto';

async function main() {
  const [,, idempotencyKey, payloadJson] = process.argv;

  if (!idempotencyKey || !payloadJson) {
    console.error('Usage: bun run worker.ts <idempotencyKey> <payloadJson>');
    process.exit(1);
  }

  const payload: ProcessBetDto = JSON.parse(payloadJson);

  const pool = new pg.Pool({
    host: process.env.APP_DB_HOST || '127.0.0.1',
    port: Number(process.env.APP_DB_PORT) || 5432,
    database: process.env.APP_DB_NAME || 'betting_db',
    user: process.env.APP_DB_USER || 'app_user',
    password: process.env.APP_DB_PASSWORD || 'app_user_secret',
    max: 10,
  });

  const uow = new PostgresUnitOfWork(pool);
  const walletRepo = new PostgresWalletRepository(uow);
  const wagerRepo = new PostgresWagerTransactionRepository(uow);
  const ledgerRepo = new PostgresWalletLedgerRepository(uow);
  const outboxRepo = new PostgresOutboxRepository(uow);

  const processBetUseCase = new ProcessBetUseCase(walletRepo, wagerRepo, ledgerRepo, outboxRepo, uow);

  try {
    const result = await processBetUseCase.execute(idempotencyKey, payload);
    console.log(JSON.stringify({ ok: true, data: result }));
  } catch (err: any) {
    console.log(JSON.stringify({ ok: false, error: err.message, code: err.code }));
  } finally {
    await pool.end();
  }
}

main();
