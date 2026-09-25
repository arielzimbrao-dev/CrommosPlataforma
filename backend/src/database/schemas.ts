/**
 * A plataforma escreve só no schema `crommos` (docs/contrato.md). `public`
 * fica no fim do caminho por causa das extensões e funções do Postgres.
 */
export const SCHEMA_PLATAFORMA = 'crommos';

/** Opção do `pg` que fixa o `search_path` de toda sessão do pool. */
export const OPCAO_SEARCH_PATH = `-c search_path=${SCHEMA_PLATAFORMA},public`;
