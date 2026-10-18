import type {
  Operation,
  OperationalResult,
  OperationalObservabilityPort,
  TelemetryContext,
} from '../../application/ports/operational-observability';
import type { NextFunction, Request, Response } from 'express';

const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const outboxBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/** Instance-local registry: never put raw paths or payloads in labels. */
export class HttpObservability implements OperationalObservabilityPort {
  private readonly series = new Map<string, { count: number; sum: number; buckets: number[] }>();
  private readonly financialCounters = new Map<string, number>();
  private readonly financialSeries = new Map<string, { count: number; sum: number; buckets: number[] }>();
  private readonly counters = new Map<string, number>();
  private readonly dlqGauges = new Map<string, number>();
  private readonly dlqCounters = new Map<string, number>();
  private outboxDelay = 0;
  private outboxPending = 0;
  private readonly outboxLagSeries = new Map<string, { count: number; sum: number; buckets: number[] }>();
  private readonly collectors: Array<() => Promise<void>> = [];

  constructor(private readonly write: (line: string) => void = line => console.log(line)) {
    // Default series initialized so scrapers and test probes always find them
    this.dlqGauges.set('wager-transactions-dlq.fifo', 0);
    this.dlqCounters.set('wager-transactions-dlq.fifo', 0);
  }

  public registerCollector(collector: () => Promise<void>): void {
    this.collectors.push(collector);
  }

  readonly middleware = (req: Request, res: Response, next: NextFunction): void => {
    const start = performance.now();
    // Matches the existing wager correlation policy without modifying transport headers.
    const candidate = req.get('x-correlation-id')?.trim() || req.get('idempotency-key')?.trim();
    const correlationId = candidate && candidate.length <= 255 ? candidate : null;

    res.once('finish', () => {
      const walletCandidate =
        (typeof req.body?.walletId === 'string' && req.body.walletId.trim()) ||
        (typeof req.params?.walletId === 'string' && req.params.walletId.trim()) ||
        (typeof req.params?.id === 'string' && req.params.id.trim()) ||
        req.get('x-wallet-id')?.trim() ||
        req.path?.match(/^\/wallets\/([0-9a-fA-F-]{36})/)?.[1] ||
        null;
      const walletId = walletCandidate && walletCandidate.length <= 255 ? walletCandidate : null;

      const providerCandidate =
        (typeof req.body?.providerId === 'string' && req.body.providerId.trim()) ||
        (typeof req.params?.providerId === 'string' && req.params.providerId.trim()) ||
        req.get('x-provider-id')?.trim() ||
        null;
      const providerId = providerCandidate && providerCandidate.length <= 255 ? providerCandidate : null;

      const messageCandidate = req.get('x-message-id')?.trim() || req.get('message-id')?.trim() || null;
      const messageId = messageCandidate && messageCandidate.length <= 255 ? messageCandidate : null;

      const route = typeof req.route?.path === 'string' ? req.route.path : '__unmatched__';
      const method = methods.has(req.method) ? req.method : 'OTHER';
      const status = res.statusCode;
      const durationSeconds = Math.max(0, performance.now() - start) / 1000;
      const labels = `method="${method}",route="${escape(route)}",status="${status}"`;
      let item = this.series.get(labels);
      if (!item) {
        item = { count: 0, sum: 0, buckets: buckets.map(() => 0) };
        this.series.set(labels, item);
      }
      item.count++;
      item.sum += durationSeconds;
      buckets.forEach((bound, index) => {
        if (durationSeconds <= bound) item!.buckets[index]++;
      });

      // Systematic structured log schema
      const logPayload: Record<string, unknown> = {
        component: 'http',
        correlationId,
        durationMs: durationSeconds * 1000,
        messageId,
        method,
        operation: 'request',
        providerId,
        result: status < 400 ? 'success' : 'failure',
        route,
        status,
        walletId,
      };

      try {
        this.write(JSON.stringify(logPayload));
      } catch {
        /* A failed log sink must not affect the financial request. */
      }
    });
    next();
  };

  event(
    component: 'publisher' | 'consumer' | 'references' | 'http' | 'financial' | string,
    operation: Operation | string,
    result: OperationalResult | string,
    context: TelemetryContext = {}
  ): void {
    // Call sites supply closed vocabularies, never transport or exception values.
    const labels = `component="${component}",operation="${operation}",result="${result}"`;
    this.counters.set(labels, (this.counters.get(labels) ?? 0) + 1);

    const logEntry: Record<string, unknown> = {
      component,
      correlationId: context.correlationId ?? null,
      durationMs: typeof context.durationMs === 'number' ? context.durationMs : 0,
      messageId: context.messageId ?? null,
      operation,
      providerId: context.providerId ?? null,
      result,
      walletId: context.walletId ?? null,
      ...context,
    };

    try {
      this.write(JSON.stringify(logEntry));
    } catch {
      /* Logging must not change transaction outcomes. */
    }
  }

  recordFinancialTransaction(
    kind: string,
    status: string,
    durationSeconds: number,
    context?: TelemetryContext
  ): void {
    // 1. Dedicated counter for financial transactions by status and kind
    const counterKey = `status="${escape(status)}",kind="${escape(kind)}"`;
    this.financialCounters.set(counterKey, (this.financialCounters.get(counterKey) ?? 0) + 1);

    // 2. Dedicated histogram for financial transaction processing latency
    const histKey = `kind="${escape(kind)}",status="${escape(status)}"`;
    let histItem = this.financialSeries.get(histKey);
    if (!histItem) {
      histItem = { count: 0, sum: 0, buckets: buckets.map(() => 0) };
      this.financialSeries.set(histKey, histItem);
    }
    histItem.count++;
    histItem.sum += durationSeconds;
    buckets.forEach((bound, index) => {
      if (durationSeconds <= bound) histItem!.buckets[index]++;
    });
  }

