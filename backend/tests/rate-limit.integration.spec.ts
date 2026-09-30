import { INestApplication, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  TentativasService,
  atrasoPorFalhas,
} from 'src/auth/tentativas.service';
import { InternoController } from 'src/interno/interno.controller';
import { criarApp, fecharApp, mailFalso } from './support/app';

describe('/interno com rate limit próprio', () => {
  it('não pula o throttler e tem limite por minuto', () => {
    expect(
      Reflect.getMetadata('THROTTLER:SKIPdefault', InternoController),
    ).toBeFalsy();
    expect(
      Reflect.getMetadata('THROTTLER:LIMITdefault', InternoController),
    ).toBeGreaterThan(0);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', InternoController)).toBe(
      60_000,
    );
  });
});

describe('atraso progressivo por conta', () => {
  it('sem atraso até o limiar; depois dobra, com teto', () => {
    expect(atrasoPorFalhas(0)).toBe(0);
    expect(atrasoPorFalhas(9)).toBe(0);
    expect(atrasoPorFalhas(10)).toBe(250);
    expect(atrasoPorFalhas(11)).toBe(500);
    expect(atrasoPorFalhas(13)).toBe(2_000);
    expect(atrasoPorFalhas(100)).toBe(5_000);
  });
});

const describeDb =
  process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;

describeDb('falhas de login de vários IPs na mesma conta (integração)', () => {
  let app: INestApplication;
  let tentativas: TentativasService;
  jest.setTimeout(60_000);

  beforeAll(async () => {
    ({ app } = await criarApp(mailFalso()));
    tentativas = app.get(TentativasService);
  });

  afterAll(() => fecharApp(app));

  it('botnet: cada IP abaixo do limite, a conta ganha atraso (sem 429) e alerta no log', async () => {
    const email = `alvo-${randomUUID()}@exemplo.com`;
    const esperar = jest
      .spyOn(
        tentativas as unknown as { esperar: (ms: number) => Promise<void> },
        'esperar',
      )
      .mockResolvedValue(undefined);
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await tentativas.exigirLoginLiberado('198.51.100.1', email);
    expect(esperar).not.toHaveBeenCalled();

    for (let i = 0; i < 12; i++) {
      await tentativas.registrarFalhaLogin(`203.0.113.${i + 1}`, email);
    }
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/falhas de login/));
    expect(JSON.stringify(warn.mock.calls)).not.toContain(email);

    await expect(
      tentativas.exigirLoginLiberado('198.51.100.1', email),
    ).resolves.toBeUndefined();
    expect(esperar).toHaveBeenCalledWith(1_000);
    // outra conta não é afetada
    esperar.mockClear();
    await tentativas.exigirLoginLiberado('198.51.100.1', `outra-${email}`);
    expect(esperar).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
