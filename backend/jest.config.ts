import type { Config } from '@jest/types';

const config: Config.InitialOptions = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  silent: true,
  // Polyfill necessário para os decorators de class-validator/class-transformer e
  // do TypeORM (emitDecoratorMetadata). A app carrega via main.ts; os testes não.
  setupFiles: ['reflect-metadata', '<rootDir>/tests/setup-env.ts'],
  roots: ['<rootDir>/tests'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  collectCoverage: true,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/main.ts',
    '!src/app.module.ts',
    // Conexão/providers dependem de Postgres real (cobertos pela integração);
    // a lógica do runner de migrations (`migrations-runner.ts`) fica NA cobertura.
    '!src/database/database.{providers,module}.ts',
    '!src/**/*.module.ts',
    '!src/**/*.entity.ts',
    '!src/**/dtos/**',
    '!src/**/interfaces/**',
    // Controllers são roteamento declarativo (decorators + delegação de 1
    // linha), verificados ponta a ponta pela integração (Supertest).
    '!src/**/*.controller{,s}.ts',
  ],
  coverageThreshold: {
    global: {
      lines: 85,
      statements: 85,
      branches: 85,
      functions: 85,
    },
  },
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
      },
    ],
  },
};

export default config;
