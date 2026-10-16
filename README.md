# Processador Financeiro de Apostas Distribuídas

Backend financeiro independente e resiliente para processamento de transações de apostas, construído com foco em **precisão monetária estrita**, **idempotência persistente**, **garantias contábeis imutáveis**, **integração transacional com MikroORM** e **controle de concorrência com PostgreSQL real**.

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
> Conforme a restrição de **nunca substituir PostgreSQL por SQLite ou mocks**, o PostgreSQL 16.8 foi executado localmente na porta padrão 5432 com banco `betting_db` e usuário `app_user` com privilégios estritamente delimitados (sem permissão de `TRUNCATE` e sem superusuário).

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
# Aplicar todas as migrações (001 e 002)
bun run src/infrastructure/persistence/migrator.ts up

# Reverter migrações de forma limpa
bun run src/infrastructure/persistence/migrator.ts down
```

---

### 3.3 Execução da Suíte de Testes

Todas as suítes utilizam **Bun Test**, executam com isolamento de processos via `process.execPath` e interagem com o **PostgreSQL real**:

```bash
# Executar verificação de tipos estritos TypeScript
bun run typecheck

# Executar TODOS os testes (unitários, integração e concorrência)
bun test

# Executar testes unitários de domínio (Money, Wallet, Ledger)
bun run test:unit

# Executar testes de integração com PostgreSQL real (Invariantes, Migrações descartáveis e HTTP)
bun run test:integration

# Executar testes de alta concorrência (50 requests paralelas, corrida de saldo e barreira de sincronização entre 3 processos de SO)
bun run test:concurrency
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
A API iniciará por padrão em `http://localhost:3000`.

---

## 4. Contratos HTTP Alinhados (Exemplos cURL)

### 4.1 Abertura de Carteira (`POST /wallets`)

#### Com saldo inicial positivo (gera transação `OPENING`, crédito no ledger e eventos de outbox):
```bash
curl -X POST http://localhost:3000/wallets \
  -H "Content-Type: application/json" \
  -d '{
    "playerId": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    "initialBalance": {
      "amount": "100.00",
      "currency": "BRL"
    }
  }'
```
**Resposta (201 Created):**
```json
{
  "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "playerId": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
  "balance": {
    "amount": "100.00",
    "currency": "BRL"
  },
  "version": 1
}
```

#### Com saldo inicial zero explícito (sem lançamento no ledger e sem eventos de outbox):
```bash
curl -X POST http://localhost:3000/wallets \
  -H "Content-Type: application/json" \
  -d '{
    "playerId": "b1ffcd88-8b1a-4fe7-aa5c-5aa8ac270b22",
    "initialBalance": {
      "amount": "0.00",
      "currency": "BRL"
    }
  }'
```
> [!IMPORTANT]
> Saldo zero deve ser explicitamente fornecido como `"0.00"`. A fronteira HTTP rejeita `null`, `0`, `false` ou strings vazias com `400 Bad Request`.

---

### 4.2 Consulta de Carteira (`GET /wallets/:walletId`)

```bash
curl -X GET http://localhost:3000/wallets/3fa85f64-5717-4562-b3fc-2c963f66afa6
```
**Resposta (200 OK):**
```json
{
  "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "playerId": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
  "balance": {
    "amount": "100.00",
    "currency": "BRL"
  },
  "version": 1
}
```

---

### 4.3 Processamento de Aposta (`POST /wagering/transactions`)

O cabeçalho `Idempotency-Key` é obrigatório. O payload requer o envelope de dinheiro `{ amount, currency }`.

```bash
curl -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: idempotency-key-uuid-1" \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    "walletId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": {
      "amount": "25.00",
      "currency": "BRL"
    }
  }'
```
**Resposta de Processamento com Sucesso (200 OK):**
```json
{
  "transactionId": "b8f683e9-74d2-43bb-81c8-c8005b61f9aa",
  "status": "PROCESSED",
  "balance": {
    "amount": "75.00",
    "currency": "BRL"
  },
  "idempotentReplay": false
}
```

#### Replay Idempotente:
Ao reenviar a requisição com a **mesma** `Idempotency-Key` e o **mesmo** corpo:
- O backend não executa novo débito nem gera novo lançamento no ledger ou outbox.
- Retorna `HTTP 200` com os dados originais, o saldo observado original e `idempotentReplay: true`:
```json
{
  "transactionId": "b8f683e9-74d2-43bb-81c8-c8005b61f9aa",
  "status": "PROCESSED",
  "balance": {
    "amount": "75.00",
    "currency": "BRL"
  },
  "idempotentReplay": true
}
```

#### Rejeição por Saldo Insuficiente:
Ao submeter uma aposta de `90.00` quando o saldo disponível é `75.00`:
**Resposta (422 Unprocessable Entity):**
```json
{
  "transactionId": "c9a712f0-83b1-42cb-92d9-d9116c72e0bb",
  "status": "REJECTED",
  "failureCode": "INSUFFICIENT_FUNDS",
  "balance": {
    "amount": "75.00",
    "currency": "BRL"
  },
  "idempotentReplay": false
}
```
A rejeição é persistida para fins de auditoria, gerando evento de outbox `WagerTransactionRejected`, mas **sem mutação de saldo e sem lançamento no ledger**. Se a mesma chave for reenviada, retorna a mesma rejeição com `idempotentReplay: true`.

