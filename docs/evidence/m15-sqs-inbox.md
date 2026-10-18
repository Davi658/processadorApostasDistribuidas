# M15 — implementação e provas

Data local: 17/10/2026 (America/Sao_Paulo). Branch `codex/m15-sqs-inbox`; worktree `D:\processadorApostasDistribuidas\.worktrees\m15-sqs-inbox`. Base `origin/main` após `git fetch origin main`: `bf5d9fe886c55ee8b321df96f9fbacf837869584`, incluindo M14 `cc1ea25`. Main local não foi movida. Commit final é informado na entrega para evitar autorreferência no commit.

## Implementação

[Contrato final e decisões D1–D8](../messaging/M15-IMPLEMENTED.md). Migration incremental 009 reversível, repositório inbox com advisory lock por identidade e FK financeira. Normalização compartilhada independente de HTTP. ConsumeWagerCommand usa a mesma instância financeira e UoW exportada por PersistenceModule. Accept representa inclusive rejeição persistida e pendência. Sem nova engine, retenção automática ou mudanças em migrations anteriores, infraestrutura, M10–M14, M17 ou runtime M18. Asserções antigas de reversão de migrations foram ampliadas para incluir 009 antes de reverter as anteriores.

## Ambiente e isolamento

Runtime de testes: Windows, Bun 1.4.3. PostgreSQL 16.6 e LocalStack 4.0.3 reais em containers Linux exclusivos. Primeira tentativa: m15-proof-postgres-pinned, porta 55416, volume Docker; segunda configuração: m15-proof-postgres-memory, porta 55417, diretório de dados em tmpfs, fsync habilitado. LocalStack exclusivo m15-proof-localstack na porta 45615. O container m15-proof-postgres (55415) foi criado durante download da imagem postgres:16-alpine e não foi usado nas provas. Nenhum serviço preexistente foi parado ou reconfigurado.

Cada arquivo da suíte oficial usa seu próprio banco descartável. M15 cria banco `m15_*` e fila UUID `m15-*.fifo`; o JSON de auditoria registra os nomes reais. A URL anunciada por LocalStack pode conter porta interna 4566; o SDK recebeu explicitamente SQS_ENDPOINT=http://127.0.0.1:45615. A presença da fila M14 no LocalStack exclusivo durante a regressão foi conferida por awslocal. Os dados de prova não são dados de produção.

As provas de crash matam o processo consumidor, mantendo PostgreSQL ativo; não provam recuperação de crash do host ou do banco em tmpfs. Não foi desabilitado fsync. Suítes em runtime Linux não foram executadas; containers Linux de serviços não equivalem a uma execução Linux dos testes.

## Comandos

Execução sequencial, sem disputar suítes:

```powershell
$env:APP_DB_PORT='55417'
$env:MIGRATION_DB_PORT='55417'
$env:MIGRATION_DB_PASSWORD='m15proof' # credencial descartável da fixture
$env:SQS_ENDPOINT='http://127.0.0.1:45615'
bun run typecheck
$env:M15_CAPTURE_EVIDENCE='1'
bun run test:m15
$env:M15_CAPTURE_EVIDENCE='0'
bun run test
bun run scripts/m15-financial-smoke.ts
```

O smoke cria banco próprio, sobe Nest em porta efêmera, executa infra/smoke-api.ts e fecha app/banco em finally. Logs em [m15/](m15/). Os resultados finais constam abaixo após o encerramento das execuções.

## Provas A–N

| Prova | Exercício real e asserções |
| --- | --- |
| A | BET, WIN, LOSS, REFUND, ROLLBACK via Send/Receive/Delete SDK + PostgreSQL; IDs externos/financeiros, snapshots, amounts, saldos 90/110/110/120/100, versão, tipos/valores/balances do ledger e conteúdo dos eventos. |
| B | Mesma função normaliza HTTP/fila; DTO e hash iguais; correlação/causação excluídas da impressão; trim da chave canônico; FIFO inválido e money numérico recusados. |
| C | Barreira before_commit; conexão externa compara conteúdo completo de carteira/transações/ledger/outbox antes; nenhuma inbox visível. Depois, associação aponta ao resultado confirmado. |
| D | REJECTED por INSUFFICIENT_FUNDS e PENDING_REFERENCE são aceitos/deletados, com snapshot/evento real e carteira integralmente inalterada, sem ledger. |
| E/F | Mesma commandId e outra commandId com chave/payload iguais devolvem mesmo transactionId; efeitos completos preservados; segunda identidade ganha associação. |
| G | Troca de chave na mesma commandId, payload divergente na mesma chave e par externo sob outra chave falham preservando estado original. Snapshot inválido falha fechado. |
| H | Processos separados para mesma commandId, commandIds distintas com mesma chave e endpoint HTTP real contra consumidor. Carteiras diferentes disputam chave global com barreiras após ambas as escritas de carteira e antes de inserir transação; nova UoW reconcilia vencedor e recusa perdedor. PIDs no audit.json. |
| I | Falhas induzidas após inbox/carteira/transação/ledger/outbox: comparação integral antes/depois comprova rollback; nova tentativa saudável confirma uma única operação. |
| J | Falha pontual injetada apenas no DeleteMessage após commit real; SQS redelivery com nova entrega, mesma inbox/transactionId e ledger único. Cliente emprestado não é destruído. |
| K | Processo filho real bloqueia antes do commit ou depois do commit/antes de delete; SIGKILL, observação externa e redelivery SQS real recuperam com efeito único. Visibilidade liberada explicitamente para tornar a prova determinística. |
| L | Replay pendente não altera attempts/eventos; worker existente resolve referência; replay da mesma inbox devolve PROCESSED e saldo terminal 110, em vez do snapshot pendente 100. |
| M | Hook after_commit lança erro após COMMIT PostgreSQL real, simulando confirmação perdida; entrega não é deletada nessa tentativa; redelivery recupera resultado já persistido sem novo efeito. Não é um proxy que corta a resposta TCP do COMMIT. |
| N | Nest app.close durante barreira before_commit espera conclusão antes de fechar ORM; receiveOnce concorrente compartilha execução. Loop habilitado automaticamente processa e encerra sem novos receives; ownership de cliente preservado. Sinais OS e shutdown sob falhas ficam em M16. |

