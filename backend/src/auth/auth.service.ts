import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { IsNull, MoreThan, Repository } from 'typeorm';
import {
  AuditService,
  ContextoAcesso,
  RECURSO_ACESSO,
} from '../audit/audit.service';
import { Assinatura } from '../billing/assinatura.entity';
import { sha256 } from '../common/crypto/segredo';
import { ITokenPayload } from '../common/interfaces/token-payload.interface';
import { configProduto, Produto } from '../common/produtos';
import { MailService } from '../mail/mail.service';
import { Acesso } from './acesso.entity';
import {
  DesafioDoisFatores,
  DoisFatoresService,
  exigidoPara,
} from './dois-fatores.service';
import { LoginDto } from './dtos/login.dto';
import type { TipoToken } from './dtos/senha.dtos';
import { SessoesService } from './sessoes.service';
import { TentativasService } from './tentativas.service';
import {
  conferirSenha,
  gerarConfirmacaoEmail,
  gerarTokenUsoUnico,
  HASH_FALSO,
  hashSenha,
  normalizarEmail,
  RESET_TOKEN_TTL_MS,
} from './tokens';
import { Usuario } from './usuario.entity';

/** E-mails de senha/confirmação por alvo (endereço ou pessoa) por hora. */
const ENVIOS_POR_HORA = 3;
const HORA_MS = 3_600_000;
const MINUTO_MS = 60_000;
/** QA-100: renovações por sessão (família) por minuto. */
const REFRESH_POR_SESSAO = 20;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PessoaView {
  id: string;
  nome: string;
  email: string;
}

export interface AcessoView {
  produto: Produto;
  tenantId: string;
  papel: string;
}

/** Sessão aberta: o refresh vai para o cookie; o resto é o corpo da resposta. */
export interface SessaoEmitida {
  accessToken: string;
  refreshToken: string;
  pessoa: PessoaView;
  acesso: AcessoView;
}

export interface ClinicaParaEscolher {
  tenantId: string;
  codigo: string | null;
  nome: string;
}

/** Mais de um acesso ativo no produto e sem `tenantId`: sem sessão. */
export interface EscolherClinica {
  escolherClinica: ClinicaParaEscolher[];
}

export type ResultadoLogin =
  | SessaoEmitida
  | EscolherClinica
  | DesafioDoisFatores;

export type MotivoTokenInvalido = 'expirado' | 'usado' | 'invalido';

/** `GET /auth/verificar-token` (docs/contrato.md). */
export type VerificacaoToken =
  | { valido: true; email: string; clinicaNome: string | null }
  | { valido: false; motivo: MotivoTokenInvalido };

interface LinhaAcesso {
  tenant_id: string;
  papel: string;
  clinico: boolean;
  exigir_2fa: boolean;
  codigo: string | null;
  nome: string | null;
}

/** Produto sem API/chave configuradas não tem login nem signup (400). */
export function exigirProdutoDisponivel(produto: Produto): void {
  if (!configProduto(produto)) {
    throw new BadRequestException('Produto indisponível.');
  }
}

