import { buildMessage, ValidateBy, ValidationOptions } from 'class-validator';
import { isValidCnpj } from './cnpj';
import { isValidCpf } from './cpf';

/** CPF (`pf`) ou CNPJ (`pj`) válido pelos dígitos verificadores, com ou sem máscara. */
export function isDocumentoValido(tipo: unknown, valor: unknown): boolean {
  if (typeof valor !== 'string') return false;
  if (tipo === 'pf') return isValidCpf(valor);
  if (tipo === 'pj') return isValidCnpj(valor);
  return false;
}

/**
 * Decorator: o documento conforme o tipo informado em outro campo do DTO
 * (ex.: `@IsDocumentoCliente('tipoCliente')` → CPF se `pf`, CNPJ se `pj`).
 */
export function IsDocumentoCliente(
  campoTipo: string,
  options?: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isDocumentoCliente',
      validator: {
        validate: (v: unknown, args) =>
          isDocumentoValido(
            (args?.object as Record<string, unknown> | undefined)?.[campoTipo],
            v,
          ),
        defaultMessage: buildMessage(
          () => 'CPF/CNPJ inválido para o tipo de cliente.',
          options,
        ),
      },
    },
    options,
  );
}
