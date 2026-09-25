import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RenovacaoCron } from 'src/billing/renovacao.cron';

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

describe('RenovacaoCron', () => {
  afterEach(() => jest.restoreAllMocks());

  it('renova sob o lock global "billing-renovacao" e só loga quando gerou fatura', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const renovarVencidas = jest
      .fn()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(2);
    const { ds, query } = fakeDs(true);
    const cron = new RenovacaoCron({ renovarVencidas } as never, ds);

    await cron.run();
    expect(log).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('pg_try_advisory_lock'),
      ['billing-renovacao'],
    );

    await cron.run();
    expect(log).toHaveBeenCalledWith('Faturas de renovação geradas: 2');
  });

  it('não renova quando outra réplica detém o lock', async () => {
    const renovarVencidas = jest.fn();
    const cron = new RenovacaoCron(
      { renovarVencidas } as never,
      fakeDs(false).ds,
    );
    await cron.run();
    expect(renovarVencidas).not.toHaveBeenCalled();
  });
});
