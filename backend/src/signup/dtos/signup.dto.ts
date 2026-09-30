import {
  Equals,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { IsDocumentoCliente } from '../../common/documento';
import { PRODUTOS, type Produto } from '../../common/produtos';
import { SenhaForte } from '../../auth/dtos/senha-forte.decorator';

/** Cadastro público: cliente, pessoa, assinatura em trial e tenant no produto. */
export class SignupDto {
  @IsIn(PRODUTOS, { message: 'produto deve ser clinic, odonto ou vet.' })
  produto!: Produto;

  /** Quem paga: pessoa física (CPF do dono) ou jurídica (CNPJ da matriz). */
  @IsIn(['pf', 'pj'], { message: 'tipoCliente deve ser pf ou pj.' })
  tipoCliente!: 'pf' | 'pj';

  /** CPF (pf) ou CNPJ (pj), com ou sem máscara; gravado só com dígitos. */
  @IsString()
  @IsDocumentoCliente('tipoCliente')
  documento!: string;

  @IsString()
  @Length(2, 255)
  nomeClinica!: string;

  /** CNPJ da clínica (14 dígitos), opcional: consultório de PF não tem. */
  @IsOptional()
  @Matches(/^\d{14}$/, { message: 'CNPJ deve ter 14 dígitos.' })
  cnpj?: string;

  /** Nome de quem está criando a conta (o admin). */
  @IsString()
  @Length(2, 255)
  nome!: string;

  @IsEmail()
  @MaxLength(255)
  email!: string;

  @SenhaForte()
  senha!: string;

  @IsString()
  @Length(2, 255)
  nomeUnidade!: string;

  @Equals(true, { message: 'É preciso aceitar os termos de uso.' })
  aceiteTermos!: boolean;

  /** Ignorado: vale a versão do servidor (`TERMOS_VERSAO`). Aceito por compatibilidade. */
  @IsOptional()
  @IsString()
  @Length(1, 20)
  termosVersao?: string;
}

/** Outra clínica na conta de quem já está logado (sem dados da pessoa). */
export class NovaClinicaDto {
  @IsIn(PRODUTOS, { message: 'produto deve ser clinic, odonto ou vet.' })
  produto!: Produto;

  @IsIn(['pf', 'pj'], { message: 'tipoCliente deve ser pf ou pj.' })
  tipoCliente!: 'pf' | 'pj';

  @IsString()
  @IsDocumentoCliente('tipoCliente')
  documento!: string;

  @IsString()
  @Length(2, 255)
  nomeClinica!: string;

  @IsOptional()
  @Matches(/^\d{14}$/, { message: 'CNPJ deve ter 14 dígitos.' })
  cnpj?: string;

  @IsString()
  @Length(2, 255)
  nomeUnidade!: string;
}
