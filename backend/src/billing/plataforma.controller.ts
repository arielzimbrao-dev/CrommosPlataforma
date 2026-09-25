import {
  Controller,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsPublic } from '../auth/decorators/is-public.decorator';
import { iguaisEmTempoConstante } from '../common/crypto/segredo';
import { AssinaturaService } from './assinatura.service';

/**
 * Backoffice da Crommos, protegido pela chave `PLATAFORMA_API_KEY` no header
 * `X-Plataforma-Key` (sem a chave configurada, 404). Provisório até o webhook
 * da AbacatePay.
 */
@ApiTags('plataforma')
@Controller('plataforma')
export class PlataformaController {
  constructor(
    private readonly assinatura: AssinaturaService,
    private readonly config: ConfigService,
  ) {}

  /** Baixa manual de fatura (auditada como `pagar-plataforma`). */
  @IsPublic()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post('faturas/:id/pagar')
  @HttpCode(200)
  async pagar(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-plataforma-key') chave?: string,
  ) {
    const esperada = this.config.get<string>('PLATAFORMA_API_KEY');
    if (!esperada) throw new NotFoundException();
    if (!chave || !iguaisEmTempoConstante(chave, esperada)) {
      throw new UnauthorizedException('Chave da plataforma inválida.');
    }
    return this.assinatura.pagarPelaPlataforma(id);
  }
}
