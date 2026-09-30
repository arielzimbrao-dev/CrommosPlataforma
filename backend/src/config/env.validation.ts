import { plainToInstance, Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  MinLength,
  ValidateIf,
  validateSync,
} from 'class-validator';
import { erroNoParDeChaves } from '../auth/chaves-jwt';
import { PRODUTOS } from '../common/produtos';

/**
 * Validação das variáveis de ambiente no boot (`ConfigModule.forRoot({
 * validate })`): obrigatória ausente ou valor inválido derruba a aplicação logo
 * na inicialização ("falhar cedo"). Booleanos são as strings 'true'/'false'.
 */
export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

const BOOL_VALUES = ['true', 'false'] as const;
const URL_OPCOES = { require_tld: false, require_protocol: true };
const emProducao = (o: EnvironmentVariables) =>
  o.NODE_ENV === NodeEnv.Production;

export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV!: NodeEnv;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT!: number;

  @IsString()
  @IsNotEmpty()
  DB_HOST!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  DB_PORT!: number;

  @IsString()
  @IsNotEmpty()
  DB_USERNAME!: string;

  @IsString()
  @IsNotEmpty()
  DB_PASSWORD!: string;

  @IsString()
  @IsNotEmpty()
  DB_NAME!: string;

  @IsOptional()
  @IsIn(BOOL_VALUES)
  DB_LOGGING?: string;

  @IsOptional()
  @IsIn(BOOL_VALUES)
  DB_RUN_SQL_MIGRATIONS?: string;

  /** Schemas de produto a esperar antes das migrations (CSV; `nenhum`). */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  DB_AGUARDAR_SCHEMAS?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  TZ?: string;

  /**
   * Base dos links dos e-mails (convite, redefinição de senha) e do redirect da
   * confirmação de e-mail. Obrigatória em produção.
   */
  @ValidateIf((o: EnvironmentVariables) => emProducao(o) || !!o.FRONTEND_URL)
  @IsUrl(URL_OPCOES)
  FRONTEND_URL?: string;

  /**
   * Allowlist de CORS (CSV): as origens dos frontends dos produtos. Sem ela,
   * vale o `FRONTEND_URL`. Em produção o CORS nunca abre com a lista vazia.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  FRONTEND_URLS?: string;

  /** URL pública desta API (link de confirmação de e-mail). Obrigatória em produção. */
  @ValidateIf((o: EnvironmentVariables) => emProducao(o) || !!o.API_URL)
  @IsUrl(URL_OPCOES)
  API_URL?: string;

  @IsOptional()
  @IsIn(BOOL_VALUES)
  ENABLE_SWAGGER?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  SWAGGER_USER?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  SWAGGER_PASSWORD?: string;

  @IsOptional()
  @IsIn(BOOL_VALUES)
  TRUST_PROXY?: string;

  // Cookie httpOnly do refresh (`crommos_rt`, path /auth).
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  COOKIE_DOMAIN?: string;

  @IsOptional()
  @IsIn(BOOL_VALUES)
  COOKIE_SECURE?: string;

  @IsOptional()
  @IsIn(['lax', 'strict', 'none'])
  COOKIE_SAMESITE?: string;

  @IsOptional()
  @IsIn(BOOL_VALUES)
  DISABLE_HTTP_COMPRESSION?: string;

  /** Chave privada RS256 (PEM; aceita `\n` escapado). Só a plataforma tem. */
  @IsString()
  @IsNotEmpty()
  PLATAFORMA_JWT_PRIVATE_KEY!: string;

  /** Chave pública RS256 (PEM) — a mesma que os produtos usam para verificar. */
  @IsString()
  @IsNotEmpty()
  PLATAFORMA_JWT_PUBLIC_KEY!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  JWT_EXPIRES_IN?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  JWT_REFRESH_EXPIRES_IN?: string;

  // E-mail transacional (Resend). Sem a chave, stub (loga, não envia).
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  RESEND_API_KEY?: string;

  /** Remetente (`Nome <email@dominio>`, domínio verificado na Resend). */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  EMAIL_FROM?: string;

  /** Dias depois do vencimento até o modo leitura por inadimplência (padrão 7). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(90)
  DIAS_TOLERANCIA_INADIMPLENCIA?: number;

  // AbacatePay (cobrança das faturas). Sem a chave, stub (sem link de pagamento).
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  ABACATEPAY_API_KEY?: string;

  /** Segredo do webhook (`?webhookSecret=`). Obrigatório com a chave. */
  @ValidateIf((o: EnvironmentVariables) => !!o.ABACATEPAY_API_KEY)
  @IsString()
  @MinLength(16, {
    message:
      'ABACATEPAY_WEBHOOK_SECRET (>= 16 caracteres) é obrigatória com ABACATEPAY_API_KEY.',
  })
  ABACATEPAY_WEBHOOK_SECRET?: string;

  @IsOptional()
  @IsUrl(URL_OPCOES)
  ABACATEPAY_API_URL?: string;

  /** Chave da assinatura HMAC do webhook (padrão: a pública da documentação). */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  ABACATEPAY_HMAC_KEY?: string;

  /**
   * Cifra do segredo do 2FA. Sem ela, ligar o 2FA responde 503 (nada
   * vai em claro); o login de quem não usa 2FA segue normal.
   */
  @IsOptional()
  @IsString()
  @MinLength(32, {
    message:
      'DATA_ENCRYPTION_KEY deve ter ao menos 32 caracteres (`openssl rand -hex 32`).',
  })
  DATA_ENCRYPTION_KEY?: string;

  /** Baixa manual de fatura (`X-Plataforma-Key`). Sem ela, a rota é 404. */
  @IsOptional()
  @IsString()
  @MinLength(32)
  PLATAFORMA_API_KEY?: string;

  // Produtos: URL da API + chave de serviço. Os dois, ou nenhum (produto
  // indisponível). A conferência do par fica em `validateEnv`.
  @IsOptional()
  @IsUrl(URL_OPCOES)
  CLINIC_API_URL?: string;

  @IsOptional()
  @IsString()
  @MinLength(32)
  SERVICO_KEY_CLINIC?: string;

  @IsOptional()
  @IsUrl(URL_OPCOES)
  ODONTO_API_URL?: string;

  @IsOptional()
  @IsString()
  @MinLength(32)
  SERVICO_KEY_ODONTO?: string;

  @IsOptional()
  @IsUrl(URL_OPCOES)
  VET_API_URL?: string;

  @IsOptional()
  @IsString()
  @MinLength(32)
  SERVICO_KEY_VET?: string;

  // Chave que a plataforma ENVIA ao produto (provisionamento). Sem ela, vale a
  // SERVICO_KEY_<PRODUTO> (compatível); com ela, cada sentido tem a sua.
  @IsOptional()
  @IsString()
  @MinLength(32)
  PROVISIONAMENTO_KEY_CLINIC?: string;

  @IsOptional()
  @IsString()
  @MinLength(32)
  PROVISIONAMENTO_KEY_ODONTO?: string;

  @IsOptional()
  @IsString()
  @MinLength(32)
  PROVISIONAMENTO_KEY_VET?: string;
}

