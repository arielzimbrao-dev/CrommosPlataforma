-- 07 — Trial com 5 usuários (QA-009): a equipe testa junto durante a
-- avaliação, sem cobrança. Os trials em andamento e ainda não confirmados que
-- nasceram com 1 usuário sobem para 5. Idempotente.

UPDATE crommos.assinaturas
   SET numero_usuarios = 5
 WHERE em_trial_ate > CURRENT_DATE
   AND trial_confirmado_em IS NULL
   AND numero_usuarios < 5
   AND deleted_at IS NULL;
