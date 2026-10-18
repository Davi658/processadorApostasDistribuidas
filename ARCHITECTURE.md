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
3. O serviço `ReprocessPendingReferencesUseCase` pesquisa transações pendentes elegíveis para reprocessamento manual (a consulta concorrente distribuída com lock pessimista `FOR UPDATE SKIP LOCKED` e agendamento contínuo é reservada exclusivamente para o marco M10), delegando a validação e movimentação aos serviços `WinProcessor` e `ReversalProcessor` sob as mesmas regras do fluxo imediato.
4. Se a referência ainda estiver ausente ou pendente: aplica backoff exponencial determinístico (`Math.min(500 * 2^attempts, 10000)` ms, até 5 tentativas). Esgotadas as tentativas, transiciona terminalmente para `REJECTED` com código `REFERENCE_NOT_FOUND`.
5. Se a referência for posteriormente confirmada (ou rejeitada/falhada/incompatível), ambos os caminhos (referência prévia imediata ou referência tardia com reprocessador) produzem exatamente o mesmo resultado contábil, saldo, versão, ledger, outbox e reconciliação.
6. **Delimitação Estrita de Escopo (M08 vs M09/M10):** A validação de M08 abrange exclusivamente a integridade contábil, a compatibilidade de regras e o reprocessamento determinístico das pendências. O replay completo de pendências pertence a M09. O agendamento contínuo em background, a concorrência distribuída entre múltiplos workers com `SKIP LOCKED` e a integração com SQS pertencem à frente M10 e permanecem marcados como **NÃO VALIDADO** nesta etapa.

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
   - O agendamento periódico/background, a concorrência distribuída entre múltiplos workers com `SKIP LOCKED` e a infraestrutura SQS/mensageria pertencem a M10 e M15 e permanecem como **NÃO VALIDADO / NÃO IMPLEMENTADO**. O replay e snapshots de `PENDING_REFERENCE` foram estabilizados em M09.

---

## 4. Garantias e Proteções no Banco de Dados (PostgreSQL)

A integridade do sistema é sustentada por migrações incrementais reversíveis; a proteção terminal descrita abaixo exige a migration `006` aplicada:

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
A migration incremental 006 instala o trigger antes de UPDATE e DELETE. Para linhas já em PROCESSED, REJECTED ou FAILED, compara com IS DISTINCT FROM as representações JSONB completas, removendo somente esta lista explícita de campos operacionais: updated_at, attempts, next_attempt_at, lease_token, lease_owner, lease_expires_at, is_operationally_blocked e operational_block_reason.

Todos os demais campos ficam imutáveis, incluindo id, created_at, wallet_id, player_id, provider_id, external_transaction_id, round_id, game_id, kind, amount, currency, idempotency_key, payload_hash, response_snapshot, status, rejection_reason e reference_external_transaction_id. A comparação cobre NULL nas duas direções e protege também futuras colunas por padrão. UPDATE protegido retorna SQLSTATE 55000 com terminal_transaction_protected_fields; DELETE terminal retorna 55000 com terminal_transaction_delete_forbidden, mesmo sem ledger associado.

O papel app_user continua sem DELETE; sua recusa por privilégio é complementada por prova administrativa do trigger. Atualizações operacionais e limpeza de lease permanecem permitidas, inclusive após resolução terminal; mudanças financeiras na mesma instrução continuam proibidas. Transições a partir de PENDING e PENDING_REFERENCE permanecem disponíveis ao M10.

A função histórica da migration 003 referencia observed_balance, coluna inexistente. A migration 006 corrige a função sem alterar o histórico. Seu DOWN restaura exatamente o comportamento anterior, inclusive a referência inválida a observed_balance e a ausência de proteção a DELETE. O rollback remove as garantias M11 e não constitui uma configuração operacional saudável; a operação normal deve manter 006 aplicada. UP/DOWN/UP foi testado sem perda de dados. Essa prova de reversibilidade não demonstra um procedimento de rollback operacional seguro.

---

### 4.3 Ledger e reconciliação (M12)

As migrations 001–003 já garantem a referência exata `(transaction_id, wallet_id, currency)`, magnitude positiva, saldos não negativos e aritmética CREDIT/DEBIT por linha. A unicidade `uq_wallet_ledger_entries_tx_wallet`, combinada com a FK composta, admite no máximo um lançamento por transação financeira. Isso não exige que toda transação tenha lançamento: LOSS, rejeições e pendências legitimamente não têm efeito financeiro.

A migration incremental 007 exclui `NaN` de amount/balance_before/balance_after do ledger (`chk_ledger_finite_values`) e de wallets.balance (`chk_wallets_balance_finite`). NUMERIC(18,2) já recusa overflow e infinidades com SQLSTATE 22003, mas aceita NaN; os checks históricos de comparação e aritmética não o excluem. Os novos checks validam dados existentes e abortam o UP se houver dados inválidos, sem modificar o histórico. DOWN remove somente esses dois checks e reabre essa lacuna; UP/DOWN/UP preserva registros válidos. Nenhuma migration histórica foi alterada. PostgreSQL arredonda escala excedente ao converter para NUMERIC(18,2); a rejeição de entradas não canônicas com mais de duas casas pertence ao contrato Money, não a uma garantia desses checks.

O trigger `trg_protect_wallet_ledger_entries`, instalado em 001, impede UPDATE e DELETE por linha mesmo sob administrador, com SQLSTATE P0001 e mensagem `Modifications and deletions are strictly prohibited on wallet_ledger_entries`. O papel restrito app_user recebe somente SELECT/INSERT nessa tabela: UPDATE, DELETE e TRUNCATE são recusados com 42501. Não existe trigger contra TRUNCATE administrativo: a proteção de TRUNCATE é uma fronteira de permissões. Um proprietário/superusuário capaz de alterar triggers ou privilégios permanece fora dessa garantia.

**Fronteira da UoW:** o banco valida cada lançamento, mas não exige igualdade entre wallets.balance e a soma do ledger, continuidade entre balance_before/balance_after de linhas diferentes, igualdade de amount/tipo com a operação referenciada, nem a existência de ledger para toda operação PROCESSED. Esses vínculos semânticos dependem dos processadores financeiros e da UoW com lock da carteira, que confirma saldo, transação e ledger atomicamente. SQL direto com privilégios de escrita pode produzir divergência válida para os checks; o teste M12 demonstra esse limite. A reconciliação detecta diferença de totais, sem certificar completude ou sequência histórica quando erros se compensam.

`ReconcileWalletUseCase` mantém o lock da carteira durante a leitura e soma centavos em bigint, sem conversão para number. A ordenação por created_at/id não é uma sequência financeira: lançamentos no mesmo instante podem aparecer em ordem de UUID. Acumular Money limitado a NUMERIC(18,2) em cada passo causava overflow intermediário em giro alto mesmo com saldo final válido. Os totais e diferenças do relatório agora são strings decimais exatas, inclusive assinadas e acima do limite de uma coluna quando houver divergência; Money e valores persistidos mantêm seus limites. Sem lançamentos, o total é 0.00. A leitura é coerente com escritores que seguem o mesmo protocolo de lock/UoW; não promete isolamento de SQL arbitrário que o ignore.

