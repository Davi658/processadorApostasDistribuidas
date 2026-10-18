param([string]$Project = 'delivery-validation-20261018', [int]$PostgresPort = 55592, [int]$SqsPort = 45692, [string]$EvidenceDirectory = 'docs/evidence/delivery')
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$env:COMPOSE_PROJECT_NAME = $Project
$env:APP_IMAGE = 'delivery-final-app:20261018'
$env:TEST_IMAGE = 'delivery-final-tests:20261018'
$env:LOCAL_POSTGRES_PORT = "$PostgresPort"
$env:LOCAL_SQS_PORT = "$SqsPort"
$env:LOCAL_API_PORT = '3092'
$env:APP_DB_HOST = '127.0.0.1'; $env:APP_DB_PORT = "$PostgresPort"
$env:APP_DB_USER = 'app_user'; $env:APP_DB_PASSWORD = 'local_runtime_only'
$env:MIGRATION_DB_USER = 'migration_user'; $env:MIGRATION_DB_PASSWORD = 'local_migration_only'
$env:SQS_ENDPOINT = "http://127.0.0.1:$SqsPort"
$env:AWS_ACCESS_KEY_ID = 'test'; $env:AWS_SECRET_ACCESS_KEY = 'test'
$env:OUTBOX_PUBLISHER_ENABLED = 'false'; $env:SQS_CONSUMER_ENABLED = 'false'; $env:PENDING_WORKER_ENABLED = 'false'
Remove-Item Env:DB_NAME -ErrorAction SilentlyContinue
$directory = $EvidenceDirectory
New-Item -ItemType Directory -Force $directory | Out-Null
function Step([string]$Name, [string]$Program, [string[]]$Arguments) {
  $file = "$directory/$Name.txt"
  if (Test-Path $file) { throw "Evidence already exists: $file. Preserve it and choose a new step name." }
  $started = [DateTime]::UtcNow
  & $Program @Arguments *> $file
  $code = $LASTEXITCODE
  @{ name=$Name; command=@($Program)+$Arguments; exitCode=$code; started=$started.ToString('o'); ended=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress | Add-Content "$directory/attempts.jsonl"
  Write-Host "$Name exit=$code"
  if ($code -ne 0) { throw "Failed $Name; see $file" }
}
Step 'install' 'bun' @('install','--frozen-lockfile')
Step 'config' 'docker' @('compose','config','--quiet')
Step 'build' 'docker' @('compose','build','app','test-runner')
Step 'test-infra' 'docker' @('compose','up','-d','--wait','postgres','localstack')
Step 'typecheck' 'bun' @('run','typecheck')
Step 'affected' 'bun' @('run','scripts/run-tests.ts','tests/unit/delivery-metrics.test.ts','tests/unit/external-wager-contract.test.ts','tests/integration/external-wager-contract.test.ts','tests/integration/migrations.test.ts','tests/integration/ledger-constraints-m12.test.ts','tests/integration/terminal-protection-m11.test.ts','tests/integration/wager-win-loss-m06.test.ts','tests/observability','tests/concurrency')
Step 'windows-official' 'bun' @('run','test')
Step 'linux-official' 'docker' @('compose','run','--rm','--no-deps','-e','APP_DB_HOST=postgres','-e','APP_DB_PORT=5432','-e','SQS_ENDPOINT=http://localstack:4566','test-runner','bun','run','test')
Step 'financial-smoke' 'bun' @('run','scripts/m15-financial-smoke.ts')
# Retain the exclusive infrastructure for inspection. Never remove volumes here.
