import { ValueTransformer } from 'typeorm';

/**
 * Converte colunas `numeric` (que o driver do Postgres devolve como string) para
 * `number` no JS. O Postgres guarda o valor exato (decimal); o número em JS só é
 * usado para exibir/transportar — sem aritmética de dinheiro aqui (isso é do
 * Financeiro, que deve tratar em centavos).
 */
export const numericTransformer: ValueTransformer = {
  to: (value?: number | null) => value,
  from: (value?: string | null) =>
    value === null || value === undefined ? value : Number(value),
};
