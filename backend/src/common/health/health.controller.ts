import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { IsPublic } from '../../auth/decorators/is-public.decorator';

export interface HealthStatus {
  status: 'ok';
  service: 'plataforma-api';
}

/**
 * Liveness: não depende do banco, para o healthcheck do Coolify/Docker
 * responder mesmo com o banco ainda conectando. O banco fica no `/health/ready`.
 */
@ApiTags('System')
@Controller('health')
// Público: liveness probe do Coolify/Docker roda sem token e sem tenant
// (@IsPublic cobre o JwtAuthGuard e o TenantGuard).
@IsPublic()
export class HealthController {
  constructor(
    @Optional() @Inject('DATA_SOURCE') private readonly ds?: DataSource,
  ) {}

  /**
   * Readiness: a API consegue falar com o banco (`SELECT 1`). 503 enquanto
   * não consegue — o proxy do Coolify tira a réplica da rotação.
   */
  @Get('ready')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Readiness (confere o banco)' })
  async ready(): Promise<{ status: 'ok'; banco: 'ok' }> {
    try {
      await this.ds!.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException('Banco indisponível.');
    }
    return { status: 'ok', banco: 'ok' };
  }

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
