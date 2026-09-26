import {
  capturarErrosNaoTratados,
  LoggerJson,
} from 'src/common/log/logger-json';
import {
  cabecalhoRequestId,
  requestIdAtual,
  requestIdMiddleware,
} from 'src/common/log/request-id';

describe('request-id', () => {
  const rodar = (header?: string) => {
    const res = { setHeader: jest.fn() };
    let dentro: string | undefined;
    let cabecalho: Record<string, string> = {};
    requestIdMiddleware(
      { headers: header === undefined ? {} : { 'x-request-id': header } },
      res,
      () => {
        dentro = requestIdAtual();
        cabecalho = cabecalhoRequestId();
      },
    );
    return { res, dentro, cabecalho };
  };

  it('aceita o id recebido, devolve no header e expõe no contexto', () => {
    const { res, dentro, cabecalho } = rodar('abc-12345678');
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'abc-12345678');
    expect(dentro).toBe('abc-12345678');
    expect(cabecalho).toEqual({ 'X-Request-Id': 'abc-12345678' });
  });

  it('gera um id quando falta ou é inválido (tamanho/caracteres)', () => {
    for (const h of [
      undefined,
      'curto',
      'com espaço inválido',
      'x'.repeat(200),
    ]) {
      const { dentro } = rodar(h);
      expect(dentro).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('fora de requisição: sem id e sem cabeçalho', () => {
    expect(requestIdAtual()).toBeUndefined();
    expect(cabecalhoRequestId()).toEqual({});
  });
});

describe('LoggerJson', () => {
  const linhas = () => {
    const saida: { linha: Record<string, unknown>; erro: boolean }[] = [];
    const logger = new LoggerJson(['error', 'warn', 'log'], (l, erro) =>
      saida.push({ linha: JSON.parse(l) as Record<string, unknown>, erro }),
    );
    return { logger, saida };
  };

  it('uma linha JSON por evento com nível, contexto e request-id', () => {
    const { logger, saida } = linhas();
    requestIdMiddleware(
      { headers: { 'x-request-id': 'req-00000001' } },
      { setHeader: () => undefined },
      () => logger.log('subiu', 'Bootstrap'),
    );
    expect(saida[0]).toEqual({
      erro: false,
      linha: expect.objectContaining({
        nivel: 'log',
        contexto: 'Bootstrap',
        msg: 'subiu',
        requestId: 'req-00000001',
        ts: expect.any(String),
      }),
    });
  });

  it('error vai para o stderr com a stack; Error e objeto viram texto', () => {
    const { logger, saida } = linhas();
    logger.error('falhou', 'pilha', 'Filtro');
    logger.error(new Error('boom'));
    logger.warn({ a: 1 });
    expect(saida[0]).toMatchObject({
      erro: true,
      linha: { msg: 'falhou', stack: 'pilha', contexto: 'Filtro' },
    });
    expect(saida[1].linha.msg).toBe('boom');
    expect(saida[1].linha.stack).toEqual(expect.stringContaining('boom'));
    expect(saida[2].linha.msg).toBe('{"a":1}');
  });

  it('respeita os níveis ligados', () => {
    const { logger, saida } = linhas();
    logger.debug('x');
    logger.verbose('y');
    expect(saida).toHaveLength(0);
  });

  it('padrão: escreve no stdout/stderr', () => {
    const out = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    const l = new LoggerJson(['log', 'error', 'debug', 'verbose']);
    l.log('a');
    l.debug('b');
    l.verbose('c');
    l.error('d');
    expect(out).toHaveBeenCalledTimes(3);
    expect(err).toHaveBeenCalledTimes(1);
    out.mockRestore();
    err.mockRestore();
  });
});

describe('capturarErrosNaoTratados', () => {
  it('loga promessa rejeitada e exceção (esta encerra o processo)', () => {
    const handlers: Record<string, (x: unknown) => void> = {};
    const processo = {
      on: jest.fn((ev: string, fn: (x: unknown) => void) => {
        handlers[ev] = fn;
      }),
      exit: jest.fn(),
    };
    const logger = { error: jest.fn(), log: jest.fn(), warn: jest.fn() };
    capturarErrosNaoTratados(logger, processo as never);
    handlers.unhandledRejection(new Error('rej'));
    handlers.unhandledRejection('texto');
    handlers.uncaughtException(new Error('exc'));
    expect(logger.error).toHaveBeenCalledTimes(3);
    expect(logger.error.mock.calls[1][0]).toContain('texto');
    expect(processo.exit).toHaveBeenCalledWith(1);
  });
});
