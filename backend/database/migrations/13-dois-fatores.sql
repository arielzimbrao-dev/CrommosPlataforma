-- 13 — Verificação em duas etapas (TOTP, revisão LGPD L-07). Da pessoa (vale
-- em todos os produtos): segredo cifrado (AES-256-GCM, DATA_ENCRYPTION_KEY),
-- ligado desde (NULL = não ligado ou configuração pendente), último passo de
-- 30 s aceito (o mesmo código não vale duas vezes) e o SHA-256 dos códigos de
-- recuperação de uso único. A clínica pode exigir 2FA de admin e de quem vê
-- prontuário (padrão desligado: o dono decide). Idempotente.

ALTER TABLE crommos.usuarios ADD COLUMN IF NOT EXISTS totp_segredo TEXT;
ALTER TABLE crommos.usuarios ADD COLUMN IF NOT EXISTS totp_ativo_em TIMESTAMPTZ;
ALTER TABLE crommos.usuarios ADD COLUMN IF NOT EXISTS totp_ultimo_passo BIGINT;
ALTER TABLE crommos.usuarios ADD COLUMN IF NOT EXISTS totp_recuperacao TEXT[];

ALTER TABLE crommos.assinaturas
  ADD COLUMN IF NOT EXISTS exigir_2fa BOOLEAN NOT NULL DEFAULT FALSE;
