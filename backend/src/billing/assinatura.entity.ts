import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../common/base.entity';
import { numericTransformer } from '../common/numeric.transformer';
import type { Produto } from '../common/produtos';
import { ModuleCode, PlanoPeriodo } from './modules.catalog';

/**
 * Assinatura de um tenant de um produto (`crommos.assinaturas`): módulos, nº de
 * usuários, periodicidade (`plano`) e o ciclo corrente. Uma por tenant; no
 * máximo uma por cliente × produto. O valor é calculado sob demanda
 * (modules.catalog); mudanças no meio do ciclo geram pró-rata (pro-rata.ts).
 */
@Entity({ name: 'assinaturas', schema: 'crommos' })
export class Assinatura extends BaseEntity {
  /** Tenant no schema do produto (ex.: `clinic.clinicas.id`). */
  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  /** Cliente pagador (`crommos.clientes`). */
  @Column({ name: 'cliente_id', type: 'uuid', nullable: true })
  clienteId?: string | null;

  @Column({ type: 'varchar', length: 10 })
  produto!: Produto;

  /** Nome do tenant para a escolha de clínica no login. */
  @Column({ name: 'tenant_nome', type: 'varchar', nullable: true })
  tenantNome?: string | null;

  /** Código curto (5) do tenant, gerado no signup; aceito no login. */
  @Column({ name: 'tenant_codigo', type: 'varchar', length: 5, nullable: true })
  tenantCodigo?: string | null;

  @Column({ name: 'modulos_ativos', type: 'jsonb', default: () => "'[]'" })
  modulosAtivos!: ModuleCode[];

  @Column({ name: 'numero_usuarios', type: 'int', default: 1 })
  numeroUsuarios!: number;

  @Column({ type: 'varchar', default: PlanoPeriodo.Mensal })
  plano!: PlanoPeriodo;

  /** Início do ciclo corrente (YYYY-MM-DD, inclusivo). */
  @Column({ name: 'ciclo_inicio', type: 'date' })
  cicloInicio!: string;

  /** Fim do ciclo corrente (YYYY-MM-DD, exclusivo = início do próximo). */
  @Column({ name: 'ciclo_fim', type: 'date' })
  cicloFim!: string;

  /** Trial ativo enquanto hoje < emTrialAte. */
  @Column({ name: 'em_trial_ate', type: 'date', nullable: true })
  emTrialAte!: string | null;

  /** Crédito (R$) de reduções, abatido das próximas faturas. */
  @Column({
    name: 'saldo_credito',
    type: 'numeric',
    precision: 12,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  saldoCredito!: number;
}
