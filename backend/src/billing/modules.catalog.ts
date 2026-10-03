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
  /** Preço cheio por assento/mês — do 1º ao 3º, no nível Essencial. R$. */
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
    precoPorUsuario: 26.78,
    papeis: AGENDA,
  },
  {
    code: ModuleCode.Prontuario,
    nome: 'Prontuário',
    precoPorUsuario: 26.78,
    papeis: CLINICO,
    clinico: true,
  },
  {
    code: ModuleCode.Financeiro,
    nome: 'Financeiro',
    precoPorUsuario: 31.24,
    papeis: GESTAO_FINANCEIRA,
  },
  {
    code: ModuleCode.Exames,
    nome: 'Exames',
    precoPorUsuario: 17.85,
    papeis: CLINICO,
    clinico: true,
  },
  // Toda a equipe trabalha em várias unidades: conta todas as pessoas.
  {
    code: ModuleCode.MultiplasUnidades,
    nome: 'Múltiplas unidades',
    precoPorUsuario: 13.39,
  },
  {
    code: ModuleCode.Convenio,
    nome: 'Convênio',
    precoPorUsuario: 35.7,
    papeis: GESTAO_FINANCEIRA,
  },
  {
    code: ModuleCode.Estoque,
    nome: 'Estoque',
    precoPorUsuario: 8.93,
    papeis: [...AGENDA, 'financeiro'],
  },
  {
    code: ModuleCode.Fiscal,
    nome: 'Fiscal (NFS-e, Receita Saúde e DMED)',
    precoPorUsuario: 26.78,
    papeis: GESTAO_FINANCEIRA,
  },
  // Franquia de teleconsultas por assento (FRANQUIA_TELECONSULTAS).
  {
    code: ModuleCode.Telemedicina,
    nome: 'Telemedicina',
    precoPorUsuario: 44.63,
    papeis: CLINICO,
    clinico: true,
  },
];

