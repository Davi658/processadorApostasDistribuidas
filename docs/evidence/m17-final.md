# M17 — consultas e paginação: evidências finais

## Isolamento

- Data: 17/10/2026, America/Sao_Paulo.
- Repositório: `D:/processadorApostasDistribuidas`.
- Branch: `codex/m17-final`.
- Worktree própria: `D:/processadorApostasDistribuidas/.worktrees/m17-final`.
- Base: `a47d1e2039e3e6267a910fd9331e342a8c013cb2`, `origin/main` após `git fetch origin main` (exit 0). Inclui M10 `4a20ecc` e M17 `253a997`.
- Checkout principal inicialmente em `d11d9f3`, sem alterações rastreadas; `.worktrees/` já não rastreado.
- Não foi integrada a branch duplicada `codex/m17-queries-pagination` (`7b4484a`). Worktrees de infraestrutura, M10 e M17 anteriores preservadas.
- Somente remoto pessoal Davi658 foi consultado. Nenhum push, merge em main, publicação ou operação no repositório da empresa.

## Implementação comprovada

- `AppModule` registra os três endpoints importando WageringQueryModule e PersistenceModule. Todas as factories de persistência existentes ficam em PersistenceModule, exportadas para comandos e consultas; removidas as factories duplicadas do módulo de consultas.
- O teste inspeciona ModulesContainer e encontra uma única instância de MikroOrmUnitOfWork. Confirma identidade da UoW e dos repositórios usados pelos providers de comando e consulta.
- Ambas as consultas de transação usam o mesmo DTO e mapper; o teste compara os JSONs completos por UUID e por identidade externa e mantém o mesmo externalId em dois provedores diferentes.
- Ledger mantém SQL parametrizado, limit + 1, vínculo walletId e ordenação ascendente created_at + id. Nenhuma conversão do timestamp de cursor para Date.
- LedgerCursorCodec em application/pagination independe de HTTP. QueryValidator somente adapta InvalidLedgerCursorError para HTTP 400; GetWalletLedgerUseCase não importa a camada HTTP.
- Base64URL é codificação sem assinatura, não um mecanismo de autenticidade. Timestamp adotado: UTC YYYY-MM-DDTHH:mm:ss.ffffffZ, seis dígitos, anos 0001–9999, calendário gregoriano estrito sem normalização de datas impossíveis.
- Teste HTTP rejeita datas impossíveis, mês/dia zero, ano zero, hora 24, minuto/segundo 60, offsets, precisão diferente de seis dígitos e formatos alternativos. Spy de getEntityManager confirma zero acesso aos repositórios para esses cursores inválidos.
- Paginação com limit=1 percorre timestamps iguais e fracionários 000001, 000002, 000999, 001000 e 001001. UUIDs em ordem contrária entre microssegundos detectariam truncamento. Cada timestamp retornado e decodificado é comparado exatamente; lista completa sem repetições/omissões.
- Dinheiro máximo NUMERIC(18,2), 9999999999999999.99, permanece string exata em ambas as consultas de transação e no ledger, incluindo saldo anterior/posterior.
- Leitura não altera nenhuma linha: snapshots completos via row_to_json(... )::text das quatro tabelas (wallets, wager_transactions, wallet_ledger_entries, outbox_messages) são idênticos antes/depois das consultas 200/400/404.
- M17 inicializa NestFactory.create(AppModule), aplica o mesmo filtro de bootstrap da API e usa HTTP real. Encerra exclusivamente por app.close(); confirma UoW fechada e zero sessões app_user no banco descartável em pg_stat_activity, antes do teardown administrativo. Finalmente restaura ambiente e remove o banco descartável.
- Nenhuma mudança na implementação do shutdown/transações M10. O teste de crash após claim foi estabilizado: lease longo no handshake, SIGKILL com confirmação de saída, asserção de claim concorrente bloqueado, renovação real para 200 ms e espera pelo PostgreSQL confirmar a expiração. Mantidos cenário e todas as asserções; adicionada a verificação de sucesso da renovação.

## Runner oficial

`bun run test` agora chama `scripts/run-tests.ts`, descobre recursivamente todos os .test.ts, ordena os arquivos e usa spawnSync(process.execPath, argv) para iniciar um processo Bun novo por arquivo. Sem sintaxe de shell específica; implementado para Windows/Linux. Timeout padrão de 30000 ms por teste; testes com timeout explícito mantêm seu limite. Continua após falhas e retorna 1 se qualquer arquivo falhar, receber sinal ou não iniciar. Ausência de testes/caminho inválido também retorna 1.

`tests/unit/test-runner.test.ts` cria filho realmente falho seguido de outro válido; confirma ambos executados, falha propagada (exit 1) e execução válida isolada com exit 0. O resultado esperado desse filho não é ocultação de falha do produto; é a asserção do contrato de erro do runner.

## Ambiente e limites

- Windows, Bun 1.4.3, PostgreSQL 16.8 real em 127.0.0.1:5432; bancos descartáveis com migrations e usuário de aplicação sem superusuário.
- Docker não operacional nesta sessão: comando ausente no PATH e executável padrão C:/Program Files/Docker/Docker/resources/bin/docker.exe não encontrado. Docker/Compose **não validados**.
- Runner implementado sem dependência de shell Windows/Linux; **execução em Linux não realizada** nesta sessão.
- Não se promete snapshot histórico entre páginas sob escritas concorrentes. A paginação usa a ordem persistida dos lançamentos visíveis em cada consulta; cursor é posição codificada vinculada à carteira, não uma assinatura ou autorização.
- SQS, inbox, publisher, infraestrutura e implementação M17 duplicada não foram alterados ou integrados.

