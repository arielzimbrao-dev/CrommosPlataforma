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
import { AuditService, type ContextoAcesso } from '../audit/audit.service';
import { paginar } from '../common/paginacao';
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
  VerificacaoToken,
} from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { ExigeAcesso, PAPEL_ADMIN } from './decorators/exige-acesso.decorator';
import { IsPublic } from './decorators/is-public.decorator';
import { LoginCodigoDto, LoginDto } from './dtos/login.dto';
import type { DesafioDoisFatores } from './dois-fatores.service';
import {
  AceitarConviteDto,
  ListarAcessosDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  TrocarSenhaDto,
  VerificarTokenDto,
} from './dtos/senha.dtos';

export interface SessaoResponse {
  accessToken: string;
  pessoa: PessoaView;
  acesso: AcessoView;
}

const MINUTO = 60_000;
const HORA = 3_600_000;

/** L-24: IP (`trust proxy` conforme TRUST_PROXY, main.ts) e navegador. */
export const contextoDe = (req: Request): ContextoAcesso => ({
  ip: req.ip,
  userAgent: req.headers['user-agent'],
});

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
 * Login único e senha (docs/contrato.md). Rate limits (QA-003): por IP,
 * generosos (a clínica inteira sai pelo mesmo NAT) — login 60/min, forgot
 * 30/h, reenviar confirmação 20/h, reset 10/h; por alvo, no AuthService — 5
 * falhas de login por IP + e-mail (e 50 por IP) em 15 min, 3 e-mails por
 * hora por endereço/pessoa.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  // Backstop por IP (todas as tentativas): generoso, para a clínica atrás de
  // um NAT; as falhas são contadas no AuthService (IP + e-mail).
  @Throttle({ default: { ttl: MINUTO, limit: 60 } })
  @IsPublic()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessaoResponse | EscolherClinica | DesafioDoisFatores> {
    const r = await this.auth.login(dto, contextoDe(req));
    // Mais de uma clínica: sem sessão; o cliente refaz com o `tenantId`.
    // Com 2FA (L-07): sem sessão; o cliente manda o código ao /login/codigo.
    return 'escolherClinica' in r || 'doisFatores' in r
      ? r
      : responderSessao(res, r);
  }

  /** 2º passo do login com 2FA: desafio + código do app ou de recuperação. */
  @Throttle({ default: { ttl: MINUTO, limit: 30 } })
  @IsPublic()
  @Post('login/codigo')
  @HttpCode(HttpStatus.OK)
  async loginCodigo(
    @Body() dto: LoginCodigoDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessaoResponse & { codigosRecuperacao?: string[] }> {
    const s = await this.auth.loginComCodigo(
      dto.desafio,
      dto.codigo,
      contextoDe(req),
    );
    return s.codigosRecuperacao
      ? {
          ...responderSessao(res, s),
          codigosRecuperacao: s.codigosRecuperacao,
        }
      : responderSessao(res, s);
  }

  // QA-100: por IP, generoso (a clínica inteira atrás de um NAT renova junto);
  // o limite estrito é por sessão (20/min, no AuthService). O 429 não encerra
  // a sessão: o refresh não é consumido e o cliente tenta de novo.
  @Throttle({ default: { ttl: MINUTO, limit: 300 } })
  @IsPublic()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessaoResponse> {
    const atual = cookieDeRefresh(req);
    if (!atual) throw new UnauthorizedException('Refresh token ausente.');
    return responderSessao(
      res,
      await this.auth.refresh(atual, contextoDe(req)),
    );
  }

  /** Público: revoga pelo cookie mesmo com o access expirado; nunca 401. */
  @IsPublic()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(cookieDeRefresh(req), contextoDe(req));
    clearRefreshCookie(res);
  }

  @Throttle({ default: { ttl: HORA, limit: 30 } })
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
  resetPassword(
    @Body() dto: ResetPasswordDto,
    @Req() req: Request,
  ): Promise<void> {
    return this.auth.resetPassword(dto.token, dto.password, contextoDe(req));
  }

  /** Troca da própria senha; a sessão atual segue com um refresh novo. */
  @Throttle({ default: { ttl: MINUTO, limit: 5 } })
  @ApiBearerAuth()
  @Post('trocar-senha')
  @HttpCode(HttpStatus.OK)
  async trocarSenha(
    @CurrentUser() user: ITokenPayload,
    @Body() dto: TrocarSenhaDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessaoResponse> {
    return responderSessao(
      res,
      await this.auth.trocarSenha(
        user,
        dto.senhaAtual,
        dto.novaSenha,
        contextoDe(req),
      ),
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

  /**
   * Link antigo do e-mail de convite (QA-004): não aceita mais sozinho (um
   * leitor de links aceitaria). Só leva à página do front, que tem o botão.
   */
  @Throttle({ default: { ttl: HORA, limit: 20 } })
  @IsPublic()
  @Get('aceitar-convite')
  @Redirect()
  redirecionarAceite(@Query('token') token?: string): { url: string } {
    const q = token ? `?token=${encodeURIComponent(token)}` : '';
    return { url: `${urlDoFrontend()}/aceitar-convite${q}` };
  }

  /** Aceite do convite pelo botão da página do front. */
  @Throttle({ default: { ttl: HORA, limit: 20 } })
  @IsPublic()
  @Post('aceitar-convite')
  @HttpCode(HttpStatus.OK)
  aceitarConvite(
    @Body() dto: AceitarConviteDto,
    @Req() req: Request,
  ): Promise<{ clinicaNome: string | null }> {
    return this.auth.aceitarConvite(dto.token, contextoDe(req));
  }

  /** A página do link do e-mail valida o token ao abrir (sem consumi-lo). */
  @Throttle({ default: { ttl: HORA, limit: 20 } })
  @IsPublic()
  @Get('verificar-token')
  verificarToken(@Query() q: VerificarTokenDto): Promise<VerificacaoToken> {
    return this.auth.verificarToken(q.tipo, q.token);
  }

  /**
   * L-24: acessos da equipe (login, falhas, refresh, senha, logout) dos
   * últimos 90 dias, com IP e navegador. Só o admin da clínica.
   */
  @ApiBearerAuth()
  @ExigeAcesso(PAPEL_ADMIN)
  @Get('acessos')
  acessos(@CurrentUser() user: ITokenPayload, @Query() q: ListarAcessosDto) {
    return this.audit.listarAcessos(user.produto, user.tenantId, {
      usuarioId: q.usuarioId,
      ...paginar(q),
    });
  }

  @Throttle({ default: { ttl: HORA, limit: 20 } })
  @ApiBearerAuth()
  @Post('reenviar-confirmacao')
  @HttpCode(HttpStatus.NO_CONTENT)
  reenviarConfirmacao(@CurrentUser() user: ITokenPayload): Promise<void> {
    return this.auth.reenviarConfirmacao(user.sub);
  }
}
