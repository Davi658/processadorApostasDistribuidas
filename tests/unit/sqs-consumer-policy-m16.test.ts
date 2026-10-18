import { expect, test } from 'bun:test';
import { SqsWagerConsumer, classifyConsumerFailure } from '../../src/infrastructure/messaging/sqs-wager-consumer.service';
import { TransactionRollbackOnlyError, IdempotencyConflictError, ReplaySnapshotUnavailableError, InvalidWagerOperationError, CurrencyMismatchError } from '../../src/domain/errors/domain.error';
import type { ConsumeWagerCommand } from '../../src/application/messaging/consume-wager-command';
test('M16 classifies nested SQL cancellation independently from durable business rejection', () => {
  expect(classifyConsumerFailure(new TransactionRollbackOnlyError('rollback', { driverException: { code: '55P03' } }))).toBe('TRANSIENT');
  expect(classifyConsumerFailure(new IdempotencyConflictError('conflict'))).toBe('PERMANENT');
  expect(classifyConsumerFailure(new ReplaySnapshotUnavailableError())).toBe('PERMANENT');
  expect(classifyConsumerFailure(new InvalidWagerOperationError('player mismatch'))).toBe('PERMANENT');
  expect(classifyConsumerFailure(new CurrencyMismatchError('currency mismatch'))).toBe('PERMANENT');
  const cyclic: { cause?: unknown } = {}; cyclic.cause = cyclic;
  expect(classifyConsumerFailure(cyclic)).toBe('UNKNOWN');
  expect(classifyConsumerFailure(new Error('COMMIT_CONFIRMATION_LOST'))).toBe('UNKNOWN');
});
test('M16 rejects visibility/network timing with no renewal margin and out-of-range SQS limits', () => {
  const consume = {} as ConsumeWagerCommand;
  expect(() => new SqsWagerConsumer(consume, { visibilitySeconds: 5, renewalMs: 1000, requestTimeoutMs: 5000 })).toThrow('INVALID_CONSUMER_TIMING');
  expect(() => new SqsWagerConsumer(consume, { visibilitySeconds: 43201 })).toThrow('INVALID_CONSUMER_TIMING');
  expect(() => new SqsWagerConsumer(consume, { retryMaxSeconds: 43201 })).toThrow('INVALID_CONSUMER_TIMING');
});
