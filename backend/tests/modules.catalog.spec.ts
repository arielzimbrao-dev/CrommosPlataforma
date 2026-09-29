import {
  ESCADA,
  FRANQUIA_TELECONSULTAS,
  MODULES,
  MODULE_CODES,
  ModuleCode,
  PRECO_TELECONSULTA_EXCEDENTE,
  PessoaAcesso,
  PlanoPeriodo,
  calcularValor,
  contarAssentos,
  degrausDe,
  itensDe,
  precoAssento,
  subtotalModulo,
  teleconsultasExcedentes,
} from 'src/billing/modules.catalog';

const {
  Agenda,
  Prontuario,
  Financeiro,
  Exames,
  MultiplasUnidades,
  Convenio,
  Fiscal,
  Estoque,
  Telemedicina,
} = ModuleCode;

const p = (papel: string, clinico = false): PessoaAcesso => ({
  papel,
  clinico,
});
const repetir = (n: number, x: PessoaAcesso) =>
  Array.from({ length: n }, () => x);

describe('tabela de preços (aprovada pelo dono, docs/03)', () => {
  it('preço cheio por assento/mês dos 9 módulos, sem "a definir"', () => {
    expect(
      Object.fromEntries(MODULES.map((m) => [m.code, m.precoPorUsuario])),
    ).toEqual({
      agenda: 25.5,
      prontuario: 25.5,
      financeiro: 29.75,
      exames: 17,
      multiplas_unidades: 12.75,
      convenio: 34,
      fiscal: 25.5,
      estoque: 8.5,
      telemedicina: 42.5,
    });
    expect(MODULES.some((m) => 'precoADefinir' in m)).toBe(false);
    expect(MODULE_CODES).toHaveLength(9);
  });

  it('escada por módulo: 1–3 cheio; 4–10 ×0,85; 11–30 ×0,75; 31+ ×0,65', () => {
    expect(ESCADA.map((d) => [d.de, d.ate, d.fator])).toEqual([
      [1, 3, 100],
      [4, 10, 85],
      [11, 30, 75],
      [31, null, 65],
    ]);
    // cada assento arredondado ao centavo (meio centavo para cima)
    expect(
      [1, 3, 4, 10, 11, 30, 31, 90].map((k) => precoAssento(Agenda, k)),
    ).toEqual([25.5, 25.5, 21.68, 21.68, 19.13, 19.13, 16.58, 16.58]);
    expect([1, 4, 11, 31].map((k) => precoAssento(Financeiro, k))).toEqual([
      29.75, 25.29, 22.31, 19.34,
    ]);
    expect([1, 4, 11, 31].map((k) => precoAssento(Estoque, k))).toEqual([
      8.5, 7.23, 6.38, 5.53,
    ]);
    expect([1, 4, 11, 31].map((k) => precoAssento(Telemedicina, k))).toEqual([
      42.5, 36.13, 31.88, 27.63,
    ]);
    expect(precoAssento('legado' as ModuleCode, 1)).toBe(0);
  });

  it('degraus e subtotal: "Agenda: 5 pessoas — 3 × R$ 25,50 + 2 × R$ 21,68 = R$ 119,86"', () => {
    expect(degrausDe(Agenda, 5)).toEqual([
      { qtd: 3, preco: 25.5 },
      { qtd: 2, preco: 21.68 },
    ]);
    expect(subtotalModulo(Agenda, 5)).toBe(119.86);
    expect(degrausDe(Agenda, 0)).toEqual([]);
    expect(subtotalModulo(Agenda, 0)).toBe(0);
    expect(degrausDe(Exames, 35).map((d) => d.qtd)).toEqual([3, 7, 20, 5]);
  });
});

describe('assentos derivados dos papéis', () => {
  it('Prontuário/Exames/Telemedicina: clínicos; Financeiro/Convênio/Fiscal: gestão; Múltiplas unidades/Estoque: todos', () => {
    const a = contarAssentos([
      p('admin', true), // médico dono
      p('profissional', true),
      p('profissional'), // sem vínculo: não abre o prontuário
      p('recepcao'),
      p('financeiro'),
      p('gestor', true), // gestor não abre o prontuário (papel)
    ]);
    expect(a.pessoas).toBe(6);
    expect(a.porModulo).toEqual({
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
      preco: 25.5,
      degraus: [
        { qtd: 3, preco: 25.5 },
        { qtd: 2, preco: 21.68 },
      ],
      subtotal: 119.86,
    });
  });
});