A concorrência usa execução de comandos em processos reais para controlar barreiras; não afirma que FIFO entrega simultaneamente duas mensagens do mesmo grupo. O caminho SDK é provado separadamente nas operações, redeliveries e loop habilitado. A prova de commit desconhecido induz a falha na confirmação ao coordenador; banco, inbox e efeitos são reais.

[audit.json](m15/audit.json) contém linhas reais das cinco tabelas, snapshots, hashes, eventIds, valores e PIDs capturados antes do teardown. Inclui fixture deliberadamente corrompida para provar fail-closed; não interpretar esse snapshot nulo como aceitação saudável de dado corrompido. Logs de runtime do consumidor contêm somente fase/código estático, sem corpo, ReceiptHandle, valores ou credenciais.

## Tentativas e limites

A primeira suíte oficial (`windows-official.txt`, exit 1) teve timeouts de 30s na preparação de cinco arquivos, com PostgreSQL observado em DataFileImmediateSync/DataFileExtend; nenhum timeout foi ampliado. A segunda (`windows-official-final.txt`, exit 1) passou as asserções, mas M18 produziu erro assíncrono FATAL 57P01 entre testes no cenário que termina conexões. A reexecução isolada M18 (`windows-m18-recheck.txt`, exit 0) passou 4 testes/80 asserções, sem alterações em M18. Os logs dessas tentativas foram preservados; detalhes de credenciais/chaves de sessão de fixture eventualmente impressos por dependências foram sanitizados nos artefatos.

M16 permanece responsável por retry avançado, renovação de visibilidade, redrive/DLQ real, sinais OS e drenagem/cancelamento sob falhas. Sem encaminhamento manual à DLQ, push, merge, publicação ou operações no repositório da empresa. Não há promessa de exactly-once do transporte.

## Resultados finais aprovados

| Plataforma | Comando | Exit | Resultado | Log |
| --- | --- | --- | --- | --- |
| Windows | bun run typecheck | 0 | TypeScript sem erros | windows-typecheck.txt |
| Windows | bun run test:m15 | 0 | 14 testes, 228 asserções, zero falhas | windows-m15-final.txt |
| Windows | bun run test | 0 | 28 arquivos, 469 testes, 5689 asserções, zero falhas | windows-official-verified.txt |
| Windows | bun test tests/observability/m18-http.test.ts --timeout 30000 | 0 | 4 testes, 80 asserções | windows-m18-recheck.txt |
| Windows | bun run scripts/m15-financial-smoke.ts | 0 | abertura 100, BET 25, replay 75, consultas, ledger, reconciliação diff 0.00 | windows-smoke.txt |
| Linux runtime | não executado | — | Somente serviços em containers Linux | — |

O typecheck e a M15 foram repetidos após as duas últimas asserções de equivalência de metadados/trim da chave. A execução oficial aprovada validou o mesmo runtime, com 226 asserções M15; a execução dedicada final ampliou essa prova para 228 sem alterar runtime. Captura final de auditoria: 28 inbox, 23 carteiras, 49 transações (incluindo aberturas), 45 lançamentos, 95 eventos e 10 processos filhos. Esses totais são apenas índice; a prova usa IDs e conteúdo, não somente contagens.

Antes do cleanup, PostgreSQL exclusivo retornou fsync=on, somente bancos postgres/template0/template1 e apenas a conexão psql de inspeção; LocalStack exclusivo retornou lista de filas vazia. Cleanup remove exclusivamente os quatro containers m15-proof-* criados nesta tarefa e seus volumes anônimos. Os três serviços preexistentes wagers-local-app-1, wagers-local-postgres-1 e wagers-local-localstack-1 permaneceram ativos nas mesmas portas. Veja cleanup.txt.

M15 concluído com provas A–N aprovadas dentro dos limites explicitados. O flake observado em M18 e a tentativa com I/O lento permanecem documentados, embora a execução oficial final tenha passado integralmente. M16 continua pendente. Manifesto exato dos arquivos desta entrega: [files.txt](m15/files.txt).
