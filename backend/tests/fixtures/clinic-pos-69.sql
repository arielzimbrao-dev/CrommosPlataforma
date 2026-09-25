-- Retrato do schema do Clinic depois das migrations 01–69 (pg_dump -s),
-- reduzido ao que a plataforma toca: o schema crommos inteiro e
-- clinic.clinicas/clinic.users. Usado pelo migrations.integration.spec
-- quando o repositório do Clinic não está ao lado (CI). Não editar à mão:
-- regerar com pg_dump se o Clinic mudar essas tabelas.

CREATE TABLE IF NOT EXISTS public._sql_migrations (
  filename   VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
INSERT INTO public._sql_migrations (filename) VALUES ('68-schemas-plataforma.sql'), ('69-usuarios-plataforma.sql');

-- SCHEMA: clinic
CREATE SCHEMA clinic;

-- SCHEMA: crommos
CREATE SCHEMA crommos;

-- TYPE: user_role
CREATE TYPE clinic.user_role AS ENUM (
    'admin',
    'gestor',
    'recepcao',
    'profissional',
    'financeiro'
);

-- TABLE: clinicas
CREATE TABLE clinic.clinicas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    razao_social character varying(255) NOT NULL,
    nome_fantasia character varying(255),
    cnpj character varying(18),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    created_by character varying(255),
    updated_by character varying(255),
    deleted_by character varying(255),
    codigo character varying(5),
    ultimo_lote_tiss bigint DEFAULT 0 NOT NULL,
    telefone character varying(30),
    email character varying(255),
    cep character varying(9),
    logradouro character varying(255),
    numero character varying(30),
    complemento character varying(255),
    bairro character varying(255),
    cidade character varying(255),
    uf character varying(2),
    logo_url character varying(500),
    cliente_id uuid
);

-- TABLE: users
CREATE TABLE clinic.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    email character varying(255) NOT NULL,
    role clinic.user_role DEFAULT 'recepcao'::clinic.user_role NOT NULL,
    active boolean DEFAULT true NOT NULL,
    hashed_refresh_token character varying(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    created_by character varying(255),
    updated_by character varying(255),
    deleted_by character varying(255),
    unidade_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    convite_pendente boolean DEFAULT false NOT NULL,
    usuario_id uuid NOT NULL
);

ALTER TABLE ONLY clinic.users FORCE ROW LEVEL SECURITY;

-- TABLE: assinaturas
CREATE TABLE crommos.assinaturas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    modulos_ativos jsonb DEFAULT '[]'::jsonb NOT NULL,
    numero_usuarios integer DEFAULT 1 NOT NULL,
    plano character varying(20) DEFAULT 'mensal'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    created_by character varying(255),
    updated_by character varying(255),
    deleted_by character varying(255),
    ciclo_inicio date NOT NULL,
    ciclo_fim date NOT NULL,
    em_trial_ate date,
    saldo_credito numeric(12,2) DEFAULT 0 NOT NULL,
    cliente_id uuid,
    produto character varying(10) DEFAULT 'clinic'::character varying NOT NULL,
    CONSTRAINT ck_assinaturas_ciclo CHECK ((ciclo_fim > ciclo_inicio)),
    CONSTRAINT ck_assinaturas_produto CHECK (((produto)::text = ANY ((ARRAY['clinic'::character varying, 'odonto'::character varying, 'vet'::character varying])::text[]))),
    CONSTRAINT ck_assinaturas_saldo_credito CHECK ((saldo_credito >= (0)::numeric))
);

ALTER TABLE ONLY crommos.assinaturas FORCE ROW LEVEL SECURITY;

-- TABLE: clientes
CREATE TABLE crommos.clientes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tipo character varying(2) DEFAULT 'pj'::character varying NOT NULL,
    documento character varying(14),
    nome character varying(255) NOT NULL,
    email_cobranca character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    created_by character varying(255),
    updated_by character varying(255),
    deleted_by character varying(255),
    CONSTRAINT ck_clientes_documento CHECK (((documento IS NULL) OR (((tipo)::text = 'pf'::text) AND ((documento)::text ~ '^[0-9]{11}$'::text)) OR (((tipo)::text = 'pj'::text) AND ((documento)::text ~ '^[0-9]{14}$'::text)))),
    CONSTRAINT clientes_tipo_check CHECK (((tipo)::text = ANY ((ARRAY['pf'::character varying, 'pj'::character varying])::text[])))
);

