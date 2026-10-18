# M14 — estabilização integrada

Data de referência do trabalho: 17/10/2026 (America/Sao_Paulo).
Base obtida por `git fetch origin main`: `51c14400282749e972903929ef4517674c77bf0c`, contendo M14 `22a77f7` e a base M18.
Branch: `codex/m14-stabilization`.
Worktree: `D:\processadorApostasDistribuidas\.worktrees\m14-stabilization`.
O commit local que contém este documento é a ponta final; consultar `git rev-parse HEAD`. Não houve push, merge, publicação ou acesso ao repositório da empresa.

## Alterações e provas

1. O worker existente mantém bloqueio de claims e drenagem em `OnModuleDestroy`. O cliente SQS próprio passa a `BeforeApplicationShutdown`; o ORM continua em `OnApplicationShutdown`. As fases Nest estabelecem a dependência, sem confiar na ordem dos providers dentro da mesma fase. Após timeout, cancelar é uma solicitação: o worker continua aguardando encerramento efetivo. Cliente emprestado não é destruído.
2. Três aplicações Nest reais pausam por barreiras: dentro do SDK antes da aceitação pelo broker; com resposta de um envio real retida e cancelamento durante a drenagem; após confirmação recebida e antes de markPublished. Cada teste rejeita novos claims e exige `execution-ended`, `client.destroy`, `ORM close`, nessa ordem. Não há sleeps fixos como prova de entrada. O cenário de cancelamento após aceitação comprova recuperabilidade com o mesmo eventId; não promete desfazer o envio confirmado.
3. Para cada uma de markPublished, recordFailure e markOperationallyBlocked há seis casos PostgreSQL: token válido, incorreto, expirado sem substituição, antigo após novo claim, publicado e bloqueado. Retorno false exige igualdade do snapshot integral da linha antes/depois. Autorização exige token, expiração futura pelo PostgreSQL e estado não publicado/não bloqueado. releaseLease apenas libera a posse não publicada com token correspondente, mesmo expirado; não confirma entrega nem modifica retry. Outro teste demonstra recusa de confirmação após expiração e republicação do envelope original.
4. Validador próprio na aplicação reutiliza nomes/versões dos eventos de domínio e Money; não importa HTTP, não modifica dados e não regenera identidade/timestamp. Suporta os quatro contratos v1 existentes. Tipo/versão desconhecidos são bloqueios operacionais recuperáveis; atualizar contrato/dados com análise operacional e desbloquear explicitamente antes de reprocessar. Há 23 testes unitários de contratos/ownership/contagem e seis casos persistidos de corrupção, além do teste original de isolamento de evento inválido. Sucessos usam payloads reais. blocked só incrementa após atualização SQL confirmada.
5. FIFO documentado como ordem de aceitação pelo broker no grupo, sem garantia de ordem causal original entre publishers concorrentes. Mantidos at-least-once e consumidor idempotente. Backoff real: min(1000 * 2^attempts, 60000) ms; lote 20, lease 30000 ms, polling/drenagem/cancelamento diagnóstico/request SQS 5000 ms. Sem limite terminal de tentativas.
6. A suíte oficial original falhou apenas na configuração fixa M18 (`127.0.0.1:55438`, ECONNREFUSED). O teste M18 agora usa getMigrationDatabaseConfig para host/porta/usuário/senha, inclusive no ORM; as asserções e o produto M18 foram preservados. Não foi integrada instrumentação nova à aplicação.

## Isolamento e reprodução

Projeto Docker `m14-stabilization`; PostgreSQL 16.6-alpine em 15434, LocalStack 4.0.3 em 14567 e API em 13014, todos em loopback. Volume `m14-stabilization_local_pgdata`, rede exclusiva e armazenamento efêmero do container LocalStack. Nenhum serviço/volume de outro projeto foi alterado. Cada suíte cria bancos descartáveis; cada execução M14 cria uma fila FIFO `m14-<UUID>.fifo` e só limpa/apaga essa fila. A URL fornecida pelo ambiente não é drenada. Os processos de crash recebem a URL da fila própria.

