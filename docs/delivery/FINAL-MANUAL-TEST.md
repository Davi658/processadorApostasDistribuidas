# Conferência pessoal do candidato

Este roteiro é para execução pessoal do candidato. Não foi executado nem marcado como realizado pelo agente. As validações automatizadas separadas estão em `docs/evidence/delivery/RESULTS.md`. Nenhum comando publica ou envia o desafio.

Use PowerShell **7+** (os scripts usam `-SkipHttpErrorCheck`), Git, Bun **1.4.3**, Docker Desktop com engine Linux, Compose v2 e portas livres. Imagens fixadas: PostgreSQL **16.6-alpine**, LocalStack **4.0.3**, oven/bun **1.4.3**. Disponibilize internet na primeira instalação/build. O projeto não depende de AWS real. Os segredos abaixo são exclusivamente locais e descartáveis.

## 1. Preparar projeto pessoal exclusivo

Abra PowerShell na worktree final informada na entrega, não em outra revisão. Confira SHA e versões:

```powershell
Set-Location D:\processadorApostasDistribuidas\.worktrees\delivery-final
git rev-parse HEAD
git status --short
bun --version
docker version
docker compose version
$PSVersionTable.PSVersion
bun install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'Install failed' }

# Altere portas se ocupadas. Mantenha este terminal e estas variáveis em todas as etapas.
$env:COMPOSE_PROJECT_NAME = "wagers-personal-$((Get-Date).ToString('yyyyMMddHHmmss'))"
$env:LOCAL_API_PORT = '3093'
$env:LOCAL_POSTGRES_PORT = '55593'
$env:LOCAL_SQS_PORT = '45693'
$env:APP_IMAGE = "$($env:COMPOSE_PROJECT_NAME)-app:personal"
$env:TEST_IMAGE = "$($env:COMPOSE_PROJECT_NAME)-tests:personal"
$env:DELIVERY_SQS_ENDPOINT = "http://127.0.0.1:$($env:LOCAL_SQS_PORT)"
$api = "http://127.0.0.1:$($env:LOCAL_API_PORT)"
docker compose config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Compose config failed' }
docker compose build app
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
docker compose up -d --wait app
if ($LASTEXITCODE -ne 0) { throw 'Startup failed; collect logs below' }
docker compose ps -a
docker compose logs --no-color migrate queues
```

Esperado: postgres/localstack/app saudáveis; migrate/queues terminam com exit 0; primeira aplicação das migrations **001–010**. Projeto novo cria volume PostgreSQL novo; não reutilize o nome de outro projeto. Não rode a suíte oficial neste projeto pessoal: o runner de regressão usa projeto separado e bancos descartáveis.

## 2. Health e métricas

```powershell
Invoke-RestMethod "$api/health/live"
Invoke-RestMethod "$api/health/ready"
(Invoke-WebRequest "$api/metrics").Content
```

Esperado: ambos retornam HTTP 200. Métricas exibem HELP/TYPE de invocações e latência; após coleta, `financial_transactions` reflete linhas persistidas por status, outbox gauges refletem backlog e DLQ visible é aproximado. Nenhuma série `sqs_dlq_messages_total`. Histograma financeiro mede entrada→finally; não representa latência do commit externo ou delete SQS. Veja [semântica completa](OBSERVABILITY.md).

## 3. Carteira, BET, replay, conflito e consultas

```powershell
./scripts/delivery-personal-http.ps1 -Api $api
$s = Get-Content .data/personal/state.json -Raw | ConvertFrom-Json
Invoke-RestMethod "$api/wallets/$($s.walletId)"
Invoke-RestMethod "$api/wagering/transactions/$($s.httpTransactionId)"
Invoke-RestMethod "$api/wallets/$($s.walletId)/ledger?limit=50"
```

O script cria carteira com `100.00`, aplica BET `10.00`, verifica replay com mesmo transactionId e conflito HTTP 409 ao mudar o valor para `11.00`. Esperado: saldo `90.00`, versão 2, dois lançamentos (OPENING e BET). A consulta da transação tem id igual ao retornado no BET. O script grava somente fixtures pessoais em `.data/personal/`; não execute novamente para recuperar estado, pois criará outra carteira.

