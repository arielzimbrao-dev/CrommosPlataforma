import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { sha256 } from '../common/crypto/segredo';

const BCRYPT_ROUNDS = 12;
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hora
export const CONVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
const CONFIRMACAO_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias (como o convite)

/** Hash bcrypt inválido: mantém o tempo do login quando o e-mail não existe. */
export const HASH_FALSO = '$2b$12$invalidinvalidinvalidinvalidinv';

/** Hash de senha (signup, redefinição, troca, senha descartável do convite). */
export const hashSenha = (plain: string): Promise<string> =>
  bcrypt.hash(plain, BCRYPT_ROUNDS);

export const conferirSenha = (plain: string, hash: string): Promise<boolean> =>
  bcrypt.compare(plain, hash);

/** Senha aleatória descartável: ninguém entra até definir a própria. */
export const senhaDescartavel = (): Promise<string> =>
  hashSenha(randomBytes(32).toString('hex'));

/** E-mail sempre comparado/gravado em minúsculas e sem espaços. */
export const normalizarEmail = (email: string): string =>
  email.trim().toLowerCase();

/** Compara dois hashes hex em tempo constante. */
export function hashesIguais(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Token de uso único (redefinição de senha e convite): o valor cru vai no link
 * do e-mail; o banco guarda só o SHA-256 e a validade.
 */
export function gerarTokenUsoUnico(ttlMs: number): {
  token: string;
  campos: { passwordResetTokenHash: string; passwordResetExpiresAt: Date };
} {
  const token = randomBytes(32).toString('hex');
  return {
    token,
    campos: {
      passwordResetTokenHash: sha256(token),
      passwordResetExpiresAt: new Date(Date.now() + ttlMs),
    },
  };
}

/** Token do link de confirmação do e-mail: hash + validade a gravar. */
export function gerarConfirmacaoEmail(): {
  token: string;
  campos: { emailConfirmacaoHash: string; emailConfirmacaoExpiraEm: Date };
} {
  const token = randomBytes(32).toString('hex');
  return {
    token,
    campos: {
      emailConfirmacaoHash: sha256(token),
      emailConfirmacaoExpiraEm: new Date(Date.now() + CONFIRMACAO_TTL_MS),
    },
  };
}
