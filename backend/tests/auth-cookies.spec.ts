import type { Response } from 'express';
import {
  clearRefreshCookie,
  durationToMs,
  REFRESH_COOKIE,
  setRefreshCookie,
} from 'src/auth/auth-cookies';

describe('auth-cookies', () => {
  const OLD_ENV = process.env;
  afterEach(() => {
    process.env = OLD_ENV;
  });

  describe('durationToMs', () => {
    it.each([
      ['15m', 15 * 60_000],
      ['7d', 7 * 86_400_000],
      ['30s', 30_000],
      ['2h', 2 * 3_600_000],
    ])('converte %s', (input, expected) => {
      expect(durationToMs(input, 999)).toBe(expected);
    });

    it('usa o fallback em formato inválido ou ausente', () => {
      expect(durationToMs('abc', 111)).toBe(111);
      expect(durationToMs(undefined, 222)).toBe(222);
    });
  });

  it('setRefreshCookie grava httpOnly com maxAge do TTL do refresh', () => {
    process.env = {
      ...OLD_ENV,
      JWT_REFRESH_EXPIRES_IN: '7d',
      NODE_ENV: 'test',
    };
    const cookie = jest.fn();
    setRefreshCookie({ cookie } as unknown as Response, 'tok');

    expect(cookie).toHaveBeenCalledWith(
      REFRESH_COOKIE,
      'tok',
      expect.objectContaining({
        httpOnly: true,
        path: '/auth',
        maxAge: 7 * 86_400_000,
        secure: false, // NODE_ENV != production e sem COOKIE_SECURE
      }),
    );
  });

  it('em produção o cookie é Secure por padrão', () => {
    process.env = { ...OLD_ENV, NODE_ENV: 'production' };
    const cookie = jest.fn();
    setRefreshCookie({ cookie } as unknown as Response, 'tok');
    expect(cookie).toHaveBeenCalledWith(
      REFRESH_COOKIE,
      'tok',
      expect.objectContaining({ secure: true }),
    );
  });

  it('clearRefreshCookie expira o cookie com o mesmo path', () => {
    const clearCookie = jest.fn();
    clearRefreshCookie({ clearCookie } as unknown as Response);
    expect(clearCookie).toHaveBeenCalledWith(
      REFRESH_COOKIE,
      expect.objectContaining({ path: '/auth', httpOnly: true }),
    );
  });
});
