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
    - Normalização consistente de `playerId` com `.trim()`, rejeitando strings vazias.
    - Exigência estrita de objeto com `amount` e `currency` quando `initialBalance` for fornecido, rejeitando `null`, `false`, `0`, `""`, números ou arrays antes de chamar métodos de string.
    - Restrição operacional estrita a `"BRL"`, rejeitando qualquer outra moeda com erro de domínio.
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

---

## 3. Próxima Rodada (Fatia de Mensageria e Resiliência)

Itens explicitamente delimitados para a próxima rodada (não implementados nesta entrega):
1. **Inbox Transacional:** Deduplicação e consumo idempotente na recepção de mensagens assíncronas.
2. **Integração SQS / LocalStack:** Conexão real com filas SQS simuladas localmente no LocalStack via Docker.
3. **Publisher Concorrente da Outbox:** Processador em background com polling distribuído (`SKIP LOCKED`), envio ao broker e marcação transacional de mensagens publicadas.
4. **Mecanismo de Retries e Dead-Letter Queue (DLQ):** Políticas de repetição com backoff exponencial e encaminhamento para DLQ após esgotamento.
5. **Crash Recovery:** Recuperação de falhas e reprocessamento consistente após reinicialização súbita de instâncias.
