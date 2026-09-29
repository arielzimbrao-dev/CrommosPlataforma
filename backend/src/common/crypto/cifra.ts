import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

/**
 * Cifra de campo em repouso (segredo do 2FA): AES-256-GCM, IV aleatório,
 * `enc:v1:` + base64(iv | tag | ct). Chave derivada (HKDF) da
 * `DATA_ENCRYPTION_KEY` (a da plataforma; a do Clinic é outra). Fail-closed:
 * sem a chave, lança — o 2FA fica indisponível, nada vai em claro.
 */
const PREFIXO = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const IV = 12;
const TAG = 16;

let chave: Buffer | null = null;

function chaveAtual(): Buffer {
  if (chave) return chave;
  const master = process.env.DATA_ENCRYPTION_KEY?.trim();
  if (!master || master.length < 32) {
    throw new Error(
      'DATA_ENCRYPTION_KEY ausente ou curta (>= 32 caracteres, ex.: `openssl rand -hex 32`): obrigatória para o 2FA.',
    );
  }
  chave = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(master, 'utf8'),
      Buffer.from('crommos-plataforma'),
      'field-encryption',
      32,
    ),
  );
  return chave;
}

/** Esquece a chave derivada (testes; lida de novo do ambiente). */
export function recarregarChave(): void {
  chave = null;
}

export function cifrar(valor: string): string {
  const iv = randomBytes(IV);
  const c = createCipheriv(ALGO, chaveAtual(), iv);
  const ct = Buffer.concat([c.update(valor, 'utf8'), c.final()]);
  return PREFIXO + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function decifrar(valor: string): string {
  if (!valor.startsWith(PREFIXO)) throw new Error('Valor sem cifra.');
  const raw = Buffer.from(valor.slice(PREFIXO.length), 'base64');
  if (raw.length < IV + TAG) throw new Error('Conteúdo cifrado inválido.');
  const d = createDecipheriv(ALGO, chaveAtual(), raw.subarray(0, IV), {
    authTagLength: TAG,
  });
  d.setAuthTag(raw.subarray(IV, IV + TAG));
  return Buffer.concat([d.update(raw.subarray(IV + TAG)), d.final()]).toString(
    'utf8',
  );
}
