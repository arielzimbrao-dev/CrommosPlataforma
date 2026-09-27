import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { ModuleCode, PlanoPeriodo } from '../modules.catalog';

const USUARIOS = 'Informe de 1 a 1000 usuários.';

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

  @Type(() => Number)
  @IsInt()
  @Min(1, { message: USUARIOS })
  @Max(1000, { message: USUARIOS })
  numeroUsuarios!: number;

  @IsEnum(PlanoPeriodo)
  plano!: PlanoPeriodo;
}
