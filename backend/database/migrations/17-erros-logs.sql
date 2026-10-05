-- 17 — Registro de erros da API: uma linha por resposta de erro (menos 401,
-- 404 e 429, que são esperados e de volume alto). Para depurar: método,
-- caminho sem query e sem token, status, tenant, pessoa, a resposta enviada, o
-- erro (do banco, sem valores) e só os NOMES dos campos do corpo — senha,
-- e-mail e token não entram. Retenção de 7 dias pela purga diária
-- (SessoesCron). Só cresce: sem updated_at/deleted_at.
-- Idempotente.

CREATE TABLE IF NOT EXISTS crommos.erros_logs (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  criado_em   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  metodo      VARCHAR(16)  NOT NULL,
  caminho     TEXT         NOT NULL,
  status      INT          NOT NULL,
  tenant_id   UUID,
  usuario_id  UUID,
  resposta    JSONB,
  erro        TEXT,
  requisicao  JSONB,
  ip          VARCHAR(64),
  navegador   TEXT
);
CREATE INDEX IF NOT EXISTS idx_erros_logs_criado_em
  ON crommos.erros_logs (criado_em);
CREATE INDEX IF NOT EXISTS idx_erros_logs_status
  ON crommos.erros_logs (status, criado_em);
CREATE INDEX IF NOT EXISTS idx_erros_logs_tenant
  ON crommos.erros_logs (tenant_id, criado_em);
