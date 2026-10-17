# M12 — Ledger e Constraints

## Base e isolamento

17/10/2026, America/Sao_Paulo. Base `6a85ab1f7c921b77b4f82cbe2dcd0896394b1ac9`, confirmada com `git fetch origin main` no remoto pessoal `https://github.com/Davi658/processadorApostasDistribuidas.git`. Branch `codex/m12-ledger-constraints`, worktree `D:/processadorApostasDistribuidas/.worktrees/m12-ledger-constraints` criada a partir de origin/main. Checkout principal e demais entregas preservados. Sem push, merge, publicação ou operações no repositório da empresa.

## Auditoria e diagnóstico

Foram inspecionados schema/migrations 001–006, entidade WalletLedgerEntry, mapeamento ORM de NUMERIC como string, repositórios MikroORM de carteira/transação/ledger, adaptador legado PostgreSQL (reexporta MikroORM), consulta M17 e ReconcileWalletUseCase. Os testes existentes de Money, abertura, UoW, operações, reversões, replay, worker, terminais e concorrência foram mantidos.

| Garantia já implementada | Responsável | Prova complementar M12 |
| --- | --- | --- |
| Transação/carteira/moeda exatas | fk_ledger_wager_tx_wallet_currency | 23503 específico, inclusive carteira USD válida com transação BRL válida, sem duplicação que mascare a FK |
| Referências inexistentes | wallet_ledger_entries_transaction_id_fkey / wallet_ledger_entries_wallet_id_fkey | 23503 e nome exato |
| Magnitude estritamente positiva | chk_ledger_positive_amount | 23514 para zero/negativo |
| CREDIT soma / DEBIT subtrai | chk_ledger_arithmetic | 23514 específico para ambos e tipo desconhecido; centavo exato no limite NUMERIC |
| Saldos não negativos | chk_ledger_non_negative_balances / chk_wallets_balance_non_negative | 23514 específico |
| Capacidade de cada coluna | NUMERIC(18,2) | 22003 para overflow de amount/before/after e carteira |
| No máximo um lançamento por transação/carteira | uq_wallet_ledger_entries_tx_wallet + FK composta | 23505 específico |
| Imutabilidade UPDATE/DELETE | trg_protect_wallet_ledger_entries | Administrador, trigger ativo O, P0001 e mensagem específica; não depende da permissão do app |
| UPDATE/DELETE/TRUNCATE pelo app recusados | Privilégios de app_user | 42501 e tabela; app sem superusuário, CREATEDB, CREATEROLE ou BYPASSRLS |

Cada recusa da matriz M12 ocorre em uma transação com escrita anterior em wallets. O teste confirma o erro esperado, estado abortado 25P02, ROLLBACK e igualdade dos snapshots completos das quatro tabelas financeiras/de eventos. Triggers não são desativados. O teste de migração também compara linhas completas, não apenas contagens.

Duas lacunas reais motivaram correções:

1. Reconciliação acumulava Money limitado a uma coluna em cada passo. Mesmo com histórico de saldos válido `0 -> MAX -> 0 -> MAX`, o desempate por UUID no mesmo timestamp pode ordenar CREDIT/CREDIT/DEBIT e causar MONEY_OVERFLOW antes do total final. O teste de regressão reproduziu isso: `m12-target-red.log`, 15 pass / 1 fail. A soma usa agora bigint e strings decimais no relatório, preservando limites e implementação de Money. Testes cobrem zero entradas, diferenças de um centavo acima de 2^53, giro alto e totais/deltas assinados fora da capacidade de uma coluna.
2. PostgreSQL aceita NaN em NUMERIC(18,2); NaN compara acima de valores finitos e é igual a NaN. Por isso os checks antigos de magnitude, saldos e aritmética aceitavam lançamentos e saldo NaN. A reprodução está em `m12-nan-red.log`: as três recusas esperadas não ocorriam. A migration incremental 007 adiciona chk_ledger_finite_values e chk_wallets_balance_finite. UP/DOWN/UP preserva dados válidos; uma linha legada NaN faz UP retornar 23514/chk_ledger_finite_values, mantendo registros, catálogo de constraints e schema_migrations sem aplicação parcial. O banco inteiro dessa prova é descartado; nenhum registro é removido para fazer o UP passar. DOWN reabre a lacuna de NaN.

O primeiro ensaio de desenvolvimento (`m12-target-before.log`) teve erros nas fixtures: parâmetro UUID reutilizado como varchar sem cast e LOSS com referência proibida pelo contrato. Foram corrigidos nos testes antes da reprodução financeira. `m12-nan-red.log` inclui também a expectativa da migration 007 ainda não implementada. Esses ensaios não são resultados de aprovação.

## Fronteira das garantias

O banco não exige existência de ledger para toda transação PROCESSED, continuidade de saldos entre linhas, igualdade entre saldo da carteira e soma do ledger, nem igualdade de tipo/valor/status da operação com o lançamento. Processadores e UoW mantêm esses vínculos sob lock da carteira e transação SQL única. Testes de SQL direto comprovam divergências aceitas pelos checks, detectadas pela reconciliação. Totais que coincidam não certificam completude histórica ou ausência de erros compensados.