As provas estão em `tests/integration/ledger-constraints-m12.test.ts` e nos testes existentes de UoW, concorrência, operações, abertura e reversões. Os resultados da base combinada e limites de ambiente estão em [M12 — evidências](docs/evidence/m12-ledger-constraints.md).

## 5. Eventos de Integração, Outbox Financeira e Envelope Transacional (M13)

### 5.1 Estrutura do Envelope Padronizado
Todos os eventos gravados na outbox transacional seguem a estrutura padronizada `IntegrationEventEnvelope<T>`:
- `eventId`: UUID v4 estável e único da mensagem (chave primária em `outbox_messages.id`).
- `eventType`: Nome canônico da classe do evento (`WagerTransactionProcessed`, `WalletBalanceChanged`, `WagerTransactionRejected`, `WagerTransactionPendingReference`).
- `version`: Versão do contrato do evento (fixado em `1`).
- `aggregateId`: ID do agregado raiz (UUID da carteira `wallets.id`).
- `correlationId`: Identificador de correlação de negócio propagado fim a fim (suporta UUIDs e strings arbitrárias de até 255 caracteres).
- `causationId`: Identificador da causa da transação (`Idempotency-Key` ou `null`/`undefined` na abertura).
- `occurredAt`: Timestamp ISO 8601 em UTC (`Date.toISOString()`).
- `data`: Carga útil tipada da transação.

A entidade abstrata `IntegrationEvent` implementa `toEnvelope()` para serialização estruturada e `reconstruct()` como ponto único de reconstrução determinística, garantindo preservação de identidade e timestamp sem regeneração de UUIDs.

### 5.2 Precisão Monetária no Payload
Todos os campos monetários nos payloads dos eventos (`amount`, `balance`, `previousBalance`, `currentBalance`) utilizam estritamente o formato `{ amount: string, currency: string }`. A utilização de ponto flutuante (`number`) é proibida em qualquer nível de evento.

### 5.3 Matriz de Auditoria e Contrato de Eventos (M13)

| Operação | Cenário / Resultado | Eventos Persistidos na Outbox | Qtd | Detalhes do Envelope & Payload |
| :--- | :--- | :--- | :---: | :--- |
| **Abertura** | Saldo positivo (`> 0.00`) | `WagerTransactionProcessed` + `WalletBalanceChanged` | 2 | `kind: 'OPENING'`, `balanceBefore: 0.00`, `balanceAfter: initialBalance`, `version: 1`, `correlationId: openingTxId` |
| **Abertura** | Saldo zero (`0.00` ou omitido) | *(nenhum)* | 0 | Sem transação financeira, sem ledger, sem eventos na outbox |
| **BET** | Processado com movimento | `WagerTransactionProcessed` + `WalletBalanceChanged` | 2 | `kind: 'BET'`, débito em carteira, `version: V+1`, `triggerTransactionId: tx.id`, `correlationId` preservado |
| **BET** | Rejeição por saldo insuficiente (`INSUFFICIENT_FUNDS`) | `WagerTransactionRejected` | 1 | `failureCode: 'INSUFFICIENT_FUNDS'`, saldo inalterado, sem ledger, sem `BalanceChanged` |
| **LOSS** | Processado neutro | `WagerTransactionProcessed` | 1 | `kind: 'LOSS'`, saldo e versão inalterados, sem ledger, sem `BalanceChanged` |
| **WIN** | Processado com movimento (sem ref ou ref `PROCESSED`) | `WagerTransactionProcessed` + `WalletBalanceChanged` | 2 | `kind: 'WIN'`, crédito em carteira, `version: V+1`, `triggerTransactionId: tx.id` |
| **WIN** | Referência ausente (`PENDING_REFERENCE`) | `WagerTransactionPendingReference` | 1 | `kind: 'WIN'`, `attempts: 1`, `nextAttemptAt` no futuro, saldo inalterado |
| **WIN** | Reagendamento via worker (`RESCHEDULED`) | *(nenhum)* | 0 | Atualiza `attempts` e `nextAttemptAt` no banco; sem duplicação acidental de eventos |
| **WIN** | Resolução posterior (ref confirmada) | `WagerTransactionProcessed` + `WalletBalanceChanged` | 2 | Transição para terminal `PROCESSED`, crédito em carteira e lançamento contábil |
| **WIN** | Rejeição (ref incompatível / timeout de tentativas) | `WagerTransactionRejected` | 1 | `failureCode: 'REFERENCE_INCOMPATIBLE'` ou `'REFERENCE_NOT_FOUND'`, saldo inalterado |
| **REFUND** | Processado com movimento (ref BET confirmada) | `WagerTransactionProcessed` + `WalletBalanceChanged` | 2 | `kind: 'REFUND'`, crédito do valor, `version: V+1`, lançamento contábil |
| **REFUND** | Referência ausente (`PENDING_REFERENCE`) | `WagerTransactionPendingReference` | 1 | `kind: 'REFUND'`, `attempts: 1`, `nextAttemptAt`, saldo inalterado |
| **REFUND** | Reagendamento via worker (`RESCHEDULED`) | *(nenhum)* | 0 | Sem eventos adicionais na outbox |
| **REFUND** | Resolução posterior via worker | `WagerTransactionProcessed` + `WalletBalanceChanged` | 2 | Transição para terminal `PROCESSED` com crédito |
| **REFUND** | Rejeição (ref não processada / incompatível) | `WagerTransactionRejected` | 1 | `failureCode: 'REFERENCE_NOT_PROCESSED'` ou `'REFERENCE_INCOMPATIBLE'` |
| **ROLLBACK** | Processado de BET (crédito) | `WagerTransactionProcessed` + `WalletBalanceChanged` | 2 | `kind: 'ROLLBACK'`, estorno de débito via crédito contábil |
| **ROLLBACK** | Processado de WIN (débito) | `WagerTransactionProcessed` + `WalletBalanceChanged` | 2 | `kind: 'ROLLBACK'`, estorno de crédito via débito contábil |
| **ROLLBACK** | Referência ausente (`PENDING_REFERENCE`) | `WagerTransactionPendingReference` | 1 | `kind: 'ROLLBACK'`, `attempts: 1`, `nextAttemptAt`, saldo inalterado |
| **ROLLBACK** | Reagendamento via worker (`RESCHEDULED`) | *(nenhum)* | 0 | Sem eventos adicionais na outbox |
| **ROLLBACK** | Resolução posterior via worker | `WagerTransactionProcessed` + `WalletBalanceChanged` | 2 | Transição para terminal `PROCESSED` com movimento contábil |
| **ROLLBACK** | Rejeição (saldo insuficiente para estornar WIN) | `WagerTransactionRejected` | 1 | `failureCode: 'REVERSAL_INSUFFICIENT_FUNDS'` |
| **Replay** | Mesma chave de idempotência e payload idêntico | *(nenhum)* | 0 | Resposta retornada do snapshot imutável; zero eventos emitidos |
| **Conflito** | Mesma chave de idempotência com payload diferente | *(nenhum)* | 0 | Exceção `IdempotencyConflictError` aborta transação; zero eventos emitidos |
| **Falha técnica** | Erro de infraestrutura / exceção antes do commit | *(nenhum)* | 0 | Rollback total no PostgreSQL; zero eventos confirmados |

