import {
  Controller,
  Headers,
  HttpCode,
  Post,
  Query,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { IsPublic } from '../auth/decorators/is-public.decorator';
import { CobrancaService } from './cobranca.service';

/**
 * Webhook da AbacatePay (cadastrado no painel dela com
 * `?webhookSecret=<ABACATEPAY_WEBHOOK_SECRET>`). Sem a AbacatePay configurada,
 * 404. O corpo cru (`rawBody`) é o que o HMAC assina.
 */
@ApiTags('webhooks')
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly cobranca: CobrancaService) {}

  @IsPublic()
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  @Post('abacatepay')
  @HttpCode(200)
  abacatepay(
    @Req() req: RawBodyRequest<Request>,
    @Query('webhookSecret') segredo?: string,
    @Headers('x-webhook-signature') assinatura?: string,
  ) {
    return this.cobranca.webhook(req.rawBody, segredo, assinatura);
  }
}
