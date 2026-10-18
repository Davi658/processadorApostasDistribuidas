import { Controller, Get, Inject, ServiceUnavailableException, Header, OnModuleDestroy } from '@nestjs/common';
import { MikroOrmUnitOfWork } from '../persistence/mikro-orm/mikro-orm-adapter';
import { HttpObservability } from './http-observability';

/** Borrows the existing pool and SQS clients; drains probes before resource close. */
export class PostgresReadiness implements OnModuleDestroy {
  private stopping = false;
  async onModuleDestroy(): Promise<void> { this.stopping = true; await this.inFlight?.catch(() => {}); }
  private inFlight?: Promise<void>;
  constructor(private readonly uow: MikroOrmUnitOfWork, private readonly timeoutMs = 500, private readonly dependencies: Array<() => Promise<void>> = []) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid readiness timeout');
  }

  async check(): Promise<void> {
    if (this.stopping) throw new Error('SHUTTING_DOWN');
    if (!this.inFlight) {
      const query = Promise.resolve().then(async () => {
        const knex = this.uow.getOrm().em.getConnection().getKnex();
        const results = await Promise.allSettled([knex.raw('SELECT 1').timeout(this.timeoutMs, { cancel: true }), ...this.dependencies.map(check => check())]);
        if (results.some(result => result.status === 'rejected')) throw new Error('DEPENDENCY_UNAVAILABLE');
      });
      this.inFlight = query;
      void query.finally(() => { if (this.inFlight === query) this.inFlight = undefined; }).catch(() => {});
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.inFlight, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Readiness deadline exceeded')), this.timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}

@Controller()
export class ObservabilityController {
  constructor(
    @Inject(PostgresReadiness) private readonly readiness: PostgresReadiness,
    @Inject(HttpObservability) private readonly http: HttpObservability,
  ) {}

  @Get('health/live')
  live() { return { status: 'ok' }; }

  @Get('health/ready')
  async ready() {
    try { await this.readiness.check(); return { status: 'ok' }; }
    catch { throw new ServiceUnavailableException({ status: 'unavailable' }); }
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async metrics() { return await this.http.render(); }
}
