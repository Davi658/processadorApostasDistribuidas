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

### 3.2 Motor Unificado de Validação e Aplicação de Reversões (`ReversalProcessor` — M08)
Para eliminar qualquer discrepância de regras entre o fluxo imediato (`ProcessWagerUseCase`) e o worker agendado (`ReprocessPendingReferencesUseCase`), a lógica de validação e movimentação financeira de reversões foi extraída e centralizada no serviço reutilizável `ReversalProcessor`:
- **Transação Única In-Flight:** O `ReversalProcessor` não cria novas transações de banco de dados; executa diretamente dentro do escopo transacional já aberto pelo caso de uso (`uow.runInTransaction`).
- **Validações Pré-Movimento Obrigatórias:**
  1. *Resolução da Referência:* Identificada por `providerId + referenceExternalTransactionId`.
  2. *Status Terminal Válido:* Referência deve estar no estado `PROCESSED`. Se estiver em `REJECTED` ou `FAILED`, a reversão é rejeitada com código estável `REFERENCE_NOT_PROCESSED`.
  3. *Compatibilidade Rigorosa:*
     - Mesmo provider (`providerId`).
     - Mesmo jogador (`playerId.toLowerCase()`).
     - Mesma carteira (`walletId.toLowerCase()`).
     - Mesma moeda (`currency`).
     - Mesma rodada (`roundId`).
     - Valor integral idêntico (`money.getAmount() == refTx.money.getAmount()`).
     - Regra de tipo: `REFUND` referencia exclusivamente transação do tipo `BET`; `ROLLBACK` referencia `BET`, `WIN` ou `REFUND`.
     - *Falha de compatibilidade:* Resulta em `REJECTED` persistida com código estável `REFERENCE_INCOMPATIBLE`.
  4. *Garantia de Reversão Única por Tipo:* Consulta no banco se já existe reversão `PROCESSED` do mesmo tipo para aquela referência (`findByProviderAndReference`). Se existir, resulta em `REJECTED` com código estável `REVERSAL_ALREADY_PROCESSED`. A política não impõe exclusividade global entre `REFUND` e `ROLLBACK`, sendo garantida no banco pelo índice parcial `uq_processed_reversal_per_reference`.
  5. *Proteção de Saldo Negativo:* Se a reversão exigir débito (`ROLLBACK` de `WIN` ou `REFUND`) e o saldo for insuficiente, a reversão é rejeitada com código estável `REVERSAL_INSUFFICIENT_FUNDS`.
- **Invariantes em Cenários de Rejeição:**
  - Status `REJECTED` é persistido com seu respectivo `failureCode` e snapshot terminal completo (`response_snapshot` com `transactionId`, `status: 'REJECTED'`, `failureCode` e `balance`).
  - Publica exclusivamente o evento `WagerTransactionRejectedEvent` na tabela `outbox_messages` (coluna `payload` contendo `transactionId` e `failureCode`).
  - **Zero movimentação financeira e ausência auditada:** Saldo da carteira não se altera, versão não é incrementada, nenhum registro contábil é criado em `wallet_ledger_entries` para a reversão, e nenhum evento `WalletBalanceChangedEvent` (`payload.triggerTransactionId`) ou `WagerTransactionProcessedEvent` (`payload.transactionId`) é emitido.

### 3.3 Tratamento de Referências Fora de Ordem (`PENDING_REFERENCE`)
Quando uma reversão (`REFUND` ou `ROLLBACK`) chega antes da transação de referência:
1. No fluxo imediato, o use case persiste a transação com status `PENDING_REFERENCE`, `attempts = 1` e agendamento de retry em `next_attempt_at`.
2. Publica o evento `WagerTransactionPendingReferenceEvent` na outbox e responde imediatamente com HTTP 202 Accepted.
3. O serviço `ReprocessPendingReferencesUseCase` pesquisa transações pendentes elegíveis com lock pessimista `SKIP LOCKED`, delegando a validação e movimentação ao `ReversalProcessor` sob a mesma regra do fluxo imediato.
4. Se a referência ainda estiver ausente ou pendente: aplica backoff exponencial com jitter (até 5 tentativas). Esgotadas as tentativas, transiciona terminalmente para `REJECTED` com código `REFERENCE_NOT_FOUND`.
5. Se a referência for posteriormente confirmada (ou rejeitada/falhada/incompatível), ambos os caminhos (referência prévia imediata ou referência tardia com reprocessador) produzem exatamente o mesmo resultado contábil, saldo, versão, ledger, outbox e reconciliação.
6. **Delimitação Estrita de Escopo (M08 vs M10):** A validação de M08 abrange exclusivamente a integridade contábil, a compatibilidade de regras e o reprocessamento determinístico das pendências. O agendamento contínuo em background, a concorrência distribuída entre múltiplos workers e a integração com SQS pertencem à frente M10 e permanecem marcados como **NÃO VALIDADO** nesta etapa.

