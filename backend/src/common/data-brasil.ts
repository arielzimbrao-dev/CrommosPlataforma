/**
 * Datas no fuso do Brasil (produto comercializado só no Brasil). Evita o
 * off-by-one de usar `new Date().toISOString()` (UTC): perto da meia-noite, o
 * dia em UTC diverge do dia local e desloca caixa/vencimentos/retornos.
 */
const TZ = 'America/Sao_Paulo';

/** Data (yyyy-mm-dd) de um `Date` no fuso America/Sao_Paulo. */
export function dataLocal(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
}

/** Hoje (yyyy-mm-dd) no fuso America/Sao_Paulo. */
export function hojeISO(): string {
  return dataLocal(new Date());
}
