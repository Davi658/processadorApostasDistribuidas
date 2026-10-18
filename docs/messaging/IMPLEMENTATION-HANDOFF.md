
Entrega atual: consulte [contrato externo confirmado](EXTERNAL-CONTRACT.md). A proposta abaixo é histórica; o consumidor aceita também WagerTransactionRequested e a migration 010 preserva identidades textuais.

Atualização: M15 possui implementação e evidências nesta branch. Consulte [contrato final M15](M15-IMPLEMENTED.md); o texto abaixo preserva a proposta histórica.

# M15/M16 — handoff para implementação futura

Estado: **M15/M16 não implementados por esta tarefa**. Somente critérios e desenho proposto. Não há migrations Inbox, consumidor ou alterações de runtime nesta entrega. M14 pertence ao Antigravity e continua independente.

## Proveniência e isolamento

- Repositório: `D:\processadorApostasDistribuidas`.
- Base mais recente disponível por inspeção local: `origin/main`, SHA `13009c73dabf7b7be7193cababd4e74f19372397`, igual à última base revisada informada (`13009c7`). A ref local `main` ainda apontava para `f73e308`; não foi movida. Não foi feito fetch nem afirmada atualização remota posterior.
- Branch: `codex/m15-m16-acceptance`.
- Worktree: `D:\processadorApostasDistribuidas\.worktrees\m15-m16-acceptance`.
- Apenas novos arquivos em docs/messaging/. Sem consulta ao repositório da empresa ou trabalho não aprovado da worktree M14. Sem testes, typecheck, Docker, serviços, bancos ou volumes; sem push/merge/publicação.

Documentos: [entrada](INPUT-CONTRACT.md), [matriz](ACCEPTANCE-MATRIX.md), [transação e ack](TRANSACTION-AND-ACK.md). Propostas aguardam decisões abaixo; referência a testes existentes significa fonte de reaproveitamento, não reexecução nesta tarefa.

## Componentes existentes para reutilizar

