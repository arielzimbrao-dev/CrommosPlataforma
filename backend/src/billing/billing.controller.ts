import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import { CobrancaService } from './cobranca.service';
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
  constructor(
    private readonly assinatura: AssinaturaService,
    private readonly cobranca: CobrancaService,
    private readonly config: ConfigService,
  ) {}

  /** Catálogo de módulos + os ativos do tenant + a situação (modo leitura). */
  @ExigeAcesso()
  @Get('modulos')
  async modulos(@CurrentUser() u: ITokenPayload) {
    const [ativos, situacao] = await Promise.all([
      this.assinatura.getModulosAtivos(ator(u)),
      this.assinatura.situacao(ator(u)),
    ]);
    return { catalogo: MODULES, ativos, situacao };
  }

  @ExigeAcesso(PAPEL_ADMIN, PAPEL_FINANCEIRO)
  @Get('assinatura')
  async getAssinatura(@CurrentUser() u: ITokenPayload) {
    return {
      ...(await this.assinatura.getCurrent(ator(u))),
      pagamentoOnline: this.cobranca.pagamentoOnline,
    };
  }

  /** Link de pagamento (AbacatePay: PIX ou cartão) de uma fatura pendente. */
  @ExigeAcesso(PAPEL_ADMIN, PAPEL_FINANCEIRO)
  @Post('assinatura/faturas/:id/pagamento')
  @HttpCode(200)
  pagamento(
    @CurrentUser() u: ITokenPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const frontend = this.config.get<string>('FRONTEND_URL');
    return this.cobranca.linkPagamento(
      ator(u),
      id,
      frontend ? `${frontend.replace(/\/+$/, '')}/assinatura` : undefined,
    );
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
