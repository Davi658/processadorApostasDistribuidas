import type { WagerCommand } from './wager-command';
import { ProcessWagerUseCase } from '../use-cases/process-wager.use-case';
import { IdempotencyConflictError, ReplaySnapshotUnavailableError } from '../../domain/errors/domain.error';
import { validateReplaySnapshot } from '../validators/snapshot.validator';
import type { UnitOfWorkPort, WagerTransactionRepositoryPort } from '../ports/ports';

export interface InboxPort {
  lock(consumer: string, commandId: string): Promise<void>;
  find(consumer: string, commandId: string): Promise<{ fingerprint: string; transaction_id: string } | undefined>;
  accept(consumer: string, command: WagerCommand, transactionId: string, messageId: string): Promise<void>;
}
export class ConsumeWagerCommand {
  static readonly consumerName = 'wager-command-v1';
  constructor(private readonly uow: UnitOfWorkPort, private readonly inbox: InboxPort,
    private readonly wagers: WagerTransactionRepositoryPort, private readonly process: ProcessWagerUseCase) {}
  async execute(command: WagerCommand, messageId: string) {
    // Errors escape the external UoW. Redelivery reconciles in a healthy context,
    // including collisions and commits whose acknowledgement was lost.
    return this.uow.runInTransaction(async () => {
      const consumer = ConsumeWagerCommand.consumerName;
      await this.inbox.lock(consumer, command.commandId);
      const accepted = await this.inbox.find(consumer, command.commandId);
      if (accepted) {
        if (accepted.fingerprint !== command.fingerprint) throw new IdempotencyConflictError('COMMAND_CONTENT_CONFLICT');
        const tx = await this.wagers.findById(accepted.transaction_id, true);
        if (!tx || tx.idempotencyKey !== command.idempotencyKey || tx.payloadHash !== ProcessWagerUseCase.computePayloadHash(command.dto, command.idempotencyKey)) throw new ReplaySnapshotUnavailableError();
        return validateReplaySnapshot(tx.responseSnapshot, tx);
      }
      const result = await this.process.execute(command.idempotencyKey, command.dto, { externalTransaction: true });
      await this.inbox.accept(consumer, command, result.transactionId, messageId);
      return result;
    });
  }
}