TRUNCATE é proibido ao papel restrito, sem trigger contra administrador. Proprietários/superusuários que alterem privilégios/triggers ficam fora dessa garantia. NUMERIC arredonda casas excedentes; rejeição de formato não canônico pertence ao contrato Money. Transações financeiras continuam com os limites persistíveis existentes; somente os agregados/deltas do relatório podem excedê-los.

## Ambiente e comandos

Windows x64, Bun 1.4.3, PostgreSQL 16.8 real. Cluster exclusivo `.data/m12-pg`, 127.0.0.1:55413, com bancos descartáveis por suíte, migrations reais e app_user restrito. Nenhum cluster com dados do usuário foi iniciado, parado, reconfigurado ou usado na preparação. `initdb --no-sync` omitiu apenas a sincronização inicial de instalação; consultas confirmaram fsync=on, synchronous_commit=on e full_page_writes=on durante os testes.

| Comando | Exit | Resultado |
| --- | ---: | --- |
| git fetch origin main | 0 | Base remota 6a85ab1 |
| git worktree add -b codex/m12-ledger-constraints .worktrees/m12-ledger-constraints origin/main | 0 | Isolamento próprio |
| initdb -D .data/m12-pg -U postgres -A trust -E UTF8 --no-sync | 0 | Cluster exclusivo criado; diagnóstico de token restrito Windows no log da chamada |
| pg_ctl start no sandbox | 1 | Falha de token Windows 87/3 |
| pg_ctl start fora do sandbox, somente esse cluster, porta 55413 | 0 | PostgreSQL real ativo |
| psql: CREATE ROLE app_user restrito; SELECT version; SHOW parâmetros de durabilidade | 0 | Papel e ambiente confirmados |
| bun run typecheck | 0 | Sem erros |
| bun run scripts/run-tests.ts tests/integration/ledger-constraints-m12.test.ts (primeiro verde) | 0 | 20 pass / 0 fail, antes de acrescentar o caso de totais fora do limite |
| bun run test (primeiro completo) | 1 | Um teste M06 de reversibilidade esperava 006 no topo; 007 passou a ser a última migration |
| bun run typecheck (final) | 0 | Sem erros |
| bun run test (final) | 0 | 354 pass / 0 fail, 22 arquivos |
| bun run .data/summarize-m12.ts | 0 | Contagens por arquivo e hashes dos logs no JSON versionado |
| git diff --check | 0 | Sem erros de whitespace |
| psql: pg_database / pg_stat_activity após testes | 0 | Somente postgres/template0/template1 e a conexão de inspeção |
| pg_ctl -D .data/m12-pg -m fast -w stop | 0 | Cluster exclusivo encerrado |
| Remove-Item do caminho absoluto verificado de .data/m12-pg | 0 | Cluster exclusivo removido, postmaster.pid ausente; server.log preservado em m12-postgres.log |

**M12 concluído:** 21/21 novos testes, incluindo UP/DOWN/UP. Na mesma execução final: M10 21/21, M11 9/9, M17 21/21, UoW/M05 18/18 e concorrência 6/6. O total integrado de 354 é extraído dos sumários dos 22 arquivos; a execução anterior teve 353 pass / 1 fail. A finalização não depende de ocultar a falha anterior ou excluir testes.

A correção desse primeiro run completo acrescentou somente o passo DOWN 007 antes de 006 nas duas sequências existentes do M06. Testes de migrations e de M11 também reconhecem 007, mantendo suas provas anteriores e sem enfraquecer asserções, ampliar timeouts ou omitir arquivos. A suíte oficial completa foi repetida após o ajuste; resultados finais e hashes estão no [JSON de evidências](m12-ledger-constraints-results.json).

Comandos de validação final em PowerShell, na worktree:

```powershell
$env:APP_DB_HOST='127.0.0.1'
$env:MIGRATION_DB_HOST='127.0.0.1'
$env:APP_DB_PORT='55413'
$env:MIGRATION_DB_PORT='55413'
bun run typecheck
bun run test
git diff --check
```

Os testes existentes cobrem rollback com falhas em wallet/transaction/ledger/outbox e retry sem efeitos adicionais. Concorrência cobre duplicatas, saldo insuficiente, disputas de identificadores, reversões, workers e pelo menos três processos independentes, com reconciliação final. A nova suíte combina abertura positiva, BET, WIN, LOSS, REFUND, ROLLBACK, rejeição e replay, verificando ledger e reconciliação após cada execução.

## Arquivos da entrega

- `src/application/use-cases/reconcile-wallet.use-case.ts`: agregação bigint exata, sem overflow intermediário.
- `src/infrastructure/persistence/migrations/007_ledger_finite_values.sql` e `.down.sql`: checks incrementais de finitude, reversíveis.
- `tests/integration/ledger-constraints-m12.test.ts`: matriz complementar M12.
- `tests/integration/migrations.test.ts`, `terminal-protection-m11.test.ts`, `wager-win-loss-m06.test.ts`: sequência de reversibilidade incluindo 007.
- `ARCHITECTURE.md`, `IMPLEMENTATION.md`: comportamento comprovado e fronteiras.
- Este documento e `m12-ledger-constraints-results.json`: diagnóstico, comandos e resultados por arquivo.

Docker, containers e Linux não foram validados; o diagnóstico de Docker não foi alterado. Publisher, inbox e SQS permanecem fora do escopo. Logs brutos ficam na worktree, ignorados pelo Git; seus hashes e resumos são versionados no JSON.
