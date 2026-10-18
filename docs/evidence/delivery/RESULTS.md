# Preparação da entrega — M18/M19/M20/M21

Base obtida por fetch do repositório pessoal: `8798c28c88d74685bc2b815b19868f281e32a58f`. Branch `codex/delivery-final`, worktree `D:\processadorApostasDistribuidas\.worktrees\delivery-final`.

Revisão fixada para a validação final: **`fdf9fb9fff6ca1eb8a6194a2d26620d85637f86e`**. O commit posterior de evidências não altera fontes executáveis. O SHA final da branch é informado na entrega. `source-manifest.json` registra SHA-256 dos arquivos de aplicação, testes, scripts, infraestrutura, lockfile e Compose; conferir com `Get-FileHash`. O enunciado original não foi incluído. Ambiente e digest da referência consultada em `provenance.json`.

## Reprodução da regressão

Executada da worktree fixada, em PowerShell 7.6.5 / Bun 1.4.3 / Docker 29.8.2 / Compose 5.6.0, Linux via Docker Desktop:

```powershell
./scripts/delivery-validate.ps1 -Project delivery-regression-final-20261018 -PostgresPort 55596 -SqsPort 45696 -EphemeralTestStorage -EvidenceDirectory docs/evidence/delivery/verification-final
```

O script recusa sobrescrever evidência existente. Para nova rodada, escolha outro EvidenceDirectory e preferencialmente outro Project/PostgresPort/SqsPort. Usa `delivery-regression-final-20261018`, PostgreSQL host 55596, SQS 45696, imagens `delivery-final-app:20261018` e `delivery-final-tests:20261018`. Testes criam bancos/filas descartáveis nessa infraestrutura exclusiva. O override infra/delivery-validation.compose.yml usa tmpfs exclusivo e requer Compose com suporte a !override (v2.24.4+); fsync e synchronous_commit permanecem habilitados. Ele não é aplicado ao Compose final persistente. A composição com dados persistidos do smoke e a conferência pessoal ficam em projetos separados.

Comandos, horários UTC e exit codes exatos: `verification-final/attempts.jsonl`; saídas integrais nos arquivos `.txt` do mesmo diretório. O runner executa um processo novo por arquivo e sequencialmente: typecheck, afetados, oficial Windows, oficial Linux, smoke financeiro. Build/config/install ocorrem antes. O smoke da composição final é outra prova, posterior, com todos os workers habilitados.

## Mapa das provas

| Prova | Ambiente e limite |
|---|---|
| Contrato externo real; chave em data; identities separadas; conflitos; rollback | Unidade e integração PostgreSQL/LocalStack, `external-wager-contract.test.ts`. Envelope interno permanece coberto por M15/M16. |
| Invocação/replay/rollback externo/falha técnica/commit/labels/lock_timeout | Suítes de observabilidade e unidade; banco/broker reais, isolados do app do smoke. |
| 50 duplicatas em ≥3 processos | `concurrency.test.ts`, onda 17+17+16, barreira READY/release, mesmo transactionId, um primeiro resultado, 49 replays, saldo/version/ledger/reconciliação. Retries de lock são limitados e registrados; não são contados como novos resultados financeiros. |
| Disputa do saldo da mesma carteira | Mesma suíte, duas BETs 80.00 sobre 100.00 e cenário em três processos. Um processado, um rejeitado, saldo 20.00. |
| Carteiras distintas em paralelo | `delivery-independent-wallets.test.ts`, três processos atingem LOCKED antes da liberação do commit, provando locks simultâneos por carteira. Reconciliação e transactionIds conferidos. |
| Publishers concorrentes e crash envio→marca | Suíte M14, dois processos, leases/SKIP LOCKED; crash real em barreira depois de confirmação SQS, retomada preserva eventId. Inclui expiração de lease e fencing. É prova isolada, não dois publishers no app único do Compose final. |
| Crash commit financeiro→delete | Nova integração externa mata processo real em after_commit; redelivery SQS mantém MessageId, muda ReceiptHandle, retorna replay, compara todos os registros completos e reconcilia. |
| Shutdown/cancelamento antes/depois do commit | M15/M16 e testes de proteção existentes; teste Linux SIGTERM é executado no contêiner. Windows mantém o skip específico de sinais Unix, sem alegar que o executou. |
| Migration 010 reversível e dados preservados | Migrations/M12: DOWN/UP mantém inbox UUID e registros financeiros; contrato externo comprova recusa atômica do DOWN com identidades não UUID. M11/M06 mantêm provas históricas de triggers/constraints. |
| HTTP/SQS/REFUND fora de ordem/publisher/worker real | `scripts/delivery-compose-smoke.ts`, executado contra a composição final (app real, flags habilitadas, broker e volume próprios). Não chama use case de referência ou publisher diretamente nem resolve estado por SQL. |
| Reinício e comparação por IDs | Modo `--verify-persistence` do smoke compara registros completos das cinco tabelas com snapshot anterior, após segunda subida e após reinício de PostgreSQL/app. |

