-- 03 — Trilha de auditoria da plataforma (append-only): login, signup,
-- senha, acessos e assinatura. Ator = pessoa (NULL = sistema/backoffice).

CREATE TABLE IF NOT EXISTS crommos.auditoria (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id   UUID,
  produto      VARCHAR(10),
  tenant_id    UUID,
  action       VARCHAR(50)   NOT NULL,
  resource     VARCHAR(50)   NOT NULL,
  resource_id  VARCHAR(255),
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auditoria_tenant_created
  ON crommos.auditoria (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auditoria_usuario_created
  ON crommos.auditoria (usuario_id, created_at DESC);
