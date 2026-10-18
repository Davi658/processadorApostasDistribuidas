// Readiness checks PostgreSQL and only the SQS queues required by enabled components.
const response = await fetch('http://127.0.0.1:3000/health/ready', { signal: AbortSignal.timeout(2000) });
if (response.status !== 200) throw new Error('Application unavailable');
export {};
