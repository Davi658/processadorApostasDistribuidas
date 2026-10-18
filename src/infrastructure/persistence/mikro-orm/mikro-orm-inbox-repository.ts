import { MikroOrmUnitOfWork } from './mikro-orm-adapter';
import { TransactionRequiredError } from '../../../domain/errors/domain.error';
import type { WagerCommand } from '../../../application/messaging/wager-command';

export class MikroOrmInboxRepository {
  constructor(private readonly uow: MikroOrmUnitOfWork) {}
  private get em() {
    if (!this.uow.isTransactionActive()) throw new TransactionRequiredError('Inbox requires external UoW');
    return this.uow.getEntityManager();
  }
  async lock(consumer: string, commandId: string): Promise<void> {
    // Transaction-scoped logical identity lock; collisions only serialize extra work.
    await this.em.execute('select pg_advisory_xact_lock(hashtextextended(?, 0))', [JSON.stringify([consumer, commandId])]);
  }
  async find(consumer: string, commandId: string): Promise<{ fingerprint: string; transaction_id: string } | undefined> {
    const rows = await this.em.execute<{ fingerprint: string; transaction_id: string }[]>('select fingerprint, transaction_id from command_inbox where consumer_name = ? and command_id = ?', [consumer, commandId]);
    return rows[0];
  }
  async accept(consumer: string, command: WagerCommand, transactionId: string, messageId: string): Promise<void> {
    await this.em.execute(`insert into command_inbox
      (consumer_name, command_id, fingerprint, transaction_id, message_id, correlation_id, causation_id)
      values (?, ?, ?, ?, ?, ?, ?)`, [consumer, command.commandId, command.fingerprint, transactionId, messageId, command.correlationId ?? null, command.causationId ?? null]);
    await this.uow.triggerTestHook('after_inbox_save');
  }
}
