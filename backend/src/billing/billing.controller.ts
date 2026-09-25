import { Body, Controller, Get, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  ExigeAcesso,
  PAPEL_ADMIN,
  PAPEL_FINANCEIRO,
} from '../auth/decorators/exige-acesso.decorator';
import type { ITokenPayload } from '../common/interfaces/token-payload.interface';
import { PaginacaoDto } from '../common/paginacao';
import { AssinaturaService, Ator } from './assinatura.service';
import { SimularDto, UpdateAssinaturaDto } from './dtos/billing.dtos';
import { MODULES } from './modules.catalog';

const ator = (u: ITokenPayload): Ator => ({
  usuarioId: u.sub,
  produto: u.produto,
  tenantId: u.tenantId,
});

/**
 * Assinatura do tenant do token. O papel vem do acesso (`crommos.acessos`):
 * `admin` altera; `admin`/`financeiro` leem. `/modulos` basta acesso ativo.
 */
@ApiTags('billing')
@ApiBearerAuth()
@Controller()
export class BillingController {
  constructor(private readonly assinatura: AssinaturaService) {}

  /** Catálogo de módulos + os ativos do tenant. */
  @ExigeAcesso()
  @Get('modulos')
  async modulos(@CurrentUser() u: ITokenPayload) {
    const ativos = await this.assinatura.getModulosAtivos(ator(u));
    return { catalogo: MODULES, ativos };
  }

  @ExigeAcesso(PAPEL_ADMIN, PAPEL_FINANCEIRO)
  @Get('assinatura')
  getAssinatura(@CurrentUser() u: ITokenPayload) {
    return this.assinatura.getCurrent(ator(u));
  }

  /** Simula valor e pró-rata sem gravar (POST como no Clinic: corpo com lista). */
  @ExigeAcesso(PAPEL_ADMIN, PAPEL_FINANCEIRO)
  @Post('assinatura/simular')
  simular(@CurrentUser() u: ITokenPayload, @Body() dto: SimularDto) {
    return this.assinatura.simular(ator(u), dto);
  }

  @ExigeAcesso(PAPEL_ADMIN)
  @Patch('assinatura')
  update(@CurrentUser() u: ITokenPayload, @Body() dto: UpdateAssinaturaDto) {
    return this.assinatura.upsert(ator(u), dto);
  }

  @ExigeAcesso(PAPEL_ADMIN, PAPEL_FINANCEIRO)
  @Get('assinatura/faturas')
  faturas(@CurrentUser() u: ITokenPayload, @Query() q: PaginacaoDto) {
    return this.assinatura.listarFaturas(ator(u), q);
  }
}
