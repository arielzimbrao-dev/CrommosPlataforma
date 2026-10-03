import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  diretorioMigrations,
  lerMigrations,
} from 'src/database/database.providers';
import {
  aguardarSchemas,
  aplicarMigrations,
  ExecutorSql,
} from 'src/database/migrations-runner';

/**
 * Migrations da plataforma contra um Postgres real, no banco `plat_int`
 * (RUN_DB_TESTS=true), em três cenários:
 *  1. banco vazio → cria tudo; reexecutar não aplica nada;
 *  2. banco com o schema do Clinic (migrations 01–69 do Clinic, quando o
 *     repositório está ao lado — CLINIC_MIGRATIONS_DIR) → não quebra nada, as
 *     tabelas compartilhadas ficam iguais às do cenário 1 e o backfill cria os
 *     acessos e o nome/código dos tenants;
 *  3. o mesmo com um retrato do schema do Clinic (tests/fixtures), para o CI
 *     sem o repositório do Clinic.
 */
const describeDb =
  process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;

const BANCO = process.env.DB_NAME_INT ?? 'plat_int';
const DIR_CLINIC =
  process.env.CLINIC_MIGRATIONS_DIR ??
  path.resolve(__dirname, '../../../crommosclinic/backend/database/migrations');
const FIXTURE_CLINIC = path.resolve(__dirname, 'fixtures/clinic-pos-69.sql');
const CONTROLE_CLINIC = { tabela: 'public._sql_migrations', lock: 72_460_001 };
const TABELAS_COMUNS = ['clientes', 'usuarios', 'assinaturas', 'faturas'];
const silencio = () => undefined;

interface Conexao extends ExecutorSql {
  query<T = any>(sql: string, params?: unknown[]): Promise<T>;
  end(): Promise<void>;
}

/** Uma conexão só (o runner exige: lock e transação são de sessão). */
async function conectar(searchPath: string): Promise<Conexao> {
  const ds = await new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: BANCO,
    extra: { options: `-c search_path=${searchPath}`, max: 1 },
  }).initialize();
  const qr = ds.createQueryRunner();
  await qr.connect();
  return {
    // Sem parâmetros o `pg` usa o protocolo simples (vários statements).
    query: (sql, params) => (params ? qr.query(sql, params) : qr.query(sql)),
    end: async () => {
      await qr.release();
      await ds.destroy();
    },
  };
}

async function resetar(): Promise<void> {
  const c = await conectar('public');
  try {
    await c.query(`DROP SCHEMA IF EXISTS clinic CASCADE;
                   DROP SCHEMA IF EXISTS crommos CASCADE;
                   DROP SCHEMA public CASCADE;
                   CREATE SCHEMA public;`);
  } finally {
    await c.end();
  }
}

async function migrarPlataforma(): Promise<string[]> {
  const c = await conectar('crommos,public');
  try {
    return await aplicarMigrations(
      c,
      lerMigrations(diretorioMigrations()),
      undefined,
      silencio,
    );
  } finally {
    await c.end();
  }
}

/**
 * Colunas, constraints e índices das tabelas compartilhadas do `crommos`.
 * `comDefinicao = false` compara as constraints só por nome e tipo (o
 * pg_dump regrava o texto dos CHECK com outros casts, mesma semântica).
 */
