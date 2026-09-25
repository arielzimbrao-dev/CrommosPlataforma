import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ITokenPayload } from '../../common/interfaces/token-payload.interface';

/** Extrai o usuário autenticado (`request.user`) — exportada para teste direto. */
export const currentUserFactory = (
  _data: unknown,
  ctx: ExecutionContext,
): ITokenPayload =>
  ctx.switchToHttp().getRequest<{ user: ITokenPayload }>().user;

/**
 * Injeta o payload do token (usuário autenticado) no handler, populado pelo
 * JwtAuthGuard/estratégia. Ex.: `logout(@CurrentUser() user: ITokenPayload)`.
 */
export const CurrentUser = createParamDecorator(currentUserFactory);
