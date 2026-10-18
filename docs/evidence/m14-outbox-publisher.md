# M14 — Publisher Concorrente da Outbox e SQS FIFO

## 1. Base e Isolamento

- **Data da Execução:** 17/10/2026, America/Sao_Paulo.
- **Base Revisada:** `f73e308a94cf18a366021a4e44c70334ea65d47c` (HEAD de `origin/main` local).
- **Branch Própria:** `feat/m14-outbox-publisher`.
- **Worktree Própria:** `D:\processadorApostasDistribuidas\.worktrees\m14-outbox-publisher`.
- **Preservação de Escopo:** Marcos M01–M13, M17 e infraestrutura Docker existente (`wagers-local`) preservados integralmente.
- **Restrição Estrita:** Nenhum push, nenhum merge em `main` e nenhuma operação no repositório remoto da empresa.

---

## 2. Objetivo e Contrato de Entrega

Publicação assíncrona e segura dos eventos confirmados na tabela `outbox_messages` para a fila FIFO `wager-events.fifo` provisionada no LocalStack SQS, garantindo recuperação robusta após falhas, proteção contra corrida entre instâncias concorrentes e imutabilidade do livro-razão financeiro.

### 2.1 Semântica At-Least-Once e Deduplicação
- **Garantia Efetiva:** A publicação oferece entrega **at-least-once**. Consumidores downstream devem ser idempotentes e implementar mecanismos de proteção contra duplicatas (ex.: tabela de Inbox ou processamento deduplicado por `eventId`).
- **Parâmetros FIFO Utilizados:**
  - `MessageDeduplicationId = eventId` (identificador único e imutável do evento de domínio).
  - `MessageGroupId = aggregateId` (ID da carteira `walletId`, particionando as mensagens do mesmo agregado ordenadamente).
- **Limitação da Janela FIFO do SQS:** A janela nativa de deduplicação de 5 minutos do SQS FIFO é aproveitada para retransmissões imediatas decorrentes de crashes na janela de publicação, mas **NÃO** é assumida como mecanismo permanente ou suficiente para o negócio. Consumidores downstream não podem depender do FIFO como único filtro de unicidade.
- **Ordenação Efetiva:** O sistema **NÃO** promete ordem causal global arbitrária baseada em timestamps ou UUIDs distribuídos. A garantia de ordenação estrita fornecida é a ordenação sequencial de entrega por partição no broker (`MessageGroupId = aggregateId`).

### 2.2 Preservação Integral do Envelope
O envelope serializado em JSON para o corpo da mensagem SQS preserva integralmente todos os campos canônicos:
- `eventId`: UUID v4 estável gerado no commit transacional da outbox.
- `eventType`: tipo do evento de integração (`WalletBalanceChanged`, `WagerTransactionProcessed`, `WagerTransactionPendingReference`, `WagerTransactionRejected`).
- `version`: versão do contrato de evento (1).
- `occurredAt`: carimbo de data/hora ISO 8601 em UTC.
- `aggregateId`: UUID da carteira associada.
- `correlationId`: identificador de rastreabilidade ponta a ponta (até 255 caracteres).
- `causationId`: identificador da operação originadora (`Idempotency-Key` ou UUID).
- `data`: carga útil com valores monetários estritos (`{ amount: string, currency: string }`), sem tipos de ponto flutuante (`number`).

---

## 3. Concorrência Segura e Lease no PostgreSQL

