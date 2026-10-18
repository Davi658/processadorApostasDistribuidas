
Entrega atual: consulte [contrato externo confirmado](EXTERNAL-CONTRACT.md). A proposta abaixo é histórica; o consumidor aceita também WagerTransactionRequested e a migration 010 preserva identidades textuais.

# M16 — retry, visibility, DLQ and shutdown

Base: `ce23c14cd8a277b1e2308c3ff85fc1562c0f701d` (`origin/main`, fetched before creating `codex/m16-sqs-reliability`). M15: `cba6b6c`. No schema change.

## Result policy

| Result | Transport action |
| --- | --- |
| Durable PROCESSED, REJECTED, PENDING_REFERENCE | Delete only after external inbox/financial UoW returns from confirmed commit. |
| Validated duplicate | Inbox verifies fingerprint and durable transaction snapshot; delete without another financial execution. A pending snapshot stays the reference worker's responsibility. |
| Transient SQL/network failure | No delete. Set bounded exponential retry visibility from broker ApproximateReceiveCount. |
| Invalid command, permanent conflict, unavailable historical snapshot, persistent unknown error | No fabricated financial rejection. Same bounded transport delay; native redrive eventually moves original command to DLQ. |
| Unknown commit outcome or failed delete | Keep durable data; no compensating financial write. Redelivery reconciles through inbox and financial uniqueness. |

`classifyConsumerFailure` follows cause/originalError/driverException/driverError with cycle protection. It recognizes PostgreSQL serialization/deadlock/lock/statement/connection/capacity/shutdown codes and network connection errors. Domain conflict, missing wallet, money validation and snapshot unavailability are permanent. Unrecognized failures remain UNKNOWN, never a synthesized business rejection. Logs contain stage, classification and numeric receive count, without body, receipt, raw error or credentials.

Receive count is SQS transport metadata, not `wager_transactions.attempts`. An accepted financial pending reference initially has attempts=1 under existing domain rules; transport failures before commit do not add attempts. No process-local redelivery budget exists.

## Visibility and native redrive

The enabled consumer checks the source queue's `FifoQueue` and native `RedrivePolicy` before polling; destination must have a FIFO ARN and maxReceiveCount in the SQS range 1–1000. The consumer requires source-queue permissions for GetQueueAttributes, ReceiveMessage, DeleteMessage and ChangeMessageVisibility; it requires no SendMessage permission for the DLQ. Provisioning remains in `infra/bootstrap-sqs.sh`: command FIFO points to command DLQ FIFO with maxReceiveCount=5. The consumer never forwards to DLQ and does not consume it.

| Setting | Default | Constraint |
| --- | --- | --- |
| SQS_REQUEST_TIMEOUT_MS | 5000 | Greater than 1 second (long polling wait); less than visibility minus renewal interval. |
| SQS_CONSUMER_VISIBILITY_SECONDS | 30 | Positive integer, at most 43200. Explicit on ReceiveMessage. |
| SQS_CONSUMER_RENEWAL_MS | 10000 | Positive integer; renewal + network timeout strictly below visibility. |
| SQS_CONSUMER_RETRY_BASE_SECONDS | 2 | Positive integer, at most retry maximum. |
| SQS_CONSUMER_RETRY_MAX_SECONDS | 300 | Positive integer, at most 43200. |
| SQS_CONSUMER_DRAIN_TIMEOUT_MS | 10000 | Positive integer, at most 2147483647. Deadline requests UoW cancellation; does not authorize premature resource closure. |

Retry delay is min(maximum, base × 2^(receiveCount−1)), with exponent safely capped at 20. Invalid/persistent failures also use delay, preventing a hot loop before native redrive. Failed visibility updates leave broker expiry in effect. No local immediate transaction retry loop.

Renewals use the current delivery's receipt and recursive timers, scheduling only after the previous request settles. They continue through UoW, commit confirmation and delete. Finally clears the timer and awaits the active request. Before retry visibility is set, the renewal loop is stopped and awaited, preventing a late renewal from replacing backoff.

Production measures the finite 12-hour visibility window conservatively from the start of ReceiveMessage, reserving network timeout plus a second. Each extension is clipped to the remaining window. A failed extension or exhausted window records uncertain ownership and stops extensions. Processing may still finish: inbox locks, idempotency keys and database constraints protect money. Visibility never establishes exclusive financial ownership.

## Shutdown

Nest's existing SIGTERM hooks call onModuleDestroy before resource shutdown. Consumer blocks new manual work and receives, aborts long polling, wakes poll delay, then waits for its poll, direct executions, deletes and renewal requests. At the drain deadline, each consumer-owned execution's AbortController requests cancellation on the **external** inbox UoW. M10's captured transaction context handles cancellation independently of the abort caller's ALS, including rollback-only checks before flush/COMMIT. Already-dispatched COMMIT is awaited under M10 rules. A failed acknowledgement now leaves commit_unknown rather than claiming rollback; only the working phase executes rollback. A real-commit regression holds confirmation through cancellation and then loses it, proving unchanged durable data on redelivery.

