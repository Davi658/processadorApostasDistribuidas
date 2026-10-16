# Plano de execução e critérios de aceite

## 1. Fundação de domínio — iniciada

Implementados Money, Wallet e WalletLedgerEntry, com sete testes.
Faltam WagerTransaction, estados terminais, reversões, eventos, inbox e outbox.

Validação executada neste ambiente:

    node --experimental-strip-types --test tests/unit/*.test.ts

Resultado: sete testes passaram em Node 24.19.0. Bun e Docker indisponíveis.
O resultado não certifica execução em Bun nem equivale a uma checagem estática TypeScript.
Com Bun disponível, executar `bun run test:unit`.

## 2. Persistência e primeira fatia HTTP

Adicionar NestJS, MikroORM e dependências com lockfile gerado por Bun.
Implementar Compose com PostgreSQL e LocalStack, migrations up/down e credenciais locais.
Entregar abertura e consulta de wallet; provar OPENING, unicidade e reconciliação.
Implementar BET com idempotência persistida e snapshot da resposta.
Aceite: 50 submissões paralelas geram um débito; duas BET de 80 sobre saldo 100
produzem exatamente uma rejeição e saldo 20 em três processos reais.

## 3. Operações e referências

WIN, LOSS, REFUND e ROLLBACK; validar identidade, moeda, rodada, valor e tipo da referência.
Definir códigos de falha estáveis, conflitos HTTP e política para dependência rejeitada.
Aceite: reversão duplicada, reversão sem saldo e referência fora de ordem cobertas em banco real.

## 4. Mensageria e recuperação

Inbox e outbox na mesma transação financeira; publishers concorrentes; consumidores SQS;
retry, DLQ, shutdown e worker de referências pendentes.
Aceite: morte após commit/antes do ack, indisponibilidade temporária e reinício não duplicam efeitos.

## 5. Entrega

Logs JSON, métricas, health, paginação opaca e estável, documentação e CI.
Aceite: todos os cenários obrigatórios do README executados com PostgreSQL/SQS reais,
reconciliação consistente ao final e limitações descritas sem alegações não demonstradas.

## Limite de escopo

Não investir inicialmente em frontend, autenticação externa, dashboard ou teste de carga opcional.
Os critérios financeiros obrigatórios precedem os diferenciais.
