# Evidências M18

Base atualizada por `git fetch origin main`: `cf90a10571d2966643b9ac6287658a22e6f66efa`.
Branch: `codex/m18-final`.
Worktree: `D:\processadorApostasDistribuidas\.worktrees\m18-final`.
Nenhum push, merge, publicação ou acesso a repositório corporativo.

## Ambiente reproduzível

Projeto Compose exclusivo: `wagers-m18-final`, definido em `infra/m18-validation.compose.yml`.
PostgreSQL `postgres:16.6-alpine` em 55448; LocalStack `localstack/localstack:4.0.3` em 45628; bancos e filas descartáveis exclusivos por teste.
A aplicação Nest usada nos testes M18 importa o AppModule principal, com filtro global real. Trocam-se apenas recursos/configurações de teste e o sink de logs; os casos financeiros permanecem reais. O teste de publisher habilita a dependência SQS e desabilita seu agendamento automático para controlar os marcos de envio e commit.

Windows: `./scripts/m18-validate.ps1` prepara as variáveis exclusivas e chama `bun run scripts/m18-validate.ts`.
Linux: `docker compose -p wagers-m18-final -f infra/m18-validation.compose.yml build tester`, depois `docker compose -p wagers-m18-final -f infra/m18-validation.compose.yml run --name wagers-m18-final-validation tester bun run scripts/m18-validate.ts`.

O validador executa sequencialmente typecheck, suíte M18, suíte oficial, build Bun e smoke financeiro existente. Os manifests `win32/validation.json` e `linux/validation.json` registram comandos completos, exit codes, plataforma, versão Bun, duração e contagens. Logs completos ficam em arquivos .log ignorados pelo Git; os manifests são versionados sem copiar dados financeiros ou erros brutos de testes.

## Falhas intermediárias registradas

1. `git fetch` sem elevação: permissão negada em .git/FETCH_HEAD; repetido com permissão de escrita e concluído. Docker/WSL também exigiram execução fora do sandbox; nenhuma alteração de permissões no projeto.
2. Primeira execução M18: 3 pass, 1 fail e 1 erro assíncrono. A asserção nova usava `/wallets/:id`, enquanto o controller declara `/wallets/:walletId`; corrigida para o template real. O erro 57P01 no teardown foi reproduzido e corrigido aguardando o fechamento real dos clientes administrativos antes de DROP DATABASE, removendo FORCE sem reduzir as provas de indisponibilidade.
3. Teste novo de publisher esperava um evento para abertura positiva. O contrato financeiro existente produz dois eventos; a prova passou a exigir duas confirmações/duas marcações e quatro tentativas no cenário com retry, preservando o contrato.
4. Primeira suíte oficial: 30 arquivos, 1 falhou. M14 exige a mensagem diagnóstica persistida de falha anterior ao envio. Restaurada a persistência original; somente logs e métricas usam resultado seguro, sem alterar a asserção M14.
5. Segunda suíte oficial: 31 arquivos, 1 falhou no teste M18 recém-acrescentado. A referência ainda não estava elegível pelo backoff financeiro existente. A fixture agora antecipa explicitamente `next_attempt_at` no banco descartável antes de testar rollback/resolução, sem alterar prazos ou regras de produção.
6. Houve uma execução exploratória da suíte M18 enquanto uma suíte oficial anterior ainda estava em curso, em bancos/filas diferentes do mesmo ambiente exclusivo. Os manifests finais são produzidos pela execução sequencial completa após estabilização.

7. Build Windows inicial: exit 1 ao tentar empacotar dependências opcionais não usadas de Nest/Knex. Build com `--packages=external` passou (exit 0), preservando os pacotes do runtime existente; smoke executado em seguida passou. Nenhum driver ou pacote opcional foi instalado. A tentativa original está no manifest attempts.jsonl.
8. Primeiro contêiner Linux: exit 1 antes do typecheck por EACCES ao criar docs em /app. O serviço tester exclusivo agora usa user root para gravar evidências/build; a imagem/runtime de produção não foi alterada. Build Docker do tester passou (exit 0), imagem `sha256:5d1c8adfc8c3ba845f066f63f59783c315549422b7d7f45e2f57e590e6759e85`.

