import { createServer, IncomingHttpHeaders, Server } from 'node:http';
import { AddressInfo } from 'node:net';

export interface ChamadaStub {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

/**
 * API de produto falsa (servidor HTTP local) para o provisionamento do
 * signup: registra as chamadas e responde com `status` (mutável no teste).
 */
export class ProdutoStub {
  status = 201;
  readonly chamadas: ChamadaStub[] = [];
  private server!: Server;

  async iniciar(): Promise<string> {
    this.server = createServer((req, res) => {
      let dados = '';
      req.on('data', (c: Buffer) => (dados += c.toString()));
      req.on('end', () => {
        this.chamadas.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body: dados ? JSON.parse(dados) : undefined,
        });
        res.statusCode = this.status;
        res.end();
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  fechar(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }
}
