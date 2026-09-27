import {
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AcessoGuard } from 'src/auth/acesso.guard';
import { currentUserFactory } from 'src/auth/decorators/current-user.decorator';
import {
  EXIGE_ACESSO_KEY,
  ExigeAcesso,
} from 'src/auth/decorators/exige-acesso.decorator';
import { JwtStrategy } from 'src/auth/jwt.strategy';
import {
  produtoServicoFactory,
  ServicoKeyGuard,
} from 'src/interno/servico-key.guard';

const contexto = (req: Record<string, unknown>) =>
  ({
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;

describe('JwtStrategy', () => {
  const sessoes = { sessaoVigente: jest.fn().mockResolvedValue(true) };
  const strategy = new JwtStrategy(
    {
      getOrThrow: () => process.env.PLATAFORMA_JWT_PUBLIC_KEY,
    } as unknown as ConfigService,
    sessoes as never,
  );
  const base = {
    sub: 'u1',
    produto: 'clinic' as const,
    tenantId: 't1',
    typ: 'access' as const,
  };

  it('devolve só as claims do contrato de um access', async () => {
    await expect(
      strategy.validate({ ...base, extra: 1 } as never),
    ).resolves.toEqual(base);
    // Sem sid (token anterior ao QA-002): não consulta a sessão.
    expect(sessoes.sessaoVigente).not.toHaveBeenCalled();
  });

  it('QA-002: com sid, confere a sessão; família encerrada → 401', async () => {
    await expect(
      strategy.validate({ ...base, sid: 's1' } as never),
    ).resolves.toEqual({ ...base, sid: 's1' });
    expect(sessoes.sessaoVigente).toHaveBeenCalledWith('s1', 'u1');
    sessoes.sessaoVigente.mockResolvedValueOnce(false);
    await expect(
      strategy.validate({ ...base, sid: 's1' } as never),
    ).rejects.toThrow('Sessão encerrada.');
  });

  it.each([
    ['refresh usado como access', { typ: 'refresh' }],
    ['sem tenantId', { tenantId: '' }],
    ['sem sub', { sub: '' }],
    ['produto desconhecido', { produto: 'x' }],
  ])('recusa %s', async (_c, over) => {
    await expect(
      strategy.validate({ ...base, ...over } as never),
    ).rejects.toThrow(UnauthorizedException);
  });
});

describe('AcessoGuard', () => {
  const acessos = { findOne: jest.fn() };
  const reflector = { getAllAndOverride: jest.fn() };
  const guard = new AcessoGuard(
    reflector as unknown as Reflector,
    acessos as never,
  );
  const user = { sub: 'u1', produto: 'clinic', tenantId: 't1' };

  beforeEach(() => jest.resetAllMocks());

  it('rota sem @ExigeAcesso passa sem consultar', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    await expect(guard.canActivate(contexto({ user }))).resolves.toBe(true);
    expect(acessos.findOne).not.toHaveBeenCalled();
  });

  it('acesso ativo com papel permitido passa e fica no request', async () => {
    reflector.getAllAndOverride.mockReturnValue(['admin']);
    const acesso = { papel: 'admin' };
    acessos.findOne.mockResolvedValue(acesso);
    const req: Record<string, unknown> = { user };
    await expect(guard.canActivate(contexto(req))).resolves.toBe(true);
    expect(req.acesso).toBe(acesso);
    expect(acessos.findOne).toHaveBeenCalledWith({
      where: {
        usuarioId: 'u1',
        produto: 'clinic',
        tenantId: 't1',
        ativo: true,
      },
    });
  });

  it('sem papéis = qualquer acesso ativo; papel fora → 403; sem acesso/usuário → 401', async () => {
    reflector.getAllAndOverride.mockReturnValue([]);
    acessos.findOne.mockResolvedValue({ papel: 'gestor' });
    await expect(guard.canActivate(contexto({ user }))).resolves.toBe(true);

    reflector.getAllAndOverride.mockReturnValue(['admin', 'financeiro']);
    await expect(guard.canActivate(contexto({ user }))).rejects.toThrow(
      ForbiddenException,
    );
    acessos.findOne.mockResolvedValue(null);
    await expect(guard.canActivate(contexto({ user }))).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(guard.canActivate(contexto({}))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('@ExigeAcesso registra os papéis', () => {
    class Ctrl {
      @ExigeAcesso('admin')
      handler() {}
    }
    expect(
      new Reflector().get(EXIGE_ACESSO_KEY, Ctrl.prototype.handler),
    ).toEqual(['admin']);
  });
});

describe('ServicoKeyGuard', () => {
  const guard = new ServicoKeyGuard();
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it('chave certa → produto no request (e no decorator)', () => {
    const req: Record<string, unknown> = {
      headers: { 'x-servico-key': process.env.SERVICO_KEY_ODONTO },
    };
    expect(guard.canActivate(contexto(req))).toBe(true);
    expect(req.produtoServico).toBe('odonto');
    expect(produtoServicoFactory(undefined, contexto(req))).toBe('odonto');
  });

  it('sem chave, chave errada ou repetida no header → 401', () => {
    for (const headers of [
      {},
      { 'x-servico-key': 'errada' },
      { 'x-servico-key': [process.env.SERVICO_KEY_CLINIC] },
    ]) {
      expect(() => guard.canActivate(contexto({ headers }))).toThrow(
        UnauthorizedException,
      );
    }
  });

  it('nenhum produto configurado → 404', () => {
    delete process.env.SERVICO_KEY_CLINIC;
    delete process.env.SERVICO_KEY_ODONTO;
    expect(() =>
      guard.canActivate(contexto({ headers: { 'x-servico-key': 'x' } })),
    ).toThrow(NotFoundException);
  });
});

describe('@CurrentUser', () => {
  it('extrai request.user', () => {
    const user = { sub: 'u1' };
    expect(currentUserFactory(undefined, contexto({ user }))).toBe(user);
  });
});
