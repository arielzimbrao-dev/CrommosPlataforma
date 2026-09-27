import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { DatabaseModule } from '../database/database.module';
import { AcessoGuard } from './acesso.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { normalizarPem } from './chaves-jwt';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtStrategy } from './jwt.strategy';
import { SessoesCron } from './sessoes.cron';
import { SessoesService } from './sessoes.service';
import { TentativasService } from './tentativas.service';

/**
 * Login único, tokens RS256 e sessões. Registra globalmente, **nesta ordem**:
 * JwtAuthGuard (access token, exceto `@IsPublic()`) e AcessoGuard
 * (`@ExigeAcesso()`: acesso ativo e papel).
 */
@Module({
  imports: [
    DatabaseModule,
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        privateKey: normalizarPem(
          config.getOrThrow<string>('PLATAFORMA_JWT_PRIVATE_KEY'),
        ),
        publicKey: normalizarPem(
          config.getOrThrow<string>('PLATAFORMA_JWT_PUBLIC_KEY'),
        ),
        signOptions: { algorithm: 'RS256' },
        verifyOptions: { algorithms: ['RS256'] },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessoesService,
    SessoesCron,
    TentativasService,
    JwtStrategy,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: AcessoGuard },
  ],
  exports: [AuthService, SessoesService],
})
export class AuthModule {}
