import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DataSource,
  EntityManager,
  LessThan,
  LessThanOrEqual,
  Repository,
} from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { Acesso } from '../auth/acesso.entity';
import { hojeISO } from '../common/data-brasil';
import { PaginacaoDto, paginar } from '../common/paginacao';
import type { Produto } from '../common/produtos';
import { Assinatura } from './assinatura.entity';
import { SimularDto, UpdateAssinaturaDto } from './dtos/billing.dtos';
import { Fatura } from './fatura.entity';
import {
  Assentos,
  FAIXAS,
  Faixa,
  ItemAssinatura,
  MODULES,
  MODULE_CODES,
  ModuleCode,
  PessoaAcesso,
  PlanoPeriodo,
  ajusteVirada,
  calcularValor,
  contarAssentos,
  faixaDe,
  itensDe,
} from './modules.catalog';
import {
  AjusteProRata,
  DIAS_TRIAL,
  abaterReducao,
  aplicarCredito,
  calcularProRata,
  centavos,
  emTrial,
  renovarCiclo,
  somarDias,
} from './pro-rata';
import {
  MotivoLeitura,
  bloqueiaEm,
  diasTolerancia,
  motivoLeitura,
  trialExpirado,
} from './situacao';

/** Quem está agindo sobre a assinatura (das claims do token). */
export interface Ator {
  usuarioId: string;
  produto: Produto;
  tenantId: string;
}

export interface AssinaturaView {
  modulosAtivos: ModuleCode[];
  /** Pessoas com acesso ativo (convites inclusos): define a faixa. */
  numeroUsuarios: number;
  plano: PlanoPeriodo;
  /** R$/mês (fórmula de docs/03-precificacao.md). */
  valor: number;
  /** QA-157: ajuste da virada de faixa (R$/mês, antes do plano); 0 = nenhum. */
  ajusteFaixa: number;
  catalogo: typeof MODULES;
  /** Assentos (pessoas com acesso) e preço na faixa de cada módulo. */
  itens: ItemAssinatura[];
  faixa: Faixa;
  faixas: typeof FAIXAS;
  ciclo: { inicio: string; fim: string } | null;
  emTrialAte: string | null;
  emTrial: boolean;
  saldoCredito: number;
  /** O admin já confirmou módulos/usuários (fim do trial). */
  trialConfirmado: boolean;
  /** `null` = normal; senão o motivo do modo leitura. */
  modoLeitura: MotivoLeitura | null;
  /** Fatura pendente mais antiga já vencida (aviso), ou `null`. */
  faturaVencida: FaturaVencida | null;
}

export interface FaturaVencida {
  id: string;
  vencimento: string;
  valorLiquido: number;
  /** Dia em que a clínica entra em modo leitura se não pagar. */
  bloqueiaEm: string;
}

/** Fatura `ciclo` que a confirmação do trial vai gerar (QA-006). */
export interface PrimeiraFatura {
  valorLiquido: number;
  periodoInicio: string;
  periodoFim: string;
  vencimento: string;
}

/** Situação para todos os papéis (banner do produto, `GET /modulos`). */
export interface SituacaoAssinatura {
  modoLeitura: MotivoLeitura | null;
  emTrialAte: string | null;
  trialConfirmado: boolean;
  faturaVencida: Pick<FaturaVencida, 'vencimento' | 'bloqueiaEm'> | null;
}

export interface AlteracaoAssinatura extends AssinaturaView {
  /** Pró-rata da mudança (null quando a assinatura acabou de ser criada). */
  ajuste: AjusteProRata | null;
  /** Fatura gerada (complementar, ou a do 1º ciclo na criação). */
  fatura: Fatura | null;
}

export interface NovoTrial {
  tenantId: string;
  produto: Produto;
  clienteId: string;
  tenantNome: string;
  tenantCodigo: string;
}

/**
 * Assentos do tenant, derivados dos acessos **ativos** (convite pendente
 * incluso: a pessoa já foi chamada) — `mais` simula pessoas a mais e `menos`
 * uma a menos (desativar ou trocar o papel).
 */
