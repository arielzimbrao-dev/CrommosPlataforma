import { NextFunction, Request, Response } from 'express';

/**
 * Basic Auth mínimo para proteger uma rota administrativa (ex.: Swagger UI em
 * produção). Não é o mecanismo de auth da API — é só um portão para não expor o
 * schema publicamente. Credenciais vêm de env.
 *
 * ponytail: comparação de string direta basta para um portão de docs; não vale
 * timing-safe aqui (não protege segredo de usuário).
 */
export function basicAuth(
  expectedUser: string,
  expectedPass: string,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
      if (user === expectedUser && pass === expectedPass) {
        next();
        return;
      }
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="API Docs"');
    res.status(401).send('Autenticação necessária.');
  };
}
