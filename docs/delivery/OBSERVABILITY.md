# Semântica operacional da entrega

| Série | Tipo e significado |
|---|---|
| `financial_invocations_total{status,kind}` | Counter por processo de saídas do ProcessWager, inclusive falha e replay financeiro. O status é o retornado pelo use case; uma UoW externa ainda pode reverter. Duplicata já encontrada na inbox não chama o use case. Não é contagem de commits. |
| `financial_invocation_duration_seconds{kind,status}` | Histogram entre entrada do ProcessWager e seu finally: validação, locks, execução e reconciliação de races. Com UoW própria inclui o commit; com UoW externa exclui o commit do dono. Sempre exclui delete SQS. |
| `financial_transactions{status,kind}` | Gauge de linhas persistidas por estado atual, coletado por SELECT no scrape; inclui OPENING. Replay não cria linha e rollback externo não aparece. Não somar entre réplicas ligadas ao mesmo banco. |
| `sqs_dlq_messages_visible{queue}` | Gauge aproximado de mensagens visíveis via GetQueueAttributes, não contador histórico de redrives. Antes da primeira coleta bem-sucedida não há amostra. Não usa ReceiveMessage na DLQ. |
| `outbox_pending_events` | Gauge coletado no banco: não publicadas e não bloqueadas operacionalmente, incluindo lease e backoff. |
| `outbox_delay_seconds` | Idade do evento mais antigo no mesmo conjunto, calculada com relógio PostgreSQL; zero quando vazio. Publicar um lote não sobrescreve essa observação global. |
| `outbox_publish_lag_seconds` | Histogram de idade desde occurredAt, amostrada após marcação local bem-sucedida; inclui envio e marcação. Não é latência exclusiva da rede SQS. |
| `operational_events_total` | Estágios por processo: consumer/inbox accepted e duplicate, retry_visibility, falhas, confirmação durável e delete; publisher/send broker_confirmed separado de mark/local_confirmed; referências contabilizam resolução após commit. Replays também podem observar resultado durável existente. |

`financial_transactions_total`, `financial_transaction_duration_seconds`, `sqs_dlq_messages_total` e `outbox_pending_events_total` foram retiradas/renomeadas para evitar semântica falsa de commit/cumulatividade. Atualizar queries de monitoramento. O enunciado exige mensagens em DLQ e transações por status, não aqueles nomes específicos. A alternativa cumulativa para redrives exigiria uma fonte operacional comprovada; não é derivada de diferenças de gauge aproximado.

Kinds/status financeiros desconhecidos viram UNKNOWN (vocabulários limitados). Gauges do banco e DLQ mantêm a última coleta bem-sucedida caso a sonda falhe; interpretar junto com readiness e disponibilidade do scrape. Não são um ledger de auditoria: reconciliação e consultas persistidas são a fonte financeira. Counters/histogramas reiniciam com o processo.

Logs operacionais não recebem valores monetários, bodies, credenciais, ReceiptHandle nem texto arbitrário de exceções. IDs e correlação permanecem metadados; nunca colocar payloads nesses campos. Liveness é independente de dependências. Readiness faz SELECT 1 e verifica filas dos componentes habilitados, com deadlines, recusando tráfego no shutdown.

Conflitos de lock PostgreSQL são contados em `operational_events_total{component="financial",operation="transaction",result="lock_conflict"}` somente para SQLSTATE 55P03, 40P01 e 40001 na cadeia de causas. A espera normal por lock que termina com sucesso não é conflito. O teste de observabilidade provoca lock_timeout real com outra conexão. Não há tracing distribuído.