export async function assentosDoTenant(
  em: EntityManager,
  produto: Produto,
  tenantId: string,
  mais: PessoaAcesso[] = [],
  menos?: PessoaAcesso,
): Promise<Assentos> {
  const pessoas = await em.getRepository(Acesso).find({
    where: { produto, tenantId, ativo: true },
    select: { id: true, papel: true, clinico: true },
  });
  // Uma pessoa a menos do papel, de preferência com o mesmo vínculo clínico.
  const mesmoPapel = pessoas.filter((p) => p.papel === menos?.papel);
  const sai =
    mesmoPapel.find((p) => p.clinico === menos?.clinico) ?? mesmoPapel[0];
  return contarAssentos([...pessoas.filter((p) => p !== sai), ...mais]);
}

/**
 * Assinatura do tenant: gating de módulos, mudança com pró-rata, faturas e
 * renovação do ciclo — portado do Clinic (docs/billing-pro-rata.md de lá).
 * Fatura pendente **não bloqueia** o acesso; a baixa é do backoffice
 * (`pagarPelaPlataforma`) até o webhook da AbacatePay.
 */
@Injectable()
export class AssinaturaService {
  constructor(
    @Inject('ASSINATURA_REPOSITORY')
    private readonly repo: Repository<Assinatura>,
    @Inject('FATURA_REPOSITORY')
    private readonly faturas: Repository<Fatura>,
    @Inject('DATA_SOURCE') private readonly ds: DataSource,
    private readonly audit: AuditService,
  ) {}

  /**
   * Assinatura em **trial** (signup): todos os módulos, sem limite de pessoas
   * (a equipe testa junto — QA-009), mensal; o
   * ciclo do trial vai de hoje a hoje + `dias` e a renovação abre o 1º ciclo
   * pago. Recebe o `EntityManager` da transação do signup.
   */
  static iniciarTrial(
    em: EntityManager,
    t: NovoTrial,
    dias = DIAS_TRIAL,
    hoje = hojeISO(),
  ): Promise<Assinatura> {
    const repo = em.getRepository(Assinatura);
    const fim = somarDias(hoje, dias);
    return repo.save(
      repo.create({
        ...t,
        modulosAtivos: [...MODULE_CODES],
        plano: PlanoPeriodo.Mensal,
        cicloInicio: hoje,
        cicloFim: fim,
        emTrialAte: fim,
        saldoCredito: 0,
      }),
    );
  }

  private buscar(ator: Pick<Ator, 'produto' | 'tenantId'>) {
    return this.repo.findOne({
      where: { produto: ator.produto, tenantId: ator.tenantId },
    });
  }

  private assentos(
    ator: Pick<Ator, 'produto' | 'tenantId'>,
    mais?: PessoaAcesso[],
    menos?: PessoaAcesso,
  ) {
    return assentosDoTenant(
      this.ds.manager,
      ator.produto,
      ator.tenantId,
      mais,
      menos,
    );
  }

  async getCurrent(ator: Ator, hoje = hojeISO()): Promise<AssinaturaView> {
    const [a, assentos] = await Promise.all([
      this.buscar(ator),
      this.assentos(ator),
    ]);
    if (a)
      return this.view(a, assentos, hoje, await this.faturaVencida(a, hoje));
    // Sem assinatura: fail-closed (nenhum módulo), como no gating (B5).
    return {
      ...this.valores([], assentos, PlanoPeriodo.Mensal),
      ciclo: null,
      emTrialAte: null,
      emTrial: false,
      saldoCredito: 0,
      trialConfirmado: false,
      modoLeitura: null,
      faturaVencida: null,
    };
  }

  /** Situação (modo leitura e aviso de fatura) para qualquer papel. */
  async situacao(
    ator: Pick<Ator, 'produto' | 'tenantId'>,
    hoje = hojeISO(),
  ): Promise<SituacaoAssinatura> {
    const a = await this.buscar(ator);
    if (!a) {
      return {
        modoLeitura: null,
        emTrialAte: null,
        trialConfirmado: false,
        faturaVencida: null,
      };
    }
    const f = await this.faturaVencida(a, hoje);
    return {
      modoLeitura: motivoLeitura(a, hoje),
      emTrialAte: a.emTrialAte,
      trialConfirmado: !!a.trialConfirmadoEm,
      faturaVencida: f && {
        vencimento: f.vencimento,
        bloqueiaEm: f.bloqueiaEm,
      },
    };
  }

