import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { NOME_PRODUTO, Produto } from '../common/produtos';
import { EMAIL_PROVIDER, type EmailProvider } from './email.provider';

const semBarraFinal = (url: string) => url.trim().replace(/\/$/, '');

/** URL pública da API (`API_URL`); localhost:PORT em dev. */
export function urlDaApi(): string {
  return semBarraFinal(
    process.env.API_URL?.trim() ||
      `http://localhost:${process.env.PORT || '3000'}`,
  );
}

/** Base dos links para o navegador (`FRONTEND_URL`); localhost em dev. */
export function urlDoFrontend(): string {
  return semBarraFinal(
    process.env.FRONTEND_URL?.trim() || 'http://localhost:5173',
  );
}

/**
 * E-mails transacionais do login único: redefinição de senha, convite e
 * confirmação de e-mail. Nunca loga o e-mail da pessoa; fora de produção loga
 * o link (teste manual). Falha no envio → 503.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    @Inject(EMAIL_PROVIDER) private readonly provider: EmailProvider,
  ) {}

  sendPasswordReset(email: string, token: string): Promise<void> {
    const link = `${urlDoFrontend()}/redefinir-senha?token=${token}`;
    return this.enviar(email, 'Redefinição de senha — Crommos', link, [
      'Recebemos um pedido para redefinir a sua senha na Crommos.',
      `Para criar uma nova senha, acesse (válido por 1 hora): ${link}`,
      'Se não foi você, ignore este e-mail.',
    ]);
  }

  sendConvite(
    email: string,
    nome: string,
    token: string,
    produto: Produto,
  ): Promise<void> {
    const sistema = NOME_PRODUTO[produto];
    const link = `${urlDoFrontend()}/definir-senha?token=${token}`;
    return this.enviar(email, `Convite para o ${sistema}`, link, [
      `Olá, ${nome}!`,
      `Você foi convidado(a) para acessar o ${sistema}.`,
      `Defina a sua senha em (válido por 7 dias): ${link}`,
    ]);
  }

  /**
   * QA-004: convite para quem **já tem conta**. O link aponta para a página
   * do front (`/aceitar-convite`), que confere o token e aceita pelo botão
   * (`POST /auth/aceitar-convite`).
   */
  sendConviteAceite(
    email: string,
    nome: string,
    token: string,
    produto: Produto,
    clinica: string | null,
  ): Promise<void> {
    const sistema = NOME_PRODUTO[produto];
    const link = `${urlDoFrontend()}/aceitar-convite?token=${token}`;
    return this.enviar(email, `Convite para o ${sistema}`, link, [
      `Olá, ${nome}!`,
      `Você foi convidado(a) para acessar ${clinica ?? 'uma clínica'} no ${sistema}.`,
      `Para aceitar, acesse (válido por 7 dias): ${link}`,
      'Depois, entre com a senha que você já usa. Se não reconhece o convite, ignore este e-mail.',
    ]);
  }

  /**
   * Confirmação do e-mail do signup. O link aponta para a **API**
   * (`GET /auth/confirmar-email`), que confirma e redireciona ao login.
   */
  sendConfirmacaoEmail(email: string, token: string): Promise<void> {
    const link = `${urlDaApi()}/auth/confirmar-email?token=${token}`;
    return this.enviar(email, 'Confirme o seu e-mail — Crommos', link, [
      'Bem-vindo(a) à Crommos!',
      `Confirme o seu e-mail para liberar o convite da equipe: ${link}`,
      'Se não foi você quem criou a conta, ignore este e-mail.',
    ]);
  }

  /**
   * QA-195: o admin de uma clínica desligou a verificação em duas etapas da
   * pessoa (vale em todas as clínicas dela). Aviso sem link.
   */
  sendAvisoDoisFatoresDesligado(
    email: string,
    clinica: string | null,
  ): Promise<void> {
    const perfil = `${urlDoFrontend()}/perfil`;
    return this.enviar(
      email,
      'Sua verificação em duas etapas foi desligada — Crommos',
      perfil,
      [
        `O administrador de ${clinica ?? 'uma clínica'} desligou a verificação em duas etapas da sua conta.`,
        'Isso vale para todas as clínicas em que você trabalha. Ligue de novo em Meu perfil assim que puder.',
        'Se você não pediu isso, troque a sua senha e avise a clínica.',
      ],
    );
  }

  private async enviar(
    email: string,
    assunto: string,
    link: string,
    linhas: string[],
  ): Promise<void> {
    if (process.env.NODE_ENV !== 'production') {
      this.logger.log(`[mail] ${assunto} — ${link}`);
    }
    try {
      await this.provider.enviarEmail(email, assunto, linhas.join('\n\n'));
    } catch (e) {
      this.logger.warn(
        `[mail] falha ao enviar "${assunto}": ${e instanceof Error ? e.message : String(e)}`,
      );
      throw new ServiceUnavailableException(
        'Não foi possível enviar o e-mail agora. Tente novamente em instantes.',
      );
    }
  }
}
