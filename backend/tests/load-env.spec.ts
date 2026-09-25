import * as dotenv from 'dotenv';
import { loadEnv } from 'src/config/load-env';

jest.mock('dotenv');

describe('loadEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('carrega .env.local (precedência) + .env', () => {
    loadEnv();
    expect(dotenv.config).toHaveBeenCalledWith({
      path: ['.env.local', '.env'],
    });
  });

  it('não aplica mais aliases de plataforma (ENV/JWT_KEY): só nomes canônicos', () => {
    delete process.env.NODE_ENV;
    process.env.ENV = 'development';
    loadEnv();
    expect(process.env.NODE_ENV).toBeUndefined();
  });
});
