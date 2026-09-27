import { generateKeyPairSync } from 'node:crypto';
import { erroNoParDeChaves, normalizarPem } from 'src/auth/chaves-jwt';

describe('chaves JWT (RS256)', () => {
  const priv = process.env.PLATAFORMA_JWT_PRIVATE_KEY!;
  const pub = process.env.PLATAFORMA_JWT_PUBLIC_KEY!;

  it('normalizarPem aceita `\\n` escapado numa linha só', () => {
    expect(pub).toContain('\\n');
    const pem = normalizarPem(`  ${pub}  `);
    expect(pem.startsWith('-----BEGIN PUBLIC KEY-----\n')).toBe(true);
    expect(pem).not.toContain('\\n');
  });

  it('normalizarPem aceita a barra dobrada que o Coolify entrega (\\\\n)', () => {
    const dobrar = (v: string) => v.replace(/\\n/g, '\\\\n');
    expect(dobrar(pub)).toContain('\\\\n');
    expect(normalizarPem(dobrar(pub))).toBe(normalizarPem(pub));
    expect(erroNoParDeChaves(dobrar(priv), dobrar(pub))).toBeNull();
  });

  it('par certo → sem erro', () => {
    expect(erroNoParDeChaves(priv, pub)).toBeNull();
  });

  it('pública de outro par, PEM inválido e chave não RSA', () => {
    const outra = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    expect(erroNoParDeChaves(priv, outra.publicKey)).toMatch(/não corresponde/);
    expect(erroNoParDeChaves('x', pub)).toMatch(/PEM válidos/);
    const ec = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    expect(erroNoParDeChaves(ec.privateKey, ec.publicKey)).toMatch(/RSA/);
  });
});
