import {
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

describe('QA-157: proteção na virada de faixa', () => {
  const doc = {
    consultorio: [p('admin', true), p('recepcao')],
    pequena: [
      p('admin', true),
      ...repetir(2, p('profissional', true)),
      ...repetir(2, p('recepcao')),
      p('financeiro'),
    ],
    media: [
      p('admin', true),
      ...repetir(9, p('profissional', true)),
      ...repetir(5, p('recepcao')),
      ...repetir(2, p('financeiro')),
      p('gestor'),
    ],
  };

  it('só Agenda: 10 pessoas 229,50; 11 pessoas continua 229,50 (+5,10 de ajuste); 12 pessoas 244,80', () => {
    const a = (n: number) => contarAssentos(repetir(n, p('recepcao')));
    expect(calcularValor([Agenda], a(10), PlanoPeriodo.Mensal)).toBe(229.5);
    expect(calcularValor([Agenda], a(11), PlanoPeriodo.Mensal)).toBe(229.5);
    expect(ajusteVirada([Agenda], a(11))).toBe(5.1);
    expect(calcularValor([Agenda], a(12), PlanoPeriodo.Mensal)).toBe(244.8);
    expect(ajusteVirada([Agenda], a(12))).toBe(0);
    // dentro da faixa nada muda; 30 → 31 também protegido
    expect(ajusteVirada([Agenda], a(10))).toBe(0);
    expect(calcularValor([Agenda], a(31), PlanoPeriodo.Mensal)).toBe(612);
  });

  it('o ajuste entra antes do desconto do plano', () => {
    const a = contarAssentos(repetir(11, p('recepcao')));
    expect(calcularValor([Agenda], a, PlanoPeriodo.Anual)).toBe(183.6);
  });

  it('os três perfis de docs/03-precificacao.md não mudam', () => {
    const c = contarAssentos(doc.consultorio);
    expect(calcularValor([Agenda, Prontuario], c, PlanoPeriodo.Mensal)).toBe(
      76.5,
    );
    expect(
      calcularValor([Agenda, Prontuario, Financeiro], c, PlanoPeriodo.Mensal),
    ).toBe(106.25);
    const pq = contarAssentos(doc.pequena);
    const quatro = [Agenda, Prontuario, Financeiro, Exames];
    expect(calcularValor(quatro, pq, PlanoPeriodo.Mensal)).toBe(283.06);
    expect(ajusteVirada(quatro, pq)).toBe(0);
    const md = contarAssentos(doc.media);
    expect(calcularValor(PRECIFICADOS, md, PlanoPeriodo.Mensal)).toBe(945.2);
    expect(ajusteVirada(PRECIFICADOS, md)).toBe(0);
  });

  // Todas as combinações de módulos com preço.
  const combinacoes = Array.from({ length: 31 }, (_, i) =>
    PRECIFICADOS.filter((_, b) => ((i + 1) >> b) & 1),
  );
  const perfis = [
    p('admin', true),
    p('profissional', true),
    p('profissional'),
    p('recepcao'),
    p('financeiro'),
    p('gestor'),
  ];

  it('propriedade: equipe de um mesmo perfil, adicionar uma pessoa nunca reduz o valor (1 → 60)', () => {
    for (const mods of combinacoes)
      for (const perfil of perfis) {
        let antes = 0;
        for (let n = 1; n <= 60; n++) {
          const v = calcularValor(
            mods,
            contarAssentos(repetir(n, perfil)),
            PlanoPeriodo.Mensal,
          );
          expect(v).toBeGreaterThanOrEqual(antes);
          antes = v;
        }
      }
  });

  it('propriedade: equipe mista, adicionar uma pessoa que custa ao menos a média da equipe nunca reduz o valor', () => {
    // Pseudoaleatório determinístico (LCG): o teste é reproduzível.
    let semente = 157;
    const sorteio = (n: number) => {
      semente = (semente * 1103515245 + 12345) % 2 ** 31;
      return semente % n;
    };
    // Custo de uma pessoa (R$) numa equipe de `n` pessoas (preço da faixa de n).
    const custo = (mods: ModuleCode[], pessoa: PessoaAcesso, n: number) =>
      mods
        .filter((c) => contarAssentos([pessoa]).porModulo[c])
        .reduce((s, c) => s + precoNaFaixa(c, n), 0);
    let casos = 0;
    for (let i = 0; i < 4000; i++) {
      const mods = combinacoes[sorteio(combinacoes.length)];
      const equipe = Array.from(
        { length: 1 + sorteio(45) },
        () => perfis[sorteio(perfis.length)],
      );
      const nova = perfis[sorteio(perfis.length)];
      const n = equipe.length;
      // Média na faixa anterior à de n + 1 (a do piso da virada).
      const limite = [5, 10, 30].filter((l) => l <= n).pop() ?? n;
      const media = equipe.reduce((s, x) => s + custo(mods, x, limite), 0) / n;
      if (custo(mods, nova, limite) + 1e-9 < media) continue;
      casos++;
      expect(
        calcularValor(
          mods,
          contarAssentos([...equipe, nova]),
          PlanoPeriodo.Mensal,
        ),
      ).toBeGreaterThanOrEqual(
        calcularValor(mods, contarAssentos(equipe), PlanoPeriodo.Mensal),
      );
    }
    expect(casos).toBeGreaterThan(1000);
  });
});
