import { Logger, OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown } from '@nestjs/common';
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand, type Message } from '@aws-sdk/client-sqs';
import { ConsumeWagerCommand } from '../../application/messaging/consume-wager-command';
import { parseWagerCommand } from '../../application/messaging/wager-command';

export interface ConsumerConfig {
  client?: SQSClient;
  queueUrl?: string;
  enabled?: boolean;
  requestTimeoutMs?: number;
}
export class SqsWagerConsumer implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown {
  private readonly logger = new Logger(SqsWagerConsumer.name);
  private readonly client: SQSClient;
  private readonly ownsClient: boolean;
  private readonly queueUrl: string;
  private readonly enabled: boolean;
  private readonly timeout: number;
  private stopping = false;
  private loop?: Promise<void>;
  private execution?: Promise<void>;
  private receiveAbort = new AbortController();
  private wake?: () => void;
  constructor(private readonly consume: ConsumeWagerCommand, config: ConsumerConfig = {}) {
    this.enabled = config.enabled ?? ['true', '1'].includes(process.env.SQS_CONSUMER_ENABLED ?? '');
    this.queueUrl = config.queueUrl ?? process.env.WAGER_TRANSACTIONS_QUEUE_URL ?? '';
    if (this.enabled && (!this.queueUrl || !this.queueUrl.endsWith('.fifo') || this.queueUrl.includes('wager-events'))) throw new Error('INVALID_COMMAND_QUEUE');
    this.timeout = config.requestTimeoutMs ?? Number(process.env.SQS_REQUEST_TIMEOUT_MS ?? 5000);
    if (!Number.isSafeInteger(this.timeout) || this.timeout <= 0) throw new Error('INVALID_SQS_TIMEOUT');
    this.ownsClient = !config.client;
    this.client = config.client ?? new SQSClient({
      endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
      region: process.env.AWS_REGION ?? 'us-east-1',
      credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' },
    });
  }
  onApplicationBootstrap(): void {
    if (this.enabled && !this.loop && !this.stopping) this.loop = this.poll();
  }
  private async poll(): Promise<void> {
    while (!this.stopping) {
      try { await this.receiveOnce(); }
      catch { if (!this.stopping) this.logger.warn('SQS_RECEIVE_FAILED'); }
      if (!this.stopping) await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.wake = undefined; resolve(); }, 250);
        this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve(); };
      });
    }
  }
  receiveOnce(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.execution) return this.execution;
    const work = this.receiveAndProcess();
    this.execution = work;
    void work.finally(() => { if (this.execution === work) this.execution = undefined; }).catch(() => {});
    return work;
  }
  private async receiveAndProcess(): Promise<void> {
    const response = await this.client.send(new ReceiveMessageCommand({
      QueueUrl: this.queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 1,
      MessageSystemAttributeNames: ['All'],
    }), { abortSignal: AbortSignal.any([this.receiveAbort.signal, AbortSignal.timeout(this.timeout)]) });
    for (const message of response.Messages ?? []) {
      if (this.stopping) break;
      await this.processMessage(message);
    }
  }
  async processMessage(message: Message): Promise<boolean> {
    let stage = 'VALIDATION';
    try {
      if (!message.Body || !message.MessageId || !message.ReceiptHandle) throw new Error('INVALID_TRANSPORT');
      const command = parseWagerCommand(message.Body, message.Attributes);
      stage = 'TRANSACTION';
      await this.consume.execute(command, message.MessageId);
      // This await is outside the external transaction and follows confirmed commit.
      stage = 'DELETE';
      await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }),
        { abortSignal: AbortSignal.timeout(this.timeout) });
      return true;
    } catch {
      // Do not log financial payloads, receipts, raw errors or credentials.
      this.logger.warn(`SQS_COMMAND_NOT_ACKNOWLEDGED stage=${stage}`);
      return false;
    }
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.receiveAbort.abort();
    this.wake?.();
    await this.loop;
    try { await this.execution; } catch { /* Receive cancellation is expected while draining. */ }
  }
  async beforeApplicationShutdown(): Promise<void> {
    await this.onModuleDestroy();
    if (this.ownsClient) this.client.destroy();
  }
}
