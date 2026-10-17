# Plano de Execução e Status da Implementação

## 1. Status Geral da Entrega (Rodada Atual)

| Bloco | Requisito | Status | Teste Automatizado |
|---|---|---|---|
| **Bloco A** | 1. Correlation ID e Idempotência (VARCHAR 255, propagação) | **CONCLUÍDO** | `tests/integration/postgres-invariants.test.ts`, `tests/integration/http-endpoints.test.ts` |
| **Bloco A** | 2. Proteger Transações Terminais (`IS DISTINCT FROM`, trigger reforçado) | **CONCLUÍDO** | `tests/integration/postgres-invariants.test.ts` |
| **Bloco A** | 3. Vincular Ledger à Transação Correta (FK composta transactionId, walletId, currency) | **CONCLUÍDO** | `tests/integration/postgres-invariants.test.ts` |
| **Bloco A** | 4. Invariantes Independentes do HTTP (Domínio isolado, regex canônica, vínculo player) | **CONCLUÍDO** | `tests/integration/postgres-invariants.test.ts`, `tests/unit/money.test.ts` |
| **Bloco A** | 5. Erros Transitórios e Envelope de Eventos (ECONNREFUSED, 503, IntegrationEventEnvelope) | **CONCLUÍDO** | `tests/integration/http-endpoints.test.ts`, `src/domain/events/events.ts` |
| **Bloco B** | 6. Isolar o Banco de Testes (DB descartável por execução, migrador automático, app_user) | **CONCLUÍDO** | `tests/test-db-helper.ts`, todas as suítes de integração |
| **Bloco B** | 7. Corrigir Testes de Concorrência (Disputa real de chaves em paralelo, barreira com READY) | **CONCLUÍDO** | `tests/concurrency/concurrency.test.ts`, `tests/concurrency/worker.ts` |
| **Bloco B** | 8. Ponto de Controle (Validação completa com PostgreSQL real) | **CONCLUÍDO** | 79 testes unitários/integração + 4 concorrência passando |
| **Bloco C** | 9. Generalizar Processamento (BET, WIN, LOSS, REFUND, ROLLBACK unificados) | **CONCLUÍDO** | `tests/integration/wager-operations.test.ts`, `tests/integration/http-endpoints.test.ts` |
| **Bloco C** | 10. Implementar Referências e Reversões (Validação estrita, unicidade parcial no banco) | **CONCLUÍDO** | `tests/integration/wager-operations.test.ts` |
| **Bloco C** | 11. Referências Fora de Ordem (`PENDING_REFERENCE`, worker com backoff exponencial) | **CONCLUÍDO** | `tests/integration/wager-operations.test.ts` |
| **Bloco C** | 12. Testar Novas Operações e Reconciliação Final | **CONCLUÍDO** | `tests/integration/wager-operations.test.ts`, `tests/integration/http-endpoints.test.ts` |
| **Frente M02** | 13. Estabilização da Frente Money (NUMERIC 18,2, overflow no domínio, round-trip real) | **CONCLUÍDO** | `tests/unit/money.test.ts`, `tests/integration/money-postgres-roundtrip.test.ts` |
| **Frente M03** | 14. Estabilização da Abertura de Carteira (Contrato, atomicidade SQL, 20 concorrentes, rollback em falhas injetadas, reconciliação, limite Money) | **CONCLUÍDO** | `tests/integration/wallet-opening.test.ts` |
| **Frente M08** | 15. Validações Financeiras de Reversões Fora de Ordem e Imediatas (ReversalProcessor unificado, cross-wallet fora de ordem, moeda divergente com fixture USD consistente, referência FAILED/REJECTED imediata e tardia, auditoria estrita outbox/ledger/snapshot e reconciliação) | **CONCLUÍDO** | `tests/integration/wager-reversals-m08.test.ts` |
| **Frente M05** | 16. Estabilização MikroORM e Unidade de Trabalho (Isolamento de EntityManager por execução via AsyncLocalStorage, zero Identity Map compartilhado, conexão e tx compartilhadas pelos 4 repositórios, locks pessimistas na tx, rollback integral, chamadas aninhadas com Rollback-Only, escrita sem UoW rejeitada com TransactionRequiredError, ciclo de vida NestJS sem conexões penduradas) | **CONCLUÍDO** | `tests/integration/mikro-orm-uow-m05.test.ts` (18 testes passando) |
| **Frente M06** | 17. Estabilização de WIN e LOSS (Crédito exato e version+1, LOSS sem mutação/ledger/balance_changed, zero aceito, replay de snapshot histórico, 409 em conflitos, 50 WIN idênticas, 50 LOSS idênticas, WIN distintas concorrentes, limite Money e overflow, falhas injetadas com rollback auditado e referência opcional validando BET) | **CONCLUÍDO** | `tests/integration/wager-win-loss-m06.test.ts` (31 testes passando) |


