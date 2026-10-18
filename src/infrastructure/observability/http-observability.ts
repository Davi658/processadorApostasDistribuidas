import type { NextFunction, Request, Response } from 'express';

const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/** Instance-local registry: never put request IDs, raw paths or payloads in labels. */
export class HttpObservability {
  private readonly series = new Map<string, { count: number; sum: number; buckets: number[] }>();
  constructor(private readonly write: (line: string) => void = line => console.log(line)) {}

  readonly middleware = (req: Request, res: Response, next: NextFunction): void => {
    const start = performance.now();
    // Matches the existing wager correlation policy without modifying transport headers.
    const correlationId = req.get('x-correlation-id')?.trim() || req.get('idempotency-key')?.trim() || null;
    res.once('finish', () => {
      const route = typeof req.route?.path === 'string' ? req.route.path : '__unmatched__';
      const method = methods.has(req.method) ? req.method : 'OTHER';
      const status = res.statusCode;
      const durationSeconds = Math.max(0, performance.now() - start) / 1000;
      const labels = `method="${method}",route="${escape(route)}",status="${status}"`;
      let item = this.series.get(labels);
      if (!item) {
        item = { count: 0, sum: 0, buckets: buckets.map(() => 0) };
        this.series.set(labels, item);
      }
      item.count++;
      item.sum += durationSeconds;
      buckets.forEach((bound, index) => { if (durationSeconds <= bound) item!.buckets[index]++; });
      // Explicit allowlist; neither requests, responses nor exceptions are serialized.
      try { this.write(JSON.stringify({ correlationId, method, route, status, durationMs: durationSeconds * 1000 })); }
      catch { /* A failed log sink must not affect the financial request. */ }
    });
    next();
  };

  render(): string {
    const lines = [
      '# HELP http_requests_total Completed HTTP requests', '# TYPE http_requests_total counter',
      '# HELP http_request_duration_seconds HTTP request duration in seconds', '# TYPE http_request_duration_seconds histogram',
    ];
    for (const [labels, item] of this.series) {
      lines.push(`http_requests_total{${labels}} ${item.count}`);
      buckets.forEach((bound, index) => lines.push(`http_request_duration_seconds_bucket{${labels},le="${bound}"} ${item.buckets[index]}`));
      lines.push(`http_request_duration_seconds_bucket{${labels},le="+Inf"} ${item.count}`,
        `http_request_duration_seconds_sum{${labels}} ${item.sum}`,
        `http_request_duration_seconds_count{${labels}} ${item.count}`);
    }
    return lines.join('\n') + '\n';
  }
}