### 3.4 Operações de Ganho e Perda: WIN e LOSS (M06)
A estabilização de `WIN` e `LOSS` (M06) assegura a precisão contábil, a idempotência terminal e o tratamento correto de referências para fechamento de apostas:
1. **Garantias de WIN (Crédito):**
   - **Movimentação Exata:** Credita exatamente o valor especificado na carteira.
   - **Versão Incrementada:** Incrementa o `version` da carteira em exatamente 1 a cada crédito efetivo.
   - **Registro Contábil:** Insere 1 registro em `wager_transactions` com status `PROCESSED` e 1 lançamento do tipo `CREDIT` em `wallet_ledger_entries`, vinculado via foreign key composta.
   - **Eventos de Outbox:** Emite exatamente 2 eventos na mesma transação SQL: `WagerTransactionProcessed` e `WalletBalanceChanged`.
   - **Limite Money e Overflow:** Suporta créditos que atinjam o limite máximo `NUMERIC(18,2)` (`9999999999999999.99`). Tentativas de crédito que resultem em overflow lançam `MoneyOverflowError` (`code: 'MONEY_OVERFLOW'`), abortando a transação integralmente sem efeitos parciais no banco.
2. **Garantias de LOSS (Sem Movimentação):**
   - **Preservação Integral da Carteira:** Não altera saldo, versão nem `updated_at` da carteira (`wallets`).
   - **Ausência de Ledger:** Não gera nenhum lançamento contábil em `wallet_ledger_entries`.
   - **Evento Único:** Emite exclusivamente `WagerTransactionProcessed` na tabela `outbox_messages` (zero emissão de `WalletBalanceChanged`).
   - **Valor Zero e Valores Positivos:** Aceita valor zero (`0.00`) conforme política documentada. Mesmo quando informada com valor positivo, nunca movimenta o saldo da carteira.
   - **Proibição de Referência:** A operação `LOSS` não permite `referenceExternalTransactionId`, sendo rejeitada com 400 Bad Request se fornecida.
3. **Política de WIN com Referência (Imediata e Fora de Ordem):**
   - A operação `WIN` aceita `referenceExternalTransactionId` opcional apontando para uma `BET`. Quando omitida, opera como ganho independente.
   - **Referência Ausente ou Pendente (`PENDING` / `PENDING_REFERENCE`):** Não é rejeitada imediatamente; transiciona para `PENDING_REFERENCE` com HTTP 202 Accepted, armazena snapshot completo de resposta e emite evento `WagerTransactionPendingReferenceEvent` na outbox.
   - **Resolução de Pendência (`WinProcessor`):** A resolução reaproveita deterministicamente a mesma regra de domínio de `WIN` do fluxo imediato via `WinProcessor` (sem encaminhar para o `ReversalProcessor` exclusivo de reversões).
   - **Validação de Referência `PROCESSED`:** Exige que a transação referenciada seja do tipo `BET` e possua mesmo provedor, jogador, carteira, moeda e rodada. Não se exige igualdade de valor monetário entre a WIN e a BET (ganho não é reversão).
   - **Referência Incompatível:** Transiciona para `REJECTED` auditável com código estável `REFERENCE_INCOMPATIBLE`, sem qualquer movimentação de saldo ou ledger.
   - **Referência Rejeitada ou com Falha (`REJECTED` / `FAILED`):** Transiciona para `REJECTED` auditável com código estável `REFERENCE_NOT_PROCESSED`, sem crédito na carteira.