---

## 2. Detalhamento das Implementações Realizadas

### 2.1 Bloco A — Correções Prioritárias
- **Migration 003 (`003_protect_terminals_and_composite_fk.sql` & `.down.sql`):**
  - Expansão de `outbox_messages.correlation_id` e `causation_id` para `VARCHAR(255)`.
  - Adição de colunas `reference_external_transaction_id`, `attempts` e `next_attempt_at` em `wager_transactions`.
  - Criação de índice único parcial `uq_processed_reversal_per_reference` em `(provider_id, reference_external_transaction_id, kind) WHERE status = 'PROCESSED' AND reference_external_transaction_id IS NOT NULL`.
  - Criação de constraint única composta `uq_wager_tx_id_wallet_currency` em `wager_transactions(id, wallet_id, currency)`.
  - Criação da foreign key composta `fk_ledger_wager_tx_wallet_currency` ligando `wallet_ledger_entries(transaction_id, wallet_id, currency)` a `wager_transactions(id, wallet_id, currency)`.
  - Trigger `prevent_terminal_transaction_modification()` com comparação segura `IS DISTINCT FROM` para todos os campos que definem identidade, payload e resultado original.
- **Invariantes de Domínio e Envelope:**
  - `Money.create` com regex `/^(?:0|[1-9]\d*)\.\d{2}$/`, rejeitando representações não-canônicas (`"00.00"`, `"01.50"`).
  - `IntegrationEventEnvelope<T>` com serialização explícita e método estático `reconstruct()`.
  - `DomainExceptionFilter` com extração recursiva de erro (`ECONNREFUSED`, `57P01`, `08006`, etc.) retornando HTTP 503 com diagnóstico interno seguro.

### 2.2 Bloco B — Testes e Ponto de Controle
- **Isolamento de Banco de Dados:** Módulo `tests/test-db-helper.ts` implementa `createIsolatedTestDatabase(prefix)` e `closeAndDrop()`, gerando banco de dados descartável por execução, executando migrações como superusuário, configurando concessão restrita de privilégios para `app_user` e destruindo o banco no teardown com terminação de conexões ativas.
- **Barreira de Concorrência Confiável:** No arquivo `tests/concurrency/worker.ts`, o processo filho anuncia `READY\n` via stdout antes de aguardar a liberação da barreira. A coordenação em `tests/concurrency/concurrency.test.ts` elimina tempos fixos de espera e trata timeouts e falhas nos filhos.
- **Disputa Real de Chaves entre Carteiras:** Implementado teste de colisão concorrente onde duas carteiras distintas competem simultaneamente pela mesma chave de idempotência; exatamente uma vence e a carteira perdedora permanece 100% inalterada, sem ledger ou eventos parciais.

### 2.3 Bloco C — Próxima Fatia Financeira
- **Caso de Uso Unificado (`ProcessWagerUseCase`):**
  - `BET`: débito com validação de saldo insuficiente (`INSUFFICIENT_FUNDS`).
  - `WIN`: crédito com ledger `CREDIT` e incremento de versão.
  - `LOSS`: neutro, sem alteração de saldo, sem ledger e sem incremento de versão.
  - `REFUND`: crédito estornando BET processada com valor idêntico.
  - `ROLLBACK`: reversão estornando BET, WIN ou REFUND. Caso o rollback de WIN não tenha saldo, rejeita com `REVERSAL_INSUFFICIENT_FUNDS`.
- **Worker de Referências Pendentes (`ReprocessPendingReferencesUseCase`):**
  - Consulta registros `PENDING_REFERENCE` elegíveis com lock pessimista `SKIP LOCKED`.
  - Se a referência foi processada, executa a reversão mantendo a atomicidade financeira.
  - Se a referência foi rejeitada ou falhou, transiciona para `REJECTED` com `REFERENCE_NOT_PROCESSED`.
  - Se o tempo limite ou número máximo de tentativas esgotar, transiciona para `REJECTED` com `REFERENCE_NOT_FOUND`.

