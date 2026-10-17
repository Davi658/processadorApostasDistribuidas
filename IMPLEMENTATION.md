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
| **Frente M06** | 17. Estabilização e Finalização de WIN e LOSS (Crédito exato e version+1, LOSS sem mutação/ledger/balance_changed, zero aceito, replay de snapshot histórico, 409 em conflitos, 50 WIN idênticas, 50 LOSS idênticas, WIN distintas concorrentes, limite Money e overflow, falhas injetadas com rollback auditado, Migration 004 permitindo múltiplas WINs na mesma BET sequencial e concorrentemente com down seguro, WIN fora de ordem via PENDING_REFERENCE e 202, WinProcessor dedicado, resolução determinística e replays) | **CONCLUÍDO** | `tests/integration/wager-win-loss-m06.test.ts` (38 testes passando) |
| **Frente M10** | 18. Worker de Referências Pendentes e Concorrência Distribuída (Reserva com relógio PostgreSQL NOW(), lease persistente imune a drift de Date.now(), operações atômicas com RETURNING id sem ressuscitar lease expirado nem permitir bloqueio por worker antigo, shutdown coordenado NestJS impedindo novos claims e drenando antes de fechar o ORM, timeout de drenagem cancelando com rollback, contadores e logs estritamente pós-commit, classificação de erros transitório / stale lease / snapshot inválido / defeito inesperado sem rejeição falsa, crash recovery com processos OS reais via SIGKILL e handshakes, 3 processos concorrentes com barreira) | **CONCLUÍDO** | `tests/integration/pending-reference-worker-m10.test.ts` (21 testes passando) |

---

## 2. Detalhamento das Implementações Realizadas


### 2.1 Bloco A — Correções Prioritárias
- **Migration 003 (`003_protect_terminals_and_composite_fk.sql` & `.down.sql`):**
  - Expansão de `outbox_messages.correlation_id` e `causation_id` para `VARCHAR(255)`.
  - Adição de colunas `reference_external_transaction_id`, `attempts` e `next_attempt_at` em `wager_transactions`.
  - Criação de índice único parcial `uq_processed_reversal_per_reference` em `(provider_id, reference_external_transaction_id, kind) WHERE status = 'PROCESSED' AND reference_external_transaction_id IS NOT NULL`.
  - Criação de constraint única composta `uq_wager_tx_id_wallet_currency` em `wager_transactions(id, wallet_id, currency)`.
  - Criação da foreign key composta `fk_ledger_wager_tx_wallet_currency` ligando `wallet_ledger_entries(transaction_id, wallet_id, currency)` a `wager_transactions(id, wallet_id, currency)`.
  - Trigger histórico `prevent_terminal_transaction_modification()`; a referência inválida a `observed_balance` desta versão é corrigida incrementalmente pela migration 006 (M11).
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
  - Consulta registros `PENDING_REFERENCE` elegíveis para reprocessamento manual (a consulta concorrente distribuída com lock pessimista `FOR UPDATE SKIP LOCKED` é reservada exclusivamente para o marco M10).
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
- **Referência Opcional de WIN e Resolução Fora de Ordem (`WinProcessor`):**
  - Se `referenceExternalTransactionId` for informada em WIN e a referência estiver ausente ou ainda não processada, a operação transiciona para `PENDING_REFERENCE` (HTTP 202 Accepted), com persistência do snapshot de resposta e evento `WagerTransactionPendingReferenceEvent` na outbox.
  - A resolução de referências pendentes foi encapsulada no serviço dedicado `WinProcessor` (reutilizando a exata mesma regra de domínio de WIN do fluxo imediato, sem direcionar para o `ReversalProcessor` exclusivo de reversões).
  - Quando a BET de referência é processada, o reprocessamento manual resolve a pendência aplicando um crédito exato, version+1, ledger `CREDIT`, eventos na outbox e status `PROCESSED`.
  - Referências com falha ou rejeitadas (`REJECTED` ou `FAILED`) são rejeitadas auditavelmente com o código estável `REFERENCE_NOT_PROCESSED`.
  - Referências incompatíveis (divergência de carteira, jogador, moeda, rodada ou tipo diferente de `BET`) são rejeitadas com `REFERENCE_INCOMPATIBLE`. Não se exige igualdade de valores entre WIN e BET (ganho não é reversão).
  - Replays terminais de transações resolvidas após período pendente preservam imutáveis os dados e saldos históricos originais.