`smoke-api` e `delivery-compose-smoke` não substituem a suíte oficial completa. A entrega é at-least-once; os testes provam proteção persistente de efeitos financeiros e identidade estável dos eventos, não exactly-once do transporte.

## Interpretações e limitações

- Enunciado SQS confirmado em arquivo local. `data.idempotencyKey` é obrigatória e autoritativa; não há fallback. `messageId` do envelope é textual. [Contrato e decisões de FIFO/timestamp](../../messaging/EXTERNAL-CONTRACT.md).
- [Semântica de métricas](../../delivery/OBSERVABILITY.md): invocações não são commits; estados financeiros persistidos são gauge consultado no banco. DLQ visible é aproximado e não cumulativo. Gauges conservam última coleta bem-sucedida se houver falha.
- Autenticação omitida conforme seção 2; ProviderIdentityPort deixa o ponto de extensão explícito. Não há validação de IAM, AWS de produção, failover ou persistência do LocalStack depois de parar ou recriar seu processo.
- Os contêineres de testes rodam como bun com diretórios graváveis; o runtime também é bun. Segredos de Compose são somente locais. Não há leitura destrutiva da DLQ para métricas.
- Logs e [investigação](INVESTIGATION.md) preservam falhas intermediárias. O episódio anterior de timeout de teardown foi instrumentado e permaneceu sob o mesmo deadline; sua causa exata não é afirmada sem evidência.
- O roteiro [FINAL-MANUAL-TEST](../../delivery/FINAL-MANUAL-TEST.md) e `delivery-personal-http.ps1` não foram executados. Somente sua sintaxe foi analisada (`manual-syntax.json`). Conferência pessoal, envio e apresentação continuam com o candidato.

Sem push, merge, publicação, submissão ou operações no repositório da empresa. Nenhuma worktree preexistente foi removida ou alterada. Recursos exclusivos e encerramento são registrados junto à prova final de Compose; volumes não são apagados por padrão.

## Resultado final

| Marco | Parecer |
|---|---|
| M18 | Validado. Invocações/replay/rollback externo separados de estados persistidos; labels limitados; lock_timeout real; DLQ gauge sem contador inventado; outbox com semântica corrigida. |
| M19 | Validado. Config/build, volume nomeado novo, migrations 001–010, API/PG/SQS saudáveis, três workers habilitados, fluxos HTTP e SQS externo, REFUND antes da referência, segunda subida e restart PostgreSQL/app. |
| M20 | Validado nas suítes reais isoladas e no smoke final conforme mapa acima. 50 submissões em três processos; zero retries nessa prova nas rodadas oficiais finais; publishers/crashes/retomada e reconciliação preservados. |
| M21 | Documentação e roteiro pessoal concluídos. Sintaxe de dois scripts e sete blocos PowerShell conferida. Testes pessoais não executados. |

