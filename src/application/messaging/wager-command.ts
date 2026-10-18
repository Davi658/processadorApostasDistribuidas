import { createHash } from 'node:crypto';
import { WagerInputValidator as V } from '../validators/wager-input.validator';
import { ProcessWagerUseCase } from '../use-cases/process-wager.use-case';

export function parseWagerCommand(body: string, attributes: Record<string, string> = {}) {
  const obj: unknown = JSON.parse(body);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('INVALID_ENVELOPE');
  const e = obj as Record<string, unknown>;
  const allowed = ['version', 'commandType', 'commandId', 'idempotencyKey', 'correlationId', 'causationId', 'data'];
  if (Object.keys(e).some(k => !allowed.includes(k)) || e.version !== 1 || e.commandType !== 'ProcessWager') throw new Error('INVALID_ENVELOPE');
  const commandId = V.validateUuid(e.commandId, 'commandId');
  const correlationId = e.correlationId === undefined ? undefined : V.validateString(e.correlationId, 'correlationId', 1, 255);
  const causationId = e.causationId === undefined ? undefined : V.validateString(e.causationId, 'causationId', 1, 255);
  const { idempotencyKey, dto } = V.validateProcessWager(e.data, e.idempotencyKey, correlationId);
  if (attributes.MessageGroupId !== dto.walletId || attributes.MessageDeduplicationId !== commandId) throw new Error('INVALID_FIFO_IDENTITY');
  const financialHash = ProcessWagerUseCase.computePayloadHash(dto, idempotencyKey);
  const fingerprint = createHash('sha256').update(JSON.stringify([1, 'ProcessWager', idempotencyKey, financialHash])).digest('hex');
  return { commandId, idempotencyKey, dto, correlationId, causationId, fingerprint };
}
export type WagerCommand = ReturnType<typeof parseWagerCommand>;
