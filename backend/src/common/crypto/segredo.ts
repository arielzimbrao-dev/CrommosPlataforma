import { createHash, timingSafeEqual } from 'node:crypto';

/** SHA-256 hex — determinístico, para guardar/consultar tokens de alta entropia. */
export function sha256(valor: string): string {
  return createHash('sha256').update(valor).digest('hex');
}

/**
 * Compara dois segredos em tempo constante. O hash antes do `timingSafeEqual`
 * iguala os tamanhos (o tamanho do segredo não vaza pelo tempo).
 */
export function iguaisEmTempoConstante(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}
