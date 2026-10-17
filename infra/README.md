# Infraestrutura local e Integração com Main

Estabilização realizada na branch `codex/main-stabilization-final`, a partir da ponta revisada de `origin/main`:
- **Base SHA**: `bef5481551b246539e18ced210d5392c764ac5fd` (merge de PR #10 `codex/m17-queries-pagination` sobre `11d73f8`).
- **Preservação**: Integração Docker oficial (`ef5141c`), M17 oficial finalizado em `52bfa20` (`WageringQueryModule` e rotas oficiais), e volume preexistente `wagers-local_local_pgdata`.
- **Saneamento PR #10**: Remoção cirúrgica dos 6 artefatos duplicados (`M17-INTEGRATION.md`, `financial-queries.port.ts`, `financial-queries.ts`, `financial-queries.controller.ts`, `financial-queries.module.ts`, `financial-queries-m17.test.ts`), mantendo `WageringQueryModule` e infraestrutura compartilhada intactos.
- **Correções M13**: Eventos identificados por tipo e ID de transação (sem presunção de ordem por timestamp/UUID); reuso do DTO completo com `roundId` nos retries após rollback; cobertura de timestamps rigorosamente iguais com ordenação de UUID reversa à emissão.
- **Worktree**: `D:\processadorApostasDistribuidas\.worktrees\main-stabilization`.

Nenhum push ou merge em `main` foi executado. As worktrees preexistentes e o volume `wagers-local_local_pgdata` foram preservados intactos.

## Subir e parar

O Compose suporta parametrização via variáveis de ambiente, permitindo execução padrão (`wagers-local`) ou em projetos isolados (ex: `wagers-integration`, `wagers-stab-isolated`):

```powershell
docker compose -f docker-compose.local.yml config
docker compose -f docker-compose.local.yml build
docker compose -f docker-compose.local.yml up -d --wait --wait-timeout 180
docker compose -f docker-compose.local.yml ps -a
docker compose -f docker-compose.local.yml stop
docker compose -f docker-compose.local.yml down
```

`down` preserva `local_pgdata`. Para isolamento total em testes, defina variáveis ou use um arquivo `.env` dedicado:

```powershell
$env:COMPOSE_PROJECT_NAME = 'wagers-stab-isolated'
$env:APP_IMAGE = 'wagers-stab-isolated-app:bun-1.4.3'
$env:LOCAL_API_PORT = '3002'
$env:LOCAL_POSTGRES_PORT = '5436'
$env:LOCAL_SQS_PORT = '4569'
docker compose -f docker-compose.local.yml up -d --wait --wait-timeout 180
```

Padrões: API 3000, PostgreSQL 5433, SQS 4566, projeto `wagers-local`. Nos containers as portas internas permanecem 3000, 5432 e 4566.

## Imagem Docker Multi-Stage

O `Dockerfile` foi estruturado em múltiplos estágios para desacoplar produção de testes:
1. `dependencies`: Instala dependências de produção e desenvolvimento com `bun install --frozen-lockfile`.
2. `base`: Contém dependências, `src/`, `infra/`, `package.json`, `tsconfig.json` e executa com usuário não-root `bun` (UID 1000).
3. `tester`: Estágio específico para execução de testes em contêiner (`target: tester`). Copia `scripts/` e `tests/` e define `CMD ["bun", "run", "test"]`.
4. `runtime`: Estágio padrão da API (`target: runtime`), mantendo a imagem oficial enxuta e estritamente restrita ao código de produção (`src/` e `infra/`).

## Inicialização e Migrations

- PostgreSQL `16.6-alpine`: Usuário administrativo `migration_user` / `local_migration_only`, banco `betting_db`.
- Runtime: `app_user` / `local_runtime_only`, sem privilégios de superusuário, criação de banco ou DDL.
- `init-db.sql`: Executa na criação de novos volumes criando o role `app_user` e revogando privilégios públicos.
- `migrate`: Aplica todas as **7 migrations** incrementais existentes no repositório:
  1. `001_initial_schema`
  2. `002_reinforce_schema_and_outbox`
  3. `003_protect_terminals_and_composite_fk`
  4. `004_restrict_reversal_unique_index`
  5. `005_pending_reference_worker_lease`
  6. `006_terminal_transaction_protection`
  7. `007_ledger_finite_values`
- Idempotência: Na segunda subida ou reexecução do migrador, relata `No new migrations to apply.` sem reexecuções indevidas.
- `queues`: Cria as três filas FIFO no LocalStack 4.0.3 (`wager-transactions-dlq.fifo`, `wager-transactions.fifo`, `wager-events.fifo`) e aplica a política de redrive para a DLQ com `maxReceiveCount: 5`.

## Smoke Test Integrado (`infra/smoke-api.ts`)

O script de smoke valida o ciclo financeiro integrado fim a fim:
1. **Abertura**: `POST /wallets` com saldo inicial de `100.00 BRL` (201 Created) e leitura via `GET /wallets/:id` (200 OK).
2. **BET**: `POST /wagering/transactions` com débito de `25.00 BRL`, validando status `PROCESSED`, saldo resultante `75.00 BRL` e `idempotentReplay: false`.
3. **Replay**: Reenvio idêntico com mesma `idempotency-key`, retornando status `PROCESSED`, saldo `75.00 BRL` e `idempotentReplay: true`.
4. **Consultas Estritas**:
   - `GET /wagering/transactions/:transactionId`: Valida campos de valor e moeda consultados via `money.amount === '25.00'` e `money.currency === 'BRL'`, com status `PROCESSED` e kind `BET`.
   - `GET /wallets/:walletId/ledger`: Valida extrato contábil contendo exatamente 2 lançamentos (1 `CREDIT` de abertura de 100.00 e 1 `DEBIT` de aposta de 25.00), com `hasMore === false` e `nextCursor === null`.
5. **Reconciliação**: `POST /wallets/:walletId/reconciliation` comprovando consistência matemática exata (`consistent: true`, `difference: 0.00`, 2 lançamentos auditados).

## Validação e Resultados Reais

Validações executadas em 2026-10-17:

| Verificação | Comando | Ambiente | Resultado |
| :--- | :--- | :--- | :--- |
| **Compose Config** | `docker compose -f docker-compose.local.yml config` | Host Windows | OK (exit 0): 5 serviços e rede/volumes isolados |
| **Build da Imagem API** | `docker compose ... build` | Docker Engine (Linux x86_64) | OK (exit 0): Imagem `wagers-stab-isolated-app:bun-1.4.3` gerada |
| **Primeira Subida (Volume Novo)** | `docker compose ... up -d --wait` | Docker Compose (`wagers-stab-isolated`) | OK (exit 0): 7 migrations aplicadas com sucesso (001 a 007) |
| **Smoke Test no Contêiner** | `docker exec wagers-stab-isolated-app-1 bun run infra/smoke-api.ts` | Contêiner Linux (`bun:1.4.3`) | OK (exit 0): Abertura, BET, replay, consultas estritas e reconciliação aprovados |
| **Smoke Test no Host** | `bun run infra/smoke-api.ts` contra porta 3002 | Host Windows (`win32 x64`) | OK (exit 0): Todas as operações estritas concluídas com sucesso |
| **Typecheck Oficial** | `bun run typecheck` | Host Windows | OK (exit 0): 0 erros de compilação |
| **Suíte Oficial Completa** | `bun run test` (via `scripts/run-tests.ts`) | Host Windows contra PostgreSQL descartável (porta 5439) | OK (exit 0): 24 arquivos de teste, 0 falhas |
| **Provas M13 Isoladas** | `bun test tests/integration/financial-outbox-m13.test.ts` | Host Windows contra PostgreSQL descartável (porta 5439) | OK (exit 0): 28 testes aprovados, 0 falhas, 218 asserções |

### Documentação Exata dos Ambientes:
- **Smoke test**: Executado dentro do contêiner da aplicação (`oven/bun:1.4.3` em Linux x86_64 na rede interna do Docker) e no host Windows via porta publicada `3002`.
- **Suíte oficial de testes**: Executada no host Windows (`win32 x64`) com Bun 1.4.3 contra contêiner descartável PostgreSQL `16.6-alpine` na porta 5439 com tmpfs. O número oficial real de arquivos de teste é 24 (28 testes no M13).
- **Limitações e Escopo**: Não inclui implementação de publisher, consumidor de fila SQS, inbox ou DLQ listener (funcionalidades reservadas para os marcos M14–M16). As variáveis e filas SQS permanecem preparadas para futuro consumo. Nenhum publisher, consumidor, inbox ou worker foi alterado fora do escopo desta infraestrutura.