## Matriz de provas

- A/B/C/D: m18-http.test.ts importa AppModule, verifica endpoints, JSON allowlist, sucesso/falha HTTP, correlação explícita/fallback/null, UUIDs na mesma série e filtro real.
- B/C/E/J: m18-messaging.test.ts usa PostgreSQL/LocalStack reais e compara snapshots completos de wallets, transações, ledger, inbox e outbox em replay. Hooks reais de rollback não produzem resultados duráveis; envio confirmado com falha local não produz marcação publicada; retry e duplicate ficam em séries distintas. O worker registra resolução apenas após commit e deixa explícita a correlação histórica ausente.
- F/G: indisponibilidade PostgreSQL real com ALLOW_CONNECTIONS false e encerramento das sessões ORM; remoção da fila SQS necessária; liveness permanece saudável, readiness genérica 503, recuperação e dependência desabilitada.
- H: oito chamadas concorrentes sob saturação do pool retornam no limite original e deixam no máximo uma aquisição pendente; recuperação posterior preserva os snapshots.
- I: app.close real bloqueado em drain de worker permite observar readiness 503 e liveness 200 antes de fechar; depois ORM fechado e zero sessões da aplicação. Teardown aguarda sockets sem handlers globais de erro.
- J e mensageria M14/M15/M16: suíte oficial cobre dinheiro, snapshots, falhas transacionais, inbox, envelopes, concorrência entre processos, crash recovery, leases, renovação, redrive real e shutdown coordenado.

## Limitações semânticas

A correlação histórica de referências não é persistida e permanece explicitamente ausente. Métricas são por processo e reiniciam no restart. Redelivery não significa DLQ; não existe contador fictício de chegada à DLQ. A confirmação durável do consumidor inclui rejeições/pendências e não equivale a crédito/débito. Logs de estágio instantâneo têm duração zero. O diagnóstico persistido M14 não é exportado.

## Resultados finais

**M18 concluído com critérios A–J comprovados nas suítes executadas.**

| Etapa | Windows / Bun 1.4.3 | Linux x64 / Bun 1.4.3 |
|---|---|---|
| Typecheck | exit 0 | exit 0 |
| M18 | 8 pass, 0 fail; exit 0 | 8 pass, 0 fail; exit 0 |
| Suíte oficial | 486 pass, 0 fail, 1 skip de plataforma; 31 arquivos; exit 0 | 487 pass, 0 fail; 31 arquivos; exit 0 |
| Build com pacotes externos | exit 0 | exit 0 |
| Smoke financeiro | exit 0; todas as operações aprovadas | exit 0; todas as operações aprovadas |

O único skip Windows é o teste M16 específico de sinal Linux: `G: Linux Nest SIGTERM drains at real pre/post commit barriers before ORM close`. Ele foi executado e aprovado em Linux. Nenhum teste foi removido e nenhum prazo foi ampliado.

Manifests: [Windows](win32/validation.json), [Linux](linux/validation.json), [hashes dos fontes](source-sha256.json), [arquivos alterados](FILES.txt). A versão final dos scripts usa build com pacotes externos; no Windows o build que falhou foi repetido após a suíte oficial aprovada, seguido do smoke; no Linux a sequência inteira executou sem intervenção.

Cleanup: container `wagers-m18-final-validation`, PostgreSQL e LocalStack exclusivos e rede `wagers-m18-final_default` removidos, comandos exit 0. Os serviços preexistentes `wagers-local-app-1`, `wagers-local-postgres-1` e `wagers-local-localstack-1` continuaram ativos. Nenhum volume preexistente foi tocado. A imagem de validação local fica disponível para reprodução.

Pendências de implementação/validação: nenhuma para este escopo. A lacuna de correlação histórica permanece documentada como limitação do modelo existente, conforme permitido na solicitação. Sem push ou merge.
