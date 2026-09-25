import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { AllExceptionsFilter } from './common/exceptions/all-exceptions.filter';
import { HealthController } from './common/health/health.controller';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { MailModule } from './mail/mail.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    // Rate limit global por IP (backstop); limites estritos por rota ficam nos
    // controllers (@Throttle). Desligado em teste (muitos logins na janela).
    // ponytail: storage em memória (instância única); Redis se escalar.
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }],
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    AuditModule,
    MailModule,
    AuthModule,
    BillingModule,
  ],
  controllers: [HealthController],
  providers: [
    // Rate limit antes de qualquer processamento.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
