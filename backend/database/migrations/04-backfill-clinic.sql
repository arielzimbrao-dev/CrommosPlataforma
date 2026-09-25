-- 04 — Backfill a partir do Clinic (uma vez), quando o schema `clinic` existe
-- (banco que já rodava o Clinic com as migrations 68/69). Num banco sem o
-- Clinic, não faz nada.
--
-- - acessos: um por vínculo vigente (clinic.users) em clínica vigente, com o
--   papel, o ativo e o convite pendente do vínculo;
-- - assinaturas.tenant_nome/tenant_codigo: nome fantasia (ou razão social) e
--   código curto da clínica.
-- Leitura do `clinic` só aqui; SQL dinâmico para não depender das tabelas no
-- parse. Idempotente (ON CONFLICT / só preenche o que está vazio).

DO $$
BEGIN
  IF to_regclass('clinic.users') IS NOT NULL
     AND to_regclass('clinic.clinicas') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'clinic' AND table_name = 'users'
          AND column_name = 'usuario_id'
     ) THEN
    EXECUTE $q$
      INSERT INTO crommos.acessos
             (usuario_id, produto, tenant_id, papel, ativo, convite_pendente)
      SELECT u.usuario_id, 'clinic', u.tenant_id, u.role::text, u.active,
             u.convite_pendente
        FROM clinic.users u
        JOIN clinic.clinicas c ON c.id = u.tenant_id AND c.deleted_at IS NULL
       WHERE u.deleted_at IS NULL AND u.usuario_id IS NOT NULL
      ON CONFLICT (usuario_id, produto, tenant_id) DO NOTHING
    $q$;
  END IF;

  IF to_regclass('clinic.clinicas') IS NOT NULL THEN
    EXECUTE $q$
      UPDATE crommos.assinaturas a
         SET tenant_nome = COALESCE(a.tenant_nome,
                                    NULLIF(c.nome_fantasia, ''), c.razao_social),
             tenant_codigo = COALESCE(a.tenant_codigo, c.codigo)
        FROM clinic.clinicas c
       WHERE c.id = a.tenant_id AND c.deleted_at IS NULL
         AND a.produto = 'clinic'
         AND (a.tenant_nome IS NULL OR a.tenant_codigo IS NULL)
    $q$;
  END IF;
END $$;