### 3.1 Migration Incremental 008 (`008_outbox_publisher_lease_and_retry.sql`)
Adiciona à tabela `outbox_messages`:
- `lease_token VARCHAR(64)`: token único criptograficamente seguro (UUID v4) gerado a cada reserva.
- `lease_owner VARCHAR(255)`: identificador do worker ou processo que detém o lease.
- `lease_expires_at TIMESTAMPTZ`: validade do lease calculada no relógio do PostgreSQL.
- `attempts INTEGER NOT NULL DEFAULT 0`: número de tentativas de envio executadas.
- `next_attempt_at TIMESTAMPTZ`: carimbo determinando a próxima tentativa após falhas.
- `last_error TEXT`: diagnóstico do último erro transitório ou técnico.
- `is_operationally_blocked BOOLEAN NOT NULL DEFAULT FALSE`: sinalizador de isolamento fail-closed.
- `operational_block_reason VARCHAR(255)`: motivo auditável de bloqueio operacional.
- Índices parciais de busca rápida:
  - `idx_outbox_messages_publisher_claim` em `(created_at ASC) WHERE published_at IS NULL AND is_operationally_blocked = FALSE`.
  - `idx_outbox_messages_lease_retry` em `(lease_expires_at, next_attempt_at) WHERE published_at IS NULL`.

### 3.2 Claim Transacional Curto com `FOR UPDATE SKIP LOCKED`
- A reserva é executada em transação curta e atômica:
  ```sql
  WITH eligible AS (
    SELECT id
    FROM outbox_messages
    WHERE published_at IS NULL
      AND is_operationally_blocked = FALSE
      AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
      AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
    ORDER BY created_at ASC
    LIMIT $1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE outbox_messages
  SET lease_token = $2,
      lease_owner = $3,
      lease_expires_at = NOW() + ($4 || ' milliseconds')::INTERVAL,
      updated_at = NOW()
  FROM eligible
  WHERE outbox_messages.id = eligible.id
  RETURNING outbox_messages.id, outbox_messages.lease_token, outbox_messages.lease_expires_at,
            outbox_messages.event_id, outbox_messages.event_type, outbox_messages.aggregate_id,
            outbox_messages.correlation_id, outbox_messages.causation_id, outbox_messages.payload;
  ```
- O relógio do PostgreSQL (`NOW()`) é a única fonte de verdade para elegibilidade e expiração de leases, eliminando riscos de desvio de relógio entre servidores.
- Instâncias concorrentes executam claims mutuamente exclusivos sem contenção bloqueante ou deadlocks.

### 3.3 Proteção Contra Leases Obsoletos (Stale Lease Protection)
- Métodos de confirmação (`markPublished`), falha (`recordFailure`) e liberação (`releaseLease`) utilizam `WHERE id = $1 AND lease_token = $2`.
- Se um worker for suspenso ou sofrer lentidão e seu lease expirar, outro worker assume a mensagem gerando um novo `lease_token`. Ao tentar finalizar, o worker antigo é rejeitado com retorno falso/zero linhas afetadas, impedindo a sobreposição de ações.

### 3.4 Isolamento de Envelopes Corrompidos (Fail-Closed)
- Mensagens com JSON malformado ou campos obrigatórios ausentes são marcadas via `markOperationallyBlocked(id, reason)`, persistindo `is_operationally_blocked = TRUE` e liberando o lease.
- Como o predicado de claim filtra `is_operationally_blocked = FALSE`, o item corrompido é imediatamente isolado, sem bloquear nem abortar a fila de mensagens saudáveis.

---

## 4. Provas Formais de Recuperação de Crash Real

A suíte `tests/integration/outbox-publisher-m14.test.ts` implementa testes com processos OS reais via `tests/concurrency/outbox-worker-runner.ts`:

1. **Crash Real após Claim antes do Envio SQS (Cenário E):**
   - O processo filho reivindica o evento e é imediatamente abatido (`SIGKILL` / `process.kill()`).
   - O evento permanece com `published_at IS NULL`.
   - Após a expiração do lease no PostgreSQL, um segundo worker reivindica a mensagem e publica com sucesso no LocalStack SQS.