4. **Múltiplas WINs na Mesma BET (Migration 004):**
   - A migration incremental `004_restrict_reversal_unique_index.sql` restringe a unicidade do índice `uq_processed_reversal_per_reference` exclusivamente a operações de reversão (`kind IN ('REFUND', 'ROLLBACK')`).
   - Múltiplas operações `WIN` vinculadas à mesma `BET` são plenamente suportadas, tanto sequencialmente quanto concorrentemente, desde que com idempotency keys e identificadores externos próprios.
   - Em caso de rollback da migration (`down`), a recusa é executada com segurança caso existam dados incompatíveis com o índice antigo, abortando sem apagar nenhum registro.
5. **Replay Histórico e Resolução de Conflitos:**
   - O reenvio da mesma `Idempotency-Key` com o mesmo payload retorna os dados originais (`transactionId`, status e saldo histórico) com `idempotentReplay: true`.
   - Transações resolvidas após período de pendência mantêm imutável seu snapshot terminal registrado no momento do processamento efetivo.
   - Alterações de saldo posteriores por outras operações não afetam o saldo histórico registrado no snapshot do replay.
   - Conflitos de payload sob a mesma chave ou reutilização do mesmo identificador externo sob chaves diferentes retornam HTTP 409 `IDEMPOTENCY_CONFLICT` sem qualquer alteração no PostgreSQL.
6. **Delimitação Estrita de Escopo:**
   - As provas de M06 atestam as regras financeiras de WIN e LOSS, idempotência, concorrência direta e resolução de pendências em PostgreSQL real.
   - O agendamento periódico/background, a concorrência distribuída entre múltiplos workers e a infraestrutura SQS/mensageria pertencem a M09, M10 e M15 e permanecem como **NÃO VALIDADO / NÃO IMPLEMENTADO**.

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

---

## 6. Hash de Idempotência e Compatibilidade com Registros Anteriores

### 6.1 Serialização Canônica Recursiva
O método `ProcessWagerUseCase.computePayloadHash` utiliza serialização canônica recursiva (`canonicalStringify`):
- Ordena alfabeticamente as chaves de objetos em todos os níveis de aninhamento.
- Preserva a ordem estrita de elementos em arrays.
- Inclui todos os campos de negócio normalizados: `externalTransactionId`, `gameId`, `kind`, `money: { amount, currency }`, `playerId`, `providerId`, `roundId`, `walletId` e `referenceExternalTransactionId` (se aplicável).
- Exclui metadados de transporte (`correlationId`, cabeçalhos HTTP, timestamps).
- Calcula o digest SHA-256 sobre a representação canônica em UTF-8.

### 6.2 Política de Compatibilidade de Registros Anteriores
- **Algoritmo Legado:** Registros de transações persistidos antes desta correção foram gerados pelo algoritmo legado (que omitia as chaves aninhadas `amount` e `currency` do objeto `money`).
- **Decisão Explícita de Compatibilidade:** Registros anteriores utilizam o algoritmo legado e exigem uma decisão explícita de compatibilidade antes de qualquer intervenção ou migração. Não há suposição de expiração automática ou descarte de chaves.
- **Imutabilidade Preservada:** Os hashes de transações já gravadas no banco de dados não são regravados silenciosamente, em conformidade com as restrições relacionais de transações terminais protegidas por trigger no PostgreSQL.

---

## 7. Precisão Monetária, Limites NUMERIC(18,2) e Política de Overflow (M02)

### 7.1 Limites entre Domínio e Persistência
A representação monetária é governada pelo Value Object `Money`, alinhado estritamente com as colunas `NUMERIC(18,2)` do PostgreSQL e entidades MikroORM:
- **Precisão Total:** 18 dígitos, com escala fixa de 2 casas decimais (máximo de 16 dígitos inteiros).
- **Limite Máximo Superior:** `"9999999999999999.99"` (`999_999_999_999_999_999n` centavos).
- **Limite Mínimo Assinado:** `"-9999999999999999.99"` (`-999_999_999_999_999_999n` centavos).
- **Sem Conversão para Number:** Dinheiro nunca transita como tipo `number` do JavaScript em nenhuma camada (domínio, DTO, ORM ou driver SQL). Todos os cálculos internos utilizam `bigint` para centavos e manipulação de string decimal canônica. Valores acima de `Number.MAX_SAFE_INTEGER` (`9007199254740991`) operam com precisão exata e sem perdas de ponto flutuante.

