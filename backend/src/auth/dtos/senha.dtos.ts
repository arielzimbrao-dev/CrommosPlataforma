import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
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