describe('calcularValor — perfis de referência (mensal)', () => {
  const consultorio = contarAssentos([p('admin', true), p('recepcao')]);
  const pequena = contarAssentos([
    p('admin', true),
    ...repetir(2, p('profissional', true)),
    ...repetir(2, p('recepcao')),
    p('financeiro'),
  ]);
  const media = contarAssentos([
    p('admin', true),
    ...repetir(9, p('profissional', true)),
    ...repetir(5, p('recepcao')),
    ...repetir(2, p('financeiro')),
    p('gestor'),
  ]);
  const M = PlanoPeriodo.Mensal;

  it('consultório: Agenda + Prontuário = 76,50; + Financeiro = 106,25', () => {
    expect(calcularValor([Agenda, Prontuario], consultorio, M)).toBe(76.5);
    expect(
      calcularValor([Agenda, Prontuario, Financeiro], consultorio, M),
    ).toBe(106.25);
  });

  // A proposta (seção 1 do artefato) somou os assentos sem arredondar
  // (306,85 / 1.028,50 / 1.765,03). Com cada assento arredondado ao centavo,
  // como na tabela publicada (21,68 etc.), a conta bate com a fatura:
  it('clínica pequena (Agenda, Prontuário, Financeiro, Exames) = 306,86', () => {
    expect(
      calcularValor([Agenda, Prontuario, Financeiro, Exames], pequena, M),
    ).toBe(306.86);
  });

  it('clínica média (+ Múltiplas unidades) = 1.028,60; com os 9 módulos = 1.765,24', () => {
    const cinco = [Agenda, Prontuario, Financeiro, Exames, MultiplasUnidades];
    expect(media.porModulo).toMatchObject({
      agenda: 16,
      prontuario: 10,
      financeiro: 4,
      multiplas_unidades: 18,
    });
    expect(calcularValor(cinco, media, M)).toBe(1028.6);
    expect(calcularValor(MODULE_CODES, media, M)).toBe(1765.24);
    expect(
      calcularValor([Convenio, Fiscal, Estoque, Telemedicina], media, M),
    ).toBe(736.64);
  });

  it('desconto do plano depois da escada: semestral −5%, anual −20%', () => {
    const quatro = [Agenda, Prontuario, Financeiro, Exames];
    expect(calcularValor(quatro, pequena, PlanoPeriodo.Semestral)).toBe(291.52);
    expect(calcularValor(quatro, pequena, PlanoPeriodo.Anual)).toBe(245.49);
  });

  it('sem módulos ou módulo desconhecido → R$ 0', () => {
    expect(calcularValor([], consultorio, PlanoPeriodo.Anual)).toBe(0);
    expect(calcularValor(['legado' as ModuleCode], consultorio, M)).toBe(0);
  });
});

describe('propriedade: adicionar uma pessoa nunca reduz o valor', () => {
  const perfis = [
    p('admin', true),
    p('admin'),
    p('profissional', true),
    p('profissional'),
    p('recepcao'),
    p('financeiro'),
    p('gestor'),
    p('gestor', true),
  ];

  it('5.000 composições aleatórias (1–60 pessoas, módulos e planos variados)', () => {
    // Pseudoaleatório determinístico (LCG): o teste é reproduzível.
    let semente = 2026;
    const sorteio = (n: number) => {
      semente = (semente * 1103515245 + 12345) % 2 ** 31;
      return semente % n;
    };
    const planos = Object.values(PlanoPeriodo);
    for (let i = 0; i < 5000; i++) {
      const mods = MODULE_CODES.filter(() => sorteio(2) === 1);
      const plano = planos[sorteio(planos.length)];
      const equipe = Array.from(
        { length: 1 + sorteio(59) },
        () => perfis[sorteio(perfis.length)],
      );
      const nova = perfis[sorteio(perfis.length)];
      expect(
        calcularValor(mods, contarAssentos([...equipe, nova]), plano),
      ).toBeGreaterThanOrEqual(
        calcularValor(mods, contarAssentos(equipe), plano),
      );
    }
  });
});

describe('Telemedicina: franquia de teleconsultas', () => {
  it('20 por assento/mês incluídas; excedente R$ 2,00 cada', () => {
    expect(FRANQUIA_TELECONSULTAS).toBe(20);
    expect(PRECO_TELECONSULTA_EXCEDENTE).toBe(2);
    expect(teleconsultasExcedentes(40, 2)).toBe(0);
    expect(teleconsultasExcedentes(47, 2)).toBe(7);
    expect(teleconsultasExcedentes(5, 0)).toBe(5);
    // ciclo semestral/anual: franquia × meses do ciclo
    expect(teleconsultasExcedentes(130, 1, 6)).toBe(10);
  });
});
