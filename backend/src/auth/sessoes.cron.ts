import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { comLockGlobal } from '../common/lock-global';
import { SessoesService } from './sessoes.service';

/** Limpeza diária das sessões de refresh vencidas (uma réplica por vez). */
@Injectable()
export class SessoesCron {
  private readonly logger = new Logger('SessoesCron');

  constructor(
    private readonly sessoes: SessoesService,
    @Inject('DATA_SOURCE') private readonly ds: DataSource,
  ) {}

  @Cron('30 3 * * *', { timeZone: 'America/Sao_Paulo' })
  async run(): Promise<void> {
    const n = await comLockGlobal(this.ds, 'plataforma-sessoes-limpeza', () =>
      this.sessoes.limparVencidas(),
    );
    if (n) this.logger.log(`Sessões vencidas removidas: ${n}`);
  }
}
