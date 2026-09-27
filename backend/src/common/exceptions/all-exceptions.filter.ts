import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { traduzirValidacao } from './mensagens-validacao';

/**
 * Mensagens de 409 por constraint (N-07). Constraint fora da lista cai na
 * genérica. Os services que já tratam o próprio 23505/23P01 continuam valendo
 * (mensagem de contexto); este é o padrão para todo o resto.
 */
const MENSAGENS_CONSTRAINT: Record<string, string> = {
  // Login único: o e-mail é da pessoa, em toda a plataforma.
  uq_usuarios_email:
    'Já existe uma conta com este e-mail. Entre com a sua conta (lá você pode criar outra clínica).',
  uq_clientes_documento: 'Já existe um cliente com este CPF/CNPJ.',
  uq_acessos_usuario_produto_tenant:
    'Esta pessoa já tem acesso a esta clínica.',
};

/** 23505 (unique) e 23P01 (exclusion) viram 409; `undefined` = não é o caso. */
export function mensagemConflito(exception: unknown): string | undefined {
  const { code, constraint } = (exception ?? {}) as {
    code?: string;
    constraint?: string;
  };
  if (code !== '23505' && code !== '23P01') return undefined;
  return (
    MENSAGENS_CONSTRAINT[constraint ?? ''] ??
    (code === '23505' ? 'Registro duplicado.' : 'Conflito com outro registro.')
  );
}

/**
 * Filtro global de exceções. Normaliza o corpo de erro retornado pela API.
 * - `HttpException`: preserva status e mensagem (erros de negócio esperados).
 * - Violação de UNIQUE/EXCLUDE do Postgres: 409 sem detalhe do banco (N-07).
 * - Qualquer outro erro (banco, bug, etc.): responde 500 com mensagem genérica
 *   e loga o erro completo apenas no servidor — nunca expõe stack trace ou
 *   detalhe interno no corpo da resposta.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: unknown = 'Erro interno do servidor';
    const conflito = mensagemConflito(exception);
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      // getResponse() de HttpException é `{ statusCode, message, error }`: o
      // corpo expõe só a mensagem (string ou lista da validação), que é o que
      // o frontend lê.
      const corpo = exception.getResponse();
      message =
        typeof corpo === 'object' && corpo !== null && 'message' in corpo
          ? corpo.message
          : corpo;
      // QA-007: mensagens padrão da validação (inglês) → pt-BR.
      if (status === 400) message = traduzirValidacao(message);
    } else if (conflito) {
      status = HttpStatus.CONFLICT;
      message = conflito;
    } else {
      // Stack completa fica no log do servidor, jamais no corpo da resposta.
      this.logger.error(
        `Erro não tratado em ${request.method} ${request.url.split('?')[0]}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).send({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      message,
    });
  }
}
