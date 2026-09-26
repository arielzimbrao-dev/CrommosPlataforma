import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength, MinLength } from 'class-validator';
import type { Response } from 'express';
import { clearRefreshCookie } from '../auth/auth-cookies';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { ITokenPayload } from '../common/interfaces/token-payload.interface';
import { ContaService } from './conta.service';

export class ExcluirContaDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  senha!: string;
}

/** LGPD da pessoa: exportar os dados e excluir (anonimizar) a conta. */
@ApiTags('conta')
@ApiBearerAuth()
@Controller('conta')
export class ContaController {
  constructor(private readonly conta: ContaService) {}

  @Throttle({ default: { ttl: 3_600_000, limit: 10 } })
  @Get('dados')
  exportar(@CurrentUser() u: ITokenPayload) {
    return this.conta.exportar(u.sub);
  }

  @Throttle({ default: { ttl: 3_600_000, limit: 5 } })
  @Post('excluir')
  @HttpCode(HttpStatus.NO_CONTENT)
  async excluir(
    @CurrentUser() u: ITokenPayload,
    @Body() dto: ExcluirContaDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.conta.excluir(u.sub, dto.senha);
    clearRefreshCookie(res);
  }
}
