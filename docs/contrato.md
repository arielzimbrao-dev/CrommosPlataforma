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
| `GET /modulos` | autenticado | `{ catalogo, ativos }` |
| `GET /assinatura` · `POST /assinatura/simular` · `PATCH /assinatura` · `GET /assinatura/faturas` | autenticado; `admin` altera, `admin`/`financeiro` leem | mesmos formatos de hoje no Clinic |
| `POST /plataforma/faturas/:id/pagar` | `X-Plataforma-Key` | baixa manual (backoffice) |

CORS: origens dos frontends dos produtos (`FRONTEND_URLS`, CSV), com credenciais.

## API interna da plataforma (chamada pelos produtos)

Cabeçalho `X-Servico-Key: <chave do produto>` (`SERVICO_KEY_CLINIC`, …), comparação em tempo
constante; `404` sem chave configurada. O `produto` vem da chave, não do corpo.

| Método e rota | Corpo | Resposta |
|---|---|---|
| `POST /interno/acessos` | `{ tenantId, email, nome, papel }` | `201 { usuarioId, novo }` — pessoa nova recebe e-mail de convite (token 7 dias); `409` já tem acesso neste tenant; `409` limite de usuários da assinatura (trava a linha da assinatura) |
| `PATCH /interno/acessos` | `{ tenantId, usuarioId, papel?, ativo? }` | `200 { usuarioId, produto, tenantId, papel, ativo, convitePendente }` — desativar revoga as sessões da pessoa no tenant; reativar respeita o limite (`409`); `404` sem acesso |
| `POST /interno/acessos/reenviar-convite` | `{ tenantId, usuarioId }` | `204`; `409` se a pessoa já definiu a senha |
| `GET /interno/pessoas/:usuarioId` | — | `{ id, nome, email, emailConfirmado }`; `404` se a pessoa não tem acesso a nenhum tenant do produto |

## API interna do produto (chamada pela plataforma)

Base `CLINIC_API_URL` etc.; mesmo cabeçalho `X-Servico-Key` (a chave do produto).

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
- **`novo`** = a pessoa foi criada agora. O e-mail de convite vai para quem ainda não tem senha
  (pessoa nova ou só com convites pendentes; o link anterior deixa de valer). Falha no envio → `503`
  com o acesso já gravado (o produto usa "reenviar convite").
- **Limite de usuários:** acessos `ativo` do tenant (convite pendente é ativo) contra
  `assinaturas.numero_usuarios`; tenant sem assinatura (legado) não tem limite.
- **Refresh:** rotação a cada chamada. Reapresentar um refresh **já rotacionado** (`substituida_por`
  preenchido) é reuso: revoga todas as sessões da pessoa. Sessão revogada por logout, senha ou
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
- **Auditoria:** `crommos.auditoria (usuario_id, produto, tenant_id, action, resource, resource_id,
  created_at)` — login, logout, signup, senha, e-mail, acessos (ator = produto), assinatura, baixa.
