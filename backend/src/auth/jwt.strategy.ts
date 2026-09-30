import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PRODUTOS } from '../common/produtos';
import { ITokenPayload } from '../common/interfaces/token-payload.interface';
import { normalizarPem } from './chaves-jwt';
import { SessoesService } from './sessoes.service';

/**
 * Valida o **access token** (Bearer, RS256 com a chave pública da
 * plataforma). O retorno vira `request.user`.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly sessoes: SessoesService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: normalizarPem(
        config.getOrThrow<string>('PLATAFORMA_JWT_PUBLIC_KEY'),
      ),
      algorithms: ['RS256'],
    });
  }

  async validate(payload: ITokenPayload): Promise<ITokenPayload> {
    // Só o access autentica rota (o refresh tem `typ: 'refresh'`).
    if (
      !payload?.sub ||
      !payload.tenantId ||
      !PRODUTOS.includes(payload.produto) ||
      payload.typ !== 'access'
    ) {
      throw new UnauthorizedException('Token inválido.');
    }
    // Logout/senha/desativação derrubam o access na hora. Sem `sid` (token
    // antigo): vale até expirar.
    if (
      payload.sid &&
      !(await this.sessoes.sessaoVigente(payload.sid, payload.sub))
    ) {
      throw new UnauthorizedException('Sessão encerrada.');
    }
    return {
      sub: payload.sub,
      produto: payload.produto,
      tenantId: payload.tenantId,
      typ: payload.typ,
      ...(payload.sid ? { sid: payload.sid } : {}),
    };
  }
}
