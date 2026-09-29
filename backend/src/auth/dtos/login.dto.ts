import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PRODUTOS, type Produto } from '../../common/produtos';

export class LoginDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @IsIn(PRODUTOS, { message: 'produto deve ser clinic, odonto ou vet.' })
  produto!: Produto;

  /**
   * Tenant, opcional: o **código curto** (5) ou o UUID. Sem ele, entra direto
   * com um acesso ativo no produto; com mais de um, a resposta é
   * `escolherClinica`.
   */
  @IsOptional()
  @IsString()
  @Length(5, 36)
  tenantId?: string;
}

/** 2º passo do login com 2FA (L-07). */
export class LoginCodigoDto {
  @IsString()
  @MinLength(10)
  @MaxLength(4096)
  desafio!: string;

  /** 6 dígitos do app ou um código de recuperação (`XXXX-XXXX`). */
  @IsString()
  @MinLength(6)
  @MaxLength(20)
  codigo!: string;
}
