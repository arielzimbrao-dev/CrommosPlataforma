import { generateKeyPairSync } from 'node:crypto';
import {
  EnvironmentVariables,
  NodeEnv,
  validateEnv,
} from 'src/config/env.validation';

describe('validateEnv', () => {
  const valido = (): Record<string, unknown> => ({
    NODE_ENV: 'development',
    PORT: '3000',
    DB_HOST: 'localhost',
    DB_PORT: '5432',
    DB_USERNAME: 'postgres',
    DB_PASSWORD: 'postgres',
    DB_NAME: 'plataforma',
    PLATAFORMA_JWT_PRIVATE_KEY: process.env.PLATAFORMA_JWT_PRIVATE_KEY,
    PLATAFORMA_JWT_PUBLIC_KEY: process.env.PLATAFORMA_JWT_PUBLIC_KEY,
  });
  const chave = (c: string) => `chave-de-servico-${c}-`.padEnd(40, 'x');

  it('aceita o mínimo e converte as portas', () => {
    const r = validateEnv(valido());
    expect(r).toBeInstanceOf(EnvironmentVariables);
    expect(r.NODE_ENV).toBe(NodeEnv.Development);
    expect(r.PORT).toBe(3000);
    expect(r.DB_PORT).toBe(5432);
  });

  it('opcionais vazios (`VAR=`) contam como ausentes; obrigatória vazia falha', () => {
    expect(() =>
      validateEnv({ ...valido(), FRONTEND_URL: '', RESEND_API_KEY: '' }),
    ).not.toThrow();
    expect(() => validateEnv({ ...valido(), DB_HOST: '' })).toThrow(
      /Configuração de ambiente inválida/,
    );
  });

  it('novas variáveis: tolerância da inadimplência, AbacatePay (chave pede segredo do webhook), chaves de provisionamento', () => {
    expect(
      validateEnv({ ...valido(), DIAS_TOLERANCIA_INADIMPLENCIA: '7' })
        .DIAS_TOLERANCIA_INADIMPLENCIA,
    ).toBe(7);
    expect(() =>
      validateEnv({ ...valido(), DIAS_TOLERANCIA_INADIMPLENCIA: '-1' }),
    ).toThrow();
    expect(() =>
      validateEnv({ ...valido(), ABACATEPAY_API_KEY: 'abc_dev_123' }),
    ).toThrow(/ABACATEPAY_WEBHOOK_SECRET/);
    expect(() =>
      validateEnv({
        ...valido(),
        ABACATEPAY_API_KEY: 'abc_dev_123',
        ABACATEPAY_WEBHOOK_SECRET: 'segredo-do-webhook-123',
        RESEND_API_KEY: 're_123',
        EMAIL_FROM: 'Crommos <contato@crommos.com>',
        DB_AGUARDAR_SCHEMAS: 'clinic',
      }),
    ).not.toThrow();
    expect(() =>
      validateEnv({ ...valido(), PROVISIONAMENTO_KEY_CLINIC: 'curta' }),
    ).toThrow();
  });

  it('exige as chaves JWT e que a pública seja a da privada (PEM, também com \\n escapado)', () => {
    const { PLATAFORMA_JWT_PUBLIC_KEY: _p, ...semPublica } = valido();
    expect(() => validateEnv(semPublica)).toThrow(/PLATAFORMA_JWT_PUBLIC_KEY/);

    const outra = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    expect(() =>
      validateEnv({ ...valido(), PLATAFORMA_JWT_PUBLIC_KEY: outra.publicKey }),
    ).toThrow(/não corresponde/);
    expect(() =>
      validateEnv({ ...valido(), PLATAFORMA_JWT_PRIVATE_KEY: 'lixo' }),
    ).toThrow(/PEM válidos/);
  });

  it('produto: URL e chave vão juntas; chave ≥ 32; chaves distintas entre produtos', () => {
    expect(() =>
      validateEnv({
        ...valido(),
        CLINIC_API_URL: 'http://clinic-api:3000',
        SERVICO_KEY_CLINIC: chave('clinic'),
        VET_API_URL: 'https://vet.exemplo.com',
        SERVICO_KEY_VET: chave('vet'),
      }),
    ).not.toThrow();
    expect(() =>
      validateEnv({ ...valido(), CLINIC_API_URL: 'http://clinic-api:3000' }),
    ).toThrow(/CLINIC_API_URL e SERVICO_KEY_CLINIC vão juntas/);
    expect(() =>
      validateEnv({ ...valido(), SERVICO_KEY_ODONTO: chave('odonto') }),
    ).toThrow(/ODONTO_API_URL e SERVICO_KEY_ODONTO/);
    expect(() =>
      validateEnv({
        ...valido(),
        CLINIC_API_URL: 'http://clinic-api:3000',
        SERVICO_KEY_CLINIC: 'curta',
      }),
    ).toThrow(/SERVICO_KEY_CLINIC/);
    expect(() =>
      validateEnv({
        ...valido(),
        CLINIC_API_URL: 'clinic-api',
        SERVICO_KEY_CLINIC: chave('clinic'),
      }),
    ).toThrow(/CLINIC_API_URL/);
    expect(() =>
      validateEnv({
        ...valido(),
        CLINIC_API_URL: 'http://a:1',
        SERVICO_KEY_CLINIC: chave('igual'),
        ODONTO_API_URL: 'http://b:1',
        SERVICO_KEY_ODONTO: chave('igual'),
      }),
    ).toThrow(/SERVICO_KEY_\* própria/);
  });

  it('produção exige FRONTEND_URL e API_URL', () => {
    const prod = { ...valido(), NODE_ENV: 'production' };
    expect(() => validateEnv(prod)).toThrow(
      /FRONTEND_URL[\s\S]*API_URL|API_URL/,
    );
    expect(() =>
      validateEnv({
        ...prod,
        FRONTEND_URL: 'https://app.crommos.com',
        API_URL: 'https://conta.crommos.com',
      }),
    ).not.toThrow();
  });

  it('PLATAFORMA_API_KEY opcional, mas ≥ 32; booleanos só true/false', () => {
    expect(() =>
      validateEnv({ ...valido(), PLATAFORMA_API_KEY: 'curta' }),
    ).toThrow(/PLATAFORMA_API_KEY/);
    expect(() => validateEnv({ ...valido(), DB_LOGGING: 'sim' })).toThrow(
      /DB_LOGGING/,
    );
  });
});
