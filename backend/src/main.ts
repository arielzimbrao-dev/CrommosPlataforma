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
import { loadEnv } from './config/load-env';

loadEnv();
process.env.TZ = process.env.TZ ?? 'America/Sao_Paulo';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger:
      process.env.NODE_ENV === 'development'
        ? ['log', 'error', 'warn', 'debug', 'verbose']
        : ['error', 'warn'],
  });

  // Atrás do proxy (Coolify/Traefik): confia em 1 hop para que `req.ip`
  // reflita o IP real do cliente — sem isto, o rate limiting por IP trataria
  // todo o tráfego como um único cliente (o proxy).
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.TRUST_PROXY === 'true'
  ) {
    app.set('trust proxy', 1);
  }

  // Cabeçalhos de segurança (defesa em profundidade). CSP/CORP desabilitados:
  // o serviço expõe Swagger UI; um CSP estrito quebraria a UI sem ganho para uma API.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: false,
    }),
  );

  // Compressão gzip/deflate das respostas. Otimização pura de transporte.
  if (process.env.DISABLE_HTTP_COMPRESSION !== 'true') {
    app.use(compression());
  }

  // Lê cookies (req.cookies) — o refresh token trafega em cookie httpOnly.
  app.use(cookieParser());

  // Corpos pequenos (login, signup, assinatura): o limite padrão (100 KB) basta.
  app.useBodyParser('json', { limit: '100kb' });

  // CORS: origens dos frontends dos produtos (FRONTEND_URLS, CSV; sem ela vale
  // FRONTEND_URL), com credenciais (cookie de refresh). Em desenvolvimento
  // libera tudo; em produção nunca abre com a lista vazia (common/http/cors.ts).
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

  // Validação global: rejeita propriedades não declaradas (whitelist +
  // forbidNonWhitelisted → 400 em campo inesperado) e aplica a transformação de
  // tipos dos DTOs (transform).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  // O AllExceptionsFilter global é registrado via APP_FILTER em app.module.ts.

  // Swagger: aberto em desenvolvimento; em produção só com ENABLE_SWAGGER=true E
  // credenciais Basic (SWAGGER_USER/SWAGGER_PASSWORD) — nunca expõe o schema
  // publicamente. Sem as credenciais em produção, mantém desligado.
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
