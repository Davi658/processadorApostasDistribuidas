# M11 — validação integrada e adendo sobre DOWN

## Base e isolamento

- Data: 17/10/2026, America/Sao_Paulo.
- Repositório pessoal consultado: https://github.com/Davi658/processadorApostasDistribuidas.git.
- Base exata: 58c124e0d97af35244de1cf2db4da826c1aa587c, obtida por git fetch origin main (exit 0).
- Essa base contém M10 final, M17 final (52bfa20, integrado por 7c2cf20) e M11 (2ce1f3d, integrado por 58c124e).
- Branch: codex/m11-integrated-validation.
- Worktree: D:/processadorApostasDistribuidas/.worktrees/m11-integrated-validation, criada com git worktree add .worktrees/m11-integrated-validation -b codex/m11-integrated-validation origin/main (exit 0).
- Checkout principal preservado em d11d9f3, sem alterações rastreadas; diretório .worktrees/ já não rastreado. Demais branches e worktrees preservadas. A main local não recebeu merge nem atualização do checkout.
- Nenhum push, merge, publicação ou acesso ao repositório da empresa. Somente leitura do remoto pessoal explicitamente solicitado.

## Escopo e histórico

Os 327 testes da execução anterior de M11 pertencem à base a47d1e2039e3e6267a910fd9331e342a8c013cb2, anterior à finalização de M17. Não são evidência da composição em 58c124e. Os resultados desta execução são apresentados separadamente abaixo e no JSON associado, extraídos do comando oficial, sem ajustar a contagem esperada.

Esta entrega altera somente documentação e evidências. Código de produção, testes, runner e migrations históricas, incluindo 006 UP e DOWN, são preservados.

## Migration 006 e reversibilidade

O DOWN de 006 restaura a implementação anterior, incluindo a referência inválida a observed_balance e o trigger somente de UPDATE. Portanto, remove as garantias M11 e não representa uma configuração operacional saudável. A operação normal deve manter 006 aplicada.

O teste terminal-protection-m11.test.ts exercita UP/DOWN/UP com linhas PROCESSED, REJECTED e FAILED. No DOWN, comprova a ausência de observed_balance no schema e reproduz SQLSTATE 42703 numa atualização operacional; no novo UP, compara as linhas completas e prossegue com a matriz terminal. O ensaio comprova reversibilidade sem perda de dados, sem demonstrar um procedimento de rollback operacional seguro. Nenhuma migration foi reescrita.

## Ambiente e execução

Windows NT 10.0.19045.0 x64, Bun 1.4.3 e PostgreSQL 16.8 real. O runner oficial descobre recursivamente .test.ts e inicia um processo Bun por arquivo, com o timeout existente de 30000 ms e os limites explícitos dos testes preservados. Bancos são descartáveis por arquivo, com migrations administrativas e papel app_user restrito, sem superusuário, BYPASSRLS, CREATEDB ou CREATEROLE.

A conexão inicial a 127.0.0.1:5432 funcionou, mas o primeiro bun run test encontrou ECONNREFUSED: 21 arquivos executados, 16 arquivos falhos e exit 1. O runner continuou após falhas. O cluster compartilhado iniciou recuperação automática e respondeu 57P03; pg_ctl start retornou 1 por exceder o prazo de espera. As falhas e o log original foram preservados, sem ocultar erros ou alterar testes.

Para a repetição foi criado um cluster exclusivo em .data/m11-integrated-pg, porta 55412, com os binários locais já instalados. initdb --no-sync (exit 0) omitiu somente o flush inicial de instalação do cluster descartável. Durante as provas, consultas reais confirmaram fsync=on, synchronous_commit=on e full_page_writes=on; esses parâmetros não foram afrouxados. pg_ctl start do cluster exclusivo retornou 0.

Não foram utilizados Docker, Compose, WSL ou Linux; esses ambientes não estão validados por esta execução. A instalação desses componentes no host não foi alterada.

## Comandos e resultados

Resultado integrado real: **333 testes aprovados, 0 falhas, em 21 arquivos**, por descoberta e execução do runner oficial. **Exit 0**. M11: 9/9; M10: 21/21; M17 final: 21/21. M11 teve 672 assertions, incluindo UP/DOWN/UP sem perda de dados e triggers ativos. A contagem antiga de 327 permanece restrita à base a47d1e2.

| Comando | Exit | Resultado |
| --- | ---: | --- |
| git fetch origin main | 0 | Base 58c124e confirmada no remoto pessoal |
| git worktree add .worktrees/m11-integrated-validation -b codex/m11-integrated-validation origin/main | 0 | Worktree própria |
| bun run typecheck | 0 | Sem erros TypeScript |
| bun run test — primeiro run, porta 5432 | 1 | 16 arquivos falhos; ECONNREFUSED e teardown após preparação incompleta |
| bun run test — primeiro run exclusivo, porta 55412 | 1 | 2 arquivos falhos; timeout do hook HTTP e asserção de tempo M10 |
| bun run test — run final completo, porta 55412 | 0 | 333 pass / 0 fail, 21 arquivos |
| git diff --check | 0 | Sem erros de whitespace |