SQL/lock waits remain bounded by existing DB_LOCK_TIMEOUT_MS / DB_STATEMENT_TIMEOUT_MS. Shutdown can exceed the drain deadline while real work terminates. It never closes ORM to interrupt unknown financial work. Consumer destroys only an internally created SQS client; borrowed clients and publisher resources remain available. ORM closes in onApplicationShutdown after consumer draining. No early visibility release is performed.

## Proofs

`tests/integration/sqs-consumer-m16.test.ts` uses disposable PostgreSQL databases and random FIFO queues on exclusive infrastructure. Fault injection wraps selected SQS calls; all actual delivery, visibility expiry and redrive use LocalStack.

| Requirement | Proof |
| --- | --- |
| A | Hold before_commit, observe eight successful broker extensions beyond original visibility, competing receive empty; complete state unchanged on replay. |
| B | Renewal fails; real broker redelivers to second consumer while first holds inbox transaction; one transaction/ledger by ID and wallet reconciled. |
| C | Inject SQLSTATE 40001 inside external UoW; rollback and real delayed redelivery with increasing receive count; real retries have delays [1,2,2] at a configured 2-second cap; immediate broker receives stay empty; pending attempts stay at domain initial value on replay. |
| D/E | Real long polling is aborted on shutdown and new receives/work are blocked; FIFO source attributes checked against random FIFO DLQ ARN; invalid and persistent failures pass through native maxReceiveCount=2, bodies compared exactly; business rejection is confirmed and DLQ empty. |
| F/J | Fail DeleteMessage after commit for processed and pending commands; broker redelivers; complete wallet, transactions, ledger, outbox and inbox rows compared. |
| G | Linux child process with Nest SIGTERM hooks and real pre/post commit barriers. Observe cancellation request before release; drain precedes ORM close; rollback or committed result recovered uniquely. Explicitly skipped on Windows. |
| H | External PostgreSQL connection holds advisory transaction lock. Shutdown timeout aborts captured consumer UoW while SQL is waiting; release lock after cancellation observed; verify complete rollback and successful broker recovery. |
| I | Hold a real visibility request in flight while delete completes. Shutdown stays pending until request ends; subsequent broker polling verifies no renewal timer survives. Borrowed client destroy would fail the test. |
| K | Fail and shut down consumer, then resolve pending reference and publish financial outbox to separate real FIFO queue using the same borrowed SQS client; reconcile wallet. |

Existing M15 assertions and deadlines, M14 and M10 suites remain unchanged. M15 fixture now provisions its own native FIFO DLQ and awaits asynchronous startup validation. No test deadline was increased. The synthetic fixture includes initial funding transactions; uniqueness checks target command transaction IDs rather than total wallet rows.

Validation commands and exit codes are recorded in [Windows results](../evidence/m16/win32/results.json) and [Linux results](../evidence/m16/linux/results.json). Raw logs for the latest runs stay local (`*.log` ignored); result manifests retain all attempts with SHA-256 hashes and test summaries. Platform broker-financial-audit.json files contain only synthetic record IDs, complete-state hashes, redrive attributes, original/DLQ body hashes and Linux process lifecycle evidence. The audit never stores command bodies, financial payloads or receipts.

## Reproduce with exclusive services

Use a new compose project, not a preexisting service/volume:

```powershell
$env:COMPOSE_PROJECT_NAME='wagers-m16'
$env:LOCAL_POSTGRES_PORT='54316'
$env:LOCAL_SQS_PORT='45616'
docker compose -f docker-compose.local.yml up -d postgres localstack
# Wait for both health checks to report healthy.
$env:APP_DB_PORT='54316'
$env:APP_DB_PASSWORD='local_runtime_only'
$env:MIGRATION_DB_PORT='54316'
$env:MIGRATION_DB_USER='migration_user'
$env:MIGRATION_DB_PASSWORD='local_migration_only'
$env:SQS_ENDPOINT='http://127.0.0.1:45616'
bun run scripts/m16-validation.ts
```

The validated Linux tester image uses Bun 1.4.3, installs bun.lock with --frozen-lockfile, and mounts only the dedicated evidence directory. It runs as container root to write /app/docs; all financial SQL still uses the restricted app_user role. Run Linux only after Windows completes, on network `wagers-m16_default`, with DB hosts `postgres`, ports 5432, SQS endpoint `http://localstack:4566`, and equivalent test credentials. `scripts/m16-validation.ts` runs typecheck, dedicated M16 suite, official suite and financial smoke sequentially, recording individual exit codes. Tear down only the dedicated compose project after all executions finish.

Limitations: LocalStack is a broker integration proof, not an AWS production availability or 12-hour soak test. The finite renewal boundary is enforced by code; database constraints remain authoritative. FIFO redrive can break ordering relative to messages already moved to DLQ; operational diagnosis/replay remains manual and out of scope. Transport redrive thresholds belong to queue configuration. No M18 integration, DLQ worker, automatic dead-message replay, push, merge or publication is included.
