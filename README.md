# Processador Financeiro de Apostas Distribuídas

Backend financeiro independente e resiliente para processamento de transações de apostas, construído com foco em **precisão monetária estrita**, **idempotência persistente**, **garantias contábeis imutáveis** e **controle de concorrência com PostgreSQL real**.

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
> Conforme a restrição estrita de **nunca substituir PostgreSQL por SQLite ou mocks**, o PostgreSQL 16.8 foi instalado e executado localmente na porta padrão 5432 com banco `betting_db` e usuário `app_user`.

---

## 2. Tecnologias Utilizadas

- **Runtime & Test Runner:** [Bun](https://bun.sh/) 1.4.3
- **Linguagem:** TypeScript 5.8 em modo estrito (`strict: true`)
- **Framework HTTP:** NestJS 11
- **ORM & Mapeamento:** MikroORM 6.4 (PostgreSQL)
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

O projeto possui um runner autônomo de migrações que suporta operações UP e DOWN:

```bash
# Aplicar migrações (cria tabelas, triggers e permissões)
bun run src/infrastructure/persistence/migrator.ts up

# Reverter migrações (remove todas as tabelas e triggers de forma limpa)
bun run src/infrastructure/persistence/migrator.ts down
```

---

### 3.3 Execução da Suíte de Testes

Todas as suítes utilizam **Bun Test** e interagem com o **PostgreSQL real**:

```bash
# Executar verificação de tipos estritos TypeScript
bun run typecheck

# Executar TODOS os testes (unitários, integração e concorrência)
bun test

# Executar testes unitários de domínio (Money, Wallet, Ledger)
bun run test:unit

# Executar testes de integração com PostgreSQL real (Invariantes, Migrações UP/DOWN descartáveis e HTTP)
bun run test:integration

# Executar testes de alta concorrência (50 requests paralelas, corrida de saldo e múltiplos processos de SO)
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

## 4. Exemplos de Chamadas HTTP (cURL)

### 4.1 Abertura de Carteira (`POST /wallets`)

#### Com saldo inicial positivo (gera transação `OPENING` e crédito no ledger):
```bash
curl -X POST http://localhost:3000/wallets \
  -H "Content-Type: application/json" \
  -d '{
    "playerId": "player-123",
    "currency": "BRL",
    "initialBalance": "100.00"
  }'
```
**Resposta (201 Created):**
```json
{
  "walletId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "playerId": "player-123",
  "currency": "BRL",
  "balance": "100.00",
  "version": 1,
  "createdAt": "2026-10-16T17:30:00.000Z"
}
```

#### Com saldo inicial zero (sem lançamento no ledger):
```bash
curl -X POST http://localhost:3000/wallets \
  -H "Content-Type: application/json" \
  -d '{
    "playerId": "player-456",
    "currency": "BRL"
  }'
```

---

### 4.2 Consulta de Carteira (`GET /wallets/:walletId`)

```bash
curl -X GET http://localhost:3000/wallets/3fa85f64-5717-4562-b3fc-2c963f66afa6
```
**Resposta (200 OK):**
```json
{
  "walletId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "playerId": "player-123",
  "currency": "BRL",
  "balance": "100.00",
  "version": 1,
  "createdAt": "2026-10-16T17:30:00.000Z",
  "updatedAt": "2026-10-16T17:30:00.000Z"
}
```

---

### 4.3 Processamento de Aposta (`POST /wagering/transactions`)

O cabeçalho `Idempotency-Key` é estritamente obrigatório. Nesta entrega, apenas `kind: "BET"` é aceito.

```bash
curl -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: a1b2c3d4-e5f6-7890-1234-56789abcdef0" \
  -d '{
    "providerId": "evolution-gaming",
    "externalTransactionId": "tx-external-999",
    "playerId": "player-123",
    "walletId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "roundId": "round-888",
    "gameId": "roulette-vip",
    "kind": "BET",
    "money": {
      "amount": "40.00",
      "currency": "BRL"
    }
  }'
