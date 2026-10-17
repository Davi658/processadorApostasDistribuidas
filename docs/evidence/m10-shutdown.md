# M10 — shutdown e cancelamento transacional

Validação local em 17/10/2026 (America/Sao_Paulo).

## Isolamento e base

- Repositório: `D:/processadorApostasDistribuidas`.
- Branch: `codex/m10-shutdown-final`.
- Worktree: `D:/processadorApostasDistribuidas/.worktrees/m10-shutdown-final`.
- Base: `d11d9f3dfccacc574158b2bc254926c75d8cc4c2`, ponta de `feat/m10-timeout-shutdown`, posterior à main `6acc7c3`.
- Inspeção inicial: checkout principal sem alterações rastreadas; somente `.worktrees/` não rastreado.
- Infra preservada em `4528b05`; M17 em `7b4484a` e `253a997`, com status limpo na inspeção final dessas worktrees.
- Nenhum push, merge, publicação ou acesso ao repositório da empresa foi realizado.

## Ambiente

- Windows, Bun 1.4.3.
- PostgreSQL 16.8 real local em 127.0.0.1:5432; bancos descartáveis via `createIsolatedTestDatabase`, migrations e papel `app_user`.
- Docker não estava operacional para esta sessão: comando ausente no PATH e `C:/Program Files/Docker/Docker/resources/bin/docker.exe` inexistente. Validação em containers não executada; testes reais executados no PostgreSQL local.

## Provas de shutdown

Seis variantes NestJS reais: `after_wallet_save`, `before_commit`, `during_flush`, `after_commit`, `lock_wait`, `query_wait`.

1. Escrita/preparação/flush pausados por promises controladas; esperas SQL confirmadas por `pg_stat_activity` (Lock ou PgSleep), sem presumir entrada por sleep.
2. `app.close()` iniciado fora do AsyncLocalStorage transacional, confirmado por asserção. Novos batches retornam zero.
3. Após 150 ms de drenagem, abort marca exatamente o contexto capturado: rollbackOnly e motivo DRAIN_TIMEOUT_EXCEEDED. No caso já confirmado, phase permanece committed e rollbackOnly false.
4. Barreira continua fechada por 60 ms após abort, além do prazo diagnóstico de cancelamento de 20 ms; app e ORM continuam abertos.
5. Lock externo mantido até terminar a execução; PostgreSQL encerra a espera com lock_timeout de 1000 ms. PgSleep(30) termina por statement_timeout de 1200 ms. Ambos encerram shutdown dentro do limite de 2500 ms verificado no teste.
6. Ordem registrada e verificada: execution-ended → orm-close. No início de close, zero transações ativas. Após close, zero novas sessões da aplicação em pg_stat_activity e zero listeners de abort.
7. Rollback preserva saldo, versão, snapshot, próxima tentativa, tentativas, ledger e outbox. Commit confirmado conserva o resultado financeiro e contabiliza processed=1.
8. Expiração controlada com clock_timestamp no PostgreSQL permite recuperação do item revertido. Saldo final 115.00, três lançamentos (OPENING, BET, WIN) e exatamente dois eventos adicionais de WIN. Segunda recuperação retorna zero e snapshot completo do estado continua igual.

Mantidos os testes anteriores de três processos concorrentes, crash após claim, crash após commit, leases obsoletos, relógio PostgreSQL, fencing e falhas antes do commit.

## Comandos e resultados

Comando final: `./docs/evidence/run-m10-validation.ps1` — **exit 0**. Executa typecheck e todos os 18 arquivos `*.test.ts` encontrados por `rg --files tests -g '*.test.ts'`, sequencialmente, em processos Bun independentes, com `--timeout 30000`. **302 testes passaram, zero falhas**, incluindo M03/M04/M05/M06/M08/M09, M10 e concorrência. Resultados estruturados: [results.json](m10-validation-logs/results.json). Saída bruta local em `m10-validation-logs/*.log` (ignorada pelo Git).