async function estrutura(
  comDefinicao = true,
): Promise<Record<string, unknown>> {
  const c = await conectar('public');
  try {
    const colunas = await c.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default,
              character_maximum_length, numeric_precision, numeric_scale
         FROM information_schema.columns
        WHERE table_schema = 'crommos' AND table_name = ANY($1)
        ORDER BY table_name, column_name`,
      [TABELAS_COMUNS],
    );
    const constraints = await c.query(
      `SELECT conrelid::regclass::text AS tabela, conname, contype,
              CASE WHEN $2 THEN pg_get_constraintdef(oid) END AS def
         FROM pg_constraint
        WHERE connamespace = 'crommos'::regnamespace
          AND conrelid::regclass::text = ANY($1)
        ORDER BY 1, 2`,
      [TABELAS_COMUNS.map((t) => `crommos.${t}`), comDefinicao],
    );
    const indices = await c.query(
      `SELECT tablename, indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'crommos' AND tablename = ANY($1)
        ORDER BY 1, 2`,
      [TABELAS_COMUNS],
    );
    return {
      colunas,
      constraints,
      indices,
    };
  } finally {
    await c.end();
  }
}

const T1 = randomUUID(); // clínica com fantasia, código e assinatura
const T2 = randomUUID(); // sem fantasia (vale a razão social)
const T3 = randomUUID(); // clínica excluída
const C1 = randomUUID();
const U1 = randomUUID();
const U2 = randomUUID();

/** Dados do Clinic (depois da 69): pessoas, clínicas, vínculos, assinaturas. */
async function semearClinic(): Promise<void> {
  const c = await conectar('clinic,crommos,public');
  try {
    await c.query(
      `INSERT INTO crommos.clientes (id, tipo, documento, nome)
       VALUES ($1, 'pj', '11222333000181', 'Cliente Um')`,
      [C1],
    );
    await c.query(
      `INSERT INTO clinic.clinicas (id, razao_social, nome_fantasia, codigo, cliente_id, deleted_at)
       VALUES ($1, 'Razão Um', 'Fantasia Um', 'ABCDE', $4, NULL),
              ($2, 'Razão Dois', NULL, 'FGHJK', NULL, NULL),
              ($3, 'Razão Três', 'Excluída', 'MNPQR', NULL, NOW())`,
      [T1, T2, T3, C1],
    );
    await c.query(
      `INSERT INTO crommos.usuarios (id, email, nome, password_hash)
       VALUES ($1, 'um@exemplo.com', 'Um', 'x'), ($2, 'dois@exemplo.com', 'Dois', 'x')`,
      [U1, U2],
    );
    await c.query(
      `INSERT INTO clinic.users (tenant_id, usuario_id, name, email, role, active, convite_pendente, deleted_at)
       VALUES ($1, $4, 'Um', 'um@exemplo.com', 'admin', TRUE, FALSE, NULL),
              ($1, $5, 'Dois', 'dois@exemplo.com', 'financeiro', FALSE, FALSE, NULL),
              ($2, $5, 'Dois', 'dois@exemplo.com', 'recepcao', TRUE, TRUE, NULL),
              ($2, $4, 'Um antigo', 'um@exemplo.com', 'gestor', TRUE, FALSE, NOW()),
              ($3, $4, 'Um', 'um@exemplo.com', 'admin', TRUE, FALSE, NULL)`,
      [T1, T2, T3, U1, U2],
    );
    await c.query(
      `INSERT INTO crommos.assinaturas (tenant_id, cliente_id, produto, ciclo_inicio, ciclo_fim)
       VALUES ($1, $3, 'clinic', '2026-09-01', '2026-10-01'),
              ($2, NULL, 'clinic', '2026-09-01', '2026-10-01')`,
      [T1, T2, C1],
    );
  } finally {
    await c.end();
  }
}

async function conferirBackfill(): Promise<void> {
  const c = await conectar('public');
  try {
    const acessos = await c.query(
      `SELECT usuario_id, produto, tenant_id, papel, ativo, convite_pendente
         FROM crommos.acessos ORDER BY papel`,
    );
    expect(acessos).toEqual([
      {
        usuario_id: U1,
        produto: 'clinic',
        tenant_id: T1,
        papel: 'admin',
        ativo: true,
        convite_pendente: false,
      },
      {
        usuario_id: U2,
        produto: 'clinic',
        tenant_id: T1,
        papel: 'financeiro',
        ativo: false,
        convite_pendente: false,
      },
      {
        usuario_id: U2,
        produto: 'clinic',
        tenant_id: T2,
        papel: 'recepcao',
        ativo: true,
        convite_pendente: true,
      },
    ]);
    const tenants = await c.query(
      `SELECT tenant_id, tenant_nome, tenant_codigo FROM crommos.assinaturas
        ORDER BY tenant_codigo`,
    );
    expect(tenants).toEqual([
      { tenant_id: T1, tenant_nome: 'Fantasia Um', tenant_codigo: 'ABCDE' },
      { tenant_id: T2, tenant_nome: 'Razão Dois', tenant_codigo: 'FGHJK' },
    ]);
    // O Clinic segue com o controle dele intocado.
    const [{ n }] = await c.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM public._sql_migrations`,
    );
    expect(n).toBeGreaterThan(0);
  } finally {
    await c.end();
  }
}

