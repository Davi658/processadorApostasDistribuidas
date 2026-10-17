import { existsSync } from 'node:fs';
import {
  MikroOrmOutboxRepository,
  MikroOrmUnitOfWork,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletLedgerRepository,
  MikroOrmWalletRepository,
} from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-adapter';
import { ReprocessPendingReferencesUseCase } from '../../src/application/use-cases/reprocess-pending-references.use-case';
import { PendingReferenceWorkerService } from '../../src/infrastructure/workers/pending-reference-worker.service';

async function main() {
  const [, , barrierFilePath, batchSizeStr, leaseDurationMsStr] = process.argv;

  const batchSize = batchSizeStr ? Number(batchSizeStr) : 10;
  const leaseDurationMs = leaseDurationMsStr ? Number(leaseDurationMsStr) : 30000;

  const uow = new MikroOrmUnitOfWork();
  await uow.init();

  const walletRepo = new MikroOrmWalletRepository(uow);
  const wagerRepo = new MikroOrmWagerTransactionRepository(uow);
  const ledgerRepo = new MikroOrmWalletLedgerRepository(uow);
  const outboxRepo = new MikroOrmOutboxRepository(uow);

  const reprocessUseCase = new ReprocessPendingReferencesUseCase(
    walletRepo,
    wagerRepo,
    ledgerRepo,
    outboxRepo,
    uow,
    5
  );

  const workerService = new PendingReferenceWorkerService(reprocessUseCase, {
    enabled: false,
    batchSize,
    leaseDurationMs,
    workerId: `runner-${process.pid}`,
  });

  try {
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
    console.log(JSON.stringify({ ok: false, error: err.message, code: err.code }));
  } finally {
    await uow.close();
  }
}

main();
