import type { OperationalObservabilityPort } from '../../application/ports/operational-observability';
/** Allowlist lifecycle logger: legacy exception arguments are deliberately not serialized. */
export class OperationalLogger {
  constructor(private readonly component: 'publisher' | 'references', private readonly telemetry?: OperationalObservabilityPort) {}
  private emit(result: 'warning' | 'failure'): void {
    if (this.telemetry) { this.telemetry.event(this.component, 'lifecycle', result); return; }
    try { console.log(JSON.stringify({ component: this.component, operation: 'lifecycle', result, correlationId: null, durationMs: 0 })); }
    catch { /* A sink failure must not interrupt drain. */ }
  }
  warn(..._ignored: unknown[]): void { this.emit('warning'); }
  error(..._ignored: unknown[]): void { this.emit('failure'); }
}
