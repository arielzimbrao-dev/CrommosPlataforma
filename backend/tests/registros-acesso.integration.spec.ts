import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  AuditService,
  RETENCAO_REGISTROS_ACESSO_DIAS,
} from 'src/audit/audit.service';
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

/**
 * L-24 (Marco Civil, art. 15): login (sucesso e falha), logout, refresh e
 * troca de senha ficam em `crommos.auditoria` com IP, navegador e data/hora;
 * o admin da clínica vê os da equipe (90 dias); a purga apaga o que passou
 * da retenção.
 */
const describeDb =
  process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;

const UA = 'Mozilla/5.0 (Teste L-24)';

describeDb('Registros de acesso (integração)', () => {
  let app: INestApplication;
  let ds: DataSource;
  const T1 = randomUUID();
  const T2 = randomUUID();
  const mail = mailFalso();
  let adminId: string;
  let equipeId: string;
  let foraId: string;

  jest.setTimeout(60_000);

  beforeAll(async () => {
    ({ app, ds } = await criarApp(mail));
    await limparBanco(ds);
    await criarAssinatura(ds, { tenantId: T1 });
    await criarAssinatura(ds, { tenantId: T2 });
    adminId = (await criarPessoa(ds, { email: 'adm@l24.com', nome: 'Adm' })).id;
    equipeId = (await criarPessoa(ds, { email: 'eq@l24.com', nome: 'Eq' })).id;
    foraId = (await criarPessoa(ds, { email: 'fora@l24.com', nome: 'Fora' }))
      .id;
    await criarAcesso(ds, { usuarioId: adminId, tenantId: T1 });
    await criarAcesso(ds, {
      usuarioId: equipeId,
      tenantId: T1,
      papel: 'recepcao',
    });
    await criarAcesso(ds, { usuarioId: foraId, tenantId: T2 });
  });

  afterAll(() => fecharApp(app));

  const entrar = (email: string, password = SENHA) =>
    request(app.getHttpServer())
      .post('/auth/login')
      .set('User-Agent', UA)
      .send({ email, password, produto: 'clinic' });

  const registros = (usuarioId: string) =>
    ds.query<
      {
        action: string;
        ip: string | null;
        user_agent: string | null;
        tenant_id: string | null;
      }[]
    >(
      `SELECT action, ip, user_agent, tenant_id FROM crommos.auditoria
        WHERE usuario_id = $1 AND resource = 'auth' ORDER BY created_at`,
      [usuarioId],
    );

  it('grava login, falha, refresh, troca de senha e logout com IP e navegador', async () => {
    await entrar('eq@l24.com', 'senha-errada-1').expect(401);
    const r = await entrar('eq@l24.com').expect(200);
    const cookie = cookieRefresh(r.headers);
    const r2 = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('User-Agent', UA)
      .set('Cookie', cookie)
      .expect(200);
    const r3 = await request(app.getHttpServer())
      .post('/auth/trocar-senha')
      .set('User-Agent', UA)
      .set('Authorization', `Bearer ${r2.body.accessToken as string}`)
      .send({ senhaAtual: SENHA, novaSenha: SENHA })
      .expect(200);
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('User-Agent', UA)
      .set('Cookie', cookieRefresh(r3.headers))
      .expect(204);

    const linhas = await registros(equipeId);
    expect(linhas.map((l) => l.action)).toEqual([
      'login-falha',
      'login',
      'refresh',
      'trocar-senha',
      'logout',
    ]);
    for (const l of linhas) {
      expect(l.ip).toMatch(/127\.0\.0\.1|::1/);
      expect(l.user_agent).toBe(UA);
    }
    // Falha sem clínica escolhida: sem tenant (o admin vê pela equipe).
    expect(linhas[0].tenant_id).toBeNull();
    expect(linhas[1].tenant_id).toBe(T1);
  });

  it('e-mail desconhecido: falha gravada sem pessoa, só com IP', async () => {
    await entrar('ninguem@l24.com', 'senha-errada-1').expect(401);
    const [l] = await ds.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM crommos.auditoria
        WHERE action = 'login-falha' AND usuario_id IS NULL AND ip IS NOT NULL`,
    );
    expect(l.n).toBe(1);
  });

  it('GET /auth/acessos: admin vê a equipe (90 dias, filtro por pessoa); outra clínica e outros papéis não', async () => {
    await entrar('fora@l24.com').expect(200);
    await ds.query(
      `INSERT INTO crommos.auditoria (usuario_id, produto, tenant_id, action, resource, ip, created_at)
       VALUES ($1, 'clinic', $2, 'login', 'auth', '10.0.0.1', now() - interval '91 days')`,
      [equipeId, T1],
    );
    const adm = await entrar('adm@l24.com').expect(200);
    const auth = `Bearer ${adm.body.accessToken as string}`;

    const r = await request(app.getHttpServer())
      .get('/auth/acessos')
      .set('Authorization', auth)
      .expect(200);
    const pessoas = new Set(
      (r.body.data as { usuarioId: string }[]).map((d) => d.usuarioId),
    );
    expect(pessoas.has(equipeId)).toBe(true);
    expect(pessoas.has(adminId)).toBe(true);
    expect(pessoas.has(foraId)).toBe(false);
    expect(r.body.total).toBe(r.body.data.length);
    expect(r.body.data[0]).toMatchObject({
      usuarioId: adminId,
      acao: 'login',
      navegador: UA,
    });
    expect(r.body.data[0].ip).toBeTruthy();
    expect(r.body.data[0].em).toBeTruthy();
    const ips = (r.body.data as { ip: string }[]).map((d) => d.ip);
    expect(ips).not.toContain('10.0.0.1'); // mais de 90 dias

    const soEquipe = await request(app.getHttpServer())
      .get(`/auth/acessos?usuarioId=${equipeId}&limit=2`)
      .set('Authorization', auth)
      .expect(200);
    expect(soEquipe.body.data).toHaveLength(2);
    expect(soEquipe.body.total).toBe(5);
    expect(
      (soEquipe.body.data as { usuarioId: string }[]).every(
        (d) => d.usuarioId === equipeId,
      ),
    ).toBe(true);

    const eq = await entrar('eq@l24.com').expect(200);
    await request(app.getHttpServer())
      .get('/auth/acessos')
      .set('Authorization', `Bearer ${eq.body.accessToken as string}`)
      .expect(403);
  });

  it('QA-206: redefinir a senha pelo link grava IP, navegador e a clínica (o admin vê)', async () => {
    await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email: 'eq@l24.com' })
      .expect(202);
    const token = ultimo(mail.sendPasswordReset, 1);
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .set('User-Agent', UA)
      .send({ token, password: SENHA })
      .expect(204);
    const l = (await registros(equipeId)).find(
      (x) => x.action === 'redefinir-senha',
    );
    expect(l).toMatchObject({ user_agent: UA, tenant_id: T1 });
    expect(l?.ip).toMatch(/127\.0\.0\.1|::1/);

    const adm = await entrar('adm@l24.com').expect(200);
    const r = await request(app.getHttpServer())
      .get(`/auth/acessos?usuarioId=${equipeId}`)
      .set('Authorization', `Bearer ${adm.body.accessToken as string}`)
      .expect(200);
    expect(r.body.data[0]).toMatchObject({ acao: 'redefinir-senha' });
  });

  it('QA-211: a lista diz de quem o admin desligou o 2FA (alvoId)', async () => {
    await ds.query(
      `INSERT INTO crommos.auditoria (usuario_id, produto, tenant_id, action, resource, resource_id)
       VALUES ($1, 'clinic', $2, '2fa-desligado-pelo-admin', 'auth', $3)`,
      [adminId, T1, equipeId],
    );
    const adm = await entrar('adm@l24.com').expect(200);
    const r = await request(app.getHttpServer())
      .get(`/auth/acessos?usuarioId=${adminId}&limit=1`)
      .set('Authorization', `Bearer ${adm.body.accessToken as string}`)
      .expect(200);
    expect(r.body.data[0]).toMatchObject({
      acao: 'login',
      alvoId: null,
    });
    const r2 = await request(app.getHttpServer())
      .get(`/auth/acessos?usuarioId=${adminId}`)
      .set('Authorization', `Bearer ${adm.body.accessToken as string}`)
      .expect(200);
    expect(
      (r2.body.data as { acao: string; alvoId: string | null }[]).find(
        (d) => d.acao === '2fa-desligado-pelo-admin',
      )?.alvoId,
    ).toBe(equipeId);
  });

  it(`purga: apaga os registros de acesso com mais de ${RETENCAO_REGISTROS_ACESSO_DIAS} dias; o resto fica`, async () => {
    await ds.query(
      `INSERT INTO crommos.auditoria (usuario_id, action, resource, created_at) VALUES
         ($1, 'login', 'auth', now() - interval '400 days'),
         ($1, 'login', 'auth', now() - interval '200 days'),
         ($1, 'alterar', 'assinatura', now() - interval '400 days')`,
      [foraId],
    );
    const n = await app.get(AuditService).purgarRegistrosAcesso();
    expect(n).toBe(1);
    const [{ velhos }] = await ds.query<{ velhos: number }[]>(
      `SELECT count(*)::int AS velhos FROM crommos.auditoria
        WHERE usuario_id = $1 AND created_at < now() - interval '100 days'`,
      [foraId],
    );
    expect(velhos).toBe(2);
  });
});
