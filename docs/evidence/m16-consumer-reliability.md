# M16 — entrega e evidências

M16 comprovado com PostgreSQL 16.6, LocalStack 4.0.3, Bun 1.4.3 e SDK SQS 3.1152.0. Windows e Linux executados sequencialmente em infraestrutura exclusiva. Não houve push, merge, publicação, operação em repositório da empresa ou alteração de serviços/volumes preexistentes.

## Proveniência

- Base obtida por `git fetch origin main`: `ce23c14cd8a277b1e2308c3ff85fc1562c0f701d`; inclui M15 `cba6b6c`.
- Branch: `codex/m16-sqs-reliability`.
- Worktree: `D:\processadorApostasDistribuidas\.worktrees\m16-sqs-reliability`.
- O SHA final é informado na entrega da conversa, sem autorreferência neste documento.

## Resultado final

| Comando | Windows | Linux |
| --- | --- | --- |
| `bun run typecheck` | exit 0 | exit 0 |
| `bun run scripts/run-tests.ts tests/integration/sqs-consumer-m16.test.ts` | exit 0: 11 pass, 1 skip Linux | exit 0: 12 pass |
| `bun run test` | exit 0: 30 arquivos, 482 pass, 1 skip Linux | exit 0: 30 arquivos, 483 pass |
| `bun run scripts/m15-financial-smoke.ts` | exit 0, reconciliação consistente, diff=0.00 | exit 0, reconciliação consistente, diff=0.00 |

A suíte oficial inclui regressões financeiras, M05/UoW, M10, M14, M15 e M16. A fixture M15 passou a provisionar sua própria DLQ FIFO e aguardar bootstrap assíncrono. Nenhuma asserção ou prazo existente foi reduzido/removido/ampliado. Nenhuma migration foi necessária.

Manifests com comandos, horários UTC, exit codes, resumos e hashes dos logs: [Windows](m16/win32/results.json), [Linux](m16/linux/results.json). Mantêm também as tentativas anteriores com falha; o último resultado de cada comando é o resultado final. O relatório de [investigação](m16/INVESTIGATION.md) explica inicialização fria, premissas corrigidas nas fixtures, timeout da prova nova de publisher e incompatibilidade da fixture M15 sem redrive.

Os audits [Windows](m16/win32/broker-financial-audit.json) e [Linux](m16/linux/broker-financial-audit.json) registram IDs de linhas, hashes de estados completos, atributos/ARNs de redrive, hashes idênticos de comando original e corpo recebido na DLQ, cancelamento de long polling e zero UoWs ativas antes do fechamento. Linux registra PIDs reais, `signalCode=SIGTERM`, cancelamento observado e drenagem anterior ao fechamento nos cortes before_commit e after_commit. Não contêm corpos, payloads financeiros, credenciais nem ReceiptHandles.

## Implementação

O [contrato operacional M16](../messaging/M16-RELIABILITY.md) contém a política de resultados, parâmetros, limites de rede/visibilidade, redrive nativo, ownership e mapa A–K das provas. Inbox, processamento financeiro e worker de referências mantêm suas responsabilidades. O ajuste compartilhado mínimo na UoW preserva COMMIT despachado e marca confirmação perdida como commit_unknown, com regressão em PostgreSQL real e redelivery SQS.

Arquivos alterados/criados:

- `.env.example`, `package.json`: parâmetros de transporte e comando test:m16.
- `src/application/messaging/consume-wager-command.ts`: AbortSignal na UoW externa.
- `src/infrastructure/messaging/sqs-wager-consumer.service.ts`: classificação, backoff por receive count, renovação finita sequencial, validação de redrive e drenagem/cancelamento seguro.
- `src/infrastructure/persistence/mikro-orm/mikro-orm-adapter.ts`: resultado desconhecido de COMMIT sem declaração indevida de rollback.
- `tests/integration/sqs-consumer-m16.test.ts`, `tests/concurrency/consumer-shutdown-m16-runner.ts`, `tests/unit/sqs-consumer-policy-m16.test.ts`: provas reais e classificação/limites.
- `tests/integration/sqs-inbox-m15.test.ts`: somente preparação/limpeza da DLQ e await do bootstrap, preservando asserções e deadlines.
- `scripts/m16-validation.ts`: execução sequencial, manifest de todas as tentativas e logs locais com hashes.
- `docs/messaging/M15-IMPLEMENTED.md`, `docs/messaging/M16-RELIABILITY.md`: evolução do contrato.
- Este relatório, manifests, audits e investigação em `docs/evidence/m16/`.

## Comandos de infraestrutura e reprodução

A [receita](../messaging/M16-RELIABILITY.md#reproduce-with-exclusive-services) registra os parâmetros Windows. Foram criados apenas `wagers-m16-postgres-1`, `wagers-m16-localstack-1`, rede `wagers-m16_default` e volume `wagers-m16_local_pgdata`, com portas locais 54316/45616. A criação foi feita por `docker compose -f docker-compose.local.yml up -d postgres localstack`, com COMPOSE_PROJECT_NAME=wagers-m16.

Após a validação Windows, a imagem Linux foi construída com `docker build --target tester -t wagers-m16-tester:bun-1.4.3 .` (exit 0), instalando `bun.lock` com --frozen-lockfile. Digest da imagem: `sha256:0818d6960a087643cd06ac7bbda5fe62fd5f0fdb3da2848ce36204dc92c1a246`.

```powershell
docker run --rm --name wagers-m16-linux-validation --user 0:0 --network wagers-m16_default --mount 'type=bind,source=D:\processadorApostasDistribuidas\.worktrees\m16-sqs-reliability\docs\evidence\m16,target=/app/docs/evidence/m16' -e APP_DB_HOST=postgres -e APP_DB_PORT=5432 -e APP_DB_PASSWORD=local_runtime_only -e MIGRATION_DB_HOST=postgres -e MIGRATION_DB_PORT=5432 -e MIGRATION_DB_USER=migration_user -e MIGRATION_DB_PASSWORD=local_migration_only -e SQS_ENDPOINT=http://localstack:4566 wagers-m16-tester:bun-1.4.3 bun run scripts/m16-validation.ts
```

Esse container executou typecheck, M16, oficial e smoke em sequência e terminou com exit 0. O domínio executou com o usuário de banco restrito app_user; root do container é usado para escrever o diretório de evidências montado.

Antes do teardown, `pg_stat_activity` confirmou zero client backends além da conexão de inspeção. A remoção usa exclusivamente `docker compose -p wagers-m16 -f docker-compose.local.yml down --volumes`; estado final em [resources.json](m16/resources.json). A imagem de testes permanece local para reprodução.

## Limitações

A prova usa LocalStack real e PostgreSQL real, sem chamada a AWS de produção e sem soak de 12 horas. A janela SQS finita é respeitada pelo código, com margem de rede; visibilidade não substitui inbox/locks/idempotência. Configuração de redrive continua pertencendo à fila. Operação/reenvio da DLQ é manual e não foi implementada. M18 não foi integrado. Logs brutos ficam locais e ignorados por Git; os manifests conservam resumos/hashes e o histórico de falhas investigadas.
