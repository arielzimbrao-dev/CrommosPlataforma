import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { PAPEL_ADMIN } from '../auth/decorators/exige-acesso.decorator';
import { SessoesService } from '../auth/sessoes.service';
import { conferirSenha, senhaDescartavel } from '../auth/tokens';
import { Usuario } from '../auth/usuario.entity';
import { comLockGlobal } from '../common/lock-global';
import { configProduto, type Produto } from '../common/produtos';
import { ProvisionamentoClient } from '../signup/provisionamento.client';

/** Exclusões re-tentadas por execução do job; o resto fica para a próxima. */
const LOTE_EXCLUSOES = 100;

/** Dados da pessoa guardados pela plataforma (LGPD art. 18, II e V). */
export interface ExportacaoConta {
  geradoEm: string;
  pessoa: {
    id: string;
    nome: string;
    email: string;
    emailConfirmado: boolean;
    termosVersao: string | null;
    termosAceitosEm: Date | null;
    criadaEm: Date;
  };
  acessos: {
    produto: string;
    tenantId: string;
    clinica: string | null;
    papel: string;
    ativo: boolean;
    convitePendente: boolean;
    desde: Date;
  }[];
  sessoes: {
    produto: string;
    tenantId: string;
    criadaEm: Date;
    expiraEm: Date;
    revogadaEm: Date | null;
  }[];
  auditoria: {
    produto: string | null;
    tenantId: string | null;
    action: string;
    resource: string;
    /** Registros de acesso: IP e navegador. */
    ip: string | null;
    navegador: string | null;
    em: Date;
  }[];
}

/**
 * LGPD da **pessoa** na plataforma (login único): exportar os próprios dados
 * e excluir a conta. Excluir = anonimizar (nome/e-mail trocados, senha e
 * tokens inutilizados, soft-delete), desativar todos os acessos e revogar as
 * sessões — a linha fica porque os produtos a referenciam (autoria de
 * registros clínicos, guarda legal). Não exclui quem é o **último admin**
 * ativo de uma clínica com assinatura vigente (409: passe a administração
 * antes). Os dados da pessoa dentro de cada clínica (vínculo, autoria) são da
 * clínica, que é a controladora.
 */
@Injectable()
export class ContaService {
  private readonly logger = new Logger(ContaService.name);

  constructor(
    @Inject('DATA_SOURCE') private readonly ds: DataSource,
    private readonly sessoes: SessoesService,
    private readonly audit: AuditService,
    private readonly produtos: ProvisionamentoClient,
  ) {}

  async exportar(usuarioId: string): Promise<ExportacaoConta> {
    const u = await this.ds
      .getRepository(Usuario)
      .findOne({ where: { id: usuarioId } });
    if (!u) throw new UnauthorizedException();
    const [acessos, sessoes, auditoria] = await Promise.all([
      this.ds.query<ExportacaoConta['acessos']>(
        `SELECT a.produto, a.tenant_id AS "tenantId", s.tenant_nome AS clinica,
                a.papel, a.ativo, a.convite_pendente AS "convitePendente",
                a.created_at AS desde
           FROM crommos.acessos a
           LEFT JOIN crommos.assinaturas s
             ON s.tenant_id = a.tenant_id AND s.produto = a.produto
            AND s.deleted_at IS NULL
          WHERE a.usuario_id = $1 ORDER BY a.created_at`,
        [usuarioId],
      ),
      this.ds.query<ExportacaoConta['sessoes']>(
        `SELECT produto, tenant_id AS "tenantId", created_at AS "criadaEm",
                expira_em AS "expiraEm", revogada_em AS "revogadaEm"
           FROM crommos.sessoes WHERE usuario_id = $1 ORDER BY created_at`,
        [usuarioId],
      ),
      this.ds.query<ExportacaoConta['auditoria']>(
        `SELECT produto, tenant_id AS "tenantId", action, resource, ip,
                user_agent AS navegador, created_at AS em
           FROM crommos.auditoria WHERE usuario_id = $1 ORDER BY created_at`,
        [usuarioId],
      ),
    ]);
    await this.registrar(usuarioId, 'exportar-conta');
    return {
      geradoEm: new Date().toISOString(),
      pessoa: {
        id: u.id,
        nome: u.nome,
        email: u.email,
        emailConfirmado: !u.emailConfirmacaoHash,
        termosVersao: u.termosVersao ?? null,
        termosAceitosEm: u.termosAceitosEm ?? null,
        criadaEm: u.createdAt,
      },
      acessos,
      sessoes,
      auditoria,
    };
  }

