-- 12 — Registros de acesso (Marco Civil, art. 15; revisão LGPD L-24): login
-- (sucesso e falha), logout, refresh e troca de senha já vão para
-- crommos.auditoria (resource = 'auth'); agora com o IP e o navegador (user
-- agent). Retenção proposta de 1 ano (RETENCAO_REGISTROS_ACESSO_DIAS em
-- src/audit/audit.service.ts): a limpeza diária apaga os mais antigos.
-- Idempotente.

ALTER TABLE crommos.auditoria ADD COLUMN IF NOT EXISTS ip VARCHAR(45);
ALTER TABLE crommos.auditoria ADD COLUMN IF NOT EXISTS user_agent VARCHAR(255);

-- Purga diária por data (só os registros de acesso).
CREATE INDEX IF NOT EXISTS idx_auditoria_auth_created
  ON crommos.auditoria (created_at) WHERE resource = 'auth';
