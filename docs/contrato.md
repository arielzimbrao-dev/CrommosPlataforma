# Contrato — plataforma-api × produtos

> Fonte da verdade da integração. Desenho geral: `Crommos/docs/16-backend-plataforma.md`.
> Mudou aqui → muda nos dois lados, no mesmo ciclo.

## Token (JWT RS256)

- Assinado pela plataforma (`PLATAFORMA_JWT_PRIVATE_KEY`, PEM). Produtos verificam com
  `PLATAFORMA_JWT_PUBLIC_KEY` (PEM). Algoritmo fixo `RS256`.
- **Access** (15 min): `{ sub: <usuarioId>, produto: 'clinic'|'odonto'|'vet', tenantId: <uuid>, typ: 'access' }`.
- **Refresh** (7 dias, cookie httpOnly `crommos_rt`, path `/auth`, na origem da plataforma):
  `{ sub, produto, tenantId, typ: 'refresh', jti }`; uma sessão por `jti` em `crommos.sessoes`
  (hash do token), rotação a cada refresh.
- Papel e unidades **não** vão no token: o produto resolve o vínculo local a cada requisição.
- O produto recusa token com `produto` diferente do seu.

## Schema `crommos` (dono: plataforma)

Tabelas existentes (criadas pelo Clinic, migrations 68/69 — as da plataforma são idempotentes e
compatíveis): `clientes`, `usuarios`, `assinaturas`, `faturas`. Novas:

- `acessos` — `(id, usuario_id → usuarios, produto, tenant_id, papel varchar, ativo bool,
  convite_pendente bool, timestamps)`, único `(usuario_id, produto, tenant_id)`. É o que a
  plataforma usa para login (lista de clínicas), limite de usuários e permissão nas telas de
  assinatura (`admin` altera; `admin`/`financeiro` leem).
- `sessoes` — `(jti pk, usuario_id, produto, tenant_id, refresh_hash, expira_em, revogada_em,
  substituida_por, created_at)`. `substituida_por` = jti da sessão que a rotacionou (detecção de
  reuso, ver abaixo).
- `assinaturas` ganha `tenant_nome varchar`, `tenant_codigo varchar(5)` (exibição na escolha de
  clínica; o código é gerado pela plataforma no signup).
- `assinaturas` ganha `trial_confirmado_em timestamptz` e `inadimplente_desde date` (migration
  05). **Modo leitura** do tenant (o produto calcula com a linha da assinatura, sem chamar a
  plataforma): `(em_trial_ate <= hoje AND trial_confirmado_em IS NULL) OR inadimplente_desde IS NOT
  NULL`. `inadimplente_desde` é mantida só pela plataforma (job diário + cada baixa).
- Um cliente (CPF/CNPJ) pode ter **várias** assinaturas do mesmo produto (o índice
  `uq_assinaturas_cliente_produto` saiu na 05).
- **Sem assinatura** (ausente ou com `deleted_at`) = nenhum módulo (fail-closed, nos dois lados).

### Modo leitura (decisão de produto)

- **Fim do trial:** nada é faturado sozinho. Antes do fim, o admin confirma módulos e usuários
  (`PATCH /assinatura` = confirmação). Sem confirmação, no dia `em_trial_ate` o tenant entra em
  modo leitura; confirmar depois abre o 1º ciclo pago no mesmo dia (fatura `ciclo`).
- **Inadimplência:** fatura `pendente` com `vencimento` há mais de `DIAS_TOLERANCIA_INADIMPLENCIA`
  dias (padrão 7) → modo leitura. Aviso desde o vencimento (`faturaVencida`). A baixa (webhook ou
  manual) reativa na hora.
- **No produto:** em modo leitura, `GET`/`HEAD`/`OPTIONS` passam; escrita responde **`402`** com
  `{ code: 'ASSINATURA_MODO_LEITURA', motivo: 'trial_expirado' | 'inadimplencia', message }`.
  Login, sessão e as telas de assinatura (plataforma) continuam funcionando.

## API pública da plataforma (`PLATAFORMA_URL`)

