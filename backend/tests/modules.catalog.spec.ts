import {
  MODULES,
  MODULE_CODES,
  ModuleCode,
  PlanoPeriodo,
  calcularValor,
} from 'src/billing/modules.catalog';

const TODOS_PRECIFICADOS = [
  ModuleCode.Agenda,
  ModuleCode.Prontuario,
  ModuleCode.Financeiro,
  ModuleCode.Exames,
  ModuleCode.MultiplasUnidades,
];

describe('calcularValor (fórmula de precificação)', () => {
  it('exemplo do doc: 10 usuários, todos os 5 módulos (R$130/usuário)', () => {
    expect(calcularValor(TODOS_PRECIFICADOS, 10, PlanoPeriodo.Mensal)).toBe(
      1300,
    );
    expect(calcularValor(TODOS_PRECIFICADOS, 10, PlanoPeriodo.Semestral)).toBe(
      1235,
    );
    expect(calcularValor(TODOS_PRECIFICADOS, 10, PlanoPeriodo.Anual)).toBe(
      1040,
    );
  });

  it('porta de entrada: 2 usuários, Agenda + Prontuário (R$60/usuário) mensal = 120', () => {
    expect(
      calcularValor(
        [ModuleCode.Agenda, ModuleCode.Prontuario],
        2,
        PlanoPeriodo.Mensal,
      ),
    ).toBe(120);
  });

  it('sem módulos → R$ 0', () => {
    expect(calcularValor([], 5, PlanoPeriodo.Anual)).toBe(0);
  });

  it('Convênio ainda não tem preço (a definir) → não altera o valor', () => {
    const base = calcularValor([ModuleCode.Agenda], 1, PlanoPeriodo.Mensal);
    const comConvenio = calcularValor(
      [ModuleCode.Agenda, ModuleCode.Convenio],
      1,
      PlanoPeriodo.Mensal,
    );
    expect(comConvenio).toBe(base);
    // explícito no catálogo para a UI mostrar "a definir" (não "grátis")
    expect(MODULES.filter((m) => m.precoADefinir).map((m) => m.code)).toEqual([
      ModuleCode.Convenio,
      ModuleCode.Estoque,
    ]);
  });

  it('Estoque entra no catálogo com preço a definir (não altera o valor)', () => {
    expect(MODULE_CODES).toContain(ModuleCode.Estoque);
    expect(calcularValor([ModuleCode.Estoque], 3, PlanoPeriodo.Mensal)).toBe(0);
  });
});

describe('catálogo', () => {
  it('Exames continua no catálogo', () => {
    expect(MODULE_CODES).toContain(ModuleCode.Exames);
  });
});
