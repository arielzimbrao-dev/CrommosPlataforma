import { ConflictException, NotFoundException } from '@nestjs/common';
import { Acesso } from 'src/auth/acesso.entity';
import { Assinatura } from 'src/billing/assinatura.entity';
import { AssinaturaService, Ator } from 'src/billing/assinatura.service';
import {
  MODULE_CODES,
  ModuleCode,
  Nivel,
  PlanoPeriodo,
  TipoConsumo,
} from 'src/billing/modules.catalog';

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const HOJE = '2026-09-16';
const ATOR: Ator = { usuarioId: USER, produto: 'clinic', tenantId: TENANT };

/**
 * Assinatura padrão: Agenda com 5 pessoas (3 × 26,78 + 2 × 24,10) = R$ 128,54
 * por mês, ciclo de 30 dias. Os assentos vêm dos acessos (`equipe`): 5 médicos-admin.
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

function make(
  atual: Assinatura | null = assinatura(),
  pessoas = equipe(5),
  teleconsultas = 0,
  consumos: Partial<Record<TipoConsumo, number>> = {},
) {
  // COUNT das teleconsultas e dos consumos do ciclo; o resto (UPDATE)
  // devolve [linhas, n].
  const query = jest.fn((sql: string) =>
    Promise.resolve(
      sql.includes('crommos.teleconsultas')
        ? [{ n: teleconsultas }]
        : sql.includes('FROM crommos.consumos')
          ? Object.entries(consumos).map(([tipo, n]) => ({ tipo, n }))
          : [[], 0],
    ),
  );
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
    query,
  };
  const ds = {
    transaction: jest.fn((cb: (m: typeof em) => unknown) => cb(em)),
    query,
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
    {} as never,
  );
  return { svc, repo, faturas, assinRepo, fatRepo, acessoRepo, em, ds, audit };
}

describe('AssinaturaService — gating e leitura', () => {
  it('sem assinatura → nenhum módulo (fail-closed)', async () => {
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
    // escada: 3 × 26,78 + 2 × 24,10
    expect(view.valor).toBe(128.54);
    expect(view.numeroUsuarios).toBe(5);
    expect(view).not.toHaveProperty('faixa');
    expect(view).not.toHaveProperty('ajusteFaixa');
    expect(view.itens.find((i) => i.code === ModuleCode.Prontuario)).toEqual({
      code: ModuleCode.Prontuario,
      pessoas: 5,
      preco: 26.78,
      nivel: 'essencial',
      valorNivel: 0,
      degraus: [
        { qtd: 3, preco: 26.78 },
        { qtd: 2, preco: 24.1 },
      ],
      subtotal: 128.54,
    });
    // sem o módulo Telemedicina, nada de franquia
    expect(view.teleconsultas).toBeNull();
    expect(view.ciclo).toEqual({ inicio: '2026-09-01', fim: '2026-10-01' });
    expect(view.emTrial).toBe(true);
    expect(view.emTrialAte).toBe('2026-09-20');
    expect(view.saldoCredito).toBe(42.5);
    expect(view.trialConfirmado).toBe(false);
    expect(view.modoLeitura).toBeNull();
    expect(view.faturaVencida).toBeNull();
  });

  it('Telemedicina: teleconsultas do ciclo e a franquia (20 por assento/mês)', async () => {
    const { svc, ds } = make(
      assinatura({
        modulosAtivos: [ModuleCode.Agenda, ModuleCode.Telemedicina],
      }),
      [...equipe(2), ...equipe(3, 'recepcao', false)],
      27,
    );
    const view = await svc.getCurrent(ATOR, HOJE);
    expect(view.teleconsultas).toEqual({ realizadas: 27, incluidas: 40 });
    expect(ds.query).toHaveBeenCalledWith(
      expect.stringContaining('crommos.teleconsultas'),
      ['clinic', TENANT, '2026-09-01', '2026-10-01'],
    );
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
      valorBruto: 53.56,
      vencimento: HOJE,
      status: 'pendente',
    });
  });
});

const AGENDA_PRONT = [ModuleCode.Agenda, ModuleCode.Prontuario];

describe('AssinaturaService.simular', () => {
  it('devolve o valor, os assentos e o pró-rata que seria gerado', async () => {
    const { svc } = make();
    // 128,54 → 257,08 (+ Prontuário, 5 assentos), 15 de 30 dias → 64,27
    const r = await svc.simular(
      ATOR,
      { modulos: AGENDA_PRONT, plano: PlanoPeriodo.Mensal },
      HOJE,
    );
    expect(r.valor).toBe(257.08);
    expect(r.valorAtual).toBe(128.54);
    expect(r.numeroUsuarios).toBe(5);
    expect(r.ajuste).toMatchObject({ tipo: 'complementar', valor: 64.27 });
    expect(r.reducao).toBeNull();
  });

  it('adicionar: impacto de ativar uma pessoa (a 6ª paga o 2º degrau)', async () => {
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
    // 128,54 + 24,10 (6º assento da Agenda)
    expect(r).toMatchObject({
      valorAtual: 128.54,
      valor: 152.64,
      numeroUsuarios: 6,
    });
    expect(r).not.toHaveProperty('faixa');
    expect(r.itens.find((i) => i.code === ModuleCode.Prontuario)?.pessoas).toBe(
      5,
    );
  });

  it('remover e trocar o papel (remover + adicionar) de uma pessoa', async () => {
    const { svc } = make(assinatura(), [
      ...equipe(4),
      { papel: 'recepcao', clinico: false },
    ]);
    const modulos = [ModuleCode.Agenda, ModuleCode.Financeiro];
    // hoje: Agenda 128,54 (5) + Financeiro 3 × 31,24 + 28,12 = 250,38
    const sem = await svc.simular(
      ATOR,
      { modulos, plano: PlanoPeriodo.Mensal, remover: { papel: 'recepcao' } },
      HOJE,
    );
    expect(sem).toMatchObject({ valor: 226.28, numeroUsuarios: 4 });
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
    expect(troca).toMatchObject({ valor: 254.4, numeroUsuarios: 5 });
    // prefere quem tem o mesmo vínculo clínico; sem ninguém do papel, nada muda
    const nada = await svc.simular(
      ATOR,
      { modulos, plano: PlanoPeriodo.Mensal, remover: { papel: 'gestor' } },
      HOJE,
    );
    expect(nada.valor).toBe(250.38);
  });

  it('escada: a 11ª pessoa só soma o preço do assento dela (sem ajuste de virada)', async () => {
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
    // 3 × 26,78 + 7 × 24,10 = 249,04 → + 21,42
    expect(r).toMatchObject({ valorAtual: 249.04, valor: 270.46 });
    expect(r).not.toHaveProperty('ajusteFaixa');
  });

  it('redução mostra quanto abate da fatura pendente e quanto vira crédito', async () => {
    const { svc, faturas } = make(assinatura({ modulosAtivos: AGENDA_PRONT }));
    faturas.find.mockResolvedValue([{ valorBruto: 50, creditoAplicado: 0 }]);
    // 257,08 → 128,54: 64,27 de redução; 50 abatem a pendente, 14,27 viram crédito
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
    expect(r.reducao).toEqual({ abatidoEmPendentes: 50, credito: 14.27 });
  });

  it('sem assinatura → ajuste nulo', async () => {
    const { svc } = make(null, equipe(2));
    const r = await svc.simular(
      ATOR,
      { modulos: [ModuleCode.Agenda], plano: PlanoPeriodo.Mensal },
      HOJE,
    );
    expect(r).toMatchObject({
      valor: 53.56,
      valorAtual: 0,
      ajuste: null,
      reducao: null,
      primeiraFatura: {
        valorLiquido: 53.56,
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

  it('trial expirado (modo leitura) → 1ª fatura = 1º ciclo a partir de hoje', async () => {
    const r = await simularAgenda2(
      assinatura({
        cicloInicio: '2026-09-01',
        cicloFim: '2026-09-15',
        emTrialAte: '2026-09-15',
        saldoCredito: 10,
      }),
    );
    expect(r.primeiraFatura).toEqual({
      valorLiquido: 43.56,
      periodoInicio: HOJE,
      periodoFim: '2026-10-16',
      vencimento: HOJE,
    });
  });

  it('trial ativo → 1ª fatura = a do fim do trial (semestral: 6 meses)', async () => {
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
      valorLiquido: 305.28, // 50,88/mês (5% do semestral) × 6
      periodoInicio: '2026-09-30',
      periodoFim: '2027-03-30',
      vencimento: '2026-09-30',
    });
  });

  it('assinatura paga (fora do trial) → sem 1ª fatura', async () => {
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
    expect(r.valor).toBe(257.08);
    expect(r.ajuste).toMatchObject({ tipo: 'complementar', valor: 64.27 });
    const fatura = fatRepo.save.mock.calls[0][0];
    expect(fatura).toMatchObject({
      tenantId: TENANT,
      assinaturaId: 'a1',
      tipo: 'complementar',
      periodoInicio: HOJE,
      periodoFim: '2026-10-01',
      valorBruto: 64.27,
      creditoAplicado: 0,
      valorLiquido: 64.27,
      status: 'pendente',
      vencimento: HOJE,
      createdBy: USER,
    });
    expect(r.fatura).toMatchObject({ id: 'f1', valorLiquido: 64.27 });
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
      valorBruto: 64.27,
      creditoAplicado: 64.27,
      valorLiquido: 0,
      status: 'paga',
    });
    expect(f.pagoEm).toBeInstanceOf(Date);
    expect(assinRepo.save.mock.calls[0][0].saldoCredito).toBe(35.73);
  });

  it('downgrade soma crédito e não gera fatura', async () => {
    const { svc, fatRepo, assinRepo } = make(assinatura({ saldoCredito: 10 }));
    const r = await svc.upsert(ATOR, { modulosAtivos: [] }, HOJE);
    // 128,54 → 0: −128,54 × 15/30 = 64,27 de crédito
    expect(r.ajuste).toMatchObject({ tipo: 'credito', valor: 64.27 });
    expect(r.fatura).toBeNull();
    expect(fatRepo.save).not.toHaveBeenCalled();
    expect(assinRepo.save.mock.calls[0][0].saldoCredito).toBe(74.27);
    expect(r.saldoCredito).toBe(74.27);
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
    // consultório 80,34 × 0,9 = 72,31/mês; anual → 867,72
    expect(r.valor).toBe(72.31);
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
      valorBruto: 867.72,
      valorLiquido: 867.72,
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

  it('upgrade → downgrade sem pagar cancela a complementar e não gera crédito', async () => {
    // 255 → 127,50: −127,50 × 15/30 = 63,75, a complementar pendente de 63,75
    const { svc, fatRepo, assinRepo, audit } = make(
      assinatura({ modulosAtivos: AGENDA_PRONT }),
    );
    fatRepo.find.mockResolvedValue([
      {
        id: 'f9',
        valorBruto: 64.27,
        creditoAplicado: 0,
        valorLiquido: 64.27,
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
    expect(r.ajuste).toMatchObject({ tipo: 'credito', valor: 64.27 });
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
        reducoes: [{ em: HOJE, valor: 64.27 }],
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

  it('redução parcial só reduz a pendente; crédito devolvido quita e marca paga', async () => {
    const { svc, fatRepo, audit } = make(
      assinatura({ modulosAtivos: AGENDA_PRONT }),
    );
    fatRepo.find.mockResolvedValue([
      { id: 'fa', valorBruto: 100, creditoAplicado: 0, status: 'pendente' },
      { id: 'fb', valorBruto: 40, creditoAplicado: 30, status: 'pendente' },
    ]);
    // redução de 62,93 — ver teste anterior
    await svc.upsert(ATOR, { modulosAtivos: [ModuleCode.Agenda] }, HOJE);
    expect(fatRepo.save).toHaveBeenCalledTimes(1);
    expect(fatRepo.save.mock.calls[0][0]).toMatchObject({
      id: 'fa',
      valorBruto: 35.73,
      valorLiquido: 35.73,
      status: 'pendente',
      itens: { reducoes: [{ em: HOJE, valor: 64.27 }] },
    });
    expect(audit.registrar).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'reduzir', resourceId: 'fa' }),
    );

    // crédito já aplicado: bruto 40 (30 de crédito) − 32,14 → bruto 7,86 coberto
    const mu = [ModuleCode.Agenda, ModuleCode.MultiplasUnidades];
    const m = make(assinatura({ modulosAtivos: mu }));
    m.fatRepo.find.mockResolvedValue([
      { id: 'fc', valorBruto: 40, creditoAplicado: 30, status: 'pendente' },
    ]);
    // sem Múltiplas unidades: −(3 × 13,39 + 2 × 12,05) × 15/30 = 32,14
    const r = await m.svc.upsert(
      ATOR,
      { modulosAtivos: [ModuleCode.Agenda] },
      HOJE,
    );
    expect(m.fatRepo.save.mock.calls[0][0]).toMatchObject({
      valorBruto: 7.86,
      creditoAplicado: 7.86,
      valorLiquido: 0,
      status: 'paga',
    });
    expect(m.fatRepo.save.mock.calls[0][0].pagoEm).toBeInstanceOf(Date);
    expect(r.saldoCredito).toBe(22.14);
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
    // +26,78 × 15/30 = 13,39
    expect(fatRepo.save.mock.calls[0][0]).toMatchObject({
      tipo: 'complementar',
      valorBruto: 13.39,
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
      // 5 → 4 na Agenda: −24,10 × 15/30 = 12,05
      { id: 'fp', valorBruto: 12.05, creditoAplicado: 0, status: 'pendente' },
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

  it('pagarPelaPlataforma: baixa fora do tenant, condicional e auditada', async () => {
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
    ds.query
      .mockResolvedValueOnce([[], 2] as never)
      .mockResolvedValueOnce([[], 1] as never);
    await expect(svc.atualizarInadimplencia(HOJE)).resolves.toBe(3);
    expect((ds.query.mock.calls[0] as unknown[])[1]).toEqual([HOJE, 7]);
    ds.query.mockResolvedValue(undefined as never);
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
      valorBruto: 128.54,
      creditoAplicado: 50,
      valorLiquido: 78.54,
      status: 'pendente',
      vencimento: '2026-09-16',
    });
    expect(assinRepo.save.mock.calls[0][0]).toMatchObject({
      cicloInicio: '2026-09-16',
      cicloFim: '2026-10-16',
      saldoCredito: 0,
    });
  });

  it('Telemedicina: teleconsultas além da franquia entram na fatura seguinte como item separado', async () => {
    const vencida = assinatura({
      modulosAtivos: [ModuleCode.Agenda, ModuleCode.Telemedicina],
      cicloFim: '2026-09-16',
      cicloInicio: '2026-08-16',
    });
    // 5 médicos: franquia 100; 107 realizadas → 7 × R$ 2,00
    const { svc, fatRepo, em } = make(vencida, equipe(5), 107);
    await expect(svc.renovarVencidas(HOJE)).resolves.toBe(1);
    // Agenda 128,54 + Telemedicina 3 × 44,63 + 2 × 40,17 = 342,77; + 14
    expect(fatRepo.save.mock.calls[0][0]).toMatchObject({
      valorBruto: 356.77,
      valorLiquido: 356.77,
      itens: expect.objectContaining({
        valorMensal: 342.77,
        teleconsultasExcedentes: {
          quantidade: 7,
          valorUnitario: 2,
          valor: 14,
          realizadas: 107,
          incluidas: 100,
        },
      }),
    });
    expect(em.query).toHaveBeenCalledWith(
      expect.stringContaining('crommos.teleconsultas'),
      ['clinic', TENANT, '2026-08-16', '2026-09-16'],
    );
  });

  it('Telemedicina: dentro da franquia, ou fechando o ciclo do trial, não cobra teleconsulta', async () => {
    const tele = [ModuleCode.Telemedicina];
    const dentro = make(
      assinatura({
        modulosAtivos: tele,
        cicloInicio: '2026-08-16',
        cicloFim: '2026-09-16',
      }),
      equipe(5),
      100,
    );
    await dentro.svc.renovarVencidas(HOJE);
    expect(dentro.fatRepo.save.mock.calls[0][0].itens).not.toHaveProperty(
      'teleconsultasExcedentes',
    );
    const trial = make(
      assinatura({
        modulosAtivos: tele,
        cicloInicio: '2026-09-02',
        cicloFim: '2026-09-16',
        emTrialAte: '2026-09-16',
        trialConfirmadoEm: new Date(),
      }),
      equipe(1),
      500,
    );
    await trial.svc.renovarVencidas(HOJE);
    expect(trial.fatRepo.save.mock.calls[0][0].valorBruto).toBe(44.63);
    expect(trial.em.query).not.toHaveBeenCalled();
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

describe('AssinaturaService — níveis e franquias (WhatsApp e NFS-e)', () => {
  const AG_FISCAL = [ModuleCode.Agenda, ModuleCode.Fiscal];

  it('getCurrent: nível de cada módulo e o consumo do ciclo × franquia do nível', async () => {
    const { svc, ds } = make(
      assinatura({
        modulosAtivos: AG_FISCAL,
        niveis: { [ModuleCode.Agenda]: Nivel.Profissional },
      }),
      equipe(5),
      0,
      { whatsapp: 1600, nfse: 90 },
    );
    const view = await svc.getCurrent(ATOR, HOJE);
    expect(view.niveis).toEqual({ agenda: 'profissional' });
    // Agenda 128,54 + 20 (Profissional); Fiscal Essencial 128,54
    expect(view.valor).toBe(277.08);
    expect(view.consumos).toEqual([
      {
        tipo: 'whatsapp',
        modulo: 'agenda',
        unidade: 'mensagens de WhatsApp',
        nivel: 'profissional',
        usados: 1600,
        incluidos: 600, // Profissional, por clínica
        excedente: 0.05,
      },
      {
        tipo: 'nfse',
        modulo: 'fiscal',
        unidade: 'notas fiscais',
        nivel: 'essencial',
        usados: 90,
        incluidos: 150, // Essencial, por clínica
        excedente: 0.15,
      },
    ]);
    expect(ds.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM crommos.consumos'),
      ['clinic', TENANT, '2026-09-01', '2026-10-01'],
    );
  });

  it('sem Agenda nem Fiscal: nenhuma franquia (e não consulta o consumo)', async () => {
    const { svc, ds } = make(
      assinatura({ modulosAtivos: [ModuleCode.Prontuario] }),
    );
    const view = await svc.getCurrent(ATOR, HOJE);
    expect(view.consumos).toEqual([]);
    expect(ds.query).not.toHaveBeenCalledWith(
      expect.stringContaining('FROM crommos.consumos'),
      expect.anything(),
    );
  });

  it('simular com outro nível: valor novo e o pró-rata da diferença', async () => {
    const { svc } = make(assinatura());
    const r = await svc.simular(
      ATOR,
      {
        modulos: [ModuleCode.Agenda],
        plano: PlanoPeriodo.Mensal,
        niveis: { agenda: Nivel.Avancado },
      },
      HOJE,
    );
    // Avançado: 128,54 + 45 = 173,54; atual 128,54
    expect(r).toMatchObject({ valor: 173.54, valorAtual: 128.54 });
    expect(r.ajuste).toMatchObject({ tipo: 'complementar', valor: 22.5 });
    expect(r.itens.find((i) => i.code === ModuleCode.Agenda)).toMatchObject({
      nivel: 'avancado',
      preco: 26.78,
    });
  });

  it('upsert grava o nível (mesclando com os atuais) e cobra a diferença no pró-rata', async () => {
    const { svc, assinRepo, fatRepo } = make(
      assinatura({
        modulosAtivos: AG_FISCAL,
        niveis: { [ModuleCode.Fiscal]: Nivel.Profissional },
      }),
    );
    const r = await svc.upsert(
      ATOR,
      { niveis: { agenda: Nivel.Profissional } },
      HOJE,
    );
    expect(assinRepo.save.mock.calls[0][0].niveis).toEqual({
      agenda: 'profissional',
      fiscal: 'profissional',
    });
    // Agenda Essencial → Profissional: +20/mês, metade do ciclo = 10
    expect(r.ajuste).toMatchObject({ tipo: 'complementar', valor: 10 });
    expect(fatRepo.save.mock.calls[0][0].itens).toMatchObject({
      niveis: { agenda: 'profissional', fiscal: 'profissional' },
    });
  });

  it('renovação: consumo além da franquia vira item da fatura seguinte', async () => {
    const vencida = assinatura({
      modulosAtivos: AG_FISCAL,
      cicloInicio: '2026-08-16',
      cicloFim: '2026-09-16',
    });
    // Essencial: 150 mensagens e 150 notas por clínica
    const { svc, fatRepo } = make(vencida, equipe(5), 0, {
      whatsapp: 400,
      nfse: 170,
    });
    await expect(svc.renovarVencidas(HOJE)).resolves.toBe(1);
    // 128,54 + 128,54 = 257,08; + 250 × 0,05 + 20 × 0,15 = 12,50 + 3,00
    expect(fatRepo.save.mock.calls[0][0]).toMatchObject({
      valorBruto: 272.58,
      itens: expect.objectContaining({
        valorMensal: 257.08,
        consumosExcedentes: [
          {
            tipo: 'whatsapp',
            modulo: 'agenda',
            unidade: 'mensagens de WhatsApp',
            nivel: 'essencial',
            usados: 400,
            incluidos: 150,
            quantidade: 250,
            valorUnitario: 0.05,
            valor: 12.5,
          },
          {
            tipo: 'nfse',
            modulo: 'fiscal',
            unidade: 'notas fiscais',
            nivel: 'essencial',
            usados: 170,
            incluidos: 150,
            quantidade: 20,
            valorUnitario: 0.15,
            valor: 3,
          },
        ],
      }),
    });
  });

  it('renovação dentro da franquia ou fechando o trial: sem item de consumo', async () => {
    const dentro = make(
      assinatura({
        modulosAtivos: AG_FISCAL,
        cicloInicio: '2026-08-16',
        cicloFim: '2026-09-16',
      }),
      equipe(5),
      0,
      { whatsapp: 150 },
    );
    await dentro.svc.renovarVencidas(HOJE);
    expect(dentro.fatRepo.save.mock.calls[0][0].itens).not.toHaveProperty(
      'consumosExcedentes',
    );
    const trial = make(
      assinatura({
        modulosAtivos: AG_FISCAL,
        cicloInicio: '2026-09-02',
        cicloFim: '2026-09-16',
        emTrialAte: '2026-09-16',
        trialConfirmadoEm: new Date(),
      }),
      equipe(1),
      0,
      { whatsapp: 9999 },
    );
    await trial.svc.renovarVencidas(HOJE);
    expect(trial.fatRepo.save.mock.calls[0][0].valorBruto).toBe(53.56);
  });

  it('registrarConsumo: idempotente pela referência', async () => {
    const { svc, ds } = make();
    await svc.registrarConsumo(
      'clinic',
      TENANT,
      TipoConsumo.Whatsapp,
      '33333333-3333-3333-3333-333333333333',
    );
    expect(ds.query).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO crommos.consumos[\s\S]*ON CONFLICT/),
      ['clinic', TENANT, 'whatsapp', '33333333-3333-3333-3333-333333333333'],
    );
  });
});
