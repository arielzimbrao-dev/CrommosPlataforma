# Contrato — plataforma-api × produtos

> Fonte da verdade da integração. Desenho geral: `Crommos/docs/16-backend-plataforma.md`.
> Mudou aqui → muda nos dois lados, no mesmo ciclo.

## Token (JWT RS256)

- Assinado pela plataforma (`PLATAFORMA_JWT_PRIVATE_KEY`, PEM). Produtos verificam com
  `PLATAFORMA_JWT_PUBLIC_KEY` (PEM). Algoritmo fixo `RS256`.
- **Access** (15 min): `{ sub: <usuarioId>, produto: 'clinic'|'odonto'|'vet', tenantId: <uuid>, typ: 'access', sid: <uuid> }`.
- **`sid`:** a **família** da sessão — o `jti` da 1ª sessão do login, herdado a cada
  rotação do refresh (`crommos.sessoes.familia`). O access só vale enquanto a família tiver uma
  sessão vigente: `EXISTS (SELECT 1 FROM crommos.sessoes WHERE familia = :sid AND usuario_id = :sub
  AND revogada_em IS NULL AND expira_em > now())` (índice `idx_sessoes_familia`). Plataforma e
  produto conferem a cada requisição e respondem `401` (`'Sessão encerrada.'`). Logout (revoga a
  família inteira, inclusive as abas que renovaram juntas), redefinir/trocar a senha, desativação
  e reuso de refresh derrubam o access **na hora**. **Transição:** access sem `sid` (emitido antes
  desta versão) é aceito até expirar (≤ 15 min).
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
  plataforma usa para login (lista de clínicas), assentos da cobrança e permissão nas telas de
  assinatura (`admin` altera; `admin`/`financeiro` leem).
- `sessoes` — `(jti pk, usuario_id, produto, tenant_id, refresh_hash, expira_em, revogada_em,
  substituida_por, familia, created_at)`. `substituida_por` = jti da sessão que a rotacionou
  (detecção de reuso, ver abaixo); `familia` = `sid` do access (migration 08; o Clinic cria o
  mesmo na 98 dele). O produto **lê** `sessoes` (`SELECT`).
- `acessos` ganha `convite_hash`, `convite_expira_em` (migration 09): link de aceite do convite
  de quem já tem conta. O hash **fica** depois do aceite (`convite_pendente = false`),
  para o link reaberto responder "já aceito". O produto **lê** `acessos` (`SELECT`: a
  lista de usuários não mostra "Convite pendente" de quem já aceitou); o Clinic cria a tabela igual
  na migration 99 dele (idempotente, como a 98).
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
  Login, sessão e as telas de assinatura (plataforma) continuam funcionando. **Exceção:**
  o admin reduz a equipe para confirmar/regularizar — desativar usuário e reenviar convite passam
  (no produto e na API interna `PATCH /interno/acessos` e `reenviar-convite`, que não olham o modo
  leitura).

## API pública da plataforma (`PLATAFORMA_URL`)

