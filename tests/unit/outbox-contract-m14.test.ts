import { describe, it, expect } from 'bun:test';
import { validateOutboxContract } from '../../src/application/validation/outbox-contract';
import { PublishOutboxEventsUseCase } from '../../src/application/use-cases/publish-outbox-events.use-case';
import { SqsOutboxQueuePublisher } from '../../src/infrastructure/messaging/sqs-outbox-queue-publisher.service';
import type { ClaimedOutboxMessage } from '../../src/application/ports/ports';
const money = { amount: '1.00', currency: 'BRL' };
const base = (): ClaimedOutboxMessage => ({ id: crypto.randomUUID(), aggregateType: 'Wallet', aggregateId: 'wallet',
  eventType: 'WalletBalanceChanged', version: 1, occurredAt: new Date().toISOString(), correlationId: 'corr', causationId: null,
  payload: { walletId: 'wallet', playerId: 'player', currency: 'BRL', previousBalance: money, currentBalance: money, version: 1, triggerTransactionId: 'tx' },
  leaseToken: 'lease', leaseOwner: 'owner', leaseExpiresAt: new Date().toISOString(), attempts: 0 });

describe('M14 domain contract validation', () => {
  it('accepts four actual v1 contracts without mutating the envelope', () => {
    const event = base();
    const transaction = { walletId: 'wallet', playerId: 'player', transactionId: 'tx', providerId: 'provider', externalTransactionId: 'external',
      roundId: 'round', gameId: 'game', kind: 'BET', amount: money, balance: money };
    for (const [type, payload] of [ ['WalletBalanceChanged', event.payload], ['WagerTransactionProcessed', transaction],
      ['WagerTransactionRejected', { ...transaction, failureCode: 'INSUFFICIENT_FUNDS' }],
      ['WagerTransactionPendingReference', { ...transaction, kind: 'REFUND', referenceExternalTransactionId: 'reference', attempts: 0, nextAttemptAt: event.occurredAt }] ] as const) {
      const e = { ...event, eventType: type, payload };
      const before = JSON.stringify(e);
      expect(validateOutboxContract(e).valid).toBe(true);
      expect(JSON.stringify(e)).toBe(before);
    }
  });
  const mutations: [string, (e: any) => void][] = [
    ['unknown type', e => e.eventType = 'FutureEvent'], ['unknown version', e => e.version = 2],
    ['missing payload', e => e.payload = undefined], ['null payload', e => e.payload = null],
    ['array', e => e.payload = []], ['empty', e => e.payload = {}],
    ['identity', e => e.payload.walletId = 'other'], ['player', e => delete e.payload.playerId],
    ['currency', e => e.payload.currentBalance = { amount: '1.00', currency: 'brl' }],
    ['mismatch', e => e.payload.currentBalance = { amount: '1.00', currency: 'USD' }],
    ['numeric money', e => e.payload.currentBalance = { amount: 1, currency: 'BRL' }],
    ['scale', e => e.payload.currentBalance = { amount: '1.0', currency: 'BRL' }],
    ['negative', e => e.payload.currentBalance = { amount: '-1.00', currency: 'BRL' }],
    ['overflow', e => e.payload.currentBalance = { amount: '10000000000000000.00', currency: 'BRL' }],
    ['metadata', e => e.aggregateType = 'Transaction'], ['correlation', e => e.correlationId = ''],
    ['causation', e => e.causationId = 42], ['timestamp', e => e.occurredAt = 'bad'],
    ['balance version', e => e.payload.version = 0], ['transaction identity', e => delete e.payload.triggerTransactionId],
  ];
  for (const [label, mutate] of mutations) it(`blocks ${label}`, () => {
    const e = base(); mutate(e); expect(validateOutboxContract(e).valid).toBe(false);
  });
  it('counts blocked only after persistence confirms authority', async () => {
    const invalid = { ...base(), payload: undefined };
    for (const authorized of [true, false]) {
      const useCase = new PublishOutboxEventsUseCase({ claimUnpublishedEvents: async () => [invalid], markOperationallyBlocked: async () => authorized } as any,
        { publish: async () => { throw Error('must not send'); } });
      const result = await useCase.execute();
      expect(result.blocked).toBe(authorized ? 1 : 0);
      expect(result.staleLease).toBe(authorized ? 0 : 1);
    }
  });
  it('does not destroy a third-party client', async () => {
    let destroyed = false;
    const publisher = new SqsOutboxQueuePublisher({ sqsClient: { destroy: () => { destroyed = true; } } as any });
    await publisher.beforeApplicationShutdown(); expect(destroyed).toBe(false);
  });
});
