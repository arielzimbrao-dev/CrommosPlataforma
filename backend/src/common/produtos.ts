import { iguaisEmTempoConstante } from './crypto/segredo';

/** Produtos da plataforma (coluna `produto` de assinaturas, acessos e sessões). */
export const PRODUTOS = ['clinic', 'odonto', 'vet'] as const;
export type Produto = (typeof PRODUTOS)[number];

/** Nome comercial (e-mails). */
export const NOME_PRODUTO: Record<Produto, string> = {
  clinic: 'Crommos Clinic',
  odonto: 'Crommos Odonto',
  vet: 'Crommos Vet',
};

export interface ConfigProduto {
  produto: Produto;
  /** Base da API do produto (provisionamento do tenant no signup). */
  apiUrl: string;
  /** Chave de serviço do produto (`X-Servico-Key`, nos dois sentidos). */
  chaveServico: string;
}

type Env = Record<string, string | undefined>;

const prefixo = (p: Produto) => p.toUpperCase();

/**
 * Configuração de um produto: `<PRODUTO>_API_URL` + `SERVICO_KEY_<PRODUTO>`.
 * Sem as duas, o produto não está disponível (`null`): signup e login dele
 * respondem 400 e a chave dele não abre a API interna.
 */
export function configProduto(
  produto: Produto,
  env: Env = process.env,
): ConfigProduto | null {
  const apiUrl = env[`${prefixo(produto)}_API_URL`]?.trim();
  const chaveServico = env[`SERVICO_KEY_${prefixo(produto)}`];
  if (!apiUrl || !chaveServico) return null;
  return { produto, apiUrl: apiUrl.replace(/\/$/, ''), chaveServico };
}

/** Produtos configurados neste ambiente. */
export const produtosDisponiveis = (env: Env = process.env): ConfigProduto[] =>
  PRODUTOS.map((p) => configProduto(p, env)).filter(
    (c): c is ConfigProduto => c !== null,
  );

/**
 * Produto dono da chave de serviço (comparação em tempo constante com todas as
 * chaves configuradas, sem sair no primeiro acerto). `null` = chave inválida.
 */
export function produtoDaChave(
  chave: string,
  env: Env = process.env,
): Produto | null {
  let achado: Produto | null = null;
  for (const c of produtosDisponiveis(env)) {
    if (iguaisEmTempoConstante(chave, c.chaveServico)) achado = c.produto;
  }
  return achado;
}
