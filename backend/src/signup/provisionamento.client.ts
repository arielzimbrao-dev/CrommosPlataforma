import { Injectable } from '@nestjs/common';
import type { ConfigProduto } from '../common/produtos';

/** Corpo do `POST {produto}/interno/tenants` (docs/contrato.md). */
export interface NovoTenant {
  tenantId: string;
  codigo: string;
  nomeClinica: string;
  cnpj?: string;
  nomeUnidade: string;
  admin: { usuarioId: string; nome: string; email: string };
}

const TIMEOUT_MS = 15_000;

/**
 * Pede ao produto que crie o tenant (clínica, 1ª unidade, vínculo admin). O
 * produto é idempotente por `tenantId`. Lança em erro de rede, timeout ou
 * status fora de 2xx — a mensagem não carrega o corpo (pode ter PII).
 */
@Injectable()
export class ProvisionamentoClient {
  async criarTenant(cfg: ConfigProduto, corpo: NovoTenant): Promise<void> {
    const res = await fetch(`${cfg.apiUrl}/interno/tenants`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Servico-Key': cfg.chaveServico,
      },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`provisionamento ${cfg.produto}: HTTP ${res.status}`);
    }
  }
}
