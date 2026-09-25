import { generateKeyPairSync } from 'node:crypto';

/**
 * Ambiente dos testes. O par RS256 é gerado a cada execução (nunca há chave
 * privada versionada); a pública vai com `\n` escapado para exercitar o
 * formato de uma linha aceito do ambiente.
 */
if (!process.env.PLATAFORMA_JWT_PRIVATE_KEY) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  process.env.PLATAFORMA_JWT_PRIVATE_KEY = privateKey;
  process.env.PLATAFORMA_JWT_PUBLIC_KEY = publicKey.replace(/\n/g, '\\n');
}
process.env.NODE_ENV ??= 'test';
process.env.PORT ??= '3000';

// Banco e produtos de teste (o CI sobrescreve DB_*). As URLs dos produtos são
// trocadas pelo stub HTTP de cada spec (lidas a cada chamada).
process.env.DB_HOST ??= 'localhost';
process.env.DB_PORT ??= '5432';
process.env.DB_USERNAME ??= 'postgres';
process.env.DB_PASSWORD ??= 'postgres';
process.env.DB_NAME ??= 'plat_test';
process.env.CLINIC_API_URL ??= 'http://127.0.0.1:9';
process.env.SERVICO_KEY_CLINIC ??= 'chave-de-servico-do-clinic-para-testes-000000';
process.env.ODONTO_API_URL ??= 'http://127.0.0.1:9';
process.env.SERVICO_KEY_ODONTO ??= 'chave-de-servico-do-odonto-para-testes-000000';
process.env.PLATAFORMA_API_KEY ??= 'chave-da-plataforma-para-testes-0123456789abcdef';
