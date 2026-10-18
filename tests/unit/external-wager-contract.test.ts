import { expect, test } from 'bun:test';
import { parseWagerCommand } from '../../src/application/messaging/wager-command';
import { ProcessWagerUseCase } from '../../src/application/use-cases/process-wager.use-case';
export const externalExample = {
  messageId: 'msg-123', type: 'WagerTransactionRequested', occurredAt: '2026-07-29T15:00:00.000Z',
  data: { providerId: 'provider-a', externalTransactionId: 'transaction-123', idempotencyKey: 'provider-a:transaction-123',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1', walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-987', gameId: 'fortune-chimp', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } },
};
test('challenge example accepts opaque messageId and takes financial key only from data', () => {
  const parsed = parseWagerCommand(JSON.stringify(externalExample));
  expect(parsed.commandId).toBe('msg-123');
  expect(parsed.consumerName).toBe('wager-transaction-requested-v1');
  expect(parsed.idempotencyKey).toBe('provider-a:transaction-123');
  expect(parsed.dto).not.toHaveProperty('idempotencyKey');
  const { idempotencyKey, ...business } = externalExample.data;
  expect(ProcessWagerUseCase.computePayloadHash(parsed.dto, parsed.idempotencyKey)).toBe(ProcessWagerUseCase.computePayloadHash(business as any, idempotencyKey));
  const changedMetadata = parseWagerCommand(JSON.stringify({ ...externalExample, messageId: 'msg-other', occurredAt: '2026-08-01T00:00:00.000Z' }));
  expect(changedMetadata.fingerprint).toBe(parsed.fingerprint);
});
test('external payload cannot obtain financial identity from transport or envelope messageId', () => {
  const { idempotencyKey, ...data } = externalExample.data;
  expect(() => parseWagerCommand(JSON.stringify({ ...externalExample, data }))).toThrow();
  for (const patch of [{ messageId: '' }, { occurredAt: 'invalid' }, { version: 1 }, { data: { ...data, idempotencyKey, money: { amount: 25, currency: 'BRL' } } }]) {
    expect(() => parseWagerCommand(JSON.stringify({ ...externalExample, ...patch }))).toThrow();
  }
});
