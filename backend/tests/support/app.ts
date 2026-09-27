import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { DataSource } from 'typeorm';
import { AppModule } from 'src/app.module';
import { MailService } from 'src/mail/mail.service';

/** MailService falso: guarda os tokens que iriam por e-mail. */
export function mailFalso() {
  return {
    sendPasswordReset: jest.fn().mockResolvedValue(undefined),
    sendConvite: jest.fn().mockResolvedValue(undefined),
    sendConviteAceite: jest.fn().mockResolvedValue(undefined),
    sendConfirmacaoEmail: jest.fn().mockResolvedValue(undefined),
  };
}
export type MailFalso = ReturnType<typeof mailFalso>;

/** Último argumento `pos` da última chamada do mock (o token do e-mail). */
export const ultimo = (fn: jest.Mock, pos: number): string => {
  const calls = fn.mock.calls as unknown[][];
  return calls[calls.length - 1][pos] as string;
};

/** Sobe a app inteira (migrations no boot) como o main.ts, com o e-mail falso. */
export async function criarApp(
  mail: MailFalso,
): Promise<{ app: INestApplication; ds: DataSource }> {
  const ref = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MailService)
    .useValue(mail)
    .compile();
  const app = ref.createNestApplication({ rawBody: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.use(cookieParser());
  await app.init();
  return { app, ds: app.get<DataSource>('DATA_SOURCE') };
}

/** Esvazia as tabelas da plataforma (banco de teste dedicado). */
export async function limparBanco(ds: DataSource): Promise<void> {
  await ds.query(
    `TRUNCATE crommos.auditoria, crommos.sessoes, crommos.acessos,
              crommos.faturas, crommos.assinaturas, crommos.usuarios,
              crommos.clientes, crommos.rate_limit CASCADE`,
  );
}

export async function fecharApp(app?: INestApplication): Promise<void> {
  if (!app) return;
  await app.get<DataSource>('DATA_SOURCE').destroy();
  await app.close();
}
