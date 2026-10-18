import { Logger, OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown } from '@nestjs/common';
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand, ChangeMessageVisibilityCommand, GetQueueAttributesCommand, type Message } from '@aws-sdk/client-sqs';
import { ConsumeWagerCommand } from '../../application/messaging/consume-wager-command';
import { parseWagerCommand } from '../../application/messaging/wager-command';

export interface ConsumerConfig {
  client?: SQSClient;
  queueUrl?: string;
  enabled?: boolean;
  requestTimeoutMs?: number;
  visibilitySeconds?: number;
  renewalMs?: number;
  retryBaseSeconds?: number;
  retryMaxSeconds?: number;
  drainTimeoutMs?: number;
}
export class SqsWagerConsumer implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown {
  private readonly logger = new Logger(SqsWagerConsumer.name);
  private readonly client: SQSClient;
  private readonly ownsClient: boolean;
  private readonly queueUrl: string;
  private readonly enabled: boolean;
  private readonly timeout: number;
  private readonly visibility: number;
  private readonly renewalMs: number;
  private readonly retryBase: number;
  private readonly retryMax: number;
  private readonly drainMs: number;
  private readonly active = new Map<Promise<boolean>, AbortController>();
  private shutdown?: Promise<void>;
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
    this.visibility = config.visibilitySeconds ?? Number(process.env.SQS_CONSUMER_VISIBILITY_SECONDS ?? 30);
    this.renewalMs = config.renewalMs ?? Number(process.env.SQS_CONSUMER_RENEWAL_MS ?? 10000);
    this.retryBase = config.retryBaseSeconds ?? Number(process.env.SQS_CONSUMER_RETRY_BASE_SECONDS ?? 2);
    this.retryMax = config.retryMaxSeconds ?? Number(process.env.SQS_CONSUMER_RETRY_MAX_SECONDS ?? 300);
    this.drainMs = config.drainTimeoutMs ?? Number(process.env.SQS_CONSUMER_DRAIN_TIMEOUT_MS ?? 10000);
    if (![this.visibility, this.renewalMs, this.retryBase, this.retryMax, this.drainMs].every(n => Number.isSafeInteger(n) && n > 0)
      || this.visibility > 43200 || this.retryMax > 43200 || this.retryBase > this.retryMax || this.drainMs > 2147483647
      || this.renewalMs + this.timeout >= this.visibility * 1000 || this.timeout <= 1000) throw new Error('INVALID_CONSUMER_TIMING');
    this.ownsClient = !config.client;
    this.client = config.client ?? new SQSClient({
      endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
      region: process.env.AWS_REGION ?? 'us-east-1',
      credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' },
    });
  }
  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled || this.loop || this.stopping) return;
    const attributes = (await this.client.send(new GetQueueAttributesCommand({ QueueUrl: this.queueUrl,
      AttributeNames: ['FifoQueue', 'RedrivePolicy'] }), { abortSignal: AbortSignal.timeout(this.timeout) })).Attributes;
    const redrive = JSON.parse(attributes?.RedrivePolicy ?? '{}');
    if (attributes?.FifoQueue !== 'true' || !String(redrive.deadLetterTargetArn ?? '').endsWith('.fifo')
      || !Number.isInteger(Number(redrive.maxReceiveCount)) || Number(redrive.maxReceiveCount) < 1 || Number(redrive.maxReceiveCount) > 1000) throw new Error('INVALID_COMMAND_REDRIVE');
    if (!this.stopping) this.loop = this.poll();
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
    const receivedAt = Date.now();
    const response = await this.client.send(new ReceiveMessageCommand({
      QueueUrl: this.queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 1, VisibilityTimeout: this.visibility,
      MessageSystemAttributeNames: ['All'],
    }), { abortSignal: AbortSignal.any([this.receiveAbort.signal, AbortSignal.timeout(this.timeout)]) });
    for (const message of response.Messages ?? []) {
      if (this.stopping) break;
      await this.processMessage(message, receivedAt);
    }
  }
  processMessage(message: Message, receivedAt = Date.now()): Promise<boolean> {
    if (this.stopping) return Promise.resolve(false);
    const controller = new AbortController();
    const work = this.handleMessage(message, controller.signal, receivedAt);
    this.active.set(work, controller);
    void work.finally(() => this.active.delete(work)).catch(() => {});
    return work;
  }
  private async handleMessage(message: Message, signal: AbortSignal, receivedAt: number): Promise<boolean> {
    let stage = 'VALIDATION';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let renewal: Promise<void> | undefined;
    let finished = false;
    let uncertain = false;
    // SQS has a 12-hour limit from receive; stop early to leave network margin.
    const renewalDeadline = receivedAt + 43200 * 1000 - this.timeout - 1000;
    const change = async (seconds: number) => {
      const remaining = Math.floor((renewalDeadline - Date.now()) / 1000);
      if (remaining <= 0) throw new Error('VISIBILITY_LIMIT');
      await this.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.queueUrl,
        ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: Math.min(seconds, remaining) }),
      { abortSignal: AbortSignal.timeout(this.timeout) });
    };
    const schedule = () => {
      timer = setTimeout(() => {
        renewal = (async () => {
          try {
            const remaining = Math.floor((renewalDeadline - Date.now()) / 1000);
            if (remaining <= 0) throw new Error('VISIBILITY_LIMIT');
            await change(Math.min(this.visibility, remaining));
          } catch {
            uncertain = true;
            this.logger.warn('SQS_OWNERSHIP_UNCERTAIN');
          }
          if (!finished && !uncertain) schedule();
        })();
      }, this.renewalMs);
    };
    try {
      if (!message.Body || !message.MessageId || !message.ReceiptHandle) throw new Error('INVALID_TRANSPORT');
      schedule();
      const command = parseWagerCommand(message.Body, message.Attributes);
      stage = 'TRANSACTION';
      await this.consume.execute(command, message.MessageId, signal);
      stage = 'DELETE';
      await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }),
        { abortSignal: AbortSignal.timeout(this.timeout) });
      return true;
    } catch (error) {
      const policy = stage === 'VALIDATION' ? 'PERMANENT' : classifyConsumerFailure(error);
      const rawCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
      const count = Number.isSafeInteger(rawCount) && rawCount > 0 ? rawCount : 1;
      this.logger.warn(`SQS_COMMAND_NOT_ACKNOWLEDGED stage=${stage} policy=${policy} receiveCount=${count}`);
      // Finish renewal before setting retry visibility so it cannot overwrite backoff.
      finished = true;
      clearTimeout(timer);
      await renewal;
      if (message.ReceiptHandle && !uncertain) {
        const delay = Math.min(this.retryMax, this.retryBase * 2 ** Math.min(count - 1, 20));
        try { await change(delay); } catch { this.logger.warn('SQS_RETRY_VISIBILITY_FAILED'); }
      }
      return false;
    } finally {
      finished = true;
      clearTimeout(timer);
      await renewal;
    }
  }
  onModuleDestroy(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.stopping = true;
    this.receiveAbort.abort();
    this.wake?.();
    this.shutdown = (async () => {
      const deadline = setTimeout(() => {
        for (const controller of this.active.values()) controller.abort(new Error('CONSUMER_DRAIN_TIMEOUT'));
      }, this.drainMs);
      try {
        await this.loop;
        try { await this.execution; } catch { /* Cancelled receive. */ }
        await Promise.allSettled([...this.active.keys()]);
      } finally { clearTimeout(deadline); }
    })();
    return this.shutdown;
  }
  async beforeApplicationShutdown(): Promise<void> {
    await this.onModuleDestroy();
    if (this.ownsClient) this.client.destroy();
  }
}

export function classifyConsumerFailure(error: unknown): 'TRANSIENT' | 'PERMANENT' | 'UNKNOWN' {
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const e = current as { code?: string; cause?: unknown; originalError?: unknown; driverException?: unknown; driverError?: unknown };
    if (['40001', '40P01', '55P03', '57014', '08000', '08001', '08003', '08004', '08006', '53300', '57P01', '57P02', '57P03', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'].includes(e.code ?? '')) return 'TRANSIENT';
    if (['IDEMPOTENCY_CONFLICT', 'REPLAY_SNAPSHOT_UNAVAILABLE', 'WALLET_NOT_FOUND', 'INVALID_MONEY', 'MONEY_OVERFLOW', 'INVALID_WAGER_OPERATION', 'CURRENCY_MISMATCH', '23503', '23514'].includes(e.code ?? '')) return 'PERMANENT';
    pending.push(e.cause, e.originalError, e.driverException, e.driverError);
  }
  return 'UNKNOWN';
}
