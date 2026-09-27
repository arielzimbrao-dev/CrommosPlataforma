import { ConflictException, NotFoundException } from '@nestjs/common';
import { Acesso } from 'src/auth/acesso.entity';
import { Assinatura } from 'src/billing/assinatura.entity';
import { AssinaturaService, Ator } from 'src/billing/assinatura.service';
import {
  MODULE_CODES,
  ModuleCode,
  PlanoPeriodo,
} from 'src/billing/modules.catalog';

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const HOJE = '2026-09-16';
const ATOR: Ator = { usuarioId: USER, produto: 'clinic', tenantId: TENANT };

/** Assinatura padrão: Agenda (30) × 5 usuários = R$ 150/mês, ciclo de 30 dias. */
function assinatura(p: Partial<Assinatura> = {}): Assinatura {
  return {
    id: 'a1',
    tenantId: TENANT,
    produto: 'clinic',
    modulosAtivos: [ModuleCode.Agenda],
    numeroUsuarios: 5,
    plano: PlanoPeriodo.Mensal,
    cicloInicio: '2026-09-01',
    cicloFim: '2026-10-01',
    emTrialAte: null,
    saldoCredito: 0,
    ...p,
  } as Assinatura;
}

function make(atual: Assinatura | null = assinatura()) {
  const assinRepo = {
    findOne: jest.fn().mockResolvedValue(atual),
    find: jest.fn(),
    create: jest.fn((x: Record<string, unknown>) => x),
    save: jest.fn((x: Record<string, unknown>) =>
      Promise.resolve({ id: 'a1', ...x }),
    ),
  };
  const fatRepo = {
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn((x: Record<string, unknown>) => x),
    save: jest.fn((x: Record<string, unknown>) =>
      Promise.resolve({ id: 'f1', ...x }),
    ),
  };
  const acessoRepo = { count: jest.fn().mockResolvedValue(1) };
  const em = {
    getRepository: (e: unknown) =>
      e === Assinatura ? assinRepo : e === Acesso ? acessoRepo : fatRepo,
  };
  const ds = {
    transaction: jest.fn((cb: (m: typeof em) => unknown) => cb(em)),
    query: jest.fn().mockResolvedValue([[], 0]),
  };
  const repo = {
    findOne: jest.fn().mockResolvedValue(atual),
    find: jest.fn().mockResolvedValue(atual ? [atual] : []),
  };
  const faturas = {
    find: jest.fn().mockResolvedValue([]),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const audit = { registrar: jest.fn() };
  const svc = new AssinaturaService(
    repo as never,
    faturas as never,
    ds as never,
    audit as never,
  );
  return { svc, repo, faturas, assinRepo, fatRepo, acessoRepo, em, ds, audit };
}

describe('AssinaturaService — gating e leitura', () => {
  it('sem assinatura → nenhum módulo (fail-closed, B5)', async () => {
    const { svc, repo } = make(null);
    await expect(svc.getModulosAtivos(ATOR)).resolves.toEqual([]);
    expect(repo.findOne).toHaveBeenCalledWith({
      where: { produto: 'clinic', tenantId: TENANT },
    });
  });

  it('com assinatura → apenas os contratados', async () => {
    const { svc } = make();
    await expect(svc.getModulosAtivos(ATOR)).resolves.toEqual([
      ModuleCode.Agenda,
    ]);
  });

  it('getCurrent sem assinatura → fail-closed, sem ciclo', async () => {
    const { svc } = make(null);
    const view = await svc.getCurrent(ATOR, HOJE);
    expect(view.modulosAtivos).toEqual([]);
    expect(view.valor).toBe(0);
    expect(view.modoLeitura).toBeNull();
    expect(view.ciclo).toBeNull();
    expect(view.saldoCredito).toBe(0);
    expect(view.emTrial).toBe(false);
  });

  it('getCurrent traz ciclo, trial e saldo', async () => {
    const { svc } = make(
      assinatura({ emTrialAte: '2026-09-20', saldoCredito: 42.5 }),
    );
    const view = await svc.getCurrent(ATOR, HOJE);
    expect(view.valor).toBe(150);
    expect(view.ciclo).toEqual({ inicio: '2026-09-01', fim: '2026-10-01' });
    expect(view.emTrial).toBe(true);
    expect(view.emTrialAte).toBe('2026-09-20');
    expect(view.saldoCredito).toBe(42.5);
    expect(view.trialConfirmado).toBe(false);
    expect(view.modoLeitura).toBeNull();
    expect(view.faturaVencida).toBeNull();
  });

  it('trial acabou sem confirmação → modo leitura (trial_expirado)', async () => {
    const { svc } = make(
      assinatura({
        cicloInicio: '2026-09-01',
        cicloFim: '2026-09-15',
        emTrialAte: '2026-09-15',
      }),
    );
    const view = await svc.getCurrent(ATOR, HOJE);
    expect(view.modoLeitura).toBe('trial_expirado');
    expect((await svc.situacao(ATOR, HOJE)).modoLeitura).toBe('trial_expirado');
  });

  it('fatura vencida: aviso com o dia do bloqueio; inadimplente → leitura', async () => {
    const { svc, faturas } = make(
      assinatura({ inadimplenteDesde: '2026-09-10' }),
    );
    faturas.findOne.mockResolvedValue({
      id: 'f9',
      vencimento: '2026-09-01',
      valorLiquido: 150,
    });
    const view = await svc.getCurrent(ATOR, HOJE);
    expect(view.faturaVencida).toEqual({
      id: 'f9',
      vencimento: '2026-09-01',
      valorLiquido: 150,
      bloqueiaEm: '2026-09-09',
    });
    expect(view.modoLeitura).toBe('inadimplencia');
    const s = await svc.situacao(ATOR, HOJE);
    expect(s).toEqual({
      modoLeitura: 'inadimplencia',
      emTrialAte: null,
      trialConfirmado: false,
      faturaVencida: { vencimento: '2026-09-01', bloqueiaEm: '2026-09-09' },
    });
  });

  it('situacao sem assinatura: normal, sem aviso', async () => {
    const { svc } = make(null);
    await expect(svc.situacao(ATOR, HOJE)).resolves.toEqual({
      modoLeitura: null,
      emTrialAte: null,
      trialConfirmado: false,
      faturaVencida: null,
    });
  });
});

describe('AssinaturaService — fim do trial (confirmação)', () => {
  it('salvar durante o trial confirma; sem fatura (a renovação fatura no fim)', async () => {
    const trial = assinatura({
      emTrialAte: '2026-09-30',
      cicloFim: '2026-09-30',
    });
    const { svc, fatRepo, assinRepo } = make(trial);
    const r = await svc.upsert(ATOR, { numeroUsuarios: 5 }, HOJE);
    expect(assinRepo.save.mock.calls[0][0].trialConfirmadoEm).toEqual(
      expect.any(Date),
    );
    expect(r.trialConfirmado).toBe(true);
    expect(fatRepo.save).not.toHaveBeenCalled();
  });

  it('trial expirado (modo leitura): confirmar abre o 1º ciclo hoje e fatura', async () => {
    const trial = assinatura({
      cicloInicio: '2026-09-01',
      cicloFim: '2026-09-15',
      emTrialAte: '2026-09-15',
    });
    const { svc, fatRepo } = make(trial);
    const r = await svc.upsert(
      ATOR,
      { modulosAtivos: [ModuleCode.Agenda], numeroUsuarios: 2 },
      HOJE,
    );
    expect(r.modoLeitura).toBeNull();
    expect(r.ciclo).toEqual({ inicio: HOJE, fim: '2026-10-16' });
    expect(fatRepo.save.mock.calls[0][0]).toMatchObject({
      tipo: 'ciclo',
      periodoInicio: HOJE,
      valorBruto: 60,
      vencimento: HOJE,
      status: 'pendente',
    });
  });
});

describe('AssinaturaService.simular', () => {
  it('devolve o valor e o pró-rata que seria gerado', async () => {
    const { svc } = make();
    // 150 → 300 (10 usuários), 15 de 30 dias → 75
    const r = await svc.simular(
      ATOR,
      {
        modulos: [ModuleCode.Agenda],
        numeroUsuarios: 10,
        plano: PlanoPeriodo.Mensal,
      },
      HOJE,
    );
    expect(r.valor).toBe(300);
    expect(r.ajuste).toMatchObject({ tipo: 'complementar', valor: 75 });
    expect(r.reducao).toBeNull();
  });

  it('N-02: redução mostra quanto abate da fatura pendente e quanto vira crédito', async () => {
    const { svc, faturas } = make(assinatura({ numeroUsuarios: 10 }));
    faturas.find.mockResolvedValue([{ valorBruto: 50, creditoAplicado: 0 }]);
    // 300 → 150: 75 de redução; 50 abatem a pendente, 25 viram crédito
    const r = await svc.simular(
      ATOR,
      {
        modulos: [ModuleCode.Agenda],
        numeroUsuarios: 5,
        plano: PlanoPeriodo.Mensal,
      },
      HOJE,
    );
    expect(faturas.find).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT,
        assinaturaId: 'a1',
        periodoFim: '2026-10-01',
        status: 'pendente',
      },
      order: { createdAt: 'DESC' },
    });
    expect(r.reducao).toEqual({ abatidoEmPendentes: 50, credito: 25 });
  });

  it('sem assinatura → ajuste nulo', async () => {
    const { svc } = make(null);
    const r = await svc.simular(
      ATOR,
      {
        modulos: [ModuleCode.Agenda],
        numeroUsuarios: 2,
        plano: PlanoPeriodo.Mensal,
      },
      HOJE,
    );
    expect(r).toEqual({
      valor: 60,
      ajuste: null,
      reducao: null,
      primeiraFatura: {
        valorLiquido: 60,
        periodoInicio: HOJE,
        periodoFim: '2026-10-16',
        vencimento: HOJE,
      },
    });
  });

  const simularAgenda2 = (a: Assinatura | null) =>
    make(a).svc.simular(
      ATOR,
      {
        modulos: [ModuleCode.Agenda],
        numeroUsuarios: 2,
        plano: PlanoPeriodo.Mensal,
      },
      HOJE,
    );

  it('QA-006: trial expirado (modo leitura) → 1ª fatura = 1º ciclo a partir de hoje', async () => {
    const r = await simularAgenda2(
      assinatura({
        cicloInicio: '2026-09-01',
        cicloFim: '2026-09-15',
        emTrialAte: '2026-09-15',
        saldoCredito: 10,
      }),
    );
    expect(r.primeiraFatura).toEqual({
      valorLiquido: 50,
      periodoInicio: HOJE,
      periodoFim: '2026-10-16',
      vencimento: HOJE,
    });
  });

  it('QA-006: trial ativo → 1ª fatura = a do fim do trial (semestral: 6 meses)', async () => {
    const { svc } = make(
      assinatura({ cicloFim: '2026-09-30', emTrialAte: '2026-09-30' }),
    );
    const r = await svc.simular(
      ATOR,
      {
        modulos: [ModuleCode.Agenda],
        numeroUsuarios: 2,
        plano: PlanoPeriodo.Semestral,
      },
      HOJE,
    );
    expect(r.primeiraFatura).toEqual({
      valorLiquido: 342, // 57/mês (5% do semestral) × 6
      periodoInicio: '2026-09-30',
      periodoFim: '2027-03-30',
      vencimento: '2026-09-30',
    });
  });

  it('QA-006: assinatura paga (fora do trial) → sem 1ª fatura', async () => {
    const r = await simularAgenda2(assinatura());
    expect(r.primeiraFatura).toBeNull();
  });
});