## 4. SQS no contrato exigido e duplicata persistente

```powershell
Get-Content .data/personal/command.json
bun run scripts/delivery-send-command.ts .data/personal/command.json
if ($LASTEXITCODE -ne 0) { throw 'SQS send failed' }
Start-Sleep -Seconds 3
bun run scripts/delivery-send-command.ts .data/personal/command.json
if ($LASTEXITCODE -ne 0) { throw 'SQS resend failed' }
$deadline = (Get-Date).AddSeconds(60)
do {
  $wallet = Invoke-RestMethod "$api/wallets/$($s.walletId)"
  if ($wallet.balance.amount -eq '85.00') { break }
  Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)
if ($wallet.balance.amount -ne '85.00') { throw 'Consumer did not produce expected balance' }
Invoke-RestMethod "$api/providers/personal/wagering/transactions/$($s.externalTransactionId)"
docker compose exec -T postgres psql -U migration_user -d betting_db -c "SELECT consumer_name, command_id, transaction_id, message_id FROM command_inbox WHERE command_id='$($s.commandId)';"
```

Fixture externa válida, gerada pelo script (IDs e horário variam):

```json
{"messageId":"personal-opaque-id","type":"WagerTransactionRequested","occurredAt":"2026-10-18T12:00:00.000Z","data":{"providerId":"personal","externalTransactionId":"bet-sqs","idempotencyKey":"personal:bet-sqs","playerId":"20000000-0000-4000-8000-000000000001","walletId":"30000000-0000-4000-8000-000000000001","roundId":"manual","gameId":"manual","kind":"BET","money":{"amount":"5.00","currency":"BRL"}}}
```

Use a fixture gerada, cujos IDs existem, para enviar. A chave financeira vem de `data.idempotencyKey`. O script usa novo dedup ID de transporte em cada envio externo para exercitar inbox sem depender da deduplicação temporária FIFO. Esperado: uma inbox no namespace externo, uma BET de fila, um débito `5.00`; saldo permanece `85.00` após duplicata. `message_id` na tabela é SQS MessageId do primeiro envio aceito; `command_id` contém o messageId lógico externo. ReceiptHandle não aparece em logs.

## 5. REFUND antes da referência, worker real e publicação

```powershell
$reference = [guid]::NewGuid().ToString()
$pendingKey = [guid]::NewGuid().ToString()
$body = @{providerId='personal';externalTransactionId=[guid]::NewGuid().ToString();playerId=$s.playerId;walletId=$s.walletId;roundId='manual';gameId='manual';kind='REFUND';money=@{amount='2.00';currency='BRL'};referenceExternalTransactionId=$reference}
$pending = Invoke-WebRequest "$api/wagering/transactions" -Method Post -ContentType 'application/json' -Headers @{'idempotency-key'=$pendingKey} -Body ($body | ConvertTo-Json -Depth 5) -SkipHttpErrorCheck
if ($pending.StatusCode -ne 202) { throw "Expected pending 202: $($pending.Content)" }
$pendingId = ($pending.Content | ConvertFrom-Json).transactionId
$body.Remove('referenceExternalTransactionId')
$body.kind='BET'; $body.externalTransactionId=$reference
Invoke-RestMethod "$api/wagering/transactions" -Method Post -ContentType 'application/json' -Headers @{'idempotency-key'=[guid]::NewGuid().ToString()} -Body ($body | ConvertTo-Json -Depth 5)
$deadline = (Get-Date).AddSeconds(90)
do {
  $resolved = Invoke-RestMethod "$api/wagering/transactions/$pendingId"
  if ($resolved.status -eq 'PROCESSED') { break }
  Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)
if ($resolved.status -ne 'PROCESSED') { throw 'Pending-reference worker did not resolve REFUND' }
docker compose exec -T postgres psql -U migration_user -d betting_db -c "SELECT t.id, t.status, l.id AS ledger_id FROM wager_transactions t LEFT JOIN wallet_ledger_entries l ON l.transaction_id=t.id WHERE t.wallet_id='$($s.walletId)' ORDER BY t.created_at;"
docker compose exec -T postgres psql -U migration_user -d betting_db -c "SELECT id,event_type,published_at FROM outbox_messages WHERE aggregate_id='$($s.walletId)' ORDER BY occurred_at;"
docker compose exec -T localstack awslocal sqs get-queue-attributes --queue-url http://localstack:4566/queue/us-east-1/000000000000/wager-events.fifo --attribute-names ApproximateNumberOfMessages
```

