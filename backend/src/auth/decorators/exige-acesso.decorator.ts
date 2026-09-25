import { SetMetadata } from '@nestjs/common';

/** Chave de metadado lida pelo AcessoGuard. */
export const EXIGE_ACESSO_KEY = 'exigeAcesso';

/** Papéis que a plataforma distingue (o resto é do produto). */
export const PAPEL_ADMIN = 'admin';
export const PAPEL_FINANCEIRO = 'financeiro';

/**
 * Exige acesso **ativo** da pessoa ao tenant do token (401 sem ele) e, se
 * informados, um dos papéis (403). Sem papéis = qualquer acesso ativo.
 */
export const ExigeAcesso = (
  ...papeis: string[]
): MethodDecorator & ClassDecorator => SetMetadata(EXIGE_ACESSO_KEY, papeis);
