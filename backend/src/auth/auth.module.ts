import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { DatabaseModule } from '../database/database.module';
import { AcessoGuard } from './acesso.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { DoisFatoresController } from './dois-fatores.controller';
import { DoisFatoresService } from './dois-fatores.service';
import { chavesJwt, opcoesJwt } from './chaves-jwt';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtStrategy } from './jwt.strategy';
import { SessoesCron } from './sessoes.cron';
import { SessoesService } from './sessoes.service';
import { TentativasService } from './tentativas.service';

/**
 * Login único, tokens RS256 (`iss`, `aud`, `kid`; rotação em `chaves-jwt.ts`) e sessões. Registra globalmente, **nesta ordem**:
 * JwtAuthGuard (access token, exceto `@IsPublic()`) e AcessoGuard
 * (`@ExigeAcesso()`: acesso ativo e papel).
 */
@Module({
  imports: [
    DatabaseModule,
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => opcoesJwt(chavesJwt(config)),
    }),
  ],
  controllers: [AuthController, DoisFatoresController],
  providers: [
    AuthService,
    DoisFatoresService,
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
