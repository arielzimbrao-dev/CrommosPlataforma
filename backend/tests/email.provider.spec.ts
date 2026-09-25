import { Logger } from '@nestjs/common';
import {
  criarEmailProvider,
  mascararEmail,
  SendpulseEmailProvider,
  StubEmailProvider,
} from 'src/mail/email.provider';

describe('StubEmailProvider', () => {
  it('loga o envio com o e-mail mascarado, sem conteúdo', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    await new StubEmailProvider().enviarEmail(
      'ana.silva@clinica.com',
      'assunto',
      'corpo secreto',
    );
    const msgs = log.mock.calls.map((c) => String(c[0])).join(' ');
    expect(msgs).toContain('a***@clinica.com');
    expect(msgs).not.toContain('ana.silva');
    expect(msgs).not.toContain('corpo secreto');
    expect(mascararEmail('sem-arroba')).toBe('s***@***');
    log.mockRestore();
  });
});

describe('SendpulseEmailProvider', () => {
  const CFG = {
    clientId: 'id',
    clientSecret: 'segredo',
    fromEmail: 'contato@crommos.com',
    fromName: 'Crommos',
  };

  function fakeFetch(respostas: Record<string, number> = {}) {
    return jest.fn((url: string) => {
      const path = new URL(url).pathname;
      const status = respostas[path] ?? 200;
      const corpo =
        path === '/oauth/access_token'
          ? { access_token: 'tok', expires_in: 3600 }
          : { result: true };
      return Promise.resolve({
        ok: status < 400,
        status,
        json: () => Promise.resolve(corpo),
      });
    });
  }
  const corpo = (f: jest.Mock, i: number) =>
    JSON.parse((f.mock.calls[i][1] as { body: string }).body) as Record<
      string,
      unknown
    >;

  it('autentica uma vez, reaproveita o token e envia texto + html escapado', async () => {
    const f = fakeFetch();
    const p = new SendpulseEmailProvider(CFG, f as never);
    await p.enviarEmail('ana@x.com', 'Assunto', 'Olá <b>');
    await p.enviarEmail('bia@x.com', 'Assunto', 'Oi');
    expect(corpo(f, 0)).toEqual({
      grant_type: 'client_credentials',
      client_id: 'id',
      client_secret: 'segredo',
    });
    expect(
      f.mock.calls.filter((c) => String(c[0]).includes('oauth')),
    ).toHaveLength(1);
    const email = corpo(f, 1).email as Record<string, unknown>;
    expect(email.to).toEqual([{ email: 'ana@x.com' }]);
    expect(email.from).toEqual({
      name: 'Crommos',
      email: 'contato@crommos.com',
    });
    expect(email.text).toBe('Olá <b>');
    expect(Buffer.from(email.html as string, 'base64').toString()).toContain(
      'Olá &lt;b&gt;',
    );
  });

  it('renova o token vencido', async () => {
    const f = fakeFetch();
    let agora = 0;
    const p = new SendpulseEmailProvider(CFG, f as never, () => agora);
    await p.enviarEmail('a@x.com', 's', 't');
    agora = 3_600_000;
    await p.enviarEmail('a@x.com', 's', 't');
    expect(
      f.mock.calls.filter((c) => String(c[0]).includes('oauth')),
    ).toHaveLength(2);
  });

  it('erro HTTP e falha de autenticação lançam só o status', async () => {
    await expect(
      new SendpulseEmailProvider(
        CFG,
        fakeFetch({ '/smtp/emails': 400 }) as never,
      ).enviarEmail('a@x.com', 's', 't'),
    ).rejects.toThrow(/^SendPulse email: HTTP 400$/);
    await expect(
      new SendpulseEmailProvider(
        CFG,
        fakeFetch({ '/oauth/access_token': 401 }) as never,
      ).enviarEmail('a@x.com', 's', 't'),
    ).rejects.toThrow('SendPulse auth: HTTP 401');
  });
});

describe('criarEmailProvider', () => {
  it('sem credenciais → stub; com id + secret → SendPulse', () => {
    expect(criarEmailProvider({})).toBeInstanceOf(StubEmailProvider);
    expect(
      criarEmailProvider({
        SENDPULSE_CLIENT_ID: 'a',
        SENDPULSE_CLIENT_SECRET: 'b',
      }),
    ).toBeInstanceOf(SendpulseEmailProvider);
    expect(criarEmailProvider()).toBeInstanceOf(StubEmailProvider);
  });
});
