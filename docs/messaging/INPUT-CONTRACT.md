
Entrega atual: consulte [contrato externo confirmado](EXTERNAL-CONTRACT.md). A proposta abaixo é histórica; o consumidor aceita também WagerTransactionRequested e a migration 010 preserva identidades textuais.

Atualização: M15 possui implementação e evidências nesta branch. Consulte [contrato final M15](M15-IMPLEMENTED.md); o texto abaixo preserva a proposta histórica.

# M15/M16 — contrato de entrada proposto

Estado: especificação para revisão; consumidor, Inbox, retry SQS, DLQ e shutdown do consumidor **não implementados por esta tarefa**. Base de inspeção: `origin/main` local em `13009c73dabf7b7be7193cababd4e74f19372397`. Não houve consulta remota. Não foi localizado texto separado do desafio; as propostas abaixo não são requisitos externos comprovados.

Leia também [matriz](ACCEPTANCE-MATRIX.md), [transação e ack](TRANSACTION-AND-ACK.md) e [handoff](IMPLEMENTATION-HANDOFF.md).

## Existente na base

- [ProcessWagerDto / WagerResponseDto](../../src/application/dto/wager.dto.ts): cinco operações, `money`, referência opcional conforme operação e resultado com snapshot.
- [HttpValidator.validateProcessWager](../../src/interfaces/http/validation/http-validator.ts): valida e normaliza a entrada HTTP; `correlationId` chega separadamente, não dentro do body financeiro.
- [ProcessWagerUseCase.execute / computePayloadHash](../../src/application/use-cases/process-wager.use-case.ts): idempotência persistente por chave global; unicidade de `(providerId, externalTransactionId)`; hash financeiro canônico, independente da correlação e chave; carteira bloqueada antes da consulta de replay.
- [Money.create](../../src/domain/value-objects/money.vo.ts): decimal exato não negativo, duas casas, até `9999999999999999.99`. Não usar Number/float para parsing, comparação ou hash financeiro.
- [IntegrationEventEnvelope / IntegrationEvent.toEnvelope](../../src/domain/events/events.ts): contrato de **eventos de saída**, não contrato de comandos SQS de entrada.
- [bootstrap-sqs.sh](../../infra/bootstrap-sqs.sh): comandos em `wager-transactions.fifo`, DLQ em `wager-transactions-dlq.fifo`, eventos da outbox em `wager-events.fifo`; FIFO e `ContentBasedDeduplication=false`; redrive de comandos configurado com `maxReceiveCount=5`.
- [docker-compose.local.yml](../../docker-compose.local.yml): `WAGER_TRANSACTIONS_QUEUE_URL`, `WAGER_TRANSACTIONS_DLQ_URL`, `OUTBOX_EVENTS_QUEUE_URL`, `SQS_ENDPOINT`, região local `us-east-1` no bootstrap. Infraestrutura preparada não comprova consumidor funcional.

## Proposta de envelope v1

O Body SQS seria um objeto JSON estrito, sem wrapper SNS. Nomes e versão aguardam aprovação (D1 no handoff).

| Campo | Proposta | Uso |
| --- | --- | --- |
| `version` | Inteiro exatamente `1` | Versão do comando, independente da versão dos eventos de saída. Versão desconhecida é inválida. |
| `commandType` | String exatamente `ProcessWager` | Não aceitar `WagerTransactionProcessed` nem eventos de outbox como comando. |
| `commandId` | UUID normalizado, estável entre tentativas de envio do mesmo comando | Identidade lógica para Inbox, namespace do consumidor `wager-command-v1`; não é SQS MessageId. |
| `idempotencyKey` | String trim, 1–255 caracteres | Mesma identidade financeira usada no HTTP; global no banco atual, sem prefixar automaticamente no consumidor. |
| `correlationId` | Opcional, string trim não vazia, até 255 caracteres | Ausente: deixar o caso de uso recorrer à chave de idempotência. Proposta de limite explícito no envelope; o HttpValidator não limita esse header. |
| `causationId` | Opcional, string trim não vazia, até 255 caracteres | Causa anterior do comando, somente metadado Inbox nesta proposta. Não substituir causalidade dos eventos atuais. |
| `data` | Objeto com as chaves financeiras aceitas pelo HttpValidator | Passar a `validateProcessWager(data, idempotencyKey, correlationId)` e então a `ProcessWagerUseCase.execute`. |

