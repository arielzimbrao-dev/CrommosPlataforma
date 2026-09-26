import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AbacatePayClient } from './abacatepay.client';
import { AssinaturaService } from './assinatura.service';
import { BillingController } from './billing.controller';
import { CobrancaService } from './cobranca.service';
import { PlataformaController } from './plataforma.controller';
import { RenovacaoCron } from './renovacao.cron';
import { WebhookController } from './webhook.controller';

/**
 * Catálogo, assinatura com pró-rata, faturas, renovação diária, situação
 * (modo leitura), pagamento pela AbacatePay (link + webhook) e baixa manual.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [BillingController, PlataformaController, WebhookController],
  providers: [
    AssinaturaService,
    CobrancaService,
    RenovacaoCron,
    { provide: AbacatePayClient, useFactory: () => new AbacatePayClient() },
  ],
  exports: [AssinaturaService],
})
export class BillingModule {}
