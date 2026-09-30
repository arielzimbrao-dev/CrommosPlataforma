import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, IsNull, Not, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { Acesso } from '../auth/acesso.entity';
import { SessoesService } from '../auth/sessoes.service';
import {
  CONVITE_TTL_MS,
  gerarTokenUsoUnico,
  normalizarEmail,
  senhaDescartavel,
} from '../auth/tokens';
import { Usuario } from '../auth/usuario.entity';
import { Assinatura } from '../billing/assinatura.entity';
import { AssinaturaService } from '../billing/assinatura.service';
import type { Produto } from '../common/produtos';
import { MailService } from '../mail/mail.service';
import {
  AtualizarAcessoDto,
  CriarAcessoDto,
  ReenviarConviteDto,
  RemoverAcessoDto,
} from './dtos/acessos.dtos';

export interface AcessoCriado {
  usuarioId: string;
  /** A pessoa foi criada agora. */
  novo: boolean;
  /** A pessoa ainda não definiu a senha (vale "reenviar convite"). */
  convitePendente: boolean;
  /** O e-mail de convite saiu. `false` com `convitePendente` = reenviar. */
  emailEnviado: boolean;
}

export interface AcessoInternoView {
  usuarioId: string;
  produto: Produto;
  tenantId: string;
  papel: string;
  ativo: boolean;
  convitePendente: boolean;
  clinico: boolean;
}

export interface PessoaInternaView {
  id: string;
  nome: string;
  email: string;
  emailConfirmado: boolean;
}

/** Token do link de aceite: o valor vai no e-mail; o banco guarda o hash. */
function tokenDeAceite(): {
  token: string;
  campos: { conviteHash: string; conviteExpiraEm: Date };
} {
  const { token, campos } = gerarTokenUsoUnico(CONVITE_TTL_MS);
  return {
    token,
    campos: {
      conviteHash: campos.passwordResetTokenHash,
      conviteExpiraEm: campos.passwordResetExpiresAt,
    },
  };
}

const paraView = (a: Acesso): AcessoInternoView => ({
  usuarioId: a.usuarioId,
  produto: a.produto,
  tenantId: a.tenantId,
  papel: a.papel,
  ativo: a.ativo,
  convitePendente: a.convitePendente,
  clinico: a.clinico,
});

/**
 * Acessos mantidos pelos produtos (API interna): o produto cria/atualiza o
 * vínculo local e avisa a plataforma, que guarda o acesso, aplica o limite de
 * usuários da assinatura e manda o convite.
 *
 * Convite: o acesso nasce `convitePendente` e fica fora do login até a pessoa
 * agir. Sem senha (e-mail novo, ou só convites pendentes): link de uso único
 * (7 dias, token da pessoa) para definir a senha em `POST
 * /auth/reset-password`. Já tem senha: link de aceite (7 dias,
 * token do acesso) em `GET /auth/aceitar-convite`. A resposta é a mesma nos
 * dois casos (não revela se a conta existia).
 */
@Injectable()
export class AcessosService {
  private readonly logger = new Logger(AcessosService.name);

  constructor(
    @Inject('DATA_SOURCE') private readonly ds: DataSource,
    @Inject('USUARIO_REPOSITORY')
    private readonly usuarios: Repository<Usuario>,
    @Inject('ACESSO_REPOSITORY')
    private readonly acessos: Repository<Acesso>,
    private readonly sessoes: SessoesService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly assinatura: AssinaturaService,
  ) {}

  async criar(produto: Produto, dto: CriarAcessoDto): Promise<AcessoCriado> {
    const email = normalizarEmail(dto.email);
    const existente = await this.usuarios.findOne({ where: { email } });
    if (
      existente &&
      (await this.acessos.exists({
        where: { usuarioId: existente.id, produto, tenantId: dto.tenantId },
      }))
    ) {
      throw new ConflictException('Esta pessoa já tem acesso a esta clínica.');
    }
    const temSenha = existente
      ? await this.acessos.exists({
          where: { usuarioId: existente.id, convitePendente: false },
        })
      : false;
    const convite = temSenha ? null : gerarTokenUsoUnico(CONVITE_TTL_MS);
    const aceite = temSenha ? tokenDeAceite() : null;
    const senha = existente ? null : await senhaDescartavel();

    // Assento por módulo: sem limite de pessoas; a diferença vai para o
    // pró-rata da assinatura.
    const usuario = await this.assinatura.comReprecificacao(
      produto,
      dto.tenantId,
      async (em) => {
        const u =
          existente ??
          (await em.save(Usuario, {
            email,
            nome: dto.nome,
            passwordHash: senha as string,
          }));
        if (convite) await em.update(Usuario, { id: u.id }, convite.campos);
        await em.insert(Acesso, {
          usuarioId: u.id,
          produto,
          tenantId: dto.tenantId,
          papel: dto.papel,
          clinico: dto.clinico ?? false,
          ativo: true,
          convitePendente: true,
          ...(aceite?.campos ?? {}),
        });
        return u;
      },
    );
    await this.auditar(produto, dto.tenantId, 'convidar', usuario.id);
    // O acesso já está gravado; se o e-mail falhar, o produto grava o
    // vínculo mesmo assim e oferece "reenviar convite" (201, não 5xx).
    const envio = aceite
      ? this.enviarAceite(usuario, aceite.token, produto, dto.tenantId)
      : this.mail.sendConvite(
          email,
          usuario.nome,
          (convite as { token: string }).token,
          produto,
        );
    const emailEnviado = await envio.then(
      () => true,
      () => {
        this.logger.warn('[acessos] convite gravado, e-mail não saiu.');
        return false;
      },
    );
    return {
      usuarioId: usuario.id,
      novo: !existente,
      convitePendente: true,
      emailEnviado,
    };
  }

