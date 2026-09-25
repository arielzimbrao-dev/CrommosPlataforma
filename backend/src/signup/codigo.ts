import { randomInt } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { Assinatura } from '../billing/assinatura.entity';

/** Sem 0/O e 1/I: o código é digitado no login. */
export const ALFABETO_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TENTATIVAS = 10;

export function sortearCodigo(): string {
  return Array.from(
    { length: 5 },
    () => ALFABETO_CODIGO[randomInt(ALFABETO_CODIGO.length)],
  ).join('');
}

/**
 * Código curto (5) de tenant livre em `crommos.assinaturas.tenant_codigo`
 * (qualquer produto). Com 32⁵ ≈ 33 mi combinações a colisão é rara; o índice
 * único `uq_assinaturas_tenant_codigo` é a garantia final.
 */
export async function gerarCodigoTenant(
  em: EntityManager,
  sortear: () => string = sortearCodigo,
): Promise<string> {
  for (let i = 0; i < TENTATIVAS; i++) {
    const codigo = sortear();
    if (!(await em.exists(Assinatura, { where: { tenantCodigo: codigo } }))) {
      return codigo;
    }
  }
  throw new Error('Não foi possível gerar o código do tenant.');
}
