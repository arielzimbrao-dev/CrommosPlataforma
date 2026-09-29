import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { iguaisEmTempoConstante } from '../common/crypto/segredo';

/**
 * TOTP (RFC 6238, o que Google/Microsoft Authenticator usam): HMAC-SHA1,
 * passos de 30 s, 6 dígitos. Aceita o passo anterior e o seguinte (relógio do
 * celular um pouco fora). Sem dependência: `node:crypto` basta.
 */
const PASSO_S = 30;
const DIGITOS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 (RFC 4648, sem `=`): o formato da chave nos apps autenticadores. */
export function base32(buf: Buffer): string {
  let bits = 0;
  let valor = 0;
  let out = '';
  for (const b of buf) {
    valor = ((valor << 8) | b) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(valor << (5 - bits)) & 31];
  return out;
}

/** Segredo novo: 20 bytes aleatórios (160 bits, o tamanho do HMAC-SHA1). */
export const gerarSegredo = (): Buffer => randomBytes(20);

/** Passo de 30 s de um instante (ms). */
export const passoDe = (agoraMs: number): number =>
  Math.floor(agoraMs / 1000 / PASSO_S);

/** Código de 6 dígitos de um passo (RFC 4226, truncamento dinâmico). */
export function codigoTotp(segredo: Buffer, passo: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(passo));
  const h = createHmac('sha1', segredo).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const n = (h.readUInt32BE(o) & 0x7fffffff) % 10 ** DIGITOS;
  return String(n).padStart(DIGITOS, '0');
}

/**
 * Passo em que `codigo` vale (agora, antes ou depois), ou `null`. Quem chama
 * guarda o passo usado e recusa outro igual ou menor (código não se reusa).
 */
export function passoDoCodigo(
  segredo: Buffer,
  codigo: string,
  agoraMs = Date.now(),
): number | null {
  if (!/^\d{6}$/.test(codigo)) return null;
  const p = passoDe(agoraMs);
  for (const d of [0, -1, 1]) {
    if (iguaisEmTempoConstante(codigoTotp(segredo, p + d), codigo))
      return p + d;
  }
  return null;
}

/** Link que o app autenticador entende (tocar no celular abre o app). */
export function otpauthUrl(segredoB32: string, email: string): string {
  const emissor = 'Crommos';
  return `otpauth://totp/${encodeURIComponent(`${emissor}:${email}`)}?secret=${segredoB32}&issuer=${emissor}&algorithm=SHA1&digits=${DIGITOS}&period=${PASSO_S}`;
}

/** Sem 0/O/1/I/L: fácil de copiar à mão. */
const ALFABETO_RECUPERACAO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const QTD_CODIGOS_RECUPERACAO = 10;

/** Códigos de recuperação de uso único (`XXXX-XXXX`), mostrados uma vez. */
export function gerarCodigosRecuperacao(): string[] {
  const um = () =>
    Array.from(
      { length: 8 },
      () => ALFABETO_RECUPERACAO[randomInt(ALFABETO_RECUPERACAO.length)],
    ).join('');
  return Array.from({ length: QTD_CODIGOS_RECUPERACAO }, () => {
    const c = um();
    return `${c.slice(0, 4)}-${c.slice(4)}`;
  });
}

/** Forma canônica para o hash: maiúsculas, sem hífen nem espaço. */
export const normalizarRecuperacao = (codigo: string): string =>
  codigo.toUpperCase().replace(/[\s-]/g, '');
