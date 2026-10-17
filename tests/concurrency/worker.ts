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

async function main() {
  const [, , idempotencyKey, payloadJson, barrierFilePath] = process.argv;

  if (!idempotencyKey || !payloadJson) {
    console.error('Usage: worker <idempotencyKey> <payloadJson> [barrierFilePath]');
    process.exit(1);
  }

  const payload: ProcessWagerDto = JSON.parse(payloadJson);

  const uow = new MikroOrmUnitOfWork();
  await uow.init();

  const walletRepo = new MikroOrmWalletRepository(uow);
  const wagerRepo = new MikroOrmWagerTransactionRepository(uow);
  const ledgerRepo = new MikroOrmWalletLedgerRepository(uow);
  const outboxRepo = new MikroOrmOutboxRepository(uow);

  const processWagerUseCase = new ProcessWagerUseCase(walletRepo, wagerRepo, ledgerRepo, outboxRepo, uow);

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

    const result = await processWagerUseCase.execute(idempotencyKey, payload);
    console.log(JSON.stringify({ ok: true, data: result }));
  } catch (err: any) {
    console.log(JSON.stringify({ ok: false, error: err.message, code: err.code }));
  } finally {
    await uow.close();
  }
}

main();
