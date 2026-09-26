import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { DataSource } from 'typeorm';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { ContaModule } from './conta/conta.module';
import { AllExceptionsFilter } from './common/exceptions/all-exceptions.filter';
import { HealthController } from './common/health/health.controller';
import { ThrottlerPostgres } from './common/http/throttler-postgres';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { InternoModule } from './interno/interno.module';
import { MailModule } from './mail/mail.module';
import { SignupModule } from './signup/signup.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    // Rate limit global por IP (backstop); limites estritos por rota ficam nos
    // controllers (@Throttle). Desligado em teste (muitos logins na janela).
    // Contagem no Postgres (crommos.rate_limit): vale para todas as réplicas.
    ThrottlerModule.forRootAsync({
      imports: [DatabaseModule],
      inject: ['DATA_SOURCE'],
      useFactory: (ds: DataSource) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }],
        skipIf: () => process.env.NODE_ENV === 'test',
        storage: new ThrottlerPostgres(ds, 'crommos.rate_limit'),
      }),
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    AuditModule,
    MailModule,
    AuthModule,
    SignupModule,
    InternoModule,
    BillingModule,
    ContaModule,
  ],
  controllers: [HealthController],
  providers: [
    // Rate limit antes de qualquer processamento.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
