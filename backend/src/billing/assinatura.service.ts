import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DataSource,
  EntityManager,
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
  MODULES,
  MODULE_CODES,
  ModuleCode,
  PlanoPeriodo,
  calcularValor,
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

/** Quem está agindo sobre a assinatura (das claims do token). */
export interface Ator {
  usuarioId: string;
  produto: Produto;
  tenantId: string;
}

export interface AssinaturaView {
  modulosAtivos: ModuleCode[];
  numeroUsuarios: number;
  plano: PlanoPeriodo;
  /** R$/mês (fórmula de docs/03-precificacao.md). */
  valor: number;
  catalogo: typeof MODULES;
  ciclo: { inicio: string; fim: string } | null;
  emTrialAte: string | null;
  emTrial: boolean;
  saldoCredito: number;
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

/** Acessos que ocupam vaga: ativos (convites pendentes são ativos). */
export function contarAcessosAtivos(
  em: EntityManager,
  produto: Produto,
  tenantId: string,
): Promise<number> {
  return em
    .getRepository(Acesso)
    .count({ where: { produto, tenantId, ativo: true } });
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
   * Assinatura em **trial** (signup): todos os módulos, 1 usuário, mensal; o
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
        numeroUsuarios: 1,
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

  async getCurrent(ator: Ator, hoje = hojeISO()): Promise<AssinaturaView> {
    const a = await this.buscar(ator);
    if (a) return this.view(a, hoje);
    // Sem assinatura (tenant legado): todos os módulos, como no gating.
    return {
      ...this.valores(MODULE_CODES, 1, PlanoPeriodo.Mensal),
      ciclo: null,
      emTrialAte: null,
      emTrial: false,
      saldoCredito: 0,
    };
  }

  /**
   * Valor da configuração simulada + o pró-rata que a mudança geraria hoje.
   * Numa redução, `reducao` diz quanto abate das faturas pendentes do ciclo e
   * quanto vira crédito — mesma regra do `upsert`.
   */
  async simular(
    ator: Ator,
    dto: SimularDto,
    hoje = hojeISO(),
  ): Promise<{
    valor: number;
    ajuste: AjusteProRata | null;
    reducao: { abatidoEmPendentes: number; credito: number } | null;
  }> {
    const valor = calcularValor(dto.modulos, dto.numeroUsuarios, dto.plano);
    const a = await this.buscar(ator);
    const ajuste = a ? this.proRata(a, valor, hoje) : null;
    if (!a || ajuste?.tipo !== 'credito') {
      return { valor, ajuste, reducao: null };
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
      valor,
      ajuste,
      reducao: { abatidoEmPendentes: abatido / 100, credito: r.credito },
    };
  }

  /**
   * Altera módulos/usuários/plano numa transação com a linha travada (a mesma
   * trava do convite/reativação — limite de usuários): upgrade → fatura
   * complementar (abatendo crédito); redução → abate as faturas pendentes do
   * ciclo e só o excedente vira crédito. Sem assinatura, cria e fatura o 1º
   * ciclo. Não aceita menos usuários que os acessos ativos (convites inclusos).
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
      const numeroUsuarios = dto.numeroUsuarios ?? atual?.numeroUsuarios ?? 1;
      const plano = dto.plano ?? atual?.plano ?? PlanoPeriodo.Mensal;
      const valorNovo = calcularValor(modulosAtivos, numeroUsuarios, plano);

      // Só confere na criação ou na redução (não trava tenant legado acima
      // do limite que mexe só nos módulos).
      if (numeroUsuarios < (atual?.numeroUsuarios ?? Infinity)) {
        const ativos = await contarAcessosAtivos(em, produto, tenantId);
        if (numeroUsuarios < ativos) {
          throw new ConflictException(
            `A clínica tem ${ativos} usuário(s) ativo(s) ou convidado(s): desative usuários antes de reduzir para ${numeroUsuarios}.`,
          );
        }
      }

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

      const ajuste = this.proRata(atual, valorNovo, hoje);
      atual.modulosAtivos = modulosAtivos;
      atual.numeroUsuarios = numeroUsuarios;
      atual.plano = plano;
      atual.updatedBy = usuarioId;
      let fatura: Fatura | null = null;
      let abatidas: Fatura[] = [];
      if (ajuste.tipo === 'credito') {
        const credito = await this.abaterPendentes(
          em,
          atual,
          ajuste.valor,
          hoje,
          usuarioId,
        );
        abatidas = credito.abatidas;
        atual.saldoCredito =
          (centavos(atual.saldoCredito) + centavos(credito.valor)) / 100;
      } else if (ajuste.tipo === 'complementar') {
        const c = aplicarCredito(ajuste.valor, atual.saldoCredito);
        atual.saldoCredito = c.saldoRestante;
        fatura = await this.gravarFatura(em, atual, {
          tipo: 'complementar',
          periodoInicio: hoje,
          periodoFim: atual.cicloFim,
          valorBruto: ajuste.valor,
          creditoAplicado: c.creditoAplicado,
          valorLiquido: c.valorLiquido,
          vencimento: hoje,
          itens: {
            motivo: 'pro-rata',
            ajuste,
            modulosAtivos,
            numeroUsuarios,
            plano,
          },
          createdBy: usuarioId,
        });
      }
      const a = await assinaturas.save(atual);
      return { a, ajuste, fatura, abatidas };
    });

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
    return { ...this.view(r.a, hoje), ajuste: r.ajuste, fatura: r.fatura };
  }

  /** Módulos ativos (gating). Sem assinatura → todos (tenant legado). */
  async getModulosAtivos(
    ator: Pick<Ator, 'produto' | 'tenantId'>,
  ): Promise<ModuleCode[]> {
    const a = await this.buscar(ator);
    return a ? a.modulosAtivos : MODULE_CODES;
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
   * Baixa de fatura pelo backoffice da Crommos (`X-Plataforma-Key`).
   * Provisório até o webhook da AbacatePay. O UPDATE condicional evita baixa
   * dupla e corrida com a redução (que trava a linha).
   */
  async pagarPelaPlataforma(id: string): Promise<Fatura> {
    const r = await this.faturas.update(
      { id, status: 'pendente' },
      { status: 'paga', pagoEm: new Date() },
    );
    const f = await this.faturas.findOne({ where: { id } });
    if (!f) throw new NotFoundException('Fatura não encontrada.');
    if (!r.affected) {
      throw new ConflictException('Só é possível pagar uma fatura pendente.');
    }
    await this.audit.registrar({
      usuarioId: null, // ator = backoffice (sem pessoa)
      tenantId: f.tenantId,
      action: 'pagar-plataforma',
      resource: 'fatura',
      resourceId: id,
    });
    return f;
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
        while (a && a.cicloFim <= hoje) {
          const valorMensal = calcularValor(
            a.modulosAtivos,
            a.numeroUsuarios,
            a.plano,
          );
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
              numeroUsuarios: a.numeroUsuarios,
              plano: a.plano,
              valorMensal,
            },
          });
          a.cicloInicio = r.cicloInicio;
          a.cicloFim = r.cicloFim;
          a.saldoCredito = r.saldoCredito;
          n++;
        }
        if (a && n > 0) await assinaturas.save(a);
        return n;
      });
    }
    return geradas;
  }

  private proRata(a: Assinatura, valorNovo: number, hoje: string) {
    return calcularProRata({
      cicloInicio: a.cicloInicio,
      cicloFim: a.cicloFim,
      emTrialAte: a.emTrialAte,
      hoje,
      valorMensalAnterior: calcularValor(
        a.modulosAtivos,
        a.numeroUsuarios,
        a.plano,
      ),
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
    usuarioId: string,
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
    numeroUsuarios: number,
    plano: PlanoPeriodo,
  ) {
    return {
      modulosAtivos,
      numeroUsuarios,
      plano,
      valor: calcularValor(modulosAtivos, numeroUsuarios, plano),
      catalogo: MODULES,
    };
  }

  private view(a: Assinatura, hoje: string): AssinaturaView {
    return {
      ...this.valores(a.modulosAtivos, a.numeroUsuarios, a.plano),
      ciclo: { inicio: a.cicloInicio, fim: a.cicloFim },
      emTrialAte: a.emTrialAte,
      emTrial: emTrial(a.emTrialAte, hoje),
      saldoCredito: a.saldoCredito,
    };
  }
}
