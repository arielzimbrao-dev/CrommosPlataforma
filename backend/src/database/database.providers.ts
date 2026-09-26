import * as fs from 'fs';
import * as path from 'path';
import { DataSource, EntityTarget, ObjectLiteral } from 'typeorm';
import { Acesso } from '../auth/acesso.entity';
import { Sessao } from '../auth/sessao.entity';
import { Usuario } from '../auth/usuario.entity';
import { Auditoria } from '../audit/auditoria.entity';
import { Assinatura } from '../billing/assinatura.entity';
import { Cliente } from '../billing/cliente.entity';
import { Fatura } from '../billing/fatura.entity';
import { loadEnv } from '../config/load-env';
import {
  aguardarSchemas,
  aplicarMigrations,
  schemasAguardados,
} from './migrations-runner';
import { OPCAO_SEARCH_PATH } from './schemas';

loadEnv();

export const ENTIDADES = [
  Usuario,
  Acesso,
  Sessao,
  Cliente,
  Assinatura,
  Fatura,
  Auditoria,
];

/** Diretório `database/migrations` (em dev a partir de src/, em prod de dist/). */
export function diretorioMigrations(): string {
  const candidatos = [
    path.resolve(process.cwd(), 'database', 'migrations'),
    path.resolve(__dirname, '../../database/migrations'),
    path.resolve(__dirname, '../../../database/migrations'),
  ];
  const dir = candidatos.find((d) => fs.existsSync(d));
  if (!dir) {
    throw new Error(
      `[migration] Diretório não encontrado. Verificados: ${candidatos.join(', ')}`,
    );
  }
  return dir;
}

/** Lê os `.sql` de um diretório (nome + conteúdo). */
export function lerMigrations(dir: string): { nome: string; sql: string }[] {
  return fs
    .readdirSync(dir)
    .filter((nome) => nome.endsWith('.sql'))
    .map((nome) => ({
      nome,
      sql: fs.readFileSync(path.join(dir, nome), 'utf8'),
    }));
}

/** Aplica as migrations pendentes numa conexão dedicada. Lança se falhar. */
async function executarMigrations(ds: DataSource): Promise<void> {
  const qr = ds.createQueryRunner();
  await qr.connect();
  try {
    await aguardarSchemas(qr, schemasAguardados());
    const aplicadas = await aplicarMigrations(
      qr,
      lerMigrations(diretorioMigrations()),
    );
    console.log(`[migration] ${aplicadas.length} migration(s) aplicada(s).`);
  } finally {
    await qr.release();
  }
}

const ESPERA_RECONEXAO_MS = 10_000;

/** Conecta, com nova tentativa a cada 10 s (o Postgres pode subir depois da API). */
async function conectar(ds: DataSource): Promise<DataSource> {
  for (let tentativa = 1; ; tentativa++) {
    try {
      return await ds.initialize();
    } catch (error) {
      console.error(
        `[database] Erro ao conectar (tentativa ${tentativa}):`,
        error instanceof Error ? error.message : String(error),
      );
      await new Promise((r) => setTimeout(r, ESPERA_RECONEXAO_MS));
    }
  }
}

const repositorio = (token: string, entidade: EntityTarget<ObjectLiteral>) => ({
  provide: token,
  useFactory: (ds: DataSource) => ds.getRepository(entidade),
  inject: ['DATA_SOURCE'],
});

/**
 * Providers de banco (padrão DATA_SOURCE, como no Clinic): um `DataSource`
 * inicializado no boot, as migrations SQL bloqueantes (falha derruba o boot) e
 * um provider de repositório por entidade. Sem `synchronize`: o schema vem só
 * das migrations.
 */
export const databaseProviders = [
  {
    provide: 'DATA_SOURCE',
    useFactory: async () => {
      const ds = await conectar(
        new DataSource({
          type: 'postgres',
          host: process.env.DB_HOST,
          port: parseInt(process.env.DB_PORT || '5432', 10),
          username: process.env.DB_USERNAME,
          password: process.env.DB_PASSWORD,
          database: process.env.DB_NAME,
          entities: ENTIDADES,
          synchronize: false,
          logging: process.env.DB_LOGGING === 'true',
          extra: {
            options: OPCAO_SEARCH_PATH,
            max: 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
          },
          maxQueryExecutionTime: 1000,
        }),
      );
      if (process.env.DB_RUN_SQL_MIGRATIONS !== 'false') {
        await executarMigrations(ds);
      }
      return ds;
    },
  },
  repositorio('USUARIO_REPOSITORY', Usuario),
  repositorio('ACESSO_REPOSITORY', Acesso),
  repositorio('SESSAO_REPOSITORY', Sessao),
  repositorio('CLIENTE_REPOSITORY', Cliente),
  repositorio('ASSINATURA_REPOSITORY', Assinatura),
  repositorio('FATURA_REPOSITORY', Fatura),
  repositorio('AUDITORIA_REPOSITORY', Auditoria),
];
