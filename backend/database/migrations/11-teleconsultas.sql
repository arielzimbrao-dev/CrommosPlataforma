-- 11 — Franquia da Telemedicina (Crommos/docs/03-precificacao.md): 20
-- teleconsultas realizadas por assento/mês incluídas; o excedente (R$ 2,00
-- cada) entra na fatura da renovação. O produto informa cada teleconsulta
-- concluída (POST /interno/teleconsultas); `referencia` = id do atendimento
-- no produto (reenvio não conta duas vezes). Sem dado de paciente.
-- Idempotente.

CREATE TABLE IF NOT EXISTS crommos.teleconsultas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produto VARCHAR(10) NOT NULL CHECK (produto IN ('clinic', 'odonto', 'vet')),
  tenant_id UUID NOT NULL,
  referencia UUID NOT NULL,
  realizada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_teleconsultas_referencia UNIQUE (produto, referencia)
);

CREATE INDEX IF NOT EXISTS ix_teleconsultas_tenant
  ON crommos.teleconsultas (produto, tenant_id, realizada_em);
