import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  Produto,
  produtoDaChave,
  produtosDisponiveis,
} from '../common/produtos';

interface RequisicaoServico {
  headers: Record<string, string | string[] | undefined>;
  produtoServico?: Produto;
}

/**
 * API interna (serviço → serviço): `X-Servico-Key` identifica o produto
 * (comparação em tempo constante). Sem nenhuma chave configurada, as rotas
 * não existem (404); chave ausente ou errada → 401. O produto vem da chave,
 * nunca do corpo.
 */
@Injectable()
export class ServicoKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (produtosDisponiveis().length === 0) throw new NotFoundException();
    const req = context.switchToHttp().getRequest<RequisicaoServico>();
    const chave = req.headers['x-servico-key'];
    const produto = typeof chave === 'string' ? produtoDaChave(chave) : null;
    if (!produto) {
      throw new UnauthorizedException('Chave de serviço inválida.');
    }
    req.produtoServico = produto;
    return true;
  }
}

/** Produto autenticado pelo ServicoKeyGuard — exportada para teste direto. */
export const produtoServicoFactory = (
  _data: unknown,
  ctx: ExecutionContext,
): Produto =>
  ctx.switchToHttp().getRequest<RequisicaoServico>().produtoServico as Produto;

export const ProdutoServico = createParamDecorator(produtoServicoFactory);
