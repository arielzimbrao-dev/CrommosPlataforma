import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { basicAuth } from './common/http/basic-auth.middleware';
import { corsPermite, origensPermitidas } from './common/http/cors';
import { capturarErrosNaoTratados, LoggerJson } from './common/log/logger-json';
import { requestIdMiddleware } from './common/log/request-id';
import { loadEnv } from './config/load-env';

loadEnv();
process.env.TZ = process.env.TZ ?? 'America/Sao_Paulo';

async function bootstrap(): Promise<void> {
  // Produção: logs JSON (uma linha por evento, com request-id). Dev: o padrão.
  const logger =
    process.env.NODE_ENV === 'production'
      ? new LoggerJson()
      : process.env.NODE_ENV === 'development'
        ? (['log', 'error', 'warn', 'debug', 'verbose'] as const)
        : (['error', 'warn'] as const);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: logger instanceof LoggerJson ? logger : [...logger],
    // Corpo cru disponível (req.rawBody): HMAC do webhook da AbacatePay.
    rawBody: true,
  });
  capturarErrosNaoTratados(new Logger('Processo'));
  // Request-id antes de tudo (logs e chamadas aos produtos).
  app.use(requestIdMiddleware);

  // Atrás do proxy (Coolify/Traefik): sem confiar em 1 hop, `req.ip` seria o
  // do proxy e o rate limit por IP trataria todo o tráfego como um cliente só.
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.TRUST_PROXY === 'true'
  ) {
    app.set('trust proxy', 1);
  }

  // CSP/CORP desligados: um CSP estrito quebraria o Swagger UI sem ganho para
  // uma API.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: false,
    }),
  );

  if (process.env.DISABLE_HTTP_COMPRESSION !== 'true') {
    app.use(compression());
  }

  // O refresh token trafega em cookie httpOnly.
  app.use(cookieParser());

  // Corpos pequenos (login, signup, assinatura): o limite padrão (100 KB) basta.
  app.useBodyParser('json', { limit: '100kb' });

  // Origens dos frontends dos produtos, com credenciais (cookie de refresh).
  const permitidas = origensPermitidas(
    process.env.FRONTEND_URLS ?? process.env.FRONTEND_URL,
  );

  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      if (corsPermite(origin, { nodeEnv: process.env.NODE_ENV, permitidas })) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    credentials: true,
    optionsSuccessStatus: 204,
    maxAge: 86400,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  // Swagger: aberto em desenvolvimento; em produção só com ENABLE_SWAGGER=true
  // e Basic Auth (SWAGGER_USER/SWAGGER_PASSWORD).
  const isProduction = process.env.NODE_ENV === 'production';
  const swaggerEnabled = !isProduction || process.env.ENABLE_SWAGGER === 'true';
  const swaggerUser = process.env.SWAGGER_USER;
  const swaggerPass = process.env.SWAGGER_PASSWORD;
  const swaggerProtected = !isProduction || (!!swaggerUser && !!swaggerPass);

  if (swaggerEnabled && !swaggerProtected) {
    new Logger('Bootstrap').warn(
      'Swagger habilitado em produção sem SWAGGER_USER/SWAGGER_PASSWORD — mantido desligado.',
    );
  }
  if (swaggerEnabled && swaggerProtected) {
    if (isProduction) {
      app.use('/api_doc', basicAuth(swaggerUser!, swaggerPass!));
    }
    const options = new DocumentBuilder()
      .setTitle('Crommos Plataforma API')
      .setDescription('Login único, signup, acessos, assinaturas e faturas')
      .setVersion('1.0')
      .addTag('plataforma-api')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, options);
    SwaggerModule.setup('api_doc', app, document, {
      customSiteTitle: 'Crommos Plataforma API Doc.',
    });
  }

  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}

void bootstrap();
