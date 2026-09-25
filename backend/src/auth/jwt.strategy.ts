import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PRODUTOS } from '../common/produtos';
import { ITokenPayload } from '../common/interfaces/token-payload.interface';
import { normalizarPem } from './chaves-jwt';

/**
 * Valida o **access token** (Bearer, RS256 com a chave pública da
 * plataforma). O retorno vira `request.user`.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: normalizarPem(
        config.getOrThrow<string>('PLATAFORMA_JWT_PUBLIC_KEY'),
      ),
      algorithms: ['RS256'],
    });
  }

  validate(payload: ITokenPayload): ITokenPayload {
    // Só o access autentica rota (o refresh tem `typ: 'refresh'`).
    if (
      !payload?.sub ||
      !payload.tenantId ||
      !PRODUTOS.includes(payload.produto) ||
      payload.typ !== 'access'
    ) {
      throw new UnauthorizedException('Token inválido.');
    }
    return {
      sub: payload.sub,
      produto: payload.produto,
      tenantId: payload.tenantId,
      typ: payload.typ,
    };
  }
}
