import { isValidCpf, onlyDigits } from 'src/common/cpf';

describe('isValidCpf', () => {
  it('aceita CPFs válidos (com e sem máscara)', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('52998224725')).toBe(true);
    expect(isValidCpf('111.444.777-35')).toBe(true);
  });

  it('rejeita dígitos verificadores errados', () => {
    expect(isValidCpf('52998224724')).toBe(false);
    expect(isValidCpf('12345678900')).toBe(false);
  });

  it('rejeita comprimento inválido', () => {
    expect(isValidCpf('123')).toBe(false);
    expect(isValidCpf('')).toBe(false);
  });

  it('rejeita sequências repetidas', () => {
    expect(isValidCpf('11111111111')).toBe(false);
    expect(isValidCpf('00000000000')).toBe(false);
  });

  it('onlyDigits extrai só os números', () => {
    expect(onlyDigits('529.982.247-25')).toBe('52998224725');
  });
});
