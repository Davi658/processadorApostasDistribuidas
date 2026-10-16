# Arquitetura e Decisões Técnicas — Processador de Apostas Distribuídas

Este documento detalha as decisões arquiteturais, garantias formais, modelagem de dados, estratégias de concorrência e idempotência, mecanismos de proteção no banco de dados e as limitações da primeira entrega.

---

## 1. Visão Geral e Organização do Código

O projeto segue estritamente os princípios de **Clean Architecture** e **Domain-Driven Design (DDD)**, com isolamento total das regras de negócio em relação a frameworks e ORM:

```
src/
├── domain/                      # Núcleo de domínio puro (zero dependência externa de NestJS/ORM)
│   ├── entities/               # Wallet, WagerTransaction, WalletLedgerEntry
│   ├── value-objects/          # Money (BigInt em centavos, imutável)
│   ├── errors/                 # Erros de domínio tipados
│   └── events/                 # Eventos de domínio (WagerTransactionProcessed, Rejected, BalanceChanged)
├── application/                 # Casos de uso e portas de entrada/saída
│   ├── use-cases/              # CreateWallet, GetWallet, ProcessBet, ReconcileWallet
│   ├── dto/                    # DTOs de entrada e saída
│   └── ports/                  # Interfaces de repositórios e Unit of Work
├── infrastructure/              # Adaptadores de persistência e banco de dados
│   └── persistence/
│       ├── migrations/         # Migrations SQL reversíveis (UP e DOWN)
│       ├── mikro-orm/          # Configuração e mapeamento MikroORM
│       ├── postgres/           # Adaptadores PostgreSQL nativos e UnitOfWork transacional
│       └── migrator.ts         # Runner autônomo de migrations
└── interfaces/
    └── http/                   # Camada de apresentação HTTP
        ├── controllers/        # WalletController, WageringController (NestJS)
        ├── filters/            # DomainExceptionFilter (mapeamento HTTP consistente)
        └── app.module.ts       # Módulo principal da aplicação NestJS
```

---

## 2. Modelagem do Domínio Financeiro

### 2.1 Decisão sobre o Valor Monetário (`Money`)
**Escolha Técnica:** `BigInt` representando centavos inteiros (`100 cents = 1.00 BRL`).

#### Justificativa da Escolha:
1. **Precisão Absoluta Sem Ponto Flutuante:** `number` em JavaScript/TypeScript segue o padrão IEEE 754 (ponto flutuante de precisão dupla), o que causa erros de arredondamento inaceitáveis para sistemas financeiros (ex.: `0.1 + 0.2 === 0.30000000000000004`).
2. **Desempenho e Zero Dependência de Runtime:** Ao contrário de bibliotecas como `decimal.js` ou `bignumber.js`, `BigInt` é nativo do motor V8/JavaScript, oferecendo operações aritméticas instantâneas com custo de alocação de memória mínimo.
3. **Imutabilidade e Escala Estrita:**
   - A entrada pública (`Money.create`) aceita exclusivamente strings no formato decimal com exatamente 2 casas decimais (`/^\d+\.\d{2}$/`).
   - Rejeição rigorosa de `NaN`, `Infinity`, notação científica (`1e5`), números com mais de duas casas e valores negativos no contrato de entrada.
   - Nenhuma conversão monetária é feita usando `number`. A conversão de string para `bigint` é feita via divisão léxica da parte inteira e decimal com preenchimento (`padEnd(2, '0')`), e a serialização de volta para string decimal é feita através de aritmética de strings inteiras.
   - Rejeição instantânea de operações aritméticas ou comparações entre moedas distintas (`CurrencyMismatchError`).
   - Objeto congelado em memória via `Object.freeze`.

### 2.2 Agregado `Wallet`
- **Construtor Privado:** Instanciação controlada através das factories `create()` (nova carteira) e `rehydrate()` (restauração do banco).
- **Abertura com Saldo (`initialBalance`):**
  - Se `initialBalance > 0`: Cria a carteira, gera uma transação interna com tipo `OPENING` e emite um lançamento contábil no ledger com tipo `CREDIT`.
  - A versão final resultante da abertura com saldo positivo é estritamente **1** (a transação de abertura compõe o estado inicial do agregado e não incrementa uma segunda vez).
  - Se `initialBalance == 0`: A carteira é criada com saldo zero, sem transação de abertura e sem geração de registro no ledger. Versão inicial **1**.
- **Controle de Versão:** A propriedade `version` inicia em 1 e **só é incrementada quando o saldo da carteira é efetivamente alterado** (débito ou crédito aprovado). Transações rejeitadas ou consultas não alteram a versão.
- **Invariante de Não-Negatividade:** O saldo nunca pode ser negativo. Qualquer tentativa de débito superior ao saldo dispara `InsufficientBalanceError` e preserva o estado anterior inalterado.

