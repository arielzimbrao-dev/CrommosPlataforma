const semBarraFinal = (url: string) => url.trim().replace(/\/$/, '');

/** Allowlist de origens a partir de `FRONTEND_URL` (CSV). */
export function origensPermitidas(frontendUrl: string | undefined): string[] {
  return (frontendUrl ?? '').split(',').map(semBarraFinal).filter(Boolean);
}

/**
 * Decide se a origem pode chamar a API com credenciais.
 * - desenvolvimento: libera tudo;
 * - sem `Origin` (curl, healthcheck, server-to-server): libera;
 * - allowlist preenchida: só ela;
 * - allowlist vazia: libera fora de produção, **nunca em produção** (lá
 *   `FRONTEND_URL` também é obrigatória em `env.validation`).
 */
export function corsPermite(
  origin: string | undefined,
  opts: { nodeEnv: string | undefined; permitidas: string[] },
): boolean {
  if (opts.nodeEnv === 'development' || !origin) return true;
  if (opts.permitidas.length === 0) return opts.nodeEnv !== 'production';
  return opts.permitidas.includes(semBarraFinal(origin));
}
