import { isValidCnpj } from 'src/common/cnpj';

describe('CNPJ', () => {
  it('aceita CNPJ válido com ou sem máscara', () => {
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('11222333000181')).toBe(true);
  });

  it('recusa dígito verificador errado, tamanho errado e sequência repetida', () => {
    expect(isValidCnpj('11222333000182')).toBe(false);
    expect(isValidCnpj('1122233300018')).toBe(false);
    expect(isValidCnpj('00000000000000')).toBe(false);
  });
});
