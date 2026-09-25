/** Só os dígitos do CPF. */
export function onlyDigits(value: string): string {
  return (value ?? '').replace(/\D/g, '');
}

/**
 * Valida um CPF pelos dígitos verificadores (algoritmo oficial). Rejeita
 * comprimento != 11 e sequências repetidas (ex.: 000..., 111...).
 */
export function isValidCpf(value: string): boolean {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const digit = (sliceLen: number): number => {
    let sum = 0;
    for (let i = 0; i < sliceLen; i++) {
      sum += Number(cpf[i]) * (sliceLen + 1 - i);
    }
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };

  return digit(9) === Number(cpf[9]) && digit(10) === Number(cpf[10]);
}
