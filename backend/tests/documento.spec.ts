import { validate } from 'class-validator';
import { IsDocumentoCliente, isDocumentoValido } from 'src/common/documento';

class Dto {
  tipo?: unknown;

  @IsDocumentoCliente('tipo')
  documento?: unknown;
}

const erros = async (tipo: unknown, documento: unknown) =>
  (await validate(Object.assign(new Dto(), { tipo, documento }))).length;

describe('documento do cliente (CPF se pf, CNPJ se pj)', () => {
  it('isDocumentoValido confere os dígitos verificadores pelo tipo', () => {
    expect(isDocumentoValido('pf', '529.982.247-25')).toBe(true);
    expect(isDocumentoValido('pf', '52998224726')).toBe(false);
    expect(isDocumentoValido('pj', '11.222.333/0001-81')).toBe(true);
    expect(isDocumentoValido('pj', '52998224725')).toBe(false);
    expect(isDocumentoValido('pf', '11222333000181')).toBe(false);
    expect(isDocumentoValido('xx', '52998224725')).toBe(false);
    expect(isDocumentoValido('pf', 52998224725)).toBe(false);
  });

  it('decorator lê o tipo do outro campo do DTO', async () => {
    expect(await erros('pf', '52998224725')).toBe(0);
    expect(await erros('pj', '11222333000181')).toBe(0);
    expect(await erros('pj', '52998224725')).toBe(1);
    expect(await erros(undefined, '52998224725')).toBe(1);
    const [e] = await validate(
      Object.assign(new Dto(), { tipo: 'pf', documento: '1' }),
    );
    expect(e.constraints).toEqual({
      isDocumentoCliente: 'CPF/CNPJ inválido para o tipo de cliente.',
    });
  });
});
