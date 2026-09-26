import type { LoggerService } from '@nestjs/common';
import { requestIdAtual } from './request-id';

type Nivel = 'error' | 'warn' | 'log' | 'debug' | 'verbose';

/**
 * Logs estruturados: uma linha JSON por evento (`ts`, `nivel`, `contexto`,
 * `msg`, `requestId`, `stack`), no stdout (erros no stderr) — o Coolify
 * guarda e dá para filtrar por request-id. Nada de corpo de requisição:
 * quem loga já evita dado de paciente (só ids, rota e status).
 */
export class LoggerJson implements LoggerService {
  constructor(
    private readonly niveis: Nivel[] = ['error', 'warn', 'log'],
    private readonly escrever: (linha: string, erro: boolean) => void = (
      linha,
      erro,
    ) => (erro ? process.stderr : process.stdout).write(`${linha}\n`),
  ) {}

  log(msg: unknown, ...extra: unknown[]) {
    this.emitir('log', msg, extra);
  }
  error(msg: unknown, ...extra: unknown[]) {
    this.emitir('error', msg, extra);
  }
  warn(msg: unknown, ...extra: unknown[]) {
    this.emitir('warn', msg, extra);
  }
  debug(msg: unknown, ...extra: unknown[]) {
    this.emitir('debug', msg, extra);
  }
  verbose(msg: unknown, ...extra: unknown[]) {
    this.emitir('verbose', msg, extra);
  }

  private emitir(nivel: Nivel, msg: unknown, extra: unknown[]) {
    if (!this.niveis.includes(nivel)) return;
    // Convenção do Nest: o último extra (string) é o contexto; no error, o
    // anterior é a stack.
    const textos = extra.filter((e): e is string => typeof e === 'string');
    const contexto = textos.length ? textos[textos.length - 1] : undefined;
    const stack =
      nivel === 'error' && textos.length > 1 ? textos[0] : undefined;
    const linha: Record<string, unknown> = {
      ts: new Date().toISOString(),
      nivel,
      contexto,
      msg:
        msg instanceof Error
          ? msg.message
          : typeof msg === 'string'
            ? msg
            : JSON.stringify(msg),
      requestId: requestIdAtual(),
      stack: stack ?? (msg instanceof Error ? msg.stack : undefined),
    };
    this.escrever(JSON.stringify(linha), nivel === 'error');
  }
}

/**
 * Erros fora de uma requisição (promessa rejeitada sem `catch`, exceção
 * não capturada): loga com a stack e, na exceção, encerra (o orquestrador
 * reinicia o container) — continuar com o processo em estado incerto é pior.
 */
export function capturarErrosNaoTratados(
  logger: LoggerService,
  processo: Pick<NodeJS.Process, 'on' | 'exit'> = process,
): void {
  processo.on('unhandledRejection', (motivo: unknown) => {
    logger.error(
      `Promessa rejeitada sem tratamento: ${motivo instanceof Error ? motivo.message : String(motivo)}`,
      motivo instanceof Error ? motivo.stack : undefined,
      'Processo',
    );
  });
  processo.on('uncaughtException', (erro: Error) => {
    logger.error(
      `Exceção não capturada: ${erro.message}`,
      erro.stack,
      'Processo',
    );
    processo.exit(1);
  });
}
