import { numericTransformer } from 'src/common/numeric.transformer';

describe('numericTransformer', () => {
  it('converte o numeric (string do driver pg) para number', () => {
    expect(numericTransformer.from('123.45')).toBe(123.45);
  });

  it('preserva null/undefined nos dois sentidos', () => {
    expect(numericTransformer.from(null)).toBeNull();
    expect(numericTransformer.from(undefined)).toBeUndefined();
    expect(numericTransformer.to(null)).toBeNull();
    expect(numericTransformer.to(7)).toBe(7);
  });
});
