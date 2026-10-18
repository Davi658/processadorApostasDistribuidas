# Revisão técnica da apresentação — 18/10/2026

Base confirmada por `git ls-remote origin refs/heads/main` e `git fetch origin main`: **3c459a592cadc2251564e5068a2d6133e9adc86a**. A main local anterior (39cb129) não foi usada na entrega. Branch `codex/technical-review`, worktree própria. Não houve push, merge, submissão ou reescrita de histórico.

## Inventário e limpeza

O [inventário da base](inventory-base.json) foi gerado antes das movimentações: 338 arquivos rastreados, tamanho, SHA-256 e referências textuais ao caminho completo. Essa busca é literal e não substitui a resolução de imports; [auditoria de links/imports](link-import-audit.json) complementa a inspeção de package.json, Dockerfile, ambos os Compose, scripts, migrations e links Markdown. O runner oficial e todas as asserções foram mantidos.

**Exclusões definitivas: nenhuma.** Duplicidade de conteúdo não foi suficiente para provar que um arquivo era dispensável:

- Compose padrão/local são idênticos, mas ambos são entradas documentadas e referenciadas. Preservados.
- Logs de typecheck, infraestrutura, configuração vazia e dois snapshots de persistência repetem bytes em execuções distintas. Preservados como evidências com proveniências distintas; não são dependências instaladas nem dumps de banco.
- Scripts SQL de inicialização e configurações de validação têm papéis/credenciais ou ambientes distintos. Não foram consolidados.
- Código, 10 pares de migrations, testes, runner, lockfile, Docker, scripts de reprodução e evidências foram preservados integralmente.

Movimentações documentais, com conteúdo histórico e links preservados:

| Origem | Destino | Motivo |
| --- | --- | --- |
| IMPLEMENTATION.md | docs/history/implementation.md | Relatos de implementação e provas por etapa |
| M18-INTEGRATION.md | docs/history/observability.md | Contrato histórico, anterior à semântica final de métricas |
| ARCHITECTURE.md (conteúdo histórico) | docs/history/architecture.md | Decisões detalhadas mantidas; novo documento principal descreve estado atual |
| infra/README.md (relato histórico) | docs/history/infrastructure.md | Resultados datados separados das instruções atuais |

README, ARCHITECTURE e infra/README foram revisados; docs/README centraliza navegação. A semântica final em docs/delivery/OBSERVABILITY.md e o contrato externo foram mantidos. Links de handoff foram ajustados; contrato interno indica a confiabilidade e entrada externa atuais. O roteiro pessoal passou a partir da raiz do clone, sem caminho do autor. `.env.example` recebeu aviso de uso exclusivamente local, sem alteração dos valores.

A revisão dos arquivos rastreados não identificou `.env` pessoal, node_modules, dumps SQL de dados ou chaves privadas/tokens reais. Senhas encontradas são as fixtures locais explícitas de Compose, scripts, exemplos e testes. IDs de imagens, filas, containers, SHAs e caminhos em relatos históricos foram preservados como metadados de evidência; não são requisitos do roteiro novo. Essa inspeção não é certificação de ausência de segredos em todo o histórico Git.

## Reprodução limpa e isolada

Cópia criada por `git archive --format=tar HEAD` + extração em diretório novo, contendo somente arquivos rastreados da base. Sem `.env` pessoal, node_modules ou fixtures externas. As mudanças finais são documentais (e comentários de exemplo), sem alteração dos arquivos executáveis/Compose/lockfile usados no build. O README revisado e os demais documentos são conferidos separadamente nessa mesma cópia antes da entrega.

Ambiente: PowerShell 7.6.7, Windows; Docker Desktop 4.95.0, Engine 29.8.2, Compose 5.6.0; Linux/amd64 nos containers, Bun 1.4.3, PostgreSQL 16.6-alpine e LocalStack 4.0.3. Não foi executada nova suíte em host Linux nativo ou host Windows; a regressão deste roteiro roda em container Linux.

Projeto exclusivo `wagers-review-20261018`; portas 3078/55478/45678, imagens próprias e volume novo. Serviços e volumes já existentes foram inventariados por leitura e não foram usados pela avaliação. Nenhum prune ou remoção global.

A execução foi concluída com os resultados abaixo. Logs novos ficam neste diretório; logs históricos permanecem vinculados às próprias bases.

## Limitações preservadas

Sem autenticação implementada (permitida sua omissão no desafio); extensão ProviderIdentityPort com adapter OIDC/JWKS e Guard. Sem validação AWS/IAM real, exactly-once, tracing distribuído, retenção automática da inbox ou replay automático de DLQ. LocalStack sem armazenamento durável configurado. Correlação tardia não preserva a original. FIFO pode inverter ordem causal entre publishers e sua deduplicação é temporária. Permissões/triggers não protegem contra administrador capaz de alterar as proteções. Reconciliação de totais não certifica completude histórica. Dados legados de hash exigem decisão de compatibilidade.

