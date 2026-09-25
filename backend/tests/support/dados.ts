import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Acesso } from 'src/auth/acesso.entity';
import { hashSenha } from 'src/auth/tokens';
import { Usuario } from 'src/auth/usuario.entity';
import { Assinatura } from 'src/billing/assinatura.entity';
import { MODULE_CODES, PlanoPeriodo } from 'src/billing/modules.catalog';

export const SENHA = 'senha-forte-123';

/** Pessoa com senha conhecida (hash calculado uma vez por processo). */
let hashPadrao: Promise<string> | undefined;
export async function criarPessoa(
  ds: DataSource,
  p: Partial<Usuario> & { email: string },
): Promise<Usuario> {
  hashPadrao ??= hashSenha(SENHA);
  return ds.getRepository(Usuario).save({
    nome: 'Pessoa Teste',
    passwordHash: await hashPadrao,
    ...p,
  });
}

export function criarAcesso(
  ds: DataSource,
  a: Partial<Acesso> & { usuarioId: string; tenantId: string },
): Promise<Acesso> {
  return ds.getRepository(Acesso).save({
    produto: 'clinic',
    papel: 'admin',
    ativo: true,
    convitePendente: false,
    ...a,
  });
}

export function criarAssinatura(
  ds: DataSource,
  a: Partial<Assinatura> = {},
): Promise<Assinatura> {
  return ds.getRepository(Assinatura).save({
    tenantId: randomUUID(),
    produto: 'clinic',
    modulosAtivos: [...MODULE_CODES],
    numeroUsuarios: 5,
    plano: PlanoPeriodo.Mensal,
    cicloInicio: '2026-09-01',
    cicloFim: '2026-10-01',
    emTrialAte: null,
    saldoCredito: 0,
    ...a,
  });
}

/** Valor do cookie `crommos_rt` de uma resposta do Supertest. */
export function cookieRefresh(headers: Record<string, unknown>): string {
  const setCookie = (headers['set-cookie'] as string[] | undefined) ?? [];
  const c = setCookie.find((x) => x.startsWith('crommos_rt='));
  if (!c) throw new Error('sem cookie de refresh');
  return c.split(';')[0];
}
