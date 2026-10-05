-- 16 — Alerta de franquia: e-mail aos admins da clínica ao chegar a 80% e a
-- 100% da franquia do ciclo (WhatsApp, NFS-e). Uma linha por ciclo e limiar:
-- a chave primária garante um aviso só, mesmo com mensagens simultâneas.
-- Idempotente.

CREATE TABLE IF NOT EXISTS crommos.alertas_franquia (
  produto VARCHAR(10) NOT NULL,
  tenant_id UUID NOT NULL,
  tipo VARCHAR(20) NOT NULL,
  ciclo_inicio DATE NOT NULL,
  limiar SMALLINT NOT NULL CHECK (limiar IN (80, 100)),
  enviado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (produto, tenant_id, tipo, ciclo_inicio, limiar)
);
