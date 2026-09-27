-- 09 — Aceite de convite de quem já tem conta (QA-004): o acesso nasce
-- `convite_pendente` e só entra no login depois que a pessoa aceita pelo link
-- do e-mail (`GET /auth/aceitar-convite`). O token é do acesso (hash + validade
-- de 7 dias). Quem ainda não tem senha segue com o token da pessoa (definir a
-- senha aceita). Idempotente.

ALTER TABLE crommos.acessos ADD COLUMN IF NOT EXISTS convite_hash VARCHAR(64);
ALTER TABLE crommos.acessos ADD COLUMN IF NOT EXISTS convite_expira_em TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS uq_acessos_convite_hash
  ON crommos.acessos (convite_hash) WHERE convite_hash IS NOT NULL;