describe('AssinaturaService.upsert (pró-rata)', () => {
  it('upgrade gera fatura complementar numa transação e audita', async () => {
    const { svc, assinRepo, fatRepo, ds, audit } = make();
    const r = await svc.upsert(ATOR, { numeroUsuarios: 10 }, HOJE);

    expect(ds.transaction).toHaveBeenCalledTimes(1);
    expect(assinRepo.findOne).toHaveBeenCalledWith({
      where: { tenantId: TENANT, produto: 'clinic' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(r.valor).toBe(300);
    expect(r.ajuste).toMatchObject({ tipo: 'complementar', valor: 75 });
    const fatura = fatRepo.save.mock.calls[0][0];
    expect(fatura).toMatchObject({
      tenantId: TENANT,
      assinaturaId: 'a1',
      tipo: 'complementar',
      periodoInicio: HOJE,
      periodoFim: '2026-10-01',
      valorBruto: 75,
      creditoAplicado: 0,
      valorLiquido: 75,
      status: 'pendente',
      vencimento: HOJE,
      createdBy: USER,
    });
    expect(r.fatura).toMatchObject({ id: 'f1', valorLiquido: 75 });
    expect(assinRepo.save.mock.calls[0][0]).toMatchObject({
      numeroUsuarios: 10,
      updatedBy: USER,
    });
    expect(audit.registrar).toHaveBeenCalledWith({
      usuarioId: USER,
      produto: 'clinic',
      tenantId: TENANT,
      action: 'update',
      resource: 'assinatura',
      resourceId: 'a1',
    });
    expect(audit.registrar).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'create', resource: 'fatura' }),
    );
  });

  it('exemplo do usuário: 500 → 1000 com 15/30 dias = R$ 250', async () => {
    // Agenda 30 + Financeiro 35 + Múltiplas 15 + Exames 20 = 100/usuário × 5 = 500
    const mod = [
      ModuleCode.Agenda,
      ModuleCode.Financeiro,
      ModuleCode.MultiplasUnidades,
      ModuleCode.Exames,
    ];
    const { svc, fatRepo } = make(assinatura({ modulosAtivos: mod }));
    const r = await svc.upsert(ATOR, { numeroUsuarios: 10 }, HOJE);
    expect(r.valor).toBe(1000);
    expect(r.ajuste).toMatchObject({ tipo: 'complementar', valor: 250 });
    expect(fatRepo.save.mock.calls[0][0].valorBruto).toBe(250);
  });

  it('upgrade abate crédito existente; se quita tudo, a fatura nasce paga', async () => {
    const { svc, fatRepo, assinRepo } = make(assinatura({ saldoCredito: 100 }));
    await svc.upsert(ATOR, { numeroUsuarios: 10 }, HOJE);
    const f = fatRepo.save.mock.calls[0][0];
    expect(f).toMatchObject({
      valorBruto: 75,
      creditoAplicado: 75,
      valorLiquido: 0,
      status: 'paga',
    });
    expect(f.pagoEm).toBeInstanceOf(Date);
    expect(assinRepo.save.mock.calls[0][0].saldoCredito).toBe(25);
  });

  it('downgrade soma crédito e não gera fatura', async () => {
    const { svc, fatRepo, assinRepo } = make(assinatura({ saldoCredito: 10 }));
    const r = await svc.upsert(ATOR, { numeroUsuarios: 1 }, HOJE);
    // 150 → 30: −120 × 15/30 = 60 de crédito
    expect(r.ajuste).toMatchObject({ tipo: 'credito', valor: 60 });
    expect(r.fatura).toBeNull();
    expect(fatRepo.save).not.toHaveBeenCalled();
    expect(assinRepo.save.mock.calls[0][0].saldoCredito).toBe(70);
    expect(r.saldoCredito).toBe(70);
  });

  it('no trial não há ajuste', async () => {
    const { svc, fatRepo } = make(assinatura({ emTrialAte: '2026-10-01' }));
    const r = await svc.upsert(ATOR, { numeroUsuarios: 10 }, HOJE);
    expect(r.ajuste).toMatchObject({ tipo: 'nenhum', emTrial: true });
    expect(fatRepo.save).not.toHaveBeenCalled();
  });

  it('upsert parcial não apaga os campos não enviados (dto com undefined)', async () => {
    const { svc } = make();
    const view = await svc.upsert(
      ATOR,
      { numeroUsuarios: 5, modulosAtivos: undefined, plano: undefined },
      HOJE,
    );
    expect(view.modulosAtivos).toEqual([ModuleCode.Agenda]);
    expect(view.plano).toBe(PlanoPeriodo.Mensal);
    expect(view.ajuste).toMatchObject({ tipo: 'nenhum' });
  });

  it('sem assinatura: cria com ciclo a partir de hoje e fatura o ciclo cheio', async () => {
    const { svc, assinRepo, fatRepo } = make(null);
    const r = await svc.upsert(
      ATOR,
      {
        modulosAtivos: [ModuleCode.Agenda],
        numeroUsuarios: 3,
        plano: PlanoPeriodo.Anual,
      },
      HOJE,
    );
    // 30 × 3 × 0,8 = 72/mês; anual → 864
    expect(r.valor).toBe(72);
    expect(assinRepo.save.mock.calls[0][0]).toMatchObject({
      tenantId: TENANT,
      cicloInicio: HOJE,
      cicloFim: '2027-09-16',
      saldoCredito: 0,
      createdBy: USER,
    });
    expect(fatRepo.save.mock.calls[0][0]).toMatchObject({
      tipo: 'ciclo',
      valorBruto: 864,
      valorLiquido: 864,
      vencimento: HOJE,
    });
    expect(r.ajuste).toBeNull();
  });

  it('sem assinatura e DTO vazio: padrões (nenhum módulo, 1 usuário, mensal) e dia de hoje', async () => {
    const { svc, assinRepo } = make(null);
    const r = await svc.upsert(ATOR, {});
    expect(assinRepo.save.mock.calls[0][0]).toMatchObject({
      modulosAtivos: [],
      numeroUsuarios: 1,
      plano: PlanoPeriodo.Mensal,
    });
    expect(r.valor).toBe(0);
    await expect(svc.getCurrent(ATOR)).resolves.toBeDefined();
  });

  it('N-02: upgrade → downgrade sem pagar cancela a complementar e não gera crédito', async () => {
    // 300 (10 usuários) → 150 (5): −150 × 15/30 = 75, a complementar pendente de 75
    const { svc, fatRepo, assinRepo, audit } = make(
      assinatura({ numeroUsuarios: 10 }),
    );
    fatRepo.find.mockResolvedValue([
      {
        id: 'f9',
        valorBruto: 75,
        creditoAplicado: 0,
        valorLiquido: 75,
        status: 'pendente',
        itens: { motivo: 'pro-rata' },
      },
    ]);
    const r = await svc.upsert(ATOR, { numeroUsuarios: 5 }, HOJE);
    expect(fatRepo.find).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT,
        assinaturaId: 'a1',
        periodoFim: '2026-10-01',
        status: 'pendente',
      },
      order: { createdAt: 'DESC' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(r.ajuste).toMatchObject({ tipo: 'credito', valor: 75 });
    expect(r.saldoCredito).toBe(0);
    expect(assinRepo.save.mock.calls[0][0].saldoCredito).toBe(0);
    expect(fatRepo.save.mock.calls[0][0]).toMatchObject({
      id: 'f9',
      valorBruto: 0,
      valorLiquido: 0,
      status: 'cancelada',
      updatedBy: USER,
      itens: {
        motivo: 'pro-rata',
        reducoes: [{ em: HOJE, valor: 75 }],
      },
    });
    expect(audit.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'cancelar',
        resource: 'fatura',
        resourceId: 'f9',
      }),
    );
  });

  it('N-02: redução parcial só reduz a pendente; crédito devolvido quita e marca paga', async () => {
    const { svc, fatRepo, audit } = make(assinatura({ numeroUsuarios: 10 }));
    fatRepo.find.mockResolvedValue([
      { id: 'fa', valorBruto: 100, creditoAplicado: 0, status: 'pendente' },
      { id: 'fb', valorBruto: 40, creditoAplicado: 30, status: 'pendente' },
    ]);
    // redução de 75 com 5 usuários — ver teste anterior
    await svc.upsert(ATOR, { numeroUsuarios: 5 }, HOJE);
    expect(fatRepo.save).toHaveBeenCalledTimes(1);
    expect(fatRepo.save.mock.calls[0][0]).toMatchObject({
      id: 'fa',
      valorBruto: 25,
      valorLiquido: 25,
      status: 'pendente',
      itens: { reducoes: [{ em: HOJE, valor: 75 }] },
    });
    expect(audit.registrar).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'reduzir', resourceId: 'fa' }),
    );

    // crédito já aplicado: bruto 40 (30 de crédito) − 25 → bruto 15 coberto
    const m = make(assinatura({ numeroUsuarios: 6 }));
    m.fatRepo.find.mockResolvedValue([
      { id: 'fc', valorBruto: 40, creditoAplicado: 30, status: 'pendente' },
    ]);
    // 180 → 150: −30 × 15/30 = 15
    const r = await m.svc.upsert(ATOR, { numeroUsuarios: 5 }, HOJE);
    expect(m.fatRepo.save.mock.calls[0][0]).toMatchObject({
      valorBruto: 25,
      creditoAplicado: 25,
      valorLiquido: 0,
      status: 'paga',
    });
    expect(m.fatRepo.save.mock.calls[0][0].pagoEm).toBeInstanceOf(Date);
    expect(r.saldoCredito).toBe(5);
  });

  it('N-03: recusa numeroUsuarios abaixo dos ativos + convites (409)', async () => {
    const { svc, acessoRepo, assinRepo } = make();
    acessoRepo.count.mockResolvedValue(4);
    await expect(svc.upsert(ATOR, { numeroUsuarios: 3 }, HOJE)).rejects.toThrow(
      /desative usuários antes de reduzir/,
    );
    expect(acessoRepo.count).toHaveBeenCalledWith({
      where: { produto: 'clinic', tenantId: TENANT, ativo: true },
    });
    expect(assinRepo.save).not.toHaveBeenCalled();
    // igual aos ativos passa; aumento nem conta
    await svc.upsert(ATOR, { numeroUsuarios: 4 }, HOJE);
    acessoRepo.count.mockClear();
    await svc.upsert(ATOR, { numeroUsuarios: 6 }, HOJE);
    expect(acessoRepo.count).not.toHaveBeenCalled();
  });

  it('N-03: na criação também confere os ativos', async () => {
    const { svc, acessoRepo } = make(null);
    acessoRepo.count.mockResolvedValue(3);
    await expect(svc.upsert(ATOR, {}, HOJE)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('AssinaturaService — faturas', () => {
  it('lista paginado, mais recentes primeiro', async () => {
    const { svc, faturas } = make();
    faturas.findAndCount.mockResolvedValue([[{ id: 'f1' }], 1]);
    const r = await svc.listarFaturas(ATOR, { limit: 10, offset: 20 });
    expect(r).toEqual({ data: [{ id: 'f1' }], total: 1 });
    expect(faturas.findAndCount).toHaveBeenCalledWith({
      where: { tenantId: TENANT, assinaturaId: 'a1' },
      order: { createdAt: 'DESC' },
      take: 10,
      skip: 20,
    });
  });

  it('pagarPelaPlataforma: baixa fora do tenant, condicional e auditada (N-01)', async () => {
    const { svc, faturas, audit, ds } = make();
    const paga = { id: 'f1', tenantId: TENANT, status: 'paga' };
    faturas.findOne.mockResolvedValue(paga);
    const f = await svc.pagarPelaPlataforma('f1');
    expect(f).toBe(paga); // relida depois do UPDATE
    expect(faturas.update).toHaveBeenCalledWith(
      { id: 'f1', status: 'pendente' },
      { status: 'paga', pagoEm: expect.any(Date) },
    );
    expect(audit.registrar).toHaveBeenCalledWith({
      usuarioId: null,
      tenantId: TENANT,
      action: 'pagar-plataforma',
      resource: 'fatura',
      resourceId: 'f1',
    });
    // Reativa na hora: recalcula a inadimplência do tenant.
    expect(ds.query).toHaveBeenCalledWith(
      expect.stringContaining('inadimplente_desde = NULL'),
      [expect.any(String), 7, TENANT],
    );
  });

  it('baixar é idempotente: já paga → baixou=false, sem auditoria', async () => {
    const { svc, faturas, audit } = make();
    faturas.update.mockResolvedValue({ affected: 0 });
    faturas.findOne.mockResolvedValue({ id: 'f1', status: 'paga' });
    await expect(svc.baixar('f1', 'pagar-abacatepay')).resolves.toMatchObject({
      baixou: false,
    });
    expect(audit.registrar).not.toHaveBeenCalled();
  });

  it('atualizarInadimplencia: marca e desmarca (todos os tenants) e soma as linhas', async () => {
    const { svc, ds } = make();
    ds.query.mockResolvedValueOnce([[], 2]).mockResolvedValueOnce([[], 1]);
    await expect(svc.atualizarInadimplencia(HOJE)).resolves.toBe(3);
    expect(ds.query.mock.calls[0][1]).toEqual([HOJE, 7]);
    ds.query.mockResolvedValue(undefined);
    await expect(svc.atualizarInadimplencia(HOJE)).resolves.toBe(0);
  });

  it('pagarPelaPlataforma: 404 inexistente e 409 se não estiver pendente', async () => {
    const { svc, faturas, audit } = make();
    faturas.update.mockResolvedValue({ affected: 0 });
    faturas.findOne.mockResolvedValueOnce(null);
    await expect(svc.pagarPelaPlataforma('x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    faturas.findOne.mockResolvedValue({ id: 'f1', status: 'paga' });
    await expect(svc.pagarPelaPlataforma('f1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(audit.registrar).not.toHaveBeenCalled();
  });
});

describe('AssinaturaService.iniciarTrial (signup)', () => {
  it('cria a assinatura em trial de 14 dias com todos os módulos e o tenant', async () => {
    const repo = {
      create: jest.fn((x: Record<string, unknown>) => x),
      save: jest.fn((x: Record<string, unknown>) => Promise.resolve(x)),
    };
    const em = { getRepository: () => repo };
    const a = await AssinaturaService.iniciarTrial(
      em as never,
      {
        tenantId: TENANT,
        produto: 'clinic',
        clienteId: 'c1',
        tenantNome: 'Clínica',
        tenantCodigo: 'ABCDE',
      },
      undefined,
      HOJE,
    );
    expect(a).toMatchObject({
      tenantId: TENANT,
      produto: 'clinic',
      clienteId: 'c1',
      tenantNome: 'Clínica',
      tenantCodigo: 'ABCDE',
      modulosAtivos: MODULE_CODES,
      numeroUsuarios: 5, // QA-009: dá para testar com a equipe
      plano: PlanoPeriodo.Mensal,
      cicloInicio: HOJE,
      cicloFim: '2026-09-30',
      emTrialAte: '2026-09-30',
      saldoCredito: 0,
    });
  });
});

describe('AssinaturaService.renovarVencidas', () => {
  it('fecha o ciclo vencido, abre o próximo e gera a fatura com crédito', async () => {
    const vencida = assinatura({ cicloFim: '2026-09-16', saldoCredito: 50 });
    const { svc, repo, assinRepo, fatRepo } = make(vencida);
    const n = await svc.renovarVencidas(HOJE);
    expect(n).toBe(1);
    expect(repo.find).toHaveBeenCalled();
    expect(fatRepo.save.mock.calls[0][0]).toMatchObject({
      tenantId: TENANT,
      assinaturaId: 'a1',
      tipo: 'ciclo',
      periodoInicio: '2026-09-16',
      periodoFim: '2026-10-16',
      valorBruto: 150,
      creditoAplicado: 50,
      valorLiquido: 100,
      status: 'pendente',
      vencimento: '2026-09-16',
    });
    expect(assinRepo.save.mock.calls[0][0]).toMatchObject({
      cicloInicio: '2026-09-16',
      cicloFim: '2026-10-16',
      saldoCredito: 0,
    });
  });

  it('trial sem confirmação não fatura (modo leitura)', async () => {
    const trial = assinatura({
      cicloInicio: '2026-07-20',
      cicloFim: '2026-08-03',
      emTrialAte: '2026-08-03',
    });
    const { svc, fatRepo } = make(trial);
    await expect(svc.renovarVencidas(HOJE)).resolves.toBe(0);
    expect(fatRepo.save).not.toHaveBeenCalled();
  });

  it('recupera ciclos atrasados (um por período) e fim do trial confirmado abre o 1º ciclo', async () => {
    const trial = assinatura({
      cicloInicio: '2026-07-20',
      cicloFim: '2026-08-03',
      emTrialAte: '2026-08-03',
      trialConfirmadoEm: new Date(),
    });
    const { svc, fatRepo } = make(trial);
    const n = await svc.renovarVencidas(HOJE);
    // 08-03→09-03 e 09-03→10-03
    expect(n).toBe(2);
    expect(fatRepo.save.mock.calls.map((c) => c[0].periodoInicio)).toEqual([
      '2026-08-03',
      '2026-09-03',
    ]);
  });

  it('assinatura já renovada por outra execução é ignorada (relida com lock)', async () => {
    const { svc, assinRepo, fatRepo } = make(
      assinatura({ cicloFim: '2026-09-10' }),
    );
    assinRepo.findOne.mockResolvedValue(assinatura({ cicloFim: '2026-10-10' }));
    await expect(svc.renovarVencidas(HOJE)).resolves.toBe(0);
    expect(fatRepo.save).not.toHaveBeenCalled();
  });

  it('assinatura removida entre a varredura e o lock é ignorada', async () => {
    const { svc, assinRepo } = make(assinatura({ cicloFim: '2026-09-10' }));
    assinRepo.findOne.mockResolvedValue(null);
    await expect(svc.renovarVencidas(HOJE)).resolves.toBe(0);
  });
});
