import {
  ESCADA,
  FRANQUIAS,
  FRANQUIA_TELECONSULTAS,
  MODULES,
  MODULE_CODES,
  ModuleCode,
  Nivel,
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
      agenda: 26.78,
      prontuario: 26.78,
      financeiro: 31.24,
      exames: 17.85,
      multiplas_unidades: 13.39,
      convenio: 35.7,
      fiscal: 26.78,
      estoque: 8.93,
      telemedicina: 44.63,
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
    ).toEqual([26.78, 26.78, 22.76, 22.76, 20.09, 20.09, 17.41, 17.41]);
    expect([1, 4].map((k) => precoAssento(Financeiro, k))).toEqual([
      31.24, 26.55,
    ]);
    expect([1, 4, 11].map((k) => precoAssento(Estoque, k))).toEqual([
      8.93, 7.59, 6.7,
    ]);
    expect([1, 4].map((k) => precoAssento(Telemedicina, k))).toEqual([
      44.63, 37.94,
    ]);
    expect(precoAssento('legado' as ModuleCode, 1)).toBe(0);
  });

  it('degraus e subtotal: "Agenda: 5 pessoas — 3 × R$ 26,78 + 2 × R$ 22,76 = R$ 125,86"', () => {
    expect(degrausDe(Agenda, 5)).toEqual([
      { qtd: 3, preco: 26.78 },
      { qtd: 2, preco: 22.76 },
    ]);
    expect(subtotalModulo(Agenda, 5)).toBe(125.86);
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
      preco: 26.78,
      nivel: Nivel.Essencial,
      degraus: [
        { qtd: 3, preco: 26.78 },
        { qtd: 2, preco: 22.76 },
      ],
      subtotal: 125.86,
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

  it('consultório: Agenda + Prontuário = 80,34; + Financeiro = 111,58', () => {
    expect(calcularValor([Agenda, Prontuario], consultorio, M)).toBe(80.34);
    expect(
      calcularValor([Agenda, Prontuario, Financeiro], consultorio, M),
    ).toBe(111.58);
  });

  // Cada assento arredondado ao centavo, como na tabela publicada (22,76 etc.).
  it('clínica pequena (Agenda, Prontuário, Financeiro, Exames) = 322,23', () => {
    expect(
      calcularValor([Agenda, Prontuario, Financeiro, Exames], pequena, M),
    ).toBe(322.23);
  });

  it('clínica média (+ Múltiplas unidades) = 1.080,02; com os 9 módulos = 1.853,56', () => {
    const cinco = [Agenda, Prontuario, Financeiro, Exames, MultiplasUnidades];
    expect(media.porModulo).toMatchObject({
      agenda: 16,
      prontuario: 10,
      financeiro: 4,
      multiplas_unidades: 18,
    });
    expect(calcularValor(cinco, media, M)).toBe(1080.02);
    expect(calcularValor(MODULE_CODES, media, M)).toBe(1853.56);
    expect(
      calcularValor([Convenio, Fiscal, Estoque, Telemedicina], media, M),
    ).toBe(773.54);
  });

  it('desconto do plano depois da escada: semestral −5%, anual −10%', () => {
    const quatro = [Agenda, Prontuario, Financeiro, Exames];
    expect(calcularValor(quatro, pequena, PlanoPeriodo.Semestral)).toBe(306.12);
    expect(calcularValor(quatro, pequena, PlanoPeriodo.Anual)).toBe(290.01);
  });

  it('nível da Agenda/Fiscal soma ao preço do assento (escada sobre o novo preço)', () => {
    const niveis = { [Agenda]: Nivel.Profissional, [Fiscal]: Nivel.Avancado };
    expect(precoAssento(Agenda, 4, Nivel.Profissional)).toBe(29.56);
    expect(precoAssento(Agenda, 1, Nivel.Avancado)).toBe(44.78);
    expect(subtotalModulo(Agenda, 5, Nivel.Profissional)).toBe(163.46);
    expect(subtotalModulo(Fiscal, 2, Nivel.Avancado)).toBe(103.56);
    // Módulo sem franquia ignora o nível.
    expect(subtotalModulo(Exames, 3, Nivel.Avancado)).toBe(53.55);
    expect(
      calcularValor(
        [Agenda, Prontuario, Financeiro, Exames],
        pequena,
        M,
        niveis,
      ),
    ).toBe(359.83); // 322,23 + (163,46 − 125,86)
    expect(
      itensDe(pequena, niveis).find((i) => i.code === Agenda),
    ).toMatchObject({
      nivel: Nivel.Profissional,
      preco: 34.78,
      subtotal: 163.46,
    });
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

describe('franquias por nível: WhatsApp na Agenda e NFS-e no Fiscal', () => {
  it('tabela aprovada pelo dono (03/10/2026)', () => {
    expect(
      FRANQUIAS.map((f) => [
        f.modulo,
        f.tipo,
        f.excedente,
        f.niveis.essencial,
        f.niveis.profissional,
        f.niveis.avancado,
      ]),
    ).toEqual([
      [
        Agenda,
        'whatsapp',
        0.05,
        { acrescimo: 0, porAssento: 150 },
        { acrescimo: 8, porAssento: 300 },
        { acrescimo: 18, porAssento: 600 },
      ],
      [
        Fiscal,
        'nfse',
        0.15,
        { acrescimo: 0, porAssento: 100 },
        { acrescimo: 10, porAssento: 300 },
        { acrescimo: 25, porAssento: 800 },
      ],
    ]);
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
