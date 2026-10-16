# Arquitetura e Decisões Técnicas — Processador de Apostas Distribuídas

Este documento detalha as decisões de engenharia, garantias formais, modelagem contábil, estratégias de concorrência e idempotência, mecanismos de proteção no PostgreSQL e a integração transacional do projeto.

---

## 1. Visão Geral e Estrutura Arquitetural

O projeto segue os princípios de **Clean Architecture** e **Domain-Driven Design (DDD)**, mantendo regras de negócio puras, livres de dependências externas ou acoplamentos a frameworks:

```
src/
├── domain/                      # Núcleo de negócio puro (zero dependência de ORM/NestJS)
│   ├── entities/               # Wallet, WagerTransaction, WalletLedgerEntry
│   ├── value-objects/          # Money (BigInt em centavos, imutável)
│   ├── errors/                 # Erros de domínio tipados
│   └── events/                 # IntegrationEvent<T> e subclasses de eventos de integração
│
├── application/                 # Casos de uso e portas de entrada/saída
│   ├── use-cases/              # CreateWallet, GetWallet, ProcessBet, ReconcileWallet
│   ├── dto/                    # DTOs de entrada e saída alinhados aos contratos HTTP
│   └── ports/                  # Interfaces de repositórios e Unit of Work transacional
│
├── infrastructure/              # Adaptadores de persistência e banco de dados
│   ├── config/                 # Centralização de credenciais e opções de banco
│   └── persistence/
│       ├── migrations/         # Migrations SQL reversíveis incrementais (001 e 002)
│       ├── mikro-orm/          # Configuração, entidades e MikroOrmUnitOfWork
│       ├── postgres/           # Adaptadores unificados (sem duplicidade de UoW)
│       └── migrator.ts         # Runner com advisory lock e tracking em schema_migrations
│
└── interfaces/
    └── http/                   # Camada de apresentação HTTP
        ├── controllers/        # WalletController, WageringController (NestJS)
        ├── filters/            # DomainExceptionFilter (mapeamento HTTP consistente)
        ├── validation/         # HttpValidator (validador de fronteira em tempo de execução)
        └── app.module.ts       # Módulo principal da aplicação NestJS
```

---

## 2. Modelagem do Domínio Financeiro

### 2.1 Objeto de Valor Monetário (`Money`)
- **Representação Interna:** `BigInt` representando centavos inteiros (`100 cents = 1.00 BRL`).
- **Eliminação de Ponto Flutuante:** `number` em JavaScript/TypeScript segue o padrão IEEE 754 (ponto flutuante de precisão dupla), o que introduz imprecisões e arredondamentos imprevisíveis. O uso de `BigInt` elimina completamente esse risco sem adicionar dependências externas de runtime.
- **Validação de Entrada:** Aceita exclusivamente strings com exatamente duas casas decimais (`/^\d+\.\d{2}$/`). Notações científicas, `NaN`, `Infinity`, números float ou valores com mais de duas casas são terminantemente rejeitados na construção.
- **Moeda e Imutabilidade:** Operações aritméticas entre moedas distintas disparam `CurrencyMismatchError`. Cada instância é congelada com `Object.freeze`.

### 2.2 Agregado `Wallet`
- **Construtor Privado e Factories:** Instanciação controlada via `Wallet.create()` (nova carteira) e `Wallet.rehydrate()` (restauração do banco).
- **Semântica de Abertura:**
  - *Com saldo inicial positivo:* Cria a carteira, gera uma transação com tipo `OPENING` e emite um lançamento contábil no ledger com tipo `CREDIT`. A versão resultante permanece estritamente **1**.
  - *Com saldo inicial zero explícito (`"0.00"`):* Cria a carteira com saldo zero, sem transação de abertura, sem lançamento no ledger e sem eventos de outbox. A versão inicial é **1**.
- **Controle de Versão:** A propriedade `version` inicia em 1 e é incrementada apenas quando há alteração real de saldo (débito ou crédito aprovado). Transações rejeitadas ou consultas não alteram a versão.
- **Invariante de Não-Negatividade:** Saldo negativo é proibido tanto na entidade quanto no banco de dados.

