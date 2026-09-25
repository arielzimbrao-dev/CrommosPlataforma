/**
 * Catálogo de módulos e a **fórmula de cobrança** (Crommos/docs/03-precificacao.md),
 * portado do Clinic. Fonte da verdade do cálculo — não duplicar preços.
 *
 * Por ora um catálogo só (o do Clinic, o único produto em operação); o
 * catálogo próprio de Odonto e Vet é _a definir_.
 */
export enum ModuleCode {
  Agenda = 'agenda',
  Prontuario = 'prontuario',
  Financeiro = 'financeiro',
  Exames = 'exames',
  MultiplasUnidades = 'multiplas_unidades',
  Convenio = 'convenio',
}

export enum PlanoPeriodo {
  Mensal = 'mensal',
  Semestral = 'semestral',
  Anual = 'anual',
}

export interface ModuleInfo {
  code: ModuleCode;
  nome: string;
  /** Preço por usuário/mês na faixa base (1–5 pessoas). R$. */
  precoPorUsuario: number;
  /** Preço ainda não definido na precificação (a UI mostra "a definir"). */
  precoADefinir?: true;
}

export const MODULES: ModuleInfo[] = [
  { code: ModuleCode.Agenda, nome: 'Agenda', precoPorUsuario: 30 },
  { code: ModuleCode.Prontuario, nome: 'Prontuário', precoPorUsuario: 30 },
  { code: ModuleCode.Financeiro, nome: 'Financeiro', precoPorUsuario: 35 },
  { code: ModuleCode.Exames, nome: 'Exames', precoPorUsuario: 20 },
  {
    code: ModuleCode.MultiplasUnidades,
    nome: 'Múltiplas unidades',
    precoPorUsuario: 15,
  },
  // Convênio não consta na planilha de preços → "a definir" (0 por ora;
  // decisão do usuário, ver audit.md §4).
  {
    code: ModuleCode.Convenio,
    nome: 'Convênio',
    precoPorUsuario: 0,
    precoADefinir: true,
  },
];

export const DESCONTO_PLANO: Record<PlanoPeriodo, number> = {
  [PlanoPeriodo.Mensal]: 0,
  [PlanoPeriodo.Semestral]: 0.05,
  [PlanoPeriodo.Anual]: 0.2,
};

export const MODULE_CODES = MODULES.map((m) => m.code);

const precoDe = (code: ModuleCode): number =>
  MODULES.find((m) => m.code === code)?.precoPorUsuario ?? 0;

/**
 * Valor final da assinatura (R$/mês), conforme a fórmula:
 *   valor/usuário = Σ preços dos módulos contratados
 *   mensal        = valor/usuário × nº de usuários
 *   final         = mensal × (1 − desconto do plano)
 */
export function calcularValor(
  modulos: ModuleCode[],
  numeroUsuarios: number,
  plano: PlanoPeriodo,
): number {
  const valorPorUsuario = modulos.reduce((soma, c) => soma + precoDe(c), 0);
  const mensal = valorPorUsuario * numeroUsuarios;
  const final = mensal * (1 - DESCONTO_PLANO[plano]);
  return Math.round(final * 100) / 100;
}
