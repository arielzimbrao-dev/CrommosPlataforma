/**
 * Catálogo de módulos e a **fórmula de cobrança** (Crommos/docs/03-precificacao.md).
 * Fonte da verdade do cálculo — não duplicar preços.
 *
 * Modelo **assento por módulo**: cada módulo contratado cobra pelas pessoas
 * que têm acesso a ele (derivadas dos acessos ativos e dos papéis — a clínica
 * só escolhe os módulos). Desconto em **escada dentro de cada módulo**: o
 * k-ésimo assento paga preço × fator do degrau (`ESCADA`). Somar uma pessoa só
 * acrescenta o preço do assento dela — o valor nunca cai ao crescer.
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
  /** Preço cheio por pessoa com acesso (assento)/mês — do 1º ao 3º. R$. */
  precoPorUsuario: number;
  /**
   * Quem ocupa assento (espelha o menu e os `@Roles` do Clinic): papéis com
   * acesso ao módulo; ausente = todas as pessoas da clínica.
   */
  papeis?: string[];
  /** Só conta quem está vinculado a um profissional de saúde (sigilo CFM). */
  clinico?: true;
}

// Papéis do Clinic (frontend/src/nav.ts de lá).
export const PAPEIS = [
  'admin',
  'gestor',
  'recepcao',
  'profissional',
  'financeiro',
] as const;
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
  {
    code: ModuleCode.Convenio,
    nome: 'Convênio',
    precoPorUsuario: 34,
    papeis: GESTAO_FINANCEIRA,
  },
  {
    code: ModuleCode.Estoque,
    nome: 'Estoque',
    precoPorUsuario: 8.5,
    papeis: [...AGENDA, 'financeiro'],
  },
  {
    code: ModuleCode.Fiscal,
    nome: 'Fiscal (NFS-e, Receita Saúde e DMED)',
    precoPorUsuario: 25.5,
    papeis: GESTAO_FINANCEIRA,
  },
  // Franquia de teleconsultas por assento (FRANQUIA_TELECONSULTAS).
  {
    code: ModuleCode.Telemedicina,
    nome: 'Telemedicina',
    precoPorUsuario: 42.5,
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
 * Escada por módulo (docs/03-precificacao.md): o k-ésimo assento do módulo
 * paga o preço cheio × `fator` (%). `ate` null = sem teto.
 */
export const ESCADA = [
  { de: 1, ate: 3, fator: 100 },
  { de: 4, ate: 10, fator: 85 },
  { de: 11, ate: 30, fator: 75 },
  { de: 31, ate: null, fator: 65 },
] as const;

/** Telemedicina: teleconsultas incluídas por assento, por mês do ciclo. */
export const FRANQUIA_TELECONSULTAS = 20;
/** R$ por teleconsulta além da franquia (cobrada na fatura seguinte). */
export const PRECO_TELECONSULTA_EXCEDENTE = 2;

export const MODULE_CODES = MODULES.map((m) => m.code);

const precoCheio = (code: ModuleCode) =>
  MODULES.find((m) => m.code === code)?.precoPorUsuario ?? 0;

/** Centavos de um assento no degrau (arredondado ao centavo, meio para cima). */
const assentoCent = (code: ModuleCode, fator: number) =>
  Math.round((Math.round(precoCheio(code) * 100) * fator) / 100);

/** Preço do k-ésimo assento do módulo (R$): 29,75 × 0,85 = 25,2875 → 25,29. */
export function precoAssento(code: ModuleCode, k: number): number {
  const d = ESCADA.find((e) => e.ate === null || k <= e.ate) ?? ESCADA[0];
  return assentoCent(code, d.fator) / 100;
}

export interface Degrau {
  /** Assentos neste degrau. */
  qtd: number;
  /** Preço de cada um (R$/mês). */
  preco: number;
}

/** `n` assentos do módulo repartidos na escada (sem degraus vazios). */
export const degrausDe = (code: ModuleCode, n: number): Degrau[] =>
  ESCADA.map((e) => ({
    qtd: Math.max(0, Math.min(n, e.ate ?? n) - e.de + 1),
    preco: assentoCent(code, e.fator) / 100,
  })).filter((d) => d.qtd > 0);

const subtotalCent = (code: ModuleCode, n: number) =>
  degrausDe(code, n).reduce((s, d) => s + d.qtd * Math.round(d.preco * 100), 0);

/** Σ dos assentos do módulo (R$/mês, antes do desconto do plano). */
export const subtotalModulo = (code: ModuleCode, n: number): number =>
  subtotalCent(code, n) / 100;

/**
 * Teleconsultas além da franquia do ciclo: 20 × assentos de Telemedicina ×
 * meses do ciclo (semestral 6, anual 12).
 */
export const teleconsultasExcedentes = (
  realizadas: number,
  assentos: number,
  meses = 1,
): number =>
  Math.max(0, realizadas - FRANQUIA_TELECONSULTAS * assentos * meses);

/** Pessoa com acesso ativo (convite pendente incluso): o que conta assento. */
export interface PessoaAcesso {
  papel: string;
  clinico: boolean;
}

/** Assentos derivados: total de pessoas e pessoas por módulo. */
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
  /** Preço cheio por assento (1º ao 3º), R$/mês. */
  preco: number;
  /** Assentos por degrau: "3 × R$ 25,50 + 2 × R$ 21,68". */
  degraus: Degrau[];
  /** Σ dos assentos (R$/mês, antes do plano). */
  subtotal: number;
}

/** Assentos, escada e subtotal de cada módulo do catálogo (contratado ou não). */
export const itensDe = (a: Assentos): ItemAssinatura[] =>
  MODULES.map((m) => {
    const pessoas = a.porModulo[m.code] ?? 0;
    return {
      code: m.code,
      pessoas,
      preco: m.precoPorUsuario,
      degraus: degrausDe(m.code, pessoas),
      subtotal: subtotalModulo(m.code, pessoas),
    };
  });

/**
 * Valor final da assinatura (R$/mês):
 *   mensal = Σ módulos contratados Σ assentos (preço cheio × fator do degrau)
 *   final  = mensal × (1 − desconto do plano)
 */
export function calcularValor(
  modulos: ModuleCode[],
  assentos: Assentos,
  plano: PlanoPeriodo,
): number {
  const mensal = modulos.reduce(
    (s, c) => s + subtotalCent(c, assentos.porModulo[c] ?? 0),
    0,
  );
  return Math.round(mensal * (1 - DESCONTO_PLANO[plano])) / 100;
}