### 5.4 Garantias de Atomicidade e Fronteira Transacional
- **Atomicidade Real Única:** Carteira, transação financeira, lançamento no ledger e eventos de outbox são gravados sob o mesmo `txid_current()` e confirmados em um único `COMMIT` SQL.
- **Barreira MVCC Pré-Commit:** Nenhuma mutação ou evento é visível a conexões externas antes da confirmação do commit no PostgreSQL.
- **Isolamento de Rollback:** Falhas injetadas após a primeira ou após a última gravação na outbox revertem integralmente saldo, versão, transação, ledger e outbox, sem linhas órfãs. Reenvio subsequente produz exatamente o conjunto esperado.
- **Fronteira de Escopo M13:** Os eventos são persistidos em estado inicial não publicado (`published_at IS NULL`). Publisher externo (M14), leases de publicação (M14), filas SQS (M15) e consumidores/inbox (M15-M16) estão estritamente fora do escopo desta meta.

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
> Da mesma forma, workers concorrentes distribuídos com `SKIP LOCKED` e filas SQS (M10) permanecem como **NÃO VALIDADOS**. O replay completo de PENDING_REFERENCE foi estabilizado no marco M09.

---

## 11. REFUND e ROLLBACK Imediatos (M07)

A estabilização do marco M07 consolida as operações imediatas de estorno e reversão financeira executadas pelo fluxo transacional síncrono (`ProcessWagerUseCase`), apoiado pelo serviço compartilhado `ReversalProcessor` e pelo índice de banco `004_restrict_reversal_unique_index.sql`:

### 11.1 Operações Contábeis e Tipos Suportados
1. **REFUND de BET (Crédito Integral):**
   - Reverte integralmente o valor debitado por uma transação `BET` previamente no estado `PROCESSED`.
   - Credita a carteira (`wallet.credit`), incrementa a versão em exatamente 1 e emite lançamento `CREDIT` em `wallet_ledger_entries`.
   - Publica os eventos `WagerTransactionProcessedEvent` e `WalletBalanceChangedEvent` (`payload.triggerTransactionId` apontando para a transação de reversão).
2. **ROLLBACK de BET (Crédito Integral):**
   - Suporta cancelamento de uma `BET` processada via operação `ROLLBACK`.
   - Aplica crédito integral na carteira, incrementa versão em 1 e registra lançamento contábil `CREDIT`.
3. **ROLLBACK de WIN (Débito Integral):**
   - Reverte o ganho creditado por uma transação `WIN`.
   - Debita a carteira (`wallet.debit`), incrementa versão em 1 e registra lançamento contábil `DEBIT`.
   - Se o saldo da carteira for insuficiente para cobrir o débito, a reversão é rejeitada com código específico `REVERSAL_INSUFFICIENT_FUNDS`.
4. **ROLLBACK de REFUND (Débito Integral):**
   - Reverte o crédito concedido por uma operação `REFUND` anterior.
   - Aplica débito integral na carteira (`wallet.debit`), incrementa versão em 1 e registra lançamento contábil `DEBIT`.
   - Se o saldo for insuficiente, rejeita com `REVERSAL_INSUFFICIENT_FUNDS`.

### 11.2 Validações Pré-Movimento e Invariantes de Rejeição Auditável
Antes de qualquer alteração de saldo ou ledger, o processador valida rigorosamente a transação referenciada:
1. **Status Terminal `PROCESSED` Obrigatório:** A referência deve existir e estar no estado `PROCESSED`. Se estiver em `REJECTED` ou `FAILED`, a reversão é terminalmente rejeitada com código estável `REFERENCE_NOT_PROCESSED`.
2. **Compatibilidade Rigorosa:**
   - Mesmo provedor (`providerId`).
   - Mesmo jogador (`playerId`).
   - Mesma carteira (`walletId`).
   - Mesma moeda (`currency`).
   - Mesma rodada (`roundId`).
   - Valor integral idêntico (`amount` exato).
   - Tipos permitidos: `REFUND` referencia exclusivamente `BET`; `ROLLBACK` referencia `BET`, `WIN` ou `REFUND`.
   - Divergências de compatibilidade resultam em status `REJECTED` com código estável `REFERENCE_INCOMPATIBLE`.
3. **Regra de Uma Reversão por Referência e Tipo:**
   - O índice parcial `uq_processed_reversal_per_reference` (`kind IN ('REFUND', 'ROLLBACK')` e `status = 'PROCESSED'`) garante que não pode haver duas reversões do mesmo tipo para a mesma referência.
   - Se já existir reversão processada do mesmo tipo para aquela referência, novas tentativas são rejeitadas auditavelmente com código `REVERSAL_ALREADY_PROCESSED`.
   - Preserva a interpretação documentada: uma `BET` pode ter legitimamente um `REFUND` e um `ROLLBACK` se documentado, e suporta múltiplas operações `WIN` simultâneas garantidas pela migration 004.
4. **Política de Overflow Monetário:**
   - Se uma reversão de crédito fizer o saldo exceder a capacidade `NUMERIC(18,2)` (`9999999999999999.99`), o Value Object `Money` lança `MoneyOverflowError`, abortando a transação integralmente sem efeitos parciais no banco.
5. **Invariantes em Rejeições Auditáveis:**
   - Saldo e versão da carteira permanecem intactos.
   - Nenhum lançamento é criado em `wallet_ledger_entries`.
   - Emite exclusivamente `WagerTransactionRejectedEvent` na tabela `outbox_messages`.
   - Persiste snapshot terminal completo (`response_snapshot`) com `status: 'REJECTED'`, `failureCode` e `balance`.
   - No HTTP, retorna código `422 Unprocessable Entity` com payload auditável.

### 11.3 Replay Terminal Histórico
1. **Replay de Reversão Processada:** Retorna `transactionId` original, status `PROCESSED`, saldo histórico registrado no snapshot e `idempotentReplay: true`. Caso o saldo da carteira tenha sido alterado posteriormente por outras transações, o saldo atual no banco é preservado e nenhum movimento contábil ou evento novo é emitido.
2. **Replay de Reversão Rejeitada (Saldo Insuficiente):** Se uma reversão for rejeitada com `REVERSAL_INSUFFICIENT_FUNDS` e a carteira for subsequentemente creditada, a repetição da mesma chave de idempotência retorna o snapshot original rejeitado com `idempotentReplay: true`, sem debitar a carteira tardiamente.
3. **Conflitos de Idempotência:**
   - Mesma chave com payload divergente (verificado por SHA-256 canônico recursivo) retorna HTTP `409 Conflict` (`IDEMPOTENCY_CONFLICT`).
   - Mesmo par `(providerId, externalTransactionId)` reenviado sob outra chave retorna HTTP `409 Conflict`.

