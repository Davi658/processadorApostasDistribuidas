# Processador Financeiro de Apostas Distribuídas

Backend financeiro independente e resiliente para processamento de transações de apostas, construído com foco em **precisão monetária estrita**, **idempotência persistente**, **garantias contábeis imutáveis**, **integração transacional com MikroORM**, **reversões referenciadas** e **controle de concorrência com PostgreSQL real**.

---

## 1. Status do Ambiente

A verificação do ambiente local identificou:

| Ferramenta | Requisito | Status Local | Observação |
|---|---|---|---|
| **Bun** | Bun 1.x | **Instalado** (v1.4.3) | Utilizado como runtime, gerenciador de pacotes e test runner |
| **Git** | Git 2.x | **Instalado** (v2.52.0.windows.1) | Controle de versão local estrito |
| **Docker & Compose** | Docker / Compose | **Operacional** | Arquivos `docker-compose.yml` (entrega padrão) e `docker-compose.local.yml` provisionam a plataforma completa com PostgreSQL, LocalStack SQS, migrações e trabalhadores distribuídos |
| **PostgreSQL** | PostgreSQL Real | **Instalado e Operacional** (v16.8) | Binários em `~/.pgsql/pgsql`, cluster em `~/.pgsql_data`, porta 5432 |

> [!NOTE]
> Conforme a restrição mandatória de **nunca substituir PostgreSQL por SQLite ou mocks**, o PostgreSQL 16.8 está em execução local na porta padrão 5432. Os testes rodam contra bancos descartáveis isolados (`betting_test_*` e `http_endpoints_*`), executados pelo usuário de aplicação `app_user` com privilégios estritamente delimitados (sem permissão de `TRUNCATE` e sem superusuário).

---

## 2. Tecnologias Utilizadas

