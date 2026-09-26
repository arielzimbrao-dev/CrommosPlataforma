import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../common/base.entity';

export type TipoCliente = 'pf' | 'pj';

/**
 * Cliente = quem paga (schema `crommos`, migration 01). Identificado pelo
 * CPF do dono (`pf`) ou pelo CNPJ da matriz (`pj`), só dígitos. Pode ter
 * várias clínicas (assinaturas) do mesmo produto; as clínicas dele podem ter CNPJs próprios
 * (`unidades.cnpj`). Ver docs/contrato.md.
 */
@Entity({ name: 'clientes', schema: 'crommos' })
export class Cliente extends BaseEntity {
  @Column({ type: 'varchar', length: 2, default: 'pj' })
  tipo!: TipoCliente;

  /** CPF (11) ou CNPJ (14) só dígitos; null só em clientes migrados sem CNPJ. */
  @Column({ type: 'varchar', length: 14, nullable: true })
  documento?: string | null;

  @Column()
  nome!: string;

  @Column({ name: 'email_cobranca', type: 'varchar', nullable: true })
  emailCobranca?: string | null;

  /** Cliente na AbacatePay (criado na 1ª cobrança). */
  @Column({ name: 'abacatepay_id', type: 'varchar', nullable: true })
  abacatepayId?: string | null;
}
