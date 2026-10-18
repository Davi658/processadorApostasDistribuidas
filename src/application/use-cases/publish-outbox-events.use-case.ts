import { validateOutboxContract } from '../validation/outbox-contract';
import { Logger } from '@nestjs/common';
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
  private readonly logger = new Logger(PublishOutboxEventsUseCase.name);
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
    options?: PublishOutboxOptions
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

    await this.triggerHook('after_claim', { claimedEvents, workerId });

    for (const event of claimedEvents) {
      if (signal?.aborted) {
        // On shutdown / cancellation, release lease on unhandled items so another instance can pick them up quickly
        await this.outboxRepo.releaseLease(event.id, event.leaseToken);
        result.failed++;
        continue;
      }

      // 1. Envelope validation: isolate invalid events without blocking the whole batch
      const validation = validateOutboxContract(event);
      if (!validation.valid) {
        this.logger.warn(
          `Outbox message ${event.id} is invalid: ${validation.reason}. Isolating event.`
        );
        const blocked = await this.outboxRepo.markOperationallyBlocked(
          event.id,
          event.leaseToken,
          validation.reason!,
          `Validation failed: ${validation.reason}`
        );
        if (blocked) result.blocked++;
        else result.staleLease++;
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

        await this.queuePublisher.publish(envelope, { signal });

        await this.triggerHook('after_sqs_send', { event, envelope, workerId });

        await this.triggerHook('before_mark_published', { event, envelope, workerId });

        const marked = await this.outboxRepo.markPublished(event.id, event.leaseToken);

        if (marked) {
          result.published++;
          await this.triggerHook('after_mark_published', { event, envelope, workerId });
        } else {
          this.logger.warn(
            `Failed to mark outbox event ${event.id} as published: lease token was stale or lost.`
          );
          result.staleLease++;
        }
      } catch (err: any) {
        this.logger.error(
          `Failed to publish outbox event ${event.id} to queue: ${err?.message || err}`,
          err?.stack
        );

        if (signal?.aborted) {
          await this.outboxRepo.releaseLease(event.id, event.leaseToken);
        } else {
          const delayMs = this.calculateBackoffDelayMs(event.attempts);
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