-- TABLE: faturas
CREATE TABLE crommos.faturas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    assinatura_id uuid NOT NULL,
    tipo character varying(20) NOT NULL,
    periodo_inicio date NOT NULL,
    periodo_fim date NOT NULL,
    valor_bruto numeric(12,2) NOT NULL,
    credito_aplicado numeric(12,2) DEFAULT 0 NOT NULL,
    valor_liquido numeric(12,2) NOT NULL,
    status character varying(20) DEFAULT 'pendente'::character varying NOT NULL,
    vencimento date NOT NULL,
    pago_em timestamp with time zone,
    itens jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    created_by character varying(255),
    updated_by character varying(255),
    deleted_by character varying(255),
    CONSTRAINT faturas_credito_aplicado_check CHECK ((credito_aplicado >= (0)::numeric)),
    CONSTRAINT faturas_status_check CHECK (((status)::text = ANY ((ARRAY['pendente'::character varying, 'paga'::character varying, 'cancelada'::character varying])::text[]))),
    CONSTRAINT faturas_tipo_check CHECK (((tipo)::text = ANY ((ARRAY['ciclo'::character varying, 'complementar'::character varying])::text[]))),
    CONSTRAINT faturas_valor_bruto_check CHECK ((valor_bruto >= (0)::numeric)),
    CONSTRAINT faturas_valor_liquido_check CHECK ((valor_liquido >= (0)::numeric))
);

ALTER TABLE ONLY crommos.faturas FORCE ROW LEVEL SECURITY;

-- TABLE: usuarios
CREATE TABLE crommos.usuarios (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email character varying(255) NOT NULL,
    nome character varying(255) NOT NULL,
    password_hash character varying(255) NOT NULL,
    password_reset_token_hash character varying(64),
    password_reset_expires_at timestamp with time zone,
    email_confirmacao_hash character varying(64),
    email_confirmacao_expira_em timestamp with time zone,
    termos_versao character varying(20),
    termos_aceitos_em timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    created_by character varying(255),
    updated_by character varying(255),
    deleted_by character varying(255)
);

-- CONSTRAINT: clinicas clinicas_pkey
ALTER TABLE ONLY clinic.clinicas
    ADD CONSTRAINT clinicas_pkey PRIMARY KEY (id);

-- CONSTRAINT: users users_pkey
ALTER TABLE ONLY clinic.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

-- CONSTRAINT: assinaturas assinaturas_pkey
ALTER TABLE ONLY crommos.assinaturas
    ADD CONSTRAINT assinaturas_pkey PRIMARY KEY (id);

-- CONSTRAINT: clientes clientes_pkey
ALTER TABLE ONLY crommos.clientes
    ADD CONSTRAINT clientes_pkey PRIMARY KEY (id);

-- CONSTRAINT: faturas faturas_pkey
ALTER TABLE ONLY crommos.faturas
    ADD CONSTRAINT faturas_pkey PRIMARY KEY (id);

-- CONSTRAINT: usuarios usuarios_pkey
ALTER TABLE ONLY crommos.usuarios
    ADD CONSTRAINT usuarios_pkey PRIMARY KEY (id);

-- INDEX: idx_clinicas_cliente
CREATE INDEX idx_clinicas_cliente ON clinic.clinicas USING btree (cliente_id);

-- INDEX: idx_users_tenant_id
CREATE INDEX idx_users_tenant_id ON clinic.users USING btree (tenant_id);

-- INDEX: idx_users_usuario
CREATE INDEX idx_users_usuario ON clinic.users USING btree (usuario_id);

-- INDEX: uq_clinicas_codigo
CREATE UNIQUE INDEX uq_clinicas_codigo ON clinic.clinicas USING btree (codigo) WHERE ((codigo IS NOT NULL) AND (deleted_at IS NULL));

-- INDEX: uq_users_tenant_email
CREATE UNIQUE INDEX uq_users_tenant_email ON clinic.users USING btree (tenant_id, email) WHERE (deleted_at IS NULL);

-- INDEX: uq_users_tenant_email_ci
CREATE UNIQUE INDEX uq_users_tenant_email_ci ON clinic.users USING btree (tenant_id, lower((email)::text)) WHERE (deleted_at IS NULL);

-- INDEX: uq_users_tenant_id_id
CREATE UNIQUE INDEX uq_users_tenant_id_id ON clinic.users USING btree (tenant_id, id);

-- INDEX: uq_users_tenant_usuario
CREATE UNIQUE INDEX uq_users_tenant_usuario ON clinic.users USING btree (tenant_id, usuario_id) WHERE (deleted_at IS NULL);

-- INDEX: idx_assinaturas_ciclo_fim
CREATE INDEX idx_assinaturas_ciclo_fim ON crommos.assinaturas USING btree (ciclo_fim) WHERE (deleted_at IS NULL);

