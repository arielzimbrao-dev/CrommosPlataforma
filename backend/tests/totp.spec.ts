import {
  base32,
  codigoTotp,
  gerarCodigosRecuperacao,
  gerarSegredo,
  normalizarRecuperacao,
  otpauthUrl,
  passoDe,
  passoDoCodigo,
  QTD_CODIGOS_RECUPERACAO,
} from 'src/auth/totp';
import { cifrar, decifrar, recarregarChave } from 'src/common/crypto/cifra';

describe('TOTP (RFC 6238)', () => {
  const rfc = Buffer.from('12345678901234567890');

  it('base32 (RFC 4648) sem padding', () => {
    expect(base32(Buffer.from('f'))).toBe('MY');
    expect(base32(Buffer.from('fo'))).toBe('MZXQ');
    expect(base32(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32(rfc)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('vetor do RFC em t=%i → %s', (t, codigo) => {
    expect(codigoTotp(rfc, passoDe(t * 1000))).toBe(codigo);
  });

  it('aceita o passo atual, o anterior e o seguinte; recusa o resto e lixo', () => {
    const agora = 1111111109_000;
    const p = passoDe(agora);
    expect(passoDoCodigo(rfc, codigoTotp(rfc, p), agora)).toBe(p);
    expect(passoDoCodigo(rfc, codigoTotp(rfc, p - 1), agora)).toBe(p - 1);
    expect(passoDoCodigo(rfc, codigoTotp(rfc, p + 1), agora)).toBe(p + 1);
    expect(passoDoCodigo(rfc, codigoTotp(rfc, p - 2), agora)).toBeNull();
    expect(passoDoCodigo(rfc, '12345', agora)).toBeNull();
    expect(passoDoCodigo(rfc, 'abcdef', agora)).toBeNull();
  });

  it('segredo de 20 bytes; link otpauth com emissor e e-mail', () => {
    expect(gerarSegredo()).toHaveLength(20);
    const url = otpauthUrl('ABC', 'ana@x.com');
    expect(url).toBe(
      'otpauth://totp/Crommos%3Aana%40x.com?secret=ABC&issuer=Crommos&algorithm=SHA1&digits=6&period=30',
    );
  });

  it('códigos de recuperação: 10, XXXX-XXXX, distintos; normalização ignora caixa, hífen e espaço', () => {
    const c = gerarCodigosRecuperacao();
    expect(c).toHaveLength(QTD_CODIGOS_RECUPERACAO);
    expect(new Set(c).size).toBe(c.length);
    for (const x of c) expect(x).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(normalizarRecuperacao(' abcd-efgh ')).toBe('ABCDEFGH');
  });
});

describe('cifra (segredo TOTP em repouso)', () => {
  const antes = process.env.DATA_ENCRYPTION_KEY;
  afterEach(() => {
    process.env.DATA_ENCRYPTION_KEY = antes;
    recarregarChave();
  });

  it('AES-256-GCM: ida e volta; IV aleatório; adulterado lança', () => {
    process.env.DATA_ENCRYPTION_KEY = 'a'.repeat(64);
    recarregarChave();
    const a = cifrar('segredo');
    expect(a).not.toContain('segredo');
    expect(cifrar('segredo')).not.toBe(a);
    expect(decifrar(a)).toBe('segredo');
    const b = Buffer.from(a.slice('enc:v1:'.length), 'base64');
    b[b.length - 1] ^= 1;
    expect(() => decifrar(`enc:v1:${b.toString('base64')}`)).toThrow();
    expect(() => decifrar('em-claro')).toThrow();
  });

  it('sem a chave (ou curta demais) lança: nada é gravado em claro', () => {
    delete process.env.DATA_ENCRYPTION_KEY;
    recarregarChave();
    expect(() => cifrar('x')).toThrow(/DATA_ENCRYPTION_KEY/);
    process.env.DATA_ENCRYPTION_KEY = 'curta';
    recarregarChave();
    expect(() => cifrar('x')).toThrow(/DATA_ENCRYPTION_KEY/);
  });
});
