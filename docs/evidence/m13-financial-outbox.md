# M13 — Outbox Financeira

## Base e isolamento

17/10/2026, America/Sao_Paulo.
- Base inspecionada: `4f6ab2d88ccc01fa27f3d7b0d4ef09c3001d515b` (HEAD de `origin/main`), com M12 concluído.
- Branch própria: `feat/m13-financial-outbox`.
- Worktree própria: `D:\processadorApostasDistribuidas\.worktrees\m13-financial-outbox`.
- Worktree `local-infrastructure` e demais entregas totalmente preservadas e intocadas.
- Sem push, merge em main, publicação ou operação no repositório da empresa.

## Objetivo e Escopo

Comprovar que cada operação financeira persiste os eventos corretos na mesma transação PostgreSQL do resultado contábil.
Esta meta NÃO implementa publisher, lease de publicação, consumidor, inbox ou integração SQS (metas M14–M16).

## Matriz de Auditoria e Contrato de Eventos

| Operação | Cenário / Resultado | Eventos Persistidos na Outbox | Qtd | Garantias de Envelope & Payload |
| :--- | :--- | :--- | :---: | :--- |
| **Abertura** | Saldo positivo (`> 0.00`) | `WagerTransactionProcessed` + `WalletBalanceChanged` | 2 | `kind: 'OPENING'`, `balanceBefore: 0.00`, `balanceAfter: initialBalance`, `version: 1`, `correlationId: openingTxId` |
| **Abertura** | Saldo zero (`0.00` ou omitido) | *(nenhum)* | 0 | Sem transação financeira, sem ledger, sem eventos na outbox |
| **BET** | Processado com movimento | `WagerTransactionProcessed` + `WalletBalanceChanged` | 2 | `kind: 'BET'`, débito em carteira, `version: V+1`, `triggerTransactionId: tx.id`, `correlationId` preservado |
| **BET** | Rejeição por saldo insuficiente (`INSUFFICIENT_FUNDS`) | `WagerTransactionRejected` | 1 | `failureCode: 'INSUFFICIENT_FUNDS'`, saldo inalterado, sem ledger, sem `BalanceChanged` |
| **LOSS** | Processado neutro | `WagerTransactionProcessed` | 1 | `kind: 'LOSS'`, saldo e versão inalterados, sem ledger, sem `BalanceChanged` |
| **WIN** | Processado com movimento (sem ref ou ref `PROCESSED`) | `WagerTransactionProcessed` + `WalletBalanceChanged` | 2 | `kind: 'WIN'`, crédito em carteira, `version: V+1`, `triggerTransactionId: tx.id` |
| **WIN** | Referência ausente (`PENDING_REFERENCE`) | `WagerTransactionPendingReference` | 1 | `kind: 'WIN'`, `attempts: 1`, `nextAttemptAt` no futuro, saldo inalterado |
| **WIN** | Reagendamento via worker (`RESCHEDULED`) | *(nenhum)* | 0 | Atualiza `attempts` e `nextAttemptAt` no banco; sem duplicação de evento |
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

## Garantias de Envelope e Persistência Comprovadas

1. **Identidade Estável e Única:** `eventId` é um UUID canônico persistido na chave primária `id` de `outbox_messages`.
2. **Campos do Envelope:** `eventType`, `version` (1), `occurredAt` (timestamp ISO 8601 em UTC), `aggregateId` (walletId).
3. **Correlação e Causalidade:** Suporta tanto UUIDs quanto strings arbitrárias de até 255 caracteres em `correlationId` (ex: IDs de parceiro como `custom-corr-partner#9988_...`), sem truncamento ou rejeição; `causationId` armazena a `Idempotency-Key` da transação causadora.
4. **Precisão Monetária Sem Float:** Todos os valores monetários (`amount`, `balance`, `previousBalance`, `currentBalance`) são estritamente formatados em `{ amount: string; currency: string }`. Nenhum tipo `number` transita nos payloads de evento.
5. **Reconstrução Sem Efeitos Colaterais:** `IntegrationEvent.reconstruct(envelope)` preserva fielmente `eventId`, `occurredAt`, `eventType`, `version`, `aggregateId`, `correlationId`, `causationId` e `data`, sem gerar novos UUIDs ou timestamps.
6. **Estado Inicial Não Publicado:** Todo evento nasce com `published_at IS NULL` no banco de dados. Métodos `listUnpublished()` e `findById()` operam estritamente sobre esse contrato.

## Garantias de Atomicidade Real e Isolamento MVCC

1. **Barreira Explícita de Visibilidade:**
   - Com uma conexão independente de observação externa (`m13_external_observer`), comprovou-se que durante a execução transacional (no hook `before_commit`), antes do `COMMIT` SQL:
     - A carteira no PostgreSQL mantém saldo e versão antigos.
     - A transação financeira não existe.
     - O lançamento contábil no ledger não existe.
     - Os eventos de outbox não estão visíveis na conexão externa.
   - Imediatamente após o `COMMIT`, todas as mutações e eventos de outbox tornam-se visíveis atomicamente na conexão externa.
2. **Reversão Total após Falhas Injetadas:**
   - **Falha após a 1ª gravação de outbox:** quando uma operação com 2 eventos sofre erro simulado logo após gravar o primeiro evento de outbox, o PostgreSQL executa `ROLLBACK` completo: saldo, versão, transação, ledger e outbox voltam ao estado original sem nenhuma linha órfã.
   - **Falha após a última gravação de outbox:** quando o erro ocorre após o segundo evento ser gravado na outbox, o `ROLLBACK` desfaz ambas as mensagens e todas as alterações contábeis.
   - **Reenvio Pós-Rollback:** O reenvio com a mesma chave de idempotência é executado com sucesso e gera exatamente o conjunto esperado (2 eventos), sem duplicações ou resquícios.
3. **Disputas Concorrentes:** Múltiplas requisições simultâneas com a mesma chave de idempotência processam uma única vez e as concorrentes realizam replay, gerando exatamente o conjunto original de eventos na outbox sem multiplicação.

## Ambiente e Execução

- **SO:** Windows x64.
- **Runtime:** Bun 1.4.3.
- **Banco de Dados:** PostgreSQL 16.8 real, cluster descartável exclusivo em `.data/m13-pg` na porta `55414`.
- **Configuração de Durabilidade:** `fsync=on`, `synchronous_commit=on`, `full_page_writes=on`.
- **Papel Restrito de Aplicação:** `app_user` (sem permissões de DDL ou TRUNCATE).
- **Isolamento de Infraestrutura:** A worktree `local-infrastructure` (portas 5432/5433) permaneceu intocada e isolada durante todo o processo.

## Resultados e Validação

1. `bun run typecheck`: **Exit 0**, sem erros de compilação ou tipagem.
2. Suíte dedicada M13 (`tests/integration/financial-outbox-m13.test.ts`):
   - **27 testes aprovados, 0 falhas, 229 assertions**.
   - Duração: ~4.10s.
3. Suíte combinada oficial (`bun run test`):
   - **381 testes aprovados, 0 falhas across 23 files**.
   - **Exit 0**.
