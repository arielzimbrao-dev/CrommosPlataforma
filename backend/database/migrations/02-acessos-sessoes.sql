-- 02 — Acessos (quem abre qual tenant de qual produto), sessões de refresh e
-- dados de exibição do tenant na assinatura. Ver docs/contrato.md.

-- Acesso da pessoa a um tenant de um produto: login (lista de clínicas),
-- limite de usuários da assinatura e papel nas telas de assinatura. O papel é
-- o do produto (texto livre aqui: a plataforma só distingue admin/financeiro).
-- Convite pendente é acesso ativo (ocupa vaga) cuja pessoa ainda não definiu a
-- senha.
CREATE TABLE IF NOT EXISTS crommos.acessos (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id        UUID          NOT NULL,
  produto           VARCHAR(10)   NOT NULL,
  tenant_id         UUID          NOT NULL,
  papel             VARCHAR(30)   NOT NULL,
  ativo             BOOLEAN       NOT NULL DEFAULT TRUE,
  convite_pendente  BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_acessos_produto CHECK (produto IN ('clinic', 'odonto', 'vet')),
  CONSTRAINT fk_acessos_usuario FOREIGN KEY (usuario_id) REFERENCES crommos.usuarios (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_acessos_usuario_produto_tenant
  ON crommos.acessos (usuario_id, produto, tenant_id);
-- Contagem do limite de usuários e listagens por tenant.
CREATE INDEX IF NOT EXISTS idx_acessos_produto_tenant
  ON crommos.acessos (produto, tenant_id) WHERE ativo;

-- Sessão de refresh: uma por jti; guarda só o hash do token. Rotação a cada
-- refresh: a anterior fica revogada com `substituida_por` = jti da nova, e
-- reapresentá-la (reuso) revoga todas as sessões da pessoa. Revogada sem
-- substituta (logout, senha, desativação) só dá 401.
CREATE TABLE IF NOT EXISTS crommos.sessoes (
  jti           UUID          PRIMARY KEY,
  usuario_id    UUID          NOT NULL,
  produto       VARCHAR(10)   NOT NULL,
  tenant_id     UUID          NOT NULL,
  refresh_hash  VARCHAR(64)   NOT NULL,
  expira_em     TIMESTAMPTZ   NOT NULL,
  revogada_em   TIMESTAMPTZ,
  substituida_por UUID,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_sessoes_usuario FOREIGN KEY (usuario_id)
    REFERENCES crommos.usuarios (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessoes_usuario
  ON crommos.sessoes (usuario_id) WHERE revogada_em IS NULL;
-- Limpeza diária das sessões vencidas.
CREATE INDEX IF NOT EXISTS idx_sessoes_expira_em ON crommos.sessoes (expira_em);

-- Nome e código curto do tenant, para a escolha de clínica no login (o código
-- é gerado pela plataforma no signup; único entre os tenants vigentes).
ALTER TABLE crommos.assinaturas ADD COLUMN IF NOT EXISTS tenant_nome VARCHAR(255);
ALTER TABLE crommos.assinaturas ADD COLUMN IF NOT EXISTS tenant_codigo VARCHAR(5);
CREATE UNIQUE INDEX IF NOT EXISTS uq_assinaturas_tenant_codigo
  ON crommos.assinaturas (tenant_codigo)
  WHERE tenant_codigo IS NOT NULL AND deleted_at IS NULL;
