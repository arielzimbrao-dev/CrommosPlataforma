-- 06 — Rate limit compartilhado entre as réplicas (ThrottlerPostgres): uma
-- linha por chave (hash do throttler: rota + IP), janela fixa. Linhas vencidas
-- são apagadas pela própria storage de tempos em tempos.

CREATE TABLE IF NOT EXISTS crommos.rate_limit (
  chave          VARCHAR(128)  PRIMARY KEY,
  hits           INT           NOT NULL,
  janela_fim     TIMESTAMPTZ   NOT NULL,
  bloqueado_ate  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_janela_fim ON crommos.rate_limit (janela_fim);