- **Múltiplas WINs Vinculadas à Mesma BET (Migration 004):**
  - A migration incremental `004_restrict_reversal_unique_index.sql` restringe a unicidade parcial de `uq_processed_reversal_per_reference` exclusivamente a `kind IN ('REFUND', 'ROLLBACK')`.
  - Múltiplas operações WIN apontando para uma mesma BET são aceitas sequencial e concorrentemente, mantendo a consistência do saldo e do versionamento.
  - O script de reversão `004_restrict_reversal_unique_index.down.sql` implementa recusa segura com código 23505 caso encontre registros incompatíveis com a constraint 003, impedindo qualquer exclusão acidental de dados.

### 2.12 Frente M09 Estabilizada (Replay de PENDING_REFERENCE e Transições Terminais)
- **Snapshot Atômico de Aceitação:**
  - Persistência atômica na mesma transação relacional (`MikroOrmUnitOfWork`) de:
    - `transactionId`
    - `status: 'PENDING_REFERENCE'`
    - `balance: { amount, currency }` observado na aceitação
    - `idempotentReplay: false`
    - Snapshot persistido em `response_snapshot` (JSONB) da entidade `WagerTransaction`
    - Evento de outbox `WagerTransactionPendingReference` na tabela `outbox_messages` (coluna `event_type = 'WagerTransactionPendingReference'`).
- **Política de Replay em Estado Pendente:**
  - Mesma `Idempotency-Key` e mesmo payload canônico retornam HTTP 202 com o snapshot de aceitação original e `idempotentReplay: true`.
  - Preserva estritamente o saldo histórico mesmo após mutações posteriores na carteira.
  - Zero efeitos colaterais no replay: não movimenta saldo, não insere registros em `wallet_ledger_entries`, não emite eventos em `outbox_messages`, não incrementa `attempts` e não altera `next_attempt_at`.
- **Evolução do Snapshot e Replay Terminal:**
  - O aceite pendente conserva seu snapshot de aceitação enquanto pendente; após a resolução pelo reprocessador, passa a fornecer o resultado terminal:
    - Se `PROCESSED`: HTTP 200 OK com saldo após o processamento e `idempotentReplay: true`.
    - Se `REJECTED`: HTTP 422 Unprocessable Entity com `failureCode` original e `idempotentReplay: true`.
  - Mutações posteriores não alteram o resultado histórico gravado no snapshot terminal.
- **Detecção Estrita de Conflito de Idempotência (409):**
  - Reenvio da mesma chave com payload divergente retorna HTTP 409 Conflict em qualquer estado (pendente ou terminal), sem alterar a transação ou emitir efeitos.
- **Retry e Tratamento Estrito de Registros Legados:**
  - O reprocessamento sem referência aplica backoff exponencial determinístico (`Math.min(500 * 2^attempts, 10000)` ms sem jitter) e atualiza `attempts` e `next_attempt_at`, preservando integralmente o snapshot de aceitação original.
  - Remoção total de fallbacks inseguros: não reconstrói saldo histórico por timestamps do ledger, não usa saldo atual da carteira e não adota `"0.00"` arbitrário. Na ausência de snapshot estruturado íntegro, lança erro tipado `REPLAY_SNAPSHOT_UNAVAILABLE` mapeado para HTTP 500 genérico e estável sem expor dados internos. Registros legados exigem análise e diagnóstico operacional manual, pois repetir a requisição não recupera o histórico. A mesma política fail-closed é aplicada aos processadores `WinProcessor` e `ReversalProcessor`, preservando intactos os registros legados no banco.
- **Comprovação com PostgreSQL Real Descartável:**
  - Suíte `tests/integration/wager-pending-replay-m09.test.ts` (22 testes passando, 100% de sucesso) cobre todos os critérios A a I e a remoção completa de fallbacks inseguros.

