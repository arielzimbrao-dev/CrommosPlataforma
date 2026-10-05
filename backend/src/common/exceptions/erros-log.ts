import { Logger } from '@nestjs/common';
import { type DataSource, TypeORMError } from 'typeorm';

type Banco = Pick<DataSource, 'query'>;

/** Retenção de `crommos.erros_logs` (purga diária no SessoesCron). */
export const RETENCAO_ERROS_LOGS = '7 days';

/**
 * Erros esperados e de volume alto, que não são bug: sessão vencida, rota ou
 * registro inexistente (inclusive varredura) e rate limit.
 */
export const STATUS_SEM_REGISTRO = [401, 404, 429];

export interface ErroLog {
  metodo: string;
  caminho: string;
  status: number;
  tenantId?: string | null;
  usuarioId?: string | null;
  /** O que o cliente recebeu (mensagem já traduzida). */
  resposta?: unknown;
  /** Nome e pilha; erro do banco sem a mensagem (`erroParaLog`). */
  erro?: string | null;
  /** Só os NOMES dos campos do corpo (senha, e-mail e token ficam fora). */
  requisicao?: Record<string, unknown> | null;
  ip?: string | null;
  navegador?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Caminho sem query string e com segmentos longos (tokens de link, > 20
 * caracteres) trocados por `***`. UUID fica: é id, não segredo. (Igual ao Clinic.)
 */
export function caminhoParaLog(url: string): string {
  return url
    .split('?')[0]
    .split('/')
    .map((seg) => (/^[\w-]{21,}$/.test(seg) && !UUID.test(seg) ? '***' : seg))
    .join('/');
}

/**
 * Erro do banco sem mensagem, `detail` e parâmetros (podem trazer e-mail, CPF):
 * ficam SQLSTATE, tabela/constraint e as linhas "at …" da pilha. (Igual ao Clinic.)
 */
export function erroParaLog(exception: unknown): string {
  if (!(exception instanceof Error)) return String(exception);
  const { code, table, constraint } = exception as Error & {
    code?: unknown;
    table?: string;
    constraint?: string;
  };
  const doBanco = typeof code === 'string' || exception instanceof TypeORMError;
  if (!doBanco) return exception.stack ?? exception.message;
  const onde = [
    typeof code === 'string' && `[${code}]`,
    table && `tabela=${table}`,
    constraint && `constraint=${constraint}`,
  ]
    .filter(Boolean)
    .join(' ');
  const pilha = (exception.stack ?? '')
    .split('\n')
    .filter((l) => /^\s+at /.test(l))
    .join('\n');
  return `${exception.name}${onde ? ` ${onde}` : ''}\n${pilha}`;
}

const logger = new Logger('ErrosLog');
// ponytail: 20 mil caracteres bastam para pilha e mensagem; corta o que fugir disso.
const MAX = 20_000;
const cortar = (v?: string | null) =>
  v && v.length > MAX ? `${v.slice(0, MAX)}…[cortado]` : (v ?? null);

/** Uma linha por resposta de erro. Nunca lança: falha aqui não vira um 2º erro. */
export async function registrarErro(ds: Banco, e: ErroLog): Promise<void> {
  try {
    await ds.query(
      `INSERT INTO crommos.erros_logs
         (metodo, caminho, status, tenant_id, usuario_id, resposta, erro,
          requisicao, ip, navegador)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        e.metodo,
        cortar(e.caminho),
        e.status,
        e.tenantId ?? null,
        e.usuarioId ?? null,
        e.resposta === undefined ? null : JSON.stringify(e.resposta),
        cortar(e.erro),
        e.requisicao ? JSON.stringify(e.requisicao) : null,
        e.ip ?? null,
        cortar(e.navegador),
      ],
    );
  } catch (err) {
    logger.error(
      `Falha ao gravar em erros_logs: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Apaga o que passou da retenção; devolve quantas linhas saíram. */
export async function purgarErrosLogs(ds: Banco): Promise<number> {
  const r: unknown = await ds.query(
    `DELETE FROM crommos.erros_logs WHERE criado_em < NOW() - $1::interval`,
    [RETENCAO_ERROS_LOGS],
  );
  return Number((r as [unknown, number])[1] ?? 0);
}
