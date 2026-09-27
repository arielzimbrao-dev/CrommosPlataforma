import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import type { Produto } from '../common/produtos';

/**
 * Sessão de refresh (`crommos.sessoes`, migration 02): uma por `jti`, só com o
 * hash do token. Cada refresh revoga a sessão e abre outra (rotação).
 */
@Entity({ name: 'sessoes', schema: 'crommos' })
export class Sessao {
  @PrimaryColumn('uuid')
  jti!: string;

  @Column({ name: 'usuario_id', type: 'uuid' })
  usuarioId!: string;

  @Column({ type: 'varchar', length: 10 })
  produto!: Produto;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ name: 'refresh_hash', type: 'varchar', length: 64 })
  refreshHash!: string;

  @Column({ name: 'expira_em', type: 'timestamptz' })
  expiraEm!: Date;

  @Column({ name: 'revogada_em', type: 'timestamptz', nullable: true })
  revogadaEm!: Date | null;

  /**
   * Família (QA-002): jti da 1ª sessão do login, herdado nas rotações. É o
   * `sid` do access token (migration 08).
   */
  @Column({ type: 'uuid', nullable: true })
  familia!: string | null;

  /** Rotação: jti da sessão que substituiu esta (reapresentar = reuso). */
  @Column({ name: 'substituida_por', type: 'uuid', nullable: true })
  substituidaPor!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