### 2.3 `WalletLedgerEntry` (Ledger Contábil Imutável)
- Cada movimentação financeira aprovada gera uma entrada imutável no livro-razão contábil.
- **Verificação de Aritmética Interna:** A entidade valida na construção se:
  - No `CREDIT`: `balance_after == balance_before + amount`
  - No `DEBIT`: `balance_after == balance_before - amount`
  Discrepâncias violam a integridade e disparam `InvalidWagerOperationError`.

### 2.4 `WagerTransaction`
- Registra cada operação de aposta (`BET`) ou transação interna (`OPENING`).
- Mantém o status final (`PROCESSED` ou `REJECTED`), o motivo de rejeição quando aplicável (`INSUFFICIENT_FUNDS`), o hash canônico do payload de negócio, e o snapshot do saldo observado no momento da operação para replay idempotente.

---

## 3. Garantias de Persistência no PostgreSQL

A integridade do sistema não se apoia apenas em código TypeScript; ela é **garantida e imposta pelo schema relacional do PostgreSQL**:

### 3.1 Garantias Estruturais no Banco de Dados
1. **Uma wallet por jogador e moeda:**
   ```sql
   CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency)
   ```
2. **Saldo não negativo:**
   ```sql
   CONSTRAINT chk_wallets_balance_non_negative CHECK (balance >= 0)
   ```
3. **Unicidade de chave de idempotência:**
   ```sql
   CONSTRAINT uq_wager_transactions_idempotency_key UNIQUE (idempotency_key)
   ```
4. **Unicidade de transação externa do provedor:**
   ```sql
   CONSTRAINT uq_wager_transactions_provider_external UNIQUE (provider_id, external_transaction_id)
   ```
5. **No máximo um lançamento contábil por transação e carteira:**
   ```sql
   CONSTRAINT uq_wallet_ledger_entries_tx_wallet UNIQUE (transaction_id, wallet_id)
   ```
6. **Integridade referencial estrita:**
   Chaves estrangeiras com `ON DELETE RESTRICT` ligando `wager_transactions` a `wallets`, e `wallet_ledger_entries` a `wallets` e `wager_transactions`.
7. **Aritmética do Ledger imposta por CHECK Constraint:**
   ```sql
   CONSTRAINT chk_ledger_arithmetic CHECK (
     (operation = 'CREDIT' AND balance_after = balance_before + amount) OR
     (operation = 'DEBIT' AND balance_after = balance_before - amount)
   )
   ```
8. **Imutabilidade Absoluta do Ledger no Banco (Trigger Guard):**
   ```sql
   CREATE OR REPLACE FUNCTION fn_prevent_wallet_ledger_modification()
   RETURNS TRIGGER AS $$
   BEGIN
     RAISE EXCEPTION 'wallet_ledger_entries is append-only: UPDATE and DELETE operations are strictly prohibited'
       USING ERRCODE = '55000';
   END;
   $$ LANGUAGE plpgsql;

   CREATE TRIGGER trg_protect_wallet_ledger_entries
   BEFORE UPDATE OR DELETE ON wallet_ledger_entries
   FOR EACH ROW
   EXECUTE FUNCTION fn_prevent_wallet_ledger_modification();
   ```
   Qualquer comando SQL de `UPDATE` ou `DELETE` contra a tabela `wallet_ledger_entries` falha imediatamente com código `55000`, mesmo se executado manualmente.

### 3.2 Princípio do Menor Privilégio (Separação de Usuários)
- **Usuário de Migrações (`postgres`):** Possui permissões DDL completas (`CREATE TABLE`, `CREATE TRIGGER`, `ALTER`, etc.).
- **Usuário da Aplicação (`app_user`):**
  - Permissões estritamente limitadas aos verbos DML necessários:
    ```sql
    GRANT CONNECT ON DATABASE betting_db TO app_user;
    GRANT USAGE ON SCHEMA public TO app_user;
    GRANT SELECT, INSERT, UPDATE ON TABLE wallets TO app_user;
    GRANT SELECT, INSERT, UPDATE ON TABLE wager_transactions TO app_user;
    GRANT SELECT, INSERT ON TABLE wallet_ledger_entries TO app_user; -- ZERO UPDATE / ZERO DELETE
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE outbox_messages TO app_user;
    ```
  - O usuário `app_user` não possui permissão de `UPDATE` ou `DELETE` na tabela `wallet_ledger_entries` em nível de permissões de catálogo do PostgreSQL.

---

## 4. Concorrência e Idempotência Persistente

