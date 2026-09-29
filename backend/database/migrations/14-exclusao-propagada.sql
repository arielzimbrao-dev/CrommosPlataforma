-- 14 — Exclusão da conta propagada aos produtos (revisão LGPD L-29): ao
-- excluir a conta, a plataforma anonimiza crommos.usuarios e pede a cada
-- produto em que a pessoa tinha acesso que anonimize a cópia local de nome e
-- e-mail (POST /interno/usuarios/:id/anonimizar). Produtos que ainda não
-- confirmaram ficam aqui; um job tenta de novo a cada 10 minutos. Idempotente.

ALTER TABLE crommos.usuarios
  ADD COLUMN IF NOT EXISTS exclusao_pendente VARCHAR(10)[];

CREATE INDEX IF NOT EXISTS idx_usuarios_exclusao_pendente
  ON crommos.usuarios (id) WHERE cardinality(exclusao_pendente) > 0;
