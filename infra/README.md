# Infraestrutura para avaliação

O [roteiro completo](../README.md) usa explicitamente `docker-compose.local.yml` com projeto, portas, imagens e volume exclusivos.

| Arquivo | Finalidade |
| --- | --- |
| `../docker-compose.local.yml` | PostgreSQL 16.6, LocalStack 4.0.3, bootstrap de filas, migrador, API e perfil de testes |
| `../docker-compose.yml` | Mesmo conteúdo do Compose local; preservado como entrada padrão compatível |
| `init-db.sql` | Papel local `app_user`, sem superusuário/DDL; executa somente em volume vazio |
| `bootstrap-sqs.sh` | Três filas FIFO e redrive para DLQ com maxReceiveCount 5 |
| `healthcheck.ts` | Readiness HTTP; exit diferente de zero quando indisponível |
| `smoke-api.ts` | Abertura, BET, replay, consultas e reconciliação; cria dados no banco da aplicação |
| `m14-validation.compose.yml`, `m18-validation.compose.yml` | Ambientes de evidências históricas; não são pré-requisito do roteiro atual |

O migrador aplica **001–010**: schema inicial, reforço/outbox, terminais/FK composta, índice de reversões, lease de pendências, proteção terminal, valores finitos, lease/retry da outbox, inbox e identidade externa textual. Migrations concedem os privilégios de tabela ao runtime; os testes precisam do administrador para criar e remover bancos descartáveis.

O Dockerfile instala pelo lockfile congelado. `tester` acrescenta runner e testes; `runtime` executa como `bun`, mas conserva dependências de desenvolvimento instaladas no estágio de dependências. A imagem não foi minimizada para produção.

O Compose habilita consumidor, publisher e worker de referências. A suíte instancia componentes e usa bancos/filas próprios nos cenários de teste. Consulte o [contrato de comandos](../docs/messaging/M15-IMPLEMENTED.md) e a [confiabilidade do consumidor](../docs/messaging/M16-RELIABILITY.md).

`down` sem `-v` preserva dados. Remova volumes somente do projeto descartável criado na avaliação, conforme o README. Não use prune nem scripts de PostgreSQL nativo para encerrar esse roteiro.
