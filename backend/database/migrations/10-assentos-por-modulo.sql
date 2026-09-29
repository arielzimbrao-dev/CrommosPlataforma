-- 10 — Assento por módulo (Crommos/docs/03-precificacao.md): a cobrança conta
-- as pessoas com acesso a cada módulo, derivadas dos acessos ativos e do papel.
-- Prontuário/Exames/Telemedicina só contam quem é vinculado a um profissional
-- de saúde no produto: `acessos.clinico` (o produto informa em
-- POST/PATCH /interno/acessos). `assinaturas.numero_usuarios` deixa de ser
-- limite: passa a guardar as pessoas cobradas (informativo).
--
-- Backfill (uma vez, se o schema do Clinic existir): clinico = vínculo com um
-- profissional vigente. Migração sem cobrança maior: com a mesma equipe, o
-- valor novo é ≤ 85% do antigo (preço −15%, faixas só descontam, e cada
-- módulo conta no máximo as pessoas ativas, que eram ≤ numero_usuarios pelo
-- limite antigo). O ciclo em curso não é refaturado; vale na renovação.
-- Idempotente.

ALTER TABLE crommos.acessos ADD COLUMN IF NOT EXISTS clinico BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF to_regclass('clinic.users') IS NOT NULL
     AND to_regclass('clinic.profissionais') IS NOT NULL THEN
    EXECUTE $q$
      UPDATE crommos.acessos a
         SET clinico = TRUE
        FROM clinic.users u
        JOIN clinic.profissionais p
          ON p.user_id = u.id AND p.tenant_id = u.tenant_id AND p.deleted_at IS NULL
       WHERE a.produto = 'clinic' AND a.usuario_id = u.usuario_id
         AND a.tenant_id = u.tenant_id AND u.deleted_at IS NULL
         AND NOT a.clinico
    $q$;
  END IF;
END $$;