### 2.3 `WalletLedgerEntry` (Ledger Contábil Imutável)
- Cada movimentação financeira aprovada gera uma entrada imutável no livro-razão contábil.
- **Verificação de Aritmética Interna:** A entidade valida no momento da instanciação:
  - `CREDIT`: `balance_after == balance_before + amount`
  - `DEBIT`: `balance_after == balance_before - amount`

### 2.4 `WagerTransaction`
- Registra cada operação de aposta (`BET`) ou transação interna (`OPENING`).
- Mantém o status final (`PROCESSED` ou `REJECTED`), o motivo de falha quando aplicável (`INSUFFICIENT_FUNDS`), o hash canônico de negócio e o snapshot do saldo observado para permitir replay idempotente seguro.

---

## 3. Integração MikroORM e Unidade de Trabalho

A persistência operacional foi integrada ao **MikroORM** de ponta a ponta, eliminando unidades de trabalho duplicadas:

### 3.1 Ciclo de Vida e Isolamento Transacional
- **Gerenciamento do Ciclo:** O MikroORM é inicializado no startup do NestJS (`MikroORM.init()`) e encerrado graciosamente no fechamento da aplicação (`orm.close()`) através dos hooks `onModuleInit` e `onModuleDestroy`.
- **Isolamento de Contexto via AsyncLocalStorage:** Cada requisição concorrente obtém um `EntityManager` transacional isolado via `EntityManager.transactional()`. Não existe `EntityManager` global compartilhando estado ou instâncias de entidades entre requisições.
- **Unidade de Trabalho Única (`MikroOrmUnitOfWork`):**
  - Carteira, transação de aposta, lançamentos de ledger e mensagens da outbox são persistidos sob a **mesma conexão e mesma transação SQL**.
  - Repositórios acessam o `EntityManager` associado à transação ativa da requisição corrente.
  - O lock pessimista é aplicado explicitamente à linha da carteira via `LockMode.PESSIMISTIC_WRITE` (`FOR UPDATE`).
  - Chamadas a `em.persistAndFlush()` garantem a ordem relacional correta de escrita respeitando as chaves estrangeiras.

---

## 4. Garantias e Proteções no Banco de Dados (PostgreSQL)

A integridade do sistema é reforçada por constraints relacionais, foreign keys compostas e triggers em nível de banco de dados (migrações `001_initial_schema` e `002_reinforce_schema_and_outbox`):

### 4.1 Schema e Constraints Estruturais
1. **Unicidade de Carteira:** `uq_wallets_player_currency` em `(player_id, currency)`.
2. **Unicidade de Chave de Idempotência:** `uq_wager_transactions_idempotency_key` em `idempotency_key`.
3. **Unicidade de Operação Externa do Provedor:** `uq_wager_transactions_provider_external` em `(provider_id, external_transaction_id)`.
4. **Saldo Não Negativo:** `chk_wallets_balance_non_negative` (`balance >= 0`).
5. **No Máximo um Lançamento por Transação e Carteira:** `uq_wallet_ledger_entries_tx_wallet` em `(transaction_id, wallet_id)`.
6. **Integridade Referencial Composta:** Foreign key composta `fk_ledger_wallet_currency` ligando `wallet_ledger_entries(wallet_id, currency)` diretamente a `wallets(wallet_id, currency)` para garantir que a moeda do lançamento coincida com a moeda da carteira.
7. **Validação de Tipos e Estados Permitidos:** `chk_wager_tx_kind` (`OPENING`, `BET`) e `chk_wager_tx_status` (`PROCESSED`, `REJECTED`).
8. **Requisitos de Hash e Snapshot para Apostas:** `chk_wager_tx_bet_contract` exige `idempotency_hash` e `observed_balance` preenchidos quando `kind = 'BET'`.

