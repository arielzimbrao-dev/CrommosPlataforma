import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Cliente HTTP da **AbacatePay** (API v2, https://docs.abacatepay.com): a
 * Crommos recebe as faturas das assinaturas por checkout hospedado (PIX e
 * cartão). Sem `ABACATEPAY_API_KEY` fica inativo (stub: sem link de
 * pagamento, webhook 404) — dev e testes.
 *
 * Fluxo de uma fatura: cliente (único por CPF/CNPJ na AbacatePay) → produto
 * avulso com o valor da fatura → checkout com `externalId` = id da fatura. O
 * webhook só avisa: a baixa confere o checkout na API (status `PAID`).
 */
export interface ConfigAbacatePay {
  apiKey?: string;
  apiUrl: string;
  webhookSecret?: string;
  /** Chave do HMAC-SHA256 do header `X-Webhook-Signature`. */
  hmacKey: string;
}

/** Chave pública do HMAC dos webhooks, publicada na documentação da AbacatePay. */
export const HMAC_PUBLICA_ABACATEPAY =
  't9dXRhHHo3yDEj5pVDYz0frf7q6bMKyMRmxxCPIPp3RCplBfXRxqlC6ZpiWmOqj4L63qEaeUOtrCI8P0VMUgo6iIga2ri9ogaHFs0WIIywSMg0q7RmBfybe1E5XJcfC4IW3alNqym0tXoAKkzvfEjZxV6bE0oG2zJrNNYmUCKZyV0KZ3JS8Votf9EAWWYdiDkMkpbMdPggfh1EqHlVkMiTady6jOR3hyzGEHrIz2Ret0xHKMbiqkr9HS1JhNHDX9';

export function configAbacatePay(
  env: Record<string, string | undefined> = process.env,
): ConfigAbacatePay {
  return {
    apiKey: env.ABACATEPAY_API_KEY || undefined,
    apiUrl: (env.ABACATEPAY_API_URL || 'https://api.abacatepay.com/v2').replace(
      /\/+$/,
      '',
    ),
    webhookSecret: env.ABACATEPAY_WEBHOOK_SECRET || undefined,
    hmacKey: env.ABACATEPAY_HMAC_KEY || HMAC_PUBLICA_ABACATEPAY,
  };
}

/** Confere o `X-Webhook-Signature` (HMAC-SHA256 base64 do corpo cru). */
export function assinaturaWebhookValida(
  corpo: Buffer,
  assinatura: string | undefined,
  chave: string,
): boolean {
  if (!assinatura) return false;
  const esperada = Buffer.from(
    createHmac('sha256', chave).update(corpo).digest('base64'),
  );
  const recebida = Buffer.from(assinatura);
  return (
    esperada.length === recebida.length && timingSafeEqual(esperada, recebida)
  );
}

export type Fetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface ClienteCobranca {
  nome: string;
  email: string;
  documento?: string | null;
}

export interface NovoCheckout {
  faturaId: string;
  valorCentavos: number;
  descricao: string;
  clienteId: string;
  retornoUrl?: string;
}

const TIMEOUT_MS = 15_000;

export class AbacatePayClient {
  constructor(
    private readonly cfg: ConfigAbacatePay = configAbacatePay(),
    private readonly http: Fetch = fetch,
  ) {}

  get ativo(): boolean {
    return !!this.cfg.apiKey;
  }

  get config(): ConfigAbacatePay {
    return this.cfg;
  }

  /** Cliente na AbacatePay (ela devolve o existente para o mesmo CPF/CNPJ). */
  async criarCliente(c: ClienteCobranca): Promise<string> {
    const r = await this.chamar<{ id: string }>('POST', '/customers/create', {
      email: c.email,
      name: c.nome,
      ...(c.documento ? { taxId: c.documento } : {}),
    });
    return r.id;
  }

  /** Produto avulso com o valor da fatura + checkout PIX/cartão. */
  async criarCheckout(n: NovoCheckout): Promise<{ id: string; url: string }> {
    const produto = await this.chamar<{ id: string }>(
      'POST',
      '/products/create',
      {
        externalId: `fatura-${n.faturaId}`,
        name: n.descricao,
        price: n.valorCentavos,
        currency: 'BRL',
      },
    );
    const checkout = await this.chamar<{ id: string; url: string }>(
      'POST',
      '/checkouts/create',
      {
        items: [{ id: produto.id, quantity: 1 }],
        methods: ['PIX', 'CARD'],
        customerId: n.clienteId,
        externalId: n.faturaId,
        ...(n.retornoUrl
          ? { returnUrl: n.retornoUrl, completionUrl: n.retornoUrl }
          : {}),
      },
    );
    return { id: checkout.id, url: checkout.url };
  }

  consultarCheckout(
    id: string,
  ): Promise<{ id: string; status: string; externalId?: string | null }> {
    return this.chamar('GET', `/checkouts/get?id=${encodeURIComponent(id)}`);
  }

  private async chamar<T>(
    metodo: string,
    rota: string,
    corpo?: unknown,
  ): Promise<T> {
    const res = await this.http(`${this.cfg.apiUrl}${rota}`, {
      method: metodo,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Só o status no erro (o corpo pode ecoar dados do cliente).
    if (!res.ok) throw new Error(`AbacatePay ${rota}: HTTP ${res.status}`);
    const r = (await res.json()) as { data?: T } | null;
    if (!r?.data) throw new Error(`AbacatePay ${rota}: resposta sem data`);
    return r.data;
  }
}
