$ErrorActionPreference = 'Stop'
$env:APP_DB_HOST='127.0.0.1'; $env:APP_DB_PORT='55448'; $env:APP_DB_USER='app_user'; $env:APP_DB_PASSWORD='app_user_secret'
$env:MIGRATION_DB_USER='postgres'; $env:MIGRATION_DB_PASSWORD='m18-exclusive'; $env:SQS_ENDPOINT='http://127.0.0.1:45628'
$env:AWS_ACCESS_KEY_ID='test'; $env:AWS_SECRET_ACCESS_KEY='test'
$env:OUTBOX_PUBLISHER_ENABLED='false'; $env:SQS_CONSUMER_ENABLED='false'; $env:PENDING_WORKER_ENABLED='false'
& bun run scripts/m18-validate.ts
exit $LASTEXITCODE
