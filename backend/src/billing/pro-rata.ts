/**
 * Cálculo **puro** do ciclo da assinatura e do ajuste pró-rata (ver
 * docs/billing-pro-rata.md). Datas são `YYYY-MM-DD`; dinheiro é calculado em
 * **centavos inteiros** e devolvido em R$ com 2 casas.
 *
 * Ciclo = [cicloInicio, cicloFim) — o fim é exclusivo (é o início do próximo).
 */
import { PlanoPeriodo } from './modules.catalog';

/** Duração do trial do signup (a precificação não define — "a definir"). */
export const DIAS_TRIAL = 14;

export const MESES_DO_PLANO: Record<PlanoPeriodo, number> = {
  [PlanoPeriodo.Mensal]: 1,
  [PlanoPeriodo.Semestral]: 6,
  [PlanoPeriodo.Anual]: 12,
};

const DIA_MS = 86_400_000;
const utc = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const centavos = (reais: number) => Math.round(reais * 100);
const reais = (cent: number) => cent / 100;

/** Dias corridos de `de` até `ate` (fim exclusivo). */
export const diasEntre = (de: string, ate: string) =>
  Math.round((utc(ate) - utc(de)) / DIA_MS);

export const somarDias = (data: string, dias: number) =>
  iso(utc(data) + dias * DIA_MS);

/** Soma meses limitando ao último dia do mês (como `date + interval` no Postgres). */
export function somarMeses(data: string, meses: number): string {
  const [a, m, d] = data.split('-').map(Number);
  const ultimoDia = new Date(Date.UTC(a, m - 1 + meses + 1, 0)).getUTCDate();
  return iso(Date.UTC(a, m - 1 + meses, Math.min(d, ultimoDia)));
}

/** Meses entre as datas pelo ano/mês (o dia pode ter sido limitado). */
export function mesesEntre(de: string, ate: string): number {
  const [a1, m1] = de.split('-').map(Number);
  const [a2, m2] = ate.split('-').map(Number);
  return (a2 - a1) * 12 + (m2 - m1);
}

/** Trial ativo enquanto hoje < emTrialAte (dia em que abre o 1º ciclo pago). */
export const emTrial = (emTrialAte: string | null | undefined, hoje: string) =>
  !!emTrialAte && hoje < emTrialAte;

export type TipoAjuste = 'nenhum' | 'complementar' | 'credito';

export interface AjusteProRata {
  tipo: TipoAjuste;
  /** R$ (sempre ≥ 0): cobrança complementar ou crédito, conforme `tipo`. */
  valor: number;
  diasRestantes: number;
  diasCiclo: number;
  mesesCiclo: number;
  valorMensalAnterior: number;
  valorMensalNovo: number;
  emTrial: boolean;
}

/**
 * Ajuste de uma mudança no meio do ciclo:
 *   (novo − anterior) × meses do ciclo × dias restantes / dias do ciclo
 * Positivo → cobrança complementar; negativo → crédito. No trial e com o ciclo
 * já vencido (renovação pendente) não há ajuste.
 */
export function calcularProRata(p: {
  cicloInicio: string;
  cicloFim: string;
  hoje: string;
  valorMensalAnterior: number;
  valorMensalNovo: number;
  emTrialAte?: string | null;
}): AjusteProRata {
  const diasCiclo = diasEntre(p.cicloInicio, p.cicloFim);
  const diasRestantes = Math.max(
    0,
    Math.min(diasCiclo, diasEntre(p.hoje, p.cicloFim)),
  );
  const mesesCiclo = mesesEntre(p.cicloInicio, p.cicloFim);
  const trial = emTrial(p.emTrialAte, p.hoje);
  const diferenca =
    (centavos(p.valorMensalNovo) - centavos(p.valorMensalAnterior)) *
    mesesCiclo;
  const bruto =
    trial || diasCiclo <= 0 ? 0 : (diferenca * diasRestantes) / diasCiclo;
  // Arredonda o módulo (meio centavo para longe do zero nos dois sentidos).
  const cent = Math.round(Math.abs(bruto));
  return {
    tipo: cent === 0 ? 'nenhum' : bruto > 0 ? 'complementar' : 'credito',
    valor: reais(cent),
    diasRestantes,
    diasCiclo,
    mesesCiclo,
    valorMensalAnterior: p.valorMensalAnterior,
    valorMensalNovo: p.valorMensalNovo,
    emTrial: trial,
  };
}

/** Abate o saldo de crédito de uma fatura; o excedente continua como saldo. */
export function aplicarCredito(valorBruto: number, saldo: number) {
  const bruto = centavos(valorBruto);
  const credito = Math.min(bruto, centavos(saldo));
  return {
    creditoAplicado: reais(credito),
    valorLiquido: reais(bruto - credito),
    saldoRestante: reais(centavos(saldo) - credito),
  };
}

/**
 * Redução no meio do ciclo (N-02): crédito só sobre valor **pago**. A redução
 * abate primeiro as faturas **pendentes** do ciclo (na ordem dada); o que
 * sobrar vira crédito. O crédito que já estava aplicado numa fatura abatida e
 * deixa de caber nela volta ao saldo. Bruto 0 → a fatura deve ser cancelada.
 */
export function abaterReducao(
  reducao: number,
  pendentes: { valorBruto: number; creditoAplicado: number }[],
) {
  let resto = centavos(reducao);
  let devolvido = 0;
  const faturas = pendentes.map((f) => {
    const bruto = centavos(f.valorBruto);
    const abatido = Math.min(resto, bruto);
    resto -= abatido;
    const novoBruto = bruto - abatido;
    const credito = Math.min(centavos(f.creditoAplicado), novoBruto);
    devolvido += centavos(f.creditoAplicado) - credito;
    return {
      valorBruto: reais(novoBruto),
      creditoAplicado: reais(credito),
      valorLiquido: reais(novoBruto - credito),
      abatido: reais(abatido),
    };
  });
  return { faturas, credito: reais(resto + devolvido) };
}

/**
 * Renovação: o próximo ciclo começa no fim do atual e é cobrado adiantado,
 * pelo valor vigente (mensal × meses do plano), menos o crédito acumulado.
 */
export function renovarCiclo(p: {
  cicloFim: string;
  plano: PlanoPeriodo;
  valorMensal: number;
  saldoCredito: number;
}) {
  const meses = MESES_DO_PLANO[p.plano];
  const valorBruto = reais(centavos(p.valorMensal) * meses);
  const c = aplicarCredito(valorBruto, p.saldoCredito);
  return {
    cicloInicio: p.cicloFim,
    cicloFim: somarMeses(p.cicloFim, meses),
    valorBruto,
    creditoAplicado: c.creditoAplicado,
    valorLiquido: c.valorLiquido,
    saldoCredito: c.saldoRestante,
  };
}
