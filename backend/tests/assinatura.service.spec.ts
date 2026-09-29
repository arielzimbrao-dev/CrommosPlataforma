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

/**
 * Assinatura padrão: Agenda (25,50) × 5 pessoas = R$ 127,50/mês, ciclo de 30
 * dias. Os assentos vêm dos acessos (`equipe`): 5 médicos-admin.
 */
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

const equipe = (n: number, papel = 'admin', clinico = true) =>
  Array.from({ length: n }, () => ({ papel, clinico }));

function make(atual: Assinatura | null = assinatura(), pessoas = equipe(5)) {
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
  const acessoRepo = { find: jest.fn().mockResolvedValue(pessoas) };
  const em = {
    getRepository: (e: unknown) =>
      e === Assinatura ? assinRepo : e === Acesso ? acessoRepo : fatRepo,
  };
  const ds = {
    transaction: jest.fn((cb: (m: typeof em) => unknown) => cb(em)),
    query: jest.fn().mockResolvedValue([[], 0]),
    manager: em,
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
    expect(view.valor).toBe(127.5);
    expect(view.numeroUsuarios).toBe(5);
    expect(view.faixa).toEqual({ de: 1, ate: 5, desconto: 0 });
    expect(view.itens.find((i) => i.code === ModuleCode.Prontuario)).toEqual({
      code: ModuleCode.Prontuario,
      pessoas: 5,
      preco: 25.5,
    });
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
    const r = await svc.upsert(ATOR, {}, HOJE);
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
    const { svc, fatRepo } = make(trial, equipe(2));
    const r = await svc.upsert(
      ATOR,
      { modulosAtivos: [ModuleCode.Agenda] },
      HOJE,
    );
    expect(r.modoLeitura).toBeNull();
    expect(r.ciclo).toEqual({ inicio: HOJE, fim: '2026-10-16' });
    expect(fatRepo.save.mock.calls[0][0]).toMatchObject({
      tipo: 'ciclo',
      periodoInicio: HOJE,
      valorBruto: 51,
      vencimento: HOJE,
      status: 'pendente',
    });
  });
});

const AGENDA_PRONT = [ModuleCode.Agenda, ModuleCode.Prontuario];

