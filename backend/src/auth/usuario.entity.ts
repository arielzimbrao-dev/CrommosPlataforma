import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../common/base.entity';

/**
 * Pessoa com login na plataforma (schema `crommos`, migration 01): um
 * e-mail = um login para todos os produtos. Guarda as credenciais e o que é
 * da pessoa (senha, redefinição/convite, confirmação do e-mail, termos). O
 * acesso a cada tenant é o `Acesso` (`crommos.acessos`). E-mail em
 * minúsculas, único na plataforma (`lower(email)`). Ver docs/contrato.md.
 *
 * Campos sensíveis são `select: false`: só carregam quando pedidos.
 */
@Entity({ name: 'usuarios', schema: 'crommos' })
export class Usuario extends BaseEntity {
  @Column()
  email!: string;

  @Column()
  nome!: string;

  @Column({ name: 'password_hash', select: false })
  passwordHash!: string;

  // `type` explícito nas colunas anuláveis: a union `string | null` não é
  // inferível pelo emitDecoratorMetadata (chega como `Object` no TypeORM).

  /** Hash do token de uso único (redefinição de senha e convite). */
  @Column({
    name: 'password_reset_token_hash',
    type: 'varchar',
    nullable: true,
    select: false,
  })
  passwordResetTokenHash?: string | null;

  @Column({
    name: 'password_reset_expires_at',
    type: 'timestamptz',
    nullable: true,
    select: false,
  })
  passwordResetExpiresAt?: Date | null;

  /**
   * Signup com e-mail ainda não confirmado (N-24): SHA-256 do token do link.
   * `null` = confirmado ou não se aplica.
   */
  @Column({
    name: 'email_confirmacao_hash',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  emailConfirmacaoHash?: string | null;

  /** Validade do link de confirmação (N-24). */
  @Column({
    name: 'email_confirmacao_expira_em',
    type: 'timestamptz',
    nullable: true,
    select: false,
  })
  emailConfirmacaoExpiraEm?: Date | null;

  /** Versão dos termos aceitos no signup. */
  @Column({ name: 'termos_versao', type: 'varchar', nullable: true })
  termosVersao?: string | null;

  @Column({ name: 'termos_aceitos_em', type: 'timestamptz', nullable: true })
  termosAceitosEm?: Date | null;
}
