import { CookieOptions, Response } from 'express';

/** Nome do cookie httpOnly que carrega o refresh token. */
export const REFRESH_COOKIE = 'crommos_rt';

const DEFAULT_REFRESH_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

/** Converte '15m'/'7d'/'3600s' em ms; cai no fallback se o formato não casar. */
export function durationToMs(
  value: string | undefined,
  fallbackMs: number,
): number {
  const match = /^(\d+)\s*([smhd])$/.exec((value ?? '').trim());
  if (!match) return fallbackMs;
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  return Number(match[1]) * (unit ?? 0) || fallbackMs;
}

/**
 * Opções base do cookie de refresh. `path: '/auth'` limita o envio às rotas de
 * auth (refresh/logout). Em produção, Secure por padrão. SameSite/domain por env
 * cobrem deploy same-site (Lax) ou cross-site (None).
 * ponytail: SameSite=None exige HTTPS — não combinar COOKIE_SAMESITE=none com
 * COOKIE_SECURE=false, o navegador rejeitaria o cookie.
 */
function baseOptions(): CookieOptions {
  const isProd = process.env.NODE_ENV === 'production';
  const sameSite = (process.env.COOKIE_SAMESITE ?? 'lax') as
    | 'lax'
    | 'strict'
    | 'none';
  return {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE
      ? process.env.COOKIE_SECURE === 'true'
      : isProd,
    sameSite,
    domain: process.env.COOKIE_DOMAIN || undefined,
    path: '/auth',
  };
}

/** Grava o refresh token no cookie httpOnly (com maxAge = TTL do refresh JWT). */
export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    ...baseOptions(),
    maxAge: durationToMs(
      process.env.JWT_REFRESH_EXPIRES_IN,
      DEFAULT_REFRESH_MS,
    ),
  });
}

/** Expira o cookie de refresh. Precisa dos mesmos path/domain do set para valer. */
export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, baseOptions());
}