Preparação executada na worktree (PowerShell):

```powershell
$env:LOCAL_POSTGRES_PORT='15434'
$env:LOCAL_SQS_PORT='14567'
$env:LOCAL_API_PORT='13014'
$env:APP_IMAGE='m14-stabilization-app:local'
$env:TEST_IMAGE='m14-stabilization-test:local'
docker compose -p m14-stabilization -f docker-compose.local.yml -f infra/m14-validation.compose.yml up -d postgres localstack queues migrate
```

Os comandos seguintes são executados a partir da worktree. `infra/m14-validation.ps1` explicita todas as variáveis de teste e nunca aponta para infraestrutura compartilhada. Imagens runtime/tester usam `bun install --frozen-lockfile` do Dockerfile existente; package.json e bun.lock não foram alterados.

## Resultados

| Ambiente | Comando | Exit | Resultado |
| --- | --- | --- | --- |
| Docker exclusivo | preparação compose acima | 0 | PostgreSQL/LocalStack/filas/migrations próprios |
| Windows | `./infra/m14-validation.ps1 typecheck` | 0 | TypeScript sem erros |
| Linux | `docker compose -p m14-stabilization -f docker-compose.local.yml -f infra/m14-validation.compose.yml --profile test run --rm test-runner bun run typecheck` (APP_IMAGE/TEST_IMAGE como acima) | 0 | TypeScript sem erros |
| Windows | `./infra/m14-validation.ps1 m14` | 0 | 39 aprovados, 0 falhas, 214 asserções |
| Linux | `./infra/m14-validation.ps1 linux-m14` | 0 | 39 aprovados, 0 falhas, 214 asserções |
| Windows | `./infra/m14-validation.ps1 official` | 0 | 455 aprovados, 0 falhas, 5454 asserções, 27 arquivos |
| Linux | `./infra/m14-validation.ps1 linux-official` (após CHECKPOINT explícito) | 0 | 455 aprovados, 0 falhas, 5454 asserções, 27 arquivos |
| Windows | `bun test tests/observability/m18-http.test.ts` (configuração exclusiva) | 0 | 4 aprovados, 0 falhas, 80 asserções |
| Linux/Docker | `./infra/m14-validation.ps1 build` | 0 | runtime/tester; frozen lockfile (267 pacotes) |
| Linux/Docker | `./infra/m14-validation.ps1 up` | 0 | API exclusiva saudável |
| Docker exclusivo | `./infra/m14-validation.ps1 down` | 0 | containers, rede e volume próprios removidos após os testes |
| Windows → API Linux | `./infra/m14-validation.ps1 smoke` | 0 | abertura 100.00; BET 25.00; replay; consultas; ledger; reconciliação diff 0.00 |

Cleanup em `cleanup.txt`; checkpoint em `checkpoint.txt`. Logs completos em [m14-stabilization/](m14-stabilization/). Os arquivos `windows-official-sequential.txt` e `linux-official-postcheckpoint.txt` são as execuções finais aprovadas. `linux-official-sequential.txt` preserva a tentativa Linux com falhas de timing. `windows-m14-verified.txt` e `linux-m14-final.txt` contêm as provas M14 finais. `bootstrap-build-excerpt.txt` transcreve o trecho observado do install congelado efetivamente executado na preparação inicial (267 pacotes); não é um log integral redirecionado. `build.txt` e `build-final-integrated.txt` contêm os builds completos posteriores, que reutilizam a camada congelada, e confirmam as imagens finais. `typecheck.txt`, `linux-typecheck.txt`, `smoke.txt` e `windows-m18.txt` complementam a prova. Logs sem sufixo sequential das suítes oficiais preservam as tentativas anteriores, não são resultados de aprovação.

## Histórico de falhas e limites