### 2.4 Idempotência Canônica e Política de Compatibilidade de Hashes
- **Serialização Canônica Recursiva:** O método `ProcessWagerUseCase.computePayloadHash` utiliza `canonicalStringify`, ordenando chaves alfabeticamente em todos os níveis e preservando a ordem de arrays. Isso garante que campos aninhados (`money.amount` e `money.currency`) sejam incluídos no cálculo do SHA-256.
- **Registros Anteriores e Decisão de Compatibilidade:** Registros de transações gravados antes desta correção foram gerados pelo algoritmo legado e exigem uma decisão explícita de compatibilidade antes de qualquer intervenção ou migração.
- **Sem Suposição de TTL:** Não há fundamento no enunciado para assumir validade transitória por TTL contratual. A imutabilidade histórica no PostgreSQL é preservada sem regravação silenciosa de hashes em transações terminais.

### 2.5 Frente Money Estabilizada (M02)
- **Limites e Precisão:** Alinhamento estrito com `NUMERIC(18,2)`: máximo `"9999999999999999.99"` e mínimo assinado `"-9999999999999999.99"`. Dinheiro nunca convertido para `number` (aritmética em `bigint` centavos e strings decimais canônicas com 2 casas).
- **Política de Overflow:** Erros de estouro de capacidade geram `MoneyOverflowError` (`code: 'MONEY_OVERFLOW'`) no nível de domínio antes de qualquer tentativa de persistência, evitando erros SQL inesperados (`22003`). Transações abortadas preservam 100% o saldo, versão, transação, ledger e outbox.
- **Valores Negativos Internos:** `Money.create` rejeita negativos em contratos externos. Operações internas e `rehydrate` suportam deltas negativos estritamente para diferenças contábeis e reconciliação.
- **Comprovação com PostgreSQL Real:** Suíte `tests/integration/money-postgres-roundtrip.test.ts` valida o ciclo `Money → ORM → NUMERIC(18,2) → ORM → Money` para valores de 0 centavos até o limite máximo, inclusive acima de `Number.MAX_SAFE_INTEGER`.

### 2.6 Frente Abertura de Carteira Estabilizada (M03)
- **Contrato e Semântica de Ausência:**
  - O contrato exige `{ playerId, initialBalance?: { amount, currency } }`.
  - Ausência explícita (chave omitida ou `undefined`) é tratada como abertura padrão com saldo zero `"0.00"` BRL, versão 1, sem geração de OPENING, ledger ou outbox.
  - Valores presentes mas não-conformes como `null`, `false`, `0`, `""`, strings primitivas, numbers ou objetos incompletos são estritamente rejeitados na camada de transporte (`HttpValidator.validateCreateWalletBody`) com HTTP 400 Bad Request (`{ statusCode: 400, error: 'Bad Request', message: '...' }`).
- **Validação Defensiva do Caso de Uso:**
  - O caso de uso `CreateWalletUseCase` possui validação defensiva autônoma e desacoplada do validador HTTP:
    - `playerId`: validado estritamente como UUID canônico, com aplicação de `trim()` e conversão para minúsculas (`toLowerCase()`) antes de qualquer consulta ou persistência, garantindo que variações de caixa ou espaços externos representem o mesmo jogador.
    - `initialBalance.amount`: **não** sofre `trim()`. A string original é encaminhada diretamente ao `Money.create`, rejeitando espaços iniciais ou finais (`" 10.00"` ou `"10.00 "`) conforme a regra monetária.
    - Exigência estrita de objeto com `amount` e `currency` quando `initialBalance` for fornecido, rejeitando `null`, `false`, `0`, `""`, números ou arrays antes de chamar métodos de string.
    - Restrição operacional estrita a `"BRL"` com normalização `toUpperCase()`, rejeitando qualquer outra moeda com erro de domínio.
- **Atomicidade SQL e Efeitos Colaterais:**
  - **Abertura Positiva:** Em uma única transação SQL (`EntityManager.transactional`), cria a entidade `Wallet`, a transação interna `WagerTransaction` com `kind: 'OPENING'`, o lançamento de crédito `WalletLedgerEntry` (`CREDIT`) e os dois eventos de outbox (`WagerTransactionProcessed` e `WalletBalanceChanged`). A versão final resultante da carteira é garantidamente `1`.
  - **Abertura Zero:** Cria exclusivamente a entidade `Wallet` com saldo `"0.00"` e versão `1`. Não gera transação `OPENING`, nenhum lançamento contábil no ledger e nenhum evento na outbox.