| Método e rota | Corpo | Resposta |
|---|---|---|
| `POST /auth/login` | `{ email, password, produto, tenantId? }` (`tenantId` = UUID ou código de 5) | Sucesso: `{ accessToken, pessoa: { id, nome, email }, acesso: { produto, tenantId, papel } }` + cookie. Mais de um acesso ativo no produto e sem `tenantId`: `200 { escolherClinica: [{ tenantId, codigo, nome }] }` sem token. Credencial errada / sem acesso: `401` genérico |
| `POST /auth/refresh` | cookie | igual ao sucesso do login (rotaciona) |
| `POST /auth/logout` | cookie | `204` |
| `POST /auth/forgot-password` | `{ email }` | `202` sempre |
| `POST /auth/reset-password` | `{ token, password }` | `204` (também define a senha do convite; revoga as sessões da pessoa) |
| `POST /auth/trocar-senha` | `{ senhaAtual, novaSenha }` (autenticado) | sucesso do login (sessão nova; revoga as outras) |
| `GET /auth/confirmar-email?token=` | — | redireciona para `FRONTEND_URL/login?emailConfirmado=1\|0` |
| `POST /auth/reenviar-confirmacao` | — (autenticado) | `204`; `409` se já confirmado |
| `POST /signup` | `{ produto, tipoCliente, documento, nomeClinica, cnpj?, nome, email, senha, nomeUnidade, aceiteTermos }` | `201` sucesso do login + `codigo`. `409` e-mail ou documento já cadastrado; `502` se o provisionamento falhar |
| `POST /signup/clinica` | autenticado; `{ produto, tipoCliente, documento, nomeClinica, cnpj?, nomeUnidade }` | **Outra clínica na mesma conta** (R2): `201` sucesso do login **na clínica nova** + `codigo`. Documento de cliente existente só para quem é admin de uma clínica dele (`409` senão); `403` e-mail não confirmado; `502` provisionamento |
| `GET /modulos` | autenticado | `{ catalogo, ativos, situacao: { modoLeitura, emTrialAte, trialConfirmado, faturaVencida: { vencimento, bloqueiaEm } \| null } }` |
| `GET /assinatura` · `POST /assinatura/simular` · `PATCH /assinatura` · `GET /assinatura/faturas` | autenticado; `admin` altera, `admin`/`financeiro` leem | formatos do Clinic; `GET /assinatura` traz também `trialConfirmado`, `modoLeitura`, `faturaVencida: { id, vencimento, valorLiquido, bloqueiaEm } \| null` e `pagamentoOnline`. `PATCH` confirma o fim do trial |
| `POST /assinatura/faturas/:id/pagamento` | `admin`/`financeiro` | `200 { url }` do checkout da AbacatePay (PIX/cartão), criado uma vez por fatura; `409` não pendente; `503` sem AbacatePay |
| `POST /webhooks/abacatepay?webhookSecret=` | AbacatePay (`X-Webhook-Signature`) | `200 { recebido: true }`; baixa idempotente de `checkout.completed`/`billing.paid` depois de conferir o checkout `PAID` na API; `401` segredo/HMAC; `404` sem AbacatePay |
| `GET /conta/dados` | autenticado | LGPD: `{ pessoa, acessos, sessoes, auditoria }` da própria pessoa |
| `POST /conta/excluir` | autenticado; `{ senha }` | `204`: anonimiza a pessoa, desativa os acessos e revoga as sessões. `400` senha errada; `409` se for o último admin ativo de uma clínica com assinatura |
| `POST /plataforma/faturas/:id/pagar` | `X-Plataforma-Key` | baixa manual (contingência do webhook) |
| `GET /health` · `GET /health/ready` | público | liveness · readiness (`SELECT 1`; `503` sem banco) |

CORS: origens dos frontends dos produtos (`FRONTEND_URLS`, CSV), com credenciais.

## API interna da plataforma (chamada pelos produtos)

Cabeçalho `X-Servico-Key: <chave do produto>` (`SERVICO_KEY_CLINIC`, …), comparação em tempo
constante; `404` sem chave configurada. O `produto` vem da chave, não do corpo.

| Método e rota | Corpo | Resposta |
|---|---|---|
| `POST /interno/acessos` | `{ tenantId, email, nome, papel }` | `201 { usuarioId, novo, convitePendente, emailEnviado }` — quem não tem senha recebe e-mail de convite (token 7 dias). **E-mail que falhou não é erro** (B2): o acesso está gravado, `emailEnviado: false` → o produto grava o vínculo e oferece "reenviar convite". `409` já tem acesso neste tenant; `409` limite de usuários da assinatura (trava a linha da assinatura) |
| `DELETE /interno/acessos` | `{ tenantId, usuarioId }` | `204` — compensação: o produto não conseguiu gravar o vínculo depois do `POST`; remove o acesso (libera a vaga) e revoga as sessões no tenant. `404` sem acesso |
| `PATCH /interno/acessos` | `{ tenantId, usuarioId, papel?, ativo? }` | `200 { usuarioId, produto, tenantId, papel, ativo, convitePendente }` — desativar revoga as sessões da pessoa no tenant; reativar respeita o limite (`409`); `404` sem acesso |
| `POST /interno/acessos/reenviar-convite` | `{ tenantId, usuarioId }` | `204`; `409` se a pessoa já definiu a senha |
| `GET /interno/pessoas/:usuarioId` | — | `{ id, nome, email, emailConfirmado }`; `404` se a pessoa não tem acesso a nenhum tenant do produto |

## API interna do produto (chamada pela plataforma)

Base `CLINIC_API_URL` etc.; cabeçalho `X-Servico-Key` = `PROVISIONAMENTO_KEY_<PRODUTO>` (chave
própria deste sentido) ou, se ela não existir, a `SERVICO_KEY_<PRODUTO>` (compatível).

**Request-id:** as duas APIs aceitam `X-Request-Id` (8–128 caracteres `[A-Za-z0-9._:-]`, senão
geram um UUID), devolvem no header da resposta, gravam em cada linha de log (JSON em produção) e
repassam nas chamadas entre si.

