import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac } from 'node:crypto';
import {
  AbacatePayClient,
  assinaturaWebhookValida,
  configAbacatePay,
  HMAC_PUBLICA_ABACATEPAY,
} from 'src/billing/abacatepay.client';
import { CobrancaService } from 'src/billing/cobranca.service';

const hmac = (corpo: string, chave = HMAC_PUBLICA_ABACATEPAY) =>
  createHmac('sha256', chave).update(Buffer.from(corpo)).digest('base64');

describe('AbacatePay — config e assinatura do webhook', () => {
  it('config: padrões e env', () => {
    expect(configAbacatePay({})).toEqual({
      apiKey: undefined,
      apiUrl: 'https://api.abacatepay.com/v2',
      webhookSecret: undefined,
      hmacKey: HMAC_PUBLICA_ABACATEPAY,
    });
    expect(
      configAbacatePay({
        ABACATEPAY_API_KEY: 'k',
        ABACATEPAY_API_URL: 'http://x/v2/',
        ABACATEPAY_HMAC_KEY: 'h',
      }),
    ).toMatchObject({ apiKey: 'k', apiUrl: 'http://x/v2', hmacKey: 'h' });
  });

  it('HMAC-SHA256 base64 do corpo cru; ausente ou errado → false', () => {
    const corpo = '{"event":"checkout.completed"}';
    const buf = Buffer.from(corpo);
    const k = HMAC_PUBLICA_ABACATEPAY;
    expect(assinaturaWebhookValida(buf, hmac(corpo), k)).toBe(true);
    expect(assinaturaWebhookValida(buf, undefined, k)).toBe(false);
    expect(assinaturaWebhookValida(buf, hmac('outro'), k)).toBe(false);
    expect(assinaturaWebhookValida(buf, 'curta', k)).toBe(false);
  });
});

describe('AbacatePayClient', () => {
  const cfg = configAbacatePay({ ABACATEPAY_API_KEY: 'abc_dev' });
  const resposta = (data: unknown, ok = true, status = 200) => ({
    ok,
    status,
    json: () => Promise.resolve(data === undefined ? null : { data }),
  });

  it('cliente, produto avulso e checkout PIX/cartão com o id da fatura', async () => {
    const http = jest
      .fn()
      .mockResolvedValueOnce(resposta({ id: 'cust_1' }))
      .mockResolvedValueOnce(resposta({ id: 'prod_1' }))
      .mockResolvedValueOnce(
        resposta({ id: 'bill_1', url: 'https://pay/bill_1' }),
      );
    const c = new AbacatePayClient(cfg, http);
    expect(c.ativo).toBe(true);
    await expect(
      c.criarCliente({ nome: 'Clínica', email: 'a@b.c', documento: '123' }),
    ).resolves.toBe('cust_1');
    await expect(
      c.criarCheckout({
        faturaId: 'f1',
        valorCentavos: 15000,
        descricao: 'Fatura',
        clienteId: 'cust_1',
        retornoUrl: 'http://app/assinatura',
      }),
    ).resolves.toEqual({ id: 'bill_1', url: 'https://pay/bill_1' });
    const [u1, i1] = http.mock.calls[0] as [string, Record<string, unknown>];
    expect(u1).toBe('https://api.abacatepay.com/v2/customers/create');
    expect(i1.headers).toMatchObject({ Authorization: 'Bearer abc_dev' });
    expect(JSON.parse(http.mock.calls[1][1].body as string)).toEqual({
      externalId: 'fatura-f1',
      name: 'Fatura',
      price: 15000,
      currency: 'BRL',
    });
    expect(JSON.parse(http.mock.calls[2][1].body as string)).toEqual({
      items: [{ id: 'prod_1', quantity: 1 }],
      methods: ['PIX', 'CARD'],
      customerId: 'cust_1',
      externalId: 'f1',
      returnUrl: 'http://app/assinatura',
      completionUrl: 'http://app/assinatura',
    });
  });

  it('consulta o checkout; erro HTTP ou sem data lança só com o status', async () => {
    const http = jest
      .fn()
      .mockResolvedValueOnce(resposta({ id: 'bill_1', status: 'PAID' }))
      .mockResolvedValueOnce(resposta(null, false, 401))
      .mockResolvedValueOnce(resposta(undefined));
    const c = new AbacatePayClient(cfg, http);
    await expect(c.consultarCheckout('bill_1')).resolves.toMatchObject({
      status: 'PAID',
    });
    expect(http.mock.calls[0][0]).toBe(
      'https://api.abacatepay.com/v2/checkouts/get?id=bill_1',
    );
    await expect(c.consultarCheckout('x')).rejects.toThrow('HTTP 401');
    await expect(c.consultarCheckout('x')).rejects.toThrow('sem data');
  });

  it('sem chave: inativo', () => {
    expect(new AbacatePayClient(configAbacatePay({})).ativo).toBe(false);
  });
});

