import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PRODUTOS } from '../common/produtos';
import { ITokenPayload } from '../common/interfaces/token-payload.interface';
import { ChavesJwt, chavesJwt, chaveDoToken } from './chaves-jwt';
import { SessoesService } from './sessoes.service';

/** `iss`, `aud` ∈ produtos e a pública escolhida pela `kid` (atual ou anterior). */
const verificacao = (c: ChavesJwt) => ({
  issuer: c.emissor,
  audience: [...PRODUTOS],
  secretOrKeyProvider: (
    _req: unknown,
    token: string,
    done: (erro: Error | null, chave?: string) => void,
  ) => {
    const chave = chaveDoToken(c, token);
    if (chave) done(null, chave);
    else done(new UnauthorizedException('Token inválido.'));
  },
});

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
      algorithms: ['RS256'],
      ...verificacao(chavesJwt(config)),
    });
  }

  async validate(payload: ITokenPayload): Promise<ITokenPayload> {
    // Só o access autentica rota (o refresh tem `typ: 'refresh'`).
    if (
      !payload?.sub ||
      !payload.tenantId ||
      !PRODUTOS.includes(payload.produto) ||
      payload.typ !== 'access' ||
      payload.aud !== payload.produto
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
