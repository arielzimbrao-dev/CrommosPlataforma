import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ProvisionamentoClient } from './provisionamento.client';
import { SignupController } from './signup.controller';
import { SignupService } from './signup.service';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [SignupController],
  providers: [SignupService, ProvisionamentoClient],
})
export class SignupModule {}
