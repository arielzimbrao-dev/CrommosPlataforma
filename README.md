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
sobrescreve). Variáveis novas do MVP (ver `backend/.env.example`):
`RESEND_API_KEY`/`EMAIL_FROM` (e-mail), `ABACATEPAY_API_KEY` +
`ABACATEPAY_WEBHOOK_SECRET` (cobrança; cadastre o webhook
`https://<plataforma>/webhooks/abacatepay?webhookSecret=<segredo>` no painel da
AbacatePay), `DIAS_TOLERANCIA_INADIMPLENCIA` (padrão 7) e
`PROVISIONAMENTO_KEY_<PRODUTO>` (chave própria do sentido plataforma → produto).
Usuário de banco próprio (`plataforma_app`, dono do `crommos`): script no
repositório do Clinic (`backend/database/manual/roles-por-schema.sql`).
