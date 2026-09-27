-- 08 — Família da sessão (QA-002): o jti da 1ª sessão de um login, herdado a
-- cada rotação do refresh. Vai no access token como `sid`; o access vale só
-- enquanto a família tiver uma sessão vigente — logout, redefinição/troca de
-- senha, desativação e reuso derrubam o access na hora (plataforma e produto
-- conferem por requisição). O Clinic cria o mesmo (migration 98 dele) para não
-- depender da ordem de deploy; mesmos nomes. Idempotente.

ALTER TABLE crommos.sessoes ADD COLUMN IF NOT EXISTS familia UUID;
UPDATE crommos.sessoes SET familia = jti WHERE familia IS NULL;
CREATE INDEX IF NOT EXISTS idx_sessoes_familia
  ON crommos.sessoes (familia) WHERE revogada_em IS NULL;
