-- 01 — Schema geral da plataforma (crommos): clientes, usuários (login único),
-- assinaturas e faturas. Ver docs/contrato.md.
--
-- Compatível com os dois cenários:
--   - banco vazio: cria tudo aqui;
--   - banco em que o Clinic já rodou as migrations 68/69 (as tabelas já
--     existem): os CREATE ... IF NOT EXISTS não fazem nada.
-- As colunas, constraints e índices são os mesmos do Clinic (12, 29, 37, 38,
-- 68 e 69), com os mesmos nomes — o que um lado criou o outro reconhece.
-- A RLS que o Clinic liga em assinaturas/faturas (migration 32) é do produto e
-- fica fora daqui (a plataforma não usa `app.rls_enforce`).

CREATE SCHEMA IF NOT EXISTS crommos;

-- Cliente (pagador): CPF do dono ou CNPJ da matriz, só dígitos.
CREATE TABLE IF NOT EXISTS crommos.clientes (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo             VARCHAR(2)    NOT NULL DEFAULT 'pj' CHECK (tipo IN ('pf', 'pj')),
  documento        VARCHAR(14),
  nome             VARCHAR(255)  NOT NULL,
  email_cobranca   VARCHAR(255),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  deleted_at       TIMESTAMPTZ,
  created_by       VARCHAR(255),
  updated_by       VARCHAR(255),
  deleted_by       VARCHAR(255),
  CONSTRAINT ck_clientes_documento CHECK (
    documento IS NULL
    OR (tipo = 'pf' AND documento ~ '^[0-9]{11}$')
    OR (tipo = 'pj' AND documento ~ '^[0-9]{14}$')
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_clientes_documento
  ON crommos.clientes (documento) WHERE documento IS NOT NULL AND deleted_at IS NULL;

-- Pessoa com login (e-mail único na plataforma, sem diferenciar maiúsculas).
CREATE TABLE IF NOT EXISTS crommos.usuarios (
  id                           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  email                        VARCHAR(255)  NOT NULL,
  nome                         VARCHAR(255)  NOT NULL,
  password_hash                VARCHAR(255)  NOT NULL,
  -- Token de uso único da redefinição de senha e do convite (definir senha).
  password_reset_token_hash    VARCHAR(64),
  password_reset_expires_at    TIMESTAMPTZ,
  -- Confirmação do e-mail do signup: NULL = confirmado ou não se aplica.
  email_confirmacao_hash       VARCHAR(64),
  email_confirmacao_expira_em  TIMESTAMPTZ,
  termos_versao                VARCHAR(20),
  termos_aceitos_em            TIMESTAMPTZ,
  created_at                   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  deleted_at                   TIMESTAMPTZ,
  created_by                   VARCHAR(255),
  updated_by                   VARCHAR(255),
  deleted_by                   VARCHAR(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_usuarios_email
  ON crommos.usuarios (lower(email)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_usuarios_password_reset
  ON crommos.usuarios (password_reset_token_hash)
  WHERE password_reset_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usuarios_email_confirmacao
  ON crommos.usuarios (email_confirmacao_hash)
  WHERE email_confirmacao_hash IS NOT NULL;

-- Assinatura: uma por tenant (e no máximo uma por cliente × produto).
CREATE TABLE IF NOT EXISTS crommos.assinaturas (
  id               UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID           NOT NULL,
  modulos_ativos   JSONB          NOT NULL DEFAULT '[]',
  numero_usuarios  INT            NOT NULL DEFAULT 1,
  plano            VARCHAR(20)    NOT NULL DEFAULT 'mensal',
  created_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  deleted_at       TIMESTAMPTZ,
  created_by       VARCHAR(255),
  updated_by       VARCHAR(255),
  deleted_by       VARCHAR(255),
  ciclo_inicio     DATE           NOT NULL,
  ciclo_fim        DATE           NOT NULL,
  em_trial_ate     DATE,
  saldo_credito    NUMERIC(12,2)  NOT NULL DEFAULT 0,
  cliente_id       UUID,
  produto          VARCHAR(10)    NOT NULL DEFAULT 'clinic',
  CONSTRAINT ck_assinaturas_ciclo CHECK (ciclo_fim > ciclo_inicio),
  CONSTRAINT ck_assinaturas_saldo_credito CHECK (saldo_credito >= 0),
  CONSTRAINT ck_assinaturas_produto CHECK (produto IN ('clinic', 'odonto', 'vet')),
  CONSTRAINT fk_assinaturas_cliente FOREIGN KEY (cliente_id) REFERENCES crommos.clientes (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_assinaturas_tenant
  ON crommos.assinaturas (tenant_id) WHERE deleted_at IS NULL;
-- Alvo da FK composta de faturas.
CREATE UNIQUE INDEX IF NOT EXISTS uq_assinaturas_tenant_id_id
  ON crommos.assinaturas (tenant_id, id);
-- Varredura diária da renovação.
CREATE INDEX IF NOT EXISTS idx_assinaturas_ciclo_fim
  ON crommos.assinaturas (ciclo_fim) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_assinaturas_cliente_produto
  ON crommos.assinaturas (cliente_id, produto) WHERE cliente_id IS NOT NULL AND deleted_at IS NULL;

-- Faturas da assinatura. tipo: 'ciclo' | 'complementar';
-- status: 'pendente' | 'paga' | 'cancelada'; itens = memória do cálculo.
CREATE TABLE IF NOT EXISTS crommos.faturas (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID          NOT NULL,
  assinatura_id     UUID          NOT NULL,
  tipo              VARCHAR(20)   NOT NULL CHECK (tipo IN ('ciclo', 'complementar')),
  periodo_inicio    DATE          NOT NULL,
  periodo_fim       DATE          NOT NULL,
  valor_bruto       NUMERIC(12,2) NOT NULL CHECK (valor_bruto >= 0),
  credito_aplicado  NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (credito_aplicado >= 0),
  valor_liquido     NUMERIC(12,2) NOT NULL CHECK (valor_liquido >= 0),
  status            VARCHAR(20)   NOT NULL DEFAULT 'pendente'
                                  CHECK (status IN ('pendente', 'paga', 'cancelada')),
  vencimento        DATE          NOT NULL,
  pago_em           TIMESTAMPTZ,
  itens             JSONB         NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ,
  created_by        VARCHAR(255),
  updated_by        VARCHAR(255),
  deleted_by        VARCHAR(255),
  CONSTRAINT fk_faturas_assinatura
    FOREIGN KEY (tenant_id, assinatura_id) REFERENCES crommos.assinaturas (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_faturas_tenant_id ON crommos.faturas (tenant_id);
CREATE INDEX IF NOT EXISTS idx_faturas_tenant_created ON crommos.faturas (tenant_id, created_at DESC);
-- Uma fatura de ciclo por período: a renovação não cobra duas vezes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_faturas_ciclo_periodo
  ON crommos.faturas (tenant_id, periodo_inicio) WHERE tipo = 'ciclo' AND deleted_at IS NULL;
