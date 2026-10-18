import { existsSync } from 'node:fs';
import {
  MikroOrmOutboxRepository,
  MikroOrmUnitOfWork,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletLedgerRepository,
  MikroOrmWalletRepository,
} from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-adapter';
import { ProcessWagerUseCase } from '../../src/application/use-cases/process-wager.use-case';
import { ProcessWagerDto } from '../../src/application/dto/wager.dto';
import ormConfig from '../../src/infrastructure/persistence/mikro-orm/mikro-orm.config';

async function main() {
  const [, , idempotencyKey, payloadJson, barrierFilePath] = process.argv;

  if (!idempotencyKey || !payloadJson) {
    console.error('Usage: worker <idempotencyKey> <payloadJson> [barrierFilePath]');
    process.exit(1);
  }

  const payload: ProcessWagerDto = JSON.parse(payloadJson);

  const uow = new MikroOrmUnitOfWork({ ...ormConfig, pool: { min: 0, max: 10, acquireTimeoutMillis: 10000 } });
  await uow.init();

  const walletRepo = new MikroOrmWalletRepository(uow);
  const wagerRepo = new MikroOrmWagerTransactionRepository(uow);
  const ledgerRepo = new MikroOrmWalletLedgerRepository(uow);
  const outboxRepo = new MikroOrmOutboxRepository(uow);

  const processWagerUseCase = new ProcessWagerUseCase(walletRepo, wagerRepo, ledgerRepo, outboxRepo, uow);
  if (process.env.WORKER_COMMIT_BARRIER) uow.setTestHook('after_wallet_save', async () => {
    console.log('LOCKED');
    const deadline = Date.now() + 15000;
    while (!existsSync(process.env.WORKER_COMMIT_BARRIER!)) {
      if (Date.now() > deadline) throw new Error('COMMIT_BARRIER_TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  });

  try {
    // If a synchronization barrier file is provided, announce READY and wait until released
    if (barrierFilePath) {
      // Announce readiness to the test coordinator
      console.log('READY');

      const startWait = Date.now();
      while (!existsSync(barrierFilePath)) {
        if (Date.now() - startWait > 15000) {
          throw new Error('Timed out waiting for synchronization barrier');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    const count = Number(process.env.WORKER_SUBMISSIONS ?? 1);
    if (!Number.isSafeInteger(count) || count < 1 || count > 50) throw new Error('INVALID_SUBMISSIONS');
    const results = await Promise.all(Array.from({ length: count }, () => processWagerUseCase.execute(idempotencyKey, payload)));
    console.log(JSON.stringify({ ok: true, data: results[0], results }));
  } catch (err: any) {
    console.log(JSON.stringify({ ok: false, error: err.message, code: err.code }));
  } finally {
    await uow.close();
  }
}

main();
