import { DataSource } from 'typeorm';
import { ThrottlerPostgres } from 'src/common/http/throttler-postgres';

describe('ThrottlerPostgres (unidade)', () => {
  it('recusa tabela sem schema ou com caracteres estranhos', () => {
    const db = { query: jest.fn() };
    expect(() => new ThrottlerPostgres(db, 'rate_limit')).toThrow();
    expect(() => new ThrottlerPostgres(db, 'a.b;drop')).toThrow();
  });

  it('mapeia a linha do banco e limpa a cada N chamadas', async () => {
    const db = {
      query: jest
        .fn()
        .mockResolvedValue([
          { hits: 2, expira_s: 30, bloqueado: false, bloqueio_s: null },
        ]),
    };
    const s = new ThrottlerPostgres(db, 'crommos.rate_limit');
    await expect(
      s.increment('k', 60_000, 5, 60_000, 'default'),
    ).resolves.toEqual({
      totalHits: 2,
      timeToExpire: 30,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    expect(db.query.mock.calls[0][1]).toEqual(['default:k', 60_000, 5, 60_000]);
    for (let i = 1; i < ThrottlerPostgres.LIMPAR_A_CADA; i++) {
      await s.increment('k', 1, 1, 1, 'd');
    }
    expect(
      db.query.mock.calls.some((c) => String(c[0]).startsWith('DELETE')),
    ).toBe(true);
  });
});

const describeDb =
  process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;

describeDb(
  'ThrottlerPostgres (Postgres real, compartilhado entre réplicas)',
  () => {
    let ds: DataSource;
    const TABELA = 'public.rate_limit_teste';

    beforeAll(async () => {
      ds = await new DataSource({
        type: 'postgres',
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT),
        username: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
      }).initialize();
      await ds.query(`DROP TABLE IF EXISTS ${TABELA}`);
      await ds.query(`CREATE TABLE ${TABELA} (
      chave VARCHAR(128) PRIMARY KEY, hits INT NOT NULL,
      janela_fim TIMESTAMPTZ NOT NULL, bloqueado_ate TIMESTAMPTZ)`);
    });

    afterAll(async () => {
      await ds.query(`DROP TABLE IF EXISTS ${TABELA}`);
      await ds.destroy();
    });

    it('duas "réplicas" somam no mesmo contador; passou do limite → bloqueado', async () => {
      const r1 = new ThrottlerPostgres(ds, TABELA);
      const r2 = new ThrottlerPostgres(ds, TABELA);
      const resultados = await Promise.all(
        [r1, r2, r1, r2].map((r) => r.increment('ip', 60_000, 3, 60_000, 'd')),
      );
      expect(resultados.map((x) => x.totalHits).sort()).toEqual([1, 2, 3, 4]);
      const bloqueados = resultados.filter((x) => x.isBlocked);
      expect(bloqueados).toHaveLength(1);
      expect(bloqueados[0].timeToBlockExpire).toBeGreaterThan(50);
      // Bloqueado continua bloqueado sem contar hits.
      const depois = await r1.increment('ip', 60_000, 3, 60_000, 'd');
      expect(depois).toMatchObject({ isBlocked: true, totalHits: 4 });
    });

    it('janela vencida recomeça a contagem; limpar apaga as antigas', async () => {
      const r = new ThrottlerPostgres(ds, TABELA);
      await r.increment('curta', 1, 10, 1, 'd');
      await new Promise((ok) => setTimeout(ok, 20));
      const x = await r.increment('curta', 60_000, 10, 1, 'd');
      expect(x).toMatchObject({ totalHits: 1, isBlocked: false });
      await ds.query(
        `UPDATE ${TABELA} SET janela_fim = now() - interval '2 hours', bloqueado_ate = NULL`,
      );
      await r.limpar();
      const [{ n }] = await ds.query(
        `SELECT count(*)::int AS n FROM ${TABELA}`,
      );
      expect(n).toBe(0);
    });
  },
);
