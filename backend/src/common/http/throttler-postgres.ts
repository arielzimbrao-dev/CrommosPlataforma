import type { ThrottlerStorage } from '@nestjs/throttler';

interface Consulta {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

interface Linha {
  hits: number;
  expira_s: number;
  bloqueado: boolean;
  bloqueio_s: number;
}

/**
 * Storage do rate limit no **Postgres**, compartilhada entre as réplicas (o
 * padrão do `@nestjs/throttler` é memória: com N réplicas, N vezes o limite).
 * Janela fixa por chave, numa instrução só (upsert atômico): conta o hit,
 * reabre a janela vencida e bloqueia por `blockDuration` quem passou do
 * limite. O relógio é o do banco (igual para todas as réplicas).
 *
 * ponytail: janela fixa (não deslizante) e limpeza a cada `LIMPAR_A_CADA`
 * chamadas por réplica; Redis só se o banco sentir o volume.
 */
export class ThrottlerPostgres implements ThrottlerStorage {
  private chamadas = 0;
  static readonly LIMPAR_A_CADA = 1000;

  constructor(
    private readonly db: Consulta,
    /** Tabela qualificada (`crommos.rate_limit`, `clinic.rate_limit`). */
    private readonly tabela: string,
  ) {
    if (!/^[a-z_]+\.[a-z_]+$/.test(tabela)) {
      throw new Error(`ThrottlerPostgres: tabela inválida ${tabela}`);
    }
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ) {
    if (++this.chamadas % ThrottlerPostgres.LIMPAR_A_CADA === 0) {
      void this.limpar().catch(() => undefined);
    }
    const t = this.tabela;
    const novosHits = `CASE WHEN r.janela_fim <= now() THEN 1 ELSE r.hits + 1 END`;
    const [l] = (await this.db.query(
      `INSERT INTO ${t} AS r (chave, hits, janela_fim, bloqueado_ate)
       VALUES ($1, 1, now() + $2 * interval '1 millisecond', NULL)
       ON CONFLICT (chave) DO UPDATE SET
         hits = CASE WHEN r.bloqueado_ate > now() THEN r.hits ELSE ${novosHits} END,
         janela_fim = CASE
           WHEN r.bloqueado_ate > now() OR r.janela_fim > now() THEN r.janela_fim
           ELSE now() + $2 * interval '1 millisecond' END,
         bloqueado_ate = CASE
           WHEN r.bloqueado_ate > now() THEN r.bloqueado_ate
           WHEN ${novosHits} > $3 THEN now() + $4 * interval '1 millisecond'
           ELSE NULL END
       RETURNING hits,
         GREATEST(0, ceil(extract(epoch FROM r.janela_fim - now())))::int AS expira_s,
         COALESCE(r.bloqueado_ate > now(), false) AS bloqueado,
         GREATEST(0, ceil(extract(epoch FROM r.bloqueado_ate - now())))::int AS bloqueio_s`,
      [`${throttlerName}:${key}`.slice(0, 128), ttl, limit, blockDuration],
    )) as Linha[];
    return {
      totalHits: l.hits,
      timeToExpire: l.expira_s,
      isBlocked: l.bloqueado,
      timeToBlockExpire: l.bloqueio_s ?? 0,
    };
  }

  /** Apaga janelas vencidas há mais de 1 h e sem bloqueio vigente. */
  async limpar(): Promise<void> {
    await this.db.query(
      `DELETE FROM ${this.tabela}
        WHERE janela_fim < now() - interval '1 hour'
          AND (bloqueado_ate IS NULL OR bloqueado_ate < now())`,
    );
  }
}