describeDb('Migrations da plataforma (plat_int)', () => {
  jest.setTimeout(120_000);
  let estruturaVazio: Record<string, unknown>;
  let estruturaVazioSemDef: Record<string, unknown>;

  it('banco vazio: cria o schema crommos e é idempotente', async () => {
    await resetar();
    const primeira = await migrarPlataforma();
    expect(primeira).toEqual([
      '01-schema-crommos.sql',
      '02-acessos-sessoes.sql',
      '03-auditoria.sql',
      '04-backfill-clinic.sql',
      '05-trial-inadimplencia-cobranca.sql',
      '06-rate-limit.sql',
      '07-trial-cinco-usuarios.sql',
      '08-sessoes-familia.sql',
      '09-acessos-convite-aceite.sql',
      '10-assentos-por-modulo.sql',
      '11-teleconsultas.sql',
      '12-registros-acesso.sql',
      '13-dois-fatores.sql',
      '14-exclusao-propagada.sql',
      '15-niveis-e-consumos.sql',
    ]);
    expect(await migrarPlataforma()).toEqual([]);
    estruturaVazio = await estrutura();
    estruturaVazioSemDef = await estrutura(false);

    const c = await conectar('public');
    try {
      const rows = await c.query<{ table_name: string }[]>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'crommos' ORDER BY 1`,
      );
      expect(rows.map((r) => r.table_name)).toEqual([
        '_migrations',
        'acessos',
        'assinaturas',
        'auditoria',
        'clientes',
        'consumos',
        'faturas',
        'rate_limit',
        'sessoes',
        'teleconsultas',
        'usuarios',
      ]);
      // Nada fora do crommos.
      const [fora] = await c.query<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM information_schema.tables
          WHERE table_schema = 'public'`,
      );
      expect(fora.n).toBe(0);
    } finally {
      await c.end();
    }
  });

  it('07: trials em andamento e não confirmados sobem para 5 usuários', async () => {
    const c = await conectar('crommos,public');
    try {
      await c.query(
        `INSERT INTO crommos.assinaturas (tenant_id, produto, ciclo_inicio, ciclo_fim, em_trial_ate, numero_usuarios, trial_confirmado_em)
         VALUES (gen_random_uuid(), 'clinic', CURRENT_DATE, CURRENT_DATE + 14, CURRENT_DATE + 14, 1, NULL),
                (gen_random_uuid(), 'clinic', CURRENT_DATE, CURRENT_DATE + 14, CURRENT_DATE + 14, 1, now()),
                (gen_random_uuid(), 'clinic', CURRENT_DATE - 14, CURRENT_DATE, CURRENT_DATE, 1, NULL)`,
      );
      await c.query(
        fs.readFileSync(
          path.join(diretorioMigrations(), '07-trial-cinco-usuarios.sql'),
          'utf8',
        ),
      );
      const rows = await c.query<{ n: number }[]>(
        `SELECT numero_usuarios AS n FROM crommos.assinaturas ORDER BY trial_confirmado_em NULLS FIRST, em_trial_ate DESC`,
      );
      // Só o trial ativo e não confirmado muda; confirmado e vencido ficam.
      expect(rows.map((r) => r.n)).toEqual([5, 1, 1]);
    } finally {
      await c.end();
    }
  });

  const comClinic = fs.existsSync(DIR_CLINIC) ? it : it.skip;
  comClinic(
    'banco com as migrations do Clinic: compatível e com backfill',
    async () => {
      await resetar();
      const c = await conectar('clinic,crommos,public');
      try {
        await aplicarMigrations(
          c,
          lerMigrations(DIR_CLINIC),
          CONTROLE_CLINIC,
          silencio,
        );
      } finally {
        await c.end();
      }
      await semearClinic();
      await migrarPlataforma();
      await conferirBackfill();
      expect(await estrutura()).toEqual(estruturaVazio);
    },
  );

  comClinic(
    'banco vazio com a plataforma subindo ANTES do Clinic — ela espera o schema do produto',
    async () => {
      await resetar();
      const plat = await conectar('crommos,public');
      const plataforma = aguardarSchemas(plat, ['clinic'], {
        intervaloMs: 100,
        tentativas: 600,
        log: silencio,
      }).then(() =>
        aplicarMigrations(
          plat,
          lerMigrations(diretorioMigrations()),
          undefined,
          silencio,
        ),
      );
      try {
        await new Promise((r) => setTimeout(r, 500));
        const c = await conectar('clinic,crommos,public');
        try {
          const [{ n }] = await c.query<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'crommos'`,
          );
          expect(n).toBe(0); // a plataforma ainda não criou nada
          await aplicarMigrations(
            c,
            lerMigrations(DIR_CLINIC),
            CONTROLE_CLINIC,
            silencio,
          );
        } finally {
          await c.end();
        }
        await plataforma;
      } finally {
        await plat.end();
      }
      const c = await conectar('public');
      try {
        const [{ n }] = await c.query<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name <> '_sql_migrations'`,
        );
        expect(n).toBe(0);
        const [{ users }] = await c.query<{ users: string | null }[]>(
          `SELECT to_regclass('clinic.users')::text AS users`,
        );
        expect(users).toBe('clinic.users');
      } finally {
        await c.end();
      }
    },
    // Migrations reais do Clinic (~90 arquivos): folga para CI carregado.
    300_000,
  );

  it('retrato do schema do Clinic (fixture): compatível e com backfill', async () => {
    await resetar();
    const c = await conectar('public');
    try {
      await c.query(fs.readFileSync(FIXTURE_CLINIC, 'utf8'));
    } finally {
      await c.end();
    }
    await semearClinic();
    await migrarPlataforma();
    await conferirBackfill();
    expect(await estrutura(false)).toEqual(estruturaVazioSemDef);
  });
});
