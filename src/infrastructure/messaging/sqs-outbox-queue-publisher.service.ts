import { Injectable, OnModuleDestroy, Logger, Optional } from '@nestjs/common';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { IntegrationEventEnvelope } from '../../domain/events/events';
import type { OutboxQueuePublisherPort } from '../../application/ports/ports';

export interface SqsPublisherConfig {
  endpoint?: string;
  region?: string;
  queueUrl?: string;
  requestTimeoutMs?: number;
  accessKeyId?: string;
  secretAccessKey?: string;
  sqsClient?: SQSClient;
}

@Injectable()
export class SqsOutboxQueuePublisher implements OutboxQueuePublisherPort, OnModuleDestroy {
  private readonly logger = new Logger(SqsOutboxQueuePublisher.name);
  private readonly client: SQSClient;
  private readonly queueUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly ownsClient: boolean;

  constructor(@Optional() config?: SqsPublisherConfig) {
    this.queueUrl =
      config?.queueUrl ||
      process.env.OUTBOX_EVENTS_QUEUE_URL ||
      'http://127.0.0.1:4566/queue/us-east-1/000000000000/wager-events.fifo';

    this.requestTimeoutMs =
      config?.requestTimeoutMs ||
      Number(process.env.SQS_REQUEST_TIMEOUT_MS) ||
      5000;

    if (config?.sqsClient) {
      this.client = config.sqsClient;
      this.ownsClient = false;
    } else {
      const endpoint = config?.endpoint || process.env.SQS_ENDPOINT || 'http://127.0.0.1:4566';
      const region = config?.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
      const accessKeyId = config?.accessKeyId || process.env.AWS_ACCESS_KEY_ID || 'test';
      const secretAccessKey = config?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || 'test';

      this.client = new SQSClient({
        endpoint,
        region,
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
      });
      this.ownsClient = true;
    }
  }

  public async publish(
    event: IntegrationEventEnvelope,
    options?: { signal?: AbortSignal }
  ): Promise<{ messageId: string }> {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const combinedSignal = options?.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    const payload = JSON.stringify({
      eventId: event.eventId,
      eventType: event.eventType,
      version: event.version,
      occurredAt: event.occurredAt,
      aggregateId: event.aggregateId,
      correlationId: event.correlationId,
      causationId: event.causationId ?? null,
      data: event.data,
    });

    const command = new SendMessageCommand({
      QueueUrl: this.queueUrl,
      MessageBody: payload,
      MessageGroupId: event.aggregateId,
      MessageDeduplicationId: event.eventId,
    });

    const response = await this.client.send(command, {
      abortSignal: combinedSignal,
    });

    if (!response.MessageId) {
      throw new Error(`SQS SendMessage response missing MessageId for eventId: ${event.eventId}`);
    }

    return { messageId: response.MessageId };
  }

  public async onModuleDestroy(): Promise<void> {
    if (this.ownsClient) {
      try {
        this.client.destroy();
      } catch (err) {
        this.logger.warn('Error destroying SQSClient', err);
      }
    }
  }

  public getQueueUrl(): string {
    return this.queueUrl;
  }
}