## Comandos e resultados

Validação final no código combinado: **324 testes passaram, zero falhas, em 20 arquivos**. Comando oficial `bun run test`, exit **0**. Registros estruturados em [m17-validation-results.json](m17-validation-results.json). stdout local completo em `official-test-final.log` (ignorado pelo Git), SHA-256 `bfb4a5ea8e89124a91f2a69f32046a60bca8f87bb8e0786bca17b7a2c5780e0e`.

| Comando | Exit | Resultado |
|---|---:|---|
| `git fetch origin main` | 0 | Base atualizada e confirmada em a47d1e2 |
| `bun run typecheck` | 0 | Sem erros, incluindo scripts/run-tests.ts no tsconfig |
| `bun run test` — execução final | 0 | Todos os 20 arquivos; 324 pass / 0 fail |
| `bun test tests/integration/m17-read-endpoints.test.ts --timeout 30000` — primeira validação específica | 0 | 21 pass / 0 fail |
| `bun run test:unit` — primeira validação do runner | 0 | 40 pass / 0 fail em 5 arquivos |
| `bun run scripts/run-tests.ts tests/integration/pending-reference-worker-m10.test.ts` — após ajuste determinístico | 0 | 21 pass / 0 fail, 348 asserções |
| `git diff --check` | 0 | Sem erros de whitespace |

| Arquivo executado pelo comando oficial | Exit | Passaram | Falharam |
|---|---:|---:|---:|
| `tests/concurrency/concurrency.test.ts` | 0 | 6 | 0 |
| `tests/integration/http-endpoints.test.ts` | 0 | 21 | 0 |
| `tests/integration/m17-read-endpoints.test.ts` | 0 | 21 | 0 |
| `tests/integration/migrations.test.ts` | 0 | 1 | 0 |
| `tests/integration/mikro-orm-uow-m05.test.ts` | 0 | 18 | 0 |
| `tests/integration/money-postgres-roundtrip.test.ts` | 0 | 9 | 0 |
| `tests/integration/pending-reference-worker-m10.test.ts` | 0 | 21 | 0 |
| `tests/integration/postgres-invariants.test.ts` | 0 | 22 | 0 |
| `tests/integration/wager-bet-replay.test.ts` | 0 | 16 | 0 |
| `tests/integration/wager-operations.test.ts` | 0 | 8 | 0 |
| `tests/integration/wager-pending-replay-m09.test.ts` | 0 | 22 | 0 |
| `tests/integration/wager-reversals-m07.test.ts` | 0 | 28 | 0 |
| `tests/integration/wager-reversals-m08.test.ts` | 0 | 23 | 0 |
| `tests/integration/wager-win-loss-m06.test.ts` | 0 | 38 | 0 |
| `tests/integration/wallet-opening.test.ts` | 0 | 30 | 0 |
| `tests/unit/money.test.ts` | 0 | 21 | 0 |
| `tests/unit/payload-hash.test.ts` | 0 | 6 | 0 |
| `tests/unit/test-runner.test.ts` | 0 | 1 | 0 |
| `tests/unit/wallet-ledger-entry.test.ts` | 0 | 5 | 0 |
| `tests/unit/wallet.test.ts` | 0 | 7 | 0 |

### Falhas intermediárias e correções

- Primeiro typecheck após mover o codec: exit 1 porque dois testes ainda chamavam QueryValidator.encodeCursor. Atualizados para LedgerCursorCodec.encode e timestamp canônico de seis dígitos; todos os typechecks posteriores passaram.
- Primeira execução do novo `bun run test`: exit **1**, 20 arquivos, um arquivo falho. O teste M10 E esperava lease de 600 ms ainda ativo depois de handshake, consultas e SIGKILL; o PostgreSQL já o considerava expirado. O runner propagou a falha e continuou os demais arquivos, conforme contratado. Log local: `official-test.log`.
- Corrigido somente o teste de tempo: lease de 30000 ms cobre o handshake/crash, aguarda saída do filho, preserva a asserção de exclusão mútua, usa a operação real renewLease para definir 200 ms e espera o banco confirmar a expiração. Não foram removidos testes nem reduzidas asserções. A implementação de shutdown, fencing, transações e SQL financeiros do M10 permaneceu intacta.
- A segunda execução completa do comando oficial, registrada acima, passou. O teste do runner também confirma explicitamente exit 1 diante de filho falho e continuidade da execução.

## Arquivos alterados

- `ARCHITECTURE.md`
- `IMPLEMENTATION.md`
- `README.md`
- `docs/evidence/m17-final.md`
- `docs/evidence/m17-validation-results.json`
- `package.json`
- `scripts/run-tests.ts`
- `src/application/dto/query-wagering-transaction.dto.ts`
- `src/application/pagination/ledger-cursor-codec.ts`
- `src/application/use-cases/get-wagering-transaction-by-external-id.use-case.ts`
- `src/application/use-cases/get-wagering-transaction-by-id.use-case.ts`
- `src/application/use-cases/get-wallet-ledger.use-case.ts`
- `src/infrastructure/persistence/persistence.module.ts`
- `src/interfaces/http/app.module.ts`
- `src/interfaces/http/validation/query-validator.ts`
- `src/interfaces/http/wagering-query.module.ts`
- `tests/integration/m17-read-endpoints.test.ts`
- `tests/integration/pending-reference-worker-m10.test.ts`
- `tests/unit/test-runner.test.ts`
- `tsconfig.json`
