# Crommos Plataforma

Backend **da plataforma** Crommos (`plataforma-api`): o que é comum aos produtos
Clinic, Odonto e Vet — **login único**, **signup**, **acessos** (quem abre qual
clínica de qual produto), **assinaturas** e **faturas**. Os produtos cuidam só do
que é deles (clínicas, unidades, vínculos, dados clínicos).

- Contrato com os produtos (fonte da verdade): [`docs/contrato.md`](docs/contrato.md)
- Desenho: `Crommos/docs/16-backend-plataforma.md` (workspace)

| Pasta | Conteúdo |
|---|---|
| `backend/` | API NestJS 11 + TypeORM + PostgreSQL 16 (schema `crommos`) — ver [`backend/context.md`](backend/context.md) |
| `docs/` | Contrato da integração |
| `.github/workflows/ci.yml` | Lint, typecheck, build e testes (unit + integração com Postgres, gate de cobertura 85%) |

## Rodar local

```bash
cd backend
cp .env.example .env      # preencha as chaves RS256 (instruções no arquivo) e DB_*
docker compose up -d      # Postgres local (ou use um existente)
npm ci
npm run start:dev         # :3000, aplica as migrations do schema crommos no boot
```

Testes: `npm test` (unit); `RUN_DB_TESTS=true npm test` inclui a integração
(bancos `plat_test` e `plat_int`).

## Deploy

Aplicação Docker no Coolify (`Base Directory = backend`, `Dockerfile`), no mesmo
Postgres dos produtos. **Healthcheck: `GET /health/ready`** (confere o banco;
`/health` é só liveness). Pode rodar com **várias réplicas**: rate limit no
Postgres, jobs e migrations com advisory lock, sem estado em memória.

Ordem de subida: não importa. Em produção, antes das migrations a plataforma
espera o schema de cada produto configurado existir (`DB_AGUARDAR_SCHEMAS`
sobrescreve).

Variáveis (lista completa e validação no boot em
`backend/src/config/env.validation.ts`; exemplo comentado em `backend/.env.example`):

| Variável | Para quê |
|---|---|
| `DB_*`, `PORT`, `TZ` | Banco e processo |
| `FRONTEND_URL`, `API_URL` | Links dos e-mails e da confirmação — **obrigatórias em produção** |
| `FRONTEND_URLS` | Allowlist de CORS (CSV); vazia = `FRONTEND_URL` |
| `PLATAFORMA_JWT_PRIVATE_KEY` / `PLATAFORMA_JWT_PUBLIC_KEY` | Par RS256 (o boot confere que fecham); a `kid` do token é o thumbprint da pública |
| `PLATAFORMA_JWT_PUBLIC_KEY_ANTERIOR` | Só durante a rotação da chave: a pública antiga, aceita pela `kid` (contrato) |
| `PLATAFORMA_JWT_ISSUER` | `iss` dos tokens (padrão `crommos-plataforma`; igual nos produtos) |
| `<PRODUTO>_API_URL` + `SERVICO_KEY_<PRODUTO>` | Produto disponível (as duas ou nenhuma; chave ≥ 32 e distinta por produto) |
| `PROVISIONAMENTO_KEY_<PRODUTO>` | Chave própria do sentido plataforma → produto (no Clinic é a `SERVICO_KEY_PROVISIONAMENTO`); vazia = vale a `SERVICO_KEY_<PRODUTO>` |
| `DATA_ENCRYPTION_KEY` | Cifra do segredo do 2FA (≥ 32 caracteres, `openssl rand -hex 32`, diferente da do Clinic). Sem ela, ligar o 2FA responde 503 |
| `TRUST_PROXY` | Confiar em 1 hop de proxy para o IP real (rate limit e registros de acesso); em produção já vale |
| `COOKIE_DOMAIN`, `COOKIE_SECURE`, `COOKIE_SAMESITE` | Cookie do refresh (`crommos_rt`); domínio _a definir_ |
| `RESEND_API_KEY`, `EMAIL_FROM` | E-mail (sem a chave, stub) |
| `ABACATEPAY_API_KEY` + `ABACATEPAY_WEBHOOK_SECRET` (≥ 16) | Cobrança; cadastre o webhook `https://<plataforma>/webhooks/abacatepay?webhookSecret=<segredo>` no painel da AbacatePay. Opcionais: `ABACATEPAY_API_URL`, `ABACATEPAY_HMAC_KEY` |
| `DIAS_TOLERANCIA_INADIMPLENCIA` | Dias até o modo leitura por fatura vencida (padrão 7) |
| `PLATAFORMA_API_KEY` | Baixa manual de fatura (`X-Plataforma-Key`); vazia = rota 404 |
| `ENABLE_SWAGGER`, `SWAGGER_USER`, `SWAGGER_PASSWORD` | Swagger opcional, com Basic Auth |

Usuário de banco próprio (`plataforma_app`, dono do `crommos`): script no
repositório do Clinic (`backend/database/manual/roles-por-schema.sql`), a rodar
de novo depois de cada deploy que criar tabela.

## O que a plataforma faz hoje (30/09/2026)

- **Login único** com sessões rotativas, convite por e-mail e escolha de clínica.
- **Verificação em duas etapas** (TOTP + 10 códigos de recuperação). A clínica pode
  exigir de admin, profissional e acessos clínicos (padrão: não exige); o admin
  desliga o 2FA de quem tem acesso ativo e aceito (a pessoa recebe e-mail e o
  evento vai para a trilha de todas as clínicas dela).
- **Registros de acesso** com IP e navegador (login, falha, refresh, senha, logout,
  2FA), tela do admin com os últimos 90 dias e purga diária depois de 1 ano.
- **LGPD da pessoa:** exportar os dados e excluir a conta; a exclusão é propagada
  aos produtos (cópia local anonimizada, vínculo desativado e sem reativação).
- **Assinatura:** preço por módulo em escada por assento, pró-rata, trial de 14
  dias, modo leitura, cobrança pela AbacatePay (PIX e cartão).
- **Erros em pt-BR** em todas as respostas (validação, JSON malformado, parâmetro
  inválido, rota inexistente), com `Cache-Control: no-store`.