### 2.13 Frente M10 Estabilizada (Worker de Referências Pendentes e Concorrência Distribuída)
- **Migration 005 (`005_pending_reference_worker_lease.sql` & `.down.sql`):**
  - Adição de colunas `lease_token VARCHAR(64)`, `lease_owner VARCHAR(255)`, `lease_expires_at TIMESTAMPTZ`, `is_operationally_blocked BOOLEAN DEFAULT FALSE` e `operational_block_reason VARCHAR(255)` na tabela `wager_transactions`.
  - Índices dedicados para seleção eficiente: `idx_wager_tx_pending_claim` em `(status, is_operationally_blocked, next_attempt_at, lease_expires_at, created_at)` e `idx_wager_tx_lease_expires` em `(lease_expires_at)`.
  - Reversibilidade total comprovada (`migrator.down()` e `migrator.up()`).
- **Reserva Persistente Curta com `FOR UPDATE SKIP LOCKED` e Horário do PostgreSQL:**
  - Consulta atômica isolada de seleção e marcação do lease (`claimPendingReferences`) sem nenhuma movimentação financeira.
  - O relógio do PostgreSQL (`NOW()`) determina a elegibilidade e expiração dos leases; validação de posse (`isLeaseValid`) consulta diretamente `WHERE lease_expires_at > NOW() AND lease_token = ?`, sem depender de `Date.now()` da aplicação, imune a desvios artificiais ou relógios descalibrados.
- **Operações Atômicas de Lease com Sucesso Inequívoco:**
  - `releaseLease(id, token)`, `renewLease(id, token, durationMs)` e `markOperationallyBlocked(id, token, reason)` utilizam `UPDATE ... RETURNING id`, informando sucesso inequívoco (`true` somente se 1 linha afetada).
  - Token incorreto, reserva já expirada no PostgreSQL ou substituída por outro worker retornam `false` sem modificar absolutamente nada.
  - Renovação nunca ressuscita lease já expirado no PostgreSQL.
  - Não é permitido que um worker antigo bloqueie operacionalmente um item já reservado por outro worker.
- **Ciclo de Vida NestJS e Shutdown Coordenado com Ordem Comprovada:**
  - Inicialização automática via `OnApplicationBootstrap` (`start()`).
  - Prevenção de sobreposição de ticks via `isTickRunning`.
  - Drenagem coordenada implementando `OnModuleDestroy` e `BeforeApplicationShutdown`:
    - Bloqueia novos claims imediatamente (`isShuttingDown = true; stop()`).
    - Drena tarefas in-flight com timeout configurável (`drainTimeoutMs`).
    - Caso a drenagem expire, `AbortController` marca o contexto transacional capturado explicitamente pela Unit of Work, independente do AsyncLocalStorage do chamador.
    - O segundo prazo (`cancellationTimeoutMs`) é diagnóstico: mesmo excedido, aguarda a execução terminar. `start()` e `executeBatch()` não iniciam novos claims no shutdown; chamadas simultâneas de batch compartilham a execução ativa.
    - Begin e commit explícitos mantêm o listener ativo durante preparação e flush. A última verificação e o envio de COMMIT não têm await intermediário. Após envio, aguarda confirmação sem rotular commit confirmado como rollback; recursos e listeners são limpos em finally.
    - Limites PostgreSQL de lock e statement, também nas conexões usadas fora da transação, encerram consultas e esperas SQL. Os padrões são 5000 ms e 10000 ms; AbortController sozinho não interrompe SQL. Os limites são por instrução, e trabalho JavaScript precisa cooperar para encerrar.
    - O fechamento do ORM (`MikroOrmUnitOfWork.onApplicationShutdown`) é executado estritamente por último, após a conclusão ou cancelamento com rollback das operações em andamento, impedindo que transações financeiras continuem operando em conexões encerradas.
    - Comprovado com aplicação Nest real e operação pausada por barreira: `app.close()` impede novos claims, a barreira é liberada e o commit/rollback é verificado com fechamento limpo das conexões.
