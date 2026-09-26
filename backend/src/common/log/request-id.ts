import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Request-id de ponta a ponta: aceita o `X-Request-Id` de quem chamou (o
 * proxy, o front ou a outra API da Crommos) ou gera um; devolve no header da
 * resposta e fica disponível no contexto assíncrono da requisição para os
 * logs e para as chamadas entre Clinic e plataforma.
 */
export const HEADER_REQUEST_ID = 'X-Request-Id';

const ID_VALIDO = /^[A-Za-z0-9._:-]{8,128}$/;
const contexto = new AsyncLocalStorage<{ requestId: string }>();

/** Request-id da requisição corrente (`undefined` fora de uma requisição). */
export const requestIdAtual = (): string | undefined =>
  contexto.getStore()?.requestId;

/** Cabeçalho para repassar o request-id numa chamada HTTP de saída. */
export const cabecalhoRequestId = (): Record<string, string> => {
  const id = requestIdAtual();
  return id ? { [HEADER_REQUEST_ID]: id } : {};
};

interface Req {
  headers: Record<string, string | string[] | undefined>;
}
interface Res {
  setHeader(nome: string, valor: string): unknown;
}

/** Middleware (Express): lê/gera o id e roda o resto da requisição no contexto. */
export function requestIdMiddleware(req: Req, res: Res, next: () => void) {
  const recebido = req.headers['x-request-id'];
  const id =
    typeof recebido === 'string' && ID_VALIDO.test(recebido)
      ? recebido
      : randomUUID();
  res.setHeader(HEADER_REQUEST_ID, id);
  contexto.run({ requestId: id }, next);
}
