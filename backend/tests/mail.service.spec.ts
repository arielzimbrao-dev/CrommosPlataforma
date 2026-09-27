import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { MailService } from 'src/mail/mail.service';

describe('MailService', () => {
  const original = { ...process.env };
  let logSpy: jest.SpyInstance;
  const enviarEmail = jest.fn().mockResolvedValue(undefined);
  const make = () => new MailService({ enviarEmail });
  const corpo = (i = 0) => enviarEmail.mock.calls[i][2] as string;

  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    enviarEmail.mockClear();
  });

  afterEach(() => {
    process.env = { ...original };
    logSpy.mockRestore();
  });

  it('redefinição com o link do FRONTEND_URL', async () => {
    process.env.FRONTEND_URL = 'https://app.crommos.com/';
    await make().sendPasswordReset('ana@x.com', 'tok-123');
    expect(enviarEmail).toHaveBeenCalledWith(
      'ana@x.com',
      'Redefinição de senha — Crommos',
      expect.stringContaining(
        'https://app.crommos.com/redefinir-senha?token=tok-123',
      ),
    );
  });

  it('convite com o nome do sistema e o link de definir senha (localhost em dev)', async () => {
    delete process.env.FRONTEND_URL;
    await make().sendConvite('bia@x.com', 'Bia', 'tok-9', 'vet');
    expect(enviarEmail.mock.calls[0][1]).toBe('Convite para o Crommos Vet');
    expect(corpo()).toContain(
      'http://localhost:5173/definir-senha?token=tok-9',
    );
    expect(corpo()).toContain('Bia');
  });

  it('QA-004: convite de quem já tem conta aponta para o aceite na API, com o nome da clínica', async () => {
    process.env.API_URL = 'https://conta.crommos.com';
    await make().sendConviteAceite('bia@x.com', 'Bia', 'tok-7', 'clinic', 'Clínica Sol');
    await make().sendConviteAceite('bia@x.com', 'Bia', 'tok-8', 'clinic', null);
    delete process.env.API_URL;
    expect(enviarEmail.mock.calls[0][1]).toBe('Convite para o Crommos Clinic');
    expect(corpo(0)).toContain(
      'https://conta.crommos.com/auth/aceitar-convite?token=tok-7',
    );
    expect(corpo(0)).toContain('Clínica Sol');
    expect(corpo(1)).toContain('uma clínica');
  });

  it('confirmação aponta para a API (API_URL ou localhost:PORT)', async () => {
    process.env.API_URL = 'https://conta.crommos.com/';
    await make().sendConfirmacaoEmail('ana@x.com', 'tok-1');
    delete process.env.API_URL;
    process.env.PORT = '4000';
    await make().sendConfirmacaoEmail('ana@x.com', 'tok-2');
    delete process.env.PORT;
    await make().sendConfirmacaoEmail('ana@x.com', 'tok-3');
    expect(corpo(0)).toContain(
      'https://conta.crommos.com/auth/confirmar-email?token=tok-1',
    );
    expect(corpo(1)).toContain(
      'http://localhost:4000/auth/confirmar-email?token=tok-2',
    );
    expect(corpo(2)).toContain('http://localhost:3000/');
  });

  it('falha do provider vira 503, com aviso no log sem o e-mail', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    enviarEmail.mockRejectedValueOnce(new Error('timeout'));
    await expect(
      make().sendConvite('bia@x.com', 'Bia', 't', 'clinic'),
    ).rejects.toThrow(ServiceUnavailableException);
    enviarEmail.mockRejectedValueOnce('texto');
    await expect(make().sendPasswordReset('bia@x.com', 't')).rejects.toThrow(
      ServiceUnavailableException,
    );
    const logado = warn.mock.calls.map((c) => String(c[0])).join(' | ');
    expect(logado).toContain('timeout');
    expect(logado).not.toContain('bia@x.com');
    warn.mockRestore();
  });

  it('dev loga o link (nunca o e-mail); produção não loga', async () => {
    process.env.NODE_ENV = 'development';
    await make().sendPasswordReset('ana@x.com', 'tok-dev');
    process.env.NODE_ENV = 'production';
    await make().sendPasswordReset('ana@x.com', 'tok-prod');
    const logado = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logado).toContain('tok-dev');
    expect(logado).not.toContain('tok-prod');
    expect(logado).not.toContain('ana@x.com');
  });
});
