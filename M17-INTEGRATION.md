# M17 — Consultas e paginação

Branch: `codex/m17-queries-pagination`.
Base da main local: `6acc7c3500af9bbd56c340aeca3ccdfcfa056aa1`.
Worktree: `D:/processadorApostasDistribuidas/.worktrees/m17-queries-pagination`.
Infraestrutura preservada na branch `codex/local-infrastructure` (HEAD `4528b05`).

## Integração pendente por reserva do AppModule

Os arquivos reservados ao Antigravity não foram modificados. Nenhuma dependência
impediu implementar ou testar as consultas isoladamente. A ativação das rotas na
aplicação principal depende desta alteração posterior em
`src/interfaces/http/app.module.ts`, quando liberado pelo responsável por M10:

```ts
import { FinancialQueriesModule } from './financial-queries.module';

@Module({
  imports: [FinancialQueriesModule], // acrescentar às imports existentes
  // manter controllers e providers existentes
})
export class AppModule {}
```

Não registrar novamente os controllers/providers desse módulo no AppModule.
O módulo abre seu próprio pool com `getAppDatabaseConfig()` e
`default_transaction_read_only=on`; fecha esse pool no shutdown. Não injeta UoW,
worker ou processadores. Usa apenas SELECTs parametrizados e o índice existente
`idx_wallet_ledger_entries_wallet_created`; não exige migration.

## Contratos HTTP

| Rota GET | Resultado |
| --- | --- |
| `/wagering/transactions/:transactionId` | Projeção da transação armazenada |
| `/wagering/transactions?providerId=...&externalTransactionId=...` | Mesma projeção, pela identidade composta |
| `/wallets/:walletId/ledger?limit=50&cursor=...` | `{ items, nextCursor }` |

Transação: `transactionId`, `walletId`, `playerId`, `providerId`,
`externalTransactionId`, `roundId`, `gameId`, `kind`, `status`, `money`,
`referenceExternalTransactionId`, `failureCode`, `createdAt`, `updatedAt`.
Campos opcionais ausentes são `null`. Não expõe hash, chave de idempotência,
snapshots nem dados de lease. Retorna HTTP 200 para qualquer status armazenado:
consulta não executa a operação financeira nem aplica a semântica de POST/replay.

Item do ledger: `id`, `walletId`, `transactionId`, `entryType`, `money`,
`balanceBefore`, `balanceAfter`, `createdAt`. Todos os objetos monetários usam
`{ amount: string, currency: string }`, inclusive zero e máximo NUMERIC(18,2),
sem passagem por number. Timestamps UTC têm seis casas fracionárias.

UUID inválido, identificadores ausentes/vazios/acima de 128 caracteres, parâmetros
repetidos de identidade/limit/cursor, limit fora de 1–100 ou não inteiro canônico,
cursor inválido ou de outra carteira: HTTP 400. Transação ou carteira inexistente:
HTTP 404. Carteira existente sem lançamentos: HTTP 200 com lista vazia e cursor null.
Padrão de limit: 50. Fim da consulta: `nextCursor: null`.

Ordem crescente `(created_at, id)`, com comparação estrita da mesma tupla.
Cursor versionado base64url transporta carteira, timestamp exato PostgreSQL e UUID;
o cliente deve reutilizá-lo sem interpretar ou construir seu conteúdo. O formato
é opaco por contrato, não criptografado/assinado e não constitui autorização.
Validação impede reutilização direta em outra carteira. Autorização continua
sendo responsabilidade da camada de acesso da aplicação.

Cada página lê o estado commitado no momento da consulta, sem snapshot persistente
entre requisições. Novos lançamentos após a posição podem aparecer nas próximas
páginas; inserções retroativas anteriores à posição exigem reiniciar a leitura.
A imutabilidade do ledger e a comparação estrita impedem repetição dos IDs já lidos.

## Validação reproduzível

PostgreSQL real local, cluster exclusivo em `.data/m17-postgres`, loopback porta
5547. A suíte cria um banco `m17_*`, aplica as migrations existentes, usa app_user
sem privilégios administrativos e remove o banco no teardown. Nenhum banco de
desenvolvimento é usado. Binários PostgreSQL locais foram usados sem Docker.

```powershell
$env:APP_DB_PORT = '5547'
$env:MIGRATION_DB_PORT = '5547'
bun run typecheck
bun test tests/integration/financial-queries-m17.test.ts tests/unit
bun test tests/integration/http-endpoints.test.ts tests/integration/money-postgres-roundtrip.test.ts tests/integration/wallet-opening.test.ts
```

A suíte M17 sobe Nest com o próprio módulo e faz requisições HTTP reais. Cobre
os estados armazenados, valores monetários zero/centavo/máximo, identidade composta,
400/404, limites, 105 lançamentos com timestamps iguais, UUIDs fora da ordem de
inserção, microssegundos distintos dentro do mesmo milissegundo, cursor de outra
carteira, repetição determinística de páginas e travessia sem duplicações.
Compara integralmente as quatro tabelas antes/depois, incluindo saldo, versão,
tentativas, agendamento e lease, para comprovar ausência de efeitos financeiros.