### 7.2 Política de Overflow e Prevenção de Erros SQL
- **Validação Antecipada no Domínio:** Limites são validados no construtor privado e em todas as operações (`create`, `rehydrate`, `fromCents`, `add`, `subtract`).
- **Tratamento de Exceções:** Quando uma operação aritmética ou entrada excede a capacidade do banco, o domínio lança `MoneyOverflowError` (`code: 'MONEY_OVERFLOW'`), que estende `InvalidMoneyError`.
- **Prevenção de Falhas SQL:** A falha é interceptada antes de atingir o banco de dados, evitando erros inesperados de driver (`numeric field overflow 22003`). No HTTP, é mapeada para `400 Bad Request`.
- **Atomicidade Total:** Quando uma operação é recusada por estouro de limite dentro de uma unidade de trabalho (`UnitOfWork`), a transação é abortada e nenhuma mutação parcial ocorre: saldo, versão, transação, ledger e outbox permanecem intactos.

### 7.3 Diferenciação de Entradas Externas e Valores Negativos Internos
- **Entradas Externas (`Money.create`):** Aceitam estritamente strings decimais canônicas positivas ou `"0.00"` (`/^(?:0|[1-9]\d*)\.\d{2}$/`). Rejeitam qualquer valor negativo (inclusive `"-0.00"`), `NaN`, `Infinity`, notação científica, espaços em branco e escalas diferentes de 2 casas.
- **Valores Negativos Internos (`Money.subtract`, `Money.rehydrate`, `Money.fromCents`):** Suportam valores negativos assinados (até `MIN_SIGNED_LIMIT`), exclusivamente para cálculo de deltas contábeis e divergências de reconciliação financeira (ex: `storedBalance.subtract(calculatedBalance)`).
- **Proteção do Saldo:** O saldo de carteira (`Wallet.balance`) nunca pode ser negativo, garantido pela regra de domínio e pela constraint `CHECK (balance >= 0)` no PostgreSQL.

---

## 8. Abertura de Carteira e Invariantes de Criação (M03)

### 8.1 Contrato e Semântica de `initialBalance`
O endpoint `POST /wallets` aceita o corpo `{ playerId: string, initialBalance?: { amount: string, currency: string } }`:
- **Normalização e Validação de `playerId`:**
  - Validado estritamente como formato canônico UUID.
  - Normalizado com `trim()` e convertido para minúsculas (`toLowerCase()`) antes de qualquer consulta ou persistência, garantindo que variações de caixa ou espaços externos apontem para a mesma identidade.
- **Normalização de `initialBalance.amount`:**
  - Não sofre `trim()`. A string original é encaminhada diretamente ao Value Object `Money.create`, rejeitando formatos não canônicos com espaços (`" 10.00"` ou `"10.00 "`) conforme a regra monetária.
- **Moeda:**
  - Normalizada em maiúsculas (`toUpperCase()`) e restrita operacionalmente a `"BRL"`.
- **Ausência vs. Nulos:**
  - Quando `initialBalance` é **ausente** (omitido no JSON ou `undefined`), a carteira é criada com saldo zero (`"0.00"` BRL), `version = 1`, sem movimentos contábeis.
  - Valores como `null`, `false`, `0`, `""` ou primitivos avulsos são estritamente rejeitados com `400 Bad Request`.
  - Se fornecido, deve ser um objeto contendo `amount` (string decimal canônica com 2 casas) e `currency` (`"BRL"`).

### 8.2 Atomicidade e Movimentação Financeira de Abertura
- **Abertura Positiva (`initialBalance > 0`):**
  - Executada atomicamente na mesma transação SQL via `UnitOfWork`.
  - Insere registro na tabela `wallets` com o saldo e `version = 1`.
  - Cria transação interna com `kind = 'OPENING'`, `providerId = 'SYSTEM'`, `status = 'PROCESSED'`, `amount = initialBalance` e chave de idempotência `OPENING_{walletId}`.
  - Cria lançamento contábil em `wallet_ledger_entries` do tipo `CREDIT`, com `balance_before = '0.00'` e `balance_after = initialBalance`, referenciando a transação OPENING.
  - Publica dois eventos na tabela `outbox_messages`: `WagerTransactionProcessed` e `WalletBalanceChanged`.