export const DESCONTO_PLANO: Record<PlanoPeriodo, number> = {
  [PlanoPeriodo.Mensal]: 0,
  [PlanoPeriodo.Semestral]: 0.05,
  [PlanoPeriodo.Anual]: 0.1,
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

/** Nível do módulo com franquia (Agenda e Fiscal): assento e franquia maiores. */
export enum Nivel {
  Essencial = 'essencial',
  Profissional = 'profissional',
  Avancado = 'avancado',
}

/** Nível escolhido por módulo; ausente = Essencial. */
export type Niveis = Partial<Record<ModuleCode, Nivel>>;

/** O que a franquia conta (informado pelo produto, POST /interno/consumos). */
export enum TipoConsumo {
  Whatsapp = 'whatsapp',
  Nfse = 'nfse',
}

export interface Franquia {
  modulo: ModuleCode;
  tipo: TipoConsumo;
  /** Para exibir: "mensagens de WhatsApp", "notas fiscais". */
  unidade: string;
  /** R$ por unidade além da franquia (cobrado na fatura seguinte). */
  excedente: number;
  /** Por nível: R$ somados ao preço cheio do assento e unidades/assento/mês. */
  niveis: Record<Nivel, { acrescimo: number; porAssento: number }>;
}

/** Tabela aprovada pelo dono em 03/10/2026 (docs/03-precificacao.md). */
export const FRANQUIAS: Franquia[] = [
  {
    modulo: ModuleCode.Agenda,
    tipo: TipoConsumo.Whatsapp,
    unidade: 'mensagens de WhatsApp',
    excedente: 0.05,
    niveis: {
      [Nivel.Essencial]: { acrescimo: 0, porAssento: 150 },
      [Nivel.Profissional]: { acrescimo: 8, porAssento: 300 },
      [Nivel.Avancado]: { acrescimo: 18, porAssento: 600 },
    },
  },
  {
    modulo: ModuleCode.Fiscal,
    tipo: TipoConsumo.Nfse,
    unidade: 'notas fiscais',
    excedente: 0.15,
    niveis: {
      [Nivel.Essencial]: { acrescimo: 0, porAssento: 100 },
      [Nivel.Profissional]: { acrescimo: 10, porAssento: 300 },
      [Nivel.Avancado]: { acrescimo: 25, porAssento: 800 },
    },
  },
];

export const franquiaDe = (code: ModuleCode) =>
  FRANQUIAS.find((f) => f.modulo === code);

/** Nível efetivo: só módulos com franquia têm nível (os outros, Essencial). */
export const nivelDe = (code: ModuleCode, niveis: Niveis = {}): Nivel =>
  (franquiaDe(code) && niveis[code]) || Nivel.Essencial;

/** Telemedicina: teleconsultas incluídas por assento, por mês do ciclo. */
export const FRANQUIA_TELECONSULTAS = 20;
/** R$ por teleconsulta além da franquia (cobrada na fatura seguinte). */
export const PRECO_TELECONSULTA_EXCEDENTE = 2;

export const MODULE_CODES = MODULES.map((m) => m.code);

/** Preço cheio do assento no nível (Essencial + acréscimo do nível). */
const precoCheio = (code: ModuleCode, nivel = Nivel.Essencial) => {
  const base = MODULES.find((m) => m.code === code)?.precoPorUsuario ?? 0;
  return base + (franquiaDe(code)?.niveis[nivel].acrescimo ?? 0);
};

/** Centavos de um assento no degrau (arredondado ao centavo, meio para cima). */
const assentoCent = (code: ModuleCode, fator: number, nivel?: Nivel) =>
  Math.round((Math.round(precoCheio(code, nivel) * 100) * fator) / 100);

/** Preço do k-ésimo assento do módulo (R$): 31,24 × 0,85 = 26,554 → 26,55. */
export function precoAssento(
  code: ModuleCode,
  k: number,
  nivel?: Nivel,
): number {
  const d = ESCADA.find((e) => e.ate === null || k <= e.ate) ?? ESCADA[0];
  return assentoCent(code, d.fator, nivel) / 100;
}

export interface Degrau {
  /** Assentos neste degrau. */
  qtd: number;
  /** Preço de cada um (R$/mês). */
  preco: number;
}

/** `n` assentos do módulo repartidos na escada (sem degraus vazios). */
export const degrausDe = (
  code: ModuleCode,
  n: number,
  nivel?: Nivel,
): Degrau[] =>
  ESCADA.map((e) => ({
    qtd: Math.max(0, Math.min(n, e.ate ?? n) - e.de + 1),
    preco: assentoCent(code, e.fator, nivel) / 100,
  })).filter((d) => d.qtd > 0);

const subtotalCent = (code: ModuleCode, n: number, nivel?: Nivel) =>
  degrausDe(code, n, nivel).reduce(
    (s, d) => s + d.qtd * Math.round(d.preco * 100),
    0,
  );

/** Σ dos assentos do módulo (R$/mês, antes do desconto do plano). */
export const subtotalModulo = (
  code: ModuleCode,
  n: number,
  nivel?: Nivel,
): number => subtotalCent(code, n, nivel) / 100;

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
  /** Preço cheio por assento (1º ao 3º) no nível, R$/mês. */
  preco: number;
  /** Nível do módulo (Essencial nos módulos sem franquia). */
  nivel: Nivel;
  /** Assentos por degrau: "3 × R$ 25,50 + 2 × R$ 21,68". */
  degraus: Degrau[];
  /** Σ dos assentos (R$/mês, antes do plano). */
  subtotal: number;
}

/** Assentos, escada e subtotal de cada módulo do catálogo (contratado ou não). */
export const itensDe = (a: Assentos, niveis: Niveis = {}): ItemAssinatura[] =>
  MODULES.map((m) => {
    const pessoas = a.porModulo[m.code] ?? 0;
    const nivel = nivelDe(m.code, niveis);
    return {
      code: m.code,
      pessoas,
      preco: precoCheio(m.code, nivel),
      nivel,
      degraus: degrausDe(m.code, pessoas, nivel),
      subtotal: subtotalModulo(m.code, pessoas, nivel),
    };
  });

/**
 * Valor final da assinatura (R$/mês):
 *   mensal = Σ módulos contratados Σ assentos (preço do nível × fator do degrau)
 *   final  = mensal × (1 − desconto do plano)
 */
export function calcularValor(
  modulos: ModuleCode[],
  assentos: Assentos,
  plano: PlanoPeriodo,
  niveis: Niveis = {},
): number {
  const mensal = modulos.reduce(
    (s, c) =>
      s + subtotalCent(c, assentos.porModulo[c] ?? 0, nivelDe(c, niveis)),
    0,
  );
  return Math.round(mensal * (1 - DESCONTO_PLANO[plano])) / 100;
}
