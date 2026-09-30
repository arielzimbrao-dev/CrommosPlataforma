import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { AllExceptionsFilter } from 'src/common/exceptions/all-exceptions.filter';

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  beforeAll(() => {
    // Silencia o log de erro interno emitido no caso não-HTTP.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  function buildHost(
    url: string,
    method = 'GET',
  ): {
    host: ArgumentsHost;
    send: jest.Mock;
    status: jest.Mock;
    setHeader: jest.Mock;
  } {
    const send = jest.fn();
    const status = jest.fn().mockReturnValue({ send });
    const setHeader = jest.fn();
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status, setHeader }),
        getRequest: () => ({ url, method }),
      }),
    } as unknown as ArgumentsHost;
    return { host, send, status, setHeader };
  }

  it('serializes a thrown HttpException into the standard error body', () => {
    const { host, send, status } = buildHost('/patients');
    filter.catch(new HttpException('not_found', HttpStatus.NOT_FOUND), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(send).toHaveBeenCalledTimes(1);
    const body = send.mock.calls[0][0];
    expect(body).toMatchObject({
      statusCode: HttpStatus.NOT_FOUND,
      path: '/patients',
      message: 'not_found',
    });
    expect(typeof body.timestamp).toBe('string');
  });

  it('preserves object responses from the exception', () => {
    const { host, send } = buildHost('/billing');
    const payload = { code: 'LOCKED', reason: 'past_due' };
    filter.catch(new HttpException(payload, HttpStatus.PAYMENT_REQUIRED), host);

    expect(send.mock.calls[0][0].message).toEqual(payload);
  });

  it('400 da validação sai em pt-BR', () => {
    const { host, send } = buildHost('/assinatura/simular', 'POST');
    filter.catch(
      new BadRequestException(['numeroUsuarios must not be greater than 1000']),
      host,
    );
    expect(send.mock.calls[0][0].message).toEqual([
      'numeroUsuarios não pode ser maior que 1000.',
    ]);
  });

  it('expõe só a mensagem das exceções do Nest (o front lê string)', () => {
    const { host, send } = buildHost('/usuarios', 'POST');
    filter.catch(new ConflictException('Limite atingido.'), host);
    expect(send.mock.calls[0][0].message).toBe('Limite atingido.');
  });

  it('mantém a lista de erros da validação', () => {
    const { host, send } = buildHost('/usuarios', 'POST');
    filter.catch(
      new BadRequestException(['name curto', 'email inválido']),
      host,
    );
    expect(send.mock.calls[0][0].message).toEqual([
      'name curto',
      'email inválido',
    ]);
  });

  it('maps a non-HTTP error to 500 with a generic message (no internal leak)', () => {
    const { host, send, status } = buildHost('/patients', 'POST');
    // Erro com detalhe sensível de infraestrutura que NÃO pode vazar ao cliente.
    const boom = new Error(
      'connect 10.0.0.5:5432 failed: password authentication',
    );
    filter.catch(boom, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    const body = send.mock.calls[0][0];
    expect(body.message).toBe('Erro interno do servidor');
    expect(JSON.stringify(body)).not.toContain('password authentication');
    expect(JSON.stringify(body)).not.toContain('10.0.0.5');
  });

  describe('violação de unicidade/exclusão → 409', () => {
    const erroPg = (code: string, constraint?: string) =>
      Object.assign(new Error('duplicate key value violates ...'), {
        code,
        constraint,
      });

    it('constraint mapeada ganha mensagem específica', () => {
      const { host, send, status } = buildHost('/signup', 'POST');
      filter.catch(erroPg('23505', 'uq_usuarios_email'), host);
      expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
      expect(send.mock.calls[0][0]).toMatchObject({
        statusCode: 409,
        message:
          'Já existe uma conta com este e-mail. Entre com a sua conta (lá você pode criar outra clínica).',
      });
    });

    it('constraint desconhecida → "Registro duplicado."', () => {
      const { host, send, status } = buildHost('/x', 'POST');
      filter.catch(erroPg('23505', 'uq_qualquer'), host);
      expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
      expect(send.mock.calls[0][0].message).toBe('Registro duplicado.');
    });

    it('exclusão (23P01) → 409 de conflito', () => {
      const { host, send, status } = buildHost('/x', 'POST');
      filter.catch(erroPg('23P01'), host);
      expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
      expect(send.mock.calls[0][0].message).toBe(
        'Conflito com outro registro.',
      );
    });

    it('outros SQLSTATE seguem 500 genérico', () => {
      const { host, status } = buildHost('/x');
      filter.catch(erroPg('23503', 'fk_x'), host);
      expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    });
  });

  it('não registra a query string no log (segredos em ?token=)', () => {
    const erro = jest.spyOn(Logger.prototype, 'error');
    erro.mockClear();
    const { host } = buildHost('/webhooks/sendpulse?token=segredo', 'POST');
    filter.catch(new Error('x'), host);
    expect(erro.mock.calls[0][0]).toBe(
      'Erro não tratado em POST /webhooks/sendpulse',
    );
  });

  it('handles a thrown non-Error value as a generic 500', () => {
    const { host, send, status } = buildHost('/x');
    filter.catch('kaboom', host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(send.mock.calls[0][0].message).toBe('Erro interno do servidor');
  });

  describe('texto do parser e do roteador em pt-BR, sem cache', () => {
    it.each([
      [
        'Unexpected end of JSON input',
        'Não foi possível ler os dados enviados. Tente de novo.',
      ],
      [
        'Expected double-quoted property name in JSON at position 11 (line 1 column 12)',
        'Não foi possível ler os dados enviados. Tente de novo.',
      ],
      ["Failed to decode param '%ZZ'", 'Endereço inválido. Confira o link.'],
    ])('400 "%s"', (original, esperado) => {
      const { host, send, setHeader } = buildHost('/auth/login', 'POST');
      filter.catch(new BadRequestException(original), host);
      expect(send.mock.calls[0][0].message).toBe(esperado);
      expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    });

    it('404 do roteador ("Cannot GET /x") vira "Endereço não encontrado."', () => {
      const { host, send } = buildHost('/convites/%ZZ');
      filter.catch(
        new HttpException('Cannot GET /convites/%ZZ', HttpStatus.NOT_FOUND),
        host,
      );
      expect(send.mock.calls[0][0].message).toBe('Endereço não encontrado.');
    });

    it('texto padrão do Nest vira pt-BR pelo status; mensagem própria fica', () => {
      const a = buildHost('/x');
      filter.catch(new HttpException('Forbidden resource', 403), a.host);
      expect(a.send.mock.calls[0][0].message).toBe(
        'Você não tem permissão para esta ação.',
      );
      const b = buildHost('/x');
      filter.catch(new HttpException('Too Many Requests', 429), b.host);
      expect(b.send.mock.calls[0][0].message).toBe(
        'Muitas tentativas. Aguarde alguns minutos e tente de novo.',
      );
      const c = buildHost('/x');
      filter.catch(new HttpException('I am a teapot', 418), c.host);
      expect(c.send.mock.calls[0][0].message).toBe('I am a teapot');
      const d = buildHost('/x');
      filter.catch(new HttpException('Bad Gateway', 502), d.host);
      expect(d.send.mock.calls[0][0].message).toBe('Bad Gateway');
    });

    it('não devolve a query string no path', () => {
      const { host, send } = buildHost('/auth/verificar-token?token=segredo');
      filter.catch(new HttpException('x', 400), host);
      expect(send.mock.calls[0][0].path).toBe('/auth/verificar-token');
    });
  });
});
