import { onlyDigits } from './cpf';

/**
 * Valida um CNPJ (14 dígitos) pelos dígitos verificadores. Aceita com ou sem
 * máscara; rejeita sequências repetidas. ponytail: só CNPJ numérico — o CNPJ
 * alfanumérico da Receita (2026) entra quando precisar.
 */
export function isValidCnpj(value: string): boolean {
  const cnpj = onlyDigits(value);
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;
  const digito = (tam: number): number => {
    let soma = 0;
    for (let i = 0; i < tam; i++) {
      const peso = ((tam - 1 - i) % 8) + 2;
      soma += Number(cnpj[i]) * peso;
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  return digito(12) === Number(cnpj[12]) && digito(13) === Number(cnpj[13]);
}
