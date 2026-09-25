import { NextFunction, Request, Response } from 'express';
import { basicAuth } from 'src/common/http/basic-auth.middleware';

describe('basicAuth middleware', () => {
  const mw = basicAuth('admin', 's3nha');

  function res(): Response & {
    status: jest.Mock;
    send: jest.Mock;
    setHeader: jest.Mock;
  } {
    const r = {} as Response & {
      status: jest.Mock;
      send: jest.Mock;
      setHeader: jest.Mock;
    };
    r.setHeader = jest.fn();
    r.send = jest.fn();
    r.status = jest.fn().mockReturnValue(r);
    return r;
  }

  const header = (u: string, p: string): string =>
    `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

  it('chama next() com credenciais corretas', () => {
    const next: NextFunction = jest.fn();
    const r = res();
    mw(
      { headers: { authorization: header('admin', 's3nha') } } as Request,
      r,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(r.status).not.toHaveBeenCalled();
  });

  it('responde 401 com WWW-Authenticate quando a senha está errada', () => {
    const next: NextFunction = jest.fn();
    const r = res();
    mw(
      { headers: { authorization: header('admin', 'errada') } } as Request,
      r,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(401);
    expect(r.setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      expect.any(String),
    );
  });

  it('responde 401 quando não há header Authorization', () => {
    const next: NextFunction = jest.fn();
    const r = res();
    mw({ headers: {} } as Request, r, next);

    expect(next).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(401);
  });
});
