import { Body, Controller, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { responderSessao, SessaoResponse } from '../auth/auth.controller';
import { IsPublic } from '../auth/decorators/is-public.decorator';
import { SignupDto } from './dtos/signup.dto';
import { SignupService } from './signup.service';

@ApiTags('signup')
@Controller('signup')
export class SignupController {
  constructor(private readonly signup: SignupService) {}

  /** Cria a conta (5/h por IP) e já entra: sucesso do login + `codigo`. */
  @Throttle({ default: { ttl: 3_600_000, limit: 5 } })
  @IsPublic()
  @Post()
  async criar(
    @Body() dto: SignupDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessaoResponse & { codigo: string }> {
    const conta = await this.signup.criarConta(dto);
    return { ...responderSessao(res, conta), codigo: conta.codigo };
  }
}
