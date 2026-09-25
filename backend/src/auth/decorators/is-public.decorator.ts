import { SetMetadata } from '@nestjs/common';

/** Chave de metadado lida pelo JwtAuthGuard. */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Rota **pública**: dispensa o access token (login, refresh, signup, senha,
 * health, API interna — esta com a chave de serviço, e a baixa de fatura).
 */
export const IsPublic = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);