- **Proteção Concorrente e Conflitos Específicos:**
  - A unicidade de `(player_id, currency)` é resguardada a nível relacional no PostgreSQL pela constraint `uq_wallets_player_currency`.
  - Somente a violação de `uq_wallets_player_currency` (identificada inclusive em erros encapsulados no driver ou `cause`) é convertida em `DuplicateWalletError`. Violações de outras constraints (ex: `23505` em outras chaves) não são malclassificadas como carteira duplicada e são re-propagadas fielmente.
  - Disputas concorrentes via HTTP (validadas com 20 requisições simultâneas via `fetch`) resultam em exatamente 1 resposta HTTP 201 Created e 19 respostas HTTP 409 Conflict (`{ statusCode: 409, error: 'Conflict', code: 'DUPLICATE_WALLET' }`), com exatamente uma carteira, uma OPENING, um CREDIT e dois eventos persistidos no PostgreSQL.
- **Resiliência a Falhas Injetadas e Rollback Integral:**
  - Falhas simuladas em 4 estágios da persistência atômica (`after_wallet_save`, `after_tx_save`, `after_ledger_save`, `after_outbox_save`) executam `ROLLBACK` total.
  - Todos os identificadores são capturados antes do rollback para atestar a ausência de registros órfãos por ID, e hooks são devidamente limpos em `finally`.
  - Para cada ponto de falha, o reenvio após rollback realiza com sucesso a criação única da carteira.
- **Bloqueio de Submissão Externa de OPENING:**
  - Requisições ao endpoint externo `POST /wagering/transactions` com `kind: "OPENING"` são rejeitadas pelo validador HTTP e pelas invariantes de domínio com HTTP 400 Bad Request (`{ statusCode: 400, error: 'Bad Request', message: '...' }`).
- **Reconciliação e Limites de Valor:**
  - Toda carteira aberta tem seu saldo reconciliado com a soma dos lançamentos do ledger (`balance = SUM(CREDIT) - SUM(DEBIT)`).
  - Aberturas com o valor limite de `Money` (`"9999999999999999.99"`) são persistidas com precisão integral. Valores que excedem o limite são rejeitados com HTTP 400 sem efeitos colaterais no banco.


### 2.7 Frente Reversões Financeiras e Reprocessamento Unificado (M08)
- **Motor Compartilhado (`ReversalProcessor`):** Centraliza integralmente as regras de reversão sem divergência entre o fluxo síncrono e o reprocessador assíncrono.
- **Validações Pré-Movimento e Rejeição Auditada:**
  1. *Outra Carteira / Jogador (Cross-Wallet):*
     - Imediato: Reversão na Wallet 2 de transação da Wallet 1 é rejeitada imediatamente com `REFERENCE_INCOMPATIBLE`.
     - Fora de Ordem: Reversão chega na Wallet 2 sem referência e transiciona para `PENDING_REFERENCE`. A referência chega posteriormente na Wallet 1. A execução manual do reprocessador transiciona a pendência para `REJECTED` com `REFERENCE_INCOMPATIBLE` sem qualquer débito/crédito na Wallet 2.
  2. *Moeda Divergente (Fixture Contabilmente Consistente):*
     - O caminho fora de ordem registra a pendência BRL antes da inserção da referência USD.
     - A fixture USD é criada com consistência relacional e contábil completa (carteira USD, transação OPENING, crédito ledger, transação BET e débito ledger, respeitando constraints, versions e a FK composta `(transaction_id, wallet_id, currency)`).
     - O reprocessador rejeita a reversão BRL com `REFERENCE_INCOMPATIBLE` sem mutação de saldo ou ledger, e ambas as carteiras (BRL e USD) reconciliam perfeitamente.
  3. *Referência em Estado Terminal FAILED / REJECTED:*
     - Cobertura explícita para referências nos estados `REJECTED` e `FAILED`, tanto no fluxo imediato quanto no fora de ordem.
     - Todas as rejeições resultam no código estável `REFERENCE_NOT_PROCESSED`.
     - Fixtures criadas diretamente no estado correto sem violação ou desativação dos triggers de proteção terminal.
  4. *Auditoria Rigorosa da Outbox e Ledger:*
     - Consultas corrigidas para ler da coluna física `payload` (JSONB) no PostgreSQL, selecionando eventos pelo `transactionId` e `triggerTransactionId`.
     - Para cada reversão rejeitada, comprova-se:
       - Exatamente um evento `WagerTransactionRejectedEvent` com o `failureCode` esperado;
       - Zero eventos `WalletBalanceChangedEvent` emitidos para a transação;
       - Zero eventos `WagerTransactionProcessedEvent` emitidos para a transação;
       - Zero lançamentos contábeis em `wallet_ledger_entries` vinculados à transação;
       - Saldo (`balance`) e versão (`version`) da carteira rigorosamente inalterados;
       - Snapshot terminal completo e coerente (`response_snapshot` em `wager_transactions`).
     - Prova de sensibilidade dos seletores demonstrando que a ausência constatada decorre da efetiva não-emissão de eventos indevidos, e não de propriedades nulas ou filtros inoperantes.
  5. *Reconciliação Integral:*
     - Todas as carteiras envolvidas em todos os cenários (inclusive fixtures de moedas alternativas) passam por validação contábil via `ReconcileWalletUseCase` (`storedBalance == calculatedBalance`).

