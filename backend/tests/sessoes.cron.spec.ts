import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SessoesCron } from 'src/auth/sessoes.cron';

function fakeDs(obteve: boolean) {
  const query = jest.fn((sql: string) =>
    Promise.resolve(
      sql.includes('pg_try_advisory_lock') ? [{ ok: obteve }] : [],
    ),
  );
  return {
    ds: {
      createQueryRunner: () => ({
        connect: jest.fn(),
        release: jest.fn(),
        query,
      }),
    } as unknown as DataSource,
    query,
  };
}

describe('SessoesCron', () => {
  afterEach(() => jest.restoreAllMocks());

  it('limpa sob o lock global "plataforma-sessoes-limpeza" e só loga quando removeu algo', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const limparVencidas = jest
      .fn()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(2);
    const purgarRegistrosAcesso = jest
      .fn()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(3);
    const { ds, query } = fakeDs(true);
    const cron = new SessoesCron({ limparVencidas } as never, ds, {
      purgarRegistrosAcesso,
    } as never);

    await cron.run();
    expect(log).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('pg_try_advisory_lock'),
      ['plataforma-sessoes-limpeza'],
    );

    await cron.run();
    expect(log).toHaveBeenCalledWith('Sessões vencidas removidas: 2');
    // A purga dos registros de acesso vai no mesmo job.
    expect(log).toHaveBeenCalledWith('Registros de acesso além da retenção: 3');
  });

  it('não limpa quando outra réplica detém o lock', async () => {
    const limparVencidas = jest.fn();
    const cron = new SessoesCron(
      { limparVencidas } as never,
      fakeDs(false).ds,
      {} as never,
    );
    await cron.run();
    expect(limparVencidas).not.toHaveBeenCalled();
  });
});
