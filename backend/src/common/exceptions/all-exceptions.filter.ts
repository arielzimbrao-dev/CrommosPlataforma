import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common';
import { Request, Response } from 'express';
import type { DataSource } from 'typeorm';
import {
  caminhoParaLog,
  erroParaLog,
  registrarErro,
  STATUS_SEM_REGISTRO,
} from './erros-log';
import { traduzirValidacao } from './mensagens-validacao';

/**
 * Mensagens de 409 por constraint. Constraint fora da lista cai na
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
 * O Nest converte o SyntaxError do
 * body-parser (JSON malformado) e o URIError do Express (`%ZZ` num parâmetro)
 * em `BadRequestException(err.message)` antes do filtro, e o texto padrão
 * (inglês) do Nest, do throttler e do roteador sai sem mensagem própria.
 */
const TEXTO_PADRAO_NEST =
  /^(ThrottlerException: )?Too Many Requests$|^Forbidden( resource)?$|^Unauthorized$|^Not Found$|^Cannot [A-Z]+ \S+$|^Conflict$|^Bad Request$|^Internal Server Error$|^Method Not Allowed$/i;
const PADRAO_POR_STATUS: Record<number, string> = {
  400: 'Dados inválidos. Revise os campos.',
  401: 'Sessão expirada. Entre novamente.',
  403: 'Você não tem permissão para esta ação.',
  404: 'Registro não encontrado.',
  409: 'Conflito com outro registro.',
  429: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.',
  500: 'Erro interno do servidor',
};

function traduzirErroDoParser(message: unknown): unknown {
  if (typeof message !== 'string') return message;
  if (/^Failed to decode param /.test(message))
    return 'Endereço inválido. Confira o link.';
  if (/\bJSON\b/.test(message))
    return 'Não foi possível ler os dados enviados. Tente de novo.';
  return message;
}

function traduzirPadraoNest(status: number, message: unknown): unknown {
  if (typeof message !== 'string' || !TEXTO_PADRAO_NEST.test(message))
    return message;
  if (/^Cannot [A-Z]+ /.test(message)) return 'Endereço não encontrado.';
  return PADRAO_POR_STATUS[status] ?? 'Não foi possível concluir a operação.';
}

/**
 * Filtro global de exceções. Normaliza o corpo de erro retornado pela API.
 * - `HttpException`: preserva status e mensagem (erros de negócio esperados).
 * - Violação de UNIQUE/EXCLUDE do Postgres: 409 sem detalhe do banco.
 * - Qualquer outro erro (banco, bug, etc.): responde 500 com mensagem genérica
 *   e loga o erro completo apenas no servidor — nunca expõe stack trace ou
 *   detalhe interno no corpo da resposta.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  /** Sem banco (testes unitários), só responde. */
  constructor(
    @Optional()
    @Inject('DATA_SOURCE')
    private readonly ds?: Pick<DataSource, 'query'>,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: unknown = 'Erro interno do servidor';
    let code: unknown;
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
      // Mensagens padrão da validação (inglês) → pt-BR.
      if (status === 400)
        message = traduzirErroDoParser(traduzirValidacao(message));
      message = traduzirPadraoNest(status, message);
      // Código de erro de negócio (ex.: CONVITE_JA_ACEITO) para o front decidir.
      if (typeof corpo === 'object' && corpo !== null && 'code' in corpo) {
        code = (corpo as { code?: unknown }).code;
      }
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

    // Resposta de erro nunca vai para cache.
    response.setHeader('Cache-Control', 'no-store');
    response.status(status).send({
      statusCode: status,
      timestamp: new Date().toISOString(),
      // Sem a query string (um segredo em `?token=` não volta no corpo).
      path: request.url.split('?')[0],
      message,
      ...(code === undefined ? {} : { code }),
    });

    // Depois de responder: gravar não atrasa nem quebra a resposta.
    const cors =
      exception instanceof Error && exception.message === 'Not allowed by CORS';
    if (!this.ds || cors || STATUS_SEM_REGISTRO.includes(status)) return;
    const req = request as Request & {
      user?: { tenantId?: string; sub?: string };
    };
    const corpo: unknown = req.body;
    void registrarErro(this.ds, {
      metodo: req.method,
      caminho: caminhoParaLog(req.url),
      status,
      tenantId: req.user?.tenantId,
      usuarioId: req.user?.sub,
      resposta: { message, ...(code === undefined ? {} : { code }) },
      erro: exception instanceof HttpException ? null : erroParaLog(exception),
      requisicao:
        corpo && typeof corpo === 'object'
          ? { campos: Object.keys(corpo) }
          : null,
      ip: req.ip,
      navegador: req.headers?.['user-agent'],
    });
  }
}