| Método e rota | Corpo | Resposta |
|---|---|---|
| `POST /interno/tenants` | `{ tenantId, codigo, nomeClinica, cnpj?, nomeUnidade, admin: { usuarioId, nome, email } }` | `201` — cria clínica (id = tenantId), 1ª unidade e vínculo admin. Idempotente por `tenantId` |

Se o provisionamento falhar, a plataforma desfaz o signup (cliente, pessoa nova, assinatura,
acesso) e responde `502`.

## Produto: resolução do vínculo

Com o access válido: `SELECT` no vínculo local por `(tenant_id, usuario_id)` ativo → `request.user =
{ sub: <id do vínculo>, usuarioId, tenantId, role, unidadeIds }`. Sem vínculo ativo → `401`.

## Decisões de implementação (plataforma-api)

Pontos que o contrato deixava em aberto; valeu a opção mais simples.

- **Simular é `POST`** (como no Clinic): o corpo leva a lista de módulos. Formatos de
  assinatura/faturas/módulos iguais aos do Clinic; `PATCH /assinatura` só `admin` (o Clinic também
  deixava `gestor`).
- **Produto disponível** = `<PRODUTO>_API_URL` **e** `SERVICO_KEY_<PRODUTO>` configuradas (as duas ou
  nenhuma; o boot recusa só uma, e chaves repetidas entre produtos). Login/signup de produto
  indisponível → `400`.
- **API interna:** sem nenhuma chave configurada → `404`; chave ausente/errada → `401`. `papel` é
  texto do produto (`^[a-z_]{2,30}$`); a plataforma só distingue `admin` e `financeiro`.
- **`novo`** = a pessoa foi criada agora; **`convitePendente`** = ela ainda não tem senha (nova ou
  só com convites pendentes; o link anterior deixa de valer). Falha no envio → `201` com
  `emailEnviado: false` e o acesso gravado (o produto usa "reenviar convite").
- **Limite de usuários:** acessos `ativo` do tenant (convite pendente é ativo) contra
  `assinaturas.numero_usuarios`; tenant sem assinatura (legado) não tem limite.
- **Refresh:** rotação a cada chamada. Reapresentar um refresh rotacionado há **menos de 10 s**
  (várias abas renovando juntas, B1) emite um par novo, sem revogar nada. Depois disso,
  reapresentar um refresh **já rotacionado** (`substituida_por` preenchido) é reuso: revoga todas
  as sessões da pessoa. Sessão revogada por logout, senha ou
  desativação só dá `401`. Refresh com o acesso desativado → `401`.
- **Esqueci a senha** só envia para quem tem algum acesso ativo (a resposta é sempre `202`).
  `trocar-senha` com a senha atual errada → `400`.
- **Links dos e-mails** e o redirect da confirmação usam `FRONTEND_URL` (uma base só); base por
  produto: _a definir_. CORS: `FRONTEND_URLS` (CSV), senão `FRONTEND_URL`.
- **Signup:** `termosVersao` é aceito e ignorado (vale a versão do servidor); `cnpj` só vai ao
  produto quando informado. A compensação apaga acesso, assinatura, pessoa e cliente; se o produto
  chegou a criar o tenant e respondeu erro/timeout, o tenant órfão fica no produto (idempotente por
  `tenantId`, que não se repete).
- **Migrations:** a plataforma não cria a RLS que o Clinic liga em `assinaturas`/`faturas` (é do
  produto). O backfill (`04`) roda uma vez e lê `clinic.users`/`clinic.clinicas` se existirem.
- **Banco vazio (B4):** antes das migrations, a plataforma **espera** o schema de cada produto
  configurado existir (em produção; `DB_AGUARDAR_SCHEMAS` CSV sobrescreve, `nenhum` desliga; 60 × 5 s
  e derruba o boot). Assim a ordem de subida no Coolify não importa.
- **Cobrança (AbacatePay, API v2):** checkout hospedado (PIX + cartão) criado sob demanda por
  fatura: cliente da AbacatePay (único por CPF/CNPJ, guardado em `clientes.abacatepay_id`), produto
  avulso com o valor e checkout com `externalId` = id da fatura. O webhook valida
  `?webhookSecret=` e o HMAC-SHA256 (base64) do corpo cru e **confere o checkout na API** antes da
  baixa. Redução que mexe numa fatura pendente descarta o checkout dela (o próximo sai com o valor
  novo). Sem `ABACATEPAY_API_KEY`: sem link (503) e webhook 404.
- **E-mail:** Resend (API HTTP); sem `RESEND_API_KEY`, stub.
- **Várias réplicas:** rate limit no Postgres (`crommos.rate_limit`), jobs com advisory lock,
  migrations com advisory lock, nada de estado em memória entre requisições.
- **Estoque:** módulo no catálogo com preço _a definir_ (como Convênio).
- **Auditoria:** `crommos.auditoria (usuario_id, produto, tenant_id, action, resource, resource_id,
  created_at)` — login, logout, signup, senha, e-mail, acessos (ator = produto), assinatura, baixa.