## Auditorias documentais reproduzíveis

Da raiz da worktree: `bun docs/review/audit.cjs` resolve destinos locais de links Markdown e imports relativos TypeScript. É uma ferramenta de revisão, não altera runner/assertivas nem acessa rede. Não valida conteúdo de URLs externas ou semântica de anchors. A existência dos arquivos é conferida no filesystem Windows; o auditor também compara capitalização com os caminhos exatos enumerados. A busca de segredos por padrões de alta confiança e a inspeção dos exemplos estão resumidas em [artifact-audit.json](artifact-audit.json).


## Comandos executados e resultados

Todos os comandos Compose usam o prefixo completo escrito no README: `docker compose --env-file .env.local -p wagers-review-20261018 -f docker-compose.local.yml`. Nenhuma variável prévia ou arquivo não rastreado pessoal foi reutilizado; `.env.local` foi criado pelo bloco PowerShell documentado.

| Comando (após o prefixo acima) | Resultado observado | Evidência |
| --- | --- | --- |
| config --quiet | exit 0 | Sem saída de erro |
| --profile test build app migrate test-runner | exit 0; stages de instalação usaram cache válido | [build](build.txt) |
| up -d --wait --wait-timeout 180 | exit 0, serviços healthy e jobs exit 0 | [subida](startup.txt), [status](status.txt) |
| logs migrate queues | exit 0; migrations 001–010 e filas | [logs](migrations-queues.txt), [tracking SQL](migration-records.txt) |
| run --rm migrate | exit 0, No new migrations to apply | [idempotência](migrate-again.txt) |
| exec -T app bun run infra/healthcheck.ts | exit 0 | [readiness](readiness.txt) |
| run --rm test-runner bun install --frozen-lockfile | exit 0, 281 installs/268 packages, no changes | [instalação explícita](frozen-install.txt) |
| run --rm test-runner bun run typecheck | exit 0, sem erros | [typecheck](typecheck.txt) |
| run --rm [flags -e completas do README] test-runner bun run test | exit 0; 35 arquivos, 495 testes, 0 falhas, 6049 asserções | [log integral](official-tests.txt), [resumo](test-summary.json) |
| exec -T app bun run infra/smoke-api.ts | exit 0, abertura/BET/replay/consultas/reconciliação | [smoke](smoke.txt) |
| down --timeout 40 | exit 0, preservou o volume próprio | [encerramento](shutdown-preserve.txt), [volume preservado](volume-preserved.txt) |
| down -v --timeout 40 | exit 0, removeu somente o volume próprio | [descarte](shutdown-discard.txt) |

Sondas HTTP adicionais no host: `/health/live` e `/health/ready` retornaram 200 ([respostas](http-health.json)). O inventário de volumes antes/depois da limpeza difere somente pelo volume criado para esta avaliação; os três serviços pessoais preexistentes continuaram healthy ([antes](containers-before-cleanup.txt), [depois](containers-after-cleanup.txt), [volumes antes](volumes-before-cleanup.txt), [volumes depois](volumes-after-cleanup.txt)). Imagens exclusivas ficam em cache, sem remoção de imagens de terceiros.

A suíte completa foi executada uma única vez para reproduzir o caminho documentado; não foi repetida por ajustes de texto. Não foi identificado defeito funcional nessa execução. A instalação explícita adicional conferiu o lock após o build com cache em outro container descartável, sem alterar pacotes/fontes; não exigiu nova regressão.

`git clone` não foi repetido: a base foi obtida por fetch e a cópia limpa por archive, evitando trazer arquivos locais ignorados. Não foi comprovado download de todas as dependências em cache frio nem nova execução em host Linux nativo. Os comandos Docker foram executados via PowerShell no host e Bun/TypeScript dentro de Linux.

Os SHA-256 do inventário inicial medem os arquivos do checkout Windows (incluindo sua conversão de fim de linha). A comparação das fontes executáveis entre os archives da base e da árvore final usa bytes de archive Git, sem diferença de CRLF. O manifesto final registra essa igualdade; documentação, comentários do exemplo e ferramenta de auditoria são as únicas mudanças de conteúdo entregues.

## Conferência da árvore final

A árvore rastreada de revisão foi exportada novamente com `git archive`, sem dependências instaladas ou configuração pessoal. O auditor passou nessa cópia: 186 links locais, 456 imports relativos, nenhum destino ausente ou divergência de capitalização. [Comparação das fontes](source-comparison.json) e [manifesto de 152 arquivos](executable-manifest.json): todos idênticos à base em código, testes, runner, scripts, migrations, Docker, Compose, lockfile e configuração TypeScript. O hash de árvore registrado identifica a exportação examinada; arquivos de relatório acrescentados depois não alteram essas fontes. Não há necessidade de repetir regressão por esse complemento documental.

Os logs novos versionados têm somente espaços finais e fim de arquivo normalizados para revisão Git; conteúdo e resultados foram preservados. Relatos históricos não tiveram decisões ou resultados removidos.