### 11.4 Concorrência Real e Multi-Processos
1. **50 Duplicatas Paralelas:** Disparadas simultaneamente sob a mesma chave de idempotência produzem exatamente uma execução financeira real (`idempotentReplay: false`) e 49 replays (`idempotentReplay: true`), mantendo saldo e reconciliação perfeitamente íntegros.
2. **Reversões Concorrentes para a Mesma Referência:** Disputas simultâneas de reversões distintas do mesmo tipo sobre a mesma referência resultam em exatamente uma processada e nas demais rejeitadas sem mutação contábil (`REVERSAL_ALREADY_PROCESSED` ou proteção de constraint).
3. **Disputa de Saldo entre ROLLBACKs Distintos:** Quando duas reversões de débito concorrem por um saldo que só comporta uma delas, o lock pessimista na carteira garante que o saldo nunca se torna negativo: uma processa com sucesso e a outra é rejeitada com `REVERSAL_INSUFFICIENT_FUNDS`.
4. **Disputa com Múltiplos Processos OS Independentes:** Pelo menos três processos de sistema operacional independentes (executando via `worker.ts` com anúncio `READY` e barreira de sincronização por arquivo) entram diretamente pelo fluxo imediato (`ProcessWagerUseCase.execute`), comprovando coordenação segura sem depender do worker de pendências.
5. **Classificação Estrita de Unicidade:** O processador inspeciona a causa raiz exata de erros `23505`. Violações de outras restrições (como `uq_wallets_player_currency`) nunca são malclassificadas como erros de idempotência ou de reversão.

### 11.5 Atomicidade e Injeção de Falhas
- Quatro pontos de falha auditados (`after_wallet_save`, `after_tx_save`, `after_ledger_save`, `after_outbox_save`) comprovam via consultas diretas no PostgreSQL que qualquer erro intermediário provoca rollback total, desfazendo todas as mutações e permitindo reenvio único subsequente com sucesso integral.

### 11.6 Delimitação Estrita de Escopo
> [!IMPORTANT]
> O marco M07 consolida exclusivamente o processamento de **REFUND e ROLLBACK imediatos** sob o ciclo transacional síncrono.
> O agendamento contínuo em background, a mensageria e filas SQS (M10, M15) e a concorrência distribuída de workers com `FOR UPDATE SKIP LOCKED` (M10) pertencem a marcos futuros e permanecem explicitamente como **NÃO VALIDADOS / NÃO IMPLEMENTADOS**.

---

## 12. Replay de PENDING_REFERENCE e Transições Terminais (M09)

A estabilização do marco M09 garante respostas completas, determinísticas e auditáveis para operações `WIN`, `REFUND` e `ROLLBACK` tanto enquanto aguardam a chegada da referência (`PENDING_REFERENCE`) quanto após a sua resolução terminal (`PROCESSED` ou `REJECTED`).

### 12.1 Snapshot de Aceitação Atômico
1. Ao persistir uma transação no estado `PENDING_REFERENCE`, o processador grava atomicamente dentro da mesma transação de banco de dados (`MikroOrmUnitOfWork`):
   - Registro de transação em `wager_transactions` com status `PENDING_REFERENCE`.
   - Snapshot estruturado gravado na coluna `response_snapshot` (JSONB) contendo:
     - `transactionId`: UUID canônico da transação criada.
     - `status`: `'PENDING_REFERENCE'`.
     - `balance`: objeto `{ amount, currency }` observado exatamente no momento da aceitação (saldo contábil da carteira).
     - `idempotentReplay`: `false` (na resposta primária HTTP 202).
   - Evento de outbox `WagerTransactionPendingReference` na tabela `outbox_messages` (coluna `event_type = 'WagerTransactionPendingReference'`), contendo no payload: `transactionId`, `walletId`, `kind`, `amount`, `currency`, `referenceExternalTransactionId` e `idempotencyKey`.
2. **Atomicidade e Integridade:** Snapshot, registro de transação e evento de outbox são comitados juntos. Em caso de falha intermediária antes do commit, ocorre rollback total; nenhum estado parcial é exposto. Nunca é retornado ou propagado snapshot nulo ou vazio no replay.

### 12.2 Política de Replay e Evolução de Snapshot
1. **Enquanto Pendente (`PENDING_REFERENCE`):**
   - Requisições com a mesma `Idempotency-Key` e payload canônico idêntico retornam HTTP 202 Accepted.
   - O corpo da resposta contém o snapshot de aceitação original (`transactionId`, `status: 'PENDING_REFERENCE'`, `balance` histórico de aceitação) e `idempotentReplay: true`.
   - **Preservação de Saldo Histórico:** Mesmo se outras movimentações financeiras legítimas alterarem o saldo da carteira posteriormente, o replay da pendência preserva estritamente o saldo observado na aceitação original.
   - **Invariância Absoluta de Efeitos:** O replay em estado pendente não movimenta saldo, não insere registros em `wallet_ledger_entries`, não emite novos eventos em `outbox_messages`, não incrementa a contagem de tentativas (`attempts`) e não modifica o agendamento (`next_attempt_at`).
2. **Após Resolução (Transição para Estado Terminal):**
   - Ao ser resolvida pelo reprocessador (`ReprocessPendingReferencesUseCase`), a transação grava o snapshot terminal definitivo:
     - Se `PROCESSED`: retorna HTTP 200 OK com `status: 'PROCESSED'`, saldo resultante após o processamento, e `idempotentReplay: true`.
     - Se `REJECTED`: retorna HTTP 422 Unprocessable Entity com `status: 'REJECTED'`, `failureCode` original (ex: `REFERENCE_NOT_FOUND`, `REFERENCE_INCOMPATIBLE`, `REFERENCE_NOT_PROCESSED`, `REVERSAL_INSUFFICIENT_FUNDS`), e `idempotentReplay: true`.
   - Movimentações financeiras posteriores na carteira nunca alteram o snapshot terminal gravado.
3. **Conflito de Payload (HTTP 409):**
   - O reenvio da mesma `Idempotency-Key` com payload divergente retorna HTTP 409 Conflict em qualquer estado (pendente ou terminal).
   - O conflito não altera a pendência existente, não incrementa `attempts` e não produz efeitos contábeis colaterais.

### 12.3 Reprocessamento, Retries e Tratamento Estrito de Registros Legados
1. **Preservação do Snapshot durante Reprocessamento:**
   - Quando o reprocessador executa uma tentativa e a referência ainda não está disponível, aplica backoff exponencial determinístico (`Math.min(500 * 2^attempts, 10000)` ms sem jitter) e atualiza exclusivamente os metadados de retry (`attempts`, `next_attempt_at`). O snapshot de aceitação original permanece rigorosamente inalterado.