| Método e rota | Corpo | Resposta |
|---|---|---|
| `POST /auth/login` | `{ email, password, produto, tenantId? }` (`tenantId` = UUID ou código de 5) | Sucesso: `{ accessToken, pessoa: { id, nome, email }, acesso: { produto, tenantId, papel } }` + cookie. Mais de um acesso ativo (e não pendente) no produto e sem `tenantId`: `200 { escolherClinica: [{ tenantId, codigo, nome }] }` sem token. Credencial errada / sem acesso / convite ainda não aceito: `401` genérico. `429` depois de 5 falhas por IP + e-mail (ou 50 por IP) em 15 min |
| `POST /auth/login` com 2FA | igual | Pessoa com 2FA ligado, ou clínica que exige 2FA do papel (admin, profissional ou acesso `clinico`): `200 { doisFatores: { desafio, configurar?: { chave, link } } }` **sem token**. `configurar` = exigido e ainda sem 2FA: segredo novo (chave base32 + link `otpauth://`) para cadastrar no app agora. `desafio` vale 5 min |
| `POST /auth/login/codigo` | `{ desafio, codigo }` (6 dígitos do app ou código de recuperação `XXXX-XXXX`) | Sucesso do login + cookie; se configurou agora, também `codigosRecuperacao` (10, mostrados uma vez). `400` código errado ou já usado; `401` desafio vencido ou inválido (entrar de novo); `429` depois de 5 códigos errados da pessoa em 15 min |
| `GET /auth/2fa` | autenticado | `{ ativo, exigido, codigosRestantes }` |
| `POST /auth/2fa/iniciar` | autenticado | `201 { chave, link }` (pendente até confirmar); `409` já ligado; `503` sem `DATA_ENCRYPTION_KEY` |
| `POST /auth/2fa/confirmar` | autenticado; `{ codigo }` | `201 { codigosRecuperacao }` (liga); `400` código errado |
| `POST /auth/2fa/desligar` | autenticado; `{ senha }` | `204`; `400` senha errada; `409` a clínica exige 2FA do papel |
| `GET /auth/2fa/clinica` · `PATCH /auth/2fa/clinica` | `admin`; `PATCH { exigir }` | `{ exigir, comDoisFatores: [usuarioId] }` · `{ exigir }` (auditado `2fa-exigencia`). Padrão: não exige |
| `POST /auth/2fa/desligar/:usuarioId` | `admin` | `204` desliga o 2FA de quem tem acesso **ativo e aceito** à clínica (perdeu o celular); `404` fora da clínica, convite pendente ou acesso desativado. O 2FA é da pessoa: vale em todas as clínicas dela — por isso a pessoa recebe e-mail de aviso e o evento vai para a trilha dela em todas as clínicas em que trabalha (`2fa-desligado-por-admin`, ator = a pessoa) além do `2fa-desligado-pelo-admin` (ator = o admin, `alvoId` = a pessoa) na clínica do admin. `GET /auth/2fa/clinica` não lista convites pendentes |
| `GET /auth/acessos?usuarioId=&limit=&offset=` | `admin` | `{ data: [{ em, usuarioId, acao, ip, navegador, alvoId }], total }` da equipe, últimos 90 dias (`login`, `login-falha`, `refresh`, `trocar-senha`, `redefinir-senha`, `logout`, `2fa-*`). `alvoId` = pessoa afetada (de quem o admin desligou o 2FA), senão `null`. Eventos da pessoa (redefinir a senha, 2FA desligado por admin) entram em cada clínica em que ela tem acesso ativo e aceito, com IP e navegador |
| `POST /auth/refresh` | cookie | igual ao sucesso do login (rotaciona). `401` = sessão encerrada. `429` depois de 20 renovações/min da mesma sessão (ou 300/min por IP): o refresh **não** é consumido — o cliente espera e tenta de novo, sem encerrar a sessão |
| `POST /auth/logout` | cookie | `204` |
| `POST /auth/forgot-password` | `{ email }` | `202` sempre (no máximo 3 e-mails/h por endereço; acima disso, `202` sem envio) |
| `POST /auth/reset-password` | `{ token, password }` | `204` (também define a senha do convite; revoga as sessões da pessoa) |
| `POST /auth/trocar-senha` | `{ senhaAtual, novaSenha }` (autenticado) | sucesso do login (sessão nova; revoga as outras) |
| `GET /auth/confirmar-email?token=` | — | redireciona para `FRONTEND_URL/login?emailConfirmado=1\|0` |
| `GET /auth/verificar-token?tipo=definir-senha\|redefinir-senha\|aceitar-convite&token=` | — | A página do link valida o token ao abrir, **sem consumi-lo**: `200 { valido: true, email, clinicaNome: string \| null }` (`clinicaNome` no convite; em `redefinir-senha` é `null`) ou `200 { valido: false, motivo: 'expirado' \| 'usado' \| 'invalido' }`. Convite já aceito → `usado`; convite cancelado (acesso desativado) → `invalido`; token de senha já usado some no uso → `invalido`. `400` tipo/token ausente ou inválido. Rate limit por IP como as demais rotas de token (20/h) |
| `POST /auth/aceitar-convite` | `{ token }` | Aceite do convite de quem já tem conta, pelo botão da página `FRONTEND_URL/aceitar-convite?token=` (o link do e-mail aponta para ela): `200 { clinicaNome }`; `409 { code: 'CONVITE_JA_ACEITO' }`; `400 { code: 'CONVITE_INVALIDO' }` (desconhecido, vencido ou cancelado) |
| `GET /auth/aceitar-convite?token=` | — | Link dos e-mails antigos: **não aceita mais** (leitor de links de e-mail aceitaria sozinho); só redireciona para `FRONTEND_URL/aceitar-convite?token=` |
| `POST /auth/reenviar-confirmacao` | — (autenticado) | `204`; `409` se já confirmado; `429` depois de 3/h por pessoa |
| `POST /signup` | `{ produto, tipoCliente, documento, nomeClinica, cnpj?, nome, email, senha, nomeUnidade, aceiteTermos }` | `201` sucesso do login + `codigo`. `409` e-mail ou documento já cadastrado; `502` se o provisionamento falhar |
| `POST /signup/clinica` | autenticado; `{ produto, tipoCliente, documento, nomeClinica, cnpj?, nomeUnidade }` | **Outra clínica na mesma conta**: `201` sucesso do login **na clínica nova** + `codigo`. Documento de cliente existente só para quem é admin de uma clínica dele (`409` senão); `403` e-mail não confirmado; `502` provisionamento |
| `GET /modulos` | autenticado | `{ catalogo, ativos, situacao: { modoLeitura, emTrialAte, trialConfirmado, faturaVencida: { vencimento, bloqueiaEm } \| null } }` |
| `GET /assinatura` · `POST /assinatura/simular` · `PATCH /assinatura` · `GET /assinatura/faturas` | autenticado; `admin` altera, `admin`/`financeiro` leem | formatos do Clinic; `GET /assinatura` traz também `trialConfirmado`, `modoLeitura`, `faturaVencida: { id, vencimento, valorLiquido, bloqueiaEm } \| null` (só `vencimento < hoje`: a que vence hoje não está vencida) e `pagamentoOnline`. `simular` traz também `primeiraFatura: { valorLiquido, periodoInicio, periodoFim, vencimento } \| null` (ver abaixo). `PATCH` confirma o fim do trial |
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
| `POST /interno/acessos` | `{ tenantId, email, nome, papel, clinico? }` | `201 { usuarioId, novo, convitePendente, emailEnviado }` — **todo convite nasce pendente e manda e-mail**: quem não tem senha recebe o link de definir a senha (token da pessoa, 7 dias); quem já tem conta recebe o link de aceite (`FRONTEND_URL/aceitar-convite?token=`, página com o botão que chama `POST /auth/aceitar-convite`; token do acesso, 7 dias). `convitePendente` é sempre `true` — o produto **não** deve expor `novo` (revelaria se o e-mail tem conta). **E-mail que falhou não é erro**: o acesso está gravado, `emailEnviado: false` → o produto grava o vínculo e oferece "reenviar convite". `409` já tem acesso neste tenant. Sem limite de pessoas: o assento novo entra no pró-rata da assinatura (fatura complementar) |
| `DELETE /interno/acessos` | `{ tenantId, usuarioId }` | `204` — compensação: o produto não conseguiu gravar o vínculo depois do `POST`; remove o acesso (libera a vaga) e revoga as sessões no tenant. `404` sem acesso |
| `PATCH /interno/acessos` | `{ tenantId, usuarioId, papel?, ativo?, clinico? }` | `200 { usuarioId, produto, tenantId, papel, ativo, convitePendente, clinico }` — desativar revoga as sessões da pessoa no tenant; reativar quem excluiu a conta → `409`; papel/ativo/`clinico` mudam os assentos (pró-rata: complementar ou crédito); `404` sem acesso. `clinico` = a pessoa está vinculada a um profissional de saúde no produto (o produto avisa ao vincular/desvincular) |
| `POST /interno/acessos/reenviar-convite` | `{ tenantId, usuarioId }` | `204` (link novo do mesmo tipo: definir senha ou aceite); `409` `'Esta pessoa já aceitou o convite.'` |
| `GET /interno/pessoas/:usuarioId` | — | `{ id, nome, email, emailConfirmado }`; `404` se a pessoa não tem acesso a nenhum tenant do produto |
| `POST /interno/teleconsultas` | `{ tenantId, referencia }` | `204` — teleconsulta **concluída** no produto (franquia da Telemedicina). `referencia` = id do atendimento no produto (UUID): reenvio não conta duas vezes. Conta no ciclo pela data de chegada (Brasília) |
| `POST /interno/consumos` | `{ tenantId, tipo, referencia }` | `204` — `tipo` = `whatsapp` (mensagem enviada ao paciente) ou `nfse` (nota emitida); conta na franquia do nível da Agenda/do Fiscal. `referencia` = id da mensagem/nota no produto (UUID): reenvio não conta duas vezes. Conta no ciclo pela data de chegada (Brasília). Ao chegar a 80% e a 100% da franquia do ciclo, os admins da clínica recebem um e-mail (uma vez por limiar e ciclo). `400` tipo inválido |

