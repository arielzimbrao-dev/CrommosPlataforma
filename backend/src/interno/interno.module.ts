import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { DatabaseModule } from '../database/database.module';
import { AcessosService } from './acessos.service';
import { InternoController } from './interno.controller';
import { ServicoKeyGuard } from './servico-key.guard';

@Module({
  imports: [DatabaseModule, AuthModule, BillingModule],
  controllers: [InternoController],
  providers: [AcessosService, ServicoKeyGuard],
})
export class InternoModule {}
