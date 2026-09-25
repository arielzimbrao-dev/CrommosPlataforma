/**
 * Runner das migrations SQL (`database/migrations/NN-*.sql`) — lógica pura,
 * testável sem banco (o `database.providers.ts` só lê os arquivos e chama
 * `aplicarMigrations` numa conexão dedicada). Portado do Clinic.
 *
 * Garantias:
 * - **uma instância por vez**: `pg_advisory_lock` durante toda a execução
 *   (chave própria, distinta da do Clinic: as duas APIs podem subir juntas);
 * - **cada arquivo numa transação**: ou aplica inteiro ou nada;
 * - **idempotência**: erros de "já existe" (SQLSTATE abaixo) são tolerados por
 *   statement (SAVEPOINT), para statements sem `IF NOT EXISTS`;
 * - **falha derruba o boot**: qualquer outro erro faz ROLLBACK e lança.
 *
 * Restrição: nada que não rode em transação (ex.: `CREATE INDEX CONCURRENTLY`).
 */

/** Conexão mínima usada pelo runner (QueryRunner do TypeORM). */
export interface ExecutorSql {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export interface ArquivoMigration {
  nome: string;
  sql: string;
}

/** Onde o runner guarda o que já aplicou e qual advisory lock usa. */
export interface ControleMigrations {
  /** Tabela de controle, sempre qualificada pelo schema. */
  tabela: string;
  /** Schema criado antes da tabela de controle (se precisar). */
  schema?: string;
  lock: number;
}

/**
 * Controle da plataforma: `crommos._migrations` (qualificada — o Clinic usa
 * `public._sql_migrations`, e os dois conjuntos de arquivos são independentes).
 */
export const CONTROLE_PLATAFORMA: ControleMigrations = {
  tabela: 'crommos._migrations',
  schema: 'crommos',
  lock: 72_460_101,
};

/** SQLSTATEs de "objeto já existe" tolerados (reexecução idempotente). */
const SQLSTATES_IDEMPOTENTES = new Set([
  '42P07', // duplicate_table
  '42710', // duplicate_object (type, constraint, index)
  '42701', // duplicate_column
  '42P06', // duplicate_schema
  '42723', // duplicate_function
]);

/**
 * Quebra um arquivo SQL em statements (terminados em `;`), ignorando
 * comentários (`--` e `/* *\/`) e respeitando strings (`'...'`, `"..."`) e
 * blocos dollar-quoted (`$$ ... $$`, `$tag$ ... $tag$`) — logo `DO $$ ... $$;`
 * é um statement só.
 */
export function splitSqlStatements(sql: string): string[] {
  const stmts: string[] = [];
  let atual = '';
  let i = 0;
  const fechar = () => {
    const s = atual.trim();
    if (s) stmts.push(s);
    atual = '';
  };

  while (i < sql.length) {
    const c = sql[i];
    const resto = sql.slice(i);

    if (resto.startsWith('--')) {
      const fim = sql.indexOf('\n', i);
      i = fim === -1 ? sql.length : fim;
      continue;
    }
    if (resto.startsWith('/*')) {
      const fim = sql.indexOf('*/', i + 2);
      i = fim === -1 ? sql.length : fim + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      // '' dentro da string é aspa escapada: o laço sai e reentra no mesmo tipo.
      const fim = sql.indexOf(c, i + 1);
      const ate = fim === -1 ? sql.length : fim + 1;
      atual += sql.slice(i, ate);
      i = ate;
      continue;
    }
    const tag = /^\$[A-Za-z_]*\$/.exec(resto)?.[0];
    if (tag) {
      const fim = sql.indexOf(tag, i + tag.length);
      const ate = fim === -1 ? sql.length : fim + tag.length;
      atual += sql.slice(i, ate);
      i = ate;
      continue;
    }
    atual += c;
    i++;
    if (c === ';') fechar();
  }
  fechar();
  return stmts;
}

/** Só `NN-*.sql`, em ordem numérica (desempate alfabético). */
export function ordenarMigrations(nomes: string[]): string[] {
  const num = (n: string) => Number(/^(\d+)/.exec(n)?.[1] ?? 0);
  return nomes
    .filter((n) => /^\d{2}.*\.sql$/i.test(n))
    .sort((a, b) => num(a) - num(b) || a.localeCompare(b));
}

const mensagem = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/**
 * Aplica as migrations pendentes. Devolve os nomes aplicados nesta execução.
 * `db` deve ser **uma única conexão** (advisory lock e transação são de sessão).
 */
export async function aplicarMigrations(
  db: ExecutorSql,
  arquivos: ArquivoMigration[],
  controle: ControleMigrations = CONTROLE_PLATAFORMA,
  log: (msg: string) => void = console.log,
): Promise<string[]> {
  const { tabela, schema, lock } = controle;
  await db.query('SELECT pg_advisory_lock($1)', [lock]);
  try {
    if (schema) await db.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await db.query(`CREATE TABLE IF NOT EXISTS ${tabela} (
      filename   VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`);
    const linhas = (await db.query(`SELECT filename FROM ${tabela}`)) as {
      filename: string;
    }[];
    const jaAplicadas = new Set(linhas.map((l) => l.filename));
    const porNome = new Map(arquivos.map((a) => [a.nome, a.sql]));
    const aplicadas: string[] = [];

    for (const nome of ordenarMigrations([...porNome.keys()])) {
      if (jaAplicadas.has(nome)) continue;
      log(`[migration] Aplicando: ${nome}`);
      await db.query('BEGIN');
      try {
        for (const stmt of splitSqlStatements(porNome.get(nome) ?? '')) {
          await db.query('SAVEPOINT stmt');
          try {
            await db.query(stmt);
            await db.query('RELEASE SAVEPOINT stmt');
          } catch (err) {
            const code = (err as { code?: string }).code;
            if (!code || !SQLSTATES_IDEMPOTENTES.has(code)) throw err;
            await db.query('ROLLBACK TO SAVEPOINT stmt');
            log(`[migration] Já existe, ignorado (${nome}): ${mensagem(err)}`);
          }
        }
        await db.query(`INSERT INTO ${tabela} (filename) VALUES ($1)`, [nome]);
        await db.query('COMMIT');
      } catch (err) {
        await db.query('ROLLBACK');
        throw new Error(`[migration] ${nome} falhou: ${mensagem(err)}`);
      }
      aplicadas.push(nome);
    }
    return aplicadas;
  } finally {
    await db.query('SELECT pg_advisory_unlock($1)', [lock]);
  }
}