2. **Remoção de Fallbacks Inseguros e Tratamento Estrito de Registros Legados:**
   - **Proibição de Fallbacks Inseguros:** É terminantemente proibido reconstruir saldo histórico por timestamps do ledger, usar o saldo atual da carteira (`wallet.balance`), ou assumir `"0.00"` como substituto monetário. Tais heurísticas são anacrônicas e contabilisticamente fraudulentas.
   - **Erro Tipado `REPLAY_SNAPSHOT_UNAVAILABLE`:** Na ausência de snapshot íntegro e validado (`response_snapshot` nulo, incompleto, com divergência de identificador/status/moeda/failureCode ou valor monetário inválido), o sistema lança `ReplaySnapshotUnavailableError`, que é mapeado para uma resposta HTTP 500 genérica e estável (`code: 'REPLAY_SNAPSHOT_UNAVAILABLE'`), sem expor detalhes internos da infraestrutura ou do banco de dados.
   - **Limitação dos Registros Legados e Procedimento de Diagnóstico Operacional:**
     - *Limitação:* Registros pendentes ou terminais legados gerados sem snapshot estruturado íntegro não possuem saldo histórico comprovável. Repetir a requisição via replay não é capaz de reconstruir ou recuperar esse histórico faltante.
     - *Procedimento de Diagnóstico:* Qualquer ocorrência de `REPLAY_SNAPSHOT_UNAVAILABLE` exige análise operacional e intervenção manual da equipe de operações/auditoria contábil para verificação do histórico contábil no provedor e conciliação direta, em vez de reenvios automáticos da requisição.
   - **Política Fail-Closed em Reagendamento (`WinProcessor` e `ReversalProcessor`):** A mesma recusa estrita se aplica a tentativas de reagendamento de pendências legadas sem snapshot válido; o processador aborta com `REPLAY_SNAPSHOT_UNAVAILABLE`, recusando-se a gravar fallbacks artificiais de saldo (`"0.00"`) ou a alterar silenciosamente registros legados ou terminais.

### 12.4 Nomes Reais de Eventos e Índices no PostgreSQL
- **Eventos na Tabela `outbox_messages` (`event_type`):**
  - `WagerTransactionProcessed`
  - `WagerTransactionRejected`
  - `WagerTransactionPendingReference`
  - `WalletBalanceChanged`
- **Índice de Reversões no PostgreSQL:**
  - `uq_processed_reversal_per_reference ON wager_transactions (provider_id, reference_external_transaction_id, kind) WHERE status = 'PROCESSED' AND reference_external_transaction_id IS NOT NULL AND kind IN ('REFUND', 'ROLLBACK')`.

### 12.5 Delimitação Estrita de Escopo (M09 vs M10 / M15)
> [!IMPORTANT]
> O marco M09 comprova exclusivamente o determinismo das respostas, a atomicidade dos snapshots de aceitação e terminais, a política de replay e a estabilização de pendências em PostgreSQL real descartável sob acionamento manual do reprocessador.
> Componentes de mensageria assíncrona (SQS/LocalStack), tabelas inbox e publishers da outbox pertencem a marcos posteriores (M14, M15, M16) e permanecem expressamente como **NÃO VALIDADOS / NÃO IMPLEMENTADOS**.

---

## 13. Worker de Referências Pendentes e Concorrência Distribuída (M10)

O marco M10 consolida o processamento automático, assíncrono e concorrente de transações no estado `PENDING_REFERENCE` (`WIN`, `REFUND` e `ROLLBACK`), com garantias estritas de reserva persistente, tolerância a falhas transitórias, recuperação pós-crash e isolamento fail-closed de registros problemáticos.

### 13.1 Ciclo de Vida e Agendamento NestJS
1. **Inicialização Automatizada (`OnApplicationBootstrap`):**
   - O worker `PendingReferenceWorkerService` é inicializado no ciclo de vida do NestJS através do hook `onApplicationBootstrap()`.
   - Permite ativação/desativação dinâmica e parametrização via variáveis de ambiente:
     - `PENDING_WORKER_ENABLED` (padrão: `false`): liga/desliga o agendamento em background.
     - `PENDING_WORKER_INTERVAL_MS` (padrão: `5000` ms): intervalo entre varreduras periódicas.
     - `PENDING_WORKER_BATCH_SIZE` (padrão: `20` itens): limite máximo de pendências por lote.
     - `PENDING_WORKER_LEASE_MS` (padrão: `30000` ms): duração de expiração do lease de reserva.
     - `PENDING_WORKER_DRAIN_TIMEOUT_MS` (padrão: `5000` ms): tempo limite de drenagem no shutdown.
2. **Prevenção de Sobreposição de Ciclos (Overlap Guard):**
   - Na mesma instância de aplicação, um ciclo de tick em execução ativa a flag booleana interna `isTickRunning`. Se o intervalo periódico disparar enquanto o lote anterior ainda estiver em processamento, a nova execução é ignorada de imediato sem sobreposição ou concorrência interna.
3. **Graceful Shutdown com Drenagem de Recursos (`OnModuleDestroy` e `BeforeApplicationShutdown`):**
   - Implementa a interface `BeforeApplicationShutdown` do NestJS, disparada antes do encerramento dos módulos de persistência e do ORM (`MikroORM`).
   - Ao receber o sinal de parada (`SIGTERM`, `SIGINT`, etc.), o worker ativa `isShuttingDown = true` e cancela os timers ativos, impedindo qualquer nova reserva (`claim`).
   - O encerramento aguarda ativamente a conclusão de todas as operações e transações financeiras in-flight até o prazo de tolerância configurado (`drainTimeoutMs`).
   - Ao exceder a drenagem, `abort()` marca o contexto capturado explicitamente pela Unit of Work como rollback-only. O listener não consulta o AsyncLocalStorage do chamador do abort.
   - `PENDING_WORKER_CANCELLATION_TIMEOUT_MS` (padrão: `5000` ms) emite diagnóstico se a execução ainda não terminou; não libera o shutdown. A execução precisa encerrar antes do fechamento do ORM em `OnApplicationShutdown`.
   - O listener permanece instalado durante `before_commit`, flush e resolução da transação, sendo removido em `finally`, junto da remoção do contexto do conjunto de transações ativas.
   - A Unit of Work faz begin explícito, trabalho, preparação, flush, última verificação síncrona e envio de COMMIT sem await intermediário. Após o envio, aguarda o resultado real: cancelamento tardio não transforma commit confirmado em rollback. Contadores e logs de sucesso continuam posteriores à confirmação.
   - `DB_LOCK_TIMEOUT_MS` (padrão: `5000`) e `DB_STATEMENT_TIMEOUT_MS` (padrão: `10000`) são aplicados pelo PostgreSQL às conexões e por `SET LOCAL` em cada transação. Abrangem também consultas fora da transação, incluindo claim. Falha ao instalar os limites locais aborta a transação; não há fallback silencioso. AbortController sozinho não interrompe SQL.
   - Os limites são por instrução SQL, não um prazo global de shutdown. Trabalho JavaScript pausado exige cooperação para terminar; o ORM permanece aberto enquanto isso. Os testes mantêm a barreira fechada além do prazo diagnóstico para provar essa propriedade.
   - Ordem comprovada: bloquear claims → drenar → solicitar cancelamento se necessário → PostgreSQL encerrar espera SQL / liberar barreira → rollback ou commit confirmado → execução terminar → fechar ORM → zero novas sessões da aplicação em `pg_stat_activity`.