const falha = (detalhe: string): Error =>
  new Error(`Configuração de ambiente inválida:\n${detalhe}`);

/**
 * Valida `process.env` contra `EnvironmentVariables`. Devolve o objeto
 * convertido ou lança agregando as falhas. Regras além dos decorators: o par
 * de chaves JWT tem de fechar e cada produto vem com URL **e** chave.
 */
export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  // `VAR=` no .env chega como '': tratado como ausente (opcionais podem ficar
  // vazios; obrigatórias vazias continuam falhando).
  const present = Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== ''),
  );
  const validated = plainToInstance(EnvironmentVariables, present, {
    enableImplicitConversion: false,
  });

  const errors = validateSync(validated, {
    skipMissingProperties: false,
    whitelist: false,
  });
  if (errors.length > 0) {
    throw falha(
      errors
        .map((error) => Object.values(error.constraints ?? {}).join(', '))
        .filter(Boolean)
        .join('\n'),
    );
  }

  const erroChaves = erroNoParDeChaves(
    validated.PLATAFORMA_JWT_PRIVATE_KEY,
    validated.PLATAFORMA_JWT_PUBLIC_KEY,
  );
  if (erroChaves) throw falha(erroChaves);

  const v = validated as unknown as Record<string, string | undefined>;
  const chaves: string[] = [];
  for (const p of PRODUTOS.map((x) => x.toUpperCase())) {
    const chave = v[`SERVICO_KEY_${p}`];
    if (!v[`${p}_API_URL`] !== !chave) {
      throw falha(
        `${p}_API_URL e SERVICO_KEY_${p} vão juntas (as duas ou nenhuma).`,
      );
    }
    if (chave) chaves.push(chave);
  }
  // A chave identifica o produto na API interna: não pode repetir.
  if (new Set(chaves).size !== chaves.length) {
    throw falha('Cada produto precisa de uma SERVICO_KEY_* própria.');
  }
  return validated;
}
