Atualização: M15 possui implementação e evidências nesta branch. Consulte [contrato final M15](M15-IMPLEMENTED.md); o texto abaixo preserva a proposta histórica.

# M15/M16 — transação e confirmação propostas

Especificação pendente de implementação. Base: `13009c73dabf7b7be7193cababd4e74f19372397`. Contrato de entrada em [INPUT-CONTRACT.md](INPUT-CONTRACT.md), provas em [ACCEPTANCE-MATRIX.md](ACCEPTANCE-MATRIX.md), decisões em [IMPLEMENTATION-HANDOFF.md](IMPLEMENTATION-HANDOFF.md).

## Existente e limites

[ProcessWagerUseCase.execute](../../src/application/use-cases/process-wager.use-case.ts) já controla idempotência financeira, snapshot e outbox. [MikroOrmUnitOfWork.runInTransaction](../../src/infrastructure/persistence/mikro-orm/mikro-orm-adapter.ts) usa AsyncLocalStorage: chamadas aninhadas compartilham EntityManager/transação, não fazem commit independente; erro aninhado marca rollback-only. A UoW externa é quem confirma o commit. [PersistenceModule](../../src/infrastructure/persistence/persistence.module.ts) exporta instâncias compartilhadas. Inbox e consumidor não existem na base.

`execute` retornar dentro de uma UoW externa significa apenas que o trabalho interno terminou. O delete depende do retorno bem-sucedido da UoW **externa**, nunca desse retorno intermediário. Não existe transação distribuída PostgreSQL/SQS; não aceitar promessa de exactly-once do transporte. A meta é efeito financeiro único apesar de entregas repetidas.

## Fluxo proposto M15

1. Receber somente da fila de comandos; guardar o receipt handle da entrega atual. Validar envelope e normalizar `data` conforme HTTP, antes de qualquer mutação financeira.
2. Abrir uma única UoW externa com o mesmo provider que será usado pelo caso de uso. Dentro dela, reservar/verificar a identidade Inbox com unicidade `(consumerName, commandId)` e lock; comparar a impressão do comando. A reserva não pode ficar confirmada sozinha antes do domínio.
3. Para comando novo, chamar `ProcessWagerUseCase.execute` na mesma UoW, associar transactionId e marcar Inbox como `ACCEPTED` (nome proposto). A marca significa comando duravelmente tratado, inclusive REJECTED e PENDING_REFERENCE, e não necessariamente aposta processada com movimento. Saldo, transação, ledger, eventos e Inbox confirmam ou revertem juntos.
4. Para mesma identidade/impressão já aceita, conferir a associação persistida. Resolver pelo resultado financeiro atual validado por snapshot; nunca executar novamente o movimento nem recriar eventos. Inbox não deve congelar um snapshot pendente que depois ficou terminal. Outra commandId com mesma chave/hash usa o replay do caso de uso e ganha sua própria associação Inbox atomicamente; o número de entradas Inbox pode exceder o número de transações financeiras.
5. Aguardar a confirmação do commit externo. Somente depois chamar DeleteMessage, fora da transação SQL, com receipt handle atual. Não esperar o publisher publicar a outbox para deletar o comando: a obrigação durável são as linhas da outbox, não o envio já realizado.

O tratamento de concorrência Inbox pode usar inserção com conflito tratável e leitura com lock, sem continuar SQL numa transação abortada. Detalhe SQL, índices e campos serão definidos em D2; nenhuma migration é entregue aqui.

## Colisões e rollback-only

O caso de uso captura algumas violações 23505 e consulta a transação vencedora em `runInTransaction`. Quando estiver aninhado, uma falha anterior pode ter marcado a UoW externa rollback-only: essa recuperação não constitui uma nova transação saudável. Critério obrigatório: abortar por inteiro a unidade externa, não confirmar Inbox nem fazer delete, e repetir/reconciliar **fora** do contexto abortado, em nova UoW. Não engolir TransactionRollbackOnlyError, não forçar commit nem abrir uma transação financeira independente enquanto a Inbox permanece noutra.

D6 deve fechar a estratégia mínima para esse caso. Testes futuros precisam provocar a colisão entre duas instâncias, inclusive em carteiras diferentes e entre HTTP/fila; happy path com lock da mesma carteira não cobre toda a disputa de chave global.

## Commit desconhecido e delete falho

Uma desconexão durante COMMIT ou exceção posterior ao commit pode deixar o chamador sem confirmação, embora o banco tenha persistido. Não declarar rollback apenas por timeout/erro e não deletar por suposição. Reconciliar por uma conexão/contexto saudável ou aguardar redelivery: localizar Inbox pela identidade, comparar impressão, localizar transação pela chave/par externo e validar associação e snapshot. Ausência em uma leitura isolada não prova rollback de um commit ainda em andamento; a nova tentativa precisa passar pelos mesmos locks/unicidades. Estados parciais ou snapshot incoerente exigem bloqueio/diagnóstico operacional, sem fabricar saldo, falha financeira ou novo resultado.

Se o commit aconteceu, o replay encontra o resultado e não repete ledger/outbox. Se não aconteceu, o processamento completo pode ser tentado novamente de forma atômica. Se o banco segue inacessível, conservar a mensagem sem delete. DeleteMessage falhar, retornar resultado incerto ou usar handle expirado não desfaz commit, não gera estorno e não apaga Inbox; admitir redelivery e fazer confirmação idempotente posterior. Um resultado financeiro não deve ser revertido porque uma API SQS falhou.

## Referência fora de ordem