Para reproduzir o comando oficial em PowerShell, com PostgreSQL real disponível e papel app_user configurado:

```powershell
$env:APP_DB_HOST='127.0.0.1'
$env:MIGRATION_DB_HOST='127.0.0.1'
$env:APP_DB_PORT='55412'
$env:MIGRATION_DB_PORT='55412'
bun run typecheck
bun run test
```

| Arquivo executado | Exit | Passaram | Falharam |
| --- | ---: | ---: | ---: |
| tests/concurrency/concurrency.test.ts | 0 | 6 | 0 |
| tests/integration/http-endpoints.test.ts | 0 | 21 | 0 |
| tests/integration/m17-read-endpoints.test.ts | 0 | 21 | 0 |
| tests/integration/migrations.test.ts | 0 | 1 | 0 |
| tests/integration/mikro-orm-uow-m05.test.ts | 0 | 18 | 0 |
| tests/integration/money-postgres-roundtrip.test.ts | 0 | 9 | 0 |
| tests/integration/pending-reference-worker-m10.test.ts | 0 | 21 | 0 |
| tests/integration/postgres-invariants.test.ts | 0 | 22 | 0 |
| tests/integration/terminal-protection-m11.test.ts | 0 | 9 | 0 |
| tests/integration/wager-bet-replay.test.ts | 0 | 16 | 0 |
| tests/integration/wager-operations.test.ts | 0 | 8 | 0 |
| tests/integration/wager-pending-replay-m09.test.ts | 0 | 22 | 0 |
| tests/integration/wager-reversals-m07.test.ts | 0 | 28 | 0 |
| tests/integration/wager-reversals-m08.test.ts | 0 | 23 | 0 |
| tests/integration/wager-win-loss-m06.test.ts | 0 | 38 | 0 |
| tests/integration/wallet-opening.test.ts | 0 | 30 | 0 |
| tests/unit/money.test.ts | 0 | 21 | 0 |
| tests/unit/payload-hash.test.ts | 0 | 6 | 0 |
| tests/unit/test-runner.test.ts | 0 | 1 | 0 |
| tests/unit/wallet-ledger-entry.test.ts | 0 | 5 | 0 |
| tests/unit/wallet.test.ts | 0 | 7 | 0 |

Os exits por arquivo são confirmados pelo contrato do runner: ele soma qualquer erro de spawn, sinal ou status não zero; o resumo final foi 21 files; 0 failed. Resultados, assertions, sumários de duração, descoberta, ambiente e hashes dos logs estão em [m11-integrated-validation-results.json](m11-integrated-validation-results.json).

Log final local: m11-integrated-test-approved.log, SHA-256 7d77bfaf389a7a477e254ea71076ef7337f2fa01ab1621295657d017c4326974. Logs originais m11-integrated-test.log e m11-integrated-test-final.log permanecem preservados e têm seus resultados por arquivo e hashes registrados no JSON. Logs são ignorados pelo Git; os sumários estruturados são versionados.

## Falhas intermediárias e limites

No primeiro run exclusivo, HTTP excedeu o timeout do hook; em M10 lock_wait, a ordem execution-ended antes de orm-close passou, mas o encerramento levou 3305 ms frente à asserção existente de menos de 2500 ms. Nenhuma asserção foi removida ou reduzida, e nenhum timeout de teste foi ampliado. A tentativa de inicialização do cluster compartilhado, iniciada nesta tarefa e ainda sem aceitar conexões, continuava fazendo sincronização de arquivos; stop fast excedeu o prazo (exit 1). Foi encerrada somente essa inicialização, com PID e estado conferidos, por stop immediate (exit 0), preservando arquivos e WAL para recuperação posterior. O cluster original não foi removido; permanece parado.

O run final repetiu todos os arquivos e passou sem qualquer alteração em src, tests, scripts, package.json ou migrations. A aprovação não depende de omitir o arquivo HTTP ou o cenário M10 que falharam antes. A causa dos atrasos do host não foi determinada além dos estados de conexão/recuperação e da sincronização observados; não se atribui o problema à instalação de Docker/WSL.

A prova cobre a composição exata 58c124e em Windows/PostgreSQL. Não valida containers, Linux, mensageria, publisher ou inbox. A operação normal exige migration 006 aplicada; DOWN não é uma configuração operacional saudável.


## Limpeza

Antes do encerramento, pg_database continha somente postgres, template0 e template1: nenhum banco de teste remanescente. O cluster exclusivo foi encerrado por pg_ctl stop -m fast (exit 0) e removido após conferir o caminho absoluto exato dentro da worktree e a ausência de postmaster.pid (exit 0). Logs e evidências foram preservados. O cluster original permanece parado, com dados e WAL preservados para recuperação posterior.