describe('CobrancaService', () => {
  const ATOR = { produto: 'clinic' as const, tenantId: 't1' };
  const SEGREDO = 'segredo-do-webhook-123';
  function make(ativo = true) {
    const fatura = {
      id: '11111111-1111-1111-1111-111111111111',
      tenantId: 't1',
      assinaturaId: 'a1',
      status: 'pendente',
      valorLiquido: 150.5,
      periodoInicio: '2026-09-01',
      periodoFim: '2026-10-01',
      cobrancaUrl: null as string | null,
    };
    const faturas = {
      findOne: jest.fn().mockResolvedValue(fatura),
      findOneOrFail: jest
        .fn()
        .mockResolvedValue({ ...fatura, cobrancaUrl: 'https://pay/1' }),
      update: jest.fn(),
    };
    const assinaturas = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 'a1', tenantId: 't1', clienteId: 'c1' }),
    };
    const clientes = {
      findOne: jest.fn().mockResolvedValue({
        id: 'c1',
        nome: 'Clínica',
        emailCobranca: 'dono@x.com',
        documento: '12345678901',
        abacatepayId: null,
      }),
      update: jest.fn(),
    };
    const assinatura = { baixar: jest.fn() };
    const abacate = {
      ativo,
      config: configAbacatePay({
        ABACATEPAY_API_KEY: 'k',
        ABACATEPAY_WEBHOOK_SECRET: SEGREDO,
      }),
      criarCliente: jest.fn().mockResolvedValue('cust_1'),
      criarCheckout: jest
        .fn()
        .mockResolvedValue({ id: 'bill_1', url: 'https://pay/1' }),
      consultarCheckout: jest.fn(),
    };
    const svc = new CobrancaService(
      faturas as never,
      assinaturas as never,
      clientes as never,
      assinatura as never,
      abacate as never,
    );
    return { svc, fatura, faturas, assinaturas, clientes, assinatura, abacate };
  }

  it('link: cria cliente e checkout (centavos) uma vez e grava na fatura', async () => {
    const { svc, abacate, clientes, faturas } = make();
    expect(svc.pagamentoOnline).toBe(true);
    await expect(svc.linkPagamento(ATOR, 'f', 'http://app')).resolves.toEqual({
      url: 'https://pay/1',
    });
    expect(clientes.update).toHaveBeenCalledWith(
      { id: 'c1' },
      { abacatepayId: 'cust_1' },
    );
    expect(abacate.criarCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ valorCentavos: 15050, clienteId: 'cust_1' }),
    );
    expect(faturas.update.mock.calls[0][1]).toEqual({
      cobrancaId: 'bill_1',
      cobrancaUrl: 'https://pay/1',
    });
  });

  it('link: reaproveita o checkout e o cliente já criados', async () => {
    const { svc, fatura, abacate, clientes } = make();
    fatura.cobrancaUrl = 'https://pay/antigo';
    await expect(svc.linkPagamento(ATOR, 'f')).resolves.toEqual({
      url: 'https://pay/antigo',
    });
    expect(abacate.criarCheckout).not.toHaveBeenCalled();
    fatura.cobrancaUrl = null;
    clientes.findOne.mockResolvedValue({
      id: 'c1',
      nome: 'C',
      emailCobranca: 'a@b.c',
      abacatepayId: 'cust_9',
    });
    await svc.linkPagamento(ATOR, 'f');
    expect(abacate.criarCliente).not.toHaveBeenCalled();
  });

  it('link: 404 sem fatura/assinatura, 409 não pendente ou sem e-mail de cobrança, 503 sem AbacatePay', async () => {
    const m = make();
    m.faturas.findOne.mockResolvedValueOnce(null);
    await expect(m.svc.linkPagamento(ATOR, 'f')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    m.assinaturas.findOne.mockResolvedValueOnce(null);
    await expect(m.svc.linkPagamento(ATOR, 'f')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    m.faturas.findOne.mockResolvedValueOnce({ ...m.fatura, status: 'paga' });
    await expect(m.svc.linkPagamento(ATOR, 'f')).rejects.toBeInstanceOf(
      ConflictException,
    );
    m.clientes.findOne.mockResolvedValueOnce({ id: 'c1' });
    await expect(m.svc.linkPagamento(ATOR, 'f')).rejects.toBeInstanceOf(
      ConflictException,
    );
    const s = make(false);
    await expect(s.svc.linkPagamento(ATOR, 'f')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  describe('webhook', () => {
    const evento = (e: unknown) => JSON.stringify(e);

    it('pago: confere o checkout na API e dá baixa na fatura do checkout', async () => {
      const { svc, abacate, assinatura, faturas, fatura } = make();
      abacate.consultarCheckout.mockResolvedValue({
        id: 'bill_1',
        status: 'PAID',
      });
      const corpo = evento({
        event: 'checkout.completed',
        data: { checkout: { id: 'bill_1' } },
      });
      await expect(
        svc.webhook(Buffer.from(corpo), SEGREDO, hmac(corpo)),
      ).resolves.toEqual({ recebido: true });
      expect(faturas.findOne).toHaveBeenCalledWith({
        where: { cobrancaId: 'bill_1' },
      });
      expect(assinatura.baixar).toHaveBeenCalledWith(
        fatura.id,
        'pagar-abacatepay',
      );
    });

    it('checkout antigo: acha a fatura pelo externalId; sem fatura só loga', async () => {
      const { svc, abacate, assinatura, faturas, fatura } = make();
      abacate.consultarCheckout.mockResolvedValue({
        id: 'bill_0',
        status: 'PAID',
        externalId: fatura.id,
      });
      faturas.findOne.mockResolvedValueOnce(null);
      const corpo = evento({ event: 'billing.paid', data: { id: 'bill_0' } });
      await svc.webhook(Buffer.from(corpo), SEGREDO, hmac(corpo));
      expect(assinatura.baixar).toHaveBeenCalledTimes(1);
      faturas.findOne.mockResolvedValueOnce(null);
      abacate.consultarCheckout.mockResolvedValue({
        id: 'bill_0',
        status: 'PAID',
        externalId: 'nao-uuid',
      });
      await svc.webhook(Buffer.from(corpo), SEGREDO, hmac(corpo));
      expect(assinatura.baixar).toHaveBeenCalledTimes(1);
    });

    it('ignora: outro evento, sem id, checkout não pago', async () => {
      const { svc, abacate, assinatura } = make();
      for (const e of [
        { event: 'checkout.refunded', data: { id: 'x' } },
        { event: 'checkout.completed', data: {} },
        { event: 'checkout.completed' },
      ]) {
        const corpo = evento(e);
        await svc.webhook(Buffer.from(corpo), SEGREDO, hmac(corpo));
      }
      abacate.consultarCheckout.mockResolvedValue({
        id: 'x',
        status: 'PENDING',
      });
      const corpo = evento({ event: 'checkout.completed', data: { id: 'x' } });
      await svc.webhook(Buffer.from(corpo), SEGREDO, hmac(corpo));
      expect(assinatura.baixar).not.toHaveBeenCalled();
    });

    it('401: segredo errado, assinatura errada, sem corpo ou JSON inválido; 404 sem AbacatePay', async () => {
      const { svc } = make();
      const corpo = evento({ event: 'checkout.completed' });
      for (const [b, s, a] of [
        [Buffer.from(corpo), 'errado-errado-errado', hmac(corpo)],
        [Buffer.from(corpo), SEGREDO, hmac('outro')],
        [Buffer.from(corpo), undefined, hmac(corpo)],
        [undefined, SEGREDO, hmac(corpo)],
        [Buffer.from('{x'), SEGREDO, hmac('{x')],
      ] as const) {
        await expect(svc.webhook(b, s, a)).rejects.toBeInstanceOf(
          UnauthorizedException,
        );
      }
      await expect(
        make(false).svc.webhook(Buffer.from(corpo), SEGREDO, hmac(corpo)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