  /** E-mail de aceite (quem já tem conta), com o nome da clínica se houver. */
  private async enviarAceite(
    usuario: Usuario,
    token: string,
    produto: Produto,
    tenantId: string,
  ): Promise<void> {
    const a = await this.ds.getRepository(Assinatura).findOne({
      where: { produto, tenantId },
      select: { id: true, tenantNome: true },
    });
    await this.mail.sendConviteAceite(
      usuario.email,
      usuario.nome,
      token,
      produto,
      a?.tenantNome ?? null,
    );
  }

  /**
   * Compensação do produto: o vínculo local não pôde ser gravado depois do
   * `criar`. Remove o acesso (desfaz a cobrança do assento); a pessoa fica
   * (inofensiva).
   */
  async remover(produto: Produto, dto: RemoverAcessoDto): Promise<void> {
    const acesso = await this.exigir(produto, dto.tenantId, dto.usuarioId);
    await this.assinatura.comReprecificacao(produto, dto.tenantId, (em) =>
      em.delete(Acesso, { id: acesso.id }),
    );
    await this.sessoes.revogarDaPessoa(dto.usuarioId, {
      produto,
      tenantId: dto.tenantId,
    });
    await this.auditar(produto, dto.tenantId, 'remover', dto.usuarioId);
  }

  async atualizar(
    produto: Produto,
    dto: AtualizarAcessoDto,
  ): Promise<AcessoInternoView> {
    const acesso = await this.exigir(produto, dto.tenantId, dto.usuarioId);
    const desativando = dto.ativo === false && acesso.ativo;
    const reativando = dto.ativo === true && !acesso.ativo;
    // Quem excluiu a conta não volta (nem ocupa assento).
    if (
      reativando &&
      (await this.usuarios.exists({
        where: { id: dto.usuarioId, deletedAt: Not(IsNull()) },
        withDeleted: true,
      }))
    ) {
      throw new ConflictException(
        'Esta pessoa excluiu a conta e não pode ser reativada.',
      );
    }
    // Papel, ativo e vínculo clínico mudam os assentos: pró-rata.
    const salvo = await this.assinatura.comReprecificacao(
      produto,
      dto.tenantId,
      (em) =>
        em.save(Acesso, {
          ...acesso,
          papel: dto.papel ?? acesso.papel,
          ativo: dto.ativo ?? acesso.ativo,
          clinico: dto.clinico ?? acesso.clinico,
        }),
    );
    if (desativando) {
      await this.sessoes.revogarDaPessoa(dto.usuarioId, {
        produto,
        tenantId: dto.tenantId,
      });
    }
    await this.auditar(
      produto,
      dto.tenantId,
      desativando ? 'desativar' : reativando ? 'reativar' : 'atualizar',
      dto.usuarioId,
    );
    return paraView(salvo);
  }

  async reenviarConvite(
    produto: Produto,
    dto: ReenviarConviteDto,
  ): Promise<void> {
    const acesso = await this.exigir(produto, dto.tenantId, dto.usuarioId);
    if (!acesso.convitePendente) {
      throw new ConflictException('Esta pessoa já aceitou o convite.');
    }
    const usuario = await this.usuarios.findOneOrFail({
      where: { id: dto.usuarioId },
    });
    if (acesso.conviteHash !== null) {
      // Link de aceite novo (o anterior deixa de valer).
      const { token, campos } = tokenDeAceite();
      await this.acessos.update({ id: acesso.id }, campos);
      await this.enviarAceite(usuario, token, produto, dto.tenantId);
      await this.auditar(produto, dto.tenantId, 'reenviar-convite', usuario.id);
      return;
    }
    // O token é da pessoa: o link anterior deixa de valer.
    const { token, campos } = gerarTokenUsoUnico(CONVITE_TTL_MS);
    await this.usuarios.update({ id: usuario.id }, campos);
    await this.mail.sendConvite(usuario.email, usuario.nome, token, produto);
    await this.auditar(produto, dto.tenantId, 'reenviar-convite', usuario.id);
  }

  /** Dados da pessoa, só para quem tem acesso a algum tenant do produto. */
  async pessoa(
    produto: Produto,
    usuarioId: string,
  ): Promise<PessoaInternaView> {
    const [usuario, temAcesso] = await Promise.all([
      this.usuarios.findOne({ where: { id: usuarioId } }),
      this.acessos.exists({ where: { usuarioId, produto } }),
    ]);
    if (!usuario || !temAcesso) {
      throw new NotFoundException('Pessoa não encontrada.');
    }
    return {
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      emailConfirmado: !usuario.emailConfirmacaoHash,
    };
  }

  private async exigir(
    produto: Produto,
    tenantId: string,
    usuarioId: string,
  ): Promise<Acesso> {
    const acesso = await this.acessos.findOne({
      where: { produto, tenantId, usuarioId },
    });
    if (!acesso) throw new NotFoundException('Acesso não encontrado.');
    return acesso;
  }

  private auditar(
    produto: Produto,
    tenantId: string,
    action: string,
    usuarioId: string,
  ): Promise<void> {
    // Ator = o produto (serviço); a pessoa afetada vai em resource_id.
    return this.audit.registrar({
      produto,
      tenantId,
      action,
      resource: 'acesso',
      resourceId: usuarioId,
    });
  }
}
