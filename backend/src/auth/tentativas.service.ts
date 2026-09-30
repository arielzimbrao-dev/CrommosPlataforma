import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { sha256 } from '../common/crypto/segredo';
import { ThrottlerPostgres } from '../common/http/throttler-postgres';

const MINUTO = 60_000;
const JANELA_LOGIN = 15 * MINUTO;
/** Falhas de login por IP + e-mail na janela (força bruta numa conta). */
export const FALHAS_POR_EMAIL = 5;
/** Falhas de login por IP, todas as contas (varredura de e-mails). */
export const FALHAS_POR_IP = 50;
/**
 * Falhas numa **conta** vindas de qualquer IP (botnet) na última hora. A
 * partir daqui cada tentativa espera (dobra a cada falha, até 5 s) — atraso,
 * não bloqueio: um 429 por conta deixaria qualquer um travar o login do dono.
 */
export const FALHAS_POR_CONTA = 10;
const JANELA_CONTA = 60 * MINUTO;
const ATRASO_MAX_MS = 5_000;
const SEM_BLOQUEIO = 1_000_000;

/** Atraso da tentativa (ms) pelo nº de falhas da conta na janela. */
export function atrasoPorFalhas(falhas: number): number {
  if (falhas < FALHAS_POR_CONTA) return 0;
  return Math.min(ATRASO_MAX_MS, 250 * 2 ** (falhas - FALHAS_POR_CONTA));
}

const TABELA = 'crommos.rate_limit';
const LOGIN_EMAIL = 'login-falha';
const LOGIN_IP = 'login-falha-ip';
const LOGIN_CONTA = 'login-falha-conta';

/**
 * Limites que dependem do resultado ou do alvo, guardados na mesma
 * tabela do rate limit por IP (`crommos.rate_limit`, compartilhada entre as
 * réplicas; chaves com hash — sem e-mail nem IP em claro):
 *
 * - **login:** conta só as **falhas**, por IP + e-mail e (mais generoso) por
 *   IP; acertar a senha zera o par. Uma clínica inteira atrás do mesmo NAT
 *   entra sem esbarrar no limite.
 * - **usos por alvo** (`permitir`): esqueci a senha por e-mail, reenviar a
 *   confirmação por pessoa.
 */
@Injectable()
export class TentativasService {
  private readonly contador: ThrottlerPostgres;
  private readonly logger = new Logger(TentativasService.name);

  constructor(@Inject('DATA_SOURCE') private readonly ds: DataSource) {
    this.contador = new ThrottlerPostgres(ds, TABELA);
  }

  private chaves(ip: string, email: string) {
    return {
      par: sha256(`${ip}|${email}`),
      ip: sha256(ip),
    };
  }

  /** 429 se o par IP + e-mail ou o IP passou das falhas da janela. */
  async exigirLoginLiberado(ip: string, email: string): Promise<void> {
    const k = this.chaves(ip, email);
    const [linha] = await this.ds.query<unknown[]>(
      `SELECT 1 FROM ${TABELA}
        WHERE janela_fim > now()
          AND ((chave = $1 AND hits >= $2) OR (chave = $3 AND hits >= $4))
        LIMIT 1`,
      [
        `${LOGIN_EMAIL}:${k.par}`,
        FALHAS_POR_EMAIL,
        `${LOGIN_IP}:${k.ip}`,
        FALHAS_POR_IP,
      ],
    );
    if (linha) {
      throw new HttpException(
        'Muitas tentativas. Aguarde alguns minutos e tente de novo.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const [conta] = await this.ds.query<{ hits: number }[]>(
      `SELECT hits FROM ${TABELA} WHERE chave = $1 AND janela_fim > now()`,
      [`${LOGIN_CONTA}:${sha256(email)}`],
    );
    const atraso = atrasoPorFalhas(Number(conta?.hits ?? 0));
    if (atraso) await this.esperar(atraso);
  }

  /** Separado para o teste não esperar de verdade. */
  protected esperar(ms: number): Promise<void> {
    return new Promise((ok) => setTimeout(ok, ms));
  }

  async registrarFalhaLogin(ip: string, email: string): Promise<void> {
    const k = this.chaves(ip, email);
    await this.contador.increment(
      k.par,
      JANELA_LOGIN,
      FALHAS_POR_EMAIL,
      JANELA_LOGIN,
      LOGIN_EMAIL,
    );
    await this.contador.increment(
      k.ip,
      JANELA_LOGIN,
      FALHAS_POR_IP,
      JANELA_LOGIN,
      LOGIN_IP,
    );
    const conta = sha256(email);
    const { totalHits } = await this.contador.increment(
      conta,
      JANELA_CONTA,
      SEM_BLOQUEIO, // só conta: o contador não congela no limite
      JANELA_CONTA,
      LOGIN_CONTA,
    );
    // Alerta (sem o e-mail): no limiar e a cada 100 falhas depois.
    if (totalHits === FALHAS_POR_CONTA || totalHits % 100 === 0) {
      this.logger.warn(
        `[login] ${totalHits} falhas de login na última hora numa mesma conta (${conta.slice(0, 12)}), de vários IPs: possível ataque distribuído.`,
      );
    }
  }

  /** Senha certa: zera as falhas do par (as do IP seguem valendo). */
  async limparFalhasLogin(ip: string, email: string): Promise<void> {
    await this.ds.query(`DELETE FROM ${TABELA} WHERE chave = $1`, [
      `${LOGIN_EMAIL}:${this.chaves(ip, email).par}`,
    ]);
  }

  /** `true` se `alvo` já tem `limite` usos na janela (só consulta; a contagem é o `permitir`). */
  async esgotado(nome: string, alvo: string, limite: number): Promise<boolean> {
    const [linha] = await this.ds.query<unknown[]>(
      `SELECT 1 FROM ${TABELA}
        WHERE chave = $1 AND janela_fim > now() AND hits >= $2`,
      [`${nome}:${sha256(alvo)}`, limite],
    );
    return !!linha;
  }

  /** Conta um uso de `alvo`; `false` = passou de `limite` na janela. */
  async permitir(
    nome: string,
    alvo: string,
    limite: number,
    janelaMs: number,
  ): Promise<boolean> {
    const r = await this.contador.increment(
      sha256(alvo),
      janelaMs,
      limite,
      janelaMs,
      nome,
    );
    return r.totalHits <= limite;
  }
}