  private async faturaVencida(
    a: Assinatura,
    hoje: string,
  ): Promise<FaturaVencida | null> {
    const f = await this.faturas.findOne({
      where: {
        tenantId: a.tenantId,
        assinaturaId: a.id,
        status: 'pendente',
        // QA-005: vencendo hoje ainda não venceu (só a partir de amanhã).
        vencimento: LessThan(hoje),
      },
      order: { vencimento: 'ASC' },
    });
    return f
      ? {
          id: f.id,
          vencimento: f.vencimento,
          valorLiquido: f.valorLiquido,
          bloqueiaEm: bloqueiaEm(f.vencimento),
        }
      : null;
  }

  /**
   * Valor da configuração simulada + o pró-rata que a mudança geraria hoje.
   * Numa redução, `reducao` diz quanto abate das faturas pendentes do ciclo e
   * quanto vira crédito — mesma regra do `upsert`. `adicionar` simula uma
   * pessoa a mais (convite/ativação); `valorAtual` é o de hoje.
   */
  async simular(
    ator: Ator,
    dto: SimularDto,
    hoje = hojeISO(),
  ): Promise<{
    valor: number;
    /** QA-157: ajuste da virada de faixa (R$/mês, antes do plano). */
    ajusteFaixa: number;
    valorAtual: number;
    numeroUsuarios: number;
    itens: ItemAssinatura[];
    faixa: Faixa;
    ajuste: AjusteProRata | null;
    reducao: { abatidoEmPendentes: number; credito: number } | null;
    primeiraFatura: PrimeiraFatura | null;
  }> {
    const [a, atuais] = await Promise.all([
      this.buscar(ator),
      this.assentos(ator),
    ]);
    const pessoa = (p: { papel: string; clinico?: boolean }) => ({
      papel: p.papel,
      clinico: !!p.clinico,
    });
    const assentos =
      dto.adicionar || dto.remover
        ? await this.assentos(
            ator,
            dto.adicionar ? [pessoa(dto.adicionar)] : [],
            dto.remover && pessoa(dto.remover),
          )
        : atuais;
    const valor = calcularValor(dto.modulos, assentos, dto.plano);
    const base = {
      valor,
      ajusteFaixa: ajusteVirada(dto.modulos, assentos),
      valorAtual: a ? calcularValor(a.modulosAtivos, atuais, a.plano) : 0,
      numeroUsuarios: assentos.pessoas,
      itens: itensDe(assentos),
      faixa: faixaDe(assentos.pessoas),
    };
    const ajuste = a ? this.proRata(a, atuais, valor, hoje) : null;
    const primeiraFatura = this.primeiraFatura(a, valor, dto.plano, hoje);
    if (!a || ajuste?.tipo !== 'credito') {
      return { ...base, ajuste, reducao: null, primeiraFatura };
    }
    const pendentes = await this.faturas.find({
      where: {
        tenantId: a.tenantId,
        assinaturaId: a.id,
        periodoFim: a.cicloFim,
        status: 'pendente',
      },
      order: { createdAt: 'DESC' },
    });
    const r = abaterReducao(ajuste.valor, pendentes);
    const abatido = r.faturas.reduce((s, f) => s + centavos(f.abatido), 0);
    return {
      ...base,
      ajuste,
      reducao: { abatidoEmPendentes: abatido / 100, credito: r.credito },
      primeiraFatura,
    };
  }

  /**
   * QA-006: a fatura `ciclo` que a confirmação vai gerar — já (sem assinatura
   * ou trial vencido: 1º ciclo a partir de hoje, como o `upsert`) ou no fim do
   * trial ativo (renovação). Fora do trial, `null`. Vence no 1º dia do ciclo,
   * como toda fatura de ciclo.
   */
  private primeiraFatura(
    a: Assinatura | null,
    valorMensal: number,
    plano: PlanoPeriodo,
    hoje: string,
  ): PrimeiraFatura | null {
    const agora = !a || (trialExpirado(a, hoje) && a.cicloFim <= hoje);
    if (!agora && !emTrial(a.emTrialAte, hoje)) return null;
    const c = renovarCiclo({
      cicloFim: agora ? hoje : a.cicloFim,
      plano,
      valorMensal,
      saldoCredito: a?.saldoCredito ?? 0,
    });
    return {
      valorLiquido: c.valorLiquido,
      periodoInicio: c.cicloInicio,
      periodoFim: c.cicloFim,
      vencimento: c.cicloInicio,
    };
  }

