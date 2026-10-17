# Infraestrutura local

Branch `codex/local-infrastructure`, base exata `6acc7c3500af9bbd56c340aeca3ccdfcfa056aa1`.
Worktree: `D:\processadorApostasDistribuidas\.worktrees\local-infrastructure`.
Nenhum acesso remoto, push, merge ou publicação. Os arquivos existentes, inclusive
`docker-compose.yml` e `scripts/init-db.sql`, foram inspecionados e preservados.
Este Compose é independente: use sempre `-f docker-compose.local.yml`, sem combinar
com o Compose antigo. Requer Docker Engine e Compose v2 com suporte a condições de dependência.

## Subir e parar

Na raiz desta worktree:

```powershell
docker compose -f docker-compose.local.yml config
docker compose -f docker-compose.local.yml build --pull
docker compose -f docker-compose.local.yml up -d --wait --wait-timeout 180
docker compose -f docker-compose.local.yml ps -a
docker compose -f docker-compose.local.yml stop
docker compose -f docker-compose.local.yml down
```

`down` preserva `local_pgdata`. Não há exclusão automática de volumes nem comando
de reset. LocalStack é efêmero: as filas são recriadas ao subir; mensagens locais
podem ser perdidas ao recriar seu container. O banco permanece no volume nomeado
do projeto `wagers-local`, separado de `pgdata` do Compose antigo.

Portas publicadas apenas em loopback. Para mudar os padrões no PowerShell:

```powershell
$env:LOCAL_API_PORT = '3100'
$env:LOCAL_POSTGRES_PORT = '5544'
$env:LOCAL_SQS_PORT = '4567'
docker compose -f docker-compose.local.yml up -d --wait --wait-timeout 180
```

Padrões: API 3000, PostgreSQL 5433, SQS 4566. Nos containers as portas são sempre
3000, 5432 e 4566. Não há montagem do diretório de código ou de `.env` na imagem.
O `.dockerignore` usa lista de inclusão, excluindo Git, worktrees, segredos e dependências locais.

## Inicialização e credenciais locais

- Bun fixado em `1.4.3`, versão indicada pelo README existente e verificada neste
  host. Instalação via `bun install --frozen-lockfile`; imagem executa como `bun`.
- PostgreSQL `16.6-alpine`: `migration_user` / `local_migration_only`, banco
  `betting_db`. É o administrador exclusivamente local, usado pelo migrador.
- Runtime: `app_user` / `local_runtime_only`, sem superuser, criação de banco,
  criação de roles ou DDL. As migrations existentes concedem os privilégios por
  tabela e protegem o ledger. A aplicação não recebe credenciais administrativas.
- `infra/init-db.sql` roda somente na primeira criação do volume. Trocar senhas
  no YAML não altera um volume já inicializado; ajuste manualmente os roles no
  banco, sem apagar o volume. Não reutilize volumes do Compose antigo.
- `migrate` aguarda PostgreSQL saudável e executa o migrador SQL existente
  `bun run src/infrastructure/persistence/migrator.ts up`. Ele mantém
  `schema_migrations` e trava transacional advisory, aplicando somente versões novas.
  O `DatabaseMigrator` possui robustez aprimorada:
  - `connectionTimeoutMillis` finito no `pg.Pool` (padrão 3000ms), prevenindo travamento indefinido de socket.
  - Retentativas com backoff restritas exclusivamente à aquisição inicial de conexão contra erros transitórios (`ECONNREFUSED`, `57P03`), preservando a causa original.
  - Erros de execução SQL falham imediatamente na primeira tentativa, disparando `ROLLBACK` e abortando sem repetição.
  - Execução CLI encapsulada em bloco `try / catch / finally` que garante o encerramento do pool via `migrator.close()` e propaga código de saída não-zero em caso de erro.
  - Comprovado pela suíte automatizada `tests/unit/migrator-robustness.test.ts`.
- `queues` aguarda LocalStack saudável. A API só inicia após ambos os jobs
  concluírem com sucesso. O healthcheck consulta uma carteira pela rota existente:
  aceita carteira encontrada ou erro de domínio `WALLET_NOT_FOUND` após acesso real ao banco.
- Para reaplicar o bootstrap sem reiniciar os serviços:

```powershell
docker compose -f docker-compose.local.yml run --rm migrate
docker compose -f docker-compose.local.yml run --rm queues
```

## SQS local e contrato futuro

LocalStack fixado em `4.0.3`; AWS access key e secret `test`, região `us-east-1`,
conta `000000000000`. Nenhum segredo real. O cliente AWS CLI está na imagem
LocalStack; bootstrap usa `aws --endpoint-url http://localstack:4566`.
O entrypoint remove CR ao executar o shell montado, suportando checkout Windows
com CRLF sem alterar configurações Git do projeto.

Endpoint interno `SQS_ENDPOINT=http://localstack:4566`. Estratégia `path` e host
anunciado `localstack:4566` mantêm as URLs retornadas utilizáveis na rede Compose:

| Variável proposta | URL interna |
| --- | --- |
| WAGER_TRANSACTIONS_QUEUE_URL | http://localstack:4566/queue/us-east-1/000000000000/wager-transactions.fifo |
| WAGER_TRANSACTIONS_DLQ_URL | http://localstack:4566/queue/us-east-1/000000000000/wager-transactions-dlq.fifo |
| OUTBOX_EVENTS_QUEUE_URL | http://localstack:4566/queue/us-east-1/000000000000/wager-events.fifo |