- **Runtime & Test Runner:** [Bun](https://bun.sh/) 1.4.3
- **Linguagem:** TypeScript 5.8 em modo estrito (`strict: true`)
- **Framework HTTP:** NestJS 11 (`@nestjs/core`, `@nestjs/common`, `@nestjs/testing` alinhados na versão 11)
- **ORM & Unidade de Trabalho:** MikroORM 6.4 (PostgreSQL) com transação explícita e isolamento por `AsyncLocalStorage`
- **Banco de Dados:** PostgreSQL 16.8
- **Containerização:** Docker Compose (`docker-compose.yml` e `docker-compose.local.yml`)

---

## 3. Comandos Reproduzíveis

### 3.1 Inicialização da Plataforma e Banco de Dados

#### Opção A: PostgreSQL Nativo Local (Scripts PowerShell inclusos)
Para iniciar o serviço PostgreSQL local:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/db-start.ps1
```
Para parar o serviço PostgreSQL local:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/db-stop.ps1
```

#### Opção B: Docker Compose — Plataforma Completa (em ambientes com Docker disponível)
Para inicializar toda a plataforma (PostgreSQL 16, LocalStack SQS FIFO, migrador automático e API com os trabalhadores distribuídos `SQS_CONSUMER_ENABLED`, `OUTBOX_PUBLISHER_ENABLED` e `PENDING_WORKER_ENABLED` ativados):
```bash
docker compose up -d --build
```
*(ou via `docker-compose up -d` ou `docker compose -f docker-compose.local.yml up -d`)*

---

### 3.2 Execução de Migrações SQL Reversíveis

O projeto possui um runner autônomo de migrações que suporta operações UP e DOWN incrementais com rastreamento na tabela `schema_migrations` e proteção contra execução concorrente via PostgreSQL Advisory Lock (`pg_advisory_xact_lock`):

```bash
# Aplicar todas as migrações (001 a 005)
bun run src/infrastructure/persistence/migrator.ts up

# Reverter migrações de forma limpa
bun run src/infrastructure/persistence/migrator.ts down
```

---

### 3.3 Execução da Suíte de Testes

Todas as suítes utilizam **Bun Test**, executam com isolamento de processos e banco descartável por execução, interagindo com o **PostgreSQL real**:

```bash
# Executar verificação de tipos estritos TypeScript (0 erros)
bun run typecheck

# Executar TODOS os testes, incluindo concorrência, por arquivo em processos separados
bun run test

# Executar testes unitários de domínio (Money, Wallet, Ledger)
bun run test:unit

# Executar testes de integração com PostgreSQL real (Invariantes, Migrações descartáveis, Operações e HTTP)
bun run test:integration

# Executar testes de alta concorrência (50 requests paralelas, corrida de saldo, chave disputada em paralelo e barreira de sincronização entre 3 processos)
bun run test:concurrency

# Executar suíte M10 — Worker de referências pendentes com PostgreSQL real e processos OS reais
bun run scripts/run-tests.ts tests/integration/pending-reference-worker-m10.test.ts
```

O comando oficial `bun run test` usa `scripts/run-tests.ts` em Windows e Linux, sem shell específico. Descobre todos os arquivos `.test.ts`, executa cada um sequencialmente em processo Bun novo com prazo padrão de 30 segundos por teste e retorna exit code 1 se qualquer processo falhar, receber sinal ou não iniciar. Continua executando os arquivos restantes para expor todas as falhas. Testes com timeout explícito conservam seu próprio limite. Isso evita vazamento de estado de módulos/variáveis de ambiente entre arquivos; cada integração cria seu banco PostgreSQL descartável. `bun test` diretamente não oferece esse isolamento por arquivo e não é o comando oficial de validação.

```bash
# Consultas M17 pela aplicação principal
bun run test:m17
```

---

### 3.4 Execução da API

Para iniciar o servidor HTTP:

```bash
# Modo de produção
bun run start

# Modo de desenvolvimento com auto-reload
bun run start:dev
```

---

## 4. Matriz de Operações Financeiras Suportadas

A API e o caso de uso unificado `ProcessWagerUseCase` processam as seguintes operações financeiras:

| Operação | Natureza | Efeito no Saldo | Registro no Ledger | Version | Reversão / Referência |
|---|---|---|---|---|---|
| `BET` | Débito | Deduz valor | Sim (`DEBIT`) | Incrementa (+1) | N/A. Rejeita se saldo insuficiente (`INSUFFICIENT_FUNDS`) |
| `WIN` | Crédito | Adiciona valor | Sim (`CREDIT`) | Incrementa (+1) | N/A. Exige valor > 0 |
| `LOSS` | Neutro | Inalterado | **Não** | **Inalterado** | N/A. Aceita valor "0.00" |
| `REFUND` | Crédito | Adiciona valor da BET | Sim (`CREDIT`) | Incrementa (+1) | Referencia `BET` processada. Reverte valor integral |
| `ROLLBACK` | Reversão | Movimento inverso | Sim (Inverso) | Incrementa (+1) | Referencia `BET` (crédito), `WIN` (débito) ou `REFUND` (débito) |

### 4.1 Ciclo de Vida Explícito da Transação

Toda transação nasce no estado `PENDING` e transiciona deterministicamente para um dos estados terminais ou pendência de referência:
- `PENDING` -> `PROCESSED`: Operação autorizada, saldo alterado (ou LOSS neutro), ledger e outbox gravados atomicamente.
- `PENDING` -> `REJECTED`: Operação recusada por regra de negócio (ex: saldo insuficiente, referência não processada). Snapshot preservado para replay idempotente idêntico.
- `PENDING` -> `FAILED`: Falha técnica não recuperável.
- `PENDING` -> `PENDING_REFERENCE`: Operação de reversão recebida fora de ordem antes da transação de referência. Retorna HTTP 202 Accepted. Reprocessada via worker com backoff exponencial.

---

## 5. Idempotência Persistente e Correlação

- **Chaves de até 255 Caracteres:** A coluna `outbox_messages.correlation_id` e `causation_id` foi expandida para `VARCHAR(255)`. Chaves de 128, 129 e 255 caracteres são aceitas sem truncamento e sem erros de persistência. Chaves maiores que 255 caracteres são rejeitadas com HTTP 400.
- **Correlação Independente:** O cabeçalho `x-correlation-id` propaga o identificador de rastreabilidade fim a fim pelos casos de uso e outbox, mantendo a chave integral `Idempotency-Key` como identidade transacional e de causalidade (`causationId`).
- **Detecção Segura de Conflito Concorrente:** Quando uma requisição com mesma chave porém payload divergente disputa inserção no PostgreSQL, o erro de violação de unicidade (`23505`) é resolvido fora da transação abortada, retornando HTTP 409 Conflict sem corromper o estado da carteira.
- **Serialização Canônica Recursiva e Registros Anteriores:** O cálculo do SHA-256 (`canonicalStringify`) ordena recursivamente todas as chaves de objetos em qualquer profundidade e preserva arrays. Registros de transações persistidos anteriormente utilizam o algoritmo legado e exigem uma decisão explícita de compatibilidade antes de qualquer ação; não há suposição de descarte ou expiração automática por TTL.

---

## 6. Integridade Relacional e Proteções no PostgreSQL

1. **Integridade Referencial Composta no Ledger:** Constraint `fk_ledger_wager_tx_wallet_currency` em `wallet_ledger_entries(transaction_id, wallet_id, currency) REFERENCES wager_transactions(id, wallet_id, currency)`. Garante fisicamente no banco que nenhum lançamento da carteira B possa referenciar uma transação da carteira A, nem com moeda divergente.
2. **Proteção Rigorosa de Estados Terminais:** Trigger `prevent_terminal_transaction_modification()` utiliza `IS DISTINCT FROM` para proteger todos os campos que definem identidade, payload e resultado original (`wallet_id`, `player_id`, `provider_id`, `external_transaction_id`, `round_id`, `game_id`, `kind`, `amount`, `currency`, `idempotency_key`, `payload_hash`, `response_snapshot`, `status`) quando a transação está em estado terminal (`PROCESSED`, `REJECTED`, `FAILED`).
3. **Unicidade de Reversão por Tipo e Referência:** Índice parcial `uq_processed_reversal_per_reference` em `(provider_id, reference_external_transaction_id, kind) WHERE status = 'PROCESSED' AND reference_external_transaction_id IS NOT NULL`. Impede no banco que duas reversões do mesmo tipo sejam processadas para a mesma referência.
4. **Resiliência a Erros Transitórios:** `DomainExceptionFilter` reconhece erros de conexão como `ECONNREFUSED`, `ETIMEDOUT`, `ECONNRESET` e códigos PostgreSQL de shutdown/sobrecarga (`57P01`, `08006`, `08001`, `53300`, `40001`, `40P01`), retornando HTTP 503 `SERVICE_UNAVAILABLE` com mensagem segura sem expor dados internos.

## Consultas e paginação — M17

As três rotas são registradas pelo `AppModule` principal. Escritas, worker M10 e consultas compartilham a mesma `MikroOrmUnitOfWork` e os repositórios exportados pelo `PersistenceModule`; o módulo de consultas não cria outro ORM/pool.

| Método e rota | Resultado |
|---|---|
| `GET /wagering/transactions/:transactionId` | Transação por UUID; 400 para UUID inválido; 404 se ausente |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Transação pela combinação exata de provedor e identidade externa; 400 para campos vazios ou acima de 128 caracteres; 404 se a combinação não existir |
| `GET /wallets/:walletId/ledger?limit=50&cursor=...` | Página do ledger; 400 para UUID, limite ou cursor inválidos; 404 para carteira ausente |

Ambas as consultas de transação retornam **o mesmo contrato**, pelo mesmo mapper: `id`, `walletId`, `playerId`, `providerId`, `externalTransactionId`, `roundId`, `gameId`, `kind`, `money: { amount, currency }`, `status`, `rejectionReason`, `referenceExternalTransactionId`, `createdAt`, `updatedAt`. Motivo e referência podem ser `null`. Valores monetários são strings decimais exatas com duas casas, inclusive `"9999999999999999.99"`; não passam por `number`. O mesmo externalId pode existir em provedores distintos sem misturar as respostas.

O ledger retorna `{ items, nextCursor, hasMore, limit }`. Cada item contém `id`, `walletId`, `transactionId`, `entryType`, `amount`, `balanceBefore`, `balanceAfter` e `createdAt`; os três campos monetários usam `{ amount: string, currency: string }`. Carteira sem lançamentos retorna `items: []`, `nextCursor: null`, `hasMore: false`. Limite padrão 50, permitido de 1 a 100. A última página tem cursor nulo.

A ordenação é ascendente por `(created_at, id)` e a consulta parametrizada busca `limit + 1`. O cursor contém `{ walletId, createdAt, id }` codificado em Base64URL canônico, sem padding. **Base64URL é codificação, não assinatura nem criptografia**: o cursor pode ser reconstruído pelo cliente e não é uma credencial de acesso. A aplicação valida o vínculo com a carteira solicitada.

O timestamp do ledger/cursor é exatamente `YYYY-MM-DDTHH:mm:ss.ffffffZ`: UTC, ano de 0001 a 9999, seis dígitos fracionários. O codec independente de HTTP valida calendário gregoriano, dias por mês, anos bissextos e hora de 00:00:00 a 23:59:59; rejeita formatos alternativos, offsets e datas impossíveis com HTTP 400 antes de qualquer acesso aos repositórios. Datas não são normalizadas com `Date.parse`. PostgreSQL formata os seis microssegundos e recebe de volta o mesmo texto no cursor.

As consultas não alteram saldo, versão, transações, ledger ou outbox. A suíte M17 usa HTTP real com `NestFactory.create(AppModule)` e PostgreSQL descartável, verifica snapshots completos das quatro tabelas e confirma que `app.close()` fecha o único ORM e não deixa sessões da aplicação. O shutdown financeiro do M10 mantém suas barreiras de drenagem e cancelamento.


## M18 — observabilidade integrada

AppModule registra `GET /health/live`, `GET /health/ready` e `GET /metrics`, com middleware HTTP e registro único compartilhado por publisher, consumidor e referências. Logs JSON usam allowlist; métricas Prometheus têm cardinalidade limitada e distinguem tentativa, confirmação SQS, commit local e replay. Readiness reutiliza UoW/clientes, limita sondagens concorrentes, consulta apenas dependências habilitadas e recusa tráfego durante shutdown. Liveness independe de PostgreSQL/SQS.

Contratos, lacuna de correlação tardia, semântica dos contadores por processo, reprodução exclusiva e provas: [M18-INTEGRATION.md](M18-INTEGRATION.md) e [evidências M18](docs/evidence/m18/RESULTS.md).
