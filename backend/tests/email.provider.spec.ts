import { Logger } from '@nestjs/common';
import {
  criarEmailProvider,
  mascararEmail,
  ResendEmailProvider,
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

describe('ResendEmailProvider', () => {
  const CFG = { apiKey: 're_123', from: 'Crommos <contato@crommos.com>' };

  it('POST /emails com Bearer, remetente, destinatário, texto e HTML escapado', async () => {
    const http = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    await new ResendEmailProvider(CFG, http).enviarEmail(
      'ana@clinica.com',
      'Assunto',
      'Olá <b>Ana</b> & cia',
    );
    const [url, init] = http.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer re_123');
    expect(JSON.parse(init.body)).toEqual({
      from: 'Crommos <contato@crommos.com>',
      to: ['ana@clinica.com'],
      subject: 'Assunto',
      text: 'Olá <b>Ana</b> & cia',
      html: '<p>Olá &lt;b&gt;Ana&lt;/b&gt; &amp; cia</p>',
    });
  });

  it('parágrafos viram <p> e links continuam texto', async () => {
    const http = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    await new ResendEmailProvider(CFG, http).enviarEmail(
      'a@b.c',
      's',
      'um\n\ndois',
    );
    const corpo = JSON.parse(
      (http.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { html: string };
    expect(corpo.html).toBe('<p>um</p><p>dois</p>');
  });

  it('erro HTTP: lança só com o status (sem ecoar o corpo)', async () => {
    const http = jest.fn().mockResolvedValue({ ok: false, status: 422 });
    await expect(
      new ResendEmailProvider(CFG, http).enviarEmail('a@b.c', 's', 'c'),
    ).rejects.toThrow('Resend: HTTP 422');
  });
});

describe('criarEmailProvider', () => {
  it('sem RESEND_API_KEY → stub; com ela → Resend (remetente padrão)', () => {
    expect(criarEmailProvider({})).toBeInstanceOf(StubEmailProvider);
    expect(criarEmailProvider({ RESEND_API_KEY: 're_x' })).toBeInstanceOf(
      ResendEmailProvider,
    );
  });
});
