> Contrato interno implementado na etapa histórica. Para renovação, retry, DLQ e shutdown atuais, veja [confiabilidade](M16-RELIABILITY.md); para entrada externa e migration 010, veja [contrato externo](EXTERNAL-CONTRACT.md).


Entrega atual: consulte [contrato externo confirmado](EXTERNAL-CONTRACT.md). A proposta abaixo é histórica; o consumidor aceita também WagerTransactionRequested e a migration 010 preserva identidades textuais.

# M15 — contrato implementado

Base: origin/main bf5d9fe886c55ee8b321df96f9fbacf837869584, obtida por fetch. Branch codex/m15-sqs-inbox; worktree .worktrees/m15-sqs-inbox. Os quatro documentos de proposta permanecem como histórico; este documento define as decisões efetivamente implementadas.

## Decisões D1–D8

- D1: envelope v1 ProcessWager conforme INPUT-CONTRACT. Campos extras, versão/tipo desconhecidos e dados inválidos falham sem delete. commandId é UUID canônico. Chave financeira trim 1–255; correlação/causação opcionais trim 1–255.
- D2: command_inbox, PK (consumer_name, command_id), FK transaction_id, fingerprint SHA256 de JSON [version, commandType, chave normalizada, hash financeiro]. Consumer wager-command-v1. Advisory lock transacional por identidade serializa duplicatas antes de ler a inbox. Colisão do hash do advisory lock apenas serializa trabalho adicional. Nenhuma retenção/expiração automática.
- D3: MessageGroupId deve igualar walletId canônico e MessageDeduplicationId deve igualar commandId. MessageId é apenas metadado persistido da primeira aceitação; ReceiptHandle permanece apenas na entrega atual e nunca é registrado. Metadados não participam do hash financeiro.
- D4: correlationId segue no DTO/caso de uso; causationId do produtor é auditada na inbox. A causalidade financeira existente não é alterada.
- D5: inválidos, conflitos e erros técnicos ficam sem delete para redelivery/redrive nativos. Diagnóstico estático com fase VALIDATION/TRANSACTION/DELETE; nenhum corpo financeiro, handle, credencial ou erro bruto. Não há envio manual à DLQ.
- D6: o consumidor passa externalTransaction ao ProcessWagerUseCase. Toda exceção escapa da UoW externa; não se tenta recuperação SQL em contexto rollback-only. Nova entrega abre nova UoW e resolve unicidades persistidas. Não existe retry imediato dentro da transação abortada.
- D7: processamento serial, receive com uma mensagem e long poll de 1 segundo, intervalo de 250ms e request timeout padrão de 5000ms. SQL usa os limites finitos existentes. OnModuleDestroy interrompe receives e aguarda loop/trabalho; BeforeApplicationShutdown fecha somente cliente próprio; ORM fecha em OnApplicationShutdown. Não há renovação de visibilidade.
- D8: provas e comandos em ../evidence/m15-sqs-inbox.md. Não há garantia exactly-once do transporte; a unicidade é financeira e persistente.

## Atomicidade e replay

ConsumeWagerCommand abre a UoW externa compartilhada. Comando novo usa ProcessWagerUseCase e insere a aceitação ligada ao resultado antes do commit. Inbox, carteira, transação, ledger e outbox confirmam/revertem juntos. A inbox não tem reserva confirmada nem snapshot independente: sua presença significa aceitação durável, inclusive REJECTED/PENDING_REFERENCE.

Mesma identidade/impressão lê a transação associada e valida o snapshot atual. Outra identidade com mesma chave/payload usa o replay financeiro e cria somente outra ligação inbox. Conteúdo divergente e conflitos preservam o original. Snapshot inválido falha fechado; saldo histórico nunca é reconstruído. Pendência é deletada após commit e segue pelo worker existente. Falha de delete ou confirmação perdida do commit não desfaz efeitos; nova entrega reconcilia pelas mesmas identidades.

## Configuração

SQS_CONSUMER_ENABLED=true habilita o loop (padrão false). WAGER_TRANSACTIONS_QUEUE_URL deve apontar explicitamente para a fila FIFO de comandos wager-transactions.fifo. URL ausente, não FIFO ou de wager-events é recusada quando habilitado. SQS_ENDPOINT, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY e SQS_REQUEST_TIMEOUT_MS seguem o padrão do adaptador SQS existente. Os dois componentes mantêm ownership independente; cliente injetado é emprestado e nunca destruído pelo consumidor.

## Evolução em M16

A política atual de retry/backoff, renovação finita de visibilidade, redrive/DLQ e shutdown com cancelamento seguro está em [M16 — confiabilidade do consumidor](M16-RELIABILITY.md). Esse documento atualiza D5/D7 e registra as provas de falhas e sinais OS, preservando o contrato de entrada, a atomicidade da inbox e o processamento financeiro M15 descritos acima.