PENDING_REFERENCE é aceitação durável, com snapshot e evento WagerTransactionPendingReference. Após commit da Inbox + domínio + outbox, deletar a mensagem original: a espera de referência passa a [ReprocessPendingReferencesUseCase](../../src/application/use-cases/reprocess-pending-references.use-case.ts) e [PendingReferenceWorkerService](../../src/infrastructure/workers/pending-reference-worker.service.ts), com leases já existentes. Não implementar segundo reprocessador no consumidor, nem incrementar attempts/next_attempt_at de negócio a cada entrega SQS. Redelivery retorna snapshot pendente ou terminal conforme estado atual. Retry de transporte e tentativas do worker são contadores distintos.

## Política proposta de erros e DLQ (D5)

| Classe | Efeito proposto | Ação de transporte |
| --- | --- | --- |
| Resultado REJECTED retornado e persistido pelo caso de uso | Inbox ACCEPTED, snapshot real e WagerTransactionRejected; sem movimento | Delete somente depois do commit. Não mandar à DLQ como se fosse falha técnica. |
| JSON/envelope/versão/data inválidos | Não chamar domínio; nenhuma Inbox ACCEPTED nem transação financeira | Não deletar; deixar redrive nativo encaminhar à DLQ após limite configurado. |
| Mesmo commandId com impressão divergente; chave divergente; par externo sob outra chave | Preservar original; rollback da nova tentativa, sem novo evento financeiro | Não deletar a entrega conflitante; redrive nativo para diagnóstico. Não classificar como replay bem-sucedido. |
| WalletNotFoundError, vínculo inválido, CurrencyMismatchError, InvalidMoneyError/MoneyOverflowError, validação de operação | Exceções não são automaticamente REJECTED persistido; rollback | Proposta: falha permanente para esta entrada, redrive; classificação de carteira que possa ser criada depois é decisão D5. |
| Falha transitória reconhecida de banco/lock/serialização | Reverter unidade completa ou reconciliar commit desconhecido | Não deletar; aguardar visibilidade/backoff limitado. Não incrementar tentativas financeiras. |
| ReplaySnapshotUnavailableError, erro de programação, erro técnico não classificado | Não inventar rejectionReason/failureCode financeiro; registrar diagnóstico sanitizado | Não deletar; retry limitado por redrive e diagnóstico DLQ. Não marcar Inbox ACCEPTED artificialmente. |

Esta política é uma proposta explícita conservadora, não comportamento implementado. Sem identidade válida, não criar uma Inbox fictícia baseada no SQS MessageId. Não exigir armazenar corpos inválidos nem credenciais em logs.

A infraestrutura local tem redrive nativo (`maxReceiveCount=5`). Sob essa proposta, o consumidor não faz SendMessage para a DLQ: a fila é responsável pela transferência depois das entregas elegíveis. Não exigir transferência exatamente na quinta chamada observada pelo teste; conferir configuração, evolução de ApproximateReceiveCount e eventual chegada, com prazo definido para o ambiente de prova. Não usar `wager-events.fifo` como DLQ.

Encaminhamento explícito à DLQ é alternativa **não escolhida por padrão**: exigiria enviar antes de deletar a origem, preservando identidade e diagnóstico. Se o envio confirmar mas o delete falhar, origem e DLQ podem coexistir; timeout no envio pode gerar cópias extras. Deduplicação FIFO não substitui deduplicação persistente no reprocessamento. Selecionar uma política em D5, sem misturar os dois caminhos inadvertidamente. Redrive/reenvio operacional deve preservar commandId, chave e payload originais; corrigir conteúdo sob a mesma identidade é conflito. Reprocessar uma DLQ pode encontrar comando já commitado.

## Retry, visibilidade e shutdown propostos M16

- Receber com concorrência limitada à capacidade do pool; não criar outra instância da UoW para o consumidor. Definir em D7 timeouts de receive, SQL/locks, visibilidade, renovação, backoff e prazo de drenagem, todos finitos e configuráveis. Long polling pendente deve poder ser cancelado.
- Em erro transitório, propor backoff exponencial limitado com jitter via ChangeMessageVisibility ou nova entrega após timeout; sem Sleep que retenha transação aberta. Valores concretos são decisão D7, não derivados do backoff de referência do worker.
- Se o processamento exceder visibilidade, renovar apenas a entrega ainda sob posse local, com margem e limite. Falha de renovação não concede exclusividade: outra instância pode receber. Locks, Inbox e idempotência financeira continuam obrigatórios. Não deletar com receipt handle de outra entrega.
- Em SIGTERM, bloquear novos polls e novos trabalhos, cancelar receive pendente e drenar os já iniciados. Manter renovações necessárias durante a drenagem, sem estendê-las indefinidamente. Ao atingir o prazo, sinalizar AbortSignal à UoW externa ainda em fase working, aguardar rollback e liberar/expirar visibilidade sem delete.
- Se COMMIT já foi enviado, aguardar resultado real/reconciliar; cancelamento não prova rollback. Nunca liberar ORM enquanto operação ainda o utiliza. Delete de unidade com commit confirmado pode ser tentado dentro do prazo; se não confirmar, permitir redelivery. Não iniciar novos retries durante shutdown.
- Fechar loops, timers de visibilidade, cliente SQS e só então permitir fechamento final dos recursos compartilhados, respeitando também os demais donos (worker existente e futuro publisher). Não usar shutdown global para cancelar transações de outro componente. Ordem precisa ser provada no Nest real, não por chamadas manuais dos hooks.

Tudo acima são critérios futuros; nenhum serviço ou teste foi executado nesta tarefa documental.
