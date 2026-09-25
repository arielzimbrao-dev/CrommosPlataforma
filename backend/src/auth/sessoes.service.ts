import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { IsNull, LessThan, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { sha256 } from '../common/crypto/segredo';
import { ITokenPayload } from '../common/interfaces/token-payload.interface';
import type { Produto } from '../common/produtos';
import { durationToMs } from './auth-cookies';
import { Sessao } from './sessao.entity';
import { hashesIguais } from './tokens';

export interface ParDeTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AlvoSessao {
  usuarioId: string;
  produto: Produto;
  tenantId: string;
}

const REFRESH_PADRAO_MS = 7 * 24 * 60 * 60 * 1000;
/** Sessões vencidas há mais de 1 dia saem na limpeza diária. */
const RETENCAO_VENCIDAS_MS = 24 * 60 * 60 * 1000;

// `expiresIn` vem da config como string ('15m', '7d'); os tipos do
// jsonwebtoken querem o template `StringValue` — validado em runtime.
const expiresIn = (v: string): JwtSignOptions['expiresIn'] =>
  v as unknown as JwtSignOptions['expiresIn'];

/**
 * Tokens (RS256) e sessões de refresh (`crommos.sessoes`): emite o par,
 * rotaciona o refresh (a sessão anterior fica revogada), detecta reuso de um
 * refresh já rotacionado (revoga todas as sessões da pessoa) e revoga por
 * pessoa/tenant (logout, desativação, redefinição e troca de senha).
 */
@Injectable()
export class SessoesService {
  private readonly logger = new Logger(SessoesService.name);

  constructor(
    @Inject('SESSAO_REPOSITORY') private readonly sessoes: Repository<Sessao>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  /** Emite access + refresh e grava a sessão (hash do refresh). */
  async emitir(
    alvo: AlvoSessao,
    jti: string = randomUUID(),
  ): Promise<ParDeTokens> {
    const base = {
      sub: alvo.usuarioId,
      produto: alvo.produto,
      tenantId: alvo.tenantId,
    };
    const accessToken = await this.jwt.signAsync(
      { ...base, typ: 'access' },
      {
        expiresIn: expiresIn(this.config.get<string>('JWT_EXPIRES_IN', '15m')),
      },
    );
    const ttl = this.config.get<string>('JWT_REFRESH_EXPIRES_IN', '7d');
    const refreshToken = await this.jwt.signAsync(
      { ...base, typ: 'refresh', jti },
      { expiresIn: expiresIn(ttl) },
    );
    await this.sessoes.insert({
      jti,
      usuarioId: alvo.usuarioId,
      produto: alvo.produto,
      tenantId: alvo.tenantId,
      refreshHash: sha256(refreshToken),
      expiraEm: new Date(Date.now() + durationToMs(ttl, REFRESH_PADRAO_MS)),
      revogadaEm: null,
      substituidaPor: null,
    });
    return { accessToken, refreshToken };
  }

  /** Claims de um refresh válido (assinatura, validade, `typ` e `jti`), ou `null`. */
  async lerRefresh(token: string): Promise<ITokenPayload | null> {
    try {
      const p = await this.jwt.verifyAsync<ITokenPayload>(token);
      return p.typ === 'refresh' && p.jti && p.sub ? p : null;
    } catch {
      return null;
    }
  }

  /**
   * Consome o refresh (rotação): confere a sessão e a revoga atomicamente,
   * apontando a substituta (`jtiNovo`, a usar no `emitir`) — o UPDATE só casa
   * se ela ainda estiver vigente. Refresh **já rotacionado** reapresentado =
   * reuso (token vazado ou replay): revoga todas as sessões da pessoa. Sessão
   * revogada por logout/senha/desativação só dá 401.
   */
  async consumir(
    token: string,
  ): Promise<{ claims: ITokenPayload; jtiNovo: string }> {
    const invalido = new UnauthorizedException(
      'Refresh token inválido ou expirado.',
    );
    const p = await this.lerRefresh(token);
    if (!p) throw invalido;
    const sessao = await this.sessoes.findOne({ where: { jti: p.jti } });
    if (
      !sessao ||
      sessao.usuarioId !== p.sub ||
      !hashesIguais(sessao.refreshHash, sha256(token))
    ) {
      throw invalido;
    }
    if (sessao.revogadaEm && !sessao.substituidaPor) throw invalido;
    const jtiNovo = randomUUID();
    const r = sessao.revogadaEm
      ? { affected: 0 }
      : await this.sessoes.update(
          { jti: sessao.jti, revogadaEm: IsNull() },
          { revogadaEm: new Date(), substituidaPor: jtiNovo },
        );
    if (!r.affected) {
      await this.revogarDaPessoa(p.sub);
      this.logger.warn(
        '[sessao] reuso de refresh: sessões da pessoa revogadas.',
      );
      await this.audit.registrar({
        usuarioId: p.sub,
        produto: p.produto,
        tenantId: p.tenantId,
        action: 'refresh-reutilizado',
        resource: 'sessao',
        resourceId: p.jti,
      });
      throw invalido;
    }
    return { claims: p, jtiNovo };
  }

  /**
   * Logout: revoga a sessão do refresh apresentado. Nunca falha (token
   * inválido ou já revogado = nada a fazer). Devolve as claims se revogou.
   */
  async encerrar(token: string | undefined): Promise<ITokenPayload | null> {
    if (!token) return null;
    const p = await this.lerRefresh(token);
    if (!p) return null;
    const r = await this.sessoes.update(
      { jti: p.jti, refreshHash: sha256(token), revogadaEm: IsNull() },
      { revogadaEm: new Date() },
    );
    return r.affected ? p : null;
  }

  /**
   * Revoga as sessões vigentes da pessoa — todas, ou só as de um tenant de um
   * produto. O access já emitido expira em ≤ 15 min (e o produto confere o
   * vínculo a cada requisição).
   */
  async revogarDaPessoa(
    usuarioId: string,
    tenant?: { produto: Produto; tenantId: string },
  ): Promise<void> {
    await this.sessoes.update(
      { usuarioId, revogadaEm: IsNull(), ...(tenant ?? {}) },
      { revogadaEm: new Date() },
    );
  }

  /** Remove as sessões vencidas há mais de um dia (job diário). */
  async limparVencidas(agora = Date.now()): Promise<number> {
    const r = await this.sessoes.delete({
      expiraEm: LessThan(new Date(agora - RETENCAO_VENCIDAS_MS)),
    });
    return r.affected ?? 0;
  }
}