  async excluir(usuarioId: string, senha: string): Promise<void> {
    const u = await this.ds
      .getRepository(Usuario)
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .where('u.id = :id', { id: usuarioId })
      .getOne();
    if (!u) throw new UnauthorizedException();
    if (!(await conferirSenha(senha, u.passwordHash))) {
      throw new BadRequestException('Senha incorreta.');
    }
    const descartavel = await senhaDescartavel();
    await this.ds.transaction(async (em) => {
      // Trava os acessos da pessoa: nada de outro admin sair ao mesmo tempo
      // sem a conferência abaixo enxergar.
      const unicos = await em.query<{ clinica: string | null }[]>(
        `SELECT s.tenant_nome AS clinica
           FROM crommos.acessos a
           JOIN crommos.assinaturas s
             ON s.tenant_id = a.tenant_id AND s.produto = a.produto
            AND s.deleted_at IS NULL
          WHERE a.usuario_id = $1 AND a.ativo AND a.papel = $2
            AND NOT EXISTS (
              SELECT 1 FROM crommos.acessos o
               WHERE o.tenant_id = a.tenant_id AND o.produto = a.produto
                 AND o.usuario_id <> a.usuario_id AND o.ativo
                 AND o.papel = $2 AND NOT o.convite_pendente)
          FOR UPDATE OF a`,
        [usuarioId, PAPEL_ADMIN],
      );
      if (unicos.length) {
        throw new ConflictException(
          `Você é o único administrador de: ${unicos
            .map((c) => c.clinica ?? 'clínica sem nome')
            .join(
              ', ',
            )}. Passe a administração para outra pessoa antes de excluir a conta.`,
        );
      }
      await em.query(
        `UPDATE crommos.acessos SET ativo = false, updated_at = now()
          WHERE usuario_id = $1`,
        [usuarioId],
      );
      await em.query(
        `UPDATE crommos.usuarios
            SET email = $2, nome = 'Conta excluída', password_hash = $3,
                password_reset_token_hash = NULL, password_reset_expires_at = NULL,
                email_confirmacao_hash = NULL, email_confirmacao_expira_em = NULL,
                totp_segredo = NULL, totp_ativo_em = NULL, totp_recuperacao = NULL,
                exclusao_pendente = coalesce((
                  SELECT array_agg(DISTINCT produto) FROM crommos.acessos
                   WHERE usuario_id = $1), '{}'),
                deleted_at = now(), updated_at = now()
          WHERE id = $1`,
        [usuarioId, `excluida-${usuarioId}@anonimizado.invalid`, descartavel],
      );
    });
    await this.sessoes.revogarDaPessoa(usuarioId);
    await this.registrar(usuarioId, 'excluir-conta');
    // A cópia de nome/e-mail nos produtos; falhou → o job repete.
    await this.propagarExclusao(usuarioId);
  }

  /** Re-tenta as exclusões pendentes nos produtos (uma réplica por vez). */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async cronExclusoes(): Promise<void> {
    const n = await comLockGlobal(this.ds, 'plataforma-exclusoes', () =>
      this.reenviarExclusoes(),
    );
    if (n) this.logger.log(`Exclusões de conta propagadas: ${n}`);
  }

  /** Devolve quantas pessoas ficaram sem pendência nesta execução. */
  async reenviarExclusoes(): Promise<number> {
    const linhas = await this.ds.query<{ id: string }[]>(
      `SELECT id FROM crommos.usuarios
        WHERE cardinality(exclusao_pendente) > 0 LIMIT $1`,
      [LOTE_EXCLUSOES],
    );
    let feitas = 0;
    for (const { id } of linhas) {
      if (await this.propagarExclusao(id)) feitas++;
    }
    return feitas;
  }

  /** Pede a cada produto pendente que anonimize; `true` = nada mais pendente. */
  private async propagarExclusao(usuarioId: string): Promise<boolean> {
    const [u] = await this.ds.query<{ pendente: Produto[] | null }[]>(
      'SELECT exclusao_pendente AS pendente FROM crommos.usuarios WHERE id = $1',
      [usuarioId],
    );
    let resta = 0;
    for (const produto of u?.pendente ?? []) {
      const cfg = configProduto(produto);
      try {
        if (!cfg) throw new Error(`produto ${produto} sem API configurada`);
        await this.produtos.anonimizarPessoa(cfg, usuarioId);
        await this.ds.query(
          `UPDATE crommos.usuarios
              SET exclusao_pendente = array_remove(exclusao_pendente, $2)
            WHERE id = $1`,
          [usuarioId, produto],
        );
      } catch (e) {
        resta++;
        this.logger.warn(
          `Exclusão da conta ainda não propagada (${produto}): ${(e as Error).message}`,
        );
      }
    }
    return resta === 0;
  }

  private registrar(usuarioId: string, action: string): Promise<void> {
    return this.audit.registrar({
      usuarioId,
      action,
      resource: 'conta',
      resourceId: usuarioId,
    });
  }
}
