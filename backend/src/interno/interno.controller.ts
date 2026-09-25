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
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { IsPublic } from '../auth/decorators/is-public.decorator';
import type { Produto } from '../common/produtos';
import { AcessosService } from './acessos.service';
import {
  AtualizarAcessoDto,
  CriarAcessoDto,
  ReenviarConviteDto,
} from './dtos/acessos.dtos';
import { ProdutoServico, ServicoKeyGuard } from './servico-key.guard';

/**
 * API interna chamada pelos produtos (`X-Servico-Key`). Fora do access token
 * (`@IsPublic`) e do rate limit por IP (todo o tráfego vem do produto).
 */
@ApiTags('interno')
@IsPublic()
@SkipThrottle()
@UseGuards(ServicoKeyGuard)
@Controller('interno')
export class InternoController {
  constructor(private readonly acessos: AcessosService) {}

  @Post('acessos')
  criar(@ProdutoServico() produto: Produto, @Body() dto: CriarAcessoDto) {
    return this.acessos.criar(produto, dto);
  }

  @Patch('acessos')
  atualizar(
    @ProdutoServico() produto: Produto,
    @Body() dto: AtualizarAcessoDto,
  ) {
    return this.acessos.atualizar(produto, dto);
  }

  @Post('acessos/reenviar-convite')
  @HttpCode(HttpStatus.NO_CONTENT)
  reenviarConvite(
    @ProdutoServico() produto: Produto,
    @Body() dto: ReenviarConviteDto,
  ): Promise<void> {
    return this.acessos.reenviarConvite(produto, dto);
  }

  @Get('pessoas/:usuarioId')
  pessoa(
    @ProdutoServico() produto: Produto,
    @Param('usuarioId', ParseUUIDPipe) usuarioId: string,
  ) {
    return this.acessos.pessoa(produto, usuarioId);
  }
}
