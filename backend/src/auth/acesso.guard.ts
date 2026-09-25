import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Repository } from 'typeorm';
import { ITokenPayload } from '../common/interfaces/token-payload.interface';
import { Acesso } from './acesso.entity';
import { EXIGE_ACESSO_KEY } from './decorators/exige-acesso.decorator';

/**
 * `@ExigeAcesso(...papeis)`: lê o acesso da pessoa ao tenant do token a cada
 * requisição (desativar vale na hora). Sem acesso ativo → 401; papel fora da
 * lista → 403. Rotas sem o decorator passam. Registrado como APP_GUARD depois
 * do JwtAuthGuard.
 */
@Injectable()
export class AcessoGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject('ACESSO_REPOSITORY') private readonly acessos: Repository<Acesso>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const papeis = this.reflector.getAllAndOverride<string[] | undefined>(
      EXIGE_ACESSO_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!papeis) return true;

    const req = context
      .switchToHttp()
      .getRequest<{ user?: ITokenPayload; acesso?: Acesso }>();
    const user = req.user;
    const acesso = user
      ? await this.acessos.findOne({
          where: {
            usuarioId: user.sub,
            produto: user.produto,
            tenantId: user.tenantId,
            ativo: true,
          },
        })
      : null;
    if (!acesso) throw new UnauthorizedException('Acesso inativo.');
    if (papeis.length > 0 && !papeis.includes(acesso.papel)) {
      throw new ForbiddenException('Acesso negado para o seu perfil.');
    }
    req.acesso = acesso;
    return true;
  }
}