## API interna do produto (chamada pela plataforma)

Base `CLINIC_API_URL` etc.; cabeçalho `X-Servico-Key` = `PROVISIONAMENTO_KEY_<PRODUTO>` (chave
própria deste sentido) ou, se ela não existir, a `SERVICO_KEY_<PRODUTO>` (compatível).

**Request-id:** as duas APIs aceitam `X-Request-Id` (8–128 caracteres `[A-Za-z0-9._:-]`, senão
geram um UUID), devolvem no header da resposta, gravam em cada linha de log (JSON em produção) e
repassam nas chamadas entre si.

| Método e rota | Corpo | Resposta |
|---|---|---|
| `POST /interno/tenants` | `{ tenantId, codigo, nomeClinica, cnpj?, nomeUnidade, admin: { usuarioId, nome, email } }` | `201` — cria clínica (id = tenantId), 1ª unidade e vínculo admin. Idempotente por `tenantId` |
| `POST /interno/usuarios/:usuarioId/anonimizar` | — | `204` — a pessoa excluiu a conta; o produto troca nome e e-mail da cópia local (`Conta excluída`, `excluida-<usuarioId>@anonimizado.invalid`) e **desativa o vínculo** (não conta como admin nem volta a ativar) em todas as clínicas. Idempotente; a plataforma tenta de novo (job de 10 min) enquanto não receber 2xx |

