import { generateKeyPairSync } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  chavesJwt,
  EMISSOR_PADRAO,
  kidDaChave,
  kidDoToken,
  normalizarPem,
  opcoesJwt,
} from 'src/auth/chaves-jwt';
import { JwtStrategy } from 'src/auth/jwt.strategy';

const par = () =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

const config = (env: Record<string, string | undefined>) =>
  ({
    get: (k: string) => env[k],
    getOrThrow: (k: string) => {
      if (env[k] === undefined) throw new Error(k);
      return env[k];
    },
  }) as unknown as ConfigService;

/** S-08: `iss`, `aud` e `kid` no token; rotação com a chave anterior. */
describe('tokens com iss, aud e kid (rotação de chave)', () => {
  const atual = {
    privateKey: process.env.PLATAFORMA_JWT_PRIVATE_KEY!,
    publicKey: process.env.PLATAFORMA_JWT_PUBLIC_KEY!,
  };
  const anterior = par();
  const env = {
    PLATAFORMA_JWT_PRIVATE_KEY: atual.privateKey,
    PLATAFORMA_JWT_PUBLIC_KEY: atual.publicKey,
    PLATAFORMA_JWT_PUBLIC_KEY_ANTERIOR: anterior.publicKey,
  };
  const jwt = new JwtService(opcoesJwt(chavesJwt(config(env))));
  const claims = {
    sub: 'u1',
    produto: 'clinic',
    tenantId: 't1',
    typ: 'access',
  };

  /** Token "da chave anterior", como a plataforma emitia antes da troca. */
  const daAnterior = (over: Record<string, unknown> = {}) =>
    new JwtService().sign(
      claims,
      // undefined = sem a claim (o jsonwebtoken recusa opção undefined)
      JSON.parse(
        JSON.stringify({
          algorithm: 'RS256',
          privateKey: anterior.privateKey,
          keyid: kidDaChave(anterior.publicKey),
          issuer: EMISSOR_PADRAO,
          audience: 'clinic',
          ...over,
        }),
      ),
    );

  it('kid = thumbprint da pública: estável, independe do formato do PEM e muda com a chave', () => {
    const kid = kidDaChave(atual.publicKey);
    expect(kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(kidDaChave(normalizarPem(atual.publicKey))).toBe(kid);
    expect(kidDaChave(anterior.publicKey)).not.toBe(kid);
  });

  it('kidDoToken lê o cabeçalho; lixo → undefined', () => {
    expect(kidDoToken(daAnterior())).toBe(kidDaChave(anterior.publicKey));
    expect(kidDoToken('lixo')).toBeUndefined();
    expect(kidDoToken('e30.e30.x')).toBeUndefined(); // cabeçalho `{}`
  });

  it('emite com iss (padrão), aud = produto e kid da chave atual', async () => {
    const token = await jwt.signAsync(claims, { audience: 'clinic' });
    expect(kidDoToken(token)).toBe(kidDaChave(atual.publicKey));
    await expect(jwt.verifyAsync(token)).resolves.toMatchObject({
      iss: 'crommos-plataforma',
      aud: 'clinic',
    });
  });

  it('PLATAFORMA_JWT_ISSUER troca o emissor', async () => {
    const outro = new JwtService(
      opcoesJwt(
        chavesJwt(config({ ...env, PLATAFORMA_JWT_ISSUER: 'https://x.y' })),
      ),
    );
    const token = await outro.signAsync(claims, { audience: 'clinic' });
    await expect(outro.verifyAsync(token)).resolves.toMatchObject({
      iss: 'https://x.y',
    });
    await expect(jwt.verifyAsync(token)).rejects.toThrow(/issuer/);
  });

  it('aceita a chave anterior durante a troca; sem ela configurada, recusa', async () => {
    await expect(jwt.verifyAsync(daAnterior())).resolves.toMatchObject(claims);
    const semAnterior = new JwtService(
      opcoesJwt(
        chavesJwt(
          config({ ...env, PLATAFORMA_JWT_PUBLIC_KEY_ANTERIOR: undefined }),
        ),
      ),
    );
    await expect(semAnterior.verifyAsync(daAnterior())).rejects.toThrow();
  });

  it.each([
    ['sem kid', { keyid: undefined }],
    ['kid desconhecida', { keyid: 'outra' }],
    [
      'kid da atual com assinatura da anterior',
      { keyid: kidDaChave(atual.publicKey) },
    ],
    ['iss errado', { issuer: 'outro' }],
    ['aud fora dos produtos', { audience: 'x' }],
  ])('recusa token %s', async (_c, over) => {
    await expect(jwt.verifyAsync(daAnterior(over))).rejects.toThrow();
  });

  describe('JwtStrategy (guard das rotas)', () => {
    const sessoes = { sessaoVigente: jest.fn().mockResolvedValue(true) };
    const strategy = new JwtStrategy(config(env), sessoes as never);

    /** Roda o passport-jwt de verdade: `true` = autenticou. */
    const autentica = (token: string) =>
      new Promise<boolean>((resolve) => {
        const s = Object.create(strategy) as JwtStrategy & {
          success: () => void;
          fail: () => void;
          error: (e: unknown) => void;
          authenticate: (req: unknown) => void;
        };
        s.success = () => resolve(true);
        s.fail = () => resolve(false);
        s.error = () => resolve(false);
        s.authenticate({ headers: { authorization: `Bearer ${token}` } });
      });

    it('atual e anterior entram; sem kid, kid desconhecida, iss errado e aud ≠ produto não', async () => {
      await expect(
        autentica(await jwt.signAsync(claims, { audience: 'clinic' })),
      ).resolves.toBe(true);
      await expect(autentica(daAnterior())).resolves.toBe(true);
      await expect(autentica(daAnterior({ keyid: undefined }))).resolves.toBe(
        false,
      );
      await expect(autentica(daAnterior({ keyid: 'outra' }))).resolves.toBe(
        false,
      );
      await expect(autentica(daAnterior({ issuer: 'outro' }))).resolves.toBe(
        false,
      );
      await expect(autentica(daAnterior({ audience: 'vet' }))).resolves.toBe(
        false,
      );
    });
  });
});
