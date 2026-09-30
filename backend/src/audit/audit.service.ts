import { Inject, Injectable } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Auditoria } from './auditoria.entity';

/**
 * Retenção **proposta** dos registros de acesso (LGPD): o Marco
 * Civil (art. 15) exige ao menos 6 meses; 1 ano dá folga para investigar um
 * incidente. Único lugar do prazo (purga diária no SessoesCron).
 */
export const RETENCAO_REGISTROS_ACESSO_DIAS = 365;
/** O admin da clínica vê os acessos da equipe dos últimos 90 dias. */
export const JANELA_ACESSOS_EQUIPE_DIAS = 90;
/** Registro de acesso = linha da auditoria com este recurso. */
export const RECURSO_ACESSO = 'auth';

/** De onde veio a requisição (Marco Civil): IP e navegador. */
export interface ContextoAcesso {
  ip?: string;
  userAgent?: string;
}

export interface EventoAuditoria extends ContextoAcesso {
  action: string;
  resource: string;
  usuarioId?: string | null;
  produto?: string | null;
  tenantId?: string | null;
  resourceId?: string | null;
}

export interface RegistroAcesso {
  em: Date;
  usuarioId: string;
  acao: string;
  ip: string | null;
  navegador: string | null;
  /** Pessoa afetada (ex.: de quem o admin desligou o 2FA). */
  alvoId: string | null;
}

/**
 * Grava a trilha de auditoria (LGPD). Sem PII além do IP e do navegador dos
 * registros de acesso (exigidos pelo Marco Civil): só ids, ação e recurso.
 */
@Injectable()
export class AuditService {
  constructor(
    @Inject('AUDITORIA_REPOSITORY')
    private readonly logs: Repository<Auditoria>,
  ) {}

  async registrar(e: EventoAuditoria): Promise<void> {
    await this.logs.insert({
      usuarioId: e.usuarioId ?? null,
      produto: e.produto ?? null,
      tenantId: e.tenantId ?? null,
      action: e.action,
      resource: e.resource,
      resourceId: e.resourceId ?? null,
      ip: e.ip?.slice(0, 45) || null,
      userAgent: e.userAgent?.slice(0, 255) || null,
    });
  }

  /**
   * Acessos da equipe do tenant (últimos 90 dias, do mais novo): os do tenant
   * e as falhas de login sem clínica escolhida de quem tem acesso a ele.
   */
  async listarAcessos(
    produto: string,
    tenantId: string,
    q: { usuarioId?: string; take: number; skip: number },
  ): Promise<{ data: RegistroAcesso[]; total: number }> {
    const onde = `a.resource = $1 AND a.created_at > now() - make_interval(days => $2)
      AND ($5::uuid IS NULL OR a.usuario_id = $5::uuid)
      AND (a.tenant_id = $4 OR (a.tenant_id IS NULL AND a.usuario_id IN (
            SELECT e.usuario_id FROM crommos.acessos e
             WHERE e.produto = $3 AND e.tenant_id = $4)))
      AND a.produto = $3`;
    const params = [
      RECURSO_ACESSO,
      JANELA_ACESSOS_EQUIPE_DIAS,
      produto,
      tenantId,
      q.usuarioId ?? null,
    ];
    const [data, [{ total }]] = await Promise.all([
      this.logs.query<RegistroAcesso[]>(
        `SELECT a.created_at AS em, a.usuario_id AS "usuarioId", a.action AS acao,
                a.ip, a.user_agent AS navegador, a.resource_id AS "alvoId"
           FROM crommos.auditoria a WHERE ${onde}
          ORDER BY a.created_at DESC LIMIT $6 OFFSET $7`,
        [...params, q.take, q.skip],
      ),
      this.logs.query<{ total: number }[]>(
        `SELECT count(*)::int AS total FROM crommos.auditoria a WHERE ${onde}`,
        params,
      ),
    ]);
    return { data, total };
  }

  /**
   * Evento da **pessoa** (senha, 2FA — valem em todos os produtos) gravado
   * na trilha dela em cada clínica em que trabalha (acesso ativo e aceito),
   * para o admin de cada uma ver. Sem acesso: uma linha sem clínica.
   */
  async registrarDaPessoa(
    usuarioId: string,
    action: string,
    ctx: ContextoAcesso,
  ): Promise<void> {
    const clinicas = await this.logs.query<
      { produto: string; tenantId: string }[]
    >(
      `SELECT produto, tenant_id AS "tenantId" FROM crommos.acessos
        WHERE usuario_id = $1 AND ativo AND NOT convite_pendente`,
      [usuarioId],
    );
    const onde = clinicas.length ? clinicas : [{}];
    for (const c of onde) {
      await this.registrar({
        ...ctx,
        ...c,
        usuarioId,
        action,
        resource: RECURSO_ACESSO,
      });
    }
  }

  /** Apaga os registros de acesso além da retenção; devolve quantos. */
  async purgarRegistrosAcesso(): Promise<number> {
    const r: [unknown[], number] = await this.logs.query(
      `DELETE FROM crommos.auditoria
        WHERE resource = $1 AND created_at < now() - make_interval(days => $2)`,
      [RECURSO_ACESSO, RETENCAO_REGISTROS_ACESSO_DIAS],
    );
    return r[1];
  }
}
