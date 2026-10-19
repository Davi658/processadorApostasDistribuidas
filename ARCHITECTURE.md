# Arquitetura e decisões técnicas

O motor financeiro é independente do transporte. HTTP e comandos SQS usam `ProcessWagerUseCase`; os processadores de WIN e reversões são compartilhados com o reprocessamento de referências. As decisões detalhadas e resultados de cada etapa foram preservados no [histórico técnico](docs/history/architecture.md); as restrições de escopo daquele histórico não descrevem o estado atual.

## Camadas e composição

- `src/domain`: Money em centavos bigint, carteiras, transações, ledger, erros e eventos, sem NestJS/ORM.
- `src/application`: casos de uso, portas, normalização, validação de snapshots/envelopes, inbox e paginação.
- `src/infrastructure`: PostgreSQL/MikroORM, migrations SQL, clientes SQS, workers e observabilidade.
- `src/interfaces/http`: controllers, validação de fronteira, filtro de erros e composição NestJS.

`AppModule`, `WageringQueryModule` e workers reutilizam a UoW/repositórios de `PersistenceModule`, sem pool paralelo de consultas. A UoW usa contexto assíncrono para preservar identidade transacional e lock pessimista da carteira, com lock de idempotência seguido de lock da carteira; carteiras independentes não dependem de lock financeiro global. Saldo, versão, transação, ledger e outbox são confirmados no mesmo commit. Na entrada SQS a inbox participa da UoW externa; erros escapam de transações abortadas e a recuperação ocorre na redelivery.

## Dinheiro, estados e idempotência

Money usa strings canônicas com duas casas na entrada/saída e bigint em centavos no cálculo. O limite persistido é NUMERIC(18,2): 9999999999999999.99. Overflow é validado no domínio. PostgreSQL arredonda excesso de escala ao converter NUMERIC; rejeitar entrada não canônica é responsabilidade da aplicação.

Abertura positiva gera OPENING e crédito no ledger; abertura zero não gera lançamento. Ambas iniciam versão 1. BET debita, WIN credita, LOSS não altera saldo/versão/ledger. REFUND reverte integralmente BET; ROLLBACK inverte BET/WIN/REFUND. Débitos preservam não negatividade. A política de reversão é por tipo: REFUND e ROLLBACK da mesma BET não são mutuamente exclusivos.

Estados: PENDING, PENDING_REFERENCE, PROCESSED, REJECTED, FAILED. Rejeição e pendência não implicam movimento financeiro. Referência ausente pode ser resolvida posteriormente; replay lê o snapshot atual persistido, sem recalcular saldo histórico. Snapshots inválidos falham fechados.

Chave idempotente normalizada de 1–255 caracteres e identidade externa por provedor são persistidas. Hash SHA-256 usa serialização canônica recursiva do negócio, sem correlação de transporte. Chave/payload iguais não repetem efeitos; divergência gera conflito. Dados gerados pelo algoritmo legado exigem decisão explícita de compatibilidade, sem reescrita silenciosa de hashes terminais ou expiração presumida.

## Schema e fronteiras das garantias

Há dez migrations UP e dez DOWN, com tracking em `schema_migrations` e advisory lock do migrador:

| Migration | Responsabilidade |
| --- | --- |
| 001 | Schema, ledger, outbox, permissões e proteções iniciais |
| 002 | Reforços relacionais e outbox |
| 003 | Proteção terminal e FK composta |
| 004 | Unicidade restrita às reversões |
| 005 | Lease e agendamento de referências |
| 006 | Proteção terminal por allowlist operacional |
| 007 | Exclusão de NaN em carteiras/ledger |
| 008 | Lease, retry e bloqueio operacional da outbox |
| 009 | Inbox de comandos |
| 010 | Identidade externa textual na inbox, preservando UUIDs existentes |

O índice efetivo, definido em [004](src/infrastructure/persistence/migrations/004_restrict_reversal_unique_index.sql), é:

```sql
CREATE UNIQUE INDEX uq_processed_reversal_per_reference
ON wager_transactions (provider_id, reference_external_transaction_id, kind)
WHERE status = 'PROCESSED'
  AND reference_external_transaction_id IS NOT NULL
  AND kind IN ('REFUND', 'ROLLBACK');
```

Isso permite múltiplos WIN para a mesma referência, mas impede duas reversões processadas do mesmo tipo. DOWN dessa migration pode recusar dados incompatíveis com a regra antiga; não é procedimento de limpeza.

Ledger tem magnitude positiva, aritmética por linha, saldos não negativos, unicidade por transação/carteira e FK `(transaction_id, wallet_id, currency)`. Trigger impede UPDATE/DELETE por linha; runtime só possui SELECT/INSERT. TRUNCATE é protegido por privilégios, sem trigger administrativo. Proprietário/superusuário capaz de alterar proteções fica fora dessa fronteira.

Migration 006 protege DELETE de terminais e todos os campos salvo a allowlist `updated_at`, `attempts`, `next_attempt_at`, `lease_token`, `lease_owner`, `lease_expires_at`, `is_operationally_blocked`, `operational_block_reason`. Não se limita à lista antiga de identidade/payload.

