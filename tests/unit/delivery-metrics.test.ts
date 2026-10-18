import { expect, test } from 'bun:test';
import { HttpObservability } from '../../src/infrastructure/observability/http-observability';

test('bounded financial categories; invocation metrics never claim durable transactions', async () => {
  const metrics = new HttpObservability(() => {});
  for (let i = 0; i < 100; i++) metrics.recordFinancialTransaction(`kind-${i}`, `status-${i}`, 0.01);
  const text = await metrics.render();
  expect(text).toContain('financial_invocations_total{status="UNKNOWN",kind="UNKNOWN"} 100');
  expect(text).not.toContain('kind-');
  expect(text).not.toContain('financial_transactions_total');
  expect(text).toContain('excludes external commit and SQS delete');
  expect(text).not.toContain('sqs_dlq_messages_total');
  // Unknown collection state must not masquerade as an observed empty DLQ.
  expect(text).not.toContain('sqs_dlq_messages_visible{');
  metrics.recordPersistedFinancial([{ kind: 'BET', status: 'PROCESSED', count: 1 }, { kind: 'untrusted', status: 'untrusted', count: 2 }]);
  const durable = await metrics.render();
  expect(durable).toContain('# TYPE financial_transactions gauge');
  expect(durable).toContain('financial_transactions{status="PROCESSED",kind="BET"} 1');
  expect(durable).toContain('financial_transactions{status="UNKNOWN",kind="UNKNOWN"} 2');
});

test('outbox publication samples cannot overwrite database backlog gauges', async () => {
  const metrics = new HttpObservability(() => {});
  metrics.recordOutboxLag(90, 42);
  metrics.recordOutboxPublishLag(10);
  metrics.recordDlqStats('exclusive.fifo', 3);
  const text = await metrics.render();
  expect(text).toContain('outbox_delay_seconds 90.000');
  expect(text).toContain('outbox_pending_events 42');
  expect(text).toContain('outbox_publish_lag_seconds_sum 10');
  expect(text).toContain('sqs_dlq_messages_visible{queue="exclusive.fifo"} 3');
});