```
**Resposta (200 OK - Processada com Sucesso):**
```json
{
  "transactionId": "b8f683e9-74d2-43bb-81c8-c8005b61f9aa",
  "status": "PROCESSED",
  "observedBalance": "60.00",
  "currency": "BRL",
  "idempotencyKey": "a1b2c3d4-e5f6-7890-1234-56789abcdef0"
}
```

#### Replay Idempotente:
Ao reenviar a requisição acima com a **mesma** `Idempotency-Key` e o **mesmo** corpo:
- O backend não altera saldo nem gera novo lançamento contábil.
- Retorna `HTTP 200` com a mesma resposta e o **saldo observado original** (`60.00`).

#### Rejeição por Saldo Insuficiente:
Ao submeter uma aposta de `80.00` quando o saldo é `60.00`:
**Resposta (422 Unprocessable Entity):**
```json
{
  "transactionId": "c9a712f0-83b1-42cb-92d9-d9116c72e0bb",
  "status": "REJECTED",
  "reason": "INSUFFICIENT_FUNDS",
  "observedBalance": "60.00",
  "currency": "BRL",
  "idempotencyKey": "chave-diferente-123"
}
```
A rejeição é gravada no banco para fins de auditoria, mas **o saldo e o ledger permanecem inalterados**.

---

### 4.4 Reconciliação Contábil (`POST /wallets/:walletId/reconciliation`)

Compara o saldo armazenado na carteira com a soma de todos os lançamentos de débito e crédito no ledger:

```bash
curl -X POST http://localhost:3000/wallets/3fa85f64-5717-4562-b3fc-2c963f66afa6/reconciliation
```
**Resposta (200 OK):**
```json
{
  "walletId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "storedBalance": "60.00",
  "calculatedBalance": "60.00",
  "difference": "0.00",
  "consistent": true,
  "checkedEntries": 2
}
```

---

## 5. Estrutura de Arquivos Criados

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
│   │   │   └── events.ts                      # Eventos de domínio (Processed, Rejected, BalanceChanged)
│   │   └── value-objects/
│   │       └── money.vo.ts                    # Objeto de valor Money (BigInt em centavos)
│   │
│   ├── application/                           # Casos de uso e portas de entrada
│   │   ├── dto/
│   │   │   ├── wager.dto.ts                   # DTOs de transações de aposta
│   │   │   └── wallet.dto.ts                  # DTOs de carteira e reconciliação
│   │   ├── ports/
│   │   │   └── ports.ts                       # Interfaces de repositórios e Unit of Work
│   │   └── use-cases/
│   │       ├── create-wallet.use-case.ts      # Abertura de carteira transacional
│   │       ├── get-wallet.use-case.ts         # Consulta de dados de carteira
│   │       ├── process-bet.use-case.ts        # Processamento de BET com lock de linha e idempotência
│   │       └── reconcile-wallet.use-case.ts   # Reconciliação de saldo vs ledger
│   │
│   ├── infrastructure/                        # Adaptadores de persistência
│   │   └── persistence/
│   │       ├── migrations/
│   │       │   ├── 001_initial_schema.sql     # Migração UP com tabelas, triggers e permissões
│   │       │   └── 001_initial_schema.down.sql# Migração DOWN para reversão limpa
│   │       ├── mikro-orm/
│   │       │   ├── entities/
│   │       │   │   └── orm-entities.ts        # Mapeamento declarativo de entidades MikroORM
│   │       │   └── mikro-orm.config.ts        # Configuração do MikroORM para PostgreSQL
│   │       ├── postgres/
│   │       │   └── postgres-adapter.ts        # Implementação de Repositórios e UoW transacional
│   │       └── migrator.ts                    # Runner de migrações UP e DOWN
│   │
│   └── interfaces/                            # Apresentação HTTP
│       └── http/
│           ├── controllers/
│           │   ├── wagering.controller.ts     # Controller POST /wagering/transactions
│           │   └── wallet.controller.ts       # Controller POST /wallets, GET /wallets/:id, reconciliação
│           ├── filters/
│           │   └── domain-exception.filter.ts # Filtro global de tratamento e códigos HTTP
│           └── app.module.ts                  # Módulo raiz NestJS com injeção de dependências
│
└── tests/
    ├── unit/                                  # Testes unitários do domínio financeiro
    │   ├── money.test.ts                      # 12 testes de precisão, escala, imutabilidade de Money
    │   ├── wallet-ledger-entry.test.ts        # 5 testes de verificação aritmética do ledger
    │   └── wallet.test.ts                     # 7 testes de abertura, crédito, débito e versão
    │
    ├── integration/                           # Testes de integração com PostgreSQL real
    │   ├── http-endpoints.test.ts             # 6 testes dos endpoints da API via HTTP
    │   ├── migrations.test.ts                 # 1 teste de UP e DOWN em banco descartável
    │   └── postgres-invariants.test.ts        # 10 testes de constraints, rollback e imutabilidade
    │
    └── concurrency/                           # Testes de alta concorrência
        ├── concurrency.test.ts                # 3 testes (50 reqs, corrida 80/100, 3 processos de SO)
        └── worker.ts                          # Script auxiliar para execução de processos paralelos
```