- **Abertura Zero (`initialBalance == 0` ou ausente):**
  - Insere registro em `wallets` com saldo `"0.00"` e `version = 1`.
  - Não gera transação `OPENING`.
  - Não gera lançamento no ledger.
  - Não gera eventos na outbox.

### 8.3 Unicidade por Jogador e Moeda
- **Garantia Física:** A constraint única `uq_wallets_player_currency` em `wallets(player_id, currency)` impede carteiras duplicadas para a mesma moeda.
- **Tratamento Concorrente:** Requisições simultâneas que disputam a criação concorrem no PostgreSQL; exatamente uma é persistida e as demais recebem o erro `23505`, sendo traduzidas para `DuplicateWalletError` e retornando HTTP `409 Conflict`.

### 8.4 Proteção da Operação OPENING
- A operação `OPENING` é estritamente interna e gerada exclusivamente pelo ciclo de criação de carteira.
- Qualquer tentativa de cliente submeter uma transação externa com `kind: "OPENING"` no endpoint `POST /wagering/transactions` é rejeitada na validação de domínio e HTTP com `400 Bad Request`.

---

## 9. BET e Replay Terminal (M04)

### 9.1 Atomicidade e Ciclo de Vida da Operação BET
- **Débito Único:** Uma operação `BET` com valor positivo debita os fundos da carteira exatamente uma vez, persistindo a transação com `status = 'PROCESSED'`, inserindo um lançamento contábil `DEBIT` no ledger, e gravando na outbox os eventos `WagerTransactionProcessed` e `WalletBalanceChanged`.
- **Saldo Insuficiente:**
  - Se `wallet.balance < betMoney`, a transação é persistida com `status = 'REJECTED'` e código estável `failureCode = 'INSUFFICIENT_FUNDS'`.
  - O saldo da carteira (`balance`) e o número de versão (`version`) permanecem **intactos**.
  - **Nenhum** lançamento de débito é gerado no ledger contábil (`wallet_ledger_entries`).
  - É publicado exclusivamente o evento `WagerTransactionRejectedEvent` na outbox, sem emitir `WalletBalanceChangedEvent`.
  - No HTTP, retorna status `422 Unprocessable Entity` contendo o payload de rejeição com `idempotentReplay: false`.
- **Atomicidade SQL:** Todas as mutações (`wallets`, `wager_transactions`, `wallet_ledger_entries`, `outbox_messages`) executam na mesma transação PostgreSQL sob lock pessimista na carteira (`SELECT ... FOR UPDATE`), garantindo que falhas em qualquer etapa abortem integralmente as operações.

### 9.2 Semântica de Replay Terminal e Imutabilidade
- **Replay de PROCESSED:** Retorna `transactionId`, `status: 'PROCESSED'`, `balance` (o saldo resultante original no momento da aposta) e `idempotentReplay: true`.
- **Replay de REJECTED:** Retorna `transactionId`, `status: 'REJECTED'`, `failureCode: 'INSUFFICIENT_FUNDS'`, `balance` (o saldo original no momento da rejeição) e `idempotentReplay: true`.
- **Preservação do Saldo Atual:** O replay terminal preserva o snapshot da operação original sem sobrescrever o saldo corrente da carteira no banco de dados. Caso operações subsequentes tenham alterado o saldo (ex: outra BET ou um crédito via WIN), o replay reporta o saldo original da transação consultada e mantém o saldo atual no banco intacto.
- **Inércia Contábil e de Eventos:** O replay não realiza novas mutações contábeis no ledger e não insere novas mensagens na tabela de outbox.

