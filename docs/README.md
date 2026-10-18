# Documentação e evidências

Comece pelo [README](../README.md) para executar e pela [arquitetura](../ARCHITECTURE.md) para decisões e limites atuais.

| Documento | Uso |
| --- | --- |
| [Observabilidade](delivery/OBSERVABILITY.md) | Semântica atual de logs, métricas e health |
| [Contrato externo](messaging/EXTERNAL-CONTRACT.md) | Entrada WagerTransactionRequested, identidade textual e migration 010 |
| [Comandos e inbox](messaging/M15-IMPLEMENTED.md) | Contrato implementado; confiabilidade complementada pelo documento seguinte |
| [Confiabilidade do consumidor](messaging/M16-RELIABILITY.md) | Visibilidade, retry, redrive e shutdown |
| [Arquitetura histórica](history/architecture.md) | Decisões detalhadas e evolução; exclusões de escopo são datadas |
| [Implementação histórica](history/implementation.md) | Relatos e resultados por etapa |
| [Observabilidade histórica](history/observability.md) | Integração e reprodução da etapa anterior, com limites datados |
| [Integração de infraestrutura histórica](history/infrastructure.md) | Proveniência e ensaios daquela base |
| [Revisão da entrega](review/VALIDATION.md) | Inventário, limpeza e reprodução atual |

`evidence/` conserva logs, resultados e scripts das execuções anteriores. Nomes M01–M21 são identificadores históricos, não requisitos para o avaliador. Contagens antigas não representam automaticamente a suíte atual.

Os documentos de proposta [entrada](messaging/INPUT-CONTRACT.md), [matriz](messaging/ACCEPTANCE-MATRIX.md), [transação e ack](messaging/TRANSACTION-AND-ACK.md) e [handoff](messaging/IMPLEMENTATION-HANDOFF.md) foram preservados para rastreabilidade. Para comportamento atual, prevalecem contratos implementados e código/migrations.