- **Resultados Pós-Commit e Classificação Rigorosa de Erros:**
  - Contadores (`processed`, `rejected`, `rescheduled`, `blocked`) e logs de sucesso só são atualizados após a confirmação inequívoca do commit da transação (`runInTransaction` concluído).
  - Injeção de falha no `before_commit` atesta que operações revertidas nunca são contabilizadas como concluídas.
  - Classificação estrita de erros:
    - *Transitórios conhecidos:* retry seguro sem queimar `attempts` de domínio, liberando o lease;
    - *Stale lease:* descarta posse antiga silenciosamente;
    - *Snapshot inválido:* bloqueio operacional fail-closed (`is_operationally_blocked = TRUE`), sem contaminação do lote;
    - *Defeito permanente/inesperado (ex: TypeError):* sinalização auditável explícita (`PENDING_REFERENCE_UNEXPECTED_ERROR`), sem transformar erro técnico em rejeição financeira falsa (`status` não vira `REJECTED`), permitindo o avanço do restante do lote.
- **Crash Recovery Real com Processos OS:**
  - Testes com processos OS reais via `spawn` + `SIGKILL` + handshake de marcos via stdout:
    - *Cenário A:* Filho anuncia marco `CLAIM_CONFIRMED` e pausa; coordenador mata o filho com `SIGKILL`; outro worker retoma o item após a expiração natural do lease no PostgreSQL.
    - *Cenário B:* Filho confirma commit financeiro na base emitindo marco `COMMIT_CONFIRMED` e pausa antes de finalizar o ciclo; coordenador mata o filho com `SIGKILL` e reinicia o worker; nenhum efeito financeiro, contábil ou evento se repete.
- **Comprovação com PostgreSQL Real Descartável:**
  - Suíte `tests/integration/pending-reference-worker-m10.test.ts` (21 testes passando, 100% de sucesso) cobrindo os cenários existentes e seis variantes de shutdown com barreiras (escrita, before_commit, flush, commit confirmado, lock e consulta longa), incluindo 3 processos concorrentes com barreira de arquivos, concorrência distribuída, duas reversões da mesma referência, falhas injetadas e reconciliação contábil integral.

Evidências finais, comandos, códigos de saída e limitações: [M10 shutdown](docs/evidence/m10-shutdown.md).

---

## 3. Próxima Rodada (Fatia de Mensageria e Concorrência Externa — M14, M15, M16)

> [!IMPORTANT]
> **Delimitação de Escopo (M02 a M10 vs M14/M15/M16):**
> A presente base conclui e comprova integralmente os fluxos de apostas, reversões imediatas e pendentes, créditos de ganhos, snapshots históricos (M09) e o worker distribuído com lease persistente seguro no PostgreSQL, crash recovery real e ciclo de vida NestJS (M10).
> Os seguintes componentes pertencem aos marcos M14, M15 e M16 e permanecem explicitamente como **NÃO VALIDADOS / FORA DE ESCOPO**:
> 1. **Publisher Concorrente da Outbox para Broker Externo (M14):** **NÃO VALIDADO / FORA DE ESCOPO**
> 2. **Inbox e Mensageria Assíncrona SQS (M15):** **NÃO VALIDADO / FORA DE ESCOPO**
> 3. **Retry, Dead Letter Queue (DLQ) e Shutdown do Consumidor (M16):** **NÃO VALIDADO / FORA DE ESCOPO**




## M11 — Proteção de Transações Terminais

Base inspecionada: origin/main local a47d1e2039e3e6267a910fd9331e342a8c013cb2 (a main local estava em 6acc7c3). A base informada 7c2cf20 não existe neste clone; nenhum remoto foi acessado. Branch exclusiva codex/m11-terminal-protection, worktree .worktrees/m11-terminal-protection.

Diagnóstico: a função histórica 003 referencia observed_balance, ausente do schema; não há correção posterior até 005. Uma atualização somente de attempts em registro terminal reproduz SQLSTATE 42703 no DOWN. O trigger histórico também não intercepta DELETE e não protege id ou created_at.

A migration 006 substitui a função e registra BEFORE UPDATE OR DELETE. A comparação JSONB com IS DISTINCT FROM preserva todos os campos salvo updated_at, attempts, next_attempt_at, lease_token, lease_owner, lease_expires_at, is_operationally_blocked e operational_block_reason. São campos exclusivamente operacionais; atualizá-los junto de um campo financeiro continua proibido. O schema financeiro, domínio, publisher e mensageria não foram ampliados. Migrations históricas permanecem intactas.

