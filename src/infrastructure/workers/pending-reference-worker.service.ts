import {
  Injectable,
  OnApplicationBootstrap,
  BeforeApplicationShutdown,
  Logger,
  Optional,
} from '@nestjs/common';
import {
  ReprocessPendingReferencesUseCase,
  ReprocessResult,
} from '../../application/use-cases/reprocess-pending-references.use-case';

export interface PendingReferenceWorkerOptions {
  enabled?: boolean;
  intervalMs?: number;
  batchSize?: number;
  leaseDurationMs?: number;
  drainTimeoutMs?: number;
  workerId?: string;
}

@Injectable()
export class PendingReferenceWorkerService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(PendingReferenceWorkerService.name);
  private isRunning = false;
  private isTickRunning = false;
  private isShuttingDown = false;
  private timer: NodeJS.Timeout | null = null;
  private activeExecutionPromise: Promise<ReprocessResult | null> | null = null;

  public readonly enabled: boolean;
  public readonly intervalMs: number;
  public readonly batchSize: number;
  public readonly leaseDurationMs: number;
  public readonly drainTimeoutMs: number;
  public readonly workerId: string;

  constructor(
    private readonly reprocessUseCase: ReprocessPendingReferencesUseCase,
    @Optional() options?: PendingReferenceWorkerOptions
  ) {
    this.enabled =
      options?.enabled ??
      (process.env.PENDING_WORKER_ENABLED === 'true' || process.env.PENDING_WORKER_ENABLED === '1');
    this.intervalMs =
      options?.intervalMs ??
      (Number(process.env.PENDING_WORKER_INTERVAL_MS) || 5000);
    this.batchSize =
      options?.batchSize ??
      (Number(process.env.PENDING_WORKER_BATCH_SIZE) || 20);
    this.leaseDurationMs =
      options?.leaseDurationMs ??
      (Number(process.env.PENDING_WORKER_LEASE_MS) || 30000);
    this.drainTimeoutMs =
      options?.drainTimeoutMs ??
      (Number(process.env.PENDING_WORKER_DRAIN_TIMEOUT_MS) || 5000);
    this.workerId =
      options?.workerId ??
      `worker-${crypto.randomUUID().slice(0, 8)}`;
  }

  public async onApplicationBootstrap(): Promise<void> {
    if (this.enabled) {
      this.start();
    }
  }

  public async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.isShuttingDown = true;
    this.stop();

    if (this.activeExecutionPromise) {
      try {
        const timeoutPromise = new Promise((resolve) =>
          setTimeout(resolve, this.drainTimeoutMs)
        );
        await Promise.race([this.activeExecutionPromise, timeoutPromise]);
      } catch (err) {
        this.logger.error('Error draining in-flight worker batch during shutdown', err);
      }
    }
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.scheduleNextTick(0);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  public isWorkerRunning(): boolean {
    return this.isRunning;
  }

  public isTickInProgress(): boolean {
    return this.isTickRunning;
  }

  private scheduleNextTick(delayMs = this.intervalMs): void {
    if (!this.isRunning || this.isShuttingDown) return;
    this.timer = setTimeout(async () => {
      await this.tick();
      if (this.isRunning && !this.isShuttingDown) {
        this.scheduleNextTick(this.intervalMs);
      }
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.isTickRunning || this.isShuttingDown) {
      return;
    }

    this.isTickRunning = true;
    try {
      this.activeExecutionPromise = this.executeBatch(this.batchSize, this.leaseDurationMs);
      await this.activeExecutionPromise;
    } catch (err) {
      this.logger.error('Worker tick execution error', err);
    } finally {
      this.activeExecutionPromise = null;
      this.isTickRunning = false;
    }
  }

  public async executeBatch(
    batchSize = this.batchSize,
    leaseDurationMs = this.leaseDurationMs
  ): Promise<ReprocessResult> {
    if (this.isShuttingDown) {
      return { processed: 0, rejected: 0, rescheduled: 0, blocked: 0, failed: 0 };
    }
    return await this.reprocessUseCase.execute(batchSize, leaseDurationMs, this.workerId);
  }
}
