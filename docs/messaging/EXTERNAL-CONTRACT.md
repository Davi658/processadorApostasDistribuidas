# Contrato de entrada confirmado para a entrega

Fonte: enunciado fornecido localmente pelo candidato, seção 10, consultado em 18/10/2026. O arquivo original permanece fora deste commit. O nome localizado foi `referencias/ENUNCIADO_ORIGINA.md` no checkout principal.

O Body SQS externo contém `messageId`, `type: "WagerTransactionRequested"`, `occurredAt` e `data`. `data` contém os campos financeiros HTTP e **`idempotencyKey` obrigatória**. Não há geração automática da chave; o default provider/external é recomendação ao produtor, não fallback do consumidor. Valores monetários permanecem strings.

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

## Identidades

| Identidade | Fonte e utilização |
|---|---|
| Identidade lógica externa | `messageId` textual, normalizado por trim, 1–255 caracteres; não exige UUID. Inbox por `('wager-transaction-requested-v1', messageId)`. A coluna histórica `command_id` armazena esse valor diretamente. |
| Identidade interna | Envelope `ProcessWager` v1 preservado integralmente: `commandId` UUID, namespace `wager-command-v1`, chave no envelope. |
| Chave financeira | Externo: `data.idempotencyKey`; interno: `idempotencyKey`. Mesma unicidade global usada no HTTP. |
| SQS MessageId | Identifica o envio de transporte; persistido em `command_inbox.message_id` para auditoria. Não controla replay financeiro. |
| ReceiptHandle | Identifica a entrega corrente para delete/visibilidade; nunca é identidade financeira ou conteúdo de log. |

O fingerprint externo contém tipo, chave financeira normalizada e hash financeiro canônico. Exclui messageId, occurredAt e atributos SQS. Mesma identidade lógica com fingerprint divergente é conflito permanente. Outra identidade lógica com mesma chave e mesmo hash vincula nova inbox à transação financeira original. Outra chave para o mesmo provider/external mantém o conflito existente. Os namespaces impedem que um identificador externo colida com um comando interno de mesmo texto, mas compartilham a idempotência financeira.

O adaptador remove apenas `data.idempotencyKey` antes de reutilizar o validador e o use case existentes. Não modifica money, hash, snapshot, processamento, atomicidade ou delete pós-commit. Migration 010 converte UUIDs existentes para texto sem alterar seus valores. O down recusa atomicamente identidades externas não conversíveis em UUID; é necessário exportar/migrar esses registros antes de retroceder, nunca apagá-los silenciosamente.

## Decisões onde o enunciado não prescreve política

O exemplo usa UTC ISO com milissegundos; o adaptador aceita esse formato e rejeita datas inválidas. occurredAt não fornece ordenação, TTL ou identidade financeira. O envelope externo não define correlação/causação: mantém-se a política existente de correlação e causação pela chave financeira, sem inventar campos novos.

A seção 10 não prescreve MessageGroupId/MessageDeduplicationId. O produtor recomendado usa walletId como grupo e uma identidade de deduplicação SQS válida; a inbox continua responsável pela deduplicação persistente. O externo não exige que esses atributos sejam iguais ao messageId. O interno mantém a validação histórica de grupo walletId/dedup commandId. O script de teste externo usa dedup de transporte nova para comprovar inbox dentro da janela FIFO de cinco minutos.

Transporte é **at-least-once**. Uma confirmação do broker ou ausência de duplicatas durante a janela FIFO não constitui exactly-once. Eventos de saída continuam em `wager-events.fifo`, separados dos comandos.

Testes: `tests/unit/external-wager-contract.test.ts`, `tests/integration/external-wager-contract.test.ts`, suítes M15/M16 existentes e smoke da composição final. A prova de crash externo mata um processo real no hook depois do COMMIT e antes do delete, recebe novamente pelo SQS e compara registros completos por IDs.
