import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { JwtModuleOptions, JwtSecretRequestType } from '@nestjs/jwt';
import { PRODUTOS } from '../common/produtos';

/**
 * PEM vindo do ambiente: aceita o valor em várias linhas ou numa linha só com
 * `\n` escapado (formato comum em painéis de variáveis, como o do Coolify).
 * `\\+n`: o Coolify entrega a barra dobrada (`\\n`); o base64 do PEM nunca tem `\`.
 */
export function normalizarPem(valor: string): string {
  return valor.replace(/\\+n/g, '\n').trim();
}

/**
 * Confere o par RS256 da plataforma: a privada e a pública precisam ser RSA
 * válidas e a pública tem de ser a da privada (senão todo token emitido seria
 * recusado pelos produtos). Devolve a mensagem de erro ou `null` se ok.
 */
export function erroNoParDeChaves(
  privada: string,
  publica: string,
): string | null {
  try {
    const priv = createPrivateKey(normalizarPem(privada));
    const pub = createPublicKey(normalizarPem(publica));
    if (priv.asymmetricKeyType !== 'rsa' || pub.asymmetricKeyType !== 'rsa') {
      return 'As chaves JWT da plataforma devem ser RSA (RS256).';
    }
    const derivada = createPublicKey(priv).export({
      type: 'spki',
      format: 'pem',
    });
    if (derivada !== pub.export({ type: 'spki', format: 'pem' })) {
      return 'PLATAFORMA_JWT_PUBLIC_KEY não corresponde à PLATAFORMA_JWT_PRIVATE_KEY.';
    }
    return null;
  } catch {
    return 'PLATAFORMA_JWT_PRIVATE_KEY/PLATAFORMA_JWT_PUBLIC_KEY não são PEM válidos.';
  }
}

/** `iss` dos tokens quando `PLATAFORMA_JWT_ISSUER` não está definida. */
export const EMISSOR_PADRAO = 'crommos-plataforma';

/**
 * `kid` = thumbprint RFC 7638 (SHA-256, base64url) da chave pública: plataforma
 * e produtos derivam do mesmo PEM, sem nada a configurar nem a errar.
 */
export function kidDaChave(publica: string): string {
  const { e, kty, n } = createPublicKey(normalizarPem(publica)).export({
    format: 'jwk',
  });
  return createHash('sha256')
    .update(JSON.stringify({ e, kty, n }))
    .digest('base64url');
}

/** `kid` do cabeçalho de um JWT (sem verificar nada), ou `undefined`. */
export function kidDoToken(token: string): string | undefined {
  try {
    const { kid } = JSON.parse(
      Buffer.from(token.split('.')[0], 'base64url').toString(),
    ) as { kid?: unknown };
    return typeof kid === 'string' ? kid : undefined;
  } catch {
    return undefined;
  }
}

export interface ChavesJwt {
  privada: string;
  /** `kid` da chave atual (a que assina). */
  kid: string;
  emissor: string;
  /** `kid` → pública PEM: a atual e, durante a troca, a anterior. */
  publicas: Map<string, string>;
}

/**
 * Chaves do ambiente. Assina com a ATUAL; verifica a atual e a
 * `PLATAFORMA_JWT_PUBLIC_KEY_ANTERIOR` (rotação: refresh de 7 dias emitidos
 * antes da troca continuam valendo até ela sair do ambiente).
 */
export function chavesJwt(
  config: Pick<ConfigService, 'get' | 'getOrThrow'>,
): ChavesJwt {
  const atual = normalizarPem(
    config.getOrThrow<string>('PLATAFORMA_JWT_PUBLIC_KEY'),
  );
  const anterior = config.get<string>('PLATAFORMA_JWT_PUBLIC_KEY_ANTERIOR');
  const publicas = new Map([[kidDaChave(atual), atual]]);
  if (anterior) publicas.set(kidDaChave(anterior), normalizarPem(anterior));
  return {
    privada: normalizarPem(
      config.getOrThrow<string>('PLATAFORMA_JWT_PRIVATE_KEY'),
    ),
    kid: kidDaChave(atual),
    emissor: config.get<string>('PLATAFORMA_JWT_ISSUER') || EMISSOR_PADRAO,
    publicas,
  };
}

/** Pública que verifica o token, escolhida pela `kid`; sem `kid` ou desconhecida → `undefined`. */
export const chaveDoToken = (c: ChavesJwt, token: string) =>
  c.publicas.get(kidDoToken(token) ?? '');

/**
 * `JwtModule`: assina com `iss` e `kid` (o `aud` = produto vai em cada
 * emissão) e verifica `iss`, `aud` ∈ produtos e a chave pela `kid`.
 */
export function opcoesJwt(c: ChavesJwt): JwtModuleOptions {
  return {
    secretOrKeyProvider: (tipo, token) => {
      if (tipo === JwtSecretRequestType.SIGN) return c.privada;
      // Rejeição (não `throw`): o `verifyAsync` vira promessa rejeitada.
      return (
        chaveDoToken(c, token as string) ??
        Promise.reject(new Error('Token sem kid ou com kid desconhecida.'))
      );
    },
    signOptions: { algorithm: 'RS256', issuer: c.emissor, keyid: c.kid },
    verifyOptions: {
      algorithms: ['RS256'],
      issuer: c.emissor,
      audience: [...PRODUTOS],
    },
  };
}

/** Confere a pública anterior (rotação). Devolve a mensagem de erro ou `null`. */
export function erroNaChaveAnterior(
  anterior: string | undefined,
  atual: string,
): string | null {
  if (!anterior) return null;
  try {
    if (createPublicKey(normalizarPem(anterior)).asymmetricKeyType !== 'rsa') {
      return 'PLATAFORMA_JWT_PUBLIC_KEY_ANTERIOR deve ser RSA (RS256).';
    }
    return kidDaChave(anterior) === kidDaChave(atual)
      ? 'PLATAFORMA_JWT_PUBLIC_KEY_ANTERIOR é igual à atual: remova-a ou troque a atual.'
      : null;
  } catch {
    return 'PLATAFORMA_JWT_PUBLIC_KEY_ANTERIOR não é uma chave pública PEM válida.';
  }
}
