import {
  aguardarSchemas,
  aplicarMigrations,
  schemasAguardados,
  CONTROLE_PLATAFORMA,
  ordenarMigrations,
  splitSqlStatements,
} from 'src/database/migrations-runner';

describe('splitSqlStatements', () => {
  it('separa por ; ignorando comentários e linhas vazias', () => {
    const sql = `
      -- cabeçalho
      CREATE TABLE a (id int); -- fim de linha
      /* bloco
         de comentário; com ponto e vírgula */
      CREATE INDEX i ON a (id);
    `;
    expect(splitSqlStatements(sql)).toEqual([
      'CREATE TABLE a (id int);',
      'CREATE INDEX i ON a (id);',
    ]);
  });

  it('não quebra dentro de string nem de bloco dollar-quoted (DO $$)', () => {
    const sql = `INSERT INTO t VALUES ('a;b', 'it''s; ok');
DO $$
BEGIN
  IF true THEN RAISE NOTICE 'x;y'; END IF;
END
$$;
DO $f$ BEGIN PERFORM 1; END $f$;
SELECT '$$;';`;
    const stmts = splitSqlStatements(sql);
    expect(stmts).toHaveLength(4);
    expect(stmts[0]).toBe(`INSERT INTO t VALUES ('a;b', 'it''s; ok');`);
    expect(stmts[1]).toMatch(/^DO \$\$[\s\S]*END\n\$\$;$/);
    expect(stmts[2]).toBe('DO $f$ BEGIN PERFORM 1; END $f$;');
    expect(stmts[3]).toBe(`SELECT '$$;';`);
  });

  it('mantém o último statement sem ; e ignora -- dentro de string', () => {
    expect(splitSqlStatements(`SELECT '--x'; SELECT 2`)).toEqual([
      `SELECT '--x';`,
      'SELECT 2',
    ]);
  });

  it('não trava com string, comentário ou dollar-quote sem fechamento', () => {
    expect(splitSqlStatements(`SELECT 'aberta; x`)).toEqual([
      `SELECT 'aberta; x`,
    ]);
    expect(splitSqlStatements('SELECT 1; /* sem fim')).toEqual(['SELECT 1;']);
    expect(splitSqlStatements('SELECT 1; -- fim')).toEqual(['SELECT 1;']);
    expect(splitSqlStatements('DO $$ BEGIN')).toEqual(['DO $$ BEGIN']);
  });
});

describe('ordenarMigrations', () => {
  it('filtra NN-*.sql e ordena numericamente', () => {
    expect(
      ordenarMigrations(['10-b.sql', 'README.md', '02-a.sql', '100-z.sql']),
    ).toEqual(['02-a.sql', '10-b.sql', '100-z.sql']);
    expect(ordenarMigrations(['05-b.sql', '05-a.sql'])).toEqual([
      '05-a.sql',
      '05-b.sql',
    ]);
  });
});

/** Executor falso: registra SQL e simula erros por trecho de statement. */
function fakeDb(
  aplicadas: string[] = [],
  erros: Record<string, string> = {},
  schemas: string[] = [],
) {
  const log: string[] = [];
  const query = jest.fn((sql: string, params?: unknown[]) => {
    log.push(params ? `${sql} ${JSON.stringify(params)}` : sql);
    if (sql.includes('pg_namespace')) {
      const nome = (params ?? [])[0] as string;
      return Promise.resolve(schemas.includes(nome) ? [{ existe: 1 }] : []);
    }
    if (sql.startsWith('SELECT filename')) {
      return Promise.resolve(aplicadas.map((filename) => ({ filename })));
    }
    for (const [trecho, code] of Object.entries(erros)) {
      if (sql.includes(trecho)) {
        return Promise.reject(
          Object.assign(new Error(`erro ${code}`), { code }),
        );
      }
    }
    return Promise.resolve([]);
  });
  return { db: { query }, log };
}

const silencio = () => undefined;