Rejeitar propriedades desconhecidas no envelope e em `data`/`money`; não converter tipos silenciosamente. A validação do envelope é nova; o validador HTTP pode ser chamado pelo adaptador inicial sem mudança ampla de camadas. Traduzir a falha de validação para a política SQS descrita em [transação e ack](TRANSACTION-AND-ACK.md), não para resposta HTTP.

O `causationId` dos eventos emitidos por `ProcessWagerUseCase` permanece a chave de idempotência. `commandId`, SQS MessageId e ReceiptHandle não o substituem. No processamento tardio, `ReprocessPendingReferencesUseCase` hoje gera novas correlações com `crypto.randomUUID()`; preservar a correlação original ao longo desse worker é decisão D4, não garantia existente.

## Validação financeira equivalente ao HTTP

| Entrada | Regra existente a reutilizar |
| --- | --- |
| providerId, externalTransactionId, roundId, gameId | String, trim, 1–128; preservar caixa. |
| playerId, walletId | String UUID com hífens, trim e lowercase. Não aceitar identificador SQS. |
| kind | String trim/uppercase, BET/WIN/LOSS/REFUND/ROLLBACK; OPENING não entra por este contrato. |
| money.amount | String decimal canônica conforme DECIMAL_AMOUNT_REGEX do HttpValidator; sem espaços, sinal, expoente, zeros à esquerda ou número JSON. LOSS admite `0.00`; demais exigem positivo. Money.create aplica limite de magnitude. |
| money.currency | String trim/uppercase; HTTP aceita apenas BRL, embora Money suporte códigos ISO de três letras. Consumidor não deve ampliar a moeda. |
| referenceExternalTransactionId | REFUND/ROLLBACK: string obrigatória, trim, 1–128. WIN: opcional; null/ausência equivalem à ausência. BET/LOSS: referência não nula é proibida; null/ausência são aceitos e omitidos pelo validador atual. |
| carteira e referência | O caso de uso verifica existência, vínculo do jogador e moeda. WIN referenciada exige BET compatível; REFUND referencia BET; ROLLBACK referencia BET, WIN ou REFUND; reversões integrais e compatíveis, com proteção de saldo e reversão única por tipo. Não antecipar isso com lógica financeira no consumidor. |

Prova exigida: entradas normalizáveis equivalentes por HTTP e fila devem produzir o mesmo `computePayloadHash`; mudanças de commandId, correlação ou metadados SQS não alteram esse hash.

## Identidades e FIFO propostas

1. Inbox única por `(consumerName, commandId)`. Para o mesmo commandId, comparar uma impressão canônica de versão, commandType, chave normalizada e hash financeiro; divergência é conflito de comando. Excluir correlação/causação e metadados do transporte dessa impressão; preservar os primeiros metadados aceitos. Armazenar também `transactionId` para ligação ao resultado financeiro. Esquema e nomes físicos ainda pendentes (D2).
2. Outra commandId com a mesma chave e hash financeiro deve chegar ao replay existente e ser vinculada ao mesmo transactionId, sem novo efeito financeiro. Outra chave com o mesmo par provider/external continua conflito, mesmo com payload financeiro idêntico; o contrato atual não transforma isso em replay.
3. SQS `MessageId` identifica um envio do transporte; `ReceiptHandle` identifica a entrega usada para delete/visibilidade; nenhum deles deduplica o domínio.
4. Proposta FIFO: `MessageGroupId = walletId` canônico (serialização por carteira), `MessageDeduplicationId = commandId`. O produtor deve manter commandId entre tentativas do mesmo envio lógico. Estratégia final e validação dos atributos ficam em D3. Não prometer ordenação entre grupos nem usar a deduplicação FIFO como substituto da Inbox/banco.
5. Não consumir `wager-events.fifo` para executar apostas: isso realimentaria eventos como comandos. A definição final de atributos FIFO do publisher M14 é independente e ainda não aprovada aqui.

