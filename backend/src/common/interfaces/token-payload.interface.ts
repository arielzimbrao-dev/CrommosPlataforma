import type { Produto } from '../produtos';

export type TipoToken = 'access' | 'refresh';

/**
 * Claims do token da plataforma (docs/contrato.md): `sub` = pessoa
 * (`crommos.usuarios.id`), o produto e o tenant em que ela entrou. Papel e
 * unidades **não** vão no token — o produto lê o vínculo a cada requisição.
 */
export interface ITokenPayload {
  sub: string;
  produto: Produto;
  tenantId: string;
  typ: TipoToken;
  /** Só no refresh: id da sessão (`crommos.sessoes.jti`). */
  jti?: string;
  /**
   * Só no access: família da sessão (`crommos.sessoes.familia`). O
   * access vale enquanto a família tiver sessão vigente. Tokens antigos, sem
   * `sid`, valem até expirar (transição, ≤ 15 min).
   */
  sid?: string;
  /** Emissor (`PLATAFORMA_JWT_ISSUER`, padrão `crommos-plataforma`). */
  iss?: string;
  /** = `produto` (o produto recusa token emitido para outro). */
  aud?: string;
}
