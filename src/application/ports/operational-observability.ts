export type Operation = 'send' | 'mark' | 'validation' | 'publish' | 'receive' | 'delivery' | 'renewal' | 'retry_visibility' | 'transaction' | 'delete' | 'processing' | 'inbox' | 'reprocess' | 'lifecycle';
export type OperationalResult = 'attempt' | 'broker_confirmed' | 'local_confirmed' | 'blocked' | 'stale_lease' | 'failure' | 'received' | 'redelivery_observed' | 'confirmed' | 'durable' | 'accepted' | 'duplicate' | 'TRANSIENT' | 'PERMANENT' | 'UNKNOWN' | 'claimed' | 'processed' | 'rejected' | 'rescheduled' | 'aborted' | 'transient_failure' | 'unexpected_failure' | 'unknown' | 'warning';

export interface OperationalObservabilityPort {
  event(component: 'publisher' | 'consumer' | 'references', operation: Operation, result: OperationalResult,
    context?: { correlationId?: string | null; eventId?: string; commandId?: string; transactionId?: string; durationMs?: number }): void;
}
