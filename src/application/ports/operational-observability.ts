export type Operation =
  | 'send'
  | 'mark'
  | 'validation'
  | 'publish'
  | 'receive'
  | 'delivery'
  | 'renewal'
  | 'retry_visibility'
  | 'transaction'
  | 'delete'
  | 'processing'
  | 'inbox'
  | 'reprocess'
  | 'lifecycle'
  | 'process'
  | 'request'
  | 'dlq';

export type OperationalResult =
  | 'lock_conflict'
  | 'attempt'
  | 'broker_confirmed'
  | 'local_confirmed'
  | 'blocked'
  | 'stale_lease'
  | 'failure'
  | 'received'
  | 'redelivery_observed'
  | 'confirmed'
  | 'durable'
  | 'accepted'
  | 'duplicate'
  | 'TRANSIENT'
  | 'PERMANENT'
  | 'UNKNOWN'
  | 'claimed'
  | 'processed'
  | 'rejected'
  | 'rescheduled'
  | 'aborted'
  | 'transient_failure'
  | 'unexpected_failure'
  | 'unknown'
  | 'warning'
  | 'success'
  | 'PROCESSED'
  | 'REJECTED'
  | 'PENDING_REFERENCE'
  | 'FAILED';

export interface TelemetryContext {
  correlationId?: string | null;
  walletId?: string | null;
  providerId?: string | null;
  messageId?: string | null;
  eventId?: string | null;
  commandId?: string | null;
  transactionId?: string | null;
  durationMs?: number;
  [key: string]: unknown;
}

export interface OperationalObservabilityPort {
  event(
    component: 'publisher' | 'consumer' | 'references' | 'http' | 'financial' | string,
    operation: Operation | string,
    result: OperationalResult | string,
    context?: TelemetryContext
  ): void;

  recordFinancialTransaction?(
    kind: string,
    status: string,
    durationSeconds: number,
    context?: TelemetryContext
  ): void;

  recordDlqStats?(
    queueName: string,
    visibleCount: number,
  ): void;

  recordOutboxPublishLag?(publishLagSeconds: number): void;

  recordOutboxLag?(
    delaySeconds: number,
    pendingCount?: number,
  ): void;
}