describe('AssinaturaService.simular', () => {
  it('devolve o valor, os assentos e o pró-rata que seria gerado', async () => {
    const { svc } = make();
    // 127,50 → 255 (+ Prontuário, 5 assentos), 15 de 30 dias → 63,75
    const r = await svc.simular(
      ATOR,
      { modulos: AGENDA_PRONT, plano: PlanoPeriodo.Mensal },
      HOJE,
    );
    expect(r.valor).toBe(255);
    expect(r.valorAtual).toBe(127.5);
    expect(r.numeroUsuarios).toBe(5);
    expect(r.ajuste).toMatchObject({ tipo: 'complementar', valor: 63.75 });
    expect(r.reducao).toBeNull();
  });

  it('adicionar: impacto de ativar uma pessoa (a 6ª muda a faixa)', async () => {
    const { svc } = make();
    const r = await svc.simular(
      ATOR,
      {
        modulos: [ModuleCode.Agenda],
        plano: PlanoPeriodo.Mensal,
        adicionar: { papel: 'recepcao' },
      },
      HOJE,
    );
    // 6 × 22,95 (faixa 6–10)
    expect(r).toMatchObject({
      valorAtual: 127.5,
      valor: 137.7,
      numeroUsuarios: 6,
    });
    expect(r.faixa.desconto).toBe(10);
    expect(r.itens.find((i) => i.code === ModuleCode.Prontuario)?.pessoas).toBe(
      5,
    );
  });

  it('QA-167: remover e trocar o papel (remover + adicionar) de uma pessoa', async () => {
    const { svc } = make(assinatura(), [
      ...equipe(4),
      { papel: 'recepcao', clinico: false },
    ]);
    const modulos = [ModuleCode.Agenda, ModuleCode.Financeiro];
    // hoje: Agenda 5 × 25,50 + Financeiro 4 × 29,75 = 246,50
    const sem = await svc.simular(
      ATOR,
      { modulos, plano: PlanoPeriodo.Mensal, remover: { papel: 'recepcao' } },
      HOJE,
    );
    expect(sem).toMatchObject({ valor: 221, numeroUsuarios: 4 });
    // recepção → financeiro: sai da Agenda, entra no Financeiro
    const troca = await svc.simular(
      ATOR,
      {
        modulos,
        plano: PlanoPeriodo.Mensal,
        remover: { papel: 'recepcao' },
        adicionar: { papel: 'financeiro' },
      },
      HOJE,
    );
    expect(troca).toMatchObject({ valor: 250.75, numeroUsuarios: 5 });
    // prefere quem tem o mesmo vínculo clínico; sem ninguém do papel, nada muda
    const nada = await svc.simular(
      ATOR,
      { modulos, plano: PlanoPeriodo.Mensal, remover: { papel: 'gestor' } },
      HOJE,
    );
    expect(nada.valor).toBe(246.5);
  });

  it('QA-157: simular mostra o ajuste da virada de faixa (10 → 11 pessoas)', async () => {
    const { svc } = make(assinatura(), equipe(10, 'recepcao', false));
    const r = await svc.simular(
      ATOR,
      {
        modulos: [ModuleCode.Agenda],
        plano: PlanoPeriodo.Mensal,
        adicionar: { papel: 'recepcao' },
      },
      HOJE,
    );
    expect(r).toMatchObject({
      valorAtual: 229.5,
      valor: 229.5,
      ajusteFaixa: 5.1,
    });
    const view = await make(
      assinatura(),
      equipe(11, 'recepcao', false),
    ).svc.getCurrent(ATOR, HOJE);
    expect(view).toMatchObject({ valor: 229.5, ajusteFaixa: 5.1 });
  });

  it('N-02: redução mostra quanto abate da fatura pendente e quanto vira crédito', async () => {
    const { svc, faturas } = make(assinatura({ modulosAtivos: AGENDA_PRONT }));
    faturas.find.mockResolvedValue([{ valorBruto: 50, creditoAplicado: 0 }]);
    // 255 → 127,50: 63,75 de redução; 50 abatem a pendente, 13,75 viram crédito
    const r = await svc.simular(
      ATOR,
      { modulos: [ModuleCode.Agenda], plano: PlanoPeriodo.Mensal },
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
    expect(r.reducao).toEqual({ abatidoEmPendentes: 50, credito: 13.75 });
  });

  it('sem assinatura → ajuste nulo', async () => {
    const { svc } = make(null, equipe(2));
    const r = await svc.simular(
      ATOR,
      { modulos: [ModuleCode.Agenda], plano: PlanoPeriodo.Mensal },
      HOJE,
    );
    expect(r).toMatchObject({
      valor: 51,
      valorAtual: 0,
      ajuste: null,
      reducao: null,
      primeiraFatura: {
        valorLiquido: 51,
        periodoInicio: HOJE,
        periodoFim: '2026-10-16',
        vencimento: HOJE,
      },
    });
  });

  const simularAgenda2 = (a: Assinatura | null) =>
    make(a, equipe(2)).svc.simular(
      ATOR,
      { modulos: [ModuleCode.Agenda], plano: PlanoPeriodo.Mensal },
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
      valorLiquido: 41,
      periodoInicio: HOJE,
      periodoFim: '2026-10-16',
      vencimento: HOJE,
    });
  });

  it('QA-006: trial ativo → 1ª fatura = a do fim do trial (semestral: 6 meses)', async () => {
    const { svc } = make(
      assinatura({ cicloFim: '2026-09-30', emTrialAte: '2026-09-30' }),
      equipe(2),
    );
    const r = await svc.simular(
      ATOR,
      { modulos: [ModuleCode.Agenda], plano: PlanoPeriodo.Semestral },
      HOJE,
    );
    expect(r.primeiraFatura).toEqual({
      valorLiquido: 290.7, // 48,45/mês (5% do semestral) × 6
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
  const MAIS_PRONT = { modulosAtivos: AGENDA_PRONT };

  it('upgrade gera fatura complementar numa transação e audita', async () => {
    const { svc, assinRepo, fatRepo, ds, audit, acessoRepo } = make();
    const r = await svc.upsert(ATOR, MAIS_PRONT, HOJE);

    expect(ds.transaction).toHaveBeenCalledTimes(1);
    expect(assinRepo.findOne).toHaveBeenCalledWith({
      where: { tenantId: TENANT, produto: 'clinic' },
      lock: { mode: 'pessimistic_write' },
    });
    // Assentos = acessos ativos (convites pendentes inclusos).
    expect(acessoRepo.find).toHaveBeenCalledWith({
      where: { produto: 'clinic', tenantId: TENANT, ativo: true },
      select: { id: true, papel: true, clinico: true },
    });
    expect(r.valor).toBe(255);
    expect(r.ajuste).toMatchObject({ tipo: 'complementar', valor: 63.75 });
    const fatura = fatRepo.save.mock.calls[0][0];
    expect(fatura).toMatchObject({
      tenantId: TENANT,
      assinaturaId: 'a1',
      tipo: 'complementar',
      periodoInicio: HOJE,
      periodoFim: '2026-10-01',
      valorBruto: 63.75,
      creditoAplicado: 0,
      valorLiquido: 63.75,
      status: 'pendente',
      vencimento: HOJE,
      createdBy: USER,
    });
    expect(r.fatura).toMatchObject({ id: 'f1', valorLiquido: 63.75 });
    expect(assinRepo.save.mock.calls[0][0]).toMatchObject({
      modulosAtivos: AGENDA_PRONT,
      numeroUsuarios: 5,
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

  it('upgrade abate crédito existente; se quita tudo, a fatura nasce paga', async () => {
    const { svc, fatRepo, assinRepo } = make(assinatura({ saldoCredito: 100 }));
    await svc.upsert(ATOR, MAIS_PRONT, HOJE);
    const f = fatRepo.save.mock.calls[0][0];
    expect(f).toMatchObject({
      valorBruto: 63.75,
      creditoAplicado: 63.75,
      valorLiquido: 0,
      status: 'paga',
    });
    expect(f.pagoEm).toBeInstanceOf(Date);
    expect(assinRepo.save.mock.calls[0][0].saldoCredito).toBe(36.25);
  });

  it('downgrade soma crédito e não gera fatura', async () => {
    const { svc, fatRepo, assinRepo } = make(assinatura({ saldoCredito: 10 }));
    const r = await svc.upsert(ATOR, { modulosAtivos: [] }, HOJE);
    // 127,50 → 0: −127,50 × 15/30 = 63,75 de crédito
    expect(r.ajuste).toMatchObject({ tipo: 'credito', valor: 63.75 });
    expect(r.fatura).toBeNull();
    expect(fatRepo.save).not.toHaveBeenCalled();
    expect(assinRepo.save.mock.calls[0][0].saldoCredito).toBe(73.75);
    expect(r.saldoCredito).toBe(73.75);
  });

  it('no trial não há ajuste', async () => {
    const { svc, fatRepo } = make(assinatura({ emTrialAte: '2026-10-01' }));
    const r = await svc.upsert(ATOR, MAIS_PRONT, HOJE);
    expect(r.ajuste).toMatchObject({ tipo: 'nenhum', emTrial: true });
    expect(fatRepo.save).not.toHaveBeenCalled();
  });

  it('upsert parcial não apaga os campos não enviados (dto com undefined)', async () => {
    const { svc } = make();
    const view = await svc.upsert(
      ATOR,
      { modulosAtivos: undefined, plano: undefined },
      HOJE,
    );
    expect(view.modulosAtivos).toEqual([ModuleCode.Agenda]);
    expect(view.plano).toBe(PlanoPeriodo.Mensal);
    expect(view.ajuste).toMatchObject({ tipo: 'nenhum' });
  });

  it('sem assinatura: cria com ciclo a partir de hoje e fatura o ciclo cheio', async () => {
    const { svc, assinRepo, fatRepo } = make(null, equipe(3));
    const r = await svc.upsert(
      ATOR,
      { modulosAtivos: [ModuleCode.Agenda], plano: PlanoPeriodo.Anual },
      HOJE,
    );
    // 25,50 × 3 × 0,8 = 61,20/mês; anual → 734,40
    expect(r.valor).toBe(61.2);
    expect(assinRepo.save.mock.calls[0][0]).toMatchObject({
      tenantId: TENANT,
      numeroUsuarios: 3,
      cicloInicio: HOJE,
      cicloFim: '2027-09-16',
      saldoCredito: 0,
      createdBy: USER,
    });
    expect(fatRepo.save.mock.calls[0][0]).toMatchObject({
      tipo: 'ciclo',
      valorBruto: 734.4,
      valorLiquido: 734.4,
      vencimento: HOJE,
    });
    expect(r.ajuste).toBeNull();
  });

  it('sem assinatura e DTO vazio: padrões (nenhum módulo, mensal) e dia de hoje', async () => {
    const { svc, assinRepo } = make(null);
    const r = await svc.upsert(ATOR, {});
    expect(assinRepo.save.mock.calls[0][0]).toMatchObject({
      modulosAtivos: [],
      plano: PlanoPeriodo.Mensal,
    });
    expect(r.valor).toBe(0);
    await expect(svc.getCurrent(ATOR)).resolves.toBeDefined();
  });

  it('N-02: upgrade → downgrade sem pagar cancela a complementar e não gera crédito', async () => {
    // 255 → 127,50: −127,50 × 15/30 = 63,75, a complementar pendente de 63,75
    const { svc, fatRepo, assinRepo, audit } = make(
      assinatura({ modulosAtivos: AGENDA_PRONT }),
    );
    fatRepo.find.mockResolvedValue([
      {
        id: 'f9',
        valorBruto: 63.75,
        creditoAplicado: 0,
        valorLiquido: 63.75,
        status: 'pendente',
        itens: { motivo: 'pro-rata' },
      },
    ]);
    const r = await svc.upsert(
      ATOR,
      { modulosAtivos: [ModuleCode.Agenda] },
      HOJE,
    );
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
    expect(r.ajuste).toMatchObject({ tipo: 'credito', valor: 63.75 });
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
        reducoes: [{ em: HOJE, valor: 63.75 }],
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
    const { svc, fatRepo, audit } = make(
      assinatura({ modulosAtivos: AGENDA_PRONT }),
    );
    fatRepo.find.mockResolvedValue([
      { id: 'fa', valorBruto: 100, creditoAplicado: 0, status: 'pendente' },
      { id: 'fb', valorBruto: 40, creditoAplicado: 30, status: 'pendente' },
    ]);
    // redução de 63,75 — ver teste anterior
    await svc.upsert(ATOR, { modulosAtivos: [ModuleCode.Agenda] }, HOJE);
    expect(fatRepo.save).toHaveBeenCalledTimes(1);
    expect(fatRepo.save.mock.calls[0][0]).toMatchObject({
      id: 'fa',
      valorBruto: 36.25,
      valorLiquido: 36.25,
      status: 'pendente',
      itens: { reducoes: [{ em: HOJE, valor: 63.75 }] },
    });
    expect(audit.registrar).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'reduzir', resourceId: 'fa' }),
    );

    // crédito já aplicado: bruto 40 (30 de crédito) − 31,88 → bruto 8,12 coberto
    const mu = [ModuleCode.Agenda, ModuleCode.MultiplasUnidades];
    const m = make(assinatura({ modulosAtivos: mu }));
    m.fatRepo.find.mockResolvedValue([
      { id: 'fc', valorBruto: 40, creditoAplicado: 30, status: 'pendente' },
    ]);
    // sem Múltiplas unidades: −5 × 12,75 × 15/30 = 31,88
    const r = await m.svc.upsert(
      ATOR,
      { modulosAtivos: [ModuleCode.Agenda] },
      HOJE,
    );
    expect(m.fatRepo.save.mock.calls[0][0]).toMatchObject({
      valorBruto: 8.12,
      creditoAplicado: 8.12,
      valorLiquido: 0,
      status: 'paga',
    });
    expect(m.fatRepo.save.mock.calls[0][0].pagoEm).toBeInstanceOf(Date);
    expect(r.saldoCredito).toBe(21.88);
  });
});

describe('AssinaturaService.comReprecificacao (acessos)', () => {
  const gravar = jest.fn().mockResolvedValue('ok');

  it('sem assinatura (legado): só grava', async () => {
    const { svc, fatRepo } = make(null);
    await expect(
      svc.comReprecificacao('clinic', TENANT, gravar, HOJE),
    ).resolves.toBe('ok');
    expect(fatRepo.save).not.toHaveBeenCalled();
  });

  it('pessoa a mais no meio do ciclo → complementar dos assentos, auditada pelo produto', async () => {
    const { svc, acessoRepo, fatRepo, assinRepo, audit } = make(
      assinatura({ modulosAtivos: AGENDA_PRONT }),
    );
    // antes: 2 médicos; depois: + 1 recepção (Agenda, não Prontuário)
    acessoRepo.find
      .mockResolvedValueOnce(equipe(2))
      .mockResolvedValueOnce([
        ...equipe(2),
        { papel: 'recepcao', clinico: false },
      ]);
    await expect(
      svc.comReprecificacao('clinic', TENANT, gravar, HOJE),
    ).resolves.toBe('ok');
    // 102 → 127,50: +25,50 × 15/30 = 12,75
    expect(fatRepo.save.mock.calls[0][0]).toMatchObject({
      tipo: 'complementar',
      valorBruto: 12.75,
      itens: {
        motivo: 'assentos',
        numeroUsuarios: 3,
        assentos: expect.objectContaining({ agenda: 3, prontuario: 2 }),
      },
    });
    expect(assinRepo.save.mock.calls[0][0].numeroUsuarios).toBe(3);
    expect(audit.registrar).toHaveBeenCalledWith({
      produto: 'clinic',
      tenantId: TENANT,
      action: 'create',
      resource: 'fatura',
      resourceId: 'f1',
    });
  });

  it('pessoa a menos → abate a pendente (auditado) e reavalia a inadimplência', async () => {
    const { svc, acessoRepo, fatRepo, audit, ds } = make();
    acessoRepo.find
      .mockResolvedValueOnce(equipe(5))
      .mockResolvedValueOnce(equipe(4));
    fatRepo.find.mockResolvedValue([
      { id: 'fp', valorBruto: 12.75, creditoAplicado: 0, status: 'pendente' },
    ]);
    await svc.comReprecificacao('clinic', TENANT, gravar, HOJE);
    expect(fatRepo.save.mock.calls[0][0]).toMatchObject({
      id: 'fp',
      status: 'cancelada',
    });
    expect(audit.registrar).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'cancelar', resourceId: 'fp' }),
    );
    expect(ds.query).toHaveBeenCalled();
  });

  it('no trial não cobra', async () => {
    const { svc, acessoRepo, fatRepo } = make(
      assinatura({ emTrialAte: '2026-10-01' }),
    );
    acessoRepo.find
      .mockResolvedValueOnce(equipe(5))
      .mockResolvedValueOnce(equipe(9));
    await svc.comReprecificacao('clinic', TENANT, gravar);
    expect(fatRepo.save).not.toHaveBeenCalled();
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
      valorBruto: 127.5,
      creditoAplicado: 50,
      valorLiquido: 77.5,
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
