import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { Acesso } from 'src/auth/acesso.entity';
import { gerarConfirmacaoEmail } from 'src/auth/tokens';
import {
  criarApp,
  fecharApp,
  limparBanco,
  mailFalso,
  ultimo,
} from './support/app';
import {
  cookieRefresh,
  criarAcesso,
  criarAssinatura,
  criarPessoa,
  SENHA,
} from './support/dados';

/** API interna (produto → plataforma) com `X-Servico-Key`. */
const describeDb =
  process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;

describeDb('API interna de acessos (integração)', () => {
  let app: INestApplication;
  let ds: DataSource;
  const mail = mailFalso();
  const CHAVE = process.env.SERVICO_KEY_CLINIC!;
  const CHAVE_ODONTO = process.env.SERVICO_KEY_ODONTO!;
  const T1 = randomUUID(); // limite 3
  const T2 = randomUUID(); // limite 2, cheio
  const T_SEM = randomUUID(); // sem assinatura (legado): sem limite

  jest.setTimeout(60_000);

  beforeAll(async () => {
    ({ app, ds } = await criarApp(mail));
    await limparBanco(ds);
    await criarAssinatura(ds, { tenantId: T1, numeroUsuarios: 3 });
    await criarAssinatura(ds, { tenantId: T2, numeroUsuarios: 2 });
    const dono = await criarPessoa(ds, { email: 'dono@exemplo.com' });
    await criarAcesso(ds, { usuarioId: dono.id, tenantId: T1 });
    await criarAcesso(ds, { usuarioId: dono.id, tenantId: T2 });
    const outro = await criarPessoa(ds, { email: 'outro@exemplo.com' });
    await criarAcesso(ds, { usuarioId: outro.id, tenantId: T2 });
  });

  afterAll(() => fecharApp(app));
  beforeEach(() => jest.clearAllMocks());

  const interno = (
    metodo: 'post' | 'patch' | 'get',
    rota: string,
    chave: string | null = CHAVE,
  ) => {
    const r = request(app.getHttpServer())[metodo](`/interno${rota}`);
    return chave ? r.set('X-Servico-Key', chave) : r;
  };
  const login = (email: string, tenantId: string, password = SENHA) =>
    request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password, produto: 'clinic', tenantId });

  it('sem chave ou com chave errada → 401', async () => {
    await interno('post', '/acessos', null)
      .send({
        tenantId: T1,
        email: 'x@exemplo.com',
        nome: 'X',
        papel: 'gestor',
      })
      .expect(401);
    await interno('get', `/pessoas/${randomUUID()}`, 'chave-errada').expect(
      401,
    );
  });

  it('pessoa nova: 201 { novo: true }, convite por e-mail; define a senha pelo reset e entra', async () => {
    const res = await interno('post', '/acessos')
      .send({
        tenantId: T1,
        email: 'Nova@Exemplo.com',
        nome: 'Nova',
        papel: 'recepcao',
      })
      .expect(201);
    expect(res.body).toEqual({ usuarioId: expect.any(String), novo: true });
    expect(mail.sendConvite).toHaveBeenCalledWith(
      'nova@exemplo.com',
      'Nova',
      expect.any(String),
      'clinic',
    );
    const acesso = await ds.getRepository(Acesso).findOneByOrFail({
      usuarioId: res.body.usuarioId,
    });
    expect(acesso).toMatchObject({
      produto: 'clinic',
      tenantId: T1,
      papel: 'recepcao',
      ativo: true,
      convitePendente: true,
    });

    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token: ultimo(mail.sendConvite, 2), password: 'minha-senha-1' })
      .expect(204);
    const l = await login('nova@exemplo.com', T1, 'minha-senha-1').expect(200);
    expect(l.body.acesso.papel).toBe('recepcao');
    const depois = await ds
      .getRepository(Acesso)
      .findOneByOrFail({ id: acesso.id });
    expect(depois.convitePendente).toBe(false);
  });

  it('pessoa que já tem senha: 201 { novo: false }, sem e-mail; entra com a senha que tem', async () => {
    const res = await interno('post', '/acessos')
      .send({
        tenantId: T1,
        email: 'outro@exemplo.com',
        nome: 'Outro',
        papel: 'financeiro',
      })
      .expect(201);
    expect(res.body.novo).toBe(false);
    expect(mail.sendConvite).not.toHaveBeenCalled();
    const l = await login('outro@exemplo.com', T1).expect(200);
    expect(l.body.acesso).toEqual({
      produto: 'clinic',
      tenantId: T1,
      papel: 'financeiro',
    });
  });

  it('409: já tem acesso neste tenant; limite de usuários da assinatura', async () => {
    const dup = await interno('post', '/acessos')
      .send({
        tenantId: T1,
        email: 'DONO@exemplo.com',
        nome: 'Dono',
        papel: 'admin',
      })
      .expect(409);
    expect(dup.body.message).toBe('Esta pessoa já tem acesso a esta clínica.');
    const cheio = await interno('post', '/acessos')
      .send({
        tenantId: T2,
        email: 'mais@exemplo.com',
        nome: 'Mais',
        papel: 'gestor',
      })
      .expect(409);
    expect(cheio.body.message).toMatch(/Limite de 2 usuário/);
    // Nada ficou gravado (a pessoa nova também não).
    const [{ n }] = await ds.query(
      `SELECT count(*)::int AS n FROM crommos.usuarios WHERE email = 'mais@exemplo.com'`,
    );
    expect(n).toBe(0);
  });

  it('tenant sem assinatura (legado) não tem limite; o produto vem da chave', async () => {
    const res = await interno('post', '/acessos', CHAVE_ODONTO)
      .send({
        tenantId: T_SEM,
        email: 'vet@exemplo.com',
        nome: 'Vera',
        papel: 'admin',
      })
      .expect(201);
    const acesso = await ds
      .getRepository(Acesso)
      .findOneByOrFail({ usuarioId: res.body.usuarioId });
    expect(acesso.produto).toBe('odonto');
  });

  it('PATCH: papel; desativar revoga as sessões do tenant (não as de outro); reativar respeita o limite', async () => {
    const p = await criarPessoa(ds, { email: 'patch@exemplo.com' });
    await criarAcesso(ds, { usuarioId: p.id, tenantId: T1, papel: 'gestor' });
    await criarAcesso(ds, { usuarioId: p.id, tenantId: T_SEM });
    const s1 = await login('patch@exemplo.com', T1).expect(200);
    const s2 = await login('patch@exemplo.com', T_SEM).expect(200);

    const papel = await interno('patch', '/acessos')
      .send({ tenantId: T1, usuarioId: p.id, papel: 'admin' })
      .expect(200);
    expect(papel.body).toMatchObject({ papel: 'admin', ativo: true });

    await interno('patch', '/acessos')
      .send({ tenantId: T1, usuarioId: p.id, ativo: false })
      .expect(200);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', cookieRefresh(s1.headers))
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', cookieRefresh(s2.headers))
      .expect(200);
    await login('patch@exemplo.com', T1).expect(401);

    // T1 tem limite 3: dono, nova, outro → cheio; reativar → 409.
    const cheio = await interno('patch', '/acessos')
      .send({ tenantId: T1, usuarioId: p.id, ativo: true })
      .expect(409);
    expect(cheio.body.message).toMatch(/Limite de 3/);
    await ds.query(
      `UPDATE crommos.assinaturas SET numero_usuarios = 4 WHERE tenant_id = $1`,
      [T1],
    );
    await interno('patch', '/acessos')
      .send({ tenantId: T1, usuarioId: p.id, ativo: true })
      .expect(200);
    await login('patch@exemplo.com', T1).expect(200);

    await interno('patch', '/acessos')
      .send({ tenantId: T1, usuarioId: randomUUID(), ativo: false })
      .expect(404);
    await interno('patch', '/acessos')
      .send({ tenantId: T1, usuarioId: p.id, papel: 'Admin!' })
      .expect(400);
  });

  it('reenviar convite: 204 com link novo enquanto pendente; 409 depois de definir a senha', async () => {
    const res = await interno('post', '/acessos')
      .send({
        tenantId: T_SEM,
        email: 'reenvio@exemplo.com',
        nome: 'Rita',
        papel: 'gestor',
      })
      .expect(201);
    const primeiro = ultimo(mail.sendConvite, 2);
    await interno('post', '/acessos/reenviar-convite')
      .send({ tenantId: T_SEM, usuarioId: res.body.usuarioId })
      .expect(204);
    const segundo = ultimo(mail.sendConvite, 2);
    expect(segundo).not.toBe(primeiro);
    // O link anterior deixou de valer.
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token: primeiro, password: 'minha-senha-1' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token: segundo, password: 'minha-senha-1' })
      .expect(204);
    await interno('post', '/acessos/reenviar-convite')
      .send({ tenantId: T_SEM, usuarioId: res.body.usuarioId })
      .expect(409);
    await interno('post', '/acessos/reenviar-convite')
      .send({ tenantId: T_SEM, usuarioId: randomUUID() })
      .expect(404);
  });

  it('convite registrado mas e-mail falhou → 503; o acesso fica (reenviar resolve)', async () => {
    mail.sendConvite.mockRejectedValueOnce(new Error('smtp'));
    await interno('post', '/acessos')
      .send({
        tenantId: T_SEM,
        email: 'falhou@exemplo.com',
        nome: 'Falhou',
        papel: 'gestor',
      })
      .expect(503);
    const [{ n }] = await ds.query(
      `SELECT count(*)::int AS n FROM crommos.acessos a
         JOIN crommos.usuarios u ON u.id = a.usuario_id
        WHERE u.email = 'falhou@exemplo.com' AND a.convite_pendente`,
    );
    expect(n).toBe(1);
  });

  it('GET /pessoas/:id: dados e emailConfirmado; 404 fora do produto da chave', async () => {
    const { campos } = gerarConfirmacaoEmail();
    const p = await criarPessoa(ds, {
      email: 'pessoa@exemplo.com',
      nome: 'Pessoa',
      ...campos,
    });
    await criarAcesso(ds, { usuarioId: p.id, tenantId: T_SEM });
    const res = await interno('get', `/pessoas/${p.id}`).expect(200);
    expect(res.body).toEqual({
      id: p.id,
      nome: 'Pessoa',
      email: 'pessoa@exemplo.com',
      emailConfirmado: false,
    });
    await interno('get', `/pessoas/${p.id}`, CHAVE_ODONTO).expect(404);
    await interno('get', `/pessoas/${randomUUID()}`).expect(404);
    await interno('get', '/pessoas/nao-uuid').expect(400);
  });
});
