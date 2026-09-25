import { Logger } from '@nestjs/common';

/**
 * Envio de e-mail transacional. Com `SENDPULSE_CLIENT_ID` +
 * `SENDPULSE_CLIENT_SECRET` usa o SendPulse (`SendpulseEmailProvider`); sem
 * elas, o stub que só loga (sem PII). Portado do provider de notificações do
 * Clinic, só com o canal de e-mail.
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
  private readonly logger = new Logger('SendPulse');

  enviarEmail(para: string, _assunto: string, _corpo: string): Promise<void> {
    this.logger.log(`[stub] E-mail enviado para ${mascararEmail(para)}`);
    return Promise.resolve();
  }
}

export interface SendpulseConfig {
  clientId: string;
  clientSecret: string;
  fromEmail?: string;
  fromName?: string;
}

export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const API = 'https://api.sendpulse.com';
const escapar = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Cliente da API REST do SendPulse (OAuth2 client_credentials). Os erros
 * trazem só o status HTTP (nunca o corpo, que pode ecoar o destinatário).
 */
export class SendpulseEmailProvider implements EmailProvider {
  private token: { valor: string; expiraEm: number } | null = null;

  constructor(
    private readonly cfg: SendpulseConfig,
    private readonly http: Fetch = fetch,
    private readonly agora: () => number = Date.now,
  ) {}

  async enviarEmail(para: string, assunto: string, corpo: string) {
    const token = await this.obterToken();
    const res = await this.http(`${API}/smtp/emails`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        email: {
          subject: assunto,
          from: { name: this.cfg.fromName, email: this.cfg.fromEmail },
          to: [{ email: para }],
          text: corpo,
          html: Buffer.from(`<p>${escapar(corpo)}</p>`).toString('base64'),
        },
      }),
    });
    if (!res.ok) throw new Error(`SendPulse email: HTTP ${res.status}`);
  }

  /** Token em memória, renovado 1 min antes de vencer. */
  private async obterToken(): Promise<string> {
    if (this.token && this.agora() < this.token.expiraEm)
      return this.token.valor;
    const res = await this.http(`${API}/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
      }),
    });
    if (!res.ok) throw new Error(`SendPulse auth: HTTP ${res.status}`);
    const r = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.token = {
      valor: r.access_token,
      expiraEm: this.agora() + (r.expires_in - 60) * 1000,
    };
    return this.token.valor;
  }
}

/** Cliente real só com credenciais; sem elas, o stub. */
export function criarEmailProvider(
  env: Record<string, string | undefined> = process.env,
): EmailProvider {
  const clientId = env.SENDPULSE_CLIENT_ID;
  const clientSecret = env.SENDPULSE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return new StubEmailProvider();
  return new SendpulseEmailProvider({
    clientId,
    clientSecret,
    fromEmail: env.SENDPULSE_FROM_EMAIL,
    fromName: env.SENDPULSE_FROM_NAME,
  });
}