### 4.1 Controle de Concorrência
- **Lock Pessimista de Linha:**
  - A operação de aposta adquire um lock exclusivo na linha da carteira específica dentro da transação SQL:
    ```sql
    SELECT wallet_id, player_id, currency, balance, version, created_at, updated_at
    FROM wallets
    WHERE wallet_id = $1
    FOR UPDATE
    ```
  - **Por que FOR UPDATE por linha?**
    Garante serialização estrita de operações financeiras concorrentes para a mesma carteira sem bloquear carteiras de outros jogadores.
  - **Zero Dependência de Memória:** Não há mutex local em processo, nem Redis nem lock global. A concorrência é gerenciada pelas garantias ACID do motor PostgreSQL.

### 4.2 Hash Canônico de Idempotência
Para garantir que a chave de idempotência represente exatamente a mesma intenção de negócio:
- **Campos incluídos no hash:** `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency`.
- **Exclusão de metadados de transporte:** Cabeçalhos HTTP, timestamps de rede, IPs e request IDs são excluídos do cálculo.
- **Normalização Canônica:** As chaves do objeto JSON são ordenadas recursivamente em ordem lexicográfica antes da serialização, garantindo que qualquer variação de ordenação de chaves produza exatamente o mesmo hash SHA-256.

### 4.3 Matriz de Comportamento de Idempotência
1. **Mesma chave de idempotência + Mesmo payload:**
   Retorna o resultado original registrado (`HTTP 200` para processada ou `HTTP 422` para rejeitada), incluindo o **saldo original observado** no momento da primeira execução (replay seguro).
2. **Mesma chave de idempotência + Payload diferente:**
   Detecta inconsistência de contrato e rejeita com `HTTP 409 Conflict` (`IdempotencyConflictError`).
3. **Outra chave com o mesmo `providerId` + `externalTransactionId`:**
   Viola a unicidade externa de transação e rejeita com `HTTP 409 Conflict` sem movimentar saldo.
4. **Rejeição por saldo insuficiente:**
   É persistida na tabela `wager_transactions` com status `REJECTED`, motivo `INSUFFICIENT_FUNDS` e saldo observado, gerando evento de auditoria na outbox, mas **sem alterar o saldo da carteira e sem registrar lançamento no ledger**.

### 4.4 Atomicidade com Transactional Outbox
Toda a operação financeira e seus efeitos colaterais são confirmados atomicamente em uma única transação SQL (`PostgresUnitOfWork`):
- Atualização do saldo da carteira (`wallets`);
- Registro da transação (`wager_transactions`);
- Registro contábil no ledger (`wallet_ledger_entries`, se aprovada);
- Eventos de domínio na outbox (`outbox_messages`):
  - `WagerTransactionProcessed` (se aprovada);
  - `WagerTransactionRejected` (se rejeitada);
  - `WalletBalanceChanged` (gerado **exclusivamente** quando há alteração real de saldo).

Se qualquer falha ou exceção ocorrer antes do commit, o PostgreSQL executa `ROLLBACK` completo de todas as tabelas.

---

## 5. Reconciliação Contábil

### Endpoint: `POST /wallets/:walletId/reconciliation`
- **Isolamento de Leitura Consistente:**
  A reconciliação é executada sob uma transação com isolamento consistente:
  1. Lê o saldo atual armazenado na tabela `wallets` (`storedBalance`).
  2. Executa a soma agregada de todos os lançamentos contábeis no ledger para aquela carteira:
     ```sql
     SELECT 
       COALESCE(SUM(CASE WHEN operation = 'CREDIT' THEN amount ELSE -amount END), 0) as calculated_cents,
       COUNT(*) as checked_entries
     FROM wallet_ledger_entries
     WHERE wallet_id = $1
     ```
  3. Reconstitui `calculatedBalance = calculated_cents / 100.00`.
  4. Calcula `difference = storedBalance - calculatedBalance`.
  5. Retorna status booleano `consistent: difference == 0`.
- **Invariante:** O sistema **nunca corrige divergências automaticamente**. Qualquer divergência é reportada para investigação de auditoria.

---

## 6. Mapeamento HTTP Consistente

O filtro global de exceções (`DomainExceptionFilter`) mapeia erros de domínio para códigos de status HTTP claros:

