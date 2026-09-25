import { Inject, Injectable } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Auditoria } from './auditoria.entity';

export interface EventoAuditoria {
  action: string;
  resource: string;
  usuarioId?: string | null;
  produto?: string | null;
  tenantId?: string | null;
  resourceId?: string | null;
}

/** Grava a trilha de auditoria (LGPD). Sem PII: só ids, ação e recurso. */
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
    });
  }
}
