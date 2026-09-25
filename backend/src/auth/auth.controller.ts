import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Redirect,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { ITokenPayload } from '../common/interfaces/token-payload.interface';
import { urlDoFrontend } from '../mail/mail.service';
import {
  clearRefreshCookie,
  REFRESH_COOKIE,
  setRefreshCookie,
} from './auth-cookies';
import {
  AcessoView,
  AuthService,
  EscolherClinica,
  PessoaView,
  SessaoEmitida,
} from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { IsPublic } from './decorators/is-public.decorator';
import { LoginDto } from './dtos/login.dto';
import {
  ForgotPasswordDto,
  ResetPasswordDto,
  TrocarSenhaDto,
} from './dtos/senha.dtos';

export interface SessaoResponse {
  accessToken: string;
  pessoa: PessoaView;
  acesso: AcessoView;
}

const MINUTO = 60_000;
const HORA = 3_600_000;

const cookieDeRefresh = (req: Request): string | undefined =>
  (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];

/** Refresh vai no cookie httpOnly (invisível a JS); o access, no corpo. */
export function responderSessao(
  res: Response,
  s: SessaoEmitida,
): SessaoResponse {
  setRefreshCookie(res, s.refreshToken);
  return { accessToken: s.accessToken, pessoa: s.pessoa, acesso: s.acesso };
}

/**
 * Login único e senha (docs/contrato.md). Rate limits por IP como no Clinic:
 * login 5/min, forgot 3/h, reset 10/h (convites atrás do mesmo IP da clínica).
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Throttle({ default: { ttl: MINUTO, limit: 5 } })
  @IsPublic()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessaoResponse | EscolherClinica> {
    const r = await this.auth.login(dto);
    // Mais de uma clínica: sem sessão; o cliente refaz com o `tenantId`.
    return 'escolherClinica' in r ? r : responderSessao(res, r);
  }

  @Throttle({ default: { ttl: MINUTO, limit: 20 } })
  @IsPublic()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessaoResponse> {
    const atual = cookieDeRefresh(req);
    if (!atual) throw new UnauthorizedException('Refresh token ausente.');
    return responderSessao(res, await this.auth.refresh(atual));
  }

  /** Público: revoga pelo cookie mesmo com o access expirado; nunca 401. */
  @IsPublic()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(cookieDeRefresh(req));
    clearRefreshCookie(res);
  }

  @Throttle({ default: { ttl: HORA, limit: 3 } })
  @IsPublic()
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  forgotPassword(@Body() dto: ForgotPasswordDto): Promise<void> {
    return this.auth.forgotPassword(dto.email);
  }

  /** Redefinição de senha e aceite de convite (token de uso único). */
  @Throttle({ default: { ttl: HORA, limit: 10 } })
  @IsPublic()
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    return this.auth.resetPassword(dto.token, dto.password);
  }

  /** Troca da própria senha; a sessão atual segue com um refresh novo. */
  @Throttle({ default: { ttl: MINUTO, limit: 5 } })
  @ApiBearerAuth()
  @Post('trocar-senha')
  @HttpCode(HttpStatus.OK)
  async trocarSenha(
    @CurrentUser() user: ITokenPayload,
    @Body() dto: TrocarSenhaDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessaoResponse> {
    return responderSessao(
      res,
      await this.auth.trocarSenha(user, dto.senhaAtual, dto.novaSenha),
    );
  }

  /** Link do e-mail de confirmação: confirma e redireciona ao login do web. */
  @Throttle({ default: { ttl: HORA, limit: 20 } })
  @IsPublic()
  @Get('confirmar-email')
  @Redirect()
  async confirmarEmail(
    @Query('token') token?: string,
  ): Promise<{ url: string }> {
    const ok = token ? await this.auth.confirmarEmail(token) : false;
    return { url: `${urlDoFrontend()}/login?emailConfirmado=${ok ? 1 : 0}` };
  }

  @Throttle({ default: { ttl: HORA, limit: 3 } })
  @ApiBearerAuth()
  @Post('reenviar-confirmacao')
  @HttpCode(HttpStatus.NO_CONTENT)
  reenviarConfirmacao(@CurrentUser() user: ITokenPayload): Promise<void> {
    return this.auth.reenviarConfirmacao(user.sub);
  }
}
