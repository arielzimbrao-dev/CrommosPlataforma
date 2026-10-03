import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { TipoConsumo } from '../../billing/modules.catalog';

/** Papel do produto (texto): minúsculas e `_`, como os papéis do Clinic. */
const PAPEL = /^[a-z_]{2,30}$/;
const MENSAGEM_PAPEL = 'papel inválido.';

export class CriarAcessoDto {
  @IsUUID()
  tenantId!: string;

  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @Length(2, 255)
  nome!: string;

  @Matches(PAPEL, { message: MENSAGEM_PAPEL })
  papel!: string;

  /** Vinculado a profissional de saúde (assento nos módulos clínicos). */
  @IsOptional()
  @IsBoolean()
  clinico?: boolean;
}

export class AtualizarAcessoDto {
  @IsUUID()
  tenantId!: string;

  @IsUUID()
  usuarioId!: string;

  @IsOptional()
  @Matches(PAPEL, { message: MENSAGEM_PAPEL })
  papel?: string;

  /** `false` desativa (revoga as sessões no tenant); `true` reativa. */
  @IsOptional()
  @IsBoolean()
  ativo?: boolean;

  /** Vinculado a profissional de saúde (assento nos módulos clínicos). */
  @IsOptional()
  @IsBoolean()
  clinico?: boolean;
}

export class ReenviarConviteDto {
  @IsUUID()
  tenantId!: string;

  @IsUUID()
  usuarioId!: string;
}

export class RemoverAcessoDto {
  @IsUUID()
  tenantId!: string;

  @IsUUID()
  usuarioId!: string;
}

/** Mensagem de WhatsApp enviada ou NFS-e emitida (franquia da Agenda/Fiscal). */
export class RegistrarConsumoDto {
  @IsUUID()
  tenantId!: string;

  @IsEnum(TipoConsumo, { message: 'Tipo inválido: whatsapp ou nfse.' })
  tipo!: TipoConsumo;

  /** Id da mensagem/nota no produto: reenvio não conta duas vezes. */
  @IsUUID()
  referencia!: string;
}

/** Teleconsulta concluída no produto (franquia da Telemedicina). */
export class RegistrarTeleconsultaDto {
  @IsUUID()
  tenantId!: string;

  /** Id do atendimento no produto: reenvio não conta duas vezes. */
  @IsUUID()
  referencia!: string;
}
