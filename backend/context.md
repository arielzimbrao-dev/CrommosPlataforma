# Contexto — backend (`plataforma-api`)

API REST da plataforma Crommos. **NestJS 11 + TypeORM 0.3 + PostgreSQL 16**, Node 24,
TypeScript strict. Dona do schema `crommos` (clientes, pessoas, acessos, sessões,
assinaturas, faturas, auditoria). Contrato com os produtos: [`../docs/contrato.md`](../docs/contrato.md).
Portado do backend do Clinic (auth, billing, runner de migrations, e-mail), sem o domínio clínico.

## Mapa do código

| Pasta | Conteúdo |
|---|---|
| `src/main.ts` | Bootstrap: helmet, compression, CORS (`FRONTEND_URLS` ou `FRONTEND_URL`, com credenciais), cookie-parser, ValidationPipe (whitelist + forbidNonWhitelisted), Swagger opcional |
| `src/app.module.ts` | Config (validação no boot), throttler, schedule, módulos |
| `src/config` | `load-env.ts` (dotenv `.env.local` + `.env`) e `env.validation.ts` (falha no boot; confere o par RS256 e o par URL + chave de cada produto; lista completa das variáveis no `README.md`) |
| `src/database` | DataSource (`search_path = crommos, public`), repositórios por token (`USUARIO_REPOSITORY`, `ACESSO_REPOSITORY`, …), `migrations-runner.ts` (lógica pura, testada) |
| `database/migrations/NN-*.sql` | Schema `crommos`. Idempotentes, rodam no boot e bloqueiam; controle em `crommos._migrations`, advisory lock próprio (≠ Clinic) |
| `src/auth` | Login único, tokens RS256 (`SessoesService`), refresh com rotação e reuso, senha, confirmação de e-mail, verificação em duas etapas (`dois-fatores.*`, `totp.ts`), registros de acesso (`GET /auth/acessos`), `JwtAuthGuard` + `AcessoGuard` (`@ExigeAcesso(...papeis)`) |
| `src/signup` | `POST /signup`: transação + provisionamento no produto (`ProvisionamentoClient`) com compensação |
| `src/interno` | API interna para os produtos (`ServicoKeyGuard`, `X-Servico-Key` → produto): acessos, convite, pessoa |
| `src/billing` | Catálogo, `AssinaturaService` (pró-rata, faturas, renovação, fim do trial, inadimplência), `situacao.ts` (modo leitura), `CobrancaService` + `AbacatePayClient` (link de pagamento e webhook), baixa pelo backoffice |
| `src/mail` | `MailService` + `EmailProvider` (Resend, API HTTP; stub sem `RESEND_API_KEY`) |
| `src/conta` | LGPD da pessoa: `GET /conta/dados` (exportar: pessoa, acessos, sessões, auditoria com IP) e `POST /conta/excluir` (anonimiza, propaga aos produtos; recusa o último admin) |
| `src/audit` | `AuditService.registrar()` → `crommos.auditoria` (com `ip`, `user_agent` e alvo em `resource_id`); purga dos registros de acesso (`RETENCAO_REGISTROS_ACESSO_DIAS`) |
| `src/common` | Produtos (`configProduto`, `produtoDaChave`), segredo (sha256, comparação em tempo constante), cifra de campo (`crypto/cifra.ts`, AES-256-GCM), CPF/CNPJ, datas BR, lock global, filtro de exceções (tudo em pt-BR, `no-store`), health (`/health`, `/health/ready`), CORS, `ThrottlerPostgres` (rate limit compartilhado), `log/` (logs JSON + request-id) |
| `tests/` | Unit (`*.spec.ts`) e integração (`*.integration.spec.ts`); `tests/support` (app, dados, stub HTTP do produto) |

## Como rodar

```bash
cp .env.example .env     # chaves RS256 (openssl, instruções no arquivo), DB_*, produtos
docker compose up -d     # Postgres local
npm ci && npm run start:dev
```

| Script | O quê |
|---|---|
| `npm test` | Jest com cobertura e **gate de 85%** |
| `RUN_DB_TESTS=true npm test` | Inclui a integração: `plat_test` (suíte) e `plat_int` (compatibilidade com o schema do Clinic) |
| `npm run lint:check`, `npm run typecheck`, `npm run build` | O CI roda todos |

## Regras e armadilhas

