import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  criarApp,
  fecharApp,
  limparBanco,
  mailFalso,
  ultimo,
} from './support/app';
import { criarAcesso, criarAssinatura, criarPessoa } from './support/dados';

/**
 * Tokens dos e-mails (sugestões da rodada 2 de QA): a página do front valida o
 * link ao abrir (`GET /auth/verificar-token`) e o aceite de convite é por botão
 * (`POST /auth/aceitar-convite`); o GET antigo só redireciona.
 */
const describeDb =
  process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;

describeDb('Tokens de e-mail (integração)', () => {
  let app: INestApplication;
  let ds: DataSource;
  const mail = mailFalso();
  const CHAVE = process.env.SERVICO_KEY_CLINIC!;
  const T = randomUUID();

  jest.setTimeout(60_000);

  beforeAll(async () => {
    ({ app, ds } = await criarApp(mail));
    await limparBanco(ds);
    await criarAssinatura(ds, { tenantId: T, tenantNome: 'Clínica Sol' });
    const dono = await criarPessoa(ds, { email: 'dono@tok.com' });
    await criarAcesso(ds, { usuarioId: dono.id, tenantId: T });
  });

  afterAll(() => fecharApp(app));
  beforeEach(() => jest.clearAllMocks());

  const srv = () => app.getHttpServer();
  const verificar = (tipo: string, token: string) =>
    request(srv())
      .get('/auth/verificar-token')
      .query({ tipo, token })
      .expect(200)
      .then((r) => r.body as Record<string, unknown>);
  const convidar = (email: string) =>
    request(srv())
      .post('/interno/acessos')
      .set('X-Servico-Key', CHAVE)
      .send({ tenantId: T, email, nome: 'Convidada', papel: 'recepcao' })
      .expect(201);

  it('definir-senha: válido com e-mail e clínica; depois de usado, inválido', async () => {
    await convidar('nova@tok.com');
    const token = ultimo(mail.sendConvite, 2);
    expect(await verificar('definir-senha', token)).toEqual({
      valido: true,
      email: 'nova@tok.com',
      clinicaNome: 'Clínica Sol',
    });
    await request(srv())
      .post('/auth/reset-password')
      .send({ token, password: 'minha-senha-1' })
      .expect(204);
    expect(await verificar('definir-senha', token)).toEqual({
      valido: false,
      motivo: 'invalido',
    });
  });

  it('redefinir-senha: válido sem clínica; expirado; token desconhecido', async () => {
    await request(srv())
      .post('/auth/forgot-password')
      .send({ email: 'dono@tok.com' })
      .expect(202);
    const token = ultimo(mail.sendPasswordReset, 1);
    expect(await verificar('redefinir-senha', token)).toEqual({
      valido: true,
      email: 'dono@tok.com',
      clinicaNome: null,
    });
    await ds.query(
      `UPDATE crommos.usuarios SET password_reset_expires_at = now() - interval '1 minute'
        WHERE email = 'dono@tok.com'`,
    );
    expect(await verificar('redefinir-senha', token)).toEqual({
      valido: false,
      motivo: 'expirado',
    });
    expect(await verificar('redefinir-senha', 'nao-existe')).toEqual({
      valido: false,
      motivo: 'invalido',
    });
  });

  it('parâmetros inválidos → 400', async () => {
    await request(srv())
      .get('/auth/verificar-token')
      .query({ tipo: 'outro', token: 'x' })
      .expect(400);
    await request(srv())
      .get('/auth/verificar-token')
      .query({ tipo: 'definir-senha' })
      .expect(400);
  });

  it('aceitar-convite: verificar, aceitar por POST (200), reaceitar (409), usado; GET só redireciona', async () => {
    const quem = await criarPessoa(ds, { email: 'ja@tok.com' });
    await criarAcesso(ds, { usuarioId: quem.id, tenantId: randomUUID() });
    await convidar('ja@tok.com');
    const token = ultimo(mail.sendConviteAceite, 2);

    // O GET antigo não aceita mais sozinho: leva à página do front.
    const get = await request(srv())
      .get(`/auth/aceitar-convite?token=${token}`)
      .expect(302);
    expect(get.headers.location).toBe(
      `http://localhost:5173/aceitar-convite?token=${token}`,
    );
    expect(await verificar('aceitar-convite', token)).toEqual({
      valido: true,
      email: 'ja@tok.com',
      clinicaNome: 'Clínica Sol',
    });

    const ok = await request(srv())
      .post('/auth/aceitar-convite')
      .send({ token })
      .expect(200);
    expect(ok.body).toEqual({ clinicaNome: 'Clínica Sol' });
    const [{ pendente }] = await ds.query(
      `SELECT convite_pendente AS pendente FROM crommos.acessos
        WHERE usuario_id = $1 AND tenant_id = $2`,
      [quem.id, T],
    );
    expect(pendente).toBe(false);

    const deNovo = await request(srv())
      .post('/auth/aceitar-convite')
      .send({ token })
      .expect(409);
    expect(deNovo.body).toMatchObject({ code: 'CONVITE_JA_ACEITO' });
    expect(await verificar('aceitar-convite', token)).toEqual({
      valido: false,
      motivo: 'usado',
    });
  });

  it('aceitar-convite: desconhecido, expirado ou cancelado → 400 CONVITE_INVALIDO', async () => {
    const r = await request(srv())
      .post('/auth/aceitar-convite')
      .send({ token: 'nao-existe' })
      .expect(400);
    expect(r.body).toMatchObject({ code: 'CONVITE_INVALIDO' });

    const quem = await criarPessoa(ds, { email: 'exp@tok.com' });
    await criarAcesso(ds, { usuarioId: quem.id, tenantId: randomUUID() });
    await convidar('exp@tok.com');
    const token = ultimo(mail.sendConviteAceite, 2);
    await ds.query(
      `UPDATE crommos.acessos SET convite_expira_em = now() - interval '1 minute'
        WHERE usuario_id = $1 AND tenant_id = $2`,
      [quem.id, T],
    );
    expect(await verificar('aceitar-convite', token)).toEqual({
      valido: false,
      motivo: 'expirado',
    });
    const exp = await request(srv())
      .post('/auth/aceitar-convite')
      .send({ token })
      .expect(400);
    expect(exp.body.code).toBe('CONVITE_INVALIDO');

    await ds.query(
      `UPDATE crommos.acessos SET ativo = false, convite_expira_em = now() + interval '1 day'
        WHERE usuario_id = $1 AND tenant_id = $2`,
      [quem.id, T],
    );
    expect(await verificar('aceitar-convite', token)).toEqual({
      valido: false,
      motivo: 'invalido',
    });
    await request(srv()).post('/auth/aceitar-convite').send({}).expect(400);
  });
});
