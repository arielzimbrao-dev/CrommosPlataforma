import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
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
import { contarAcessosAtivos } from '../billing/assinatura.service';
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
}

export interface PessoaInternaView {
  id: string;
  nome: string;
  email: string;
  emailConfirmado: boolean;
}

const paraView = (a: Acesso): AcessoInternoView => ({
  usuarioId: a.usuarioId,
  produto: a.produto,
  tenantId: a.tenantId,
  papel: a.papel,
  ativo: a.ativo,
  convitePendente: a.convitePendente,
});

/**
 * Acessos mantidos pelos produtos (API interna): o produto cria/atualiza o
 * vínculo local e avisa a plataforma, que guarda o acesso, aplica o limite de
 * usuários da assinatura e manda o convite.
 *
 * Convite: pessoa sem senha (e-mail novo, ou só convites pendentes) ganha o
 * acesso `convitePendente` e o link de uso único (7 dias) para definir a
 * senha em `POST /auth/reset-password`. Quem já tem senha só ganha o acesso,
 * sem e-mail (o e-mail "você ganhou acesso a outra clínica" é _a definir_).
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
    const senha = existente ? null : await senhaDescartavel();

    const usuario = await this.dentroDoLimite(
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
          ativo: true,
          convitePendente: !temSenha,
        });
        return u;
      },
    );
    await this.auditar(produto, dto.tenantId, 'convidar', usuario.id);
    // B2: o acesso já está gravado; se o e-mail falhar, o produto grava o
    // vínculo mesmo assim e oferece "reenviar convite" (201, não 5xx).
    const emailEnviado = convite
      ? await this.mail
          .sendConvite(email, usuario.nome, convite.token, produto)
          .then(
            () => true,
            () => {
              this.logger.warn('[acessos] convite gravado, e-mail não saiu.');
              return false;
            },
          )
      : false;
    return {
      usuarioId: usuario.id,
      novo: !existente,
      convitePendente: !temSenha,
      emailEnviado,
    };
  }

  /**
   * Compensação do produto: o vínculo local não pôde ser gravado depois do
   * `criar`. Remove o acesso (libera a vaga); a pessoa fica (inofensiva).
   */
  async remover(produto: Produto, dto: RemoverAcessoDto): Promise<void> {
    const acesso = await this.exigir(produto, dto.tenantId, dto.usuarioId);
    await this.acessos.delete({ id: acesso.id });
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
    const gravar = (em: EntityManager) =>
      em.save(Acesso, {
        ...acesso,
        papel: dto.papel ?? acesso.papel,
        ativo: dto.ativo ?? acesso.ativo,
      });
    const salvo = reativando
      ? await this.dentroDoLimite(produto, dto.tenantId, gravar)
      : await gravar(this.ds.manager);
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
      throw new ConflictException('Esta pessoa já definiu a senha.');
    }
    const usuario = await this.usuarios.findOneOrFail({
      where: { id: dto.usuarioId },
    });
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

  /**
   * Limite de usuários da assinatura: trava a linha da assinatura
   * (`FOR UPDATE`, a mesma do `PATCH /assinatura`), confere a vaga e grava na
   * mesma transação — convites simultâneos esperam um pelo outro. Acessos
   * ativos (convites pendentes inclusos) ocupam vaga. Sem assinatura (tenant
   * legado) não há limite.
   */
  private dentroDoLimite<R>(
    produto: Produto,
    tenantId: string,
    gravar: (em: EntityManager) => Promise<R>,
  ): Promise<R> {
    return this.ds.transaction(async (em) => {
      const assinatura = await em.getRepository(Assinatura).findOne({
        where: { produto, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (assinatura) {
        const ativos = await contarAcessosAtivos(em, produto, tenantId);
        if (ativos >= assinatura.numeroUsuarios) {
          throw new ConflictException(
            `Limite de ${assinatura.numeroUsuarios} usuário(s) da assinatura atingido. Aumente o nº de usuários na assinatura para adicionar mais.`,
          );
        }
      }
      return gravar(em);
    });
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
