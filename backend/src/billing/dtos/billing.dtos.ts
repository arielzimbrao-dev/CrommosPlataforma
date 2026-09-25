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

export class UpdateAssinaturaDto {
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsEnum(ModuleCode, { each: true })
  modulosAtivos?: ModuleCode[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
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
  @Min(1)
  @Max(1000)
  numeroUsuarios!: number;

  @IsEnum(PlanoPeriodo)
  plano!: PlanoPeriodo;
}
