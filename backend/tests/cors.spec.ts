import { corsPermite, origensPermitidas } from 'src/common/http/cors';

describe('CORS (BE-A4)', () => {
  it('normaliza a allowlist de FRONTEND_URL (CSV, sem barra final)', () => {
    expect(origensPermitidas(' https://a.com/, https://b.com ,')).toEqual([
      'https://a.com',
      'https://b.com',
    ]);
    expect(origensPermitidas(undefined)).toEqual([]);
  });

  const prod = { nodeEnv: 'production', permitidas: ['https://app.com'] };

  it('produção: só a allowlist (barra final tolerada)', () => {
    expect(corsPermite('https://app.com/', prod)).toBe(true);
    expect(corsPermite('https://evil.com', prod)).toBe(false);
  });

  it('produção com allowlist vazia NUNCA libera origem de navegador', () => {
    expect(
      corsPermite('https://evil.com', {
        nodeEnv: 'production',
        permitidas: [],
      }),
    ).toBe(false);
  });

  it('requisição sem Origin (não-navegador) passa', () => {
    expect(corsPermite(undefined, prod)).toBe(true);
  });

  it('desenvolvimento libera tudo; teste sem allowlist também', () => {
    expect(
      corsPermite('http://x', { nodeEnv: 'development', permitidas: ['a'] }),
    ).toBe(true);
    expect(corsPermite('http://x', { nodeEnv: 'test', permitidas: [] })).toBe(
      true,
    );
    expect(
      corsPermite('http://x', { nodeEnv: 'test', permitidas: ['http://y'] }),
    ).toBe(false);
  });
});