describe('aplicarMigrations', () => {
  it('aplica só as pendentes, cada uma numa transação, sob advisory lock', async () => {
    const { db, log } = fakeDb(['01-a.sql']);
    const aplicadas = await aplicarMigrations(
      db,
      [
        { nome: '02-b.sql', sql: 'CREATE TABLE b (x int);' },
        { nome: '01-a.sql', sql: 'CREATE TABLE a (x int);' },
      ],
      CONTROLE_PLATAFORMA,
      silencio,
    );

    expect(aplicadas).toEqual(['02-b.sql']);
    expect(log[0]).toMatch(/^SELECT pg_advisory_lock/);
    expect(log.at(-1)).toMatch(/^SELECT pg_advisory_unlock/);
    const b = log.indexOf('BEGIN');
    expect(log.slice(b)).toEqual([
      'BEGIN',
      'SAVEPOINT stmt',
      'CREATE TABLE b (x int);',
      'RELEASE SAVEPOINT stmt',
      'INSERT INTO crommos._migrations (filename) VALUES ($1) ["02-b.sql"]',
      'COMMIT',
      expect.stringMatching(/^SELECT pg_advisory_unlock/),
    ]);
    expect(log.some((l) => l.includes('CREATE TABLE a'))).toBe(false);
  });

  it('tolera "já existe" (idempotência) voltando ao savepoint', async () => {
    const { db, log } = fakeDb([], { 'CREATE TYPE': '42710' });
    await aplicarMigrations(
      db,
      [{ nome: '01-a.sql', sql: "CREATE TYPE e AS ENUM ('x'); SELECT 1;" }],
      CONTROLE_PLATAFORMA,
      silencio,
    );
    expect(log).toContain('ROLLBACK TO SAVEPOINT stmt');
    expect(log).toContain('SELECT 1;');
    expect(log).toContain('COMMIT');
  });

  it('falha de verdade: ROLLBACK, não registra, libera o lock e derruba o boot', async () => {
    const { db, log } = fakeDb([], { 'ALTER TABLE': '42P01' });
    await expect(
      aplicarMigrations(
        db,
        [
          { nome: '01-a.sql', sql: 'ALTER TABLE x ADD y int;' },
          { nome: '02-b.sql', sql: 'SELECT 2;' },
        ],
        CONTROLE_PLATAFORMA,
        silencio,
      ),
    ).rejects.toThrow(/01-a\.sql/);
    expect(log).toContain('ROLLBACK');
    expect(
      log.some((l) => l.startsWith('INSERT INTO crommos._migrations')),
    ).toBe(false);
    expect(log.some((l) => l.includes('SELECT 2'))).toBe(false);
    expect(log.at(-1)).toMatch(/^SELECT pg_advisory_unlock/);
  });

  it('erro sem SQLSTATE (ex.: conexão) também derruba, com a mensagem', async () => {
    const query = jest.fn((sql: string) =>
      sql === 'SELECT 1;'
        ? Promise.reject(new Error('conexão perdida'))
        : Promise.resolve([]),
    );
    await expect(
      aplicarMigrations(
        { query },
        [{ nome: '01-a.sql', sql: 'SELECT 1;' }],
        CONTROLE_PLATAFORMA,
        silencio,
      ),
    ).rejects.toThrow('[migration] 01-a.sql falhou: conexão perdida');

    const query2 = jest.fn((sql: string) =>
      sql === 'SELECT 1;'
        ? Promise.reject('texto') // eslint-disable-line @typescript-eslint/prefer-promise-reject-errors
        : Promise.resolve([]),
    );
    await expect(
      aplicarMigrations(
        { query: query2 },
        [{ nome: '01-a.sql', sql: 'SELECT 1;' }],
        CONTROLE_PLATAFORMA,
        silencio,
      ),
    ).rejects.toThrow('falhou: texto');
  });

  it('usa console.log por padrão', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation();
    const { db } = fakeDb();
    await aplicarMigrations(db, [{ nome: '01-a.sql', sql: 'SELECT 1;' }]);
    expect(log).toHaveBeenCalledWith('[migration] Aplicando: 01-a.sql');
    log.mockRestore();
  });

  it('arquivo vazio é só registrado', async () => {
    const { db, log } = fakeDb();
    await aplicarMigrations(
      db,
      [{ nome: '01-a.sql', sql: '  ' }],
      CONTROLE_PLATAFORMA,
      silencio,
    );
    expect(log).toContain(
      'INSERT INTO crommos._migrations (filename) VALUES ($1) ["01-a.sql"]',
    );
    expect(log).not.toContain('SAVEPOINT stmt');
  });
});