Se o provisionamento falhar, a plataforma desfaz o signup (cliente, pessoa nova, assinatura,
acesso) e responde `502`.

## Produto: resolução do vínculo

Com o access válido: `SELECT` no vínculo local por `(tenant_id, usuario_id)` ativo → `request.user =
{ sub: <id do vínculo>, usuarioId, tenantId, role, unidadeIds }`. Sem vínculo ativo → `401`.
Com `sid` no token, confere também a sessão (consulta acima, em `crommos.sessoes`) → `401` se
encerrada. O usuário de banco do produto precisa de `SELECT` em `crommos.sessoes` e em
`crommos.acessos` (estado do convite na lista de usuários).

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
- **`novo`** = a pessoa foi criada agora; **`convitePendente`** é sempre `true` no convite (o acesso
  só entra no login depois do aceite ou da senha definida). Falha no envio → `201` com
  `emailEnviado: false` e o acesso gravado (o produto usa "reenviar convite").
- **Assento por módulo (migration 10, substitui o limite de usuários):** valor = Σ módulos
  contratados (Σ assentos (preço cheio × fator do degrau) + valor do nível) × (1 − desconto do plano). **Escada por
  módulo** (substitui a faixa pelo total de pessoas e o antigo ajuste de virada de faixa): o k-ésimo assento
  do módulo paga 100% (1º–3º), 90% (4º–10º), 80% (11º–30º) ou 70% (31º+), cada assento arredondado
  ao centavo — somar uma pessoa nunca reduz o valor. Pessoas = acessos `ativo` (convite pendente
  conta); quem ocupa assento em cada módulo vem do papel (espelha o menu do Clinic) e, nos clínicos
  (Prontuário, Exames, Telemedicina), de `acessos.clinico`. Mudança de acesso → pró-rata na hora.
  `GET /assinatura` traz `itens: [{ code, pessoas, preco, nivel, valorNivel, degraus: [{ qtd, preco }], subtotal }]`
  (`preco` = cheio; `valorNivel` = R$/mês fixo do nível, fora do `subtotal` dos assentos), `niveis` (`{ agenda?, fiscal? }`: `essencial` | `profissional` |
  `avancado`; ausente = Essencial), `franquias` (tabela de níveis: `valor` fixo por clínica/mês,
  `incluidos` por clínica/mês e preço do excedente), `consumos: [{ tipo, modulo, unidade, nivel, usados,
  incluidos, excedente }]` (Agenda/Fiscal contratados; o excedente entra na fatura da renovação em
  `itens.consumosExcedentes`, com `quantidade`, `valorUnitario` e `valor` — migration 15,
  `crommos.consumos`; o ciclo do trial não cobra; o nível vigente no fim do ciclo vale para o ciclo
  inteiro). `PATCH /assinatura` e `simular` aceitam `niveis` (só os informados mudam; a troca de
  nível entra no pró-rata como uma troca de módulo), `escada` e
  `teleconsultas: { realizadas, incluidas } | null` (só com
  Telemedicina: 20 por assento × meses do ciclo; o excedente, R$ 2,00 cada, entra na fatura da
  renovação em `itens.teleconsultasExcedentes: { quantidade, valorUnitario, valor, realizadas,
  incluidas }` — migration 11, `crommos.teleconsultas`; o ciclo do trial não cobra). **Assinaturas
  existentes:** a fatura do ciclo em curso não é refeita; o valor pela escada vale na renovação (o
  pró-rata de mudanças no meio do ciclo já compara antes × depois pela regra nova);
  `simular` aceita `adicionar: { papel, clinico? }` (convidar/ativar) e `remover: { papel,
  clinico? }` (desativar; trocar o papel = remover + adicionar), com `papel` entre admin,
  gestor, recepcao, profissional e financeiro (senão 400), e devolve `valorAtual`, `valor`,
  `numeroUsuarios`, `itens`. `numeroUsuarios` no corpo do `PATCH`/`simular` é ignorado
  (compatibilidade). `assinaturas.numero_usuarios` = pessoas cobradas (informativo).
