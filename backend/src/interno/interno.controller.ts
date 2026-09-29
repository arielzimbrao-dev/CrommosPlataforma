import {
  Body,
  Controller,
  Delete,
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
import { AssinaturaService } from '../billing/assinatura.service';
import type { Produto } from '../common/produtos';
import { AcessosService } from './acessos.service';
import {
  AtualizarAcessoDto,
  CriarAcessoDto,
  ReenviarConviteDto,
  RegistrarTeleconsultaDto,
  RemoverAcessoDto,
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
  constructor(
    private readonly acessos: AcessosService,
    private readonly assinaturas: AssinaturaService,
  ) {}

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

  /** Compensação: o produto não gravou o vínculo depois do convite. */
  @Delete('acessos')
  @HttpCode(HttpStatus.NO_CONTENT)
  remover(
    @ProdutoServico() produto: Produto,
    @Body() dto: RemoverAcessoDto,
  ): Promise<void> {
    return this.acessos.remover(produto, dto);
  }

  @Post('acessos/reenviar-convite')
  @HttpCode(HttpStatus.NO_CONTENT)
  reenviarConvite(
    @ProdutoServico() produto: Produto,
    @Body() dto: ReenviarConviteDto,
  ): Promise<void> {
    return this.acessos.reenviarConvite(produto, dto);
  }

  /** Teleconsulta concluída: conta na franquia do ciclo (idempotente). */
  @Post('teleconsultas')
  @HttpCode(HttpStatus.NO_CONTENT)
  teleconsulta(
    @ProdutoServico() produto: Produto,
    @Body() dto: RegistrarTeleconsultaDto,
  ): Promise<void> {
    return this.assinaturas.registrarTeleconsulta(
      produto,
      dto.tenantId,
      dto.referencia,
    );
  }

  @Get('pessoas/:usuarioId')
  pessoa(
    @ProdutoServico() produto: Produto,
    @Param('usuarioId', ParseUUIDPipe) usuarioId: string,
  ) {
    return this.acessos.pessoa(produto, usuarioId);
  }
}
