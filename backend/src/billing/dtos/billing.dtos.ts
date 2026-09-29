import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ModuleCode, PlanoPeriodo } from '../modules.catalog';

const USUARIOS = 'Informe de 1 a 1000 usuários.';

/** Pessoa a mais na simulação (convite/ativação): o impacto na mensalidade. */
export class PessoaSimuladaDto {
  @Matches(/^[a-z_]{2,30}$/, { message: 'papel inválido.' })
  papel!: string;

  @IsOptional()
  @IsBoolean()
  clinico?: boolean;
}

/**
 * `numeroUsuarios` é **ignorado** desde o assento por módulo (os assentos vêm
 * dos acessos); aceito só para o frontend antigo não levar 400 na transição.
 */
export class UpdateAssinaturaDto {
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsEnum(ModuleCode, { each: true })
  modulosAtivos?: ModuleCode[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: USUARIOS })
  @Max(1000, { message: USUARIOS })
  numeroUsuarios?: number;

  @IsOptional()
  @IsEnum(PlanoPeriodo)
  plano?: PlanoPeriodo;
}

export class SimularDto {
  @IsArray()
  @ArrayUnique()
  @IsEnum(ModuleCode, { each: true })
  modulos!: ModuleCode[];

  /** Ignorado (ver `UpdateAssinaturaDto`). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: USUARIOS })
  @Max(1000, { message: USUARIOS })
  numeroUsuarios?: number;

  @IsEnum(PlanoPeriodo)
  plano!: PlanoPeriodo;

  @IsOptional()
  @ValidateNested()
  @Type(() => PessoaSimuladaDto)
  adicionar?: PessoaSimuladaDto;
}
