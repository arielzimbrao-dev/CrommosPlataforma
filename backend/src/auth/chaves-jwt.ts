import { createPrivateKey, createPublicKey } from 'node:crypto';

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