---

### 4.4 Reconciliação Contábil (`POST /wallets/:walletId/reconciliation`)

Compara o saldo armazenado na carteira com a soma de todos os lançamentos contábeis no ledger sob contexto transacional consistente:

```bash
curl -X POST http://localhost:3000/wallets/3fa85f64-5717-4562-b3fc-2c963f66afa6/reconciliation
```
**Resposta (200 OK):**
```json
{
  "walletId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "storedBalance": {
    "amount": "75.00",
    "currency": "BRL"
  },
  "calculatedBalance": {
    "amount": "75.00",
    "currency": "BRL"
  },
  "difference": {
    "amount": "0.00",
    "currency": "BRL"
  },
  "consistent": true,
  "checkedEntries": 2
}
```
> [!NOTE]
> Todos os valores monetários retornam no formato `{ amount, currency }`. O campo `difference` admite resultados negativos caso exista discrepância auditada.

---

## 5. Estrutura de Arquivos

```
d:\processadorApostasDistribuidas/
├── .env                                       # Configurações de ambiente locais
├── .env.example                               # Exemplo seguro sem credenciais reais
├── .gitignore                                 # Padrões ignorados (node_modules, logs, etc.)
├── ARCHITECTURE.md                            # Documentação técnica e de invariantes
├── IMPLEMENTATION.md                          # Critérios de aceite e plano de fases
├── README.md                                  # Guia de execução e documentação da API
├── bun.lock                                   # Lockfile estrito gerado pelo Bun
├── docker-compose.yml                         # Manifesto compose para PostgreSQL
├── package.json                               # Dependências e scripts de automação
├── tsconfig.json                              # Configuração estrita do TypeScript
│
├── scripts/
│   ├── db-start.ps1                           # Inicialização do PostgreSQL nativo em background
│   ├── db-stop.ps1                            # Parada controlada do PostgreSQL nativo
│   └── init-db.sql                            # Criação do banco betting_db e usuário app_user
│
├── src/
│   ├── main.ts                                # Ponto de entrada do NestJS com CORS e validação
│   │
│   ├── domain/                                # Domínio puro isolado
│   │   ├── entities/
│   │   │   ├── wager-transaction.entity.ts    # Transação financeira de aposta / abertura
│   │   │   ├── wallet-ledger-entry.entity.ts  # Entrada imutável de livro-razão contábil
│   │   │   └── wallet.entity.ts               # Agregado Wallet com versionamento e saldo
│   │   ├── errors/
│   │   │   └── domain.error.ts                # Hierarquia de erros tipados de negócio
│   │   ├── events/
│   │   │   └── events.ts                      # IntegrationEvent<T> e subclasses de eventos de domínio
│   │   └── value-objects/
│   │       └── money.vo.ts                    # Objeto de valor Money (BigInt em centavos)
│   │
│   ├── application/                           # Casos de uso e portas de entrada
│   │   ├── dto/
│   │   │   ├── common.dto.ts                  # DTO compartilhado MoneyObjectDto
│   │   │   ├── wager.dto.ts                   # DTOs de aposta alinhados ao contrato
│   │   │   └── wallet.dto.ts                  # DTOs de carteira e reconciliação
│   │   ├── ports/
│   │   │   └── ports.ts                       # Interfaces de repositórios e Unit of Work
│   │   └── use-cases/
│   │       ├── create-wallet.use-case.ts      # Abertura de carteira transacional
│   │       ├── get-wallet.use-case.ts         # Consulta de dados de carteira
│   │       ├── process-bet.use-case.ts        # Processamento de BET com lock de linha e idempotência
│   │       └── reconcile-wallet.use-case.ts   # Reconciliação de saldo vs ledger
│   │
│   ├── infrastructure/                        # Adaptadores de persistência e configuração
│   │   ├── config/
│   │   │   └── database.config.ts             # Centralização de credenciais e opções de banco
│   │   └── persistence/
│   │       ├── migrations/
│   │       │   ├── 001_initial_schema.sql     # Schema inicial
│   │       │   ├── 001_initial_schema.down.sql# Reversão 001
│   │       │   ├── 002_reinforce_schema_and_outbox.sql     # Reforço de schema, triggers e outbox
│   │       │   └── 002_reinforce_schema_and_outbox.down.sql# Reversão 002
│   │       ├── mikro-orm/
│   │       │   ├── entities/
│   │       │   │   └── orm-entities.ts        # Mapeamento declarativo de entidades MikroORM
│   │       │   ├── mikro-orm-adapter.ts       # MikroOrmUnitOfWork e repositórios com EntityManager
│   │       │   └── mikro-orm.config.ts        # Configuração do MikroORM para PostgreSQL
│   │       ├── postgres/
│   │       │   └── postgres-adapter.ts        # Re-export unificado para evitar duplicação de UoW
│   │       └── migrator.ts                    # Runner de migrações com advisory lock e tracking
│   │
│   └── interfaces/                            # Apresentação HTTP
│       └── http/
│           ├── controllers/
│           │   ├── wagering.controller.ts     # Controller POST /wagering/transactions
│           │   └── wallet.controller.ts       # Controller POST /wallets, GET /wallets/:id, reconciliação
│           ├── filters/
│           │   └── domain-exception.filter.ts # Filtro global de tratamento e códigos HTTP
│           ├── validation/
│           │   └── http-validator.ts          # Validador rigoroso de fronteira HTTP em runtime
│           └── app.module.ts                  # Módulo raiz NestJS com ciclo do MikroORM
│
└── tests/
    ├── unit/                                  # Testes unitários do domínio financeiro
    │   ├── money.test.ts                      # 12 testes de precisão, escala, imutabilidade de Money
    │   ├── wallet-ledger-entry.test.ts        # 5 testes de verificação aritmética do ledger
    │   └── wallet.test.ts                     # 7 testes de abertura, crédito, débito e versão
    │
    ├── integration/                           # Testes de integração com PostgreSQL real
    │   ├── http-endpoints.test.ts             # 13 testes de contratos HTTP e validações de fronteira
    │   ├── migrations.test.ts                 # 1 teste de UP e DOWN incremental em banco descartável
    │   └── postgres-invariants.test.ts        # 17 testes de constraints, falhas atômicas e triggers
    │
    └── concurrency/                           # Testes de alta concorrência
        ├── concurrency.test.ts                # 3 testes (50 reqs, corrida 80/100, 3 processos de SO)
        └── worker.ts                          # Script de processo com barreira de sincronização
```