| Caminho / símbolos reais | Reuso e ponto de integração futuro |
| --- | --- |
| [wager.dto.ts](../../src/application/dto/wager.dto.ts): ProcessWagerDto, WagerResponseDto, WagerOperationKind; [common.dto.ts](../../src/application/dto/common.dto.ts): MoneyObjectDto | Payload normalizado e resultado; não criar motor financeiro SQS separado. |
| [http-validator.ts](../../src/interfaces/http/validation/http-validator.ts): HttpValidator.validateProcessWager, validateUuid, validateMoneyObject | Mesma validação/normalização do HTTP depois de validar o envelope. correlationId separado do data. Verificar limites que o header HTTP não valida; evitar refatoração ampla de fronteiras. |
| [process-wager.use-case.ts](../../src/application/use-cases/process-wager.use-case.ts): execute, computePayloadHash, canonicalStringify | Executar na UoW externa Inbox; deduplicação financeira já existe. Recuperação interna de 23505 sob UoW aninhada requer decisão D6 e prova específica. |
| [win-processor.service.ts](../../src/application/services/win-processor.service.ts): WinProcessor; [reversal-processor.service.ts](../../src/application/services/reversal-processor.service.ts): ReversalProcessor | Regras atuais de WIN, REFUND, ROLLBACK e pendências; consumidor não deve duplicar validações de referência/movimentos. |
| [snapshot.validator.ts](../../src/application/validators/snapshot.validator.ts): validateReplaySnapshot; [wager-transaction.entity.ts](../../src/domain/entities/wager-transaction.entity.ts): WagerTransaction | Validar snapshot histórico e transições; não guardar resposta pendente como única verdade Inbox. |
| [money.vo.ts](../../src/domain/value-objects/money.vo.ts): Money.create, MAX_LIMIT | Precisão decimal, magnitude e invariantes; sem float. |
| [domain.error.ts](../../src/domain/errors/domain.error.ts): IdempotencyConflictError, ReplaySnapshotUnavailableError, TransactionRollbackOnlyError, WalletNotFoundError, MoneyOverflowError | Classificar por tipo/causa; rejeição persistida retornada não equivale a toda exceção de domínio. |
| [domain-exception.filter.ts](../../src/interfaces/http/filters/domain-exception.filter.ts): DomainExceptionFilter | Referência para códigos transitórios e distinções HTTP; não reutilizar status HTTP como algoritmo de ack SQS. |
| [ports.ts](../../src/application/ports/ports.ts): UnitOfWorkPort, WagerTransactionRepositoryPort, OutboxRepositoryPort | Acrescentar porta Inbox mínima futuramente; manter contratos financeiros. |
| [mikro-orm-adapter.ts](../../src/infrastructure/persistence/mikro-orm/mikro-orm-adapter.ts): MikroOrmUnitOfWork.runInTransaction, getTransactionContext, getEntityManager, getActiveTransactionsCount, setTestHook, MikroOrmOutboxRepository | Persistência Inbox no mesmo EntityManager/transação; hooks before_commit/after_commit para provas futuras. Não criar outro pool. Não modificar internals de publisher. |
| [persistence.module.ts](../../src/infrastructure/persistence/persistence.module.ts): PersistenceModule; [app.module.ts](../../src/interfaces/http/app.module.ts): AppModule | Compartilhar instâncias financeiras e UoW no novo módulo consumidor; composição e export de ProcessWagerUseCase precisam ser planejados sem instância duplicada. |
| [reprocess-pending-references.use-case.ts](../../src/application/use-cases/reprocess-pending-references.use-case.ts): ReprocessPendingReferencesUseCase; [pending-reference-worker.service.ts](../../src/infrastructure/workers/pending-reference-worker.service.ts): PendingReferenceWorkerService | PENDING_REFERENCE já persistido é responsabilidade do worker, não do retry SQS. Reutilizar o padrão de drenagem e AbortSignal, sem alterar o worker nesta tarefa. |
| [events.ts](../../src/domain/events/events.ts): IntegrationEventEnvelope, IntegrationEvent.toEnvelope, WagerTransactionProcessedEvent, WagerTransactionRejectedEvent, WagerTransactionPendingReferenceEvent, WalletBalanceChangedEvent | Contrato da outbox existente; consumidor confirma persistência atômica, publisher futuro cuida do envio. Nenhum novo tipo de evento financeiro proposto. |
| [migrations](../../src/infrastructure/persistence/migrations/001_initial_schema.sql), [proteções terminais](../../src/infrastructure/persistence/migrations/006_terminal_transaction_protection.sql), [ledger finito](../../src/infrastructure/persistence/migrations/007_ledger_finite_values.sql) | Unicidades, FKs, ledger e transições existentes continuam valendo. Uma futura migration Inbox será específica e reversível, não alteração das migrations aprovadas. |
| [bootstrap-sqs.sh](../../infra/bootstrap-sqs.sh), [docker-compose.local.yml](../../docker-compose.local.yml), [infra/README.md](../../infra/README.md), [.env.example](../../.env.example) | Nomes/URLs e redrive já declarados; configuração de concorrência, visibilidade e SDK consumidor ainda ausente. Não executar a infraestrutura nesta tarefa. |
| [README](../../README.md), [ARCHITECTURE](../../ARCHITECTURE.md), [IMPLEMENTATION](../../IMPLEMENTATION.md), [evidência M13](../evidence/m13-financial-outbox.md), [M18-INTEGRATION](../../M18-INTEGRATION.md) | Fontes locais de garantias e fronteiras. Trechos antigos ainda chamam M10 de futuro; código e evidências mais recentes mostram o worker existente. Não inferir SQS pronto a partir dele. IMPLEMENTATION também tem rotulagem histórica de M15/publicação; estes documentos adotam comandos de entrada em M15 e retry/DLQ/shutdown em M16 conforme pedido atual. |

## Decisões pendentes, com proposta explícita

| ID | Decisão necessária | Proposta de partida e limite |
| --- | --- | --- |
| D1 | Envelope, versão e produtor de comandos | Envelope v1 ProcessWager com commandId próprio; exemplos de INPUT-CONTRACT. Não foi encontrado contrato externo aprovado para esse Body. Confirmar com quem produz os comandos. |
| D2 | Inbox: esquema, identidade, lock, retenção e replay | Unique consumerName/commandId, impressão versão/tipo/chave/hash, ligação transactionId e estado ACCEPTED atômico. Não incluir metadados SQS na identidade. Definir colunas/índices/retenção e permissões mínimas em migration futura; não expirar deduplicação financeira junto da Inbox. Política de metadados: primeiro aceite vence; snapshot financeiro continua autoridade. |
| D3 | Atributos FIFO e incompatibilidades | Grupo por walletId, dedup por commandId; validar atributos recebidos conforme política aprovada. Não depender de janela de deduplicação ou ordem para impedir débito duplo; comandos e eventos têm grupos/IDs independentes. |
| D4 | Correlação e causalidade | Entrada opcional até 255; fallback para chave, eventos imediatos mantêm causationId=chave. Causa anterior do comando fica em metadado Inbox. Worker tardio hoje gera nova correlação; decidir se isso é aceitável ou se preservar a original exige mudança mínima separada. Não prometer rastreabilidade contínua já existente. |
| D5 | Inválidos, conflitos, falhas permanentes e DLQ | Proposta conservadora: sem delete e redrive nativo já configurado (5); não criar rejeição financeira falsa. Classificar carteira ausente/inconsistência de snapshot e definir intervenção/reenvio operacional. Encaminhamento explícito só se aprovado com prova de duplicação; não adicionar listener DLQ ou recuperação automática opcional. |
| D6 | Colisões com UoW aninhada e commit desconhecido | Abortar unidade externa rollback-only e reconciliar/repetir numa nova UoW fora dela. Decidir necessidade de ajuste mínimo de integração ao caso de uso, sem transação independente para o domínio. Provar colisões globais e resultado de commit perdido. |
| D7 | Parâmetros finitos de execução/retry/shutdown | Definir limites de concorrência, receive/batch, visibilidade/renovação máxima, backoff com jitter, SQL/lock, drenagem e timeout SDK, compatíveis com capacidade do pool e janela do processo. Não transportar os números do retry de referências para SQS. |
| D8 | Versão final aprovada de M14 e dependências compartilhadas | Registrar SHA revisado ao integrar. Alinhar contrato final de publicação, client/config SDK compartilhados, ownership de shutdown e extensões do OutboxRepositoryPort. Não presumir leases, API ou arquivos do publisher em desenvolvimento. M15 pode ser provado com publisher desligado, auditando outbox no banco. |

