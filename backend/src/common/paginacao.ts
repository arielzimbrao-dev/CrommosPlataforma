import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const LIMITE_PADRAO = 50;
export const LIMITE_MAXIMO = 200;
/**
 * Teto de segurança para listas que ainda não são paginadas (B13): limita a
 * memória/resposta sem mudar o contrato. Troque por `paginar()` ao paginar.
 */
export const TETO_LISTA = 500;

/** Query de paginação (`?limit=&offset=`); estenda nos `ListXDto`. */
export class PaginacaoDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIMITE_MAXIMO)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

/** `{ take, skip }` do TypeORM com padrão 50 e teto 200. */
export function paginar(q: { limit?: number; offset?: number }): {
  take: number;
  skip: number;
} {
  return {
    take: Math.min(q.limit ?? LIMITE_PADRAO, LIMITE_MAXIMO),
    skip: q.offset ?? 0,
  };
}
