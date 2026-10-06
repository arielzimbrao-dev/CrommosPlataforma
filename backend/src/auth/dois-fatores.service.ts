import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import {
  AuditService,
  ContextoAcesso,
  RECURSO_ACESSO,
} from '../audit/audit.service';
import { cifrar, decifrar } from '../common/crypto/cifra';
import { sha256 } from '../common/crypto/segredo';
import type { ITokenPayload } from '../common/interfaces/token-payload.interface';
import type { Produto } from '../common/produtos';
import { MailService } from '../mail/mail.service';
import { TentativasService } from './tentativas.service';
import { conferirSenha } from './tokens';
import {
  base32,
  gerarCodigosRecuperacao,
  gerarSegredo,
  normalizarRecuperacao,
  otpauthUrl,
  passoDoCodigo,
} from './totp';

/**
 * Papéis que a clínica pode obrigar a usar 2FA: admin e quem vê prontuário
 * (profissional; e qualquer acesso marcado `clinico`, vínculo com
 * profissional de saúde).
 */
export const PAPEIS_2FA_EXIGIVEL = ['admin', 'profissional'];
/** Tempo para digitar o código depois da senha. */
const DESAFIO_TTL = '5m';
/** Códigos errados por pessoa em 15 min antes do 429. */
export const FALHAS_CODIGO = 5;
const JANELA_CODIGO_MS = 15 * 60_000;
const LIMITE = '2fa-falha';

/** Chave (texto) e link `otpauth://` para cadastrar no app autenticador. */
export interface Configuracao2fa {
  chave: string;
  link: string;
}

/** Resposta do login depois da senha: falta o código do app. */
export interface DesafioDoisFatores {
  doisFatores: { desafio: string; configurar?: Configuracao2fa };
}

export interface Estado2fa {
  ativo: boolean;
  exigido: boolean;
  codigosRestantes: number;
}

interface Claims2fa {
  sub: string;
  produto: Produto;
  tenantId: string;
  typ: '2fa';
}

interface LinhaTotp {
  email: string;
  segredo: string | null;
  ativo: boolean;
  restantes: number;
}

export const exigidoPara = (
  papel: string,
  clinico: boolean,
  exigirNaClinica: boolean,
): boolean =>
  exigirNaClinica && (clinico || PAPEIS_2FA_EXIGIVEL.includes(papel));

/**
 * Verificação em duas etapas (TOTP) da pessoa — vale em todos os
 * produtos. Segredo cifrado; o código aceito grava o passo (não se reusa);
 * códigos de recuperação só com hash, consumidos numa instrução atômica.
 */