---

## 6. Resultados Reais da Execução dos Testes

Testes executados com Bun 1.4.3 e PostgreSQL 16.8 real:

| Suíte | Arquivo | Testes | Asserções | Status |
|---|---|---|---|---|
| **Unit** | `money.test.ts` | 12 | 24 | ✅ Passou |
| **Unit** | `wallet-ledger-entry.test.ts` | 5 | 15 | ✅ Passou |
| **Unit** | `wallet.test.ts` | 7 | 56 | ✅ Passou |
| **Integration** | `postgres-invariants.test.ts` | 17 | 93 | ✅ Passou |
| **Integration** | `migrations.test.ts` | 1 | 8 | ✅ Passou |
| **Integration** | `http-endpoints.test.ts` | 13 | 40 | ✅ Passou |
| **Concurrency** | `concurrency.test.ts` | 3 | 184 | ✅ Passou |
| **Total Geral** | **7 arquivos** | **58 testes** | **418 asserções** | **100% Sucesso** |

---

## 7. Diferenciação de Escopo: Implementado, Testado e Lacunas Futuras

### ✅ Implementado e Testado
- Objeto de valor `Money` com `BigInt` em centavos, sem conversão para ponto flutuante, imutável e com detecção de moedas divergentes.
- Agregado `Wallet` com versionamento atômico, criação com e sem saldo, integridade de saldo não negativo.
- Unidade de trabalho transacional integrada exclusivamente via MikroORM (`EntityManager.transactional()`), com isolamento por requisição via `AsyncLocalStorage`.
- Lock pessimista `LockMode.PESSIMISTIC_WRITE` (`FOR UPDATE`) na linha da carteira.
- `WalletLedgerEntry` com verificação de aritmética contábil e trigger de imutabilidade no banco de dados.
- Triggers de banco que impedem alteração de transações em estado terminal e bloqueiam `UPDATE`/`DELETE` no ledger.
- `app_user` auditado com permissões mínimas e sem direito a `TRUNCATE`.
- Migrações incrementais reversíveis (`001` e `002`) com runner protegido por advisory lock (`pg_advisory_xact_lock`).
- Validação rigorosa na fronteira HTTP em runtime (`HttpValidator`), rejeitando coerção implícita de tipos, números para valores monetários, propriedades inesperadas e strings vazias.
- Idempotência persistente com hash SHA-256 canônico normalizado, replay seguro com saldo original e resolução de corridas 23505 sem reuso de transações PostgreSQL abortadas.
- Testes com injeção de falhas atômicas comprovando rollback completo e reprocessamento limpo.
- Testes de concorrência com 50 submissões simultâneas, corrida de saldo com rejeição de saldo insuficiente e coordenação de 3 processos reais via barreira de sincronização em arquivo temporário.

### ⏳ Fases Futuras Obrigatórias (Fora do Escopo desta Etapa)
- Operações de aposta adicionais (`WIN`, `LOSS`, `REFUND`, `ROLLBACK`).
- Worker/Publisher para leitura da tabela `outbox_messages` e despacho confiável para **AWS SQS** (broker estipulado pelo desafio).
- Gestão de credenciais, autenticação e autorização por provedor de jogos.
