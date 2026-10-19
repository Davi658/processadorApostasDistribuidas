# Processador financeiro de apostas distribuídas

Backend de avaliação técnica para carteiras, apostas, ganhos, perdas e reversões. Usa valores decimais exatos, ledger, idempotência persistente, referências fora de ordem e mensageria transacional com TypeScript/Bun, NestJS, MikroORM, PostgreSQL real e SQS FIFO via LocalStack.

O escopo é consistência financeira e recuperação sob concorrência/falhas. A autenticação foi omitida para concentrar a avaliação no motor financeiro. O ponto de extensão é a porta `ProviderIdentityPort` com um adaptador OIDC/JWKS e Guard antes dos controllers, com autorização de acesso a carteiras/provedores, antes de exposição externa. Não há garantia exactly-once, operação AWS de produção certificada ou processamento automático de DLQ.

## Pré-requisitos e versões

Git, Docker com containers Linux, Compose com `--wait`, acesso aos registries e portas locais livres. Não é necessário Bun ou PostgreSQL no host nem `.env` pessoal. Execute da raiz do clone em terminal novo.

Ambiente desta revisão: Windows, Docker Desktop 4.95.0, Engine 29.8.2, Compose 5.6.0, containers Linux/amd64. Imagens: Bun 1.4.3, PostgreSQL 16.6-alpine e LocalStack 4.0.3. Versões exatas das dependências: [bun.lock](bun.lock). Resultados efetivamente obtidos: [validação](docs/review/VALIDATION.md). O bloco Bash é equivalente; não significa nova validação em host Linux nativo.

## Avaliação rápida — executar do zero

No host, PowerShell (Windows) ou Bash (Linux):

```text
git clone https://github.com/Davi658/processadorApostasDistribuidas.git
cd processadorApostasDistribuidas
```

Use checkout limpo. Confira `docker ps -a` e `docker volume ls`: projeto `wagers-review-20261018`, imagens e portas 55478, 45678 e 3078 devem estar livres. Se já existirem, escolha outro nome e portas na configuração e substitua também `-p wagers-review-20261018` em **todos** os comandos. Não reutilize volume de outra avaliação.

### 1. Configuração no host

PowerShell, Windows (testado com 7.6.7; gera arquivo ignorado pelo Git, somente valores locais):

```powershell
'COMPOSE_PROJECT_NAME','APP_IMAGE','TEST_IMAGE','LOCAL_API_PORT','LOCAL_POSTGRES_PORT','LOCAL_SQS_PORT' | ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
@'
APP_IMAGE=wagers-review-20261018-app:local
TEST_IMAGE=wagers-review-20261018-test:local
LOCAL_API_PORT=3078
LOCAL_POSTGRES_PORT=55478
LOCAL_SQS_PORT=45678
'@ | Set-Content -Encoding ascii .env.local
```

Alternativa Bash, Linux:

```bash
unset COMPOSE_PROJECT_NAME APP_IMAGE TEST_IMAGE LOCAL_API_PORT LOCAL_POSTGRES_PORT LOCAL_SQS_PORT
cat > .env.local <<'ENV'
APP_IMAGE=wagers-review-20261018-app:local
TEST_IMAGE=wagers-review-20261018-test:local
LOCAL_API_PORT=3078
LOCAL_POSTGRES_PORT=55478
LOCAL_SQS_PORT=45678
ENV
```

Os comandos Docker seguintes são iguais nos dois shells e executados no host. Rode um por vez e pare em exit code não zero (`$LASTEXITCODE` no PowerShell, `$?` no Bash). O Compose padrão e o local são equivalentes nesta base; o roteiro explicita o arquivo para evitar ambiguidades.

### 2. Instalação congelada e infraestrutura exclusiva

```text
docker compose --env-file .env.local -p wagers-review-20261018 -f docker-compose.local.yml config --quiet
docker compose --env-file .env.local -p wagers-review-20261018 -f docker-compose.local.yml --profile test build app migrate test-runner
docker compose --env-file .env.local -p wagers-review-20261018 -f docker-compose.local.yml up -d --wait --wait-timeout 180
```

O build executa `bun install --frozen-lockfile` na imagem. Não atualize o lockfile. A subida cria rede e volume `wagers-review-20261018_local_pgdata`, PostgreSQL, LocalStack, três filas, aplica migrations **001–010** e inicia a API. `queues` e `migrate` devem terminar com exit 0; `postgres`, `localstack` e `app` devem ficar healthy.

### 3. Migrations e readiness

```text
docker compose --env-file .env.local -p wagers-review-20261018 -f docker-compose.local.yml ps -a
docker compose --env-file .env.local -p wagers-review-20261018 -f docker-compose.local.yml logs migrate queues
docker compose --env-file .env.local -p wagers-review-20261018 -f docker-compose.local.yml run --rm migrate
docker compose --env-file .env.local -p wagers-review-20261018 -f docker-compose.local.yml exec -T app bun run infra/healthcheck.ts
```

