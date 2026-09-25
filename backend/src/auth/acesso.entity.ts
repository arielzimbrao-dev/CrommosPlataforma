import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { Produto } from '../common/produtos';

/**
 * Acesso da pessoa a um tenant de um produto (`crommos.acessos`, migration 02):
 * o que o login lista, o que conta no limite de usuários e o papel que libera
 * as telas de assinatura (`admin` altera; `admin`/`financeiro` leem). O papel
 * vem do produto. Convite pendente = pessoa que ainda não definiu a senha.
 */
@Entity({ name: 'acessos', schema: 'crommos' })
export class Acesso {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'usuario_id', type: 'uuid' })
  usuarioId!: string;

  @Column({ type: 'varchar', length: 10 })
  produto!: Produto;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 30 })
  papel!: string;

  @Column({ type: 'boolean', default: true })
  ativo!: boolean;

  @Column({ name: 'convite_pendente', type: 'boolean', default: false })
  convitePendente!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