### 4.2 Correspondência entre Saldo da Carteira e Ledger
É fundamental distinguir o que é protegido pelo schema do que depende do protocolo transacional:
- **Protegido pelo Schema:**
  - A integridade referencial entre as tabelas;
  - A unicidade de lançamento por `(transaction_id, wallet_id)`;
  - A correspondência estrita da moeda entre carteira e ledger via foreign key composta `(wallet_id, currency)`;
  - A consistência aritmética local de cada linha de ledger (`balance_after = balance_before +/- amount`);
  - A imutabilidade do ledger (bloqueio total de `UPDATE` e `DELETE`).
- **Dependente do Protocolo Transacional:**
  - A consistência global e contínua entre o saldo consolidado na carteira (`wallets.balance`) e a soma histórica cumulativa de todas as entradas do ledger (`wallet_ledger_entries`).
  - O `CHECK` de aritmética local valida a transição de um único registro isolado, mas **não é suficiente por si só para garantir a consistência global**. A equivalência global depende estritamente do protocolo transacional: a transação única que serializa as operações sob lock pessimista `FOR UPDATE` na carteira e grava atomicamente a mutação da carteira junto com o registro de ledger correspondente.

### 4.3 Triggers de Proteção no PostgreSQL
1. **Imutabilidade do Livro-Razão (`trg_protect_wallet_ledger_entries`):**
   Bloqueia qualquer operação de `UPDATE` ou `DELETE` na tabela `wallet_ledger_entries`, disparando exceção `55000`.
2. **Preservação de Estados Terminais (`trg_protect_terminal_wager_transactions`):**
   Impede que uma transação já gravada em estado terminal (`PROCESSED` ou `REJECTED`) sofra alterações em status, valores monetários ou identidades de auditoria.

### 4.4 Princípio do Menor Privilégio (`app_user`)
- O usuário operacional `app_user` possui permissões estritamente delimitadas para DML (`SELECT`, `INSERT`, `UPDATE` em wallets/transactions, `SELECT`, `INSERT` em ledger).
- O privilégio `TRUNCATE` foi expressamente revogado de todas as tabelas para o usuário de aplicação.
- `app_user` não é proprietário das tabelas nem superusuário.

---

## 5. Idempotência e Tratamento de Concorrência

### 5.1 Hash Canônico de Idempotência
Para garantir que a chave de idempotência represente exatamente a intenção de negócio:
- **Campos Normalizados:** `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency`.
- **Política de Normalização:** Espaços em branco externos são normalizados; campos numéricos não são convertidos em float; as chaves JSON são ordenadas lexicograficamente de forma recursiva antes do cálculo do SHA-256.

### 5.2 Resolução de Conflitos e Tratamento do Erro 23505
Quando duas requisições idênticas concorrentes atingem o banco simultaneamente:
1. Uma transação adquire o lock e conclui o `INSERT`.
2. A segunda transação sofre violação de unicidade (`PostgreSQL 23505`).
3. **Resolução Fora da Transação Abortada:** Uma transação PostgreSQL abortada não permite novas consultas. O `MikroOrmUnitOfWork` captura a violação, executa `ROLLBACK` completo e o caso de uso consulta o snapshot já confirmado em uma nova leitura limpa.
4. Se o hash coincidir, retorna o **replay idempotente** (`idempotentReplay: true`) preservando o `transactionId`, `status`, `balance` e `failureCode` originais. Se o hash divergir, mapeia para `409 Conflict`.

---

## 6. Eventos de Domínio e Transactional Outbox

### 6.1 Hierarquia de Eventos
- Classe abstrata `IntegrationEvent<T>` contendo:
  - `eventId`: UUID v4 estável, reutilizado como chave primária da outbox;
  - `eventType`: string que identifica o tipo do evento;
  - `version`: versão do contrato do evento;
  - `aggregateId`: ID da entidade raiz (ex.: `walletId` ou `transactionId`);
  - `correlationId`: ID de correlação propagado pela requisição;
  - `causationId`: ID causador opcional;
  - `occurredAt`: data e hora serializadas em ISO-8601;
  - `data`: payload específico contendo valores monetários no formato `{ amount, currency }`.
- Subclasses concretas:
  - `WagerTransactionProcessedEvent` (`eventType: "wager.transaction.processed"`);
  - `WagerTransactionRejectedEvent` (`eventType: "wager.transaction.rejected"`);
  - `WalletBalanceChangedEvent` (`eventType: "wallet.balance.changed"`).

