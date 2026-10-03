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

  it('escada por módulo: 1–3 cheio; 4–10 ×0,90; 11–30 ×0,80; 31+ ×0,70', () => {
    expect(ESCADA.map((d) => [d.de, d.ate, d.fator])).toEqual([
      [1, 3, 100],
      [4, 10, 90],
      [11, 30, 80],
      [31, null, 70],
    ]);
    // cada assento arredondado ao centavo (meio centavo para cima)
    expect(
      [1, 3, 4, 10, 11, 30, 31, 90].map((k) => precoAssento(Agenda, k)),
    ).toEqual([26.78, 26.78, 24.1, 24.1, 21.42, 21.42, 18.75, 18.75]);
    expect([1, 4].map((k) => precoAssento(Financeiro, k))).toEqual([
      31.24, 28.12,
    ]);
    expect([1, 4, 11].map((k) => precoAssento(Estoque, k))).toEqual([
      8.93, 8.04, 7.14,
    ]);
    expect([1, 4].map((k) => precoAssento(Telemedicina, k))).toEqual([
      44.63, 40.17,
    ]);
    expect(precoAssento('legado' as ModuleCode, 1)).toBe(0);
  });

  it('degraus e subtotal: "Agenda: 5 pessoas — 3 × R$ 26,78 + 2 × R$ 24,10 = R$ 128,54"', () => {
    expect(degrausDe(Agenda, 5)).toEqual([
      { qtd: 3, preco: 26.78 },
      { qtd: 2, preco: 24.1 },
    ]);
    expect(subtotalModulo(Agenda, 5)).toBe(128.54);
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
      valorNivel: 0,
      degraus: [
        { qtd: 3, preco: 26.78 },
        { qtd: 2, preco: 24.1 },
      ],
      subtotal: 128.54,
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
  it('clínica pequena (Agenda, Prontuário, Financeiro, Exames) = 324,91', () => {
    expect(
      calcularValor([Agenda, Prontuario, Financeiro, Exames], pequena, M),
    ).toBe(324.91);
  });

  it('clínica média (+ Múltiplas unidades) = 1.124,68; com os 9 módulos = 1.923,62', () => {
    const cinco = [Agenda, Prontuario, Financeiro, Exames, MultiplasUnidades];
    expect(media.porModulo).toMatchObject({
      agenda: 16,
      prontuario: 10,
      financeiro: 4,
      multiplas_unidades: 18,
    });
    expect(calcularValor(cinco, media, M)).toBe(1124.68);
    expect(calcularValor(MODULE_CODES, media, M)).toBe(1923.62);
    expect(
      calcularValor([Convenio, Fiscal, Estoque, Telemedicina], media, M),
    ).toBe(798.94);
  });

  it('desconto do plano depois da escada: semestral −5%, anual −10%', () => {
    const quatro = [Agenda, Prontuario, Financeiro, Exames];
    expect(calcularValor(quatro, pequena, PlanoPeriodo.Semestral)).toBe(308.66);
    expect(calcularValor(quatro, pequena, PlanoPeriodo.Anual)).toBe(292.42);
  });

  it('nível da Agenda/Fiscal: valor fixo por clínica, independente das pessoas (o plano desconta)', () => {
    const niveis = { [Agenda]: Nivel.Profissional, [Fiscal]: Nivel.Avancado };
    // Fiscal não contratado: o nível dele não soma.
    expect(
      calcularValor(
        [Agenda, Prontuario, Financeiro, Exames],
        pequena,
        M,
        niveis,
      ),
    ).toBe(344.91); // 324,91 + 20
    // Fiscal: 2 pessoas × 26,78 + 110 (Avançado); anual −10%.
    expect(calcularValor([Fiscal], pequena, M, niveis)).toBe(163.56);
    expect(calcularValor([Fiscal], pequena, PlanoPeriodo.Anual, niveis)).toBe(
      147.2,
    );
    // Módulo sem franquia ignora o nível.
    expect(
      calcularValor([Exames], pequena, M, { [Exames]: Nivel.Avancado }),
    ).toBe(53.55);
    expect(
      itensDe(pequena, niveis).find((i) => i.code === Agenda),
    ).toMatchObject({
      nivel: Nivel.Profissional,
      valorNivel: 20,
      preco: 26.78,
      subtotal: 128.54,
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
  it('tabela aprovada pelo dono (03/10/2026): valor e franquia por clínica/mês', () => {
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
        { valor: 0, incluidos: 150 },
        { valor: 20, incluidos: 600 },
        { valor: 45, incluidos: 1200 },
      ],
      [
        Fiscal,
        'nfse',
        0.15,
        { valor: 0, incluidos: 150 },
        { valor: 50, incluidos: 600 },
        { valor: 110, incluidos: 1200 },
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
