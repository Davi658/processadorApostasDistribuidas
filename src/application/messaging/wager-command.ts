import { createHash } from 'node:crypto';
import { WagerInputValidator as V } from '../validators/wager-input.validator';
import { ProcessWagerUseCase } from '../use-cases/process-wager.use-case';

export function parseWagerCommand(body: string, attributes: Record<string, string> = {}) {
  const obj: unknown = JSON.parse(body);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('INVALID_ENVELOPE');
  const e = obj as Record<string, unknown>;
  if (e.type === 'WagerTransactionRequested') {
    const allowed = ['messageId', 'type', 'occurredAt', 'data'];
    if (Object.keys(e).some(k => !allowed.includes(k))) throw new Error('INVALID_ENVELOPE');
    const commandId = V.validateString(e.messageId, 'messageId', 1, 255);
    // An ISO timestamp is metadata, never financial identity or ordering authority.
    if (typeof e.occurredAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(e.occurredAt)
      || !Number.isFinite(Date.parse(e.occurredAt)) || new Date(e.occurredAt).toISOString() !== e.occurredAt) throw new Error('INVALID_OCCURRED_AT');
    if (!e.data || typeof e.data !== 'object' || Array.isArray(e.data)) throw new Error('INVALID_ENVELOPE');
    const { idempotencyKey: key, ...business } = e.data as Record<string, unknown>;
    const { idempotencyKey, dto } = V.validateProcessWager(business, key);
    // The challenge does not prescribe FIFO attributes. They are transport hints;
    // persistent inbox and financial uniqueness remain authoritative.
    const financialHash = ProcessWagerUseCase.computePayloadHash(dto, idempotencyKey);
    const fingerprint = createHash('sha256').update(JSON.stringify(['WagerTransactionRequested', idempotencyKey, financialHash])).digest('hex');
    return { commandId, idempotencyKey, dto, correlationId: undefined, causationId: undefined, fingerprint,
      consumerName: 'wager-transaction-requested-v1' };
  }
  const allowed = ['version', 'commandType', 'commandId', 'idempotencyKey', 'correlationId', 'causationId', 'data'];
  if (Object.keys(e).some(k => !allowed.includes(k)) || e.version !== 1 || e.commandType !== 'ProcessWager') throw new Error('INVALID_ENVELOPE');
  const commandId = V.validateUuid(e.commandId, 'commandId');
  const correlationId = e.correlationId === undefined ? undefined : V.validateString(e.correlationId, 'correlationId', 1, 255);
  const causationId = e.causationId === undefined ? undefined : V.validateString(e.causationId, 'causationId', 1, 255);
  const { idempotencyKey, dto } = V.validateProcessWager(e.data, e.idempotencyKey, correlationId);
  if (attributes.MessageGroupId !== dto.walletId || attributes.MessageDeduplicationId !== commandId) throw new Error('INVALID_FIFO_IDENTITY');
  const financialHash = ProcessWagerUseCase.computePayloadHash(dto, idempotencyKey);
  const fingerprint = createHash('sha256').update(JSON.stringify([1, 'ProcessWager', idempotencyKey, financialHash])).digest('hex');
  return { commandId, idempotencyKey, dto, correlationId, causationId, fingerprint, consumerName: 'wager-command-v1' };
}
export type WagerCommand = ReturnType<typeof parseWagerCommand>;