### 6.2 Regras de Emissão
- **Abertura Positiva:** Gera transação `OPENING`, lançamento `CREDIT`, e eventos `WagerTransactionProcessedEvent` e `WalletBalanceChangedEvent`.
- **Abertura Zero:** Não gera transação, nem lançamento no ledger, nem eventos de outbox.
- **BET Aprovada:** Gera `WagerTransactionProcessedEvent` e `WalletBalanceChangedEvent`.
- **BET Rejeitada:** Gera `WagerTransactionRejectedEvent` (sem evento de alteração de saldo).
- **Replay Idempotente:** Não emite novos eventos para a outbox.

---

## 7. Validação de Fronteira HTTP

Todas as entradas passam pelo `HttpValidator` antes da execução do domínio:
- Validação estrita de tipos em tempo de execução (JSON bruto analisado sem coerções indesejadas);
- Rejeição de números nos campos de dinheiro (`amount` deve ser string com duas casas decimais);
- Rejeição de strings vazias, valores nulos ou booleanos onde se espera dinheiro ou IDs;
- Validação de UUID v4 via regex nas identidades;
- Proibição de propriedades inesperadas (unknown fields);
- O cabeçalho `Idempotency-Key` é obrigatório e limitado a 255 caracteres;
- Preservação de erros nativos do NestJS (`HttpException`) e mascaramento de detalhes internos de SQL sob respostas 500 genéricas.

---

## 8. Testes Automatizados e Evidências

O sistema conta com 58 testes automatizados executados com Bun 1.4.3 e PostgreSQL 16.8 real:

1. **Testes Unitários de Domínio (24 testes):**
   - Imutabilidade e aritmética de `Money` (adição, subtração, validação decimal estrita, rejeição de moedas divergentes).
   - Invariantes aritméticas em `WalletLedgerEntry` (`CREDIT` e `DEBIT`).
   - Ciclo de vida e versionamento em `Wallet`.
2. **Testes de Integração com PostgreSQL Real (17 testes):**
   - Criação de carteira com saldo positivo e zero;
   - Processamento de BET e rejeição por saldo insuficiente;
   - Replay idempotente com preservação de saldo original;
   - Conflitos de idempotência (mesma chave/payload divergente; transação externa concorrente);
   - Injeção de falhas atômicas (`after_wallet_save`, `after_tx_save`, `after_ledger_save`, `after_outbox_save`) comprovando ausência de estado parcial após rollback;
   - Verificação das proteções do banco (trigger de imutabilidade do ledger, trigger de estado terminal, proibição de TRUNCATE para `app_user`).
3. **Testes de Migrações Reversíveis (1 teste):**
   - Criação de banco descartável isolado, execução de migrações UP (`001` e `002`), verificação das tabelas e triggers, execução de DOWN (`002` e `001`) e verificação da limpeza completa.
4. **Testes de Fronteira HTTP (13 testes):**
   - Contratos de POST e GET para carteiras e apostas;
   - Rejeição de tipos incorretos, campos ausentes, propriedades adicionais e formatação monetária inválida.
5. **Testes de Alta Concorrência (3 testes):**
   - 50 submissões simultâneas da mesma aposta (resultando em exatamente 1 débito e 49 replays consistentes);
   - Duas apostas concorrentes de 80.00 sobre saldo de 100.00 (exatamente 1 aprovada e 1 rejeitada com `INSUFFICIENT_FUNDS`, saldo final 20.00);
   - Coordenação de 3 processos reais de sistema operacional utilizando barreira de sincronização via arquivo temporário.

---

## 9. Limitações e Fases Futuras

### Não Implementado Nesta Entrega (Conforme Restrições do Desafio):
- Operações de aposta subsequentes (`WIN`, `LOSS`, `REFUND`, `ROLLBACK`);
- Dispatcher/Publisher assíncrono para consumo da tabela `outbox_messages` e envio para **AWS SQS**;
- Autenticação e autorização por API key ou OAuth2.