As três filas são FIFO, com deduplicação por ID explícito. A fila de transações
tem redrive para a DLQ após 5 recebimentos. O bootstrap obtém o ARN real da DLQ,
cria filas idempotentemente e reaplica a política de redrive. Se uma fila
preexistente tiver atributos incompatíveis, falha explicitamente sem excluí-la.
A fila de eventos é independente, reservada para futura publicação da outbox.

Do host, use `http://localhost:<LOCAL_SQS_PORT>` como endpoint. URLs anunciadas
continuam internas; use os comandos abaixo dentro de `queues` para evitar
dependência de DNS no host.

## Validação e diagnóstico

```powershell
docker compose -f docker-compose.local.yml logs --tail=100 postgres migrate localstack queues app
docker compose -f docker-compose.local.yml exec postgres psql -U migration_user -d betting_db -c 'SELECT version, applied_at FROM schema_migrations ORDER BY version;'
docker compose -f docker-compose.local.yml exec -e PGPASSWORD=local_runtime_only postgres psql -h postgres -U app_user -d betting_db -c 'SELECT current_user, current_database(), count(*) FROM wallets;'
docker compose -f docker-compose.local.yml exec postgres psql -U migration_user -d betting_db -c "SELECT rolname, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname IN ('migration_user','app_user');"
docker compose -f docker-compose.local.yml exec postgres psql -U migration_user -d betting_db -c "SELECT has_schema_privilege('app_user','public','CREATE') AS runtime_ddl, has_table_privilege('app_user','wallet_ledger_entries','UPDATE') AS ledger_update;"
docker compose -f docker-compose.local.yml run --rm queues
docker compose -f docker-compose.local.yml run --rm --entrypoint aws queues --endpoint-url http://localstack:4566 sqs list-queues
docker compose -f docker-compose.local.yml run --rm --entrypoint aws queues --endpoint-url http://localstack:4566 sqs get-queue-attributes --queue-url http://localstack:4566/queue/us-east-1/000000000000/wager-transactions.fifo --attribute-names All
docker compose -f docker-compose.local.yml exec app id
docker compose -f docker-compose.local.yml exec app bun run infra/smoke-api.ts
```

Esperado: cinco migrations 001 a 005; runtime `app_user`; `runtime_ddl` e
`ledger_update` falsos; três filas FIFO, redrive com ARN da DLQ e maxReceiveCount 5;
UID da aplicação diferente de zero. O smoke faz POST `/wallets` (201), seguido de
GET `/wallets/:id` (200), e deixa uma carteira de saldo zero com identificador
aleatório para inspeção. Pode ser repetido sem colidir com dados anteriores.

Se a API não subir, examine primeiro os jobs `migrate` e `queues` com `ps -a`
e `logs`; depois o log da API. Não há dependência de AWS real ou credenciais do host.

Resultados validados com Docker Engine (2026-10-17):

| Verificação | Comando | Resultado |
| --- | --- | --- |
| `docker compose config` | `docker compose -f docker-compose.local.yml config` | OK: exit 0, cinco serviços, redes e volumes válidos |
| Build da imagem e instalação Linux | `docker compose -f docker-compose.local.yml build` | OK: exit 0, imagem `wagers-local-app:bun-1.4.3` gerada com Bun 1.4.3 |
| Subida, prontidão e execução sem root | `docker compose -f docker-compose.local.yml up -d --wait` / `exec app id` | OK: exit 0, todos os serviços saudáveis, UID `1000(bun)` não-root |
| Healthcheck TCP PostgreSQL | `pg_isready -h 127.0.0.1 -p 5432 -U migration_user -d betting_db` | OK: exit 0, valida conexão TCP antes de liberar migrador |
| Migrations aplicadas e idempotência | `docker compose -f docker-compose.local.yml logs migrate` | OK: 5 migrations (001 a 005) aplicadas; "No new migrations to apply" no reenvio |
| Consulta real ao PostgreSQL e privilégios | `psql -c ...` em roles e permissões | OK: `migration_user` admin; `app_user` sem superuser, DDL=false, ledger_update=false |
| Filas FIFO e Redrive SQS LocalStack | `sqs list-queues` e `sqs get-queue-attributes` | OK: 3 filas FIFO criadas, `wager-transactions.fifo` com redrive para DLQ (maxReceiveCount 5) |
| API POST/GET (smoke) | `docker compose -f docker-compose.local.yml exec app bun run infra/smoke-api.ts` | OK: exit 0, carteira criada (201) e consultada (200) com UUID válido |
| Primeira subida isolada (volume novo) | Projeto `wagers-fresh-test`, portas 3990/5439/4599 | OK: exit 0 de primeira sem ECONNREFUSED; volume e containers descartados após prova |

## Dependências de integração

A validação foi executada nesta máquina com Docker Engine local.
Não há integração SQS implementada na aplicação nesta etapa: os nomes propostos de
variáveis foram validados na infraestrutura para futuro consumo pelos marcos M14–M16.
Nenhum publisher, consumidor, inbox ou worker foi alterado fora do escopo desta infraestrutura.
