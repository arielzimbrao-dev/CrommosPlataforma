import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { Acesso } from '../auth/acesso.entity';
import {
  AuthService,
  exigirProdutoDisponivel,
  SessaoEmitida,
} from '../auth/auth.service';
import { PAPEL_ADMIN } from '../auth/decorators/exige-acesso.decorator';
import {
  gerarConfirmacaoEmail,
  hashSenha,
  normalizarEmail,
} from '../auth/tokens';
import { Usuario } from '../auth/usuario.entity';
import { Assinatura } from '../billing/assinatura.entity';
import { AssinaturaService } from '../billing/assinatura.service';
import { Cliente } from '../billing/cliente.entity';
import { onlyDigits } from '../common/cpf';
import { configProduto, ConfigProduto } from '../common/produtos';
import { MailService } from '../mail/mail.service';
import { gerarCodigoTenant } from './codigo';
import { NovaClinicaDto, SignupDto } from './dtos/signup.dto';
import { ProvisionamentoClient } from './provisionamento.client';

/**
 * Versão dos termos aceita no signup, definida **no servidor**: o cliente não
 * escolhe o que aceitou. Atualize junto com os textos jurídicos.
 */
export const TERMOS_VERSAO = 'rascunho-2026-09';

interface Criados {
  codigo: string;
  tenantId: string;
  clienteId: string;
  /** O signup criou o cliente/pessoa (a compensação só apaga o que criou). */
  clienteNovo: boolean;
  usuarioNovo: boolean;
  usuario: Usuario;
  assinaturaId: string;
  acessoId: string;
}

/**
 * Signup público (docs/contrato.md): numa transação cria cliente (CPF do dono
 * ou CNPJ da matriz), pessoa, assinatura em trial (tenant novo, com código de
 * 5) e o acesso admin; depois pede ao produto o tenant (clínica, 1ª unidade,
 * vínculo admin). Se o produto falhar, desfaz tudo e responde 502. E-mail ou
 * documento já cadastrados → 409 (índices únicos, AllExceptionsFilter).
 */
@Injectable()
export class SignupService {
  private readonly logger = new Logger(SignupService.name);

  constructor(
    @Inject('DATA_SOURCE') private readonly ds: DataSource,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly provisionamento: ProvisionamentoClient,
  ) {}

  async criarConta(
    dto: SignupDto,
  ): Promise<SessaoEmitida & { codigo: string }> {
    exigirProdutoDisponivel(dto.produto);
    const cfg = configProduto(dto.produto) as ConfigProduto;
    const email = normalizarEmail(dto.email);
    const passwordHash = await hashSenha(dto.senha);
    // O admin entra já; confirmar o e-mail libera o convite da equipe.
    const confirmacao = gerarConfirmacaoEmail();
    const tenantId = randomUUID();

    const c = await this.ds.transaction(async (em): Promise<Criados> => {
      const codigo = await gerarCodigoTenant(em);
      const cliente = await em.save(Cliente, {
        tipo: dto.tipoCliente,
        documento: onlyDigits(dto.documento),
        nome: dto.nomeClinica,
        emailCobranca: email,
      });
      const usuario = await em.save(Usuario, {
        email,
        nome: dto.nome,
        passwordHash,
        termosVersao: TERMOS_VERSAO,
        termosAceitosEm: new Date(),
        ...confirmacao.campos,
      });
      const assinatura = await AssinaturaService.iniciarTrial(em, {
        tenantId,
        produto: dto.produto,
        clienteId: cliente.id,
        tenantNome: dto.nomeClinica,
        tenantCodigo: codigo,
      });
      const acesso = await em.save(Acesso, {
        usuarioId: usuario.id,
        produto: dto.produto,
        tenantId,
        papel: PAPEL_ADMIN,
        ativo: true,
        convitePendente: false,
      });
      return {
        codigo,
        tenantId,
        clienteId: cliente.id,
        clienteNovo: true,
        usuarioNovo: true,
        usuario,
        assinaturaId: assinatura.id,
        acessoId: acesso.id,
      };
    });

    await this.provisionarOuDesfazer(cfg, c, dto);

    await this.audit.registrar({
      usuarioId: c.usuario.id,
      produto: dto.produto,
      tenantId,
      action: 'signup',
      resource: 'assinatura',
      resourceId: c.assinaturaId,
    });
    // Falha no envio não desfaz a conta: dá para pedir outro link depois.
    await this.mail
      .sendConfirmacaoEmail(email, confirmacao.token)
      .catch(() =>
        this.logger.warn('[signup] e-mail de confirmação não enviado.'),
      );
    const sessao = await this.auth.iniciarSessao(
      c.usuario,
      { produto: dto.produto, tenantId, papel: PAPEL_ADMIN },
      'login',
    );
    return { ...sessao, codigo: c.codigo };
  }

