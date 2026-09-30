import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  LIMITE_MAXIMO,
  LIMITE_PADRAO,
  PaginacaoDto,
  paginar,
} from 'src/common/paginacao';

describe('paginação', () => {
  it('padrão: 50 itens a partir do início', () => {
    expect(paginar({})).toEqual({ take: LIMITE_PADRAO, skip: 0 });
    expect(LIMITE_PADRAO).toBe(50);
  });

  it('respeita limit/offset e nunca passa do teto', () => {
    expect(paginar({ limit: 10, offset: 20 })).toEqual({ take: 10, skip: 20 });
    expect(paginar({ limit: 10_000 })).toEqual({
      take: LIMITE_MAXIMO,
      skip: 0,
    });
    expect(LIMITE_MAXIMO).toBe(200);
  });

  it('DTO converte a query string e rejeita limit > 200 ou offset < 0', () => {
    const ok = plainToInstance(PaginacaoDto, { limit: '20', offset: '5' });
    expect(validateSync(ok)).toHaveLength(0);
    expect(ok.limit).toBe(20);

    const alto = plainToInstance(PaginacaoDto, { limit: '201' });
    expect(validateSync(alto)).toHaveLength(1);
    const negativo = plainToInstance(PaginacaoDto, { offset: '-1' });
    expect(validateSync(negativo)).toHaveLength(1);
  });
});
