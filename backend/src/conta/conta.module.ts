import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ProvisionamentoClient } from '../signup/provisionamento.client';
import { ContaController } from './conta.controller';
import { ContaService } from './conta.service';

/** LGPD da pessoa (exportar e excluir a conta). */
@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [ContaController],
  providers: [ContaService, ProvisionamentoClient],
})
export class ContaModule {}