Provas reproduzíveis: tests/integration/terminal-protection-m11.test.ts usa PostgreSQL real descartável e triggers ativos. Para PROCESSED, REJECTED e FAILED, cada papel (app_user restrito e administrativo) tenta individualmente alterar 17 campos protegidos; cobre também NULL para valor e valor para NULL nas cinco colunas protegidas anuláveis, usando OPENING para permitir NULL em idempotency_key e payload_hash sem violar o contrato externo. Cada recusa verifica SQLSTATE 55000, motivo terminal_transaction_protected_fields e igualdade da linha completa antes/depois. UPDATE sem alteração é aceito.

DELETE pelo app_user verifica 42501 e o identificador da tabela (mensagem localizada pelo PostgreSQL); DELETE administrativo verifica 55000 e terminal_transaction_delete_forbidden, sem depender de FK ou ledger. Os oito campos operacionais são atualizados separadamente; cada um também é combinado com alteração financeira recusada. Há limpeza de lease e seis transições legítimas das duas origens pendentes aos três estados terminais. UP/DOWN/UP preserva linhas completas dos três estados e restaura a proteção. DOWN restaura deliberadamente a função histórica defeituosa; não oferece as garantias M11.


Validação final em 17/10/2026, PostgreSQL 16.8 exclusivo e descartável na porta 55411, com fsync=on e synchronous_commit=on:

| Comando | Exit code | Resultado |
| --- | --- | --- |
| bun run typecheck | 0 | Sem erros TypeScript |
| APP_DB_PORT=55411 MIGRATION_DB_PORT=55411 bun run test | 0 | 39 unitários + 282 integração + 6 concorrência = 327 testes, zero falhas; inclui M10, M17 e nove casos M11 |
| APP_DB_PORT=55411 MIGRATION_DB_PORT=55411 bun test tests/integration/terminal-protection-m11.test.ts | 0 | Reforço final: nove casos, 672 assertions; transições diretas e via PENDING_REFERENCE |
| git diff --check | 0 | Sem erros de whitespace |

Em PowerShell, definir as portas com $env:APP_DB_PORT='55411' e $env:MIGRATION_DB_PORT='55411' antes do comando. O teste M06 de rollback da 004 recebeu somente a reversão explícita da nova 006 antes da 005, em seus dois ciclos. Não houve alteração de comportamento de M06, M10 ou M17.

A matriz M11 verifica 217 recusas com linha intacta: 213 pela proteção terminal (55000), três por privilégio de DELETE (42501) e uma pela falha histórica reproduzida no DOWN (42703). Inclui seis transições diretas de PENDING/PENDING_REFERENCE aos três estados terminais e a transição PENDING para PENDING_REFERENCE. Triggers permanecem ativos; nenhuma prova altera session_replication_role.

Histórico de execução e limitações: a primeira execução de bun run test na porta 5432 retornou 1 (39 unitários aprovados; 185 integrações aprovadas e oito falhas, incluindo timeouts de preparação/limpeza, timeout M04 e teardown após preparação incompleta). PostgreSQL mostrou esperas VersionFileSync e DataFileImmediateSync; a repetição isolada de M04 com --timeout 30000 retornou 1 ainda na preparação. bun run test:concurrency nessa porta retornou 1 por timeout do hook e teardown sem UoW. Não houve afrouxamento da durabilidade ou dos prazos das regressões existentes. No primeiro run do cluster exclusivo, 281 integrações passaram e uma falhou porque o teste M06 ainda supunha 005 como última migration; o ajuste acima eliminou essa falha no run final. As tentativas iniciais do teste novo também corrigiram uma inferência de parâmetro UUID/texto e a expectativa de mensagem de privilégio localizada, sem mudança na lógica do trigger.

Logs locais ignorados pelo Git: m11-test.log (primeiro run), m11-test-isolated.log (diagnóstico do teste M06), m11-test-final.log (327 aprovações), m11-concurrency.log e m11-m04-recheck.log. O cluster exclusivo é encerrado após as provas. A main remota não foi consultada; a base é a referência local mais recente disponível. Nenhum push, merge, publicação ou operação remota foi realizado.