  /**
   * R2 — pessoa já logada cria **outra clínica** (tenant novo, trial próprio)
   * na mesma conta. O cliente pagador é o do CPF/CNPJ informado: se já
   * existe, só vale para quem é admin de uma clínica dele (senão 409); um
   * cliente pode ter várias clínicas do mesmo produto. Exige e-mail
   * confirmado. Devolve a sessão já na clínica nova.
   */
  async criarClinica(
    usuarioId: string,
    dto: NovaClinicaDto,
  ): Promise<SessaoEmitida & { codigo: string }> {
    exigirProdutoDisponivel(dto.produto);
    const cfg = configProduto(dto.produto) as ConfigProduto;
    const usuario = await this.ds
      .getRepository(Usuario)
      .findOne({ where: { id: usuarioId } });
    if (!usuario) throw new UnauthorizedException();
    if (usuario.emailConfirmacaoHash) {
      throw new ForbiddenException(
        'Confirme o seu e-mail (link enviado no cadastro) para criar outra clínica.',
      );
    }
    const documento = onlyDigits(dto.documento);
    const tenantId = randomUUID();

    const c = await this.ds.transaction(async (em): Promise<Criados> => {
      const codigo = await gerarCodigoTenant(em);
      let cliente = await em.findOne(Cliente, { where: { documento } });
      const clienteNovo = !cliente;
      if (cliente) {
        const [dono] = (await em.query(
          `SELECT 1 FROM crommos.assinaturas a
             JOIN crommos.acessos x
               ON x.tenant_id = a.tenant_id AND x.produto = a.produto
            WHERE a.cliente_id = $1 AND a.deleted_at IS NULL
              AND x.usuario_id = $2 AND x.papel = $3 AND x.ativo
            LIMIT 1`,
          [cliente.id, usuarioId, PAPEL_ADMIN],
        )) as unknown[];
        if (!dono) {
          throw new ConflictException(
            'Este CPF/CNPJ já está cadastrado em outra conta.',
          );
        }
      } else {
        cliente = await em.save(Cliente, {
          tipo: dto.tipoCliente,
          documento,
          nome: dto.nomeClinica,
          emailCobranca: usuario.email,
        });
      }
      const assinatura = await AssinaturaService.iniciarTrial(em, {
        tenantId,
        produto: dto.produto,
        clienteId: cliente.id,
        tenantNome: dto.nomeClinica,
        tenantCodigo: codigo,
      });
      const acesso = await em.save(Acesso, {
        usuarioId,
        produto: dto.produto,
        tenantId,
        papel: PAPEL_ADMIN,
        ativo: true,
        convitePendente: false,
      });
      return {
        codigo,
        tenantId,
        clienteId: cliente.id,
        clienteNovo,
        usuarioNovo: false,
        usuario,
        assinaturaId: assinatura.id,
        acessoId: acesso.id,
      };
    });

    await this.provisionarOuDesfazer(cfg, c, {
      nomeClinica: dto.nomeClinica,
      cnpj: dto.cnpj,
      nomeUnidade: dto.nomeUnidade,
      nome: usuario.nome,
    });
    await this.audit.registrar({
      usuarioId,
      produto: dto.produto,
      tenantId,
      action: 'nova-clinica',
      resource: 'assinatura',
      resourceId: c.assinaturaId,
    });
    const sessao = await this.auth.iniciarSessao(
      usuario,
      { produto: dto.produto, tenantId, papel: PAPEL_ADMIN },
      'login',
    );
    return { ...sessao, codigo: c.codigo };
  }

  /** Pede o tenant ao produto; se falhar, desfaz o que foi criado e 502. */
  private async provisionarOuDesfazer(
    cfg: ConfigProduto,
    c: Criados,
    d: Pick<SignupDto, 'nomeClinica' | 'cnpj' | 'nomeUnidade' | 'nome'>,
  ): Promise<void> {
    try {
      await this.provisionamento.criarTenant(cfg, {
        tenantId: c.tenantId,
        codigo: c.codigo,
        nomeClinica: d.nomeClinica,
        ...(d.cnpj ? { cnpj: d.cnpj } : {}),
        nomeUnidade: d.nomeUnidade,
        admin: {
          usuarioId: c.usuario.id,
          nome: d.nome,
          email: c.usuario.email,
        },
      });
    } catch (e) {
      this.logger.warn(
        `[signup] provisionamento falhou; desfazendo: ${e instanceof Error ? e.message : String(e)}`,
      );
      await this.desfazer(c);
      throw new BadGatewayException(
        'Não foi possível criar a clínica agora. Tente novamente em instantes.',
      );
    }
  }

  /** Compensação: apaga o que o signup criou (filho → pai). */
  private desfazer(c: Criados): Promise<void> {
    return this.ds.transaction(async (em) => {
      await em.delete(Acesso, { id: c.acessoId });
      await em.delete(Assinatura, { id: c.assinaturaId });
      if (c.usuarioNovo) await em.delete(Usuario, { id: c.usuario.id });
      if (c.clienteNovo) await em.delete(Cliente, { id: c.clienteId });
    });
  }
}