| Código de Erro de Domínio | Status HTTP | Significado |
|---|---|---|
| `InvalidMoneyError` | `400 Bad Request` | Valor monetário com formatação inválida, escala excessiva ou não numérico |
| `CurrencyMismatchError` | `400 Bad Request` | Moeda incompatível com a carteira ou operação |
| `InvalidWagerOperationError`| `400 Bad Request` | Operação diferente de BET ou aritmética violada |
| `WalletNotFoundError` | `404 Not Found` | Carteira informada não existe |
| `DuplicateWalletError` | `409 Conflict` | Já existe uma carteira cadastrada para o jogador e moeda |
| `IdempotencyConflictError` | `409 Conflict` | Chave de idempotência reutilizada com payload divergente ou transação externa duplicada |
| `InsufficientBalanceError` | `422 Unprocessable` | Saldo insuficiente para débito de aposta |
| Erros transitórios de BD | `500 / 503` | Falha de infraestrutura com rollback garantido |

---

## 7. Evidências dos Testes de Concorrência e Distribuição

A estabilidade e invariantes do sistema foram comprovadas contra uma instância real de **PostgreSQL 16.8** através de testes automatizados com o executor Bun:

1. **50 Submissões Simultâneas da Mesma BET:**
   - 50 promises concorrentes disparadas via `Promise.all` com o mesmo payload e a mesma idempotency key.
   - **Resultado:** Exatamente 1 débito executado. 49 requisições receberam o replay seguro com o mesmo saldo observado. A reconciliação contábil final confirmou diferença `0.00` e total consistência.
2. **Corrida Concorrente de Duas BETs de 80.00 sobre Saldo 100.00:**
   - Duas requisições simultâneas disputando o saldo da mesma carteira com chaves de idempotência diferentes.
   - **Resultado:** Exatamente 1 aposta foi processada (saldo passou para `20.00`), e a outra foi rejeitada com `INSUFFICIENT_FUNDS`. O saldo final foi de exatamente `20.00`, sem saldo negativo ou corrida crítica.
3. **Múltiplos Processos de Sistema Operacional (3 Processos Concorrentes Reais):**
   - 3 processos de sistema operacional independentes instanciados via `Bun.spawn` executando `worker.ts`, operando contra o mesmo PostgreSQL compartilhado.
   - **Resultado:** Serialização garantida pelo banco via `FOR UPDATE`. Zero condições de corrida ou sobre-débito interprocessos.
4. **Testes de Migrations Reversíveis em Banco Descartável:**
   - Criação de banco descartável no PostgreSQL (`CREATE DATABASE`).
   - Aplicação de `migrator.up()` com verificação de tabelas e triggers.
   - Aplicação de `migrator.down()` com verificação de limpeza completa.
   - Destruição do banco descartável.

---

## 8. Status dos Requisitos: Implementado, Testado e Pendente

### Implementado e Testado
- [x] Objeto de valor `Money` com `BigInt` em centavos, validação rigorosa de escala e formatação, imutabilidade e detecção de conflito de moedas.
- [x] Agregado `Wallet` com versionamento (inicia em 1, incrementa apenas em mutação de saldo), criação com saldo zero (sem ledger) e saldo positivo (transação `OPENING` + `CREDIT` no ledger).
- [x] Entidade `WalletLedgerEntry` imutável com verificação de aritmética contábil.
- [x] Entidade `WagerTransaction` com estados `PROCESSED` e `REJECTED`, motivo de rejeição e snapshot de saldo.
- [x] Migrations reversíveis SQL (UP e DOWN) com constraints de banco de dados e trigger de proibição de UPDATE/DELETE no ledger.
- [x] Script e configuração de usuário de aplicação com privilégios restritos (`app_user`).
- [x] Endpoints `POST /wallets` e `GET /wallets/:walletId`.
- [x] Endpoint `POST /wagering/transactions` aceitando exclusivamente `kind=BET` com header obrigatório `Idempotency-Key`.
- [x] Hash SHA-256 canônico de negócio excluindo metadados de transporte.
- [x] Idempotência persistente com replay de saldo original e detecção de conflitos de payload e de chave externa.
- [x] Lock de linha `FOR UPDATE` por carteira com transações atômicas e outbox transacional.
- [x] Endpoint de reconciliação `POST /wallets/:walletId/reconciliation` com leitura consistente.
- [x] Suíte completa de testes unitários (24 testes).
- [x] Suíte completa de testes de integração com PostgreSQL real (17 testes).
- [x] Suíte de testes de concorrência com 50 requisições simultâneas, disputa concorrente de saldo e 3 processos reais de SO (3 testes).

### Pendente (Fora do Escopo desta Primeira Entrega)
- [ ] Outras operações de aposta (`WIN`, `LOSS`, `REFUND`, `ROLLBACK`).
- [ ] Publisher assíncrono para esvaziar a tabela `outbox_messages` para broker externo (AWS SQS, Kafka ou RabbitMQ).
- [ ] Autenticação e autorização (API Keys, JWT, OAuth2).
- [ ] Interface visual / Frontend.
