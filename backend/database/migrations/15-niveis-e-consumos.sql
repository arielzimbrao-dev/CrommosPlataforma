-- 15 — Níveis com franquia (Crommos/docs/03-precificacao.md): Agenda e Fiscal
-- têm 3 níveis (Essencial, Profissional, Avançado), que mudam o preço do
-- assento e a franquia mensal por assento — mensagens de WhatsApp na Agenda,
-- NFS-e no Fiscal. O excedente entra na fatura da renovação, como o das
-- teleconsultas.
--
-- `assinaturas.niveis`: nível por módulo ({"agenda": "profissional"}); ausente
-- = Essencial. `consumos`: o produto informa cada mensagem enviada ou nota
-- emitida (POST /interno/consumos); `referencia` = id no produto (reenvio não
-- conta duas vezes). Sem dado de paciente.
-- Idempotente.

ALTER TABLE crommos.assinaturas
  ADD COLUMN IF NOT EXISTS niveis JSONB NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS crommos.consumos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produto VARCHAR(10) NOT NULL CHECK (produto IN ('clinic', 'odonto', 'vet')),
  tenant_id UUID NOT NULL,
  tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('whatsapp', 'nfse')),
  referencia UUID NOT NULL,
  ocorrido_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_consumos_referencia UNIQUE (produto, tipo, referencia)
);

CREATE INDEX IF NOT EXISTS ix_consumos_tenant
  ON crommos.consumos (produto, tenant_id, ocorrido_em);
