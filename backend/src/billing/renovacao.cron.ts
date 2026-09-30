import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { comLockGlobal } from '../common/lock-global';
import { AssinaturaService } from './assinatura.service';

/**
 * Renovação diária dos ciclos vencidos (gera a fatura `ciclo`) e, em seguida,
 * a marcação da inadimplência (modo leitura). Com várias réplicas, só a que
 * obtiver o lock global roda. O nome do lock
 * é o mesmo do Clinic de propósito: durante a transição, nunca as duas APIs
 * renovam ao mesmo tempo.
 */
@Injectable()
export class RenovacaoCron {
  private readonly logger = new Logger('RenovacaoCron');

  constructor(
    private readonly assinaturas: AssinaturaService,
    @Inject('DATA_SOURCE') private readonly ds: DataSource,
  ) {}

  @Cron('0 3 * * *', { timeZone: 'America/Sao_Paulo' })
  async run(): Promise<void> {
    const r = await comLockGlobal(this.ds, 'billing-renovacao', async () => ({
      faturas: await this.assinaturas.renovarVencidas(),
      // Depois da renovação: marca/desmarca o modo leitura por inadimplência.
      inadimplencia: await this.assinaturas.atualizarInadimplencia(),
    }));
    if (r?.faturas)
      this.logger.log(`Faturas de renovação geradas: ${r.faturas}`);
    if (r?.inadimplencia) {
      this.logger.log(
        `Assinaturas com a inadimplência atualizada: ${r.inadimplencia}`,
      );
    }
  }
}
