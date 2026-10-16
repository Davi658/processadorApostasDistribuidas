# Arquitetura e Decisões Técnicas — Processador de Apostas Distribuídas

Este documento detalha as decisões de engenharia, garantias formais, modelagem contábil, estratégias de concorrência, idempotência, referências fora de ordem e proteções relacionais no PostgreSQL.

---

## 1. Visão Geral e Estrutura Arquitetural

O projeto segue os princípios de **Clean Architecture** e **Domain-Driven Design (DDD)**, mantendo regras de negócio puras, livres de dependências externas ou acoplamentos a frameworks:

```
src/
├── domain/                      # Núcleo de negócio puro (zero dependência de ORM/NestJS)
│   ├── entities/               # Wallet, WagerTransaction, WalletLedgerEntry
│   ├── value-objects/          # Money (BigInt em centavos, imutável, regex estrita)
│   ├── errors/                 # Erros de domínio tipados
│   └── events/                 # IntegrationEvent<T>, IntegrationEventEnvelope e subclasses
│
├── application/                 # Casos de uso e portas de entrada/saída
│   ├── use-cases/              # CreateWallet, GetWallet, ProcessWager, ProcessBet,
│   │                           # ReconcileWallet, ReprocessPendingReferences
│   ├── dto/                    # DTOs de entrada e saída alinhados aos contratos HTTP
│   └── ports/                  # Interfaces de repositórios e Unit of Work transacional
│
├── infrastructure/              # Adaptadores de persistência e banco de dados
│   ├── config/                 # Centralização de credenciais e opções de banco
│   └── persistence/
│       ├── migrations/         # Migrations SQL reversíveis (001, 002 e 003)
│       ├── mikro-orm/          # Configuração dinâmica, entidades e MikroOrmUnitOfWork
│       └── migrator.ts         # Runner com advisory lock e tracking em schema_migrations
│
└── interfaces/
    └── http/                   # Camada de apresentação HTTP
        ├── controllers/        # WalletController, WageringController (NestJS)
        ├── filters/            # DomainExceptionFilter (erros transitórios e mapeamentos)
        ├── validation/         # HttpValidator (validador de fronteira em tempo de execução)
        └── app.module.ts       # Módulo principal da aplicação NestJS
```

---

## 2. Modelagem do Domínio Financeiro

### 2.1 Objeto de Valor Monetário (`Money`)
- **Representação Interna:** `BigInt` representando centavos inteiros (`100 cents = 1.00 BRL`).
- **Eliminação de Ponto Flutuante:** `number` em JavaScript/TypeScript segue o padrão IEEE 754 (ponto flutuante de precisão dupla), o que introduz imprecisões e arredondamentos imprevisíveis. O uso de `BigInt` elimina completamente esse risco sem adicionar dependências externas de runtime.
- **Validação Estrita de Entrada:** Aceita apenas representações canônicas com exatamente duas casas decimais (`/^(?:0|[1-9]\d*)\.\d{2}$/`). Valores como `"00.00"`, `"01.50"`, números float ou strings vazias são estritamente rejeitados.
- **Moeda e Imutabilidade:** Operações aritméticas entre moedas distintas disparam `CurrencyMismatchError`. Cada instância é congelada com `Object.freeze`.

### 2.2 Agregado `Wallet`
- **Construtor Privado e Factories:** Instanciação controlada via `Wallet.create()` (nova carteira) e `Wallet.rehydrate()` (restauração do banco).
- **Semântica de Abertura:**
  - *Com saldo inicial positivo:* Cria a carteira, gera uma transação com tipo `OPENING` e emite um lançamento contábil no ledger com tipo `CREDIT`. A versão resultante permanece estritamente **1**.
  - *Com saldo inicial zero explícito (`"0.00"`):* Cria a carteira com saldo zero, sem transação de abertura, sem lançamento no ledger e sem eventos de outbox. A versão inicial é **1**.