### 2.8 Frente MikroORM e Unidade de Trabalho (M05)
- **Isolamento de EntityManager e Conexão via `AsyncLocalStorage`:**
  - `MikroOrmUnitOfWork` gerencia o contexto assíncrono via `AsyncLocalStorage<TransactionContext>`, garantindo que cada execução concorrente possua sua própria instância de `EntityManager`, conexão e transação física.
  - Comprovação com PostgreSQL real em `tests/integration/mikro-orm-uow-m05.test.ts`:
    - **Identidade Transacional (Teste A):** Durante a gravação dos 4 repositórios (`wallets`, `wager_transactions`, `wallet_ledger_entries`, `outbox_messages`), todos compartilham o mesmo `EntityManager` e executam exatamente sob o mesmo PID de conexão física (`SELECT pg_backend_pid()`) e mesmo ID de transação (`SELECT txid_current()`).
    - **Isolamento e MVCC (Teste B):** Duas execuções concorrentes com sincronização explícita (sem esperas arbitrárias) usam PIDs e txids distintos. Enquanto não commitadas, dados inseridos por uma transação são 100% invisíveis na conexão externa do pool administrativo (`adminPool`).
- **Rollback Integral Auditado por ID (Teste C):**
  - Falhas injetadas após a gravação de cada um dos 4 repositórios (`after_wallet_save`, `after_tx_save`, `after_ledger_save`, `after_outbox_save`) executam `ROLLBACK` total. Todos os identificadores são auditados no PostgreSQL, garantindo ausência de linhas órfãs.
- **Semântica de Aninhamento e Estratégia Rollback-Only (Teste D):**
  - *D.1 (Não confirmação independente):* Bloco aninhado conclui sem confirmar no banco antes do bloco externo.
  - *D.2 (Falha externa desfaz trabalho interno):* Erro no bloco externo aborta e reverte tanto o trabalho externo quanto o trabalho do bloco aninhado.
  - *D.3 (Falha interna capturada / Rollback-Only):* Quando o bloco aninhado falha e a camada externa captura a exceção para tentar comitar parcialmente, o Unit of Work detecta `rollbackOnly = true`, rejeita a tentativa de commit com `TransactionRollbackOnlyError` (preservando o erro original em `cause`) e força `ROLLBACK` total no PostgreSQL.
  - *D.4 (Rejeição de continuação aninhada em Rollback-Only):* Tentativa subsequente de executar novo bloco aninhado em transação já abortada é rejeitada imediatamente com `TransactionRollbackOnlyError` preservando `cause`.
- **Limpeza de Contexto e Ciclo de Vida NestJS Real (Testes E e G):**
  - Após falhas, o contexto transacional é limpo e uma nova execução opera com novo contexto válido.
  - Teste G com PostgreSQL descartável inicializa aplicação Nest via `NestFactory.create(AppModule)` e `await app.init()` (sem chamar `onModuleInit` manualmente), executa operação transacional via provider real, confirma persistência por conexão externa administrativa identificada (`admin_pool_lifecycle_test`), encerra via `await app.close()` (sem chamar `close` manualmente) e atesta via `pg_stat_activity` que zero conexões da aplicação permanecem abertas. Teardown garantido em bloco `finally`.
- **Proteção Contra Escrita Acidental sem UoW (Teste F):**
  - Chamadas de `.save()` em qualquer um dos 4 repositórios fora de transação lançam `TransactionRequiredError` sem persistir dados no banco.
  - Locks pessimistas fora de transação são rejeitados com `TransactionRequiredError`. Consultas simples de leitura funcionam normalmente.

