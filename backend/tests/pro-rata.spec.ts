import { PlanoPeriodo } from 'src/billing/modules.catalog';
import {
  abaterReducao,
  aplicarCredito,
  calcularProRata,
  diasEntre,
  emTrial,
  mesesEntre,
  renovarCiclo,
  somarDias,
  somarMeses,
} from 'src/billing/pro-rata';

describe('pró-rata — datas', () => {
  it('diasEntre conta dias corridos (fim exclusivo)', () => {
    expect(diasEntre('2026-09-01', '2026-10-01')).toBe(30);
    expect(diasEntre('2026-02-01', '2026-03-01')).toBe(28);
    expect(diasEntre('2028-02-01', '2028-03-01')).toBe(29); // bissexto
    expect(diasEntre('2026-01-01', '2027-01-01')).toBe(365);
    expect(diasEntre('2026-09-10', '2026-09-10')).toBe(0);
  });

  it('somarDias atravessa mês e ano', () => {
    expect(somarDias('2026-12-25', 14)).toBe('2027-01-08');
    expect(somarDias('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('somarMeses limita ao último dia do mês (igual ao Postgres)', () => {
    expect(somarMeses('2026-01-31', 1)).toBe('2026-02-28');
    expect(somarMeses('2028-01-31', 1)).toBe('2028-02-29');
    expect(somarMeses('2026-08-31', 6)).toBe('2027-02-28');
    expect(somarMeses('2026-09-15', 12)).toBe('2027-09-15');
    expect(somarMeses('2026-11-30', 1)).toBe('2026-12-30');
  });

  it('mesesEntre ignora o dia (ciclos com dia limitado)', () => {
    expect(mesesEntre('2026-01-31', '2026-02-28')).toBe(1);
    expect(mesesEntre('2026-08-31', '2027-02-28')).toBe(6);
    expect(mesesEntre('2026-09-15', '2027-09-15')).toBe(12);
  });

  it('emTrial: ativo até o dia anterior a emTrialAte', () => {
    expect(emTrial('2026-10-09', '2026-10-08')).toBe(true);
    expect(emTrial('2026-10-09', '2026-10-09')).toBe(false);
    expect(emTrial(null, '2026-10-09')).toBe(false);
  });
});

describe('calcularProRata', () => {
  const ciclo = { cicloInicio: '2026-09-01', cicloFim: '2026-10-01' }; // 30 dias

  it('exemplo do usuário: R$ 500 → R$ 1.000 faltando 15 de 30 dias = R$ 250 complementar', () => {
    const r = calcularProRata({
      ...ciclo,
      hoje: '2026-09-16',
      valorMensalAnterior: 500,
      valorMensalNovo: 1000,
    });
    expect(r).toMatchObject({
      tipo: 'complementar',
      valor: 250,
      diasRestantes: 15,
      diasCiclo: 30,
      mesesCiclo: 1,
    });
  });

  it('redução vira crédito (valor positivo)', () => {
    const r = calcularProRata({
      ...ciclo,
      hoje: '2026-09-16',
      valorMensalAnterior: 1000,
      valorMensalNovo: 500,
    });
    expect(r.tipo).toBe('credito');
    expect(r.valor).toBe(250);
  });

  it('sem mudança de valor → nenhum', () => {
    const r = calcularProRata({
      ...ciclo,
      hoje: '2026-09-16',
      valorMensalAnterior: 300,
      valorMensalNovo: 300,
    });
    expect(r).toMatchObject({ tipo: 'nenhum', valor: 0 });
  });

  it('arredonda em centavos inteiros (meio centavo para longe do zero, simétrico)', () => {
    // 10,00 × 10/30 = 3,333… → 3,33
    expect(
      calcularProRata({
        ...ciclo,
        hoje: '2026-09-21',
        valorMensalAnterior: 0,
        valorMensalNovo: 10,
      }).valor,
    ).toBe(3.33);
    // 0,01 × 15/30 = 0,005 → 0,01 (sobe) e simétrico na redução
    const up = calcularProRata({
      ...ciclo,
      hoje: '2026-09-16',
      valorMensalAnterior: 100,
      valorMensalNovo: 100.01,
    });
    const down = calcularProRata({
      ...ciclo,
      hoje: '2026-09-16',
      valorMensalAnterior: 100.01,
      valorMensalNovo: 100,
    });
    expect(up).toMatchObject({ tipo: 'complementar', valor: 0.01 });
    expect(down).toMatchObject({ tipo: 'credito', valor: 0.01 });
  });

  it('evita erro de ponto flutuante (0,1 + 0,2)', () => {
    const r = calcularProRata({
      ...ciclo,
      hoje: '2026-09-01',
      valorMensalAnterior: 0.1,
      valorMensalNovo: 0.3,
    });
    expect(r.valor).toBe(0.2);
  });

  it('no 1º dia do ciclo cobra a diferença inteira', () => {
    const r = calcularProRata({
      ...ciclo,
      hoje: '2026-09-01',
      valorMensalAnterior: 500,
      valorMensalNovo: 1000,
    });
    expect(r).toMatchObject({ valor: 500, diasRestantes: 30 });
  });

  it('no último dia do ciclo cobra 1 dia', () => {
    const r = calcularProRata({
      ...ciclo,
      hoje: '2026-09-30',
      valorMensalAnterior: 500,
      valorMensalNovo: 1100,
    });
    // 600 × 1/30 = 20
    expect(r).toMatchObject({
      tipo: 'complementar',
      valor: 20,
      diasRestantes: 1,
    });
  });

  it('ciclo vencido (renovação pendente) → nenhum ajuste', () => {
    const r = calcularProRata({
      ...ciclo,
      hoje: '2026-10-03',
      valorMensalAnterior: 500,
      valorMensalNovo: 1000,
    });
    expect(r).toMatchObject({ tipo: 'nenhum', valor: 0, diasRestantes: 0 });
  });

  it('hoje antes do início do ciclo é limitado ao ciclo inteiro', () => {
    const r = calcularProRata({
      ...ciclo,
      hoje: '2026-08-20',
      valorMensalAnterior: 500,
      valorMensalNovo: 1000,
    });
    expect(r.diasRestantes).toBe(30);
    expect(r.valor).toBe(500);
  });

  it('mudança dupla no mesmo ciclo: cada uma sobre o valor vigente', () => {
    const base = { ...ciclo, hoje: '2026-09-16' };
    const a = calcularProRata({
      ...base,
      valorMensalAnterior: 500,
      valorMensalNovo: 1000,
    });
    const b = calcularProRata({
      ...base,
      valorMensalAnterior: 1000,
      valorMensalNovo: 800,
    });
    expect(a).toMatchObject({ tipo: 'complementar', valor: 250 });
    expect(b).toMatchObject({ tipo: 'credito', valor: 100 });
    // saldo líquido = (800 − 500) × 15/30
    expect(a.valor - b.valor).toBe(150);
  });

  it('semestral: diferença mensal × 6 meses × dias restantes / dias do ciclo', () => {
    // 2026-09-01 → 2027-03-01 = 181 dias; restam 90 (a partir de 2026-12-01)
    const r = calcularProRata({
      cicloInicio: '2026-09-01',
      cicloFim: '2027-03-01',
      hoje: '2026-12-01',
      valorMensalAnterior: 95,
      valorMensalNovo: 190,
    });
    expect(r.mesesCiclo).toBe(6);
    expect(r.diasCiclo).toBe(181);
    expect(r.diasRestantes).toBe(90);
    // 95 × 6 = 570; 570 × 90/181 = 283,425… → 283,43
    expect(r.valor).toBe(283.43);
  });

  it('anual: diferença mensal × 12', () => {
    const r = calcularProRata({
      cicloInicio: '2026-01-01',
      cicloFim: '2027-01-01',
      hoje: '2026-07-02', // restam 183 de 365
      valorMensalAnterior: 1040,
      valorMensalNovo: 520,
    });
    // 520 × 12 = 6240; × 183/365 = 3128,547… → 3128,55 de crédito
    expect(r).toMatchObject({
      tipo: 'credito',
      valor: 3128.55,
      mesesCiclo: 12,
    });
  });

  it('durante o trial não gera cobrança nem crédito', () => {
    const r = calcularProRata({
      cicloInicio: '2026-09-25',
      cicloFim: '2026-10-09',
      emTrialAte: '2026-10-09',
      hoje: '2026-09-30',
      valorMensalAnterior: 130,
      valorMensalNovo: 1300,
    });
    expect(r).toMatchObject({ tipo: 'nenhum', valor: 0, emTrial: true });
  });
});

describe('aplicarCredito', () => {
  it('abate o crédito até o valor da fatura', () => {
    expect(aplicarCredito(100, 30)).toEqual({
      creditoAplicado: 30,
      valorLiquido: 70,
      saldoRestante: 0,
    });
  });

  it('crédito maior que a fatura continua como saldo', () => {
    expect(aplicarCredito(100, 250.5)).toEqual({
      creditoAplicado: 100,
      valorLiquido: 0,
      saldoRestante: 150.5,
    });
  });

  it('sem crédito', () => {
    expect(aplicarCredito(0.3, 0)).toEqual({
      creditoAplicado: 0,
      valorLiquido: 0.3,
      saldoRestante: 0,
    });
  });
});

describe('renovarCiclo', () => {
  it('abre o próximo ciclo mensal a partir do fim do atual e cobra o valor novo', () => {
    const r = renovarCiclo({
      cicloFim: '2026-10-01',
      plano: PlanoPeriodo.Mensal,
      valorMensal: 1000,
      saldoCredito: 0,
    });
    expect(r).toEqual({
      cicloInicio: '2026-10-01',
      cicloFim: '2026-11-01',
      valorBruto: 1000,
      creditoAplicado: 0,
      valorLiquido: 1000,
      saldoCredito: 0,
    });
  });

  it('semestral e anual cobram o ciclo inteiro (mensal × meses)', () => {
    const s = renovarCiclo({
      cicloFim: '2026-08-31',
      plano: PlanoPeriodo.Semestral,
      valorMensal: 1235,
      saldoCredito: 0,
    });
    expect(s.cicloFim).toBe('2027-02-28');
    expect(s.valorBruto).toBe(7410);
    const a = renovarCiclo({
      cicloFim: '2026-10-01',
      plano: PlanoPeriodo.Anual,
      valorMensal: 1040,
      saldoCredito: 0,
    });
    expect(a.cicloFim).toBe('2027-10-01');
    expect(a.valorBruto).toBe(12480);
  });

  it('aplica o crédito acumulado; o excedente segue como saldo', () => {
    const r = renovarCiclo({
      cicloFim: '2026-10-01',
      plano: PlanoPeriodo.Mensal,
      valorMensal: 120,
      saldoCredito: 200,
    });
    expect(r).toMatchObject({
      valorBruto: 120,
      creditoAplicado: 120,
      valorLiquido: 0,
      saldoCredito: 80,
    });
  });
});

describe('pró-rata — redução com fatura pendente (N-02)', () => {
  it('sem pendentes, a redução inteira vira crédito', () => {
    expect(abaterReducao(60, [])).toEqual({ faturas: [], credito: 60 });
  });

  it('upgrade → downgrade sem pagar: zera a complementar e não gera crédito', () => {
    const r = abaterReducao(75, [{ valorBruto: 75, creditoAplicado: 0 }]);
    expect(r.credito).toBe(0);
    expect(r.faturas).toEqual([
      { valorBruto: 0, creditoAplicado: 0, valorLiquido: 0, abatido: 75 },
    ]);
  });

  it('redução menor que a pendente só reduz o valor', () => {
    const r = abaterReducao(30.1, [{ valorBruto: 75, creditoAplicado: 0 }]);
    expect(r.credito).toBe(0);
    expect(r.faturas[0]).toEqual({
      valorBruto: 44.9,
      creditoAplicado: 0,
      valorLiquido: 44.9,
      abatido: 30.1,
    });
  });

  it('o que excede as pendentes vira crédito; percorre em ordem', () => {
    const r = abaterReducao(100, [
      { valorBruto: 30, creditoAplicado: 0 },
      { valorBruto: 50, creditoAplicado: 0 },
    ]);
    expect(r.faturas.map((f) => f.abatido)).toEqual([30, 50]);
    expect(r.credito).toBe(20);
  });

  it('crédito já aplicado numa fatura reduzida volta ao saldo', () => {
    // bruto 75 com 60 de crédito (líquido 15); redução de 40 → bruto 35,
    // crédito aplicado 35, líquido 0; 25 de crédito voltam ao saldo.
    const r = abaterReducao(40, [{ valorBruto: 75, creditoAplicado: 60 }]);
    expect(r.faturas[0]).toEqual({
      valorBruto: 35,
      creditoAplicado: 35,
      valorLiquido: 0,
      abatido: 40,
    });
    expect(r.credito).toBe(25);
  });
});
