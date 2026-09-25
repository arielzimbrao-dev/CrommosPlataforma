import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { IsPublic } from '../../auth/decorators/is-public.decorator';

export interface HealthStatus {
  status: 'ok';
  service: 'plataforma-api';
}

/**
 * Health check da aplicação.
 *
 * Intencionalmente NÃO depende de banco de dados: o endpoint precisa responder
 * para o healthcheck do Coolify/Docker mesmo quando o DB ainda está conectando.
 * Quando houver checagens de dependências (DB, cache, etc.), adicionar um
 * endpoint separado (ex.: /health/ready) sem alterar este liveness probe.
 */
@ApiTags('System')
@Controller('health')
// Público: liveness probe do Coolify/Docker roda sem token e sem tenant
// (@IsPublic cobre o JwtAuthGuard e o TenantGuard).
@IsPublic()
export class HealthController {
  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Health check',
    description: 'Liveness probe. Retorna o status da API sem tocar no banco.',
  })
  @ApiResponse({
    status: 200,
    description: 'API no ar',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ok'] },
        service: { type: 'string', enum: ['plataforma-api'] },
      },
    },
  })
  getHealth(): HealthStatus {
    return { status: 'ok', service: 'plataforma-api' };
  }
}
