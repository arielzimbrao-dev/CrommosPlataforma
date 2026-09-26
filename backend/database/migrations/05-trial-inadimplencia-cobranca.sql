-- 05 — Fim do trial, inadimplência (modo leitura), cobrança pela AbacatePay e
-- mais de uma clínica por cliente. Ver docs/contrato.md.
--
-- - assinaturas.trial_confirmado_em: o admin confirmou módulos/usuários. Sem
--   confirmação, ao fim do trial a clínica fica em MODO LEITURA (nada é
--   faturado). Assinaturas cujo trial já acabou (e que a renovação já
--   converteu) contam como confirmadas.
-- - assinaturas.inadimplente_desde: fatura pendente vencida há mais de
--   DIAS_TOLERANCIA_INADIMPLENCIA dias → modo leitura. Mantida pela
--   plataforma (job diário e a cada baixa); os produtos só leem.
-- - faturas.cobranca_id / cobranca_url: checkout da AbacatePay (criado sob
--   demanda); clientes.abacatepay_id: cliente na AbacatePay.
-- - R2: um cliente (CPF/CNPJ) pode ter várias clínicas do mesmo produto.

ALTER TABLE crommos.assinaturas ADD COLUMN IF NOT EXISTS trial_confirmado_em TIMESTAMPTZ;
ALTER TABLE crommos.assinaturas ADD COLUMN IF NOT EXISTS inadimplente_desde DATE;

UPDATE crommos.assinaturas
   SET trial_confirmado_em = NOW()
 WHERE trial_confirmado_em IS NULL
   AND em_trial_ate IS NOT NULL
   AND ciclo_fim > em_trial_ate;

ALTER TABLE crommos.faturas ADD COLUMN IF NOT EXISTS cobranca_id VARCHAR(64);
ALTER TABLE crommos.faturas ADD COLUMN IF NOT EXISTS cobranca_url TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_faturas_cobranca_id
  ON crommos.faturas (cobranca_id) WHERE cobranca_id IS NOT NULL;
-- Varredura da inadimplência.
CREATE INDEX IF NOT EXISTS idx_faturas_pendentes_vencimento
  ON crommos.faturas (vencimento) WHERE status = 'pendente' AND deleted_at IS NULL;

ALTER TABLE crommos.clientes ADD COLUMN IF NOT EXISTS abacatepay_id VARCHAR(64);

DROP INDEX IF EXISTS crommos.uq_assinaturas_cliente_produto;
CREATE INDEX IF NOT EXISTS idx_assinaturas_cliente
  ON crommos.assinaturas (cliente_id) WHERE cliente_id IS NOT NULL AND deleted_at IS NULL;