Esperado: REFUND 202 sem débito/crédito enquanto falta referência; BET `2.00` debita e worker devolve `2.00`, terminando com saldo `85.00`. REFUND e BET têm IDs distintos e cada um seu ledger. Publisher habilitado marca os eventos publicados (aguarde até 60 s se necessário); fila de eventos contém mensagens. Nenhum SQL acima resolve referência ou marca publicação manualmente. Repetir o REFUND com mesma key continua devolvendo seu snapshot original de aceite; para ver o estado atual use a consulta por ID.

## 6. Reconciliação, segunda subida e persistência

```powershell
$before = Invoke-RestMethod "$api/wallets/$($s.walletId)"
$beforeLedger = Invoke-RestMethod "$api/wallets/$($s.walletId)/ledger?limit=50"
Invoke-RestMethod "$api/wallets/$($s.walletId)/reconciliation" -Method Post
docker compose up -d --wait app
if ($LASTEXITCODE -ne 0) { throw 'Second startup failed' }
docker compose stop app
docker compose restart postgres
docker compose up -d --wait app
if ($LASTEXITCODE -ne 0) { throw 'Restart failed' }
$deadline=(Get-Date).AddSeconds(90)
do {
  try { $ready = Invoke-WebRequest "$api/health/ready" -SkipHttpErrorCheck; if ($ready.StatusCode -eq 200) { break } } catch {}
  Start-Sleep -Seconds 1
} while ((Get-Date) -lt $deadline)
$after = Invoke-RestMethod "$api/wallets/$($s.walletId)"
$afterLedger = Invoke-RestMethod "$api/wallets/$($s.walletId)/ledger?limit=50"
if (($before | ConvertTo-Json -Depth 8 -Compress) -ne ($after | ConvertTo-Json -Depth 8 -Compress)) { throw 'Wallet changed during restart' }
if (($beforeLedger | ConvertTo-Json -Depth 8 -Compress) -ne ($afterLedger | ConvertTo-Json -Depth 8 -Compress)) { throw 'Ledger IDs/records changed during restart' }
Invoke-RestMethod "$api/wallets/$($s.walletId)/reconciliation" -Method Post
docker compose logs --no-color migrate
```

Esperado: saldo armazenado/calculado `85.00`, diferença `0.00`, consistent true, cinco lançamentos e cinco transações (OPENING, HTTP BET, SQS BET, BET referência e REFUND). Segunda aplicação não repete migrations; reinício conserva IDs, saldo e versão. O LocalStack deste Compose não é armazenamento durável de produção; este reinício preserva o contêiner do broker e verifica persistência PostgreSQL.

## 7. Diagnóstico e encerramento

```powershell
New-Item -ItemType Directory -Force .data/personal/logs | Out-Null
docker compose ps -a | Set-Content .data/personal/logs/status.txt
docker compose logs --no-color --timestamps app migrate queues postgres localstack *> .data/personal/logs/compose.txt
git rev-parse HEAD | Set-Content .data/personal/logs/source-sha.txt
(Invoke-WebRequest "$api/metrics").Content | Set-Content .data/personal/logs/metrics.txt
docker compose stop
```

`stop` preserva contêineres, filas e volume. Para retomar, mantenha as mesmas variáveis e execute `docker compose up -d --wait app`. Não use `down -v`, prune ou scripts de limpeza global. Não publique os arquivos de diagnóstico sem revisar seus metadados.

Autenticação HTTP foi omitida conforme permitido na seção 2. O ponto de extensão é `ProviderIdentityPort`, para um adapter OIDC/JWKS e guard nas rotas financeiras; health permanece público e SQS é canal interno confiável com validação de domínio. Não há validação AWS de produção, IAM real ou promessa exactly-once. O envio final e esta conferência pessoal permanecem sob responsabilidade do candidato.
