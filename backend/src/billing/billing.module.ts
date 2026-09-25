import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AssinaturaService } from './assinatura.service';
import { BillingController } from './billing.controller';
import { PlataformaController } from './plataforma.controller';
import { RenovacaoCron } from './renovacao.cron';

/** Catálogo, assinatura com pró-rata, faturas, renovação diária e baixa. */
@Module({
  imports: [DatabaseModule],
  controllers: [BillingController, PlataformaController],
  providers: [AssinaturaService, RenovacaoCron],
  exports: [AssinaturaService],
})
export class BillingModule {}
