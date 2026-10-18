import type { OperationalObservabilityPort } from '../ports/operational-observability';
import { validateOutboxContract } from '../validation/outbox-contract';
import type {
  ClaimedOutboxMessage,
  OutboxQueuePublisherPort,
  OutboxRepositoryPort,
} from '../ports/ports';
import type { IntegrationEventEnvelope } from '../../domain/events/events';

export interface PublishResult {
  claimed: number;
  published: number;
  failed: number;
  blocked: number;
  staleLease: number;
}

export interface PublishOutboxOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryFactor?: number;
}

export type OutboxPublishHookPoint =
  | 'after_claim'
  | 'before_sqs_send'
  | 'after_sqs_send'
  | 'before_mark_published'
  | 'after_mark_published';

export class PublishOutboxEventsUseCase {
  private readonly testHooks = new Map<
    OutboxPublishHookPoint,
    (context: any) => Promise<void> | void
  >();

  public readonly baseDelayMs: number;
  public readonly maxDelayMs: number;
  public readonly retryFactor: number;

  constructor(
    private readonly outboxRepo: OutboxRepositoryPort,
    private readonly queuePublisher: OutboxQueuePublisherPort,
    options?: PublishOutboxOptions,
    private readonly telemetry?: OperationalObservabilityPort
  ) {
    this.baseDelayMs =
      options?.baseDelayMs ??
      (Number(process.env.OUTBOX_PUBLISHER_RETRY_BASE_DELAY_MS) || 1000);
    this.maxDelayMs =
      options?.maxDelayMs ??
      (Number(process.env.OUTBOX_PUBLISHER_RETRY_MAX_DELAY_MS) || 60000);
    this.retryFactor =
      options?.retryFactor ??
      (Number(process.env.OUTBOX_PUBLISHER_RETRY_FACTOR) || 2);
  }

  public setTestHook(
    point: OutboxPublishHookPoint,
    fn: (context: any) => Promise<void> | void
  ): void {
    this.testHooks.set(point, fn);
  }

  public clearTestHooks(): void {
    this.testHooks.clear();
  }

  private async triggerHook(point: OutboxPublishHookPoint, context: any): Promise<void> {
    const hook = this.testHooks.get(point);
    if (hook) {
      await hook(context);
    }
  }

  public calculateBackoffDelayMs(attempts: number): number {
    return Math.min(
      this.baseDelayMs * Math.pow(this.retryFactor, Math.max(0, attempts)),
      this.maxDelayMs
    );
  }

  public async execute(
    batchSize = 20,
    leaseDurationMs = 30000,
    workerId = `publisher-${crypto.randomUUID().slice(0, 8)}`,
    signal?: AbortSignal
  ): Promise<PublishResult> {
    const result: PublishResult = {
      claimed: 0,
      published: 0,
      failed: 0,
      blocked: 0,
      staleLease: 0,
    };

    if (signal?.aborted) {
      return result;
    }

    const claimedEvents = await this.outboxRepo.claimUnpublishedEvents(
      batchSize,
      leaseDurationMs,
      workerId
    );

    result.claimed = claimedEvents.length;
    if (claimedEvents.length === 0) {
      return result;
    }

    const oldestOccurredAt = Math.min(...claimedEvents.map(e => new Date(e.occurredAt).getTime()));
    const delaySeconds = Math.max(0, (Date.now() - oldestOccurredAt) / 1000);
    this.telemetry?.recordOutboxLag?.(delaySeconds, claimedEvents.length);

    await this.triggerHook('after_claim', { claimedEvents, workerId });

    for (const event of claimedEvents) {
      if (signal?.aborted) {
        // On shutdown / cancellation, release lease on unhandled items so another instance can pick them up quickly
        await this.outboxRepo.releaseLease(event.id, event.leaseToken);
        result.failed++;
        continue;
      }

      const started = performance.now();
      const walletId = event.aggregateId ?? null;
      const providerId = (event.payload as any)?.providerId ?? (event.payload as any)?.data?.providerId ?? null;
      const messageId = (event.payload as any)?.messageId ?? (event.payload as any)?.data?.messageId ?? null;
      const context = {
        correlationId: event.correlationId,
        eventId: event.id,
        walletId,
        providerId,
        messageId,
      };
      // 1. Envelope validation: isolate invalid events without blocking the whole batch
      const validation = validateOutboxContract(event);
      if (!validation.valid) {
        const blocked = await this.outboxRepo.markOperationallyBlocked(
          event.id,
          event.leaseToken,
          validation.reason!,
          `Validation failed: ${validation.reason}`
        );
        if (blocked) result.blocked++;
        else result.staleLease++;
        this.telemetry?.event('publisher', 'validation', blocked ? 'blocked' : 'stale_lease', { ...context, durationMs: performance.now() - started });
        continue;
      }

      const envelope: IntegrationEventEnvelope = {
        eventId: event.id,
        eventType: event.eventType,
        version: event.version,
        occurredAt: event.occurredAt,
        aggregateId: event.aggregateId,
        correlationId: event.correlationId,
        causationId: event.causationId ?? null,
        data: event.payload,
      };

      try {
        await this.triggerHook('before_sqs_send', { event, envelope, workerId });

        this.telemetry?.event('publisher', 'send', 'attempt', context);
        await this.queuePublisher.publish(envelope, { signal });

        this.telemetry?.event('publisher', 'send', 'broker_confirmed', { ...context, durationMs: performance.now() - started });
        await this.triggerHook('after_sqs_send', { event, envelope, workerId });

        await this.triggerHook('before_mark_published', { event, envelope, workerId });

        const markStarted = performance.now();
        const marked = await this.outboxRepo.markPublished(event.id, event.leaseToken);

        if (marked) {
          result.published++;
          const occurredAtMs = new Date(event.occurredAt).getTime();
          const publishLagSeconds = Math.max(0, (Date.now() - occurredAtMs) / 1000);
          this.telemetry?.recordOutboxLag?.(publishLagSeconds, undefined, publishLagSeconds);

          this.telemetry?.event('publisher', 'mark', 'local_confirmed', { ...context, durationMs: performance.now() - markStarted });
          await this.triggerHook('after_mark_published', { event, envelope, workerId });
        } else {
          result.staleLease++;
          this.telemetry?.event('publisher', 'mark', 'stale_lease', { ...context, durationMs: performance.now() - markStarted });
        }
      } catch (err: any) {
        this.telemetry?.event('publisher', 'publish', 'failure', { ...context, durationMs: performance.now() - started });

        if (signal?.aborted) {
          await this.outboxRepo.releaseLease(event.id, event.leaseToken);
        } else {
          const delayMs = this.calculateBackoffDelayMs(event.attempts);
          // Preserve M14's persisted diagnostic contract; never emit this value to logs or labels.
          const errorMsg = String(err?.message || err || 'SQS_SEND_FAILED').slice(0, 1000);
          await this.outboxRepo.recordFailure(
            event.id,
            event.leaseToken,
            delayMs,
            errorMsg
          );
        }
        result.failed++;
      }
    }

    return result;
  }
}