- **Refresh:** rotação a cada chamada. Reapresentar um refresh rotacionado há **menos de 10 s**
  (várias abas renovando juntas) emite um par novo, sem revogar nada. Depois disso,
  reapresentar um refresh **já rotacionado** (`substituida_por` preenchido) é reuso: revoga todas
  as sessões da pessoa. Sessão revogada por logout, senha ou
  desativação só dá `401`. Refresh com o acesso desativado → `401`.
- **Esqueci a senha** só envia para quem tem algum acesso ativo (a resposta é sempre `202`).
  `trocar-senha` com a senha atual errada → `400`.
- **Rate limit:** por IP, generoso (a clínica inteira sai pelo mesmo NAT): login 60/min,
  refresh 300/min, forgot 30/h, reenviar confirmação 20/h, reset 10/h, aceite 20/h. Por alvo (`TentativasService`,
  mesma tabela `crommos.rate_limit`, chaves com hash): login conta só **falhas** — 5 por IP +
  e-mail e 50 por IP em 15 min → `429` antes do bcrypt; acertar a senha zera o par; forgot 3
  e-mails/h por endereço (silencioso); reenviar confirmação 3/h por pessoa (`429`); refresh 20/min
  por sessão (família), conferido antes de consumir o token (`429` não derruba a sessão).
- **Validação:** o `AllExceptionsFilter` traduz para pt-BR as mensagens padrão do
  class-validator/ParseUUIDPipe nos `400` (`mensagens-validacao.ts`); mensagens próprias dos DTOs
  ficam como estão.
- **Trial:** sem cobrança e sem limite de pessoas (assento por módulo).
- **1ª fatura:** `simular.primeiraFatura` = a fatura `ciclo` que a confirmação gera —
  já (sem assinatura, ou trial vencido/modo leitura: período a partir de hoje) ou no fim do trial
  ativo (período a partir de `em_trial_ate`); fora do trial, `null`. `valorLiquido` já desconta o
  crédito. **Vencimento = 1º dia do período** (hoje, no trial vencido), como toda fatura de ciclo:
  decisão pela coerência — a tolerância de 7 dias antes do modo leitura
  (`DIAS_TOLERANCIA_INADIMPLENCIA`) já dá o prazo para pagar, e a fatura do dia
  aparece como "vence hoje", não "vencida".
- **Links dos e-mails** e o redirect da confirmação usam `FRONTEND_URL` (uma base só); base por
  produto: _a definir_. CORS: `FRONTEND_URLS` (CSV), senão `FRONTEND_URL`.
- **Signup:** `termosVersao` é aceito e ignorado (vale a versão do servidor); `cnpj` só vai ao
  produto quando informado. A compensação apaga acesso, assinatura, pessoa e cliente; se o produto
  chegou a criar o tenant e respondeu erro/timeout, o tenant órfão fica no produto (idempotente por
  `tenantId`, que não se repete).
- **Migrations:** a plataforma não cria a RLS que o Clinic liga em `assinaturas`/`faturas` (é do
  produto). O backfill (`04`) roda uma vez e lê `clinic.users`/`clinic.clinicas` se existirem.
- **Banco vazio:** antes das migrations, a plataforma **espera** o schema de cada produto
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
- **Preços:** os 9 módulos têm preço (docs/03-precificacao.md do workspace); nenhum _a definir_.
- **Auditoria:** `crommos.auditoria (usuario_id, produto, tenant_id, action, resource, resource_id,
  ip, user_agent, created_at)` — login, logout, signup, senha, e-mail, 2FA, acessos (ator =
  produto), assinatura, baixa. Registros de acesso (`resource = 'auth'`, com IP e navegador) são
  apagados depois de 1 ano (`RETENCAO_REGISTROS_ACESSO_DIAS`, prazo proposto); o resto fica.
- **Erros:** toda resposta de erro sai em pt-BR (inclusive JSON malformado, parâmetro inválido e
  rota inexistente) e com `Cache-Control: no-store`.