- **Token:** access 15 min `{ sub: pessoa, produto, tenantId, typ: 'access', sid }`; refresh 7 dias
  `{ …, typ: 'refresh', jti }` no cookie `crommos_rt` (httpOnly, path `/auth`). Papel **não** vai no
  token: o `AcessoGuard` (e o produto, do lado dele) lê o acesso a cada requisição. `sid` = família
  da sessão (`sessoes.familia`, herdada nas rotações): a `JwtStrategy` recusa o access se a família
  não tem sessão vigente (logout/senha/desativação derrubam na hora); sem `sid` = token antigo,
  vale até expirar.
- **Sessões (`crommos.sessoes`):** uma por `jti`, só o hash. Refresh revoga a sessão e grava
  `substituida_por`. Reapresentar um refresh **já rotacionado** = reuso → revoga **todas** as
  sessões da pessoa (auditado `refresh-reutilizado`). Revogada sem substituta (logout, senha,
  desativação) só dá 401. Limpeza diária das vencidas (`SessoesCron`).
- **Rate limit por alvo (`TentativasService`):** login conta só falhas (5 por IP + e-mail, 50 por
  IP, 15 min; sucesso zera o par); forgot 3/h por e-mail; reenviar confirmação 3/h por pessoa.
  Os `@Throttle` por IP são generosos (NAT da clínica). O `ThrottlerGuard` é desligado em teste;
  o `TentativasService` não.
- **Login:** bcrypt sempre (401 genérico). `tenantId` = UUID ou código (`assinaturas.tenant_codigo`,
  sem diferenciar maiúsculas). Mais de um acesso ativo no produto → `escolherClinica` sem token.
  Produto sem `<PRODUTO>_API_URL` + `SERVICO_KEY_<PRODUTO>` → 400.
- **Signup:** a transação grava cliente, pessoa, assinatura (trial 14 dias, `tenant_id` novo, código
  de 5) e acesso admin; **depois** chama o produto. Falha do produto → apaga o que criou e responde
  502. 409 por `uq_usuarios_email`/`uq_clientes_documento` (mensagem no `AllExceptionsFilter`).
- **Assento por módulo (migration 10):** sem limite de pessoas. Os assentos vêm dos acessos
  ativos (convite pendente conta) × papel/`clinico` (`modules.catalog.ts`); preço em **escada
  dentro de cada módulo** (`ESCADA`, sem faixa pelo total nem ajuste de virada). Convite, papel, ativo e `clinico` passam por `AssinaturaService.comReprecificacao`: linha
  da assinatura em `FOR UPDATE`, grava e cobra a diferença no pró-rata (complementar ou crédito)
  **na mesma transação**. `numero_usuarios` virou informativo (pessoas cobradas).
- **Convite:** todo acesso convidado nasce `convite_pendente` (fora do login) e sai e-mail. Pessoa
  sem senha (nova, ou só convites pendentes) → token de 7 dias na pessoa (o link anterior deixa de
  valer); define a senha em `POST /auth/reset-password` (aceita os convites sem `convite_hash`).
  Quem já tem senha → token de 7 dias no acesso (`convite_hash`); o e-mail leva à página do front
  (`/aceitar-convite`), que aceita por botão em `POST /auth/aceitar-convite` (o `GET` antigo só
  redireciona: leitor de links não aceita sozinho). O hash fica depois do aceite, para o link
  reaberto responder "já aceito". A resposta do convite é igual nos dois casos.
- **Links de e-mail:** `GET /auth/verificar-token` diz se o token vale (sem consumir) para a página
  avisar ao abrir: e-mail, nome da clínica do convite, ou `motivo` (`expirado`/`usado`/`invalido`).
- **Billing:** mesmas regras do Clinic (pró-rata em `billing/pro-rata.ts`, não duplicar; redução abate
  pendentes antes de virar crédito; fatura pendente não bloqueia). Lock da renovação com o **mesmo
  nome** do Clinic (`billing-renovacao`) para as duas APIs não renovarem juntas na transição.
- **Migrations:** compatíveis com o banco em que o Clinic criou `crommos` (68/69) — mesmos nomes de
  constraints e índices (o spec compara a estrutura). A `04` lê `clinic.users`/`clinic.clinicas` uma
  vez (backfill), protegida por `to_regclass`. Num banco vazio, a plataforma deve subir **depois** que
  o produto criar o schema dele (senão o `search_path` do produto pode cair no `crommos`) — o boot
  **espera** por isso sozinho (`aguardarSchemas`, `DB_AGUARDAR_SCHEMAS`).
