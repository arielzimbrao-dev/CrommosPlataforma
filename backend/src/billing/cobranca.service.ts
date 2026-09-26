import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { IsNull, Repository } from 'typeorm';
import { iguaisEmTempoConstante } from '../common/crypto/segredo';
import { AbacatePayClient, assinaturaWebhookValida } from './abacatepay.client';
import { Assinatura } from './assinatura.entity';
import { AssinaturaService, Ator } from './assinatura.service';
import { Cliente } from './cliente.entity';
import { Fatura } from './fatura.entity';
import { centavos } from './pro-rata';

/** Eventos da AbacatePay que significam "checkout pago". */
const EVENTOS_PAGO = new Set(['checkout.completed', 'billing.paid']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface EventoWebhook {
  event?: string;
  data?: {
    id?: string;
    externalId?: string;
    checkout?: { id?: string; externalId?: string };
    billing?: { id?: string; externalId?: string };
  };
}

/**
 * Pagamento das faturas pela AbacatePay: link de checkout (PIX/cartão) criado
 * sob demanda e webhook que dá baixa (idempotente) e reativa a clínica. A
 * baixa manual (`POST /plataforma/faturas/:id/pagar`) continua como
 * contingência.
 */
@Injectable()
export class CobrancaService {
  private readonly logger = new Logger(CobrancaService.name);

  constructor(
    @Inject('FATURA_REPOSITORY') private readonly faturas: Repository<Fatura>,
    @Inject('ASSINATURA_REPOSITORY')
    private readonly assinaturas: Repository<Assinatura>,
    @Inject('CLIENTE_REPOSITORY')
    private readonly clientes: Repository<Cliente>,
    private readonly assinatura: AssinaturaService,
    private readonly abacate: AbacatePayClient,
  ) {}

  get pagamentoOnline(): boolean {
    return this.abacate.ativo;
  }

  /** Link de pagamento de uma fatura pendente do tenant (cria o checkout 1 vez). */
  async linkPagamento(
    ator: Pick<Ator, 'produto' | 'tenantId'>,
    faturaId: string,
    retornoUrl?: string,
  ): Promise<{ url: string }> {
    const a = await this.assinaturas.findOne({
      where: { produto: ator.produto, tenantId: ator.tenantId },
    });
    const f = a
      ? await this.faturas.findOne({
          where: { id: faturaId, tenantId: a.tenantId, assinaturaId: a.id },
        })
      : null;
    if (!a || !f) throw new NotFoundException('Fatura não encontrada.');
    if (f.status !== 'pendente') {
      throw new ConflictException('Esta fatura não está pendente.');
    }
    if (f.cobrancaUrl) return { url: f.cobrancaUrl };
    if (!this.abacate.ativo) {
      throw new ServiceUnavailableException(
        'Pagamento online indisponível. Fale com a Crommos.',
      );
    }
    const clienteId = await this.clienteAbacate(a);
    const checkout = await this.abacate.criarCheckout({
      faturaId: f.id,
      valorCentavos: centavos(f.valorLiquido),
      descricao: `Crommos — fatura ${f.periodoInicio} a ${f.periodoFim}`,
      clienteId,
      retornoUrl,
    });
    // Dois cliques ao mesmo tempo: vale o primeiro checkout gravado.
    await this.faturas.update(
      { id: f.id, cobrancaId: IsNull() },
      { cobrancaId: checkout.id, cobrancaUrl: checkout.url },
    );
    const gravada = await this.faturas.findOneOrFail({ where: { id: f.id } });
    return { url: gravada.cobrancaUrl ?? checkout.url };
  }

  /**
   * Webhook: segredo na query (`webhookSecret`) + HMAC do corpo cru. O evento
   * só aponta o checkout: o status `PAID` é conferido na API antes da baixa.
   */
  async webhook(
    corpo: Buffer | undefined,
    segredo: string | undefined,
    assinatura: string | undefined,
  ): Promise<{ recebido: true }> {
    const cfg = this.abacate.config;
    if (!this.abacate.ativo || !cfg.webhookSecret)
      throw new NotFoundException();
    if (
      !corpo ||
      !segredo ||
      !iguaisEmTempoConstante(segredo, cfg.webhookSecret) ||
      !assinaturaWebhookValida(corpo, assinatura, cfg.hmacKey)
    ) {
      throw new UnauthorizedException('Webhook inválido.');
    }
    let evento: EventoWebhook;
    try {
      evento = JSON.parse(corpo.toString('utf8')) as EventoWebhook;
    } catch {
      throw new UnauthorizedException('Webhook inválido.');
    }
    if (!EVENTOS_PAGO.has(evento.event ?? '')) return { recebido: true };
    const d = evento.data ?? {};
    const checkoutId = d.checkout?.id ?? d.billing?.id ?? d.id;
    if (!checkoutId) return { recebido: true };

    const checkout = await this.abacate.consultarCheckout(checkoutId);
    if (checkout.status !== 'PAID') return { recebido: true };
    const porCobranca = await this.faturas.findOne({
      where: { cobrancaId: checkout.id },
    });
    // Checkout antigo (a fatura foi reduzida e ganhou outro): pelo externalId.
    // ponytail: o pago a mais nesse caso não vira crédito; ajuste manual.
    const f =
      porCobranca ??
      (checkout.externalId && UUID.test(checkout.externalId)
        ? await this.faturas.findOne({ where: { id: checkout.externalId } })
        : null);
    if (!f) {
      this.logger.warn(`[abacatepay] checkout pago sem fatura: ${checkout.id}`);
      return { recebido: true };
    }
    await this.assinatura.baixar(f.id, 'pagar-abacatepay');
    return { recebido: true };
  }

  /** Cliente da AbacatePay do pagador (criado e guardado na 1ª cobrança). */
  private async clienteAbacate(a: Assinatura): Promise<string> {
    const c = a.clienteId
      ? await this.clientes.findOne({ where: { id: a.clienteId } })
      : null;
    if (!c?.emailCobranca) {
      throw new ConflictException(
        'Assinatura sem cliente com e-mail de cobrança. Fale com a Crommos.',
      );
    }
    if (c.abacatepayId) return c.abacatepayId;
    const id = await this.abacate.criarCliente({
      nome: c.nome,
      email: c.emailCobranca,
      documento: c.documento,
    });
    await this.clientes.update({ id: c.id }, { abacatepayId: id });
    return id;
  }
}
