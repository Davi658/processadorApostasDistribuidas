import type { OperationalObservabilityPort } from '../../application/ports/operational-observability';
import { OperationalLogger } from '../observability/operational-logger';
import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
  BeforeApplicationShutdown,
  Optional,
} from '@nestjs/common';
import {
  ReprocessPendingReferencesUseCase,
  ReprocessResult,
} from '../../application/use-cases/reprocess-pending-references.use-case';

export interface PendingReferenceWorkerOptions {
  telemetry?: OperationalObservabilityPort;
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
  private readonly logger: OperationalLogger;
  private isRunning = false;
  private isTickRunning = false;
  private isShuttingDown = false;
  private timer: NodeJS.Timeout | null = null;
  private activeExecutionPromise: Promise<ReprocessResult> | null = null;
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
    this.logger = new OperationalLogger('references', options?.telemetry);
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

            // This is a diagnostic deadline, never permission to close an ORM
            // still owned by an execution. SQL waits are bounded by PostgreSQL.
            const warning = setTimeout(() => {
              this.logger.error(`Cancellation still pending after ${this.cancellationTimeoutMs}ms during ${phase}; waiting for execution termination.`);
            }, this.cancellationTimeoutMs);
            try {
              await this.activeExecutionPromise;
            } finally {
              clearTimeout(warning);
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
    if (this.isRunning || this.isShuttingDown) return;
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
    // A worker owns at most one execution, including manual executeBatch calls.
    if (this.activeExecutionPromise) return await this.activeExecutionPromise;
    const controller = new AbortController();
    this.abortController = controller;
    const execPromise = this.reprocessUseCase.execute(
      batchSize,
      leaseDurationMs,
      this.workerId,
      controller.signal
    );
    this.activeExecutionPromise = execPromise;
    try {
      return await execPromise;
    } finally {
      if (this.activeExecutionPromise === execPromise) {
        this.activeExecutionPromise = null;
      }
      if (this.abortController === controller) this.abortController = null;
    }
  }
}