  /**
   * Altera módulos/plano numa transação com a linha travada (a mesma trava
   * dos acessos): upgrade → fatura complementar (abatendo crédito); redução →
   * abate as faturas pendentes do ciclo e só o excedente vira crédito. Sem
   * assinatura, cria e fatura o 1º ciclo. Os assentos vêm dos acessos.
   */
  async upsert(
    ator: Ator,
    dto: UpdateAssinaturaDto,
    hoje = hojeISO(),
  ): Promise<AlteracaoAssinatura> {
    const { tenantId, produto, usuarioId } = ator;
    const r = await this.ds.transaction(async (em) => {
      const assinaturas = em.getRepository(Assinatura);
      const atual = await assinaturas.findOne({
        where: { tenantId, produto },
        lock: { mode: 'pessimistic_write' },
      });
      // Merge explícito: campos ausentes chegam como `undefined` no DTO.
      const modulosAtivos = dto.modulosAtivos ?? atual?.modulosAtivos ?? [];
      const plano = dto.plano ?? atual?.plano ?? PlanoPeriodo.Mensal;
      const assentos = await assentosDoTenant(em, produto, tenantId);
      const valorNovo = calcularValor(modulosAtivos, assentos, plano);
      const numeroUsuarios = assentos.pessoas;

      if (!atual) {
        const ciclo = renovarCiclo({
          cicloFim: hoje,
          plano,
          valorMensal: valorNovo,
          saldoCredito: 0,
        });
        const a = await assinaturas.save(
          assinaturas.create({
            tenantId,
            produto,
            modulosAtivos,
            numeroUsuarios,
            plano,
            cicloInicio: ciclo.cicloInicio,
            cicloFim: ciclo.cicloFim,
            emTrialAte: null,
            saldoCredito: 0,
            createdBy: usuarioId,
            updatedBy: usuarioId,
          }),
        );
        const fatura = await this.gravarFatura(em, a, {
          tipo: 'ciclo',
          periodoInicio: ciclo.cicloInicio,
          periodoFim: ciclo.cicloFim,
          valorBruto: ciclo.valorBruto,
          creditoAplicado: 0,
          valorLiquido: ciclo.valorLiquido,
          vencimento: hoje,
          itens: { motivo: 'criacao', modulosAtivos, numeroUsuarios, plano },
          createdBy: usuarioId,
        });
        return { a, ajuste: null, fatura, abatidas: [] as Fatura[] };
      }

      // Fim do trial: salvar a assinatura = o admin confirmou módulos/usuários.
      // Trial já expirado (modo leitura, nada faturado): abre o 1º ciclo pago
      // hoje, com a configuração escolhida.
      const expirado = trialExpirado(atual, hoje) && atual.cicloFim <= hoje;
      if (atual.emTrialAte && !atual.trialConfirmadoEm) {
        atual.trialConfirmadoEm = new Date();
      }
      const ajuste = this.proRata(atual, assentos, valorNovo, hoje);
      atual.modulosAtivos = modulosAtivos;
      atual.numeroUsuarios = numeroUsuarios;
      atual.plano = plano;
      atual.updatedBy = usuarioId;
      let fatura: Fatura | null = null;
      let abatidas: Fatura[] = [];
      if (expirado) {
        const ciclo = renovarCiclo({
          cicloFim: hoje,
          plano,
          valorMensal: valorNovo,
          saldoCredito: atual.saldoCredito,
        });
        atual.cicloInicio = ciclo.cicloInicio;
        atual.cicloFim = ciclo.cicloFim;
        atual.saldoCredito = ciclo.saldoCredito;
        fatura = await this.gravarFatura(em, atual, {
          tipo: 'ciclo',
          periodoInicio: ciclo.cicloInicio,
          periodoFim: ciclo.cicloFim,
          valorBruto: ciclo.valorBruto,
          creditoAplicado: ciclo.creditoAplicado,
          valorLiquido: ciclo.valorLiquido,
          vencimento: hoje,
          itens: { motivo: 'fim-trial', modulosAtivos, numeroUsuarios, plano },
          createdBy: usuarioId,
        });
      } else {
        const r = await this.aplicarAjuste(em, atual, ajuste, hoje, usuarioId, {
          modulosAtivos,
          numeroUsuarios,
          plano,
        });
        fatura = r.fatura;
        abatidas = r.abatidas;
      }
      const a = await assinaturas.save(atual);
      return { a, ajuste, fatura, abatidas };
    });

    // A redução pode ter quitado/cancelado pendentes: situação na hora.
    if (r.abatidas.length) await this.atualizarInadimplencia(hoje, tenantId);
    await this.log(ator, 'update', 'assinatura', r.a.id);
    if (r.fatura) await this.log(ator, 'create', 'fatura', r.fatura.id);
    for (const f of r.abatidas) {
      await this.log(
        ator,
        f.status === 'cancelada' ? 'cancelar' : 'reduzir',
        'fatura',
        f.id,
      );
    }
    return {
      ...this.view(
        r.a,
        await this.assentos(ator),
        hoje,
        await this.faturaVencida(r.a, hoje),
      ),
      ajuste: r.ajuste,
      fatura: r.fatura,
    };
  }

