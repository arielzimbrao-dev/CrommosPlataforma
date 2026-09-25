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
