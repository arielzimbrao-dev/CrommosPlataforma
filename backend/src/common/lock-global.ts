import { DataSource } from 'typeorm';

/**
 * Roda `fn` só se esta réplica obtiver o advisory lock `nome` no Postgres; se
 * outra réplica já estiver com ele, não faz nada (devolve `undefined`). Evita
 * que um job agendado (@Cron) rode N vezes com N réplicas da API.
 *
 * O lock é de sessão, então usa uma conexão dedicada (QueryRunner) do início
 * ao fim e sempre libera.
 */
export async function comLockGlobal<R>(
  ds: DataSource,
  nome: string,
  fn: () => Promise<R>,
): Promise<R | undefined> {
  const qr = ds.createQueryRunner();
  await qr.connect();
  try {
    const [{ ok }] = (await qr.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS ok',
      [nome],
    )) as { ok: boolean }[];
    if (!ok) return undefined;
    try {
      return await fn();
    } finally {
      await qr.query('SELECT pg_advisory_unlock(hashtext($1))', [nome]);
    }
  } finally {
    await qr.release();
  }
}