---

## 6. Resultados da Execução dos Testes

Todos os testes foram executados com sucesso utilizando Bun e PostgreSQL 16.8 real:

| Suíte | Arquivo | Testes | Asserções | Status |
|---|---|---|---|---|
| **Unit** | `money.test.ts` | 12 | 24 | ✅ Passou |
| **Unit** | `wallet-ledger-entry.test.ts` | 5 | 15 | ✅ Passou |
| **Unit** | `wallet.test.ts` | 7 | 56 | ✅ Passou |
| **Integration** | `postgres-invariants.test.ts` | 10 | 57 | ✅ Passou |
| **Integration** | `migrations.test.ts` | 1 | 4 | ✅ Passou |
| **Integration** | `http-endpoints.test.ts` | 6 | 29 | ✅ Passou |
| **Concurrency** | `concurrency.test.ts` | 3 | 189 | ✅ Passou |
| **Total Geral** | **7 arquivos** | **44 testes** | **374 asserções** | **100% Sucesso** |

---

## 7. Diferenciação de Escopo: Implementado, Testado e Pendente

### ✅ Implementado e Testado
- Objeto de valor `Money` com `BigInt` em centavos, rejeição de notação científica, negativas, `NaN`, e escala não estrita.
- Agregado `Wallet` com versionamento atômico, criação com e sem saldo, integridade de saldo não negativo.
- `WalletLedgerEntry` com validação de invariante aritmética no domínio e trigger guard no banco de dados.
- Migrações reversíveis UP e DOWN validadas em banco de dados descartável.
- Endpoints REST com validação de entrada, códigos de erro de domínio mapeados para HTTP consistente.
- Idempotência com hash SHA-256 canônico, replay persistente com saldo original e rejeição de concorrência com chaves divergentes.
- Controle de concorrência exclusivamente no banco de dados via `FOR UPDATE` sem mutex em memória.
- Reconciliação contábil com garantia de visão consistente e sem auto-correção.
- Concorrência de 50 requisições simultâneas, disputa concorrente de saldo e paralelismo com 3 processos de SO.

### ⏳ Pendente para Próximas Fases
- Operações de aposta adicionais (`WIN`, `LOSS`, `REFUND`, `ROLLBACK`).
- Worker/Publisher para envio assíncrono dos eventos da tabela `outbox_messages` para fila SQS / Kafka.
- Autenticação de clientes e gestão de credenciais por provedor.
- Frontend e interface gráfica de usuário.
