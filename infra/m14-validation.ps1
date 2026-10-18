param([ValidateSet('typecheck','m14','official','build','linux-m14','linux-official','up','smoke','down')][string]$Task)
$ErrorActionPreference = 'Stop'
$env:LOCAL_POSTGRES_PORT='15434'
$env:LOCAL_SQS_PORT='14567'
$env:LOCAL_API_PORT='13014'
$env:APP_IMAGE='m14-stabilization-app:local'
$env:TEST_IMAGE='m14-stabilization-test:local'
$env:APP_DB_HOST='127.0.0.1'
$env:APP_DB_PORT='15434'
$env:APP_DB_NAME='betting_db'
$env:APP_DB_USER='app_user'
$env:APP_DB_PASSWORD='local_runtime_only'
$env:MIGRATION_DB_HOST='127.0.0.1'
$env:MIGRATION_DB_PORT='15434'
$env:MIGRATION_DB_NAME='betting_db'
$env:MIGRATION_DB_USER='migration_user'
$env:MIGRATION_DB_PASSWORD='local_migration_only'
$env:AWS_ACCESS_KEY_ID='test'
$env:AWS_SECRET_ACCESS_KEY='test'
$env:AWS_REGION='us-east-1'
$env:SQS_ENDPOINT='http://127.0.0.1:14567'
$env:OUTBOX_EVENTS_QUEUE_URL='http://127.0.0.1:14567/queue/us-east-1/000000000000/wager-events.fifo'
$env:OUTBOX_PUBLISHER_ENABLED='false'
$env:PENDING_WORKER_ENABLED='false'
$compose=@('compose','-p','m14-stabilization','-f','docker-compose.local.yml','-f','infra/m14-validation.compose.yml')
switch ($Task) {
 'typecheck' { bun run typecheck }
 'm14' { bun run test:m14 }
 'official' { bun run test }
 'build' { docker @compose --profile test build app test-runner }
 'linux-m14' { docker @compose --profile test run --rm test-runner bun run test:m14 }
 'linux-official' { docker @compose --profile test run --rm test-runner bun run test }
 'up' { docker @compose up -d --wait app }
 'smoke' { bun run infra/smoke-api.ts }
 'down' { docker @compose down --volumes }
}
exit $LASTEXITCODE