- Primeiro typecheck retornou 1 enquanto dois cleanups de teste ainda referenciavam onModuleDestroy do SQS; ambos foram migrados para beforeApplicationShutdown antes da validação final.
- Primeira tentativa M14: erro de fixture SQL `42P08` (parâmetro repetido inferido como text/varchar); corrigido com cast explícito, mantendo as asserções. A conexão da transação não confirmada agora sempre executa ROLLBACK no finally.
- Repetição simultânea das suítes integrais: latências de dezenas de segundos, falha H por next_attempt_at já ultrapassado na leitura, timeouts em hooks de M14/M10 e preparação PostgreSQL. A repetição Linux foi interrompida (exit 137), somente no container identificado do projeto exclusivo. As execuções finais são sequenciais, com os mesmos prazos e asserções. Não se atribui a causa a um recurso específico sem medição.
- Primeira execução Linux sequencial: 405 aprovados, 4 falhas, 3 arquivos com falha (lock timeout 55P03 em concorrência e hooks de preparação M13/HTTP). pg_stat_activity mostrou espera IPC/CheckpointDone em uma amostra; isso não prova causalidade de todas as falhas. Após término da suíte, `docker exec m14-stabilization-postgres-1 psql -U migration_user -d postgres -c CHECKPOINT` retornou 0. A repetição integral, sem alteração de código, prazos ou asserções, passou 455/455. A aprovação final não elimina a observação de timing intermitente neste ambiente. Ver diagnostics.txt e os logs históricos.
- Primeiras suítes oficiais Windows/Linux: falha no arquivo M18 pela porta fixa, não por mudança financeira. A execução final usa exclusivamente a infraestrutura descrita acima.
- Windows: Bun 1.4.3 nativo; integrações usam serviços Docker Linux exclusivos. A morte de processo no Windows usa a implementação do sistema para kill, sem alegar semântica POSIX.
- Linux: testes executados dentro da imagem oven/bun:1.4.3, incluindo os crashes SIGKILL reais. Smoke financeiro faz requisições HTTP da máquina Windows para a API da imagem Linux.
- Não validados: AWS SQS de produção, falhas de infraestrutura fora dos cenários locais, outras versões/plataformas e ordenação causal original entre publishers concorrentes. M18 continua base isolada, com integração ao produto e mensageria fora deste trabalho.
- Consumidor/inbox, novas métricas e outras metas não foram implementados. Nenhum teste foi removido e nenhuma asserção foi reduzida para aprovação.


## Arquivos da alteração

- Produto M14: `src/application/validation/outbox-contract.ts`, `src/application/use-cases/publish-outbox-events.use-case.ts`, `src/infrastructure/messaging/sqs-outbox-queue-publisher.service.ts`, `src/infrastructure/persistence/mikro-orm/mikro-orm-adapter.ts` (somente operações finais de lease da outbox).
- Provas: `tests/integration/outbox-publisher-m14.test.ts`, `tests/unit/outbox-contract-m14.test.ts`, `tests/concurrency/outbox-worker-runner.ts` (cleanup na nova fase) e `tests/observability/m18-http.test.ts` (configuração de conexão).
- Reprodução exclusiva: `infra/m14-validation.compose.yml`, `infra/m14-validation.ps1`.
- Documentação: `ARCHITECTURE.md`, `IMPLEMENTATION.md`, este documento, manifesto de resultados e logs completos na pasta homônima.
- Domínio, fluxo financeiro BET/WIN/LOSS/REFUND/ROLLBACK, worker M10, observabilidade do produto M18, migrations, Dockerfile, manifests/lockfile e consultas M17 não foram alterados. `git diff --exit-code 51c1440 -- src/domain src/application/use-cases/process-bet.use-case.ts src/application/use-cases/process-wager.use-case.ts src/infrastructure/workers/pending-reference-worker.service.ts src/infrastructure/observability` retornou 0.
