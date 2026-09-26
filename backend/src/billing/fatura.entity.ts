import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../common/base.entity';
import { numericTransformer } from '../common/numeric.transformer';

export type TipoFatura = 'ciclo' | 'complementar';
export type StatusFatura = 'pendente' | 'paga' | 'cancelada';

const dinheiro = {
  type: 'numeric' as const,
  precision: 12,
  scale: 2,
  transformer: numericTransformer,
};

/** Fatura da assinatura (`crommos.faturas`; pró-rata em pro-rata.ts). */
@Entity({ name: 'faturas', schema: 'crommos' })
export class Fatura extends BaseEntity {
  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ name: 'assinatura_id', type: 'uuid' })
  assinaturaId!: string;

  @Column({ type: 'varchar', length: 20 })
  tipo!: TipoFatura;

  @Column({ name: 'periodo_inicio', type: 'date' })
  periodoInicio!: string;

  @Column({ name: 'periodo_fim', type: 'date' })
  periodoFim!: string;

  @Column({ name: 'valor_bruto', ...dinheiro })
  valorBruto!: number;

  @Column({ name: 'credito_aplicado', ...dinheiro, default: 0 })
  creditoAplicado!: number;

  @Column({ name: 'valor_liquido', ...dinheiro })
  valorLiquido!: number;

  @Column({ type: 'varchar', length: 20, default: 'pendente' })
  status!: StatusFatura;

  @Column({ type: 'date' })
  vencimento!: string;

  @Column({ name: 'pago_em', type: 'timestamptz', nullable: true })
  pagoEm!: Date | null;

  /** Memória do cálculo (pró-rata ou renovação). */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  itens!: Record<string, unknown>;

  /** Checkout na AbacatePay (criado sob demanda). */
  @Column({ name: 'cobranca_id', type: 'varchar', nullable: true })
  cobrancaId?: string | null;

  @Column({ name: 'cobranca_url', type: 'text', nullable: true })
  cobrancaUrl?: string | null;
}
