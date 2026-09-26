import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { sha256 } from 'src/common/crypto/segredo';
import { normalizarPem } from 'src/auth/chaves-jwt';
import { SessoesService } from 'src/auth/sessoes.service';

/** Unidade: casos de borda que a integração não alcança com facilidade. */
describe('SessoesService', () => {
  const jwt = new JwtService({
    privateKey: normalizarPem(process.env.PLATAFORMA_JWT_PRIVATE_KEY!),
    publicKey: normalizarPem(process.env.PLATAFORMA_JWT_PUBLIC_KEY!),
    signOptions: { algorithm: 'RS256' },
    verifyOptions: { algorithms: ['RS256'] },
  });
  const make = () => {
    const sessoes = {
      insert: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 3 }),
    };
    const config = { get: (_k: string, padrao: string) => padrao };
    const audit = { registrar: jest.fn() };
    const svc = new SessoesService(
      sessoes as never,
      jwt,
      config as never,
      audit as never,
    );
    return { svc, sessoes, audit };
  };
  const alvo = { usuarioId: 'u1', produto: 'clinic' as const, tenantId: 't1' };

  it('emitir grava a sessão com o hash do refresh e validade de 7 dias', async () => {
    const { svc, sessoes } = make();
    const antes = Date.now();
    const { refreshToken } = await svc.emitir(alvo, 'jti-1');
    const [linha] = sessoes.insert.mock.calls[0] as [Record<string, unknown>];
    expect(linha).toMatchObject({
      jti: 'jti-1',
      usuarioId: 'u1',
      refreshHash: sha256(refreshToken),
      revogadaEm: null,
      substituidaPor: null,
    });
    const ttl = (linha.expiraEm as Date).getTime() - antes;
    expect(ttl).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000);
  });

  it('lerRefresh recusa access token e lixo', async () => {
    const { svc } = make();
    const { accessToken } = await svc.emitir(alvo);
    await expect(svc.lerRefresh(accessToken)).resolves.toBeNull();
    await expect(svc.lerRefresh('lixo')).resolves.toBeNull();
  });

  it('consumir: sessão inexistente, de outra pessoa ou com hash diferente → 401 sem revogar tudo', async () => {
    const { svc, sessoes, audit } = make();
    const { refreshToken } = await svc.emitir(alvo, 'jti-2');
    const base = {
      jti: 'jti-2',
      usuarioId: 'u1',
      refreshHash: sha256(refreshToken),
      revogadaEm: null,
      substituidaPor: null,
    };
    for (const s of [
      null,
      { ...base, usuarioId: 'u2' },
      { ...base, refreshHash: sha256('outro') },
      { ...base, revogadaEm: new Date() }, // logout: sem substituta
    ]) {
      sessoes.findOne.mockResolvedValueOnce(s);
      await expect(svc.consumir(refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
    }
    expect(sessoes.update).not.toHaveBeenCalled();
    expect(audit.registrar).not.toHaveBeenCalled();
  });

  it('consumir: refresh recém-rotacionado (outra aba, < 10 s) → par novo, sem revogar tudo (B1)', async () => {
    const { svc, sessoes, audit } = make();
    const { refreshToken } = await svc.emitir(alvo, 'jti-g');
    sessoes.findOne.mockResolvedValue({
      jti: 'jti-g',
      usuarioId: 'u1',
      refreshHash: sha256(refreshToken),
      revogadaEm: new Date(Date.now() - 2_000),
      substituidaPor: 'jti-outra-aba',
    });
    const r = await svc.consumir(refreshToken);
    expect(r.claims.sub).toBe('u1');
    expect(r.jtiNovo).toEqual(expect.any(String));
    expect(sessoes.update).not.toHaveBeenCalled();
    expect(audit.registrar).not.toHaveBeenCalled();
  });

  it('consumir: rotacionado há mais de 10 s → reuso (revoga todas)', async () => {
    const { svc, sessoes, audit } = make();
    const { refreshToken } = await svc.emitir(alvo, 'jti-v');
    sessoes.findOne.mockResolvedValue({
      jti: 'jti-v',
      usuarioId: 'u1',
      refreshHash: sha256(refreshToken),
      revogadaEm: new Date(Date.now() - 11_000),
      substituidaPor: 'jti-x',
    });
    await expect(svc.consumir(refreshToken)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(audit.registrar).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'refresh-reutilizado' }),
    );
  });

  it('consumir: corrida em que a outra aba acabou de rotacionar → par novo (B1)', async () => {
    const { svc, sessoes, audit } = make();
    const { refreshToken } = await svc.emitir(alvo, 'jti-c');
    const base = {
      jti: 'jti-c',
      usuarioId: 'u1',
      refreshHash: sha256(refreshToken),
    };
    sessoes.findOne
      .mockResolvedValueOnce({
        ...base,
        revogadaEm: null,
        substituidaPor: null,
      })
      .mockResolvedValueOnce({
        ...base,
        revogadaEm: new Date(),
        substituidaPor: 'jti-aba-1',
      });
    sessoes.update.mockResolvedValueOnce({ affected: 0 });
    await expect(svc.consumir(refreshToken)).resolves.toMatchObject({
      claims: { sub: 'u1' },
    });
    expect(audit.registrar).not.toHaveBeenCalled();
  });

  it('consumir: corrida (UPDATE não casou) conta como reuso', async () => {
    const { svc, sessoes, audit } = make();
    const { refreshToken } = await svc.emitir(alvo, 'jti-3');
    sessoes.findOne.mockResolvedValue({
      jti: 'jti-3',
      usuarioId: 'u1',
      refreshHash: sha256(refreshToken),
      revogadaEm: null,
      substituidaPor: null,
    });
    sessoes.update.mockResolvedValueOnce({ affected: 0 });
    await expect(svc.consumir(refreshToken)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(audit.registrar).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'refresh-reutilizado' }),
    );
  });

  it('encerrar sem token ou com lixo não faz nada', async () => {
    const { svc, sessoes } = make();
    await expect(svc.encerrar(undefined)).resolves.toBeNull();
    await expect(svc.encerrar('lixo')).resolves.toBeNull();
    expect(sessoes.update).not.toHaveBeenCalled();
  });

  it('limparVencidas apaga as vencidas há mais de um dia', async () => {
    const { svc, sessoes } = make();
    await expect(svc.limparVencidas(10 * 86_400_000)).resolves.toBe(3);
    const [where] = sessoes.delete.mock.calls[0] as [
      { expiraEm: { value: Date } },
    ];
    expect(where.expiraEm.value.getTime()).toBe(9 * 86_400_000);
    sessoes.delete.mockResolvedValueOnce({});
    await expect(svc.limparVencidas()).resolves.toBe(0);
  });
});
