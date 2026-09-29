import {
  MODULES,
  MODULE_CODES,
  ModuleCode,
  PessoaAcesso,
  PlanoPeriodo,
  calcularValor,
  contarAssentos,
  faixaDe,
  itensDe,
  precoNaFaixa,
} from 'src/billing/modules.catalog';

const { Agenda, Prontuario, Financeiro, Exames, MultiplasUnidades } =
  ModuleCode;
const PRECIFICADOS = [
  Agenda,
  Prontuario,
  Financeiro,
  Exames,
  MultiplasUnidades,
];

const p = (papel: string, clinico = false): PessoaAcesso => ({
  papel,
  clinico,
});
const repetir = (n: number, x: PessoaAcesso) =>
  Array.from({ length: n }, () => x);

describe('preços e faixas (planilha −15%)', () => {
  it('faixa base: Agenda 25,50; Prontuário 25,50; Financeiro 29,75; Exames 17; Múltiplas unidades 12,75', () => {
    expect(PRECIFICADOS.map((c) => precoNaFaixa(c, 5))).toEqual([
      25.5, 25.5, 29.75, 17, 12.75,
    ]);
  });

  it('faixas pelo total de pessoas: 6–10 −10%, 11–30 −20%, 31+ −30%', () => {
    expect(
      [1, 5, 6, 10, 11, 30, 31, 500].map((n) => faixaDe(n).desconto),
    ).toEqual([0, 0, 10, 10, 20, 20, 30, 30]);
    expect(precoNaFaixa(Agenda, 6)).toBe(22.95);
    expect(precoNaFaixa(Agenda, 11)).toBe(20.4);
    expect(precoNaFaixa(Agenda, 31)).toBe(17.85);
    // arredonda ao centavo em inteiros: 29,75 × 0,9 = 26,775 → 26,78
    expect(precoNaFaixa(Financeiro, 8)).toBe(26.78);
    expect(precoNaFaixa(MultiplasUnidades, 40)).toBe(8.93);
  });

  it('Convênio, Estoque, Fiscal e Telemedicina: preço a definir (não cobra)', () => {
    expect(MODULES.filter((m) => m.precoADefinir).map((m) => m.code)).toEqual([
      ModuleCode.Convenio,
      ModuleCode.Estoque,
      ModuleCode.Fiscal,
      ModuleCode.Telemedicina,
    ]);
    const todos = contarAssentos(repetir(3, p('admin', true)));
    expect(
      calcularValor(
        [
          ModuleCode.Convenio,
          ModuleCode.Estoque,
          ModuleCode.Fiscal,
          ModuleCode.Telemedicina,
        ],
        todos,
        PlanoPeriodo.Mensal,
      ),
    ).toBe(0);
    expect(MODULE_CODES).toEqual(
      expect.arrayContaining(['fiscal', 'telemedicina']),
    );
  });
});

describe('assentos derivados dos papéis', () => {
  it('Prontuário/Exames só quem é vinculado a profissional; Financeiro gestão; Agenda recepção e clínica; Múltiplas unidades todos', () => {
    const a = contarAssentos([
      p('admin', true), // médico dono
      p('profissional', true),
      p('profissional'), // sem vínculo: não abre o prontuário
      p('recepcao'),
      p('financeiro'),
      p('gestor', true), // gestor não abre o prontuário (papel)
    ]);
    expect(a.pessoas).toBe(6);
    expect(a.porModulo).toMatchObject({
      agenda: 5,
      prontuario: 2,
      exames: 2,
      financeiro: 3,
      multiplas_unidades: 6,
      convenio: 3,
      estoque: 6,
      fiscal: 3,
      telemedicina: 2,
    });
    expect(itensDe(a).find((i) => i.code === Agenda)).toEqual({
      code: Agenda,
      pessoas: 5,
      preco: 22.95,
    });
  });
});

describe('calcularValor (assento por módulo)', () => {
  // docs/03-precificacao.md — os três perfis de exemplo.
  it('consultório: 1 médico (admin) + 1 secretária, Agenda + Prontuário = 2×25,50 + 1×25,50', () => {
    const a = contarAssentos([p('admin', true), p('recepcao')]);
    expect(calcularValor([Agenda, Prontuario], a, PlanoPeriodo.Mensal)).toBe(
      76.5,
    );
  });

  it('clínica pequena: 3 médicos + 2 recepção + 1 financeiro, todos os módulos (faixa 6–10)', () => {
    const a = contarAssentos([
      p('admin', true),
      ...repetir(2, p('profissional', true)),
      ...repetir(2, p('recepcao')),
      p('financeiro'),
    ]);
    // Agenda 5×22,95 + Pront. 3×22,95 + Fin. 2×26,78 (admin + financeiro) + Exames 3×15,30 + MU 6×11,48
    expect(calcularValor(PRECIFICADOS, a, PlanoPeriodo.Mensal)).toBe(351.94);
    expect(calcularValor(PRECIFICADOS, a, PlanoPeriodo.Semestral)).toBe(334.34);
    expect(calcularValor(PRECIFICADOS, a, PlanoPeriodo.Anual)).toBe(281.55);
  });

  it('sem módulos ou módulo desconhecido → R$ 0', () => {
    const a = contarAssentos([p('admin', true)]);
    expect(calcularValor([], a, PlanoPeriodo.Anual)).toBe(0);
    expect(
      calcularValor(['legado' as ModuleCode], a, PlanoPeriodo.Mensal),
    ).toBe(0);
  });

  it('migração: nunca cobra mais que o modelo antigo (Σ preços × nº de usuários) com a mesma equipe', () => {
    const antigo = (n: number) => 130 * n; // 5 módulos × usuário, tabela antiga
    for (const n of [1, 2, 5, 6, 10, 11, 30, 31, 80]) {
      const a = contarAssentos(repetir(n, p('admin', true)));
      expect(
        calcularValor(PRECIFICADOS, a, PlanoPeriodo.Mensal),
      ).toBeLessThanOrEqual(antigo(n));
    }
  });
});