  /**
   * Pró-rata de um mid-ciclo já decidido: complementar (abatendo o crédito)
   * ou redução (abate as pendentes do ciclo; o excedente vira crédito).
   * Altera `a` (saldo) sem salvar.
   */
  private async aplicarAjuste(
    em: EntityManager,
    a: Assinatura,
    ajuste: AjusteProRata,
    hoje: string,
    usuarioId: string | undefined,
    itens: Record<string, unknown>,
  ): Promise<{ fatura: Fatura | null; abatidas: Fatura[] }> {
    if (ajuste.tipo === 'credito') {
      const credito = await this.abaterPendentes(
        em,
        a,
        ajuste.valor,
        hoje,
        usuarioId,
      );
      a.saldoCredito =
        (centavos(a.saldoCredito) + centavos(credito.valor)) / 100;
      return { fatura: null, abatidas: credito.abatidas };
    }
    if (ajuste.tipo !== 'complementar') return { fatura: null, abatidas: [] };
    const c = aplicarCredito(ajuste.valor, a.saldoCredito);
    a.saldoCredito = c.saldoRestante;
    const fatura = await this.gravarFatura(em, a, {
      tipo: 'complementar',
      periodoInicio: hoje,
      periodoFim: a.cicloFim,
      valorBruto: ajuste.valor,
      creditoAplicado: c.creditoAplicado,
      valorLiquido: c.valorLiquido,
      vencimento: hoje,
      itens: { motivo: 'pro-rata', ajuste, ...itens },
      createdBy: usuarioId,
    });
    return { fatura, abatidas: [] };
  }

