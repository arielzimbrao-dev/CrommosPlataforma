import * as dotenv from 'dotenv';

/**
 * Carrega `.env.local` (precedência, dev) + `.env`. Único ponto de carga de
 * ambiente do processo; em produção (Coolify) as variáveis vêm do ambiente e
 * usam só os nomes canônicos de `env.validation.ts`.
 */
export function loadEnv(): void {
  dotenv.config({ path: ['.env.local', '.env'] });
}