  recordDlqStats(queueName: string, visibleCount: number, totalMovedCount?: number): void {
    this.dlqGauges.set(queueName, Math.max(0, visibleCount));
    if (typeof totalMovedCount === 'number') {
      this.dlqCounters.set(queueName, Math.max(0, totalMovedCount));
    }
  }

  incrementDlqMessages(queueName: string, count = 1): void {
    const current = this.dlqCounters.get(queueName) ?? 0;
    this.dlqCounters.set(queueName, current + count);
  }

  recordOutboxLag(delaySeconds: number, pendingCount?: number, publishLagSeconds?: number): void {
    this.outboxDelay = Math.max(0, delaySeconds);
    if (typeof pendingCount === 'number') {
      this.outboxPending = Math.max(0, pendingCount);
    }
    if (typeof publishLagSeconds === 'number') {
      const key = 'outbox_lag';
      let item = this.outboxLagSeries.get(key);
      if (!item) {
        item = { count: 0, sum: 0, buckets: outboxBuckets.map(() => 0) };
        this.outboxLagSeries.set(key, item);
      }
      item.count++;
      item.sum += publishLagSeconds;
      outboxBuckets.forEach((bound, index) => {
        if (publishLagSeconds <= bound) item!.buckets[index]++;
      });
    }
  }

  async render(): Promise<string> {
    if (this.collectors.length > 0) {
      await Promise.allSettled(this.collectors.map(c => c()));
    }

    const lines: string[] = [
      '# HELP http_requests_total Completed HTTP requests',
      '# TYPE http_requests_total counter',
      '# HELP http_request_duration_seconds HTTP request duration in seconds',
      '# TYPE http_request_duration_seconds histogram',
    ];
    for (const [labels, item] of this.series) {
      lines.push(`http_requests_total{${labels}} ${item.count}`);
      buckets.forEach((bound, index) =>
        lines.push(`http_request_duration_seconds_bucket{${labels},le="${bound}"} ${item.buckets[index]}`)
      );
      lines.push(
        `http_request_duration_seconds_bucket{${labels},le="+Inf"} ${item.count}`,
        `http_request_duration_seconds_sum{${labels}} ${item.sum}`,
        `http_request_duration_seconds_count{${labels}} ${item.count}`
      );
    }

    // Dedicated Financial Transactions by status and kind
    lines.push(
      '# HELP financial_transactions_total Total financial transactions processed by status and kind',
      '# TYPE financial_transactions_total counter'
    );
    for (const [labels, count] of this.financialCounters) {
      lines.push(`financial_transactions_total{${labels}} ${count}`);
    }

    // Dedicated Financial Processing Latency histogram
    lines.push(
      '# HELP financial_transaction_duration_seconds Latency of financial transaction processing in seconds',
      '# TYPE financial_transaction_duration_seconds histogram'
    );
    for (const [labels, item] of this.financialSeries) {
      buckets.forEach((bound, index) =>
        lines.push(`financial_transaction_duration_seconds_bucket{${labels},le="${bound}"} ${item.buckets[index]}`)
      );
      lines.push(
        `financial_transaction_duration_seconds_bucket{${labels},le="+Inf"} ${item.count}`,
        `financial_transaction_duration_seconds_sum{${labels}} ${item.sum}`,
        `financial_transaction_duration_seconds_count{${labels}} ${item.count}`
      );
    }

    // Dedicated SQS DLQ metrics
    lines.push(
      '# HELP sqs_dlq_messages_visible Approximate number of visible messages in the dead-letter queue',
      '# TYPE sqs_dlq_messages_visible gauge'
    );
    for (const [queue, visible] of this.dlqGauges) {
      lines.push(`sqs_dlq_messages_visible{queue="${escape(queue)}"} ${visible}`);
    }
    lines.push(
      '# HELP sqs_dlq_messages_total Total messages observed in the dead-letter queue',
      '# TYPE sqs_dlq_messages_total counter'
    );
    for (const [queue, count] of this.dlqCounters) {
      lines.push(`sqs_dlq_messages_total{queue="${escape(queue)}"} ${count}`);
    }

    // Dedicated Outbox delay and lag metrics
    lines.push(
      '# HELP outbox_delay_seconds Age in seconds of the oldest unpublished outbox event',
      '# TYPE outbox_delay_seconds gauge',
      `outbox_delay_seconds ${this.outboxDelay.toFixed(3)}`,
      '# HELP outbox_pending_events_total Number of unpublished outbox events pending delivery',
      '# TYPE outbox_pending_events_total gauge',
      `outbox_pending_events_total ${this.outboxPending}`
    );
    const outboxLagItem = this.outboxLagSeries.get('outbox_lag');
    lines.push(
      '# HELP outbox_publish_lag_seconds Time in seconds between event creation and broker publish confirmation',
      '# TYPE outbox_publish_lag_seconds histogram'
    );
    if (outboxLagItem) {
      outboxBuckets.forEach((bound, index) =>
        lines.push(`outbox_publish_lag_seconds_bucket{le="${bound}"} ${outboxLagItem.buckets[index]}`)
      );
      lines.push(
        `outbox_publish_lag_seconds_bucket{le="+Inf"} ${outboxLagItem.count}`,
        `outbox_publish_lag_seconds_sum ${outboxLagItem.sum}`,
        `outbox_publish_lag_seconds_count ${outboxLagItem.count}`
      );
    }

    // Generic operational events
    lines.push(
      '# HELP operational_events_total Observed process-local operational stages',
      '# TYPE operational_events_total counter'
    );
    for (const [labels, count] of this.counters) {
      lines.push(`operational_events_total{${labels}} ${count}`);
    }

    return lines.join('\n') + '\n';
  }
}
