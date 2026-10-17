import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
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
  cancellationTimeoutMs?: number;
  workerId?: string;
}

@Injectable()
export class PendingReferenceWorkerService
  implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown
{
  private readonly logger = new Logger(PendingReferenceWorkerService.name);
  private isRunning = false;
  private isTickRunning = false;
  private isShuttingDown = false;
  private timer: NodeJS.Timeout | null = null;
  private activeExecutionPromise: Promise<ReprocessResult | null> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private abortController: AbortController | null = null;

  public readonly enabled: boolean;
  public readonly intervalMs: number;
  public readonly batchSize: number;
  public readonly leaseDurationMs: number;
  public readonly drainTimeoutMs: number;
  public readonly cancellationTimeoutMs: number;
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
    this.cancellationTimeoutMs =
      options?.cancellationTimeoutMs ??
      (Number(process.env.PENDING_WORKER_CANCELLATION_TIMEOUT_MS) || 5000);
    this.workerId =
      options?.workerId ??
      `worker-${crypto.randomUUID().slice(0, 8)}`;
  }

  public async onApplicationBootstrap(): Promise<void> {
    if (this.enabled) {
      this.start();
    }
  }

  public async onModuleDestroy(): Promise<void> {
    await this.handleShutdown('onModuleDestroy');
  }

  public async beforeApplicationShutdown(signal?: string): Promise<void> {
    await this.handleShutdown('beforeApplicationShutdown');
  }

  private async handleShutdown(phase: string): Promise<void> {
    if (this.shutdownPromise) {
      return await this.shutdownPromise;
    }

    this.shutdownPromise = (async () => {
      this.isShuttingDown = true;
      this.stop();

      if (this.activeExecutionPromise) {
        let drainTimeoutHandle: NodeJS.Timeout | null = null;
        const drainTimeoutPromise = new Promise<'timeout'>((resolve) => {
          drainTimeoutHandle = setTimeout(() => resolve('timeout'), this.drainTimeoutMs);
        });

        try {
          const res = await Promise.race([this.activeExecutionPromise, drainTimeoutPromise]);
          if (res === 'timeout') {
            this.logger.warn(
              `Worker drainage timed out after ${this.drainTimeoutMs}ms during ${phase}. Aborting active operations.`
            );
            if (this.abortController) {
              this.abortController.abort(new Error('DRAIN_TIMEOUT_EXCEEDED'));
            }

            // Await confirmation of rollback and execution completion before allowing ORM closure
            let cancellationHandle: NodeJS.Timeout | null = null;
            const cancellationTimeoutPromise = new Promise<'timeout'>((resolve) => {
              cancellationHandle = setTimeout(() => resolve('timeout'), this.cancellationTimeoutMs);
            });

            try {
              const cancelRes = await Promise.race([this.activeExecutionPromise, cancellationTimeoutPromise]);
              if (cancelRes === 'timeout') {
                this.logger.error(
                  `Active execution did not terminate within cancellation timeout of ${this.cancellationTimeoutMs}ms during ${phase}.`
                );
              } else {
                this.logger.log(
                  `Active execution successfully cancelled and terminated during ${phase}.`
                );
              }
            } finally {
              if (cancellationHandle) {
                clearTimeout(cancellationHandle);
              }
            }
          }
        } catch (err) {
          this.logger.error('Error draining in-flight worker batch during shutdown', err);
        } finally {
          if (drainTimeoutHandle) {
            clearTimeout(drainTimeoutHandle);
          }
        }
      }
    })();

    return await this.shutdownPromise;
  }

  public isAbortRequested(): boolean {
    return this.abortController?.signal.aborted ?? false;
  }

  public isShuttingDownStatus(): boolean {
    return this.isShuttingDown;
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
      await this.executeBatch(this.batchSize, this.leaseDurationMs);
    } catch (err) {
      this.logger.error('Worker tick execution error', err);
    } finally {
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
    this.abortController = new AbortController();
    const execPromise = this.reprocessUseCase.execute(
      batchSize,
      leaseDurationMs,
      this.workerId,
      this.abortController.signal
    );
    this.activeExecutionPromise = execPromise;
    try {
      return await execPromise;
    } finally {
      if (this.activeExecutionPromise === execPromise) {
        this.activeExecutionPromise = null;
      }
      this.abortController = null;
    }
  }
}