### 2.6 Frente M06 — Estabilização de WIN e LOSS
- **Garantias de WIN Comprovadas com PostgreSQL Real (`tests/integration/wager-win-loss-m06.test.ts`):**
  - Crédito exato com incremento de `version` em 1.
  - Gravação de transação `PROCESSED` e ledger `CREDIT` na mesma transação SQL.
  - Emissão de exatamente 2 eventos na outbox: `WagerTransactionProcessed` e `WalletBalanceChanged`.
  - Rejeição de valores zero e negativos, formatos não canônicos, moeda divergente (422) e jogador incompatível (400) sem efeitos parciais.
  - Crédito no limite máximo (`9999999999999999.99`) processado com sucesso e overflow (`+ 0.01`) rejeitado com `MONEY_OVERFLOW` (400) sem alterações na carteira.
- **Garantias de LOSS Comprovadas:**
  - Status `PROCESSED` persistido com snapshot.
  - Zero alteração em `balance`, `version` e `updated_at` da carteira.
  - Zero entradas em `wallet_ledger_entries`.
  - Emissão exclusiva de `WagerTransactionProcessed` (zero `WalletBalanceChanged`).
  - Aceita valor zero (`0.00`) conforme documentado e nunca movimenta saldo mesmo com valores positivos.
  - Proíbe `referenceExternalTransactionId` (400 Bad Request se fornecida).
- **Replay Histórico e Resolução de Conflitos:**
  - Replay retorna `transactionId`, status e saldo históricos da primeira execução (`idempotentReplay: true`), mesmo que o saldo atual da carteira tenha sido alterado posteriormente por outras transações.
  - Replay não altera o banco nem emite novos eventos.
  - Conflito de payload sob mesma chave retorna 409 `IDEMPOTENCY_CONFLICT`.
  - Reutilização de `providerId/externalTransactionId` sob outra chave retorna 409 `IDEMPOTENCY_CONFLICT`.
- **Concorrência Real e Falhas Injetadas:**
  - 50 WIN idênticas simultâneas geram exatamente 1 crédito, version+1 e 1 registro no ledger.
  - 50 LOSS idênticas simultâneas geram exatamente 1 transação, 1 evento e zero movimentos na carteira.
  - 10 WIN distintas simultâneas na mesma carteira executam soma exata sem lost update e com version correta (ex: +100.00 e version+10).
  - Falhas injetadas em `wallet_save`, `tx_save`, `ledger_save` e primeira `outbox_save` para WIN e `tx_save`, `outbox_save` para LOSS executam rollback integral auditado por IDs, com reenvio bem-sucedido e efeito único.
- **Referência Opcional de WIN:**
  - Se `referenceExternalTransactionId` for informada em WIN, valida existência e compatibilidade da BET (PROCESSED, mesma carteira/jogador/moeda/rodada). Se incompatível, não encontrada ou não processada, rejeita auditavelmente com 422 (`REFERENCE_INCOMPATIBLE`, `REFERENCE_NOT_FOUND` ou `REFERENCE_NOT_PROCESSED`). Se omitida, opera como ganho independente.

---

## 3. Próxima Rodada (Fatia de Mensageria e Resiliência — M09, M10, M15)

> [!IMPORTANT]
> **Delimitação de Escopo (M05/M06/M08 vs M09/M10/M15):**
> A presente suíte comprova a atomicidade e isolamento de `wallet`, `wager_transactions`, `wallet_ledger_entries` e `outbox_messages` via MikroORM e NestJS real.
> O reprocessador manual (`ReprocessPendingReferencesUseCase.execute()`) comprova a consistência financeira sob referências fora de ordem.
> Os seguintes componentes permanecem explicitamente como **NÃO VALIDADO / NÃO IMPLEMENTADO**:
> 1. **Replay Completo de PENDING_REFERENCE (M09):** **NÃO VALIDADO**
> 2. **Agendamento Automático em Background (Cron/Timer):** **NÃO VALIDADO**
> 3. **Concorrência entre Múltiplos Workers com `SKIP LOCKED` (M10):** **NÃO VALIDADO**
> 4. **Filas SQS / LocalStack e Mensageria Assíncrona Distribuída (M10):** **NÃO VALIDADO**
> 5. **Atomicidade Inbox / SQS (M15):** **NÃO VALIDADO / NÃO IMPLEMENTADO**
> 6. **Publisher Concorrente da Outbox com Broker:** **NÃO VALIDADO**
> 7. **Mecanismo de Retries Distribuído e DLQ:** **NÃO VALIDADO**
> 8. **Crash Recovery de Instâncias:** **NÃO VALIDADO**