-- INDEX: idx_faturas_tenant_created
CREATE INDEX idx_faturas_tenant_created ON crommos.faturas USING btree (tenant_id, created_at DESC);

-- INDEX: idx_faturas_tenant_id
CREATE INDEX idx_faturas_tenant_id ON crommos.faturas USING btree (tenant_id);

-- INDEX: idx_usuarios_email_confirmacao
CREATE INDEX idx_usuarios_email_confirmacao ON crommos.usuarios USING btree (email_confirmacao_hash) WHERE (email_confirmacao_hash IS NOT NULL);

-- INDEX: idx_usuarios_password_reset
CREATE INDEX idx_usuarios_password_reset ON crommos.usuarios USING btree (password_reset_token_hash) WHERE (password_reset_token_hash IS NOT NULL);

-- INDEX: uq_assinaturas_cliente_produto
CREATE UNIQUE INDEX uq_assinaturas_cliente_produto ON crommos.assinaturas USING btree (cliente_id, produto) WHERE ((cliente_id IS NOT NULL) AND (deleted_at IS NULL));

-- INDEX: uq_assinaturas_tenant
CREATE UNIQUE INDEX uq_assinaturas_tenant ON crommos.assinaturas USING btree (tenant_id) WHERE (deleted_at IS NULL);

-- INDEX: uq_assinaturas_tenant_id_id
CREATE UNIQUE INDEX uq_assinaturas_tenant_id_id ON crommos.assinaturas USING btree (tenant_id, id);

-- INDEX: uq_clientes_documento
CREATE UNIQUE INDEX uq_clientes_documento ON crommos.clientes USING btree (documento) WHERE ((documento IS NOT NULL) AND (deleted_at IS NULL));

-- INDEX: uq_faturas_ciclo_periodo
CREATE UNIQUE INDEX uq_faturas_ciclo_periodo ON crommos.faturas USING btree (tenant_id, periodo_inicio) WHERE (((tipo)::text = 'ciclo'::text) AND (deleted_at IS NULL));

-- INDEX: uq_usuarios_email
CREATE UNIQUE INDEX uq_usuarios_email ON crommos.usuarios USING btree (lower((email)::text)) WHERE (deleted_at IS NULL);

-- FK CONSTRAINT: clinicas fk_clinicas_cliente
ALTER TABLE ONLY clinic.clinicas
    ADD CONSTRAINT fk_clinicas_cliente FOREIGN KEY (cliente_id) REFERENCES crommos.clientes(id);

-- FK CONSTRAINT: users fk_users_usuario
ALTER TABLE ONLY clinic.users
    ADD CONSTRAINT fk_users_usuario FOREIGN KEY (usuario_id) REFERENCES crommos.usuarios(id);

-- FK CONSTRAINT: assinaturas fk_assinaturas_cliente
ALTER TABLE ONLY crommos.assinaturas
    ADD CONSTRAINT fk_assinaturas_cliente FOREIGN KEY (cliente_id) REFERENCES crommos.clientes(id);

-- FK CONSTRAINT: faturas fk_faturas_assinatura
ALTER TABLE ONLY crommos.faturas
    ADD CONSTRAINT fk_faturas_assinatura FOREIGN KEY (tenant_id, assinatura_id) REFERENCES crommos.assinaturas(tenant_id, id);

-- POLICY: users tenant_isolation
CREATE POLICY tenant_isolation ON clinic.users USING (((current_setting('app.rls_enforce'::text, true) IS DISTINCT FROM 'on'::text) OR (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid))) WITH CHECK (((current_setting('app.rls_enforce'::text, true) IS DISTINCT FROM 'on'::text) OR (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)));

-- ROW SECURITY: users
ALTER TABLE clinic.users ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: assinaturas
ALTER TABLE crommos.assinaturas ENABLE ROW LEVEL SECURITY;

-- ROW SECURITY: faturas
ALTER TABLE crommos.faturas ENABLE ROW LEVEL SECURITY;

-- POLICY: assinaturas tenant_isolation
CREATE POLICY tenant_isolation ON crommos.assinaturas USING (((current_setting('app.rls_enforce'::text, true) IS DISTINCT FROM 'on'::text) OR (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid))) WITH CHECK (((current_setting('app.rls_enforce'::text, true) IS DISTINCT FROM 'on'::text) OR (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)));

-- POLICY: faturas tenant_isolation
CREATE POLICY tenant_isolation ON crommos.faturas USING (((current_setting('app.rls_enforce'::text, true) IS DISTINCT FROM 'on'::text) OR (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid))) WITH CHECK (((current_setting('app.rls_enforce'::text, true) IS DISTINCT FROM 'on'::text) OR (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)));