Regressão final em `verification-final/`: instalação congelada, Compose config/build, typecheck, afetados (**112 pass em 12 arquivos**), oficial Windows (**494 pass, 1 skip Unix, 0 fail, 35 arquivos**), oficial Linux (**495 pass, 0 skip, 0 fail, 35 arquivos**) e smoke financeiro: **todos exit 0**. O teste Linux SIGTERM foi executado. Contagens em `final-test-counts.json`, saídas e exit codes integrais preservados.

Aceitação em `compose/attempts.jsonl`: config/build/primeira subida, flags, E2E, segunda subida, verificação de persistência, restart PostgreSQL/app e nova verificação: **todos exit 0**. Projeto `delivery-compose-final-20261018`, API 3094, PostgreSQL 55594, SQS 45694, volume `delivery-compose-final-20261018_local_pgdata`. O teste confirmou que esse volume não existia antes da primeira subida e que o override de regressão não estava aplicado. As filas de nomes contratuais pertencem ao broker LocalStack exclusivo desse projeto, não ao broker de outra composição.

Estado reconciliado: uma carteira, cinco transações, cinco lançamentos, uma inbox externa e onze eventos de outbox publicados; saldo armazenado e reconstruído **85.00 BRL**. IDs reais em `compose/financial-e2e.txt`. `second-up-persistence.txt` e `restart-persistence.txt` confirmam igualdade dos registros completos por IDs nas cinco tabelas. Snapshot local de apoio em `.data/delivery-compose-snapshot.json`, SHA-256 registrado em `compose/checks.json`.

Após restart: liveness/readiness/metrics HTTP 200; gauge persistido de três BETs, backlog outbox zero e ausência de sqs_dlq_messages_total. Fsync/synchronous_commit on e volume persistente comprovados. Seis arquivos críticos do contêiner correspondem byte a byte ao manifesto dos fontes. Foram conferidos 113 registros JSON operacionais sem campos de money/payload/ReceiptHandle/credenciais. Artefatos em `compose/http-probes.json`, `metrics-after-restart.txt`, `deployed-source-hashes.txt`, `postgres-storage.txt`, `postgres-durability.txt` e `checks.json`.

Recursos de regressão/intermediários foram parados; nenhum volume foi removido. O Compose final permanece **saudável e ativo para inspeção**, conservando também as filas em memória do LocalStack. Inventário em `containers-after-cleanup.txt`, `retained-volumes.txt` e `cleanup.json`. O broker local não promete conservar mensagens se seu processo for parado/recriado. Todos os recursos preexistentes e todas as worktrees anteriores foram preservados.

Para retomar a mesma configuração de inspeção em um novo terminal PowerShell:

```powershell
$env:COMPOSE_FILE='docker-compose.yml'
$env:COMPOSE_PROJECT_NAME='delivery-compose-final-20261018'
$env:APP_IMAGE='delivery-final-app:20261018'
$env:LOCAL_API_PORT='3094'
$env:LOCAL_POSTGRES_PORT='55594'
$env:LOCAL_SQS_PORT='45694'
docker compose up -d --wait app
```

Encerramento opcional da inspeção: `docker compose stop` no mesmo terminal, sem `-v` ou prune. Para repetir a aceitação financeira automatizada, configure DELIVERY_API_URL/DELIVERY_DB_PORT/DELIVERY_SQS_ENDPOINT para esse projeto e execute `bun run scripts/delivery-compose-smoke.ts`; para comparar o snapshot local já criado use `--verify-persistence`. Para a conferência pessoal, siga o roteiro separado, que usa projeto e portas próprios.

Não restaram bloqueios contratuais ou falhas na rodada final. As falhas intermediárias e os limites da investigação de I/O/teardown permanecem explícitos em INVESTIGATION, sem atribuir seus resultados aos fontes finais. Não foi realizado push, merge, publicação, submissão ou acesso ao repositório da empresa. O arquivo original de referência não integra o commit.