A segunda execução do migrador deve informar `No new migrations to apply.` e exit 0. Readiness (`GET /health/ready`) responde 200 ou 503 se indisponível. Liveness (`GET /health/live`) independe das dependências. API no host: `http://127.0.0.1:3078`; healthcheck no container: porta interna 3000. Não reverta migrations para encerrar.

### 4. Typecheck e suíte oficial em containers Linux

```text
docker compose --env-file .env.local -p wagers-review-20261018 -f docker-compose.local.yml run --rm test-runner bun install --frozen-lockfile
docker compose --env-file .env.local -p wagers-review-20261018 -f docker-compose.local.yml run --rm test-runner bun run typecheck
docker compose --env-file .env.local -p wagers-review-20261018 -f docker-compose.local.yml run --rm -e SQS_ENDPOINT=http://localstack:4566 -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_REGION=us-east-1 -e SQS_CONSUMER_ENABLED=false -e OUTBOX_PUBLISHER_ENABLED=false -e PENDING_WORKER_ENABLED=false test-runner bun run test
```

A instalação explícita deve sair 0 e confere o lockfile mesmo quando o build usou cache. Typecheck deve sair 0. O comando oficial `bun run test` usa `scripts/run-tests.ts`: cada `.test.ts` roda sequencialmente em processo Bun novo, timeout padrão de 30 s por teste, mantendo limites explícitos. Continua após falhas; retorna 1 se qualquer arquivo falhar, receber sinal ou não iniciar. Exit 0 significa todos os arquivos aprovados. `bun test` direto não substitui esse isolamento.

Testes criam/removem bancos descartáveis e filas exclusivas **na infraestrutura desta avaliação**, usando administrador para provisionamento e `app_user` para runtime. Não use banco compartilhado/produção. A API usa `betting_db`: executar testes não é subir a aplicação nem validar os dados do smoke. O administrador tem privilégios elevados somente nesse ambiente local descartável.

### 5. Smoke da API real

```text
docker compose --env-file .env.local -p wagers-review-20261018 -f docker-compose.local.yml exec -T app bun run infra/smoke-api.ts
```

Espera exit 0 e `All smoke operations passed successfully!`: abertura 100.00 BRL, BET 25.00, saldo 75.00, replay sem segundo débito, consulta da transação, dois lançamentos no ledger e reconciliação com diferença 0.00. Cria registros em `betting_db` e não os remove. Não comprova entrega end-to-end pela fila.

A composição habilita consumidor SQS, publisher da outbox e worker de referências. A suíte usa bancos/filas próprios e habilita componentes nos cenários específicos. Consulte [infraestrutura](infra/README.md), [comandos SQS](docs/messaging/M15-IMPLEMENTED.md) e [retry, lease, DLQ e shutdown](docs/messaging/M16-RELIABILITY.md).

### 6. Encerramento seguro

Mesmo após falha, use somente o projeto criado acima:

```text
docker compose --env-file .env.local -p wagers-review-20261018 -f docker-compose.local.yml down --timeout 40
```

Isso encerra containers/rede desse projeto e preserva seu volume. Para descartar **também os dados desta avaliação**, depois de conferir o nome do projeto:

```text
docker compose --env-file .env.local -p wagers-review-20261018 -f docker-compose.local.yml down -v --timeout 40
```

Não use prune, remoção global de volumes ou scripts de parada de PostgreSQL nativo. As imagens exclusivas podem permanecer em cache.

## Operações e contratos

| Operação | Efeito |
| --- | --- |
| BET | Débito, rejeita saldo insuficiente |
| WIN | Crédito positivo; pode aguardar referência |
| LOSS | Sem alteração de saldo, versão ou ledger |
| REFUND | Crédito integral de BET processada |
| ROLLBACK | Inverte BET, WIN ou REFUND; valida saldo no débito |

Dinheiro: `{ amount: "25.00", currency: "BRL" }`, sem ponto flutuante. Escrita: `POST /wallets`, `POST /wagering/transactions` com `Idempotency-Key`; leitura: `GET /wallets/:id`, `GET /wagering/transactions/:id`, `GET /providers/:providerId/wagering/transactions/:externalTransactionId` e `GET /wallets/:id/ledger`. Reconciliação: `POST /wallets/:id/reconciliation`.

Pendências respondem 202; operações processadas 200, abertura 201. Entradas inválidas: 400; ausência: 404; conflito de idempotência: 409; falhas transitórias mapeadas: 503. Rejeição financeira é resultado persistido. Testes HTTP e DTOs detalham os contratos.

## Leitura técnica

- [Arquitetura, decisões e limitações](ARCHITECTURE.md).
- [Observabilidade e correlação](docs/delivery/OBSERVABILITY.md).
- [Índice documental e evidências históricas](docs/README.md).
- [Inventário, limpeza e validação desta revisão](docs/review/VALIDATION.md).

`scripts/db-start.ps1` e `scripts/db-stop.ps1` são auxiliares históricos dependentes de instalação local; não são usados aqui. `.env.example` exemplifica execução nativa com senhas somente locais; o Compose usa outras credenciais. O roteiro acima cria toda a configuração necessária.
