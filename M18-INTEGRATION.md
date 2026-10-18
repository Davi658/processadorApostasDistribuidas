# M18 — Logs, métricas e health

Status: **CONCLUÍDO**, com provas Windows e Linux em `docs/evidence/m18/RESULTS.md`.

Base: `cf90a10571d2966643b9ac6287658a22e6f66efa` (origin/main atualizada em 2026-10-18, contém M16 `ab600b4`). Branch `codex/m18-final`, worktree `D:\processadorApostasDistribuidas\.worktrees\m18-final`.

## Composição implementada

O AppModule principal registra o middleware e os endpoints `/health/live`, `/health/ready` e `/metrics`, sem prefixo global. ObservabilityModule fornece uma única instância HttpObservability por aplicação, reutilizada por HTTP, publisher, consumidor e referências. PersistenceModule continua sendo o proprietário do UoW/pool; as sondagens SQS usam os clientes já pertencentes aos componentes. Os casos de uso dependem de uma porta de observação opcional, sem implementação paralela nem alteração das transações financeiras.

## Logs e correlação

Cada evento operacional é uma linha JSON com component, operation, result, durationMs e correlationId. HTTP acrescenta method, route normalizada e status; mensageria acrescenta somente eventId/commandId/transactionId quando disponíveis. Sem payloads, valores, saldos, headers completos, ReceiptHandles, erros ou stacks brutos. Falhas usam resultados de vocabulário fechado; falha no sink não altera efeitos financeiros. O diagnóstico já persistido por M14 em outbox.last_error mantém seu contrato anterior; esse campo nunca é emitido em logs ou métricas.

HTTP usa x-correlation-id aparado, depois Idempotency-Key aparada, depois null. Entradas acima de 255 caracteres não são copiadas para logs. O consumidor usa correlationId validado do comando, com fallback na idempotencyKey. O publisher usa a correlação persistida no envelope. Abertura de carteira gera sua própria correlação; não há promessa de vínculo com o log HTTP sem header.

**Limitação histórica explícita:** wager_transactions não persiste a correlação original para reprocessamento tardio. O worker preserva a geração de novas correlações de resolução e a causalidade existente, e registra correlationId null com transactionId técnico. Isso não representa correlação ponta a ponta; nenhum registro terminal, hash, snapshot, inbox ou envelope histórico é reescrito.

## Métricas Prometheus

`http_requests_total` e `http_request_duration_seconds` preservam o formato text 0.0.4 e os buckets existentes. Labels method/route/status usam templates Express; UUIDs e URLs concretas não viram séries. 404 sem rota usa `__unmatched__`, métodos desconhecidos usam OTHER. Requisições abortadas antes de finish não contam como respostas concluídas.

`operational_events_total{component,operation,result}` usa vocabulários fechados tipados:

- Publisher: send/attempt, send/broker_confirmed e mark/local_confirmed são estágios distintos. validation/blocked, validation ou mark/stale_lease e publish/failure indicam os resultados observados. Não representa entrega ao consumidor.
- Consumidor: receive/received, receive/failure, inbox/accepted ou duplicate após confirmação da transação, transaction/durable e delete/confirmed. processing/delete com TRANSIENT, PERMANENT ou UNKNOWN distingue a etapa que falhou. renewal/confirmed ou failure e retry_visibility/failure observam a posse. delivery/redelivery_observed significa ApproximateReceiveCount maior que um; não implica chegada à DLQ. O consumidor não sonda a DLQ, portanto não expõe contador de chegada inventado.
- Referências: reprocess/processed, rejected, rescheduled e blocked são emitidos somente depois do commit; claimed não é resultado financeiro confirmado. stale_lease, aborted, transient_failure, unexpected_failure e lifecycle/failure são operacionais.

Todos os contadores são locais ao processo, reiniciados no restart. Agregação e taxas entre réplicas pertencem ao coletor Prometheus. Nenhum saldo, valor financeiro ou identificador em labels. Duração zero representa evento instantâneo de estágio; durações das operações concluídas são medidas pelo relógio monotônico. Um resultado durável de consumidor inclui rejeição ou pendência persistida, e não significa movimento no ledger.

## Health e shutdown

Liveness responde 200 sem acessar dependências. Readiness faz SELECT 1 e GetQueueAttributes apenas nas filas dos componentes habilitados: eventos quando OUTBOX_PUBLISHER_ENABLED, comandos quando SQS_CONSUMER_ENABLED. O worker de referências requer apenas PostgreSQL. Não testa saúde enviando, recebendo, apagando mensagens nem alterando visibilidade. Não exige fila de eventos para aplicação apenas HTTP.

Deadline HTTP de 500 ms; no máximo uma rodada de sondagens pendente por instância. Requisições concorrentes compartilham essa rodada; allSettled retém a rodada até todas as dependências terminarem, inclusive quando uma falha primeiro. SQS tem abort de até 500 ms. Aquisição e conexão PostgreSQL têm limites de 1000 ms e as consultas têm timeout/cancelamento. O timeout HTTP não fecha recursos para cancelar trabalho. O hook OnModuleDestroy marca stopping antes de aguardar sondagens; readiness retorna 503 durante drain, e ORM/clientes fecham nas fases posteriores existentes. Resposta indisponível é somente `{status: "unavailable"}`.

`infra/healthcheck.ts` testa readiness com deadline externo de 2 s. Portanto a saúde do contêiner representa disponibilidade das dependências habilitadas. Para reinício por falha do processo, configure separadamente liveness no orquestrador.

## Reprodução exclusiva

`infra/m18-validation.compose.yml`, projeto `wagers-m18-final`, usa PostgreSQL 16.6 e LocalStack 4.0.3, portas locais 55448 e 45628. Dados PostgreSQL ficam em tmpfs; não usa volumes ou filas preexistentes.

```powershell
docker compose -p wagers-m18-final -f infra/m18-validation.compose.yml up -d --wait postgres localstack
docker compose -p wagers-m18-final -f infra/m18-validation.compose.yml exec -T postgres psql -U postgres -c "CREATE ROLE app_user LOGIN PASSWORD 'app_user_secret';"
./scripts/m18-validate.ps1
```

Crie o role somente na primeira inicialização. O script executa sequencialmente typecheck, suíte M18, suíte oficial, build e smoke financeiro, registrando exit codes. Os testes criam bancos e filas UUID exclusivos e removem somente esses recursos. Para Linux, compile o target tester e execute `bun run scripts/m18-validate.ts` no serviço tester, com rede exclusiva e sem publicação de portas adicional. O contêiner descartável de validação usa root para gravar docs e .data em /app; o runtime de produção preserva USER bun. O bundle usa `--packages=external`, conservando as dependências instaladas no runtime, e o smoke financeiro usa o AppModule fonte real. Consulte `docs/evidence/m18/RESULTS.md` para resultados efetivamente obtidos e limitações.

## Flake 57P01

Reproduzido no teardown do teste M18: pg.Pool.end() pode concluir a remoção dos clientes do pool antes de todos os sockets emitirem end; DROP DATABASE WITH (FORCE) encerrava um cliente administrativo ainda fechando, gerando erro assíncrono sem listener. O teste agora acompanha os clientes e aguarda end antes de DROP DATABASE sem FORCE. Mantém a prova de indisponibilidade real com término das sessões ORM e recuperação. Não instala handlers globais nem ignora erros de produção.