4. **Preservação de Ponto de Entrada para Testes Manuais:**
   - O método `executeBatch(batchSize, leaseDurationMs)` permanece exposto para acionamento determinístico e manual pelas suítes de testes, executando rigorosamente o mesmo caso de uso e a mesma lógica do agendador automático.

### 13.2 Reserva Concorrente com Lease Persistente e `FOR UPDATE SKIP LOCKED`
Para coordenar múltiplos processos e nós de aplicação independentes disputando a mesma base de dados sem duplicações ou deadlocks, foi adotada a estratégia de lease persistente com transação curta de reserva:

1. **Campos Persistidos de Controle (Migration 005):**
   - `lease_token VARCHAR(64)`: token único criptograficamente seguro (UUID v4) gerado a cada reserva.
   - `lease_owner VARCHAR(255)`: identificador do worker ou processo que detém o lease (hostname, PID ou identificador lógico).
   - `lease_expires_at TIMESTAMPTZ`: carimbo de tempo no horário do PostgreSQL determinando a validade da reserva.
   - `is_operationally_blocked BOOLEAN DEFAULT FALSE`: sinalizador de bloqueio operacional para registros com snapshot corrompido.
   - `operational_block_reason VARCHAR(255)`: diagnóstico auditável sem payload financeiro.
2. **Transação Curta de Reserva (`claimPendingReferences`):**
   - A reserva é executada em uma transação SQL rápida e isolada, **sem nenhuma movimentação financeira**:
     ```sql
     WITH eligible AS (
       SELECT id
       FROM wager_transactions
       WHERE status = 'PENDING_REFERENCE'
         AND is_operationally_blocked = FALSE
         AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
         AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE wager_transactions
     SET lease_token = $2,
         lease_owner = $3,
         lease_expires_at = NOW() + ($4 || ' milliseconds')::INTERVAL,
         updated_at = NOW()
     FROM eligible
     WHERE wager_transactions.id = eligible.id
     RETURNING wager_transactions.id, wager_transactions.lease_token, wager_transactions.lease_expires_at;
     ```
   - O uso de `FOR UPDATE SKIP LOCKED` faz com que linhas sob disputa concorrente sejam ignoradas instantaneamente pelas demais instâncias, eliminando contenção e esperas bloqueantes.
   - O relógio do PostgreSQL (`NOW()`) é a única fonte de verdade para elegibilidade e expiração de leases, eliminando riscos decorrentes de desvios de relógio (clock drift) entre servidores.
3. **Proteção Contra Finalização Indevida por Worker Antigo (Stale Lease Protection):**
   - Durante a resolução financeira de um item reservado, o processador valida sob lock pessimista se a transação ainda pertence ao worker atual (`tx.leaseToken === claimedToken` e `tx.leaseExpiresAt > now`).
   - Se um worker sofrer um atraso prolongado ou pausa GC e seu lease expirar, outro worker pode assumir a pendência gerando um novo `lease_token`. Caso o worker antigo retome, ele detecta a divergência do token e aborta imediatamente com erro tipado `StaleLeaseError` (`code: 'STALE_LEASE'`), impedindo que finalize ou cometa alterações indevidas em uma reserva já assumida por outro.
4. **Recuperação Pós-Crash:**
   - Se um worker falhar ou morrer inesperadamente após efetuar o claim e antes de concluir o processamento, a condição `(lease_expires_at IS NULL OR lease_expires_at < NOW())` permite que qualquer outro worker elegível reassuma automaticamente a pendência assim que a validade do lease expirar, sem necessidade de intervenção humana.
5. **Liberação e Renovação Condicionadas:**
   - Métodos `releaseLease` e `renewLease` utilizam cláusulas `WHERE id = $1 AND lease_token = $2`, garantindo que apenas o detentor legítimo do token consiga liberar ou prorrogar o lease. Ao concluir ou rejeitar a transação, os campos de lease são automaticamente limpos (`NULL`).

### 13.3 Ordem Canônica de Locks e Isolamento de Memória
1. **Ordem Estrita de Locks Anti-Deadlock:**
   - Durante o processamento de cada item do lote, o worker adquire os locks pessimistas na seguinte ordem estrita:
     1. `wallets` (`SELECT ... FOR UPDATE`).
     2. `wager_transactions` (`SELECT ... FOR UPDATE` com releitura direta).
   - Essa ordem espelha fielmente a ordem adotada no endpoint HTTP imediato (`ProcessWagerUseCase`), prevenindo deadlocks cruzados no PostgreSQL (`40P01 dead lock detected`).
2. **Releitura Limpa do Identity Map (MikroORM):**
   - Para evitar inconsistências causadas por entidades em cache de memória (Identity Map do ORM), o processamento utiliza transações isoladas (`em.fork()`, begin explícito, flush e commit pela API transacional pública do Knex) e releitura explícita com `{ refresh: true, lockMode: LockMode.PESSIMISTIC_WRITE }`.
3. **Idempotência e Estado Terminal Reavaliado sob Lock:**
   - O status da transação é inspecionado imediatamente após a obtenção dos locks. Se a transação já tiver atingido um estado terminal (`PROCESSED` ou `REJECTED`), a execução retorna sem aplicar novas mutações de saldo, sem criar lançamentos adicionais no ledger e sem emitir eventos repetidos na outbox.
4. **Reutilização Integral de Motores de Negócio:**
   - O worker reutiliza integralmente os serviços consolidados `WinProcessor` (para `WIN`) e `ReversalProcessor` (para `REFUND` e `ROLLBACK`), garantindo 100% de paridade de regras contábeis, reconciliação e validações de referência entre o fluxo síncrono e assíncrono.
5. **Nenhum Lock Retido Durante Polling ou Backoff:**
   - As transações de banco de dados são estritamente delimitadas a cada item individual do lote. Nenhum lock relacional permanece aberto durante as pausas de agendamento, polling ou backoff.

### 13.4 Tratamento de Erros, Retries e Bloqueio Operacional Fail-Closed
1. **Classificação Rigorosa entre Falhas Transitórias e de Negócio:**
   - Falhas transitórias de infraestrutura (como quedas temporárias de rede, timeouts ou deadlocks transitórios) são capturadas e logadas sem incrementar a contagem de tentativas de domínio (`attempts`) e sem transicionar a transação para `REJECTED`. O lease é liberado (ou expira naturalmente), permitindo que a transação seja reprocessada normalmente após a recuperação da infraestrutura.