- **Controle de Versão:** A propriedade `version` inicia em 1 e é incrementada apenas quando há alteração real de saldo (`debit` ou `credit`). Operações neutras como `LOSS` ou transações rejeitadas não alteram a versão.
- **Invariante de Não-Negatividade:** Saldo negativo é proibido tanto na entidade quanto no banco de dados (`chk_wallets_balance_non_negative`).

### 2.3 `WalletLedgerEntry` (Ledger Contábil Imutável)
- Cada movimentação financeira que altera saldo gera uma entrada imutável no livro-razão contábil.
- **Verificação de Aritmética Interna:** A entidade valida no momento da instanciação:
  - `CREDIT`: `balance_after == balance_before + amount`
  - `DEBIT`: `balance_after == balance_before - amount`

### 2.4 `WagerTransaction` e Máquina de Estados
- Registra cada operação de aposta (`BET`), crédito de ganho (`WIN`), perda neutra (`LOSS`), estorno de aposta (`REFUND`) ou reversão (`ROLLBACK`).
- **Estados:** `PENDING`, `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED`.
- **Transições Explícitas:** Toda transação nasce `PENDING` (ou `PENDING_REFERENCE` quando aguardando dependência) e transiciona para `PROCESSED`, `REJECTED` ou `FAILED`. Estados terminais são imutáveis e protegidos pelo método `isTerminal()` no domínio e por trigger com `IS DISTINCT FROM` no PostgreSQL.
- **Rehidratação Pura:** `WagerTransaction.rehydrate()` reconstrói o estado persistido sem disparar transições de ciclo de vida.

---

## 3. Generalização do Processamento Financeiro (`ProcessWagerUseCase`)

O caso de uso `ProcessWagerUseCase` centraliza e unifica todas as operações financeiras sem duplicação de fluxos, garantindo isolamento de regras de transporte:

