import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { MoreThan, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { Assinatura } from '../billing/assinatura.entity';
import { sha256 } from '../common/crypto/segredo';
import { ITokenPayload } from '../common/interfaces/token-payload.interface';
import { configProduto, Produto } from '../common/produtos';
import { MailService } from '../mail/mail.service';
import { Acesso } from './acesso.entity';
import { LoginDto } from './dtos/login.dto';
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

export type ResultadoLogin = SessaoEmitida | EscolherClinica;

interface LinhaAcesso {
  tenant_id: string;
  papel: string;
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
  ) {}

  /**
   * Com `tenantId` (UUID ou código de 5), entra naquele tenant; sem ele, um
   * acesso ativo no produto entra direto e mais de um devolve a lista. A
   * resposta de erro é sempre o mesmo 401 (e o bcrypt roda sempre), para não
   * revelar se o e-mail, o tenant ou o acesso existem.
   */
  async login(dto: LoginDto, ip = ''): Promise<ResultadoLogin> {
    exigirProdutoDisponivel(dto.produto);
    const email = normalizarEmail(dto.email);
    // QA-003: só as falhas contam (por IP + e-mail e por IP); 429 antes do bcrypt.
    await this.tentativas.exigirLoginLiberado(ip, email);
    const r = await this.autenticar(dto, email).catch(async (e: unknown) => {
      if (e instanceof UnauthorizedException) {
        await this.tentativas.registrarFalhaLogin(ip, email);
      }
      throw e;
    });
    await this.tentativas.limparFalhasLogin(ip, email);
    return r;
  }

  private async autenticar(
    dto: LoginDto,
    email: string,
  ): Promise<ResultadoLogin> {
    const usuario = await this.usuarios.findOne({
      where: { email },
      select: { id: true, email: true, nome: true, passwordHash: true },
    });
    const invalido = new UnauthorizedException('Credenciais inválidas.');
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
    return this.iniciarSessao(
      usuario,
      { produto: dto.produto, tenantId: l.tenant_id, papel: l.papel },
      'login',
    );
  }

  /** Emite a sessão de um acesso já autenticado e audita (login, signup, troca). */
  async iniciarSessao(
    usuario: Pick<Usuario, 'id' | 'nome' | 'email'>,
    acesso: AcessoView,
    action: string,
  ): Promise<SessaoEmitida> {
    const sessao = await this.abrirSessao(usuario, acesso);
    await this.audit.registrar({
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
    jti?: string,
  ): Promise<SessaoEmitida> {
    const tokens = await this.sessoes.emitir(
      {
        usuarioId: usuario.id,
        produto: acesso.produto,
        tenantId: acesso.tenantId,
      },
      jti,
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
  async refresh(refreshToken: string): Promise<SessaoEmitida> {
    const { claims, jtiNovo } = await this.sessoes.consumir(refreshToken);
    const { usuario, acesso } = await this.exigirAcessoAtivo(claims);
    return this.abrirSessao(usuario, acesso, jtiNovo);
  }

  /** Logout pelo cookie: nunca falha; audita quando havia sessão vigente. */
  async logout(refreshToken: string | undefined): Promise<void> {
    const p = await this.sessoes.encerrar(refreshToken);
    if (!p) return;
    await this.audit.registrar({
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
  async resetPassword(token: string, novaSenha: string): Promise<void> {
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
    await this.acessos.update(
      { usuarioId: usuario.id, convitePendente: true },
      { convitePendente: false },
    );
    await this.sessoes.revogarDaPessoa(usuario.id);
    await this.audit.registrar({
      usuarioId: usuario.id,
      action: 'redefinir-senha',
      resource: 'auth',
    });
  }

  /**
   * Troca da própria senha. Senha atual errada → 400 (um 401 faria o front
   * tentar renovar a sessão). Revoga as outras sessões e abre uma nova.
   */
  async trocarSenha(
    user: ITokenPayload,
    senhaAtual: string,
    novaSenha: string,
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
    return this.iniciarSessao(usuario, acesso, 'trocar-senha');
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
      `SELECT a.tenant_id, a.papel, s.tenant_codigo AS codigo, s.tenant_nome AS nome
         FROM crommos.acessos a
         LEFT JOIN crommos.assinaturas s
           ON s.tenant_id = a.tenant_id AND s.produto = a.produto
          AND s.deleted_at IS NULL
        WHERE a.usuario_id = $1 AND a.produto = $2 AND a.ativo
          AND ($3::uuid IS NULL OR a.tenant_id = $3::uuid)`,
      [usuarioId, produto, tenantId ?? null],
    );
  }
}
