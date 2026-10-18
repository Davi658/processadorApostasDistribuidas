import { MikroOrmUnitOfWork, MikroOrmWalletRepository, MikroOrmWagerTransactionRepository, MikroOrmWalletLedgerRepository, MikroOrmOutboxRepository, type FailureHookPoint } from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-adapter';
import { MikroOrmInboxRepository } from '../../src/infrastructure/persistence/mikro-orm/mikro-orm-inbox-repository';
import { ConsumeWagerCommand } from '../../src/application/messaging/consume-wager-command';
import { parseWagerCommand } from '../../src/application/messaging/wager-command';
import { ProcessWagerUseCase } from '../../src/application/use-cases/process-wager.use-case';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/interfaces/http/app.module';
import { DomainExceptionFilter } from '../../src/interfaces/http/filters/domain-exception.filter';
const e = JSON.parse(process.env.M15_COMMAND!);
const uow = new MikroOrmUnitOfWork(); await uow.init();
const wagers = new MikroOrmWagerTransactionRepository(uow);
const processWager = new ProcessWagerUseCase(new MikroOrmWalletRepository(uow), wagers, new MikroOrmWalletLedgerRepository(uow), new MikroOrmOutboxRepository(uow), uow);
const httpApp = process.env.M15_HTTP === '1' ? await NestFactory.create(AppModule, { logger: false }) : undefined;
if (httpApp) { httpApp.useGlobalFilters(new DomainExceptionFilter()); await httpApp.listen(0, '127.0.0.1'); }
if (process.env.M15_RACE === '1') (httpApp?.get(MikroOrmUnitOfWork) ?? uow).setTestHook('after_wallet_save', async () => {
  console.log('RACE_BARRIER'); await new Promise<void>(resolve => process.stdin.once('data', () => resolve()));
});
if (process.env.M15_CUT) uow.setTestHook(process.env.M15_CUT as FailureHookPoint, async () => { console.log('BARRIER'); await new Promise(() => {}); });
console.log('READY');
await new Promise<void>(resolve => process.stdin.once('data', () => resolve()));
try {
  let result;
  if (httpApp) {
    const response = await fetch(`${await httpApp.getUrl()}/wagering/transactions`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': e.idempotencyKey }, body: JSON.stringify(e.data),
    });
    if (![200, 202, 422, 409].includes(response.status)) throw new Error('HTTP_RACE_FAILED');
    result = await response.json();
  }
  else result = await new ConsumeWagerCommand(uow, new MikroOrmInboxRepository(uow), wagers, processWager).execute(parseWagerCommand(JSON.stringify(e), { MessageGroupId: e.data.walletId, MessageDeduplicationId: e.commandId }), 'child-process');
  console.log('RESULT ' + JSON.stringify(result));
} catch { console.log('RETRY'); }
await httpApp?.close(); await uow.close(); process.stdin.destroy();