describe('controle das migrations', () => {
  it('plataforma: cria o schema crommos antes da tabela qualificada; lock próprio', async () => {
    const { db, log } = fakeDb();
    await aplicarMigrations(db, [], CONTROLE_PLATAFORMA, silencio);
    expect(log[0]).toBe('SELECT pg_advisory_lock($1) [72460101]');
    expect(log[1]).toBe(
      'SELECT 1 FROM pg_namespace WHERE nspname = $1 ["crommos"]',
    );
    expect(log[2]).toBe('CREATE SCHEMA IF NOT EXISTS crommos');
    expect(log[3]).toMatch(/^CREATE TABLE IF NOT EXISTS crommos\._migrations/);
    expect(log[4]).toBe('SELECT filename FROM crommos._migrations');
  });

  it('schema já existente: sem CREATE SCHEMA (o usuário da API não tem CREATE no banco)', async () => {
    const { db, log } = fakeDb([], {}, ['crommos']);
    await aplicarMigrations(db, [], CONTROLE_PLATAFORMA, silencio);
    expect(log.some((l) => l.startsWith('CREATE SCHEMA'))).toBe(false);
    expect(log).toContain('SELECT filename FROM crommos._migrations');
  });

  it('outro controle (ex.: o do Clinic, nos testes de compatibilidade) sem schema', async () => {
    const { db, log } = fakeDb();
    await aplicarMigrations(
      db,
      [{ nome: '01-a.sql', sql: 'SELECT 1;' }],
      { tabela: 'public._sql_migrations', lock: 72_460_001 },
      silencio,
    );
    expect(log.some((l) => l.startsWith('CREATE SCHEMA'))).toBe(false);
    expect(log).toContain(
      'INSERT INTO public._sql_migrations (filename) VALUES ($1) ["01-a.sql"]',
    );
  });
});

describe('aguardar os schemas dos produtos (banco vazio)', () => {
  const chaves = {
    CLINIC_API_URL: 'http://clinic',
    SERVICO_KEY_CLINIC: 'x'.repeat(32),
  };

  it('schemasAguardados: DB_AGUARDAR_SCHEMAS manda; senão, em produção, os produtos configurados', () => {
    expect(schemasAguardados({ DB_AGUARDAR_SCHEMAS: 'clinic, vet' })).toEqual([
      'clinic',
      'vet',
    ]);
    expect(
      schemasAguardados({ ...chaves, DB_AGUARDAR_SCHEMAS: 'nenhum' }),
    ).toEqual([]);
    expect(schemasAguardados({ ...chaves, NODE_ENV: 'production' })).toEqual([
      'clinic',
    ]);
    expect(schemasAguardados({ ...chaves, NODE_ENV: 'test' })).toEqual([]);
  });

  it('recusa nome de schema inválido', () => {
    expect(() => schemasAguardados({ DB_AGUARDAR_SCHEMAS: 'x;drop' })).toThrow(
      /DB_AGUARDAR_SCHEMAS/,
    );
  });

  it('espera até o schema existir', async () => {
    const respostas = [[], [], [{ nspname: 'clinic' }]];
    const db = { query: jest.fn(() => Promise.resolve(respostas.shift())) };
    const esperar = jest.fn(() => Promise.resolve());
    const log = jest.fn();
    await aguardarSchemas(db, ['clinic'], { esperar, log });
    expect(db.query).toHaveBeenCalledTimes(3);
    expect(esperar).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/clinic/));
  });

  it('sem schemas não consulta; esgotadas as tentativas, lança', async () => {
    const db = { query: jest.fn(() => Promise.resolve([])) };
    await aguardarSchemas(db, []);
    expect(db.query).not.toHaveBeenCalled();
    await expect(
      aguardarSchemas(db, ['clinic'], {
        tentativas: 2,
        esperar: () => Promise.resolve(),
        log: () => undefined,
      }),
    ).rejects.toThrow(/clinic/);
  });
});