### 9.3 Deduplicação e Conflitos de Idempotência
- **Mesma Chave com Payload Divergente:** Quando uma mesma `idempotencyKey` é submetida com parâmetros divergentes (verificados pelo hash SHA-256 canônico), o processador lança `IdempotencyConflictError`, resultando em HTTP `409 Conflict`. Nenhum efeito financeiro é gerado.
- **Chave Disputada por Carteiras Diferentes:** Se duas carteiras disputarem a mesma chave de idempotência concorrentemente, o PostgreSQL resolve a constraint única: a vencedora completa o débito e a perdedora recebe 409 Conflict sem nenhuma alteração parcial em seu saldo, ledger ou outbox.
- **Deduplicação de Provedor (`providerId + externalTransactionId`):** O par `(providerId, externalTransactionId)` é único no banco (`uq_wager_transactions_provider_external`). Se um identificador de provedor já processado for reenviado sob outra chave de idempotência, a solicitação é recusada com `409 Conflict`, impedindo duplo efeito financeiro.

### 9.4 Classificação Estrita de Violações de Unicidade (PostgreSQL 23505)
O processador inspeciona a causa raiz exata de erros com código `23505` (`unique_violation`):
- `uq_wager_transactions_idempotency_key`: Identifica colisão de chave de idempotência concorrente. Realiza consulta segura fora da transação abortada; se o hash canônico coincidir, retorna o snapshot terminal com `idempotentReplay: true`; se diferir, lança `IdempotencyConflictError` (409).
- `uq_wager_transactions_provider_external`: Identifica colisão em transação de provedor, lançando `IdempotencyConflictError` (409).
- `uq_processed_reversal_per_reference`: Identifica colisão em reversão duplicada para mesma referência, lançando `IdempotencyConflictError` (409).
- **Outras Constraints:** Violações de outras constraints (ex: `uq_wallets_player_currency` ou constraints arbitrárias) **não** são convertidas indevidamente em conflito de idempotência, sendo repassadas integralmente com seu código e tipo de exceção originais.

### 9.5 Rollback Integral e Injeção de Falhas
- Quatro pontos de hook auditados garantem a reversão completa em caso de exceções:
  1. `after_wallet_save`: Falha após atualizar saldo da carteira.
  2. `after_tx_save`: Falha após salvar transação `wager_transactions`.
  3. `after_ledger_save`: Falha após salvar lançamento no ledger.
  4. `after_outbox_save`: Falha após salvar primeira mensagem na outbox.
- Todos os identificadores da tentativa são capturados e auditados diretamente no PostgreSQL, confirmando ausência total de registros órfãos após rollback.
- O reenvio subsequente da operação confirma a conclusão bem-sucedida com um único efeito final consolidado.

---

## 10. Persistência MikroORM e Unidade de Trabalho (M05)

### 10.1 Isolamento Transacional e Gestão de Contexto
A unidade de trabalho `MikroOrmUnitOfWork` implementa a porta `UnitOfWorkPort` e gerencia a fronteira transacional utilizando o mecanismo nativo `AsyncLocalStorage` do Node.js:
- **EntityManager Transacional Isolado:** Cada invocação de `uow.runInTransaction` gera um novo fork isolado do EntityManager via `orm.em.transactional(async (forkedEm) => ...)`.
- **Zero Compartilhamento de Identity Map Global:** O root EntityManager da aplicação nunca é utilizado para consultas ou gravações de requisições. Dentro da transação, todas as operações usam exclusivamente o Identity Map privado do `forkedEm`. Fora de transação, consultas simples realizam seu próprio fork descartável, impedindo vazamento de entidades ou poluição cruzada entre requisições concorrentes.
- **Identidade Transacional e Compartilhamento de Conexão:** Dentro de uma transação aberta, todos os repositórios (`MikroOrmWalletRepository`, `MikroOrmWagerTransactionRepository`, `MikroOrmWalletLedgerRepository`, `MikroOrmOutboxRepository`) obtêm o EntityManager ativo via `uow.getEntityManager()`. Testes com PostgreSQL real comprovam que todas as gravações dos 4 repositórios executam exatamente sob o mesmo PID de conexão física (`SELECT pg_backend_pid()`) e sob o mesmo identificador de transação (`SELECT txid_current()`).
- **Locks Pessimistas Exclusivamente na Transação:** O método `walletRepo.findById(id, lockForUpdate = true)` exige explicitamente transação ativa. Qualquer tentativa de invocar lock pessimista fora da Unit of Work lança `TransactionRequiredError`, impedindo que locks de linha no PostgreSQL sejam imediatamente liberados por auto-commit.