/**
 * Login único (docs/contrato.md): autentica a pessoa (`crommos.usuarios`),
 * escolhe o acesso ao tenant do produto e emite os tokens. Também cuida da
 * senha (esqueci/redefinir/trocar, convite) e da confirmação do e-mail — tudo
 * da pessoa, valendo para todos os produtos.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject('USUARIO_REPOSITORY')
    private readonly usuarios: Repository<Usuario>,
    @Inject('ACESSO_REPOSITORY')
    private readonly acessos: Repository<Acesso>,
    @Inject('ASSINATURA_REPOSITORY')
    private readonly assinaturas: Repository<Assinatura>,
    private readonly sessoes: SessoesService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly tentativas: TentativasService,
    private readonly doisFatores: DoisFatoresService,
  ) {}

  /**
   * Com `tenantId` (UUID ou código de 5), entra naquele tenant; sem ele, um
   * acesso ativo no produto entra direto e mais de um devolve a lista. A
   * resposta de erro é sempre o mesmo 401 (e o bcrypt roda sempre), para não
   * revelar se o e-mail, o tenant ou o acesso existem.
   */
  async login(
    dto: LoginDto,
    ctx: ContextoAcesso = {},
  ): Promise<ResultadoLogin> {
    exigirProdutoDisponivel(dto.produto);
    const email = normalizarEmail(dto.email);
    const ip = ctx.ip ?? '';
    // QA-003: só as falhas contam (por IP + e-mail e por IP); 429 antes do bcrypt.
    await this.tentativas.exigirLoginLiberado(ip, email);
    const r = await this.autenticar(dto, email, ctx).catch(
      async (e: unknown) => {
        if (e instanceof UnauthorizedException) {
          await this.tentativas.registrarFalhaLogin(ip, email);
          await this.registrarFalha(dto, email, ctx);
        }
        throw e;
      },
    );
    await this.tentativas.limparFalhasLogin(ip, email);
    return r;
  }

  /** L-24: falha de login com IP (e a pessoa, se o e-mail existe; nunca o e-mail). */
  private async registrarFalha(
    dto: LoginDto,
    email: string,
    ctx: ContextoAcesso,
  ): Promise<void> {
    const u = await this.usuarios.findOne({
      where: { email },
      select: { id: true },
    });
    await this.audit.registrar({
      ...ctx,
      usuarioId: u?.id ?? null,
      produto: dto.produto,
      action: 'login-falha',
      resource: RECURSO_ACESSO,
    });
  }

  private async autenticar(
    dto: LoginDto,
    email: string,
    ctx: ContextoAcesso,
  ): Promise<ResultadoLogin> {
    const usuario = await this.usuarios.findOne({
      where: { email },
      select: { id: true, email: true, nome: true, passwordHash: true },
    });
    const invalido = new UnauthorizedException('E-mail ou senha incorretos.');
    const ok = await conferirSenha(
      dto.password,
      usuario?.passwordHash ?? HASH_FALSO,
    );
    if (!usuario || !ok) throw invalido;

    const tenantId = dto.tenantId
      ? await this.resolverTenant(dto.produto, dto.tenantId)
      : undefined;
    if (tenantId === null) throw invalido;
    const linhas = await this.acessosAtivos(usuario.id, dto.produto, tenantId);
    if (linhas.length === 0) throw invalido;
    if (linhas.length > 1) {
      return {
        escolherClinica: linhas
          .map((l) => ({
            tenantId: l.tenant_id,
            codigo: l.codigo,
            nome: l.nome ?? l.codigo ?? l.tenant_id,
          }))
          .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')),
      };
    }
    const [l] = linhas;
    // L-07: com 2FA (ou exigido pela clínica), falta o código do app.
    const desafio = await this.doisFatores.desafioSeNecessario(usuario.id, {
      produto: dto.produto,
      tenantId: l.tenant_id,
      exigido: exigidoPara(l.papel, l.clinico, l.exigir_2fa),
    });
    if (desafio) return desafio;
    return this.iniciarSessao(
      usuario,
      { produto: dto.produto, tenantId: l.tenant_id, papel: l.papel },
      'login',
      ctx,
    );
  }

  /**
   * 2º passo do login (L-07): o código do app (ou de recuperação) contra o
   * desafio da senha. Configurou agora → devolve também os códigos de
   * recuperação.
   */
  async loginComCodigo(
    desafio: string,
    codigo: string,
    ctx: ContextoAcesso = {},
  ): Promise<SessaoEmitida & { codigosRecuperacao?: string[] }> {
    const { claims, codigosRecuperacao } =
      await this.doisFatores.validarDesafio(desafio, codigo, ctx);
    const { usuario, acesso } = await this.exigirAcessoAtivo(claims);
    const sessao = await this.iniciarSessao(
      usuario,
      {
        produto: acesso.produto,
        tenantId: acesso.tenantId,
        papel: acesso.papel,
      },
      'login',
      ctx,
    );
    return codigosRecuperacao ? { ...sessao, codigosRecuperacao } : sessao;
  }

  /** Emite a sessão de um acesso já autenticado e audita (login, signup, troca). */
  async iniciarSessao(
    usuario: Pick<Usuario, 'id' | 'nome' | 'email'>,
    acesso: AcessoView,
    action: string,
    ctx: ContextoAcesso = {},
  ): Promise<SessaoEmitida> {
    const sessao = await this.abrirSessao(usuario, acesso);
    await this.audit.registrar({
      ...ctx,
      usuarioId: usuario.id,
      produto: acesso.produto,
      tenantId: acesso.tenantId,
      action,
      resource: 'auth',
    });
    return sessao;
  }

  private async abrirSessao(
    usuario: Pick<Usuario, 'id' | 'nome' | 'email'>,
    acesso: AcessoView,
    rotacao?: { jti: string; familia: string },
  ): Promise<SessaoEmitida> {
    const tokens = await this.sessoes.emitir(
      {
        usuarioId: usuario.id,
        produto: acesso.produto,
        tenantId: acesso.tenantId,
      },
      rotacao?.jti,
      rotacao?.familia,
    );
    return {
      ...tokens,
      pessoa: { id: usuario.id, nome: usuario.nome, email: usuario.email },
      acesso: {
        produto: acesso.produto,
        tenantId: acesso.tenantId,
        papel: acesso.papel,
      },
    };
  }

  /**
   * Rotaciona o refresh e devolve a sessão nova, com o papel atual. Sem acesso
   * ativo (desativado depois do login) → 401.
   */
  async refresh(
    refreshToken: string,
    ctx: ContextoAcesso = {},
  ): Promise<SessaoEmitida> {
    // QA-100: limite por sessão ANTES de consumir — o 429 não gasta o refresh
    const daSessao = await this.sessoes.familiaDo(refreshToken);
    if (
      daSessao &&
      !(await this.tentativas.permitir(
        'refresh-sessao',
        daSessao,
        REFRESH_POR_SESSAO,
        MINUTO_MS,
      ))
    ) {
      throw new HttpException(
        'Muitas renovações de sessão. Aguarde alguns segundos e tente de novo.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const { claims, jtiNovo, familia } =
      await this.sessoes.consumir(refreshToken);
    const { usuario, acesso } = await this.exigirAcessoAtivo(claims);
    const sessao = await this.abrirSessao(usuario, acesso, {
      jti: jtiNovo,
      familia,
    });
    await this.audit.registrar({
      ...ctx,
      usuarioId: usuario.id,
      produto: acesso.produto,
      tenantId: acesso.tenantId,
      action: 'refresh',
      resource: RECURSO_ACESSO,
    });
    return sessao;
  }

  /** Logout pelo cookie: nunca falha; audita quando havia sessão vigente. */
  async logout(
    refreshToken: string | undefined,
    ctx: ContextoAcesso = {},
  ): Promise<void> {
    const p = await this.sessoes.encerrar(refreshToken);
    if (!p) return;
    await this.audit.registrar({
      ...ctx,
      usuarioId: p.sub,
      produto: p.produto,
      tenantId: p.tenantId,
      action: 'logout',
      resource: 'auth',
    });
  }

  /**
   * Esqueci a senha: token na pessoa (vale para todos os produtos), só para
   * quem tem algum acesso ativo. A resposta é sempre a mesma (202).
   */
  async forgotPassword(email: string): Promise<void> {
    const normalizado = normalizarEmail(email);
    // QA-003: até 3 e-mails por hora para o mesmo endereço (o limite por IP,
    // generoso, fica no controller). Acima disso, a mesma resposta, sem envio.
    const permitido = await this.tentativas.permitir(
      'forgot-email',
      normalizado,
      ENVIOS_POR_HORA,
      HORA_MS,
    );
    const usuario = await this.usuarios.findOne({
      where: { email: normalizado },
      select: { id: true, email: true },
    });
    if (
      !permitido ||
      !usuario ||
      !(await this.acessos.exists({
        where: { usuarioId: usuario.id, ativo: true },
      }))
    ) {
      return;
    }
    const { token, campos } = gerarTokenUsoUnico(RESET_TOKEN_TTL_MS);
    await this.usuarios.update({ id: usuario.id }, campos);
    // Falha de envio não muda a resposta (senão revelaria o e-mail).
    await this.mail
      .sendPasswordReset(usuario.email, token)
      .catch(() => undefined);
  }

  /**
   * Redefine a senha (esqueci a senha **e** aceite de convite). Consumo
   * atômico: o UPDATE só casa se o hash ainda for o vigente e não expirou.
   * Fecha os convites pendentes da pessoa e revoga todas as sessões dela.
   */
  async resetPassword(
    token: string,
    novaSenha: string,
    ctx: ContextoAcesso = {},
  ): Promise<void> {
    const hash = sha256(token);
    const invalido = new UnauthorizedException('Token inválido ou expirado.');
    const usuario = await this.usuarios.findOne({
      where: { passwordResetTokenHash: hash },
      select: { id: true },
    });
    if (!usuario) throw invalido;
    const r = await this.usuarios.update(
      {
        id: usuario.id,
        passwordResetTokenHash: hash,
        passwordResetExpiresAt: MoreThan(new Date()),
      },
      {
        passwordHash: await hashSenha(novaSenha),
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
      },
    );
    if (!r.affected) throw invalido;
    // Definir a senha aceita os convites de quem não tinha senha; os de aceite
    // (quem já tinha conta — QA-004) só pelo link deles.
    await this.acessos.update(
      { usuarioId: usuario.id, convitePendente: true, conviteHash: IsNull() },
      { convitePendente: false },
    );
    await this.sessoes.revogarDaPessoa(usuario.id);
    // QA-206: com IP e navegador, na trilha de cada clínica da pessoa.
    await this.audit.registrarDaPessoa(usuario.id, 'redefinir-senha', ctx);
  }

  /**
   * Troca da própria senha. Senha atual errada → 400 (um 401 faria o front
   * tentar renovar a sessão). Revoga as outras sessões e abre uma nova.
   */
  async trocarSenha(
    user: ITokenPayload,
    senhaAtual: string,
    novaSenha: string,
    ctx: ContextoAcesso = {},
  ): Promise<SessaoEmitida> {
    const atual = await this.usuarios.findOne({
      where: { id: user.sub },
      select: { id: true, passwordHash: true },
    });
    if (!atual || !(await conferirSenha(senhaAtual, atual.passwordHash))) {
      throw new BadRequestException('Senha atual incorreta.');
    }
    const { usuario, acesso } = await this.exigirAcessoAtivo(user);
    await this.usuarios.update(
      { id: usuario.id },
      { passwordHash: await hashSenha(novaSenha) },
    );
    await this.sessoes.revogarDaPessoa(usuario.id);
    return this.iniciarSessao(usuario, acesso, 'trocar-senha', ctx);
  }

  /**
   * Confirma o e-mail pelo token do link (consumo atômico). `false` = token
   * inválido, já usado ou expirado.
   */
  async confirmarEmail(token: string): Promise<boolean> {
    const hash = sha256(token);
    const usuario = await this.usuarios.findOne({
      where: { emailConfirmacaoHash: hash },
      select: { id: true, emailConfirmacaoExpiraEm: true },
    });
    if (!usuario) return false;
    const expira = usuario.emailConfirmacaoExpiraEm;
    if (expira && expira.getTime() <= Date.now()) return false;
    const r = await this.usuarios.update(
      { id: usuario.id, emailConfirmacaoHash: hash },
      { emailConfirmacaoHash: null, emailConfirmacaoExpiraEm: null },
    );
    if (!r.affected) return false;
    await this.audit.registrar({
      usuarioId: usuario.id,
      action: 'confirmar-email',
      resource: 'auth',
    });
    return true;
  }

  /**
   * Situação do link de um e-mail, para a página do front avisar ao abrir
   * (sem consumir o token). Definir/redefinir senha usam o token da pessoa; o
   * convite de quem já tem conta, o do acesso. Token de pessoa já usado é
   * apagado no uso, então aparece como `invalido`.
   */
  async verificarToken(
    tipo: TipoToken,
    token: string,
  ): Promise<VerificacaoToken> {
    const hash = sha256(token);
    if (tipo === 'aceitar-convite') {
      const s = await this.situacaoConvite(hash);
      return s.valido
        ? { valido: true, email: s.email, clinicaNome: s.clinicaNome }
        : s;
    }
    const u = await this.usuarios.findOne({
      where: { passwordResetTokenHash: hash },
      select: { id: true, email: true, passwordResetExpiresAt: true },
    });
    if (!u) return { valido: false, motivo: 'invalido' };
    if ((u.passwordResetExpiresAt?.getTime() ?? 0) <= Date.now()) {
      return { valido: false, motivo: 'expirado' };
    }
    return {
      valido: true,
      email: u.email,
      clinicaNome:
        tipo === 'definir-senha' ? await this.clinicaDoConvite(u.id) : null,
    };
  }

  /**
   * Aceite do convite de quem já tem conta (QA-004), pelo botão da página do
   * front (`POST`; um leitor de links não aceita sozinho). Consumo atômico. O
   * hash fica gravado depois do aceite para o link reaberto dizer "já aceito".
   */
  async aceitarConvite(
    token: string,
    ctx: ContextoAcesso = {},
  ): Promise<{ clinicaNome: string | null }> {
    const hash = sha256(token);
    const s = await this.situacaoConvite(hash);
    const jaAceito = new ConflictException({
      code: 'CONVITE_JA_ACEITO',
      message: 'Este convite já foi aceito. Entre com a sua conta.',
    });
    if (!s.valido) {
      if (s.motivo === 'usado') throw jaAceito;
      throw new BadRequestException({
        code: 'CONVITE_INVALIDO',
        message:
          s.motivo === 'expirado'
            ? 'O convite venceu. Peça um novo convite à clínica.'
            : 'O convite é inválido ou foi cancelado.',
      });
    }
    const r = await this.acessos.update(
      {
        id: s.acesso.id,
        conviteHash: hash,
        convitePendente: true,
        ativo: true,
        conviteExpiraEm: MoreThan(new Date()),
      },
      { convitePendente: false },
    );
    if (!r.affected) throw jaAceito; // outra requisição aceitou antes
    await this.audit.registrar({
      ...ctx,
      usuarioId: s.acesso.usuarioId,
      produto: s.acesso.produto,
      tenantId: s.acesso.tenantId,
      action: 'aceitar-convite',
      resource: 'acesso',
    });
    return { clinicaNome: s.clinicaNome };
  }

  private async situacaoConvite(hash: string): Promise<
    | { valido: false; motivo: MotivoTokenInvalido }
    | {
        valido: true;
        acesso: Acesso;
        email: string;
        clinicaNome: string | null;
      }
  > {
    const acesso = await this.acessos.findOne({ where: { conviteHash: hash } });
    if (!acesso) return { valido: false, motivo: 'invalido' };
    if (!acesso.convitePendente) return { valido: false, motivo: 'usado' };
    if (!acesso.ativo) return { valido: false, motivo: 'invalido' };
    if ((acesso.conviteExpiraEm?.getTime() ?? 0) <= Date.now()) {
      return { valido: false, motivo: 'expirado' };
    }
    const [usuario, assinatura] = await Promise.all([
      this.usuarios.findOneOrFail({
        where: { id: acesso.usuarioId },
        select: { id: true, email: true },
      }),
      this.assinaturas.findOne({
        where: { produto: acesso.produto, tenantId: acesso.tenantId },
        select: { id: true, tenantNome: true },
      }),
    ]);
    return {
      valido: true,
      acesso,
      email: usuario.email,
      clinicaNome: assinatura?.tenantNome ?? null,
    };
  }

  /** Nome da clínica do convite pendente mais recente de quem define a senha. */
  private async clinicaDoConvite(usuarioId: string): Promise<string | null> {
    const linhas: { nome: string | null }[] = await this.acessos.query(
      `SELECT s.tenant_nome AS nome
         FROM crommos.acessos a
         LEFT JOIN crommos.assinaturas s
           ON s.tenant_id = a.tenant_id AND s.produto = a.produto
          AND s.deleted_at IS NULL
        WHERE a.usuario_id = $1 AND a.ativo AND a.convite_pendente
          AND a.convite_hash IS NULL
        ORDER BY a.created_at DESC
        LIMIT 1`,
      [usuarioId],
    );
    return linhas[0]?.nome ?? null;
  }

  /** Novo link de confirmação (o anterior deixa de valer). 409 se já confirmado. */
  async reenviarConfirmacao(usuarioId: string): Promise<void> {
    const usuario = await this.usuarios.findOne({ where: { id: usuarioId } });
    if (!usuario?.emailConfirmacaoHash) {
      throw new ConflictException('O e-mail já está confirmado.');
    }
    // QA-003: por pessoa (o limite por IP, generoso, fica no controller).
    const permitido = await this.tentativas.permitir(
      'reenviar-confirmacao',
      usuario.id,
      ENVIOS_POR_HORA,
      HORA_MS,
    );
    if (!permitido) {
      throw new HttpException(
        'Muitos envios. Aguarde alguns minutos e tente de novo.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const { token, campos } = gerarConfirmacaoEmail();
    await this.usuarios.update({ id: usuario.id }, campos);
    await this.mail.sendConfirmacaoEmail(usuario.email, token);
  }

  /** Pessoa e acesso ativo das claims do token; 401 se algum faltar. */
  private async exigirAcessoAtivo(
    p: ITokenPayload,
  ): Promise<{ usuario: Usuario; acesso: Acesso }> {
    const [usuario, acesso] = await Promise.all([
      this.usuarios.findOne({ where: { id: p.sub } }),
      this.acessos.findOne({
        where: {
          usuarioId: p.sub,
          produto: p.produto,
          tenantId: p.tenantId,
          ativo: true,
        },
      }),
    ]);
    if (!usuario || !acesso) {
      throw new UnauthorizedException('Acesso inativo.');
    }
    return { usuario, acesso };
  }

  /** UUID direto; senão, código curto do tenant no produto. `null` = não existe. */
  private async resolverTenant(
    produto: Produto,
    entrada: string,
  ): Promise<string | null> {
    if (UUID_RE.test(entrada)) return entrada.toLowerCase();
    const a = await this.assinaturas.findOne({
      where: { produto, tenantCodigo: entrada.trim().toUpperCase() },
      select: { id: true, tenantId: true },
    });
    return a?.tenantId ?? null;
  }

  /** Acessos ativos da pessoa no produto, com nome/código do tenant. */
  private acessosAtivos(
    usuarioId: string,
    produto: Produto,
    tenantId?: string,
  ): Promise<LinhaAcesso[]> {
    return this.acessos.query(
      `SELECT a.tenant_id, a.papel, a.clinico, s.tenant_codigo AS codigo,
              s.tenant_nome AS nome, coalesce(s.exigir_2fa, false) AS exigir_2fa
         FROM crommos.acessos a
         LEFT JOIN crommos.assinaturas s
           ON s.tenant_id = a.tenant_id AND s.produto = a.produto
          AND s.deleted_at IS NULL
        WHERE a.usuario_id = $1 AND a.produto = $2 AND a.ativo
          AND NOT a.convite_pendente
          AND ($3::uuid IS NULL OR a.tenant_id = $3::uuid)`,
      [usuarioId, produto, tenantId ?? null],
    );
  }
}
