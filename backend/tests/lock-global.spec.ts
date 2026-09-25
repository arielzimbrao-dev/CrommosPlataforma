import { DataSource } from 'typeorm';
import { comLockGlobal } from 'src/common/lock-global';

function fakeDs(obteve: boolean) {
  const query = jest.fn((sql: string) =>
    Promise.resolve(
      sql.includes('pg_try_advisory_lock') ? [{ ok: obteve }] : [],
    ),
  );
  const qr = { connect: jest.fn(), release: jest.fn(), query };
  const ds = { createQueryRunner: () => qr } as unknown as DataSource;
  return { ds, qr, query };
}

describe('comLockGlobal (jobs com réplicas)', () => {
  it('executa quando obtém o lock e sempre libera', async () => {
    const { ds, qr, query } = fakeDs(true);
    const fn = jest.fn().mockResolvedValue(7);
    await expect(comLockGlobal(ds, 'job', fn)).resolves.toBe(7);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('pg_try_advisory_lock'),
      ['job'],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_unlock'),
      ['job'],
    );
    expect(qr.release).toHaveBeenCalled();
  });

  it('não executa se outra réplica já está com o lock', async () => {
    const { ds, qr, query } = fakeDs(false);
    const fn = jest.fn();
    await expect(comLockGlobal(ds, 'job', fn)).resolves.toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_unlock'),
      expect.anything(),
    );
    expect(qr.release).toHaveBeenCalled();
  });

  it('libera o lock mesmo se o job falhar', async () => {
    const { ds, qr, query } = fakeDs(true);
    await expect(
      comLockGlobal(ds, 'job', () => Promise.reject(new Error('x'))),
    ).rejects.toThrow('x');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_unlock'),
      ['job'],
    );
    expect(qr.release).toHaveBeenCalled();
  });
});
