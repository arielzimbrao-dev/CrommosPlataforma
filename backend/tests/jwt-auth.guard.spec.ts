import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';

const noop = (): undefined => undefined;

function makeContext(): ExecutionContext {
  return {
    getHandler: () => noop,
    getClass: () => Object,
    switchToHttp: () => ({ getRequest: () => ({}) }),
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  let reflector: Reflector;
  let guard: JwtAuthGuard;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new JwtAuthGuard(reflector);
  });

  it('libera rotas marcadas com @IsPublic sem chamar o passport', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    expect(guard.canActivate(makeContext())).toBe(true);
  });

  it('delega ao passport (super) quando a rota não é pública', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    // AuthGuard('jwt') é a superclasse; mockamos seu canActivate.
    const superProto = Object.getPrototypeOf(JwtAuthGuard.prototype);
    jest.spyOn(superProto, 'canActivate').mockReturnValue(true);
    expect(guard.canActivate(makeContext())).toBe(true);
  });
});
