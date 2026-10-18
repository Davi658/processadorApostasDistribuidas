# M18 — integração pendente

Status: **PARCIALMENTE IMPLEMENTADO**. Base HTTP/health validada isoladamente. Não registrada na aplicação principal; mensageria não implementada nem validada. Nenhuma alteração ou instrumentação de M14.

Base local: main, f73e308a94cf18a366021a4e44c70334ea65d47c.
Branch: codex/m18-observability.
Worktree: D:\processadorApostasDistribuidas\.worktrees\m18-observability.

## Contratos consultados

README.md, ARCHITECTURE.md, IMPLEMENTATION.md, package.json, main.ts, AppModule, HttpValidator, ProcessWagerUseCase, DomainExceptionFilter, configuração MikroORM, MikroOrmUnitOfWork, migrations e testes HTTP/banco existentes. Nenhum acesso ao repositório da empresa. Não foi encontrado arquivo local separado do desafio nem exigência explícita de formato de métricas nesses documentos; a base oferece exposição Prometheus text 0.0.4 sem dependência nova.

Correlação: header x-correlation-id aparado, com fallback para Idempotency-Key aparada, conforme ProcessWagerUseCase. Sem ambos, correlationId é null no log. Não gera outro ID nem modifica headers, DTOs, causalidade ou outbox. A criação de carteira gera sua correlação internamente; relacionar esse ID ao log HTTP exigirá um contrato explícito futuro, sem alteração neste marco.

## Composição exata a aplicar futuramente

No módulo que já declara MikroOrmUnitOfWork (atualmente AppModule):

```ts
import { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { HttpObservability } from '../../infrastructure/observability/http-observability';
import { ObservabilityController, PostgresReadiness } from '../../infrastructure/observability/observability.controller';

// Acrescentar ObservabilityController ao array controllers existente.
// Acrescentar estes dois providers ao array providers existente:
{ provide: HttpObservability, useFactory: () => new HttpObservability() },
{
  provide: PostgresReadiness,
  useFactory: (uow: MikroOrmUnitOfWork) => new PostgresReadiness(uow, 500),
  inject: [MikroOrmUnitOfWork],
},

// Substituir somente a declaração vazia da classe do módulo por:
export class AppModule implements NestModule {
  constructor(private readonly http: HttpObservability) {}
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(this.http.middleware).forRoutes('{*path}');
  }
}
```

Manter os providers financeiros existentes e o filtro global. Usar uma instância HttpObservability por aplicação e o UoW já existente, sem criar outro pool. O sink padrão escreve cada evento como uma linha JSON em stdout; se substituído, deve aceitar a linha sem serializar request/response/erro. Aplicar o middleware antes das rotas para observar também falhas. Testar a composição definitiva com os controllers reais e o filtro existente; esta etapa permanece pendente. Não é necessária alteração de main.ts, package.json ou lockfile. Se houver prefixo global, os endpoints de observabilidade herdarão esse prefixo; definir o contrato operacional antes de integrar.

Endpoints: GET /health/live (200 sem acessar banco), GET /health/ready (SELECT 1 real, 200 ou 503 com apenas {status: 'unavailable'}), GET /metrics (text/plain; version=0.0.4). Não habilitar worker/publisher para esses testes isolados.

Readiness usa Knex do MikroORM existente, timeout de query com cancelamento PostgreSQL e deadline HTTP finito, inclusive quando a aquisição do pool demora. Há no máximo uma consulta pendente por instância; chamadas concorrentes compartilham essa consulta, sem enfileirar novas sondagens. Configurar também acquireTimeoutMillis finito no pool principal na integração (por exemplo 1000 ms), pois o deadline HTTP não cancela uma aquisição já aguardando no Knex. O shutdown continua pertencendo exclusivamente ao UoW existente.

## Logs e métricas

Allowlist dos logs: correlationId, method, route, status, durationMs. Registra ao concluir a resposta, com status final; não registra payloads, resposta, query string, path concreto, headers completos ou exceções. Requisições abortadas antes de finish não entram nos contadores de respostas concluídas.