### 10.2 Proteção Contra Gravação Isolada Acidental (Escrita sem UoW Rejeitada)
- Todos os repositórios de escrita (`walletRepo.save`, `wagerRepo.save`, `ledgerRepo.save`, `outboxRepo.save`) possuem guardas que verificam `this.uow.isTransactionActive()`.
- Se uma operação de escrita for invocada fora de um bloco `runInTransaction`, o repositório lança imediatamente `TransactionRequiredError` (`code: 'TRANSACTION_REQUIRED'`), sem emitir comandos SQL nem alterar o banco de dados.
- Consultas simples de leitura (`findById`, `findByPlayerIdAndCurrency`, `findByIdempotencyKey`, `listByWalletId`, `listUnpublished`) podem ser executadas fora de transação com isolamento de leitura via fork descartável.

### 10.3 Semântica de Chamadas Aninhadas e Estratégia Rollback-Only
O `MikroOrmUnitOfWork` rastreia a profundidade de execução (`depth`) e o estado de abortamento (`rollbackOnly`) no contexto transacional:
1. **Reutilização da Transação Externa:** Chamadas aninhadas a `runInTransaction` reutilizam a transação externa e o mesmo `forkedEm`, incrementando o contador de profundidade.
2. **Não-Confirmação Independente:** O bloco interno não emite `COMMIT` nem confirma dados independentemente. O commit no PostgreSQL é executado exclusivamente pelo bloco mais externo (profundidade 0).
3. **Falha Externa Desfaz Trabalho Interno:** Caso o bloco interno execute com sucesso e ocorra uma falha subsequente no bloco externo, todo o trabalho — interno e externo — é revertido atomicamente no PostgreSQL.
4. **Estratégia Rollback-Only para Falha Interna Capturada:**
   - Se uma chamada aninhada falhar com erro e a camada externa capturar o erro em bloco `try/catch` para tentar commitar dados parciais, o Unit of Work marca o contexto com `rollbackOnly = true` e armazena `rollbackReason`.
   - Ao finalizar o bloco raiz (depth 0), o Unit of Work inspeciona `context.rollbackOnly`. Se verdadeiro, impede a execução de `flush()` e lança `TransactionRollbackOnlyError`, preservando o erro original em `cause`. Da mesma forma, qualquer chamada aninhada subsequente que tente executar trabalho sobre um contexto já marcado como `rollbackOnly` é imediatamente rejeitada com `TransactionRollbackOnlyError`, preservando `cause`.
   - O wrapper transacional do MikroORM captura o erro e emite `ROLLBACK` ao PostgreSQL, garantindo que nenhum commit parcial ocorra no banco.

### 10.4 Ciclo de Vida NestJS e Liberação de Recursos
- `MikroOrmUnitOfWork` implementa `OnModuleInit` e `OnModuleDestroy`.
- Na inicialização (`app.init()`), o pool MikroORM é provisionado e conectado sem necessidade de chamadas manuais a `onModuleInit`.
- No encerramento da aplicação Nest (`app.close()`), os pools e conexões físicas são fechados automaticamente. A suíte dedicada M05 atesta via `pg_stat_activity` (usando conexão administrativa identificada separadamente) que zero conexões ativas da aplicação permanecem no PostgreSQL após o shutdown.

### 10.5 Delimitação e Não-Validação de Escopos Futuros
> [!IMPORTANT]
> A presente estabilização de M05 comprova exclusivamente a atomicidade e o isolamento de `wallet`, `wager_transactions`, `wallet_ledger_entries` e `outbox_messages` via MikroORM sob ciclo NestJS real.
> **Tabela Inbox e integração SQS ainda não existem no modelo atual.** A atomicidade entre Inbox e SQS pertence ao marco **M15** e permanece explicitamente como **NÃO VALIDADO / NÃO IMPLEMENTADO**.
> Da mesma forma, workers concorrentes distribuídos e filas SQS (M10) e replay completo de PENDING_REFERENCE (M09) permanecem como **NÃO VALIDADOS**.