### 3.1 Invariantes Independentes do Transporte HTTP
O caso de uso valida diretamente suas invariantes antes de abrir a transação de persistência:
1. `Idempotency-Key` obrigatória, não nula, não vazia e com no máximo 255 caracteres.
2. Operação permitida (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`).
3. Valor de `BET`, `WIN`, `REFUND` e `ROLLBACK` estritamente positivo (> "0.00").
4. `LOSS` com valor não negativo (>= "0.00").
5. Campos de negócio obrigatórios presentes (`providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`).
6. Validação de vínculo: a carteira `walletId` deve pertencer ao jogador `playerId`.
7. Consistência de moeda: a moeda informada deve coincidir com a moeda da carteira.
8. Hash canônico de payload baseado nos dados normalizados efetivamente processados.

### 3.2 Referências e Reversões
- `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`, resolvido por `providerId + referenceExternalTransactionId`.
- **Validações de Referência:**
  - Mesmo provider, player, wallet, moeda e rodada (`roundId`).
  - Referência deve estar no estado terminal `PROCESSED`.
  - `REFUND` referencia exclusivamente transação do tipo `BET`.
  - `ROLLBACK` referencia transação do tipo `BET`, `WIN` ou `REFUND`.
  - Valor da reversão deve ser integralmente igual ao valor da referência.
  - No máximo uma reversão processada por referência e tipo de operação (garantido no banco pelo índice parcial `uq_processed_reversal_per_reference`).
- **Saldo Insuficiente em Reversão:** Se um `ROLLBACK` de `WIN` exigir débito maior que o saldo disponível, a operação é rejeitada com código específico `REVERSAL_INSUFFICIENT_FUNDS` (distinto de `INSUFFICIENT_FUNDS`), sem lançar ledger.

### 3.3 Tratamento de Referências Fora de Ordem (`PENDING_REFERENCE`)
Quando uma reversão (`REFUND` ou `ROLLBACK`) chega antes da transação de referência:
1. O use case persiste a transação com status `PENDING_REFERENCE`, `attempts = 1` e agendamento de retry em `next_attempt_at`.
2. Publica o evento `WagerTransactionPendingReferenceEvent` na outbox.
3. Responde imediatamente ao chamador com HTTP 202 Accepted.
4. O worker agendado `ReprocessPendingReferencesUseCase` pesquisa transações pendentes elegíveis com lock pessimista `SKIP LOCKED`, reprocessando a operação financeira quando a referência é confirmada, ou aplicando backoff exponencial com jitter.
5. Se a referência for posteriormente rejeitada/falhada ou o limite de retries for esgotado, a transação transiciona para `REJECTED` com código estável `REFERENCE_NOT_PROCESSED` ou `REFERENCE_NOT_FOUND`.

---

## 4. Garantias e Proteções no Banco de Dados (PostgreSQL)

A integridade do sistema é sustentada por três migrações incrementais reversíveis (`001`, `002` e `003`):

### 4.1 Integridade Referencial Composta no Ledger
Constraint `fk_ledger_wager_tx_wallet_currency`:
```sql
ALTER TABLE wallet_ledger_entries 
    ADD CONSTRAINT fk_ledger_wager_tx_wallet_currency 
    FOREIGN KEY (transaction_id, wallet_id, currency) 
    REFERENCES wager_transactions (id, wallet_id, currency) 
    ON DELETE RESTRICT;
```
Impede fisicamente no PostgreSQL que um lançamento contábil pertencente à carteira B faça referência a uma transação registrada para a carteira A, ou com moeda divergente.

### 4.2 Proteção Rigorosa de Transações Terminais
Trigger `prevent_terminal_transaction_modification()` ativado antes de `UPDATE`:
```sql
IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') AND (
    NEW.wallet_id IS DISTINCT FROM OLD.wallet_id OR
    NEW.player_id IS DISTINCT FROM OLD.player_id OR
    NEW.provider_id IS DISTINCT FROM OLD.provider_id OR
    NEW.external_transaction_id IS DISTINCT FROM OLD.external_transaction_id OR
    NEW.round_id IS DISTINCT FROM OLD.round_id OR
    NEW.game_id IS DISTINCT FROM OLD.game_id OR
    NEW.kind IS DISTINCT FROM OLD.kind OR
    NEW.amount IS DISTINCT FROM OLD.amount OR
    NEW.currency IS DISTINCT FROM OLD.currency OR
    NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR
    NEW.payload_hash IS DISTINCT FROM OLD.payload_hash OR
    NEW.response_snapshot IS DISTINCT FROM OLD.response_snapshot OR
    NEW.status IS DISTINCT FROM OLD.status
) THEN
    RAISE EXCEPTION 'wager_transactions in terminal state cannot be modified'
        USING ERRCODE = '55000';
END IF;
```
Utiliza `IS DISTINCT FROM` para tratar com segurança valores nulos e protege integralmente todos os campos de identidade, payload e resultado original, permitindo apenas transições de estados não terminais (`PENDING` -> `PROCESSED`, etc.).

---

## 5. Eventos de Integração e Envelope Transacional

Todos os eventos gravados na outbox transacional seguem a estrutura padronizada `IntegrationEventEnvelope<T>`:
- `eventId`: UUID v4 único da mensagem.
- `eventType`: Nome canônico da classe do evento (ex: `WalletBalanceChangedEvent`).
- `version`: Versão do esquema do evento (padrão 1).
- `aggregateId`: ID do agregado raiz (carteira).
- `correlationId`: Identificador de correlação propagado fim a fim (até 255 caracteres).
- `causationId`: Identificador da causa da transação (chave de idempotência, até 255 caracteres).
- `occurredAt`: Timestamp ISO 8601 em UTC.
- `data`: Carga útil tipada da transação.

A entidade `IntegrationEvent` implementa `toEnvelope()` para serialização JSON padronizada e `reconstruct()` como ponto único de reconstrução testada.
