import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { comLockGlobal } from '../common/lock-global';
import { SessoesService } from './sessoes.service';

/**
 * Limpeza diária (uma réplica por vez): sessões de refresh vencidas e
 * registros de acesso além da retenção (`RETENCAO_REGISTROS_ACESSO_DIAS`).
 */
@Injectable()
export class SessoesCron {
  private readonly logger = new Logger('SessoesCron');

  constructor(
    private readonly sessoes: SessoesService,
    @Inject('DATA_SOURCE') private readonly ds: DataSource,
    private readonly audit: AuditService,
  ) {}

  @Cron('30 3 * * *', { timeZone: 'America/Sao_Paulo' })
  async run(): Promise<void> {
    const r = await comLockGlobal(
      this.ds,
      'plataforma-sessoes-limpeza',
      async () => ({
        sessoes: await this.sessoes.limparVencidas(),
        acessos: await this.audit.purgarRegistrosAcesso(),
      }),
    );
    if (r?.sessoes) this.logger.log(`Sessões vencidas removidas: ${r.sessoes}`);
    if (r?.acessos) {
      this.logger.log(`Registros de acesso além da retenção: ${r.acessos}`);
    }
  }
}