Métricas: http_requests_total e histograma http_request_duration_seconds, labels method/route/status. route vem do template Express (por exemplo /probe/:id), sem IDs nem query. 404 usa __unmatched__, métodos desconhecidos usam OTHER. Nenhum ID de correlação, idempotência, carteira ou jogador em labels. Buckets em segundos: .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, +Inf. Registro em memória por processo; agrega-se externamente entre réplicas. O scrape de /metrics aparece no próximo scrape. Sem métricas financeiras fictícias.

## Mensageria futura — não concluída

- Publisher M14: integrar depois da estabilização exclusiva pelo Antigravity. Pontos futuros: tentativas, duração, falhas e resultado confirmado de envio; labels com categorias limitadas, sem eventId/correlationId/messageId. Não contar tentativa como entrega confirmada.
- Consumidor: observação no recebimento, resultado pós-commit, duplicatas/inbox, falhas e duração; propagação da correlação canônica. Não inferir sucesso antes do commit ou confirmação de ack/delete.
- SQS: resultado de send/receive/delete, retries, visibilidade e DLQ. Nomes de fila devem vir de configuração limitada, nunca de entradas por mensagem; nenhum payload ou receipt handle nos logs. Idade e backlog somente de medições reais. Provas de retry, redelivery, DLQ e shutdown são pendentes.

## Reprodução isolada, sem Docker

Usar binários nativos já instalados e diretório exclusivo desta worktree. Confirmar porta 55438 livre antes de iniciar. Não usar scripts/db-start.ps1 nem a suíte completa, pois apontam para recursos compartilhados.

```powershell
Set-Location D:\processadorApostasDistribuidas\.worktrees\m18-observability
$pgBinM18 = "$env:USERPROFILE\.pgsql\pgsql\bin"
& "$pgBinM18\initdb.exe" -D "$PWD\.data\m18-pg" -U postgres -A trust -E UTF8
& "$pgBinM18\pg_ctl.exe" -D "$PWD\.data\m18-pg" -l "$PWD\.data\m18-pg.log" -o '-h 127.0.0.1 -p 55438' -w start
bun run typecheck
bun test tests/observability/m18-http.test.ts
& "$pgBinM18\pg_ctl.exe" -D "$PWD\.data\m18-pg" -m fast -w stop
```

Inicializar apenas na primeira execução. Cluster descartável .data/m18-pg ignorado pelo Git; cada execução cria m18_observability_<pid>, aplica migrations existentes e remove a base em finally. Não usar esse cluster fora do desenvolvimento local. Dependências foram resolvidas pelo node_modules já disponível no repositório pai, sem instalação ou alteração de manifests.

## Resultados reais

- bun run typecheck: PASSOU.
- bun test tests/observability/m18-http.test.ts: 4 testes passaram, 0 falharam.
- Nest real com porta HTTP dinâmica; PostgreSQL nativo 16, porta 55438 exclusiva.
- Logs allowlist com correlação explícita/fallback, payload financeiro e credenciais ausentes; 13 UUIDs na mesma série normalizada, erros 422 e 404 observados.
- SELECT 1 bem-sucedido; pool saturado retorna 503 dentro do limite e recupera; ALLOW_CONNECTIONS false + término das sessões ORM comprova indisponibilidade real e resposta genérica. Liveness permanece 200.
- Snapshot integral de wallets (com saldo de fixture), wager_transactions, wallet_ledger_entries e outbox_messages preservado; zero transações financeiras abertas; app.close fecha o ORM e pg_stat_activity confirma zero conexões da aplicação.
- Falhas intermediárias corrigidas antes da validação final: tipagem da variável snapshot; ALTER DATABASE precisa executar pela conexão de manutenção, não pelo próprio banco alvo.

Pendências para concluir M18: aplicar composição, validar em aplicação principal, alinhar eventual contrato externo do desafio e implementar/validar observabilidade de publisher, consumidor e SQS.
