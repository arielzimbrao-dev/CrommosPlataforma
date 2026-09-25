import { applyDecorators } from '@nestjs/common';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

const MENSAGEM = 'A senha deve ter de 8 a 72 caracteres, com letras e números.';

/**
 * Política mínima de senha nova (signup, convite/redefinição, troca): 8+
 * caracteres com ao menos uma letra e um número. Teto de 72 = limite do bcrypt.
 */
export const SenhaForte = (): PropertyDecorator =>
  applyDecorators(
    IsString(),
    MinLength(8, { message: MENSAGEM }),
    MaxLength(72, { message: MENSAGEM }),
    Matches(/^(?=.*[A-Za-z])(?=.*\d)/, { message: MENSAGEM }),
  );