- **Produção:** `FRONTEND_URL` e `API_URL` obrigatórias; CORS nunca abre com a lista vazia; chaves
  RS256 conferidas no boot; `trust proxy` de 1 hop (fora de produção, só com `TRUST_PROXY=true`)
  para o IP real no rate limit e nos registros de acesso.
- **Erros:** o `AllExceptionsFilter` responde sempre em pt-BR e com `Cache-Control: no-store` —
  validação (`mensagens-validacao.ts`), JSON malformado, parâmetro com `%` inválido, rota
  inexistente e throttler; erro inesperado vira 500 genérico (detalhe só no log).
- Dinheiro em `numeric`, conta em centavos inteiros. Datas "só dia" em `America/Sao_Paulo`.
- **Refresh em várias abas:** refresh rotacionado há < 10 s (`TOLERANCIA_ROTACAO_MS`) ganha
  par novo; depois disso é reuso.
- **Modo leitura:** trial vencido sem confirmação (`trial_confirmado_em`) ou `inadimplente_desde`
  (job diário depois da renovação; `baixar()` recalcula o tenant). `PATCH /assinatura` confirma o
  trial; se ele já venceu, abre o 1º ciclo pago hoje. Sem assinatura = nenhum módulo.
- **AbacatePay:** o link é criado só quando alguém clica em pagar (`/assinatura/faturas/:id/pagamento`).
  O webhook precisa do corpo cru (`rawBody: true` no `main.ts` e no `criarApp` dos testes).
- **Réplicas:** rate limit em `crommos.rate_limit` (`ThrottlerPostgres`), jobs com `comLockGlobal`,
  migrations com advisory lock; nada de estado em memória entre requisições.
- **Login contra botnet:** além de IP e IP+e-mail, falhas por conta na última hora; a partir
  de 10, atraso progressivo (250 ms → 5 s, `TentativasService.esperar`) e alerta no log — nunca 429
  por conta (seria DoS contra o dono). `/interno` tem limite próprio (600/min por IP).
- **Banco vazio:** `aguardarSchemas` antes das migrations (produção: produtos configurados).
- **2FA (migration 13):** TOTP próprio (`auth/totp.ts`, RFC 6238 com `node:crypto`), segredo
  cifrado (`common/crypto/cifra.ts`, `DATA_ENCRYPTION_KEY`; sem ela, ligar = 503). Login com 2FA =
  `{ doisFatores: { desafio } }` (JWT `typ: '2fa'`, 5 min — o `JwtStrategy` e o produto só aceitam
  `access`) → `POST /auth/login/codigo`. Passo usado fica em `totp_ultimo_passo` (código não se
  reusa); recuperação só com hash (`array_remove` atômico). Clínica exige (`assinaturas.exigir_2fa`,
  padrão falso) de `admin`, `profissional` e acesso `clinico`: sem 2FA, configura no próprio login.
  5 códigos errados por pessoa em 15 min → 429 (código errado ou repetido = 400; 401 só para o
  desafio vencido). O admin desliga o 2FA de quem tem acesso **ativo e aceito** na clínica dele
  (`POST /auth/2fa/desligar/:usuarioId`): a pessoa recebe e-mail e o evento
  `2fa-desligado-por-admin` entra na trilha de todas as clínicas dela (além do
  `2fa-desligado-pelo-admin`, com o alvo, na do admin).
- **Registros de acesso (migration 12):** `auditoria.ip`/`user_agent` em login, `login-falha`,
  `refresh`, `trocar-senha`, `logout` e `2fa-*` (`resource = 'auth'`). Purga no `SessoesCron` pela
  `RETENCAO_REGISTROS_ACESSO_DIAS` (365, proposta). `GET /auth/acessos` (admin, 90 dias; `alvoId` =
  `resource_id`). Eventos da pessoa (redefinir a senha, 2FA desligado por admin) entram em cada
  clínica em que ela tem acesso ativo e aceito.
- **Exclusão propagada (migration 14):** `POST /conta/excluir` grava em
  `usuarios.exclusao_pendente` os produtos em que a pessoa tinha acesso e chama
  `POST {produto}/interno/usuarios/:id/anonimizar` (nome/e-mail da cópia local). Falhou (produto
  fora) → fica pendente; `ContaService.cronExclusoes` tenta de novo a cada 10 min (lock global).
  O produto desativa o vínculo; `PATCH /interno/acessos` recusa reativar conta excluída (409).
