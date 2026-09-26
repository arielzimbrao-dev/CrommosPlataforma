/**
 * Situação da assinatura (decisão de produto, docs/contrato.md):
 *
 * - **fim do trial sem confirmação** → modo leitura (nada é faturado);
 * - **fatura pendente vencida há mais de N dias** (`DIAS_TOLERANCIA_INADIMPLENCIA`,
 *   padrão 7) → modo leitura; o aviso aparece desde o vencimento. A baixa
 *   reativa na hora.
 *
 * Modo leitura: o produto aceita só leitura (GET) e responde 402 à escrita;
 * login e a tela de assinatura continuam funcionando.
 */
import { somarDias } from './pro-rata';

export type MotivoLeitura = 'trial_expirado' | 'inadimplencia';

export const DIAS_TOLERANCIA_PADRAO = 7;

export function diasTolerancia(
  env: Record<string, string | undefined> = process.env,
): number {
  const n = Number(env.DIAS_TOLERANCIA_INADIMPLENCIA);
  return env.DIAS_TOLERANCIA_INADIMPLENCIA && Number.isInteger(n) && n >= 0
    ? n
    : DIAS_TOLERANCIA_PADRAO;
}

/** Trial acabou (hoje ≥ emTrialAte) e o admin não confirmou. */
export const trialExpirado = (
  a: { emTrialAte: string | null; trialConfirmadoEm?: Date | null },
  hoje: string,
) => !!a.emTrialAte && hoje >= a.emTrialAte && !a.trialConfirmadoEm;

export function motivoLeitura(
  a: {
    emTrialAte: string | null;
    trialConfirmadoEm?: Date | null;
    inadimplenteDesde?: string | null;
  },
  hoje: string,
): MotivoLeitura | null {
  if (trialExpirado(a, hoje)) return 'trial_expirado';
  if (a.inadimplenteDesde) return 'inadimplencia';
  return null;
}

/** Dia em que uma fatura pendente com este vencimento leva ao modo leitura. */
export const bloqueiaEm = (vencimento: string, dias = diasTolerancia()) =>
  somarDias(vencimento, dias + 1);