  /**
   * Acesso criado/alterado/removido (API interna): trava a assinatura, grava
   * e cobra a diferença de assentos no pró-rata (complementar ou crédito),
   * como uma mudança de módulos. Sem assinatura (legado): só grava.
   */
  async comReprecificacao<R>(
    produto: Produto,
    tenantId: string,
    gravar: (em: EntityManager) => Promise<R>,
    hoje = hojeISO(),
  ): Promise<R> {
    const r = await this.ds.transaction(async (em) => {
      const assinaturas = em.getRepository(Assinatura);
      const a = await assinaturas.findOne({
        where: { produto, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!a) return { valor: await gravar(em), fatura: null, abatidas: [] };
      const antes = await assentosDoTenant(em, produto, tenantId);
      const valor = await gravar(em);
      const depois = await assentosDoTenant(em, produto, tenantId);
      const ajuste = calcularProRata({
        cicloInicio: a.cicloInicio,
        cicloFim: a.cicloFim,
        emTrialAte: a.emTrialAte,
        hoje,
        valorMensalAnterior: calcularValor(a.modulosAtivos, antes, a.plano),
        valorMensalNovo: calcularValor(a.modulosAtivos, depois, a.plano),
      });
      const aj = await this.aplicarAjuste(em, a, ajuste, hoje, undefined, {
        motivo: 'assentos',
        modulosAtivos: a.modulosAtivos,
        numeroUsuarios: depois.pessoas,
        assentos: depois.porModulo,
        plano: a.plano,
      });
      a.numeroUsuarios = depois.pessoas;
      await assinaturas.save(a);
      return { valor, ...aj };
    });
    if (r.abatidas.length) await this.atualizarInadimplencia(hoje, tenantId);
    // Ator = o produto (serviço), como a auditoria dos acessos.
    const auditar = (action: string, id: string) =>
      this.audit.registrar({
        produto,
        tenantId,
        action,
        resource: 'fatura',
        resourceId: id,
      });
    if (r.fatura) await auditar('create', r.fatura.id);
    for (const f of r.abatidas) {
      await auditar(f.status === 'cancelada' ? 'cancelar' : 'reduzir', f.id);
    }
    return r.valor;
  }

  /**
   * Módulos ativos (gating). Sem assinatura (ausente ou removida) → nenhum:
   * fail-closed (B5).
   */
  async getModulosAtivos(
    ator: Pick<Ator, 'produto' | 'tenantId'>,
  ): Promise<ModuleCode[]> {
    const a = await this.buscar(ator);
    return a ? a.modulosAtivos : [];
  }

  async listarFaturas(
    ator: Pick<Ator, 'produto' | 'tenantId'>,
    q: PaginacaoDto,
  ): Promise<{ data: Fatura[]; total: number }> {
    const a = await this.buscar(ator);
    if (!a) return { data: [], total: 0 };
    const [data, total] = await this.faturas.findAndCount({
      where: { tenantId: a.tenantId, assinaturaId: a.id },
      order: { createdAt: 'DESC' },
      ...paginar(q),
    });
    return { data, total };
  }

  /**
   * Baixa manual pelo backoffice da Crommos (`X-Plataforma-Key`): contingência
   * do webhook da AbacatePay. 409 se não estiver pendente.
   */
  async pagarPelaPlataforma(id: string): Promise<Fatura> {
    const { fatura, baixou } = await this.baixar(id, 'pagar-plataforma');
    if (!baixou) {
      throw new ConflictException('Só é possível pagar uma fatura pendente.');
    }
    return fatura;
  }

  /**
   * Baixa idempotente (backoffice ou webhook): o UPDATE condicional evita
   * baixa dupla e corrida com a redução (que trava a linha). Reativa a clínica
   * na hora se ela estava em modo leitura por inadimplência.
   */
  async baixar(
    id: string,
    action: 'pagar-plataforma' | 'pagar-abacatepay',
    hoje = hojeISO(),
  ): Promise<{ fatura: Fatura; baixou: boolean }> {
    const r = await this.faturas.update(
      { id, status: 'pendente' },
      { status: 'paga', pagoEm: new Date() },
    );
    const f = await this.faturas.findOne({ where: { id } });
    if (!f) throw new NotFoundException('Fatura não encontrada.');
    if (!r.affected) return { fatura: f, baixou: false };
    await this.atualizarInadimplencia(hoje, f.tenantId);
    await this.audit.registrar({
      usuarioId: null, // ator = backoffice/AbacatePay (sem pessoa)
      tenantId: f.tenantId,
      action,
      resource: 'fatura',
      resourceId: id,
    });
    return { fatura: f, baixou: true };
  }

  /**
   * Marca (e desmarca) a inadimplência: fatura pendente com vencimento há
   * mais de `DIAS_TOLERANCIA_INADIMPLENCIA` dias. Job diário e cada baixa
   * (só o tenant). Devolve quantas assinaturas mudaram.
   */
  async atualizarInadimplencia(
    hoje = hojeISO(),
    tenantId?: string,
  ): Promise<number> {
    const vencida = `EXISTS (SELECT 1 FROM crommos.faturas f
        WHERE f.assinatura_id = a.id AND f.tenant_id = a.tenant_id
          AND f.status = 'pendente' AND f.deleted_at IS NULL
          AND f.vencimento < $1::date - $2::int)`;
    const doTenant = tenantId ? 'AND a.tenant_id = $3' : '';
    const params = [hoje, diasTolerancia(), ...(tenantId ? [tenantId] : [])];
    const marcou = await this.ds.query<[unknown, number] | undefined>(
      `UPDATE crommos.assinaturas a SET inadimplente_desde = $1::date
        WHERE a.deleted_at IS NULL AND a.inadimplente_desde IS NULL
          ${doTenant} AND ${vencida}`,
      params,
    );
    const desmarcou = await this.ds.query<[unknown, number] | undefined>(
      `UPDATE crommos.assinaturas a SET inadimplente_desde = NULL
        WHERE a.inadimplente_desde IS NOT NULL ${doTenant} AND NOT ${vencida}`,
      params,
    );
    return (marcou?.[1] ?? 0) + (desmarcou?.[1] ?? 0);
  }

  /**
   * Renovação (job diário): para cada ciclo vencido (cicloFim ≤ hoje), fecha o
   * ciclo, abre o próximo e gera a fatura `ciclo` com o crédito aplicado —
   * recuperando ciclos atrasados um a um. Devolve quantas faturas gerou.
   */
  async renovarVencidas(hoje = hojeISO()): Promise<number> {
    // ponytail: varre tudo numa rodada; pagine se o nº de tenants crescer muito.
    const vencidas = await this.repo.find({
      where: { cicloFim: LessThanOrEqual(hoje) },
      select: { id: true },
    });
    let geradas = 0;
    for (const v of vencidas) {
      geradas += await this.ds.transaction(async (em) => {
        const assinaturas = em.getRepository(Assinatura);
        const a = await assinaturas.findOne({
          where: { id: v.id },
          lock: { mode: 'pessimistic_write' },
        });
        let n = 0;
        // Assentos de hoje (os de ciclos atrasados não ficam guardados).
        const assentos =
          a && (await assentosDoTenant(em, a.produto, a.tenantId));
        // Trial sem confirmação não fatura: a clínica fica em modo leitura.
        // ponytail: esses tenants voltam na varredura todo dia; filtre no SQL
        // se forem muitos.
        while (
          a &&
          assentos &&
          a.cicloFim <= hoje &&
          !trialExpirado(a, a.cicloFim)
        ) {
          const valorMensal = calcularValor(a.modulosAtivos, assentos, a.plano);
          const r = renovarCiclo({
            cicloFim: a.cicloFim,
            plano: a.plano,
            valorMensal,
            saldoCredito: a.saldoCredito,
          });
          await this.gravarFatura(em, a, {
            tipo: 'ciclo',
            periodoInicio: r.cicloInicio,
            periodoFim: r.cicloFim,
            valorBruto: r.valorBruto,
            creditoAplicado: r.creditoAplicado,
            valorLiquido: r.valorLiquido,
            vencimento: r.cicloInicio,
            itens: {
              motivo: 'renovacao',
              modulosAtivos: a.modulosAtivos,
              numeroUsuarios: assentos.pessoas,
              assentos: assentos.porModulo,
              plano: a.plano,
              valorMensal,
            },
          });
          a.cicloInicio = r.cicloInicio;
          a.cicloFim = r.cicloFim;
          a.saldoCredito = r.saldoCredito;
          a.numeroUsuarios = assentos.pessoas;
          n++;
        }
        if (a && n > 0) await assinaturas.save(a);
        return n;
      });
    }
    return geradas;
  }

  /** Pró-rata de trocar módulos/plano com os mesmos assentos. */
  private proRata(
    a: Assinatura,
    assentos: Assentos,
    valorNovo: number,
    hoje: string,
  ) {
    return calcularProRata({
      cicloInicio: a.cicloInicio,
      cicloFim: a.cicloFim,
      emTrialAte: a.emTrialAte,
      hoje,
      valorMensalAnterior: calcularValor(a.modulosAtivos, assentos, a.plano),
      valorMensalNovo: valorNovo,
    });
  }

  /**
   * A redução abate as faturas pendentes do ciclo corrente (mais recentes
   * primeiro, travadas); devolve o que sobra como crédito.
   */
  private async abaterPendentes(
    em: EntityManager,
    a: Assinatura,
    reducao: number,
    hoje: string,
    usuarioId: string | undefined,
  ): Promise<{ valor: number; abatidas: Fatura[] }> {
    const repo = em.getRepository(Fatura);
    const pendentes = await repo.find({
      where: {
        tenantId: a.tenantId,
        assinaturaId: a.id,
        periodoFim: a.cicloFim,
        status: 'pendente',
      },
      order: { createdAt: 'DESC' },
      lock: { mode: 'pessimistic_write' },
    });
    const r = abaterReducao(reducao, pendentes);
    const abatidas: Fatura[] = [];
    for (const [i, novo] of r.faturas.entries()) {
      if (novo.abatido === 0) continue;
      const f = pendentes[i];
      // O checkout da AbacatePay tinha o valor antigo: um novo sob demanda.
      f.cobrancaId = null;
      f.cobrancaUrl = null;
      const reducoes = (f.itens?.reducoes as unknown[] | undefined) ?? [];
      Object.assign(f, {
        valorBruto: novo.valorBruto,
        creditoAplicado: novo.creditoAplicado,
        valorLiquido: novo.valorLiquido,
        itens: {
          ...f.itens,
          reducoes: [...reducoes, { em: hoje, valor: novo.abatido }],
        },
        updatedBy: usuarioId,
      });
      if (novo.valorBruto === 0) f.status = 'cancelada';
      else if (novo.valorLiquido === 0) {
        f.status = 'paga'; // o crédito que já tinha cobre o que restou
        f.pagoEm = new Date();
      }
      abatidas.push(await repo.save(f));
    }
    return { valor: r.credito, abatidas };
  }

  private gravarFatura(
    em: EntityManager,
    a: Assinatura,
    f: Pick<
      Fatura,
      | 'tipo'
      | 'periodoInicio'
      | 'periodoFim'
      | 'valorBruto'
      | 'creditoAplicado'
      | 'valorLiquido'
      | 'vencimento'
      | 'itens'
    > & { createdBy?: string },
  ): Promise<Fatura> {
    const repo = em.getRepository(Fatura);
    const quitada = f.valorLiquido === 0; // crédito cobriu tudo
    return repo.save(
      repo.create({
        ...f,
        tenantId: a.tenantId,
        assinaturaId: a.id,
        status: quitada ? 'paga' : 'pendente',
        pagoEm: quitada ? new Date() : null,
        updatedBy: f.createdBy,
      }),
    );
  }

  private log(ator: Ator, action: string, resource: string, id: string) {
    return this.audit.registrar({
      usuarioId: ator.usuarioId,
      produto: ator.produto,
      tenantId: ator.tenantId,
      action,
      resource,
      resourceId: id,
    });
  }

  private valores(
    modulosAtivos: ModuleCode[],
    assentos: Assentos,
    plano: PlanoPeriodo,
  ) {
    return {
      modulosAtivos,
      numeroUsuarios: assentos.pessoas,
      plano,
      valor: calcularValor(modulosAtivos, assentos, plano),
      ajusteFaixa: ajusteVirada(modulosAtivos, assentos),
      catalogo: MODULES,
      itens: itensDe(assentos),
      faixa: faixaDe(assentos.pessoas),
      faixas: FAIXAS,
    };
  }

  private view(
    a: Assinatura,
    assentos: Assentos,
    hoje: string,
    faturaVencida: FaturaVencida | null,
  ): AssinaturaView {
    return {
      ...this.valores(a.modulosAtivos, assentos, a.plano),
      ciclo: { inicio: a.cicloInicio, fim: a.cicloFim },
      emTrialAte: a.emTrialAte,
      emTrial: emTrial(a.emTrialAte, hoje),
      saldoCredito: a.saldoCredito,
      trialConfirmado: !!a.trialConfirmadoEm,
      modoLeitura: motivoLeitura(a, hoje),
      faturaVencida,
    };
  }
}
