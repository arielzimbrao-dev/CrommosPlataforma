import {
  ALFABETO_CODIGO,
  gerarCodigoTenant,
  sortearCodigo,
} from 'src/signup/codigo';

describe('código curto do tenant', () => {
  it('5 caracteres do alfabeto sem 0/O/1/I', () => {
    for (let i = 0; i < 50; i++) {
      const c = sortearCodigo();
      expect(c).toHaveLength(5);
      expect([...c].every((x) => ALFABETO_CODIGO.includes(x))).toBe(true);
    }
    expect(ALFABETO_CODIGO).not.toMatch(/[01OI]/);
  });

  it('tenta de novo quando o código já existe; desiste depois de 10', async () => {
    const exists = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const sortear = jest
      .fn()
      .mockReturnValueOnce('AAAAA')
      .mockReturnValueOnce('BBBBB');
    await expect(gerarCodigoTenant({ exists } as never, sortear)).resolves.toBe(
      'BBBBB',
    );

    const sempre = { exists: jest.fn().mockResolvedValue(true) };
    await expect(gerarCodigoTenant(sempre as never)).rejects.toThrow(
      /código do tenant/,
    );
    expect(sempre.exists).toHaveBeenCalledTimes(10);
  });
});