## Resultados

- `bun run typecheck`: passou.
- M17: 9 testes passaram, zero falhas.
- Unitários: 39 testes passaram, zero falhas.
- Regressão HTTP, Money/PostgreSQL e abertura: 60 testes passaram, zero falhas.
- Total: 108 testes passaram. Nenhum teste ignorado ou mock de PostgreSQL.
- Bancos descartáveis removidos ao final; cluster exclusivo encerrado após validação.
- Diff completo em `.data/M17.diff` (inclui os seis arquivos novos).

## Discriminação dos 108 testes e códigos de saída

Resultados das execuções finais bem-sucedidas da implementação, em 17/10/2026.
Os códigos abaixo correspondem aos comandos executados naquela rodada; esta
preparação para revisão não reexecuta o banco nem modifica código de produção.
Contagens são de casos `it` executados; loops internos de cenários não são
contados como testes adicionais. Não somar novamente a reexecução final de M17.

| Arquivo | Casos aprovados | Exercita M17 diretamente? |
| --- | ---: | --- |
| `tests/integration/financial-queries-m17.test.ts` | 9 | Sim: módulo, controller e SQL novos via HTTP real |
| `tests/unit/money.test.ts` | 21 | Não: regressão do domínio monetário |
| `tests/unit/payload-hash.test.ts` | 6 | Não: regressão da idempotência |
| `tests/unit/wallet-ledger-entry.test.ts` | 5 | Não: invariantes dos lançamentos |
| `tests/unit/wallet.test.ts` | 7 | Não: agregado carteira |
| `tests/integration/http-endpoints.test.ts` | 21 | Não: endpoints preexistentes do AppModule |
| `tests/integration/money-postgres-roundtrip.test.ts` | 9 | Não: precisão monetária e overflow no PostgreSQL |
| `tests/integration/wallet-opening.test.ts` | 30 | Não: abertura, concorrência, rollback e contratos existentes |
| **Total único** | **108** | **9 específicos + 99 de regressão** |

Comandos executados na raiz do worktree M17, com `APP_DB_PORT=5547` e
`MIGRATION_DB_PORT=5547` para os testes PostgreSQL:

| Comando | Resultado | Exit code |
| --- | --- | ---: |
| `bun run typecheck` | TypeScript sem erros; conferido novamente após a última alteração | 0 |
| `bun test tests/integration/financial-queries-m17.test.ts tests/unit` | 48 pass, 0 fail (9 M17 + 39 unitários) | 0 |
| `bun test tests/integration/http-endpoints.test.ts tests/integration/money-postgres-roundtrip.test.ts tests/integration/wallet-opening.test.ts` | 60 pass, 0 fail | 0 |
| `bun test tests/integration/financial-queries-m17.test.ts` | Reexecução final: 9 pass, 0 fail, 99 assertions | 0 |

Os nove casos específicos de M17 verificam:

1. Mesma projeção por UUID e identidade composta; máximo monetário e exclusão de campos internos.
2. 404 por UUID ausente, provider incorreto, ID externo incorreto e carteira ausente.
3. Cinco estados armazenados com valor zero, retornados sem processamento ou replay.
4. Limites 50/100, travessia de 105 lançamentos empatados e isolamento da carteira.
5. 400 para UUID inválido e identificadores ausentes, repetidos, vazios ou longos.
6. Travessia com páginas de um item, empate exato e microssegundos, sem duplicações.
7. Páginas repetíveis, saldos monetários textuais, débito, carteira vazia e cursor final null.
8. Limites/cursors malformados, versão desconhecida, data inválida, ano zero e outra carteira.
9. Igualdade integral das quatro tabelas após as leituras; também repetida no teardown.

## Como as rotas foram registradas nos testes

Sim: a suíte específica executa
`NestFactory.create(FinancialQueriesModule, { logger: false })`, depois
`app.listen(0, '127.0.0.1')`. O Nest registra `FinancialQueriesController` pelo
metadata `controllers` do módulo, resolve o provider `FinancialQueriesPort` e
serve as três rotas GET novas numa porta TCP efêmera. As chamadas usam `fetch`
contra esse servidor real e o pool acessa o banco PostgreSQL descartável.
Não se trata de chamadas diretas aos métodos do controller nem de mocks HTTP.

A suíte preexistente `http-endpoints.test.ts` sobe `AppModule` e instala
`DomainExceptionFilter`. A suíte M17 sobe somente `FinancialQueriesModule`, sem
esse filtro global e sem providers financeiros ou worker. As validações 400/404
de M17 usam exceções HTTP padrão do Nest. Portanto, o teste comprova o módulo
isolado, mas não comprova a composição com o AppModule, o filtro global e os
hooks de ciclo de vida de toda a aplicação.

O AppModule principal permanece sem importar `FinancialQueriesModule`; as novas
rotas ainda não estão ativas nele. A integração continua apenas como instrução
acima e deve aguardar o encerramento das edições do Antigravity.

Não houve push, merge ou integração. A revisão é entregue como commit local
contendo exclusivamente os seis arquivos de M17; o hash está no manifesto do ZIP.
