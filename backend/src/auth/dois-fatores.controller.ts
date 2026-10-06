import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import type { ITokenPayload } from '../common/interfaces/token-payload.interface';
import { contextoDe } from './auth.controller';
import { CurrentUser } from './decorators/current-user.decorator';
import { ExigeAcesso, PAPEL_ADMIN } from './decorators/exige-acesso.decorator';
import { DoisFatoresService } from './dois-fatores.service';

export class CodigoDto {
  @IsString()
  @MinLength(6)
  @MaxLength(20)
  codigo!: string;
}

export class SenhaDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  senha!: string;
}

export class SenhaCodigoDto extends SenhaDto {
  @IsString()
  @MinLength(6)
  @MaxLength(20)
  codigo!: string;
}

export class ExigenciaDto {
  @IsBoolean()
  exigir!: boolean;
}

/**
 * Verificação em duas etapas (docs/contrato.md): a pessoa liga e
 * desliga em Meu perfil; o admin da clínica exige (admin e quem vê
 * prontuário) e desliga o de quem perdeu o celular.
 */
@ApiTags('auth')
@ApiBearerAuth()
@Controller('auth/2fa')
export class DoisFatoresController {
  constructor(private readonly doisFatores: DoisFatoresService) {}

  @Get()
  estado(@CurrentUser() u: ITokenPayload) {
    return this.doisFatores.estado(u);
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post('iniciar')
  iniciar(@CurrentUser() u: ITokenPayload) {
    return this.doisFatores.iniciar(u);
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post('confirmar')
  confirmar(
    @CurrentUser() u: ITokenPayload,
    @Body() dto: CodigoDto,
    @Req() req: Request,
  ) {
    return this.doisFatores.confirmar(u, dto.codigo, contextoDe(req));
  }

  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('desligar')
  @HttpCode(HttpStatus.NO_CONTENT)
  desligar(
    @CurrentUser() u: ITokenPayload,
    @Body() dto: SenhaCodigoDto,
    @Req() req: Request,
  ): Promise<void> {
    return this.doisFatores.desligar(u, dto.senha, dto.codigo, contextoDe(req));
  }

  /** Códigos de recuperação novos (senha + código do app); os antigos deixam de valer. */
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('recuperacao')
  novosCodigos(
    @CurrentUser() u: ITokenPayload,
    @Body() dto: SenhaCodigoDto,
    @Req() req: Request,
  ) {
    return this.doisFatores.novosCodigos(
      u,
      dto.senha,
      dto.codigo,
      contextoDe(req),
    );
  }

  @ExigeAcesso(PAPEL_ADMIN)
  @Get('clinica')
  daClinica(@CurrentUser() u: ITokenPayload) {
    return this.doisFatores.daClinica(u);
  }

  @ExigeAcesso(PAPEL_ADMIN)
  @Patch('clinica')
  definirExigencia(
    @CurrentUser() u: ITokenPayload,
    @Body() dto: ExigenciaDto,
    @Req() req: Request,
  ) {
    return this.doisFatores.definirExigencia(u, dto.exigir, contextoDe(req));
  }

  @ExigeAcesso(PAPEL_ADMIN)
  @Post('desligar/:usuarioId')
  @HttpCode(HttpStatus.NO_CONTENT)
  desligarDe(
    @CurrentUser() u: ITokenPayload,
    @Param('usuarioId', ParseUUIDPipe) usuarioId: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.doisFatores.desligarDe(u, usuarioId, contextoDe(req));
  }
}
