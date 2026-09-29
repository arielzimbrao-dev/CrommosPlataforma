import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Trilha de auditoria da plataforma (`crommos.auditoria`, migration 03),
 * append-only: quem (pessoa; `null` = sistema) fez o quê em qual tenant.
 */
@Entity({ name: 'auditoria', schema: 'crommos' })
export class Auditoria {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'usuario_id', type: 'uuid', nullable: true })
  usuarioId!: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  produto!: string | null;

  @Column({ name: 'tenant_id', type: 'uuid', nullable: true })
  tenantId!: string | null;

  @Column({ type: 'varchar', length: 50 })
  action!: string;

  @Column({ type: 'varchar', length: 50 })
  resource!: string;

  @Column({ name: 'resource_id', type: 'varchar', nullable: true })
  resourceId!: string | null;

  /** Registros de acesso (migration 12, Marco Civil): IP e navegador. */
  @Column({ type: 'varchar', length: 45, nullable: true })
  ip!: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 255, nullable: true })
  userAgent!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
