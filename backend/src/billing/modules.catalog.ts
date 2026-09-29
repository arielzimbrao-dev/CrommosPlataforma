/**
 * Catálogo de módulos e a **fórmula de cobrança** (Crommos/docs/03-precificacao.md),
 * portado do Clinic. Fonte da verdade do cálculo — não duplicar preços.
 *
 * Modelo **assento por módulo**: cada módulo contratado cobra pelas pessoas
 * que têm acesso a ele (derivadas dos acessos ativos e dos papéis — a clínica
 * só escolhe os módulos). A faixa de porte vem do total de pessoas da clínica.
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
  Estoque = 'estoque',
  Fiscal = 'fiscal',
  Telemedicina = 'telemedicina',
}

export enum PlanoPeriodo {
  Mensal = 'mensal',
  Semestral = 'semestral',
  Anual = 'anual',
}

export interface ModuleInfo {
  code: ModuleCode;
  nome: string;
  /** Preço por pessoa com acesso (assento)/mês na faixa base (1–5 pessoas). R$. */
  precoPorUsuario: number;
  /** Preço ainda não definido na precificação (a UI mostra "a definir"). */
  precoADefinir?: true;
  /**
   * Quem ocupa assento (espelha o menu e os `@Roles` do Clinic): papéis com
   * acesso ao módulo; ausente = todas as pessoas da clínica.
   */
  papeis?: string[];
  /** Só conta quem está vinculado a um profissional de saúde (sigilo CFM). */
  clinico?: true;
}

// Papéis do Clinic (frontend/src/nav.ts de lá).
const AGENDA = ['admin', 'gestor', 'recepcao', 'profissional'];
const CLINICO = ['admin', 'profissional'];
const GESTAO_FINANCEIRA = ['admin', 'gestor', 'financeiro'];

export const MODULES: ModuleInfo[] = [
  {
    code: ModuleCode.Agenda,
    nome: 'Agenda',
    precoPorUsuario: 25.5,
    papeis: AGENDA,
  },
  {
    code: ModuleCode.Prontuario,
    nome: 'Prontuário',
    precoPorUsuario: 25.5,
    papeis: CLINICO,
    clinico: true,
  },
  {
    code: ModuleCode.Financeiro,
    nome: 'Financeiro',
    precoPorUsuario: 29.75,
    papeis: GESTAO_FINANCEIRA,
  },
  {
    code: ModuleCode.Exames,
    nome: 'Exames',
    precoPorUsuario: 17,
    papeis: CLINICO,
    clinico: true,
  },
  // Toda a equipe trabalha em várias unidades: conta todas as pessoas.
  {
    code: ModuleCode.MultiplasUnidades,
    nome: 'Múltiplas unidades',
    precoPorUsuario: 12.75,
  },
  // "A definir" (0 por ora): Convênio, Estoque, Fiscal e Telemedicina não
  // têm preço na precificação — a UI mostra "a definir", não "grátis".
  {
    code: ModuleCode.Convenio,
    nome: 'Convênio',
    precoPorUsuario: 0,
    precoADefinir: true,
    papeis: GESTAO_FINANCEIRA,
  },
  {
    code: ModuleCode.Estoque,
    nome: 'Estoque',
    precoPorUsuario: 0,
    precoADefinir: true,
    papeis: [...AGENDA, 'financeiro'],
  },
  {
    code: ModuleCode.Fiscal,
    nome: 'Fiscal (NFS-e, Receita Saúde e DMED)',
    precoPorUsuario: 0,
    precoADefinir: true,
    papeis: GESTAO_FINANCEIRA,
  },
  {
    code: ModuleCode.Telemedicina,
    nome: 'Telemedicina',
    precoPorUsuario: 0,
    precoADefinir: true,
    papeis: CLINICO,
    clinico: true,
  },
];

export const DESCONTO_PLANO: Record<PlanoPeriodo, number> = {
  [PlanoPeriodo.Mensal]: 0,
  [PlanoPeriodo.Semestral]: 0.05,
  [PlanoPeriodo.Anual]: 0.2,
};

/**
 * Faixas de porte pelo **total** de pessoas da clínica (planilha: 30 → 27 →
 * 24 → 21): desconto em % sobre o preço base. `ate` null = sem teto.
 */
export const FAIXAS = [
  { de: 1, ate: 5, desconto: 0 },
  { de: 6, ate: 10, desconto: 10 },
  { de: 11, ate: 30, desconto: 20 },
  { de: 31, ate: null, desconto: 30 },
] as const;

export type Faixa = (typeof FAIXAS)[number];

export const MODULE_CODES = MODULES.map((m) => m.code);

export const faixaDe = (pessoas: number): Faixa =>
  FAIXAS.find((f) => f.ate === null || pessoas <= f.ate) ?? FAIXAS[0];

/** Preço do módulo por assento na faixa (R$, arredondado ao centavo). */
export function precoNaFaixa(code: ModuleCode, pessoas: number): number {
  const base = MODULES.find((m) => m.code === code)?.precoPorUsuario ?? 0;
  // Em centavos inteiros: 29,75 × 90% = 26,775 → 26,78.
  const cent = Math.round(
    (Math.round(base * 100) * (100 - faixaDe(pessoas).desconto)) / 100,
  );
  return cent / 100;
}

/** Pessoa com acesso ativo (convite pendente incluso): o que conta assento. */
export interface PessoaAcesso {
  papel: string;
  clinico: boolean;
}

/** Assentos derivados: total de pessoas (faixa) e pessoas por módulo. */
export interface Assentos {
  pessoas: number;
  porModulo: Record<ModuleCode, number>;
}

export const ocupaAssento = (m: ModuleInfo, p: PessoaAcesso): boolean =>
  (!m.papeis || m.papeis.includes(p.papel)) && (!m.clinico || p.clinico);

export function contarAssentos(pessoas: PessoaAcesso[]): Assentos {
  const porModulo = Object.fromEntries(
    MODULES.map((m) => [
      m.code,
      pessoas.filter((p) => ocupaAssento(m, p)).length,
    ]),
  ) as Record<ModuleCode, number>;
  return { pessoas: pessoas.length, porModulo };
}

export interface ItemAssinatura {
  code: ModuleCode;
  /** Pessoas com acesso ao módulo (assentos). */
  pessoas: number;
  /** Preço por assento na faixa atual (R$/mês). */
  preco: number;
}

/** Assentos e preço de cada módulo do catálogo (contratado ou não). */
export const itensDe = (a: Assentos): ItemAssinatura[] =>
  MODULES.map((m) => ({
    code: m.code,
    pessoas: a.porModulo[m.code] ?? 0,
    preco: precoNaFaixa(m.code, a.pessoas),
  }));

/**
 * Valor final da assinatura (R$/mês):
 *   mensal = Σ (preço do módulo na faixa × assentos do módulo)
 *   final  = mensal × (1 − desconto do plano)
 * A faixa é pelo total de pessoas da clínica.
 */
export function calcularValor(
  modulos: ModuleCode[],
  assentos: Assentos,
  plano: PlanoPeriodo,
): number {
  const mensal = modulos.reduce(
    (soma, c) =>
      soma +
      Math.round(precoNaFaixa(c, assentos.pessoas) * 100) *
        (assentos.porModulo[c] ?? 0),
    0,
  );
  return Math.round(mensal * (1 - DESCONTO_PLANO[plano])) / 100;
}