@Injectable()
export class DoisFatoresService {
  constructor(
    @Inject('DATA_SOURCE') private readonly ds: DataSource,
    private readonly jwt: JwtService,
    private readonly tentativas: TentativasService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  // ---- login ---------------------------------------------------------------

  /**
   * Depois da senha: `null` = entra direto (sem 2FA e não exigido). Com 2FA,
   * o desafio; exigido e sem 2FA, o desafio com um segredo novo para
   * configurar agora (o 1º código confirma e liga).
   */
  async desafioSeNecessario(
    usuarioId: string,
    alvo: { produto: Produto; tenantId: string; exigido: boolean },
  ): Promise<DesafioDoisFatores | null> {
    const t = await this.linha(usuarioId);
    if (!t.ativo && !alvo.exigido) return null;
    const configurar = t.ativo ? undefined : await this.novoSegredo(usuarioId);
    const desafio = await this.jwt.signAsync(
      {
        sub: usuarioId,
        produto: alvo.produto,
        tenantId: alvo.tenantId,
        typ: '2fa',
      } satisfies Claims2fa,
      { expiresIn: DESAFIO_TTL },
    );
    return { doisFatores: { desafio, ...(configurar ? { configurar } : {}) } };
  }

  /**
   * 2º passo do login: confere o desafio e o código (do app ou de
   * recuperação). Configuração pendente → liga e devolve os códigos de
   * recuperação (mostrados uma vez).
   */
  async validarDesafio(
    desafio: string,
    codigo: string,
    ctx: ContextoAcesso,
  ): Promise<{ claims: ITokenPayload; codigosRecuperacao?: string[] }> {
    const c = await this.jwt.verifyAsync<Claims2fa>(desafio).catch(() => null);
    if (c?.typ !== '2fa' || !c.sub) {
      throw new UnauthorizedException(
        'O tempo para digitar o código acabou. Entre de novo.',
      );
    }
    const claims: ITokenPayload = {
      sub: c.sub,
      produto: c.produto,
      tenantId: c.tenantId,
      typ: 'access',
    };
    const t = await this.linha(c.sub);
    const ok = await this.conferir(c.sub, codigo, t.ativo, ctx, claims);
    if (!ok) {
      // 400: o 401 fica para o desafio vencido (o front diz "entre de novo").
      throw new BadRequestException(
        'Código incorreto. Confira o app autenticador e tente de novo.',
      );
    }
    if (t.ativo) return { claims };
    return { claims, codigosRecuperacao: await this.ligar(c.sub, ctx, claims) };
  }

  // ---- Meu perfil ----------------------------------------------------------

  async estado(user: ITokenPayload): Promise<Estado2fa> {
    const [t, exigido] = await Promise.all([
      this.linha(user.sub),
      this.exigidoDe(user),
    ]);
    return {
      ativo: t.ativo,
      exigido,
      codigosRestantes: t.ativo ? t.restantes : 0,
    };
  }

  async iniciar(user: ITokenPayload): Promise<Configuracao2fa> {
    if ((await this.linha(user.sub)).ativo) {
      throw new ConflictException(
        'A verificação em duas etapas já está ligada.',
      );
    }
    return this.novoSegredo(user.sub);
  }

  /** Confirma a configuração com o 1º código; devolve os códigos de recuperação. */
  async confirmar(
    user: ITokenPayload,
    codigo: string,
    ctx: ContextoAcesso,
  ): Promise<{ codigosRecuperacao: string[] }> {
    const t = await this.linha(user.sub);
    if (t.ativo) {
      throw new ConflictException(
        'A verificação em duas etapas já está ligada.',
      );
    }
    if (!t.segredo) {
      throw new BadRequestException('Comece de novo: toque em "Ligar".');
    }
    if (!(await this.conferir(user.sub, codigo, false, ctx, user))) {
      // 400, não 401: um 401 faria o app tentar renovar a sessão.
      throw new BadRequestException(
        'Código incorreto. Confira o app autenticador e tente de novo.',
      );
    }
    return { codigosRecuperacao: await this.ligar(user.sub, ctx, user) };
  }

  /**
   * Desliga o próprio 2FA: pede a senha e o código (do app ou de
   * recuperação — quem perdeu o celular ainda desliga); não quando a
   * clínica exige.
   */
  async desligar(
    user: ITokenPayload,
    senha: string,
    codigo: string,
    ctx: ContextoAcesso,
  ): Promise<void> {
    await this.conferirSenha(user.sub, senha);
    if (await this.exigidoDe(user)) {
      throw new ConflictException(
        'A sua clínica exige a verificação em duas etapas para o seu perfil.',
      );
    }
    await this.exigirCodigo(user, codigo, true, ctx);
    await this.limpar(user.sub);
    await this.registrar(user, '2fa-desligado', ctx);
  }

  /**
   * Códigos de recuperação novos (os antigos deixam de valer). Pede a senha
   * e o código do app — não um de recuperação: quem não tem o celular
   * desliga e configura de novo.
   */
  async novosCodigos(
    user: ITokenPayload,
    senha: string,
    codigo: string,
    ctx: ContextoAcesso,
  ): Promise<{ codigosRecuperacao: string[] }> {
    await this.conferirSenha(user.sub, senha);
    if (!(await this.linha(user.sub)).ativo) {
      throw new ConflictException(
        'A verificação em duas etapas está desligada.',
      );
    }
    await this.exigirCodigo(user, codigo, false, ctx);
    const codigos = gerarCodigosRecuperacao();
    await this.ds.query(
      `UPDATE crommos.usuarios SET totp_recuperacao = $2, updated_at = now()
        WHERE id = $1`,
      [user.sub, codigos.map((c) => sha256(normalizarRecuperacao(c)))],
    );
    await this.registrar(user, '2fa-recuperacao-gerada', ctx);
    return { codigosRecuperacao: codigos };
  }

  // ---- admin da clínica ----------------------------------------------------

  async daClinica(
    user: ITokenPayload,
  ): Promise<{ exigir: boolean; comDoisFatores: string[] }> {
    const [s] = await this.ds.query<{ exigir: boolean }[]>(
      `SELECT exigir_2fa AS exigir FROM crommos.assinaturas
        WHERE produto = $1 AND tenant_id = $2 AND deleted_at IS NULL LIMIT 1`,
      [user.produto, user.tenantId],
    );
    const linhas = await this.ds.query<{ id: string }[]>(
      `SELECT u.id FROM crommos.acessos a
         JOIN crommos.usuarios u ON u.id = a.usuario_id
        WHERE a.produto = $1 AND a.tenant_id = $2 AND a.ativo
          AND NOT a.convite_pendente AND u.totp_ativo_em IS NOT NULL
        ORDER BY u.id`,
      [user.produto, user.tenantId],
    );
    return { exigir: !!s?.exigir, comDoisFatores: linhas.map((l) => l.id) };
  }

  async definirExigencia(
    user: ITokenPayload,
    exigir: boolean,
    ctx: ContextoAcesso,
  ): Promise<{ exigir: boolean }> {
    await this.ds.query(
      `UPDATE crommos.assinaturas SET exigir_2fa = $3, updated_at = now()
        WHERE produto = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [user.produto, user.tenantId, exigir],
    );
    // Quem passa a ser cobrado e ainda não configurou sai das sessões desta
    // clínica: configura no próximo login. Quem ligou fica (não cai no meio).
    if (exigir) {
      await this.ds.query(
        `UPDATE crommos.sessoes s SET revogada_em = now()
           FROM crommos.acessos a
           JOIN crommos.usuarios u ON u.id = a.usuario_id
          WHERE a.produto = $1 AND a.tenant_id = $2 AND a.ativo
            AND (a.clinico OR a.papel = ANY($3)) AND u.totp_ativo_em IS NULL
            AND a.usuario_id <> $4
            AND s.usuario_id = a.usuario_id AND s.produto = $1
            AND s.tenant_id = $2 AND s.revogada_em IS NULL`,
        [user.produto, user.tenantId, PAPEIS_2FA_EXIGIVEL, user.sub],
      );
    }
    await this.audit.registrar({
      ...ctx,
      usuarioId: user.sub,
      produto: user.produto,
      tenantId: user.tenantId,
      action: '2fa-exigencia',
      resource: 'assinatura',
      resourceId: exigir ? 'ligada' : 'desligada',
    });
    return { exigir };
  }

  /**
   * Quem perdeu o celular: o admin desliga (a pessoa configura de novo). O
   * 2FA é da pessoa e vale em todas as clínicas dela: só o admin de
   * uma clínica em que ela trabalha (acesso ativo e **aceito** — convite
   * pendente não conta); a pessoa recebe e-mail e o evento entra na trilha
   * dela em todas as clínicas.
   */
  async desligarDe(
    admin: ITokenPayload,
    usuarioId: string,
    ctx: ContextoAcesso,
  ): Promise<void> {
    const [a] = await this.ds.query<
      { email: string; clinica: string | null }[]
    >(
      `SELECT u.email, s.tenant_nome AS clinica
         FROM crommos.acessos a
         JOIN crommos.usuarios u ON u.id = a.usuario_id
         LEFT JOIN crommos.assinaturas s
           ON s.tenant_id = a.tenant_id AND s.produto = a.produto
          AND s.deleted_at IS NULL
        WHERE a.usuario_id = $1 AND a.produto = $2 AND a.tenant_id = $3
          AND a.ativo AND NOT a.convite_pendente`,
      [usuarioId, admin.produto, admin.tenantId],
    );
    if (!a) throw new NotFoundException('Usuário não encontrado.');
    await this.limpar(usuarioId);
    await this.audit.registrarDaPessoa(
      usuarioId,
      '2fa-desligado-por-admin',
      ctx,
      { tenantId: admin.tenantId, noutra: '2fa-desligado-por-outra-clinica' },
    );
    // Aviso de segurança: falha no envio não desfaz (o admin já decidiu).
    await this.mail
      .sendAvisoDoisFatoresDesligado(a.email, a.clinica)
      .catch(() => undefined);
    await this.audit.registrar({
      ...ctx,
      usuarioId: admin.sub,
      produto: admin.produto,
      tenantId: admin.tenantId,
      action: '2fa-desligado-pelo-admin',
      resource: RECURSO_ACESSO,
      resourceId: usuarioId,
    });
  }

  // ---- interno -------------------------------------------------------------

  private async conferirSenha(usuarioId: string, senha: string): Promise<void> {
    const [u] = await this.ds.query<{ hash: string }[]>(
      'SELECT password_hash AS hash FROM crommos.usuarios WHERE id = $1',
      [usuarioId],
    );
    if (!u || !(await conferirSenha(senha, u.hash))) {
      throw new BadRequestException('Senha incorreta.');
    }
  }

  /** Código certo ou 400 (não 401: um 401 faria o app tentar renovar a sessão). */
  private async exigirCodigo(
    user: ITokenPayload,
    codigo: string,
    aceitaRecuperacao: boolean,
    ctx: ContextoAcesso,
  ): Promise<void> {
    if (
      !(await this.conferir(user.sub, codigo, aceitaRecuperacao, ctx, user))
    ) {
      throw new BadRequestException(
        'Código incorreto. Confira o app autenticador e tente de novo.',
      );
    }
  }

  private async linha(usuarioId: string): Promise<LinhaTotp> {
    const [t] = await this.ds.query<LinhaTotp[]>(
      `SELECT email, totp_segredo AS segredo,
              totp_ativo_em IS NOT NULL AS ativo,
              coalesce(cardinality(totp_recuperacao), 0)::int AS restantes
         FROM crommos.usuarios WHERE id = $1`,
      [usuarioId],
    );
    if (!t) throw new UnauthorizedException();
    return t;
  }

  private async exigidoDe(user: ITokenPayload): Promise<boolean> {
    const [l] = await this.ds.query<
      { papel: string; clinico: boolean; exigir: boolean }[]
    >(
      `SELECT a.papel, a.clinico, coalesce(s.exigir_2fa, false) AS exigir
         FROM crommos.acessos a
         LEFT JOIN crommos.assinaturas s
           ON s.tenant_id = a.tenant_id AND s.produto = a.produto
          AND s.deleted_at IS NULL
        WHERE a.usuario_id = $1 AND a.produto = $2 AND a.tenant_id = $3
          AND a.ativo`,
      [user.sub, user.produto, user.tenantId],
    );
    return !!l && exigidoPara(l.papel, l.clinico, l.exigir);
  }

  /** Segredo novo (pendente até o 1º código): grava cifrado e devolve para o app. */
  private async novoSegredo(usuarioId: string): Promise<Configuracao2fa> {
    const segredo = gerarSegredo();
    const cifrado = this.comChave(() => cifrar(segredo.toString('hex')));
    const [[u]] = await this.ds.query<[{ email: string }[], number]>(
      `UPDATE crommos.usuarios
          SET totp_segredo = $2, totp_ativo_em = NULL, totp_ultimo_passo = NULL,
              totp_recuperacao = NULL, updated_at = now()
        WHERE id = $1 RETURNING email`,
      [usuarioId, cifrado],
    );
    const chave = base32(segredo);
    return { chave, link: otpauthUrl(chave, u.email) };
  }

  /**
   * Código do app (6 dígitos: grava o passo, só se maior que o último) ou, com
   * o 2FA ligado, de recuperação (sai da lista). Falha conta no limite.
   */
  private async conferir(
    usuarioId: string,
    codigo: string,
    aceitaRecuperacao: boolean,
    ctx: ContextoAcesso,
    alvo: ITokenPayload,
  ): Promise<boolean> {
    if (await this.tentativas.esgotado(LIMITE, usuarioId, FALHAS_CODIGO)) {
      throw new HttpException(
        'Muitas tentativas. Aguarde 15 minutos e tente de novo.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const ok = /^\s*\d{6}\s*$/.test(codigo)
      ? await this.usarTotp(usuarioId, codigo.trim())
      : aceitaRecuperacao && (await this.usarRecuperacao(usuarioId, codigo));
    if (!ok) {
      await this.tentativas.permitir(
        LIMITE,
        usuarioId,
        FALHAS_CODIGO,
        JANELA_CODIGO_MS,
      );
      await this.registrar(alvo, '2fa-falha', ctx);
    }
    return ok;
  }

  private async usarTotp(usuarioId: string, codigo: string): Promise<boolean> {
    const t = await this.linha(usuarioId);
    if (!t.segredo) return false;
    const segredo = Buffer.from(
      this.comChave(() => decifrar(t.segredo!)),
      'hex',
    );
    const passo = passoDoCodigo(segredo, codigo);
    if (passo === null) return false;
    const [, n] = await this.ds.query<[unknown[], number]>(
      `UPDATE crommos.usuarios SET totp_ultimo_passo = $2
        WHERE id = $1 AND (totp_ultimo_passo IS NULL OR totp_ultimo_passo < $2)`,
      [usuarioId, passo],
    );
    return n === 1;
  }

  private async usarRecuperacao(
    usuarioId: string,
    codigo: string,
  ): Promise<boolean> {
    const h = sha256(normalizarRecuperacao(codigo));
    const [, n] = await this.ds.query<[unknown[], number]>(
      `UPDATE crommos.usuarios
          SET totp_recuperacao = array_remove(totp_recuperacao, $2)
        WHERE id = $1 AND totp_ativo_em IS NOT NULL
          AND $2 = ANY(totp_recuperacao)`,
      [usuarioId, h],
    );
    return n === 1;
  }

  /** Liga (pendente → ativo) e devolve os códigos de recuperação novos. */
  private async ligar(
    usuarioId: string,
    ctx: ContextoAcesso,
    alvo: ITokenPayload,
  ): Promise<string[]> {
    const codigos = gerarCodigosRecuperacao();
    await this.ds.query(
      `UPDATE crommos.usuarios
          SET totp_ativo_em = now(), totp_recuperacao = $2, updated_at = now()
        WHERE id = $1`,
      [usuarioId, codigos.map((c) => sha256(normalizarRecuperacao(c)))],
    );
    await this.registrar(alvo, '2fa-ligado', ctx);
    return codigos;
  }

  private async limpar(usuarioId: string): Promise<void> {
    await this.ds.query(
      `UPDATE crommos.usuarios
          SET totp_segredo = NULL, totp_ativo_em = NULL, totp_ultimo_passo = NULL,
              totp_recuperacao = NULL, updated_at = now()
        WHERE id = $1`,
      [usuarioId],
    );
  }

  private registrar(
    alvo: ITokenPayload,
    action: string,
    ctx: ContextoAcesso,
  ): Promise<void> {
    return this.audit.registrar({
      ...ctx,
      usuarioId: alvo.sub,
      produto: alvo.produto,
      tenantId: alvo.tenantId,
      action,
      resource: RECURSO_ACESSO,
    });
  }

  /** Sem DATA_ENCRYPTION_KEY: 503 (nunca grava nem lê o segredo em claro). */
  private comChave<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof Error && e.message.includes('DATA_ENCRYPTION_KEY')) {
        throw new ServiceUnavailableException(
          'A verificação em duas etapas está indisponível no momento. Tente mais tarde.',
        );
      }
      throw e;
    }
  }
}