2. **Backoff e Esgotamento de Tentativas de Referência:**
   - Quando a referência legítima ainda não se encontra disponível, o sistema incrementa `attempts` e agenda a próxima tentativa com backoff exponencial determinístico (`Math.min(500 * 2^attempts, 10000)` ms).
   - Ao atingir o limite máximo de tentativas (`MAX_ATTEMPTS = 5`), a transação é transicionada para `REJECTED` com código `REFERENCE_NOT_FOUND`, gerando exatamente 1 snapshot terminal rejeitado e 1 evento `WagerTransactionRejected` na outbox.
3. **Isolamento de Snapshots Inválidos (Bloqueio Operacional Fail-Closed):**
   - Caso um registro pendente possua snapshot inválido ou corrompido (`validateReplaySnapshot` lança erro), o worker:
     - Não altera o saldo nem gera registros no ledger contábil.
     - Não comete alterações financeiras indevidas.
     - Isola o registro persistindo `is_operationally_blocked = TRUE` e `operational_block_reason = ...` no banco de dados, liberando o lease.
     - Emite log estruturado de advertência com diagnóstico seguro, sem expor montantes ou payloads financeiros.
     - Como a query de claim filtra `is_operationally_blocked = FALSE`, o item corrompido é automaticamente excluído de todas as seleções subsequentes, impedindo que ocupe continuamente o lote ou bloqueie os demais itens saudáveis da fila.
4. **Isolamento de Itens no Lote:**
   - O processamento de cada item do lote ocorre em bloco `try/catch` individual com transação própria. A falha de um registro nunca aborta nem bloqueia o processamento dos demais itens do lote.
5. **Observabilidade e Logs Estruturados:**
   - Logs em formato JSON registram eventos do ciclo de vida: `worker_claim_batch`, `worker_process_success`, `worker_process_rejected`, `worker_process_transient_error`, `worker_operational_block` e `worker_stale_lease`.
   - Nenhuma informação financeira confidencial, dados de payload ou valores monetários (`amount`, `balance`) são emitidos nos logs.

### 13.5 Delimitação Estrita de Escopo (M10 vs M14 / M15 / M16)
> [!IMPORTANT]
> O marco M10 estabiliza e conclui exclusivamente o **worker de referências pendentes baseado em lease persistente no PostgreSQL, crash recovery real e ciclo de vida NestJS com drenagem comprovada**.
> Os seguintes componentes pertencem aos marcos posteriores M14, M15 e M16 e permanecem explicitamente como **NÃO VALIDADOS / FORA DE ESCOPO**:
> 1. **Publisher Concorrente da Outbox para Broker Externo (M14):** **NÃO VALIDADO / FORA DE ESCOPO**
> 2. **Inbox e Mensageria Assíncrona SQS (M15):** **NÃO VALIDADO / FORA DE ESCOPO**
> 3. **Retry, Dead Letter Queue (DLQ) e Shutdown do Consumidor (M16):** **NÃO VALIDADO / FORA DE ESCOPO**






### 13.5 Evidências finais do shutdown M10

`tests/integration/pending-reference-worker-m10.test.ts` executa 21 testes contra PostgreSQL real descartável. Seis variantes com aplicação Nest real pausam após escrita, em `before_commit`, durante flush, após commit confirmado, em lock de carteira e em `pg_sleep(30)`. Barreiras explícitas e `pg_stat_activity` confirmam o ponto atingido antes de iniciar `app.close()`. Nos testes SQL, limites de 1000 ms para lock e 1200 ms para instrução encerram as esperas mantendo o lock externo até o worker terminar. Cada variante verifica ordem de encerramento, saldo, versão, snapshot, tentativas, ledger, outbox, recuperação e ausência de repetição. Os testes de múltiplos processos, crash após claim, crash após commit e fencing de leases continuam presentes. Comandos e resultados finais estão em `docs/evidence/m10-shutdown.md`.

## 14. M17 — Consultas pela aplicação principal

`AppModule` importa `PersistenceModule` e `WageringQueryModule`. O primeiro contém os providers existentes da UoW, carteira, transação, ledger e outbox e os exporta para ambos os módulos. Há uma única instância de cada provider de persistência; a consulta de ledger acrescenta somente um adaptador de leitura, injetado com a mesma UoW. Nenhuma lógica transacional do M10 foi alterada. `OnModuleDestroy` drena o worker antes de `OnApplicationShutdown` fechar a UoW compartilhada.

As três rotas são `GET /wagering/transactions/:transactionId`, `GET /providers/:providerId/wagering/transactions/:externalTransactionId` e `GET /wallets/:walletId/ledger`. As duas primeiras reutilizam `WagerTransactionQueryResponseDto` e `toWagerTransactionQueryResponse`, garantindo contrato único. A identidade externa é sempre consultada junto ao provedor. Dinheiro continua string canônica com duas casas.

`LedgerCursorCodec`, em `application/pagination`, é independente do transporte, lança `InvalidLedgerCursorError` e é usado pelo caso de uso para codificar o próximo cursor. A camada HTTP adapta erros de decode para 400 antes de chamar o caso de uso. `GetWalletLedgerUseCase` não importa validadores HTTP. O codec valida Base64URL canônico e JSON com exatamente walletId, createdAt e id, UUIDs, vínculo com a carteira e calendário gregoriano estrito. O formato temporal é UTC `YYYY-MM-DDTHH:mm:ss.ffffffZ`, anos 0001–9999; não usa Date nem normaliza dias impossíveis.

O SQL existente mantém parâmetros, `limit + 1`, ordenação ascendente `(created_at, id)` e predicado keyset. `TO_CHAR(... AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` conserva os microssegundos integralmente. O cursor é apenas codificado, sem assinatura criptográfica; a validação estrutural e o vínculo com walletId não conferem autenticidade ao conteúdo.

O comando oficial `bun run test` descobre todos os `.test.ts` e executa cada arquivo em um processo Bun independente, sequencialmente, com timeout padrão de 30000 ms e propagação de qualquer falha como exit 1. É implementado em TypeScript sem dependência de PowerShell ou shell Linux. Um teste com filho deliberadamente falho comprova que o runner continua os demais arquivos e retorna falha. A validação local não equivale a uma execução em Linux ou em Docker; ambiente e resultados são registrados em `docs/evidence/m17-final.md`.

## 15. M14 — Publisher Concorrente da Outbox e SQS FIFO (`wager-events.fifo`)

### 15.1 Contrato de Entrega e Ordenação no SQS FIFO
O publisher de outbox é responsável por transferir confiavelmente eventos da tabela `outbox_messages` do PostgreSQL para a fila FIFO do SQS (`wager-events.fifo` no LocalStack):
1. **Entrega At-Least-Once:** A entrega fornecida é comprovadamente **at-least-once**. Retentativas de rede, interrupções inesperadas de processos e reinicializações de workers podem fazer com que uma mensagem já enviada ao broker seja retransmitida. Consumidores downstream devem ser estritamente idempotentes (ex.: tabela de Inbox ou deduplicação por `eventId`).
2. **Preservação de Envelope:** O corpo de cada mensagem SQS contém o JSON canônico integral do evento: `eventId`, `eventType`, `version`, `occurredAt`, `aggregateId`, `correlationId`, `causationId` e `data`.
3. **Identificadores FIFO:**
   - `MessageDeduplicationId = eventId`: o identificador único do evento atua como chave de deduplicação na fila FIFO.
   - `MessageGroupId = aggregateId`: particiona as mensagens pela identidade da carteira (`walletId`), preservando a ordem de aceitação pelo broker dentro do grupo. Não garante ordem causal original entre publishers concorrentes.