## Exemplos completos propostos

Cada bloco é um Body SQS independente. As referências e carteiras devem existir em fixtures compatíveis para sucesso; os exemplos não provam execução nem formam uma sequência obrigatória. Para cada envio: MessageGroupId igual ao walletId abaixo; MessageDeduplicationId igual ao commandId do bloco.

BET (debita 10.00):

```json
{"version":1,"commandType":"ProcessWager","commandId":"10000000-0000-4000-8000-000000000001","idempotencyKey":"demo-bet-1","correlationId":"demo-round-1","causationId":"demo-provider-request-1","data":{"providerId":"demo-provider","externalTransactionId":"bet-1","playerId":"20000000-0000-4000-8000-000000000001","walletId":"30000000-0000-4000-8000-000000000001","roundId":"round-1","gameId":"game-1","kind":"BET","money":{"amount":"10.00","currency":"BRL"}}}
```

WIN (credita 20.00; referência BET opcional, quando informada deve ser compatível):

```json
{"version":1,"commandType":"ProcessWager","commandId":"10000000-0000-4000-8000-000000000002","idempotencyKey":"demo-win-1","correlationId":"demo-round-1","data":{"providerId":"demo-provider","externalTransactionId":"win-1","playerId":"20000000-0000-4000-8000-000000000001","walletId":"30000000-0000-4000-8000-000000000001","roundId":"round-1","gameId":"game-1","kind":"WIN","money":{"amount":"20.00","currency":"BRL"},"referenceExternalTransactionId":"bet-1"}}
```

LOSS (neutro, mesmo quando o amount for positivo):

```json
{"version":1,"commandType":"ProcessWager","commandId":"10000000-0000-4000-8000-000000000003","idempotencyKey":"demo-loss-1","data":{"providerId":"demo-provider","externalTransactionId":"loss-1","playerId":"20000000-0000-4000-8000-000000000001","walletId":"30000000-0000-4000-8000-000000000001","roundId":"round-1","gameId":"game-1","kind":"LOSS","money":{"amount":"0.00","currency":"BRL"}}}
```

REFUND (crédito integral da BET referenciada):

```json
{"version":1,"commandType":"ProcessWager","commandId":"10000000-0000-4000-8000-000000000004","idempotencyKey":"demo-refund-1","data":{"providerId":"demo-provider","externalTransactionId":"refund-1","playerId":"20000000-0000-4000-8000-000000000001","walletId":"30000000-0000-4000-8000-000000000001","roundId":"round-1","gameId":"game-1","kind":"REFUND","money":{"amount":"10.00","currency":"BRL"},"referenceExternalTransactionId":"bet-1"}}
```

ROLLBACK (aqui débito integral de uma WIN confirmada; para BET seria crédito):

```json
{"version":1,"commandType":"ProcessWager","commandId":"10000000-0000-4000-8000-000000000005","idempotencyKey":"demo-rollback-1","data":{"providerId":"demo-provider","externalTransactionId":"rollback-1","playerId":"20000000-0000-4000-8000-000000000001","walletId":"30000000-0000-4000-8000-000000000001","roundId":"round-1","gameId":"game-1","kind":"ROLLBACK","money":{"amount":"20.00","currency":"BRL"},"referenceExternalTransactionId":"win-1"}}
```

Decisões antes da implementação: D1 envelope/versão, D2 Inbox/impressão/retenção, D3 FIFO, D4 causalidade/correlação. Todas detalhadas no [handoff](IMPLEMENTATION-HANDOFF.md).
