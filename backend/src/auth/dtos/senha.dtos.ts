import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginacaoDto } from '../../common/paginacao';
import { SenhaForte } from './senha-forte.decorator';

export class ForgotPasswordDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;
}

export class ResetPasswordDto {
  /** Token recebido por e-mail (esqueci a senha ou convite). */
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  token!: string;

  @SenhaForte()
  password!: string;
}

export class TrocarSenhaDto {
  @IsString()
  @MinLength(1)
  @MaxLength(72)
  senhaAtual!: string;

  @SenhaForte()
  novaSenha!: string;
}

/** Tipos de link de e-mail que a página do front valida ao abrir. */
export const TIPOS_TOKEN = [
  'definir-senha',
  'redefinir-senha',
  'aceitar-convite',
] as const;
export type TipoToken = (typeof TIPOS_TOKEN)[number];

/** `GET /auth/verificar-token?tipo=…&token=…`. */
export class VerificarTokenDto {
  @IsIn(TIPOS_TOKEN)
  tipo!: TipoToken;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  token!: string;
}

/** `POST /auth/aceitar-convite`: token do link do e-mail de convite. */
export class AceitarConviteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  token!: string;
}

/** `GET /auth/acessos`: paginação e, opcional, uma pessoa. */
export class ListarAcessosDto extends PaginacaoDto {
  @IsOptional()
  @IsUUID()
  usuarioId?: string;
}
