import {
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Column,
} from 'typeorm';

/**
 * Classe base das entidades do schema `crommos`.
 * Fornece id (uuid), timestamps de auditoria e soft-delete.
 * Estenda esta classe em cada entidade de domínio.
 */
export abstract class BaseEntity {
  // `!` (definite assignment): o TypeORM popula estas colunas em runtime, então
  // sob `strictPropertyInitialization` afirmamos que serão atribuídas.
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @DeleteDateColumn({
    name: 'deleted_at',
    type: 'timestamptz',
    nullable: true,
  })
  deletedAt?: Date;

  @Column({ name: 'created_by', nullable: true })
  createdBy?: string;

  @Column({ name: 'updated_by', nullable: true })
  updatedBy?: string;

  @Column({ name: 'deleted_by', nullable: true })
  deletedBy?: string;
}