| Comando / arquivo | Exit code | Resultado |
|---|---:|---|
| `bun run typecheck` | 0 | TypeScript sem erros |
| `bun test tests/concurrency/concurrency.test.ts --timeout 30000` | 0 | 6 pass / 0 fail |
| `bun test tests/integration/http-endpoints.test.ts --timeout 30000` | 0 | 21 pass / 0 fail |
| `bun test tests/integration/migrations.test.ts --timeout 30000` | 0 | 1 pass / 0 fail |
| `bun test tests/integration/mikro-orm-uow-m05.test.ts --timeout 30000` | 0 | 18 pass / 0 fail |
| `bun test tests/integration/money-postgres-roundtrip.test.ts --timeout 30000` | 0 | 9 pass / 0 fail |
| `bun test tests/integration/pending-reference-worker-m10.test.ts --timeout 30000` | 0 | 21 pass / 0 fail |
| `bun test tests/integration/postgres-invariants.test.ts --timeout 30000` | 0 | 22 pass / 0 fail |
| `bun test tests/integration/wager-bet-replay.test.ts --timeout 30000` | 0 | 16 pass / 0 fail |
| `bun test tests/integration/wager-operations.test.ts --timeout 30000` | 0 | 8 pass / 0 fail |
| `bun test tests/integration/wager-pending-replay-m09.test.ts --timeout 30000` | 0 | 22 pass / 0 fail |
| `bun test tests/integration/wager-reversals-m07.test.ts --timeout 30000` | 0 | 28 pass / 0 fail |
| `bun test tests/integration/wager-reversals-m08.test.ts --timeout 30000` | 0 | 23 pass / 0 fail |
| `bun test tests/integration/wager-win-loss-m06.test.ts --timeout 30000` | 0 | 38 pass / 0 fail |
| `bun test tests/integration/wallet-opening.test.ts --timeout 30000` | 0 | 30 pass / 0 fail |
| `bun test tests/unit/money.test.ts --timeout 30000` | 0 | 21 pass / 0 fail |
| `bun test tests/unit/payload-hash.test.ts --timeout 30000` | 0 | 6 pass / 0 fail |
| `bun test tests/unit/wallet-ledger-entry.test.ts --timeout 30000` | 0 | 5 pass / 0 fail |
| `bun test tests/unit/wallet.test.ts --timeout 30000` | 0 | 7 pass / 0 fail |

Tentativas anteriores, preservadas nos logs locais da worktree:

- Baseline M10 na base d11d9f3: exit 0, 16 pass, 0 fail. O teste original não cobria a janela completa nem ultrapassava o segundo prazo.
- Primeiro typecheck após refatoração: exit 1 por tipo nullable da promise ativa; corrigido para `Promise<ReprocessResult>`.
- Ampliação das asserções inicialmente esperava um evento por WIN; exit 1. Ajustada para os dois eventos reais (WagerTransactionProcessed e WalletBalanceChanged); também deixou de tentar atualizar lease de item terminal.
- `bun run test`: exit 1; unitários 39 pass; integração 252 pass, 5 fail, 1 error. Falha de contagem de migrations (esperava 4, agora há 5) e testes excedendo o prazo padrão de 5 s. Concorrência não foi alcançada pelo encadeamento desse comando.
- `bun test tests/integration/pending-reference-worker-m10.test.ts tests/integration/migrations.test.ts`: exit 1, 21 pass / 1 timeout de migrations a 30 s. Migrations isolado posteriormente: exit 0, 1 pass.
- `bun test tests/unit tests/integration tests/concurrency/concurrency.test.ts --timeout 30000`: exit 1, 299 pass / 3 fail. M05 lifecycle excedeu 30 s; M10 revelou pendência residual elegível por backoff (N contabilizava dois itens) e lease de 800 ms expirando antes da barreira de flush. A suíte M10 passou a limpar pendências entre cenários e usar lease de 60 s nas barreiras, com expiração explícita pelo PostgreSQL na recuperação.
- A validação final por arquivo acima foi executada após essas correções e após trocar o wrapper assíncrono de commit pela API transacional pública do Knex (`commit()` e `executionPromise`). Não se declara que o wrapper padrão de 5 s passou nesta máquina.
- `git diff --check`: exit 0 antes do commit.

## Arquivos da entrega

- `src/application/ports/ports.ts`
- `src/application/use-cases/reprocess-pending-references.use-case.ts`
- `src/infrastructure/persistence/mikro-orm/mikro-orm-adapter.ts`
- `src/infrastructure/persistence/mikro-orm/mikro-orm.config.ts`
- `src/infrastructure/workers/pending-reference-worker.service.ts`
- `tests/integration/pending-reference-worker-m10.test.ts`
- `tests/integration/migrations.test.ts` (cobertura UP/DOWN da migration 005 do M10)
- `ARCHITECTURE.md`
- `IMPLEMENTATION.md`
- `docs/evidence/m10-shutdown.md`
- `docs/evidence/run-m10-validation.ps1`
- `docs/evidence/m10-validation-logs/results.json`


## Limites do contrato

- AbortController marca intenção; os limites aplicados pelo PostgreSQL interrompem SQL. Padrões: lock_timeout 5000 ms, statement_timeout 10000 ms, drenagem 5000 ms, diagnóstico de cancelamento 5000 ms.
- Limites SQL são por instrução; não há promessa de prazo global rígido para código JavaScript que não coopera. Nesse caso o shutdown continua aguardando, preservando o ORM até o término.
- Depois do envio de COMMIT, aguarda-se o resultado real; cancelamento tardio não declara rollback de commit confirmado. Falha de transporte com resultado desconhecido não equivale a confirmação; idempotência e estado persistido continuam necessários na retomada.
- Infraestrutura, M17, SQS, inbox e publisher não foram alterados.