2. **Crash Real após Confirmação SQS antes de Marcar `published_at` (Cenário F):**
   - O processo filho envia a mensagem ao SQS FIFO, obtém `MessageId` e `SequenceNumber` de sucesso, e é abatido antes da confirmação SQL no banco.
   - O evento permanece `published_at IS NULL`.
   - O worker de recuperação assume a mensagem expirada e republica para o SQS FIFO mantendo estritamente o mesmo `eventId` como `MessageDeduplicationId`.
   - O SQS FIFO aceita e deduplica o envio na janela de 5 minutos, e o worker de recuperação marca com sucesso `published_at = NOW()` no PostgreSQL sem perda de dados.
3. **Isolamento de Transações Não Confirmadas (MVCC - Cenário A):**
   - Eventos inseridos dentro de transações financeiras em andamento (antes do COMMIT) não são visíveis nem publicados pelo publisher.

---

## 5. Ciclo de Vida NestJS e Shutdown Coordenado

O serviço `OutboxPublisherWorkerService` integra-se ao ciclo de vida da aplicação NestJS:
1. `OnApplicationBootstrap`: inicia o loop de polling periódico.
2. `BeforeApplicationShutdown`: sinaliza `isShuttingDown = true` impedindo novos claims e aciona o cancelamento cooperativo via `AbortController`.
3. `OnModuleDestroy`: aguarda ativamente a drenagem do lote in-flight até o prazo limite (`drainTimeoutMs`, padrão 5000ms), liberando o encerramento seguro antes da destruição do pool de banco de dados e do cliente SQS.

---

## 6. Imutabilidade Financeira Comprovada

Durante todas as fases de publicação, falha, retentativa, crash recovery e bloqueio operacional, o publisher:
- **NÃO** acessa nem altera a tabela `wallets` (saldo e versão mantidos íntegros).
- **NÃO** altera campos financeiros da tabela `wager_transactions`.
- **NÃO** insere ou altera registros na tabela contábil `wallet_ledger_entries`.

---

## 7. Evidências de Execução e Resultados

### 7.1 Compilação e Tipagem
```bash
bun run typecheck
# Exit code: 0 (sem erros de compilação TypeScript)
```

### 7.2 Suíte Integrada M14
```bash
bun test tests/integration/outbox-publisher-m14.test.ts --timeout 30000
```
- **Resultado:** 11 pass / 0 fail (116 assertions) em 23.93s.
- **Cenários Comprovados:**
  - [x] A. Evento de transação não confirmada não é publicado (MVCC).
  - [x] B. Publicação preserva integralmente o envelope e os identificadores FIFO.
  - [x] C. Dois publishers concorrentes não possuem simultaneamente o mesmo claim válido (`FOR UPDATE SKIP LOCKED`).
  - [x] D. Falha antes do envio permite recuperação após expiração do lease.
  - [x] E. Crash real após claim: segundo processo retoma após expiração.
  - [x] F. Crash real após confirmação SQS e antes de marcar `published_at`: recuperação republica com mesmo `eventId`.
  - [x] G. Obsolete claim token rejeitado ao tentar atualizar linha com novo lease.
  - [x] H. Falha/indisponibilidade do SQS mantém evento não publicado e reagenda com backoff.
  - [x] I. Evento inválido não impede publicação dos demais (`is_operationally_blocked`).
  - [x] J. Shutdown em aplicação Nest real preserva recuperabilidade e fecha recursos na ordem correta.
  - [x] K. Publicação não altera saldo, versão, transações ou ledger.

### 7.3 Suíte Completa de Regressão do Repositório
```bash
bun run test
```
- **Resultado:** **25 arquivos executados, 0 falhas, Exit code: 0**.
- Todas as regressões históricas (M01 a M13, M17, migrations UP/DOWN 001–008) passaram integralmente.

### 7.4 Multi-Stage Docker Build
```bash
docker build -t wagers-m14-isolated-app:bun-1.4.3 --target runtime .
docker build -t wagers-m14-isolated-test:bun-1.4.3 --target tester .
```
- Imagens construídas com sucesso em ambiente isolado Alpine Linux / Bun 1.4.3 com `bun install --frozen-lockfile`.
