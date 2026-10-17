# Processador Financeiro de Apostas Distribuídas

Backend financeiro independente e resiliente para processamento de transações de apostas, construído com foco em **precisão monetária estrita**, **idempotência persistente**, **garantias contábeis imutáveis**, **integração transacional com MikroORM**, **reversões referenciadas** e **controle de concorrência com PostgreSQL real**.

---

## 1. Status do Ambiente

A verificação do ambiente local identificou:

| Ferramenta | Requisito | Status Local | Observação |
|---|---|---|---|
| **Bun** | Bun 1.x | **Instalado** (v1.4.3) | Utilizado como runtime, gerenciador de pacotes e test runner |
| **Git** | Git 2.x | **Instalado** (v2.52.0.windows.1) | Controle de versão local estrito |
| **Docker & Compose** | Docker / Compose | **Não instalado no host** | Arquivo `docker-compose.yml` e scripts nativos fornecidos |
| **PostgreSQL** | PostgreSQL Real | **Instalado e Operacional** (v16.8) | Binários em `~/.pgsql/pgsql`, cluster em `~/.pgsql_data`, porta 5432 |

> [!NOTE]
> Conforme a restrição mandatória de **nunca substituir PostgreSQL por SQLite ou mocks**, o PostgreSQL 16.8 está em execução local na porta padrão 5432. Os testes rodam contra bancos descartáveis isolados (`betting_test_*` e `http_endpoints_*`), executados pelo usuário de aplicação `app_user` com privilégios estritamente delimitados (sem permissão de `TRUNCATE` e sem superusuário).

---

## 2. Tecnologias Utilizadas

- **Runtime & Test Runner:** [Bun](https://bun.sh/) 1.4.3
- **Linguagem:** TypeScript 5.8 em modo estrito (`strict: true`)
- **Framework HTTP:** NestJS 11 (`@nestjs/core`, `@nestjs/common`, `@nestjs/testing` alinhados na versão 11)
- **ORM & Unidade de Trabalho:** MikroORM 6.4 (PostgreSQL) com `EntityManager.transactional()` e isolamento por `AsyncLocalStorage`
- **Banco de Dados:** PostgreSQL 16.8
- **Containerização:** Docker Compose (`docker-compose.yml`)

---

## 3. Comandos Reproduzíveis

### 3.1 Inicialização do Banco de Dados

#### Opção A: PostgreSQL Nativo Local (Scripts PowerShell inclusos)
Para iniciar o serviço PostgreSQL local:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/db-start.ps1
```
Para parar o serviço PostgreSQL local:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/db-stop.ps1
```

#### Opção B: Docker Compose (em ambientes com Docker disponível)
```bash
docker-compose up -d
```

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

# Executar TODOS os testes unitários e de integração
bun test

# Executar testes unitários de domínio (Money, Wallet, Ledger)
bun run test:unit

# Executar testes de integração com PostgreSQL real (Invariantes, Migrações descartáveis, Operações e HTTP)
bun run test:integration

# Executar testes de alta concorrência (50 requests paralelas, corrida de saldo, chave disputada em paralelo e barreira de sincronização entre 3 processos)
bun run test:concurrency

# Executar suíte M10 — Worker de referências pendentes com PostgreSQL real e processos OS reais
bun test tests/integration/pending-reference-worker-m10.test.ts
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