## Sequência curta proposta

### M15 primeiro

1. Fechar D1–D4 e D6, mantendo independência de execução de M14. Criar apenas adaptador de entrada/validação e configuração mínima SQS; confirmar versão do SDK necessária (package.json da base ainda não inclui SDK AWS). Não incorporar dependência não revisada de outra worktree.
2. Criar migration/repositório Inbox com transação compartilhada, coordenador Inbox + ProcessWagerUseCase + resultado durável e DeleteMessage pós-commit. Fechar D5 para o comportamento inicial de mensagens inválidas/conflitantes; usar redrive nativo proposto até decisão diferente.
3. Comprovar equivalência HTTP/fila, cinco operações, rejeição persistida, replay/identidade divergente e PENDING_REFERENCE. Acrescentar concorrência de duas instâncias, rollback após cada escrita, falha de delete, crash antes/depois do commit e reconciliação de commit desconhecido. Reutilizar fixtures/ideias de [M05](../../tests/integration/mikro-orm-uow-m05.test.ts), [M09](../../tests/integration/wager-pending-replay-m09.test.ts), [M13](../../tests/integration/financial-outbox-m13.test.ts), [concorrência](../../tests/concurrency/concurrency.test.ts) e [hash](../../tests/unit/payload-hash.test.ts). Nenhum teste foi rodado agora.

### M16 depois da atomicidade de M15

1. Fechar D5/D7 e implementar retry transitório limitado, renovação de visibilidade e redrive/DLQ conforme política escolhida. Separar contadores de transporte das tentativas de referência financeira.
2. Implementar parada de polls, drenagem/cancelamento da UoW externa e ordem de fechamento dos recursos compartilhados. Revisar D8 quando M14 final estiver aprovado; não cancelar trabalho alheio.
3. Provar expiração da visibilidade com outra instância, erro de renovação, limite de redrive, mensagem efetivamente observada na DLQ, reenvio sem duplicar efeito e SIGTERM em processo OS/Nest real. Usar [provas M10](../../tests/integration/pending-reference-worker-m10.test.ts) como referência de barreiras, processos e shutdown, sem reutilizar filas/bancos concorrentes de outra frente. Anotar timeouts e versões reais, sem teste baseado apenas em sleep.

Não incluir funcionalidades opcionais, painéis, listener DLQ, novos eventos financeiros ou refatoração ampla. A evidência de M15/M16 deverá ser registrada na implementação futura, com recursos descartáveis exclusivos e teardown explícito, depois de liberar disputa de recursos com M14.

## Revisão documental desta entrega

Conferir que apenas os quatro documentos novos foram adicionados; resolver todos os links relativos; fazer parse estático dos cinco exemplos JSON e conferir envelope, identidade e referência com as regras descritas; comparar as decisões e a política de ack entre documentos; verificar whitespace com git diff --check. Isso é inspeção estática, não execução de testes/serviços. O SHA do commit final é informado na entrega da conversa para evitar autorreferência circular no arquivo.

Resultado real da inspeção estática: quatro documentos, 62 links relativos resolvidos e cinco exemplos JSON parseados e conferidos quanto a versão, tipo, unicidade de commandId, UUIDs, strings monetárias e referências por operação. A matriz contém A01–A24. Nenhum teste de aplicação, typecheck ou serviço executado. git diff --cached --check sem erros antes do commit.