O banco não prova continuidade entre linhas, igualdade do saldo com a soma do ledger, completude do ledger de toda operação PROCESSED ou equivalência semântica do lançamento à operação. Isso depende de processadores/UoW e do protocolo de lock. SQL arbitrário privilegiado pode produzir divergência válida para checks. Reconciliação mantém lock, soma bigint e detecta diferença de totais; erros compensatórios podem escapar, e `created_at/id` não é sequência causal financeira.

## Referências, outbox e entrega at-least-once

Workers são opt-in. Referências usam lease persistente, token de posse, relógio PostgreSQL, `FOR UPDATE SKIP LOCKED`, backoff e bloqueio operacional de registros problemáticos. Reutilizam o motor financeiro, sem regras paralelas.

Outbox persiste envelopes v1 com identidade/timestamp estáveis e dinheiro em strings. Publisher faz claim em transação curta, envia fora dela e marca publicação sob token/lease vigente. Expiração revoga autorização mesmo sem novo claim. `releaseLease` libera apenas token correspondente não publicado, inclusive expirado, sem confirmar envio nem alterar retry. Falha após confirmação SQS e antes da marca SQL pode republicar o mesmo evento: a semântica é **at-least-once** e exige consumidor idempotente. FIFO usa aggregateId como grupo/eventId para deduplicação, mas a janela de deduplicação não é permanente, e concorrência pode inverter a ordem causal original. Envelopes inválidos são bloqueados para intervenção, sem descarte silencioso; retry da outbox é limitado em intervalo, sem jitter ou teto terminal de tentativas.

Inbox usa `(consumer_name, command_id)`, fingerprint e vínculo à transação, com advisory lock por identidade. Delete SQS só ocorre após commit confirmado; confirmação perdida e falha no delete são recuperadas por redelivery. A inbox registra aceitação inclusive de REJECTED/PENDING_REFERENCE, sem snapshot paralelo. Visibilidade é renovada, perdas de posse solicitam cancelamento e impedem delete indevido. Retry de transporte é separado das tentativas de referência financeira. Redrive é nativo do broker; replay da DLQ é manual e pode alterar ordenação. Consulte [contrato](docs/messaging/M15-IMPLEMENTED.md) e [confiabilidade](docs/messaging/M16-RELIABILITY.md).

Shutdown interrompe novos claims/receives, drena trabalho e solicita cancelamento nos deadlines; não fecha recursos enquanto trabalho efetivo ainda os usa. Cliente próprio SQS fecha antes do ORM. Um deadline diagnóstico não garante término forçado em tempo fixo e confirmação externa não é desfeita por cancelamento.

## Consultas, observabilidade e limites

Consultas de transação por UUID/identidade externa e ledger não escrevem estado financeiro. Ledger usa keyset `(created_at, id)`, `limit + 1`, limite padrão 50 (1–100), cursor Base64URL canônico vinculado à carteira e timestamp UTC com seis microssegundos. Cursor não é assinado nem credencial de autorização. Datas são validadas sem normalização por Date.parse.

Liveness independe de banco/broker. Readiness consulta PostgreSQL e somente filas habilitadas, com limite de tempo/concorrência e 503 durante shutdown. Logs usam allowlist; métricas Prometheus têm labels limitadas e contadores por processo, separando tentativa, confirmação do broker e commit local. Não representam entrega ao consumidor. O gauge `sqs_dlq_messages_visible` observa quantidade aproximada visível na DLQ, sem contar redrives históricos. A correlação original não é persistida para resolução tardia: referências podem registrar correlationId null com transactionId. [Contrato de observabilidade](docs/delivery/OBSERVABILITY.md).

Autenticação/autorização foi omitida do escopo de avaliação do motor financeiro. A porta `ProviderIdentityPort` com adapter OIDC/JWKS e Guard na borda HTTP é o ponto de extensão para identidade, confiança de provedor e autorização de carteira, sem contaminar regras de domínio. Cursor, UUID e chave idempotente não substituem autorização. Endpoints de métricas também precisam de controle de exposição em produção.

LocalStack comprova cenários de integração local, não disponibilidade/limites operacionais da AWS em produção, soak test ou escala ilimitada. Sem retenção automática da inbox, coletor de métricas, DLQ worker ou compatibilidade automática do hash legado. Os resultados históricos permanecem vinculados às suas bases; a [validação desta revisão](docs/review/VALIDATION.md) relata o que foi reproduzido agora.

O contrato externo WagerTransactionRequested usa messageId textual e data.idempotencyKey obrigatória, com namespace de inbox distinto do ProcessWager v1 interno. A migration 010 converte command_id para varchar(255); DOWN recusa identidades não conversíveis em UUID sem apagá-las. Consulte o [contrato externo](docs/messaging/EXTERNAL-CONTRACT.md). Gauges financeiros leem linhas persistidas; financial_invocations_total e seu histograma medem chamadas, inclusive replay/falha, sem prometer commit da UoW externa. A DLQ possui sonda aproximada de mensagens visíveis; não há replay automático.
