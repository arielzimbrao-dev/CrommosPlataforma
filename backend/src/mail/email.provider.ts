import { Logger } from '@nestjs/common';

/**
 * Envio de e-mail transacional. Com `RESEND_API_KEY` usa a API HTTP da
 * Resend (`ResendEmailProvider`); sem ela, o stub que só loga (sem PII).
 */
export interface EmailProvider {
  enviarEmail(para: string, assunto: string, corpo: string): Promise<void>;
}

export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';

/** Mascara o e-mail para o log (LGPD: não logar PII). */
export function mascararEmail(email: string): string {
  const [nome, dominio] = email.split('@');
  return `${nome.slice(0, 1)}***@${dominio ?? '***'}`;
}

/** Stub (dev/CI, sem credenciais): não envia; loga sem PII nem conteúdo. */
export class StubEmailProvider implements EmailProvider {
  private readonly logger = new Logger('Email');

  enviarEmail(para: string, _assunto: string, _corpo: string): Promise<void> {
    this.logger.log(`[stub] E-mail enviado para ${mascararEmail(para)}`);
    return Promise.resolve();
  }
}

export interface ResendConfig {
  apiKey: string;
  /** Remetente (`Nome <email@dominio>`, domínio verificado na Resend). */
  from: string;
}

export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

const API = 'https://api.resend.com/emails';
const REMETENTE_PADRAO = 'Crommos <contato@crommos.com>';
const escapar = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * API HTTP da Resend (`POST /emails`, Bearer). O corpo vai em texto e num HTML
 * mínimo (um `<p>` por parágrafo, escapado). O erro traz só o status HTTP
 * (nunca o corpo, que pode ecoar o destinatário).
 */
export class ResendEmailProvider implements EmailProvider {
  constructor(
    private readonly cfg: ResendConfig,
    private readonly http: Fetch = fetch,
  ) {}

  async enviarEmail(para: string, assunto: string, corpo: string) {
    const html = corpo
      .split(/\n{2,}/)
      .map((p) => `<p>${escapar(p)}</p>`)
      .join('');
    const res = await this.http(API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        from: this.cfg.from,
        to: [para],
        subject: assunto,
        text: corpo,
        html,
      }),
    });
    if (!res.ok) throw new Error(`Resend: HTTP ${res.status}`);
  }
}

/** Cliente real só com a chave; sem ela, o stub. */
export function criarEmailProvider(
  env: Record<string, string | undefined> = process.env,
): EmailProvider {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return new StubEmailProvider();
  return new ResendEmailProvider({
    apiKey,
    from: env.EMAIL_FROM || REMETENTE_PADRAO,
  });
}