4. **Isenção de Deduplicação Permanente pelo FIFO:** A janela de deduplicação de 5 minutos do SQS FIFO protege contra repetições de curtíssimo prazo decorrentes de retries imediatos ou crashes entre o envio e o `published_at`, mas **NÃO** é assumida como mecanismo definitivo de deduplicação de negócio. Mensagens retransmitidas além dessa janela geram nova entrega.
5. **Ordenação Efetivamente Ofertada:** O sistema não oferece ordenação causal global arbitrária via timestamp e UUID distribuídos entre agregados distintos. A garantia é a ordem de aceitação pelo broker dentro de cada grupo (`MessageGroupId = aggregateId`); publishers concorrentes podem inverter a ordem causal original mesmo dentro do grupo.

### 15.2 Coordenação Concorrente por Lease Persistente e `FOR UPDATE SKIP LOCKED`
Múltiplas instâncias do worker publisher concorrem pela fila de mensagens não publicadas sem contenção ou sobreposição:
1. **Migration Incremental 008:** Adiciona colunas operacionais em `outbox_messages`: `lease_token`, `lease_owner`, `lease_expires_at`, `attempts`, `next_attempt_at`, `last_error`, `is_operationally_blocked` e `operational_block_reason`.
2. **Claim Atômico:** Transação SQL curta seleciona até `batchSize` registros com `published_at IS NULL AND is_operationally_blocked = FALSE AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp()) AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp())` ordenados por `next_attempt_at ASC NULLS FIRST, created_at ASC` com `FOR UPDATE SKIP LOCKED`.
3. **Relógio Exclusivo no PostgreSQL (`clock_timestamp()`):** Toda a verificação de elegibilidade e cálculo de expiração de lease decorre do relógio do banco de dados, protegendo contra divergências temporais de relógio (clock drift) entre os nós da aplicação.
4. **Fencing contra Leases Obsoletos (Stale Lease Protection):** Finalização (`markPublished`), falha (`recordFailure`) e bloqueio (`markOperationallyBlocked`) exigem token correspondente, lease vigente no PostgreSQL e estado não publicado/não bloqueado. Expiração já revoga autorização mesmo sem novo claim. `releaseLease` apenas libera token correspondente em evento não publicado, inclusive expirado, sem confirmar publicação.

### 15.3 Tratamento de Falhas, Retentativas e Isolamento Fail-Closed
1. **Backoff Exponencial Limitado:** Falhas transitórias de conexão com o broker agendam a próxima tentativa com backoff determinístico `Math.min(1000 * 2^attempts, 60000)` ms, incrementando `attempts` e persistindo `last_error`.
2. **Isolamento Fail-Closed (`is_operationally_blocked`):** Eventos com payload corrompido ou envelope inválido são marcados com `is_operationally_blocked = TRUE` e `operational_block_reason = ...`. Como o predicado de claim exige `is_operationally_blocked = FALSE`, o item corrompido é excluído de buscas posteriores sem travar ou interromper a fila de eventos saudáveis.

### 15.4 Ciclo de Vida NestJS e Shutdown Coordenado
1. **Coordenação com o Ciclo da Aplicação:** `OutboxPublisherWorkerService` implementa `OnApplicationBootstrap`, `BeforeApplicationShutdown` e `OnModuleDestroy`.
2. **Interrupção Imediata de Novos Claims:** No início de `OnModuleDestroy`, `isShuttingDown` é assinalado como `true`, rejeitando novos ciclos de claim.
3. **Drenagem Segura de Lote In-Flight:** O encerramento aguarda o término do lote atual até o limite de tolerância configurado (`drainTimeoutMs`). Caso o tempo expire, o `AbortController` solicita cancelamento cooperativo e o worker aguarda o encerramento efetivo, mesmo além do prazo de diagnóstico. Só depois o cliente SQS próprio é destruído em `BeforeApplicationShutdown` e o ORM fecha em `OnApplicationShutdown`.

### 15.5 Imutabilidade Contábil
O publisher atua exclusivamente na tabela `outbox_messages`. Em nenhum momento o processo de publicação, retentativa ou crash recovery efetua mutações nas tabelas `wallets`, `wager_transactions` ou `wallet_ledger_entries`. Saldo, versão e lançamentos contábeis permanecem rigorosamente imutáveis.


### Estabilização M14 sobre main combinada (17/10/2026)
Base: `51c14400282749e972903929ef4517674c77bf0c`; branch `codex/m14-stabilization`.
- Shutdown: worker bloqueia novos claims e drena em `OnModuleDestroy`; após 5000 ms solicita cancelamento e continua aguardando encerramento efetivo. O limite de cancelamento de 5000 ms apenas emite diagnóstico, não autoriza fechar recursos. SQS próprio é destruído em `BeforeApplicationShutdown`, ORM em `OnApplicationShutdown`; cliente de terceiros pertence ao injetor externo. Confirmação SQS não pode ser revertida por cancelamento.
- `markPublished`, `recordFailure` e `markOperationallyBlocked` exigem token correspondente, `lease_expires_at > clock_timestamp()`, `published_at IS NULL` e evento não bloqueado. Expiração sem substituição já revoga autorização. `releaseLease` aceita token correspondente expirado de evento não publicado: libera somente a posse, sem confirmar envio nem modificar retry. Token antigo após novo claim não libera a posse atual.
- Validação por contratos v1 de `WalletBalanceChanged`, `WagerTransactionProcessed`, `WagerTransactionRejected` e `WagerTransactionPendingReference`, sem validadores HTTP. Identidade wallet/agregado, metadados, campos obrigatórios e Money canônico são conferidos sem regenerar identidade/timestamp nem modificar payload. Tipo/versão desconhecidos são bloqueios operacionais recuperáveis: corrigir contrato/dados sob procedimento operacional e desbloquear explicitamente; não descartar evento. `blocked` só aumenta após confirmação SQL.
- Padrões: polling 5000 ms, lote 20, lease 30000 ms, request SQS 5000 ms; retry `min(1000 * 2^attempts, 60000)` ms, sem jitter nem limite terminal de tentativas. Claim ordena `next_attempt_at ASC NULLS FIRST, created_at ASC`, usa `clock_timestamp()` e expiração `<=`.
- Envio concluído após expiração não autoriza marcar publicação. Evento permanece recuperável para republicar o mesmo eventId: entrega at-least-once exige consumidor idempotente. FIFO preserva ordem de aceitação pelo broker dentro do grupo, sem garantir ordem causal original entre publishers concorrentes.
- Evidências atualizadas: `docs/evidence/m14-stabilization.md`. As seções anteriores descrevem o histórico dos marcos; os resultados desta estabilização são registrados separadamente.
