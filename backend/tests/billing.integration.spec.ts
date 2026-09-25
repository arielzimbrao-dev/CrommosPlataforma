import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { Acesso } from 'src/auth/acesso.entity';
import { hojeISO } from 'src/common/data-brasil';
import { MODULE_CODES } from 'src/billing/modules.catalog';
import { criarApp, fecharApp, limparBanco, mailFalso } from './support/app';
import {
  criarAcesso,
  criarAssinatura,
  criarPessoa,
  SENHA,
} from './support/dados';

/**
 * Assinatura ponta a ponta: papel pelo acesso (admin altera, admin/financeiro
 * leem), pró-rata, limite de usuários, faturas e baixa pelo backoffice.
 */
const describeDb =
  process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;

describeDb('Billing (integração)', () => {
  let app: INestApplication;
  let ds: DataSource;
  const T = randomUUID();
  const T_OUTRO = randomUUID();
  const CHAVE = process.env.PLATAFORMA_API_KEY!;
  const tokens: Record<string, string> = {};

  jest.setTimeout(60_000);

  beforeAll(async () => {
    ({ app, ds } = await criarApp(mailFalso()));
    await limparBanco(ds);
    // Ciclo corrente começando hoje: pró-rata do ciclo inteiro.
    const hoje = hojeISO();
    const fim = new Date(`${hoje}T00:00:00Z`);
    fim.setUTCMonth(fim.getUTCMonth() + 1);
    await criarAssinatura(ds, {
      tenantId: T,
      modulosAtivos: ['agenda'] as never,
      numeroUsuarios: 3,
      cicloInicio: hoje,
      cicloFim: fim.toISOString().slice(0, 10),
    });
    await criarAssinatura(ds, { tenantId: T_OUTRO, numeroUsuarios: 9 });
    for (const papel of ['admin', 'financeiro', 'gestor']) {
      const p = await criarPessoa(ds, { email: `${papel}@bill.com` });
      await criarAcesso(ds, { usuarioId: p.id, tenantId: T, papel });
      const l = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: `${papel}@bill.com`,
          password: SENHA,
          produto: 'clinic',
        })
        .expect(200);
      tokens[papel] = l.body.accessToken as string;
    }
  });

  afterAll(() => fecharApp(app));

  const como = (papel: string) => ({
    Authorization: `Bearer ${tokens[papel]}`,
  });
  const http = () => request(app.getHttpServer());

  it('GET /modulos: qualquer acesso ativo; sem token → 401', async () => {
    const res = await http().get('/modulos').set(como('gestor')).expect(200);
    expect(res.body.ativos).toEqual(['agenda']);
    expect(res.body.catalogo.map((m: { code: string }) => m.code)).toEqual(
      MODULE_CODES,
    );
    await http().get('/modulos').expect(401);
  });

  it('leitura: admin e financeiro; gestor → 403', async () => {
    for (const papel of ['admin', 'financeiro']) {
      const a = await http().get('/assinatura').set(como(papel)).expect(200);
      expect(a.body).toMatchObject({
        modulosAtivos: ['agenda'],
        numeroUsuarios: 3,
        valor: 90,
      });
      await http().get('/assinatura/faturas').set(como(papel)).expect(200);
      await http()
        .post('/assinatura/simular')
        .set(como(papel))
        .send({ modulos: ['agenda'], numeroUsuarios: 3, plano: 'mensal' })
        .expect(201);
    }
    await http().get('/assinatura').set(como('gestor')).expect(403);
    await http().get('/assinatura/faturas').set(como('gestor')).expect(403);
  });

  it('PATCH: só admin; upgrade gera fatura complementar (pró-rata do ciclo inteiro) e audita', async () => {
    for (const papel of ['financeiro', 'gestor']) {
      await http()
        .patch('/assinatura')
        .set(como(papel))
        .send({ numeroUsuarios: 6 })
        .expect(403);
    }
    const sim = await http()
      .post('/assinatura/simular')
      .set(como('admin'))
      .send({ modulos: ['agenda'], numeroUsuarios: 6, plano: 'mensal' })
      .expect(201);
    expect(sim.body).toMatchObject({
      valor: 180,
      ajuste: { tipo: 'complementar', valor: 90 },
    });
    const res = await http()
      .patch('/assinatura')
      .set(como('admin'))
      .send({ numeroUsuarios: 6 })
      .expect(200);
    expect(res.body.ajuste).toMatchObject({ tipo: 'complementar', valor: 90 });
    expect(res.body.fatura).toMatchObject({
      tipo: 'complementar',
      valorLiquido: 90,
      status: 'pendente',
    });
    const [{ n }] = await ds.query(
      `SELECT count(*)::int AS n FROM crommos.auditoria
        WHERE tenant_id = $1 AND resource = 'assinatura' AND action = 'update'`,
      [T],
    );
    expect(n).toBe(1);
  });

  it('redução sem pagar a complementar cancela a fatura e não gera crédito', async () => {
    const res = await http()
      .patch('/assinatura')
      .set(como('admin'))
      .send({ numeroUsuarios: 3 })
      .expect(200);
    expect(res.body.ajuste).toMatchObject({ tipo: 'credito', valor: 90 });
    expect(res.body.saldoCredito).toBe(0);
    const lista = await http()
      .get('/assinatura/faturas')
      .set(como('financeiro'))
      .expect(200);
    expect(lista.body.data[0]).toMatchObject({
      tipo: 'complementar',
      status: 'cancelada',
      valorBruto: 0,
    });
  });

  it('não reduz abaixo dos acessos ativos (convites pendentes contam) → 409', async () => {
    await http()
      .patch('/assinatura')
      .set(como('admin'))
      .send({ numeroUsuarios: 2 })
      .expect(409);
    await http()
      .patch('/assinatura')
      .set(como('admin'))
      .send({ numeroUsuarios: 4 })
      .expect(200);
    const convidado = await criarPessoa(ds, { email: 'convite@bill.com' });
    await criarAcesso(ds, {
      usuarioId: convidado.id,
      tenantId: T,
      papel: 'recepcao',
      convitePendente: true,
    });
    const r = await http()
      .patch('/assinatura')
      .set(como('admin'))
      .send({ numeroUsuarios: 3 })
      .expect(409);
    expect(r.body.message).toMatch(/4 usuário\(s\) ativo\(s\)/);
  });

  it('acesso desativado depois do login → 401 mesmo com o access válido', async () => {
    const p = await criarPessoa(ds, { email: 'sai@bill.com' });
    const acesso = await criarAcesso(ds, {
      usuarioId: p.id,
      tenantId: T_OUTRO,
    });
    const l = await http()
      .post('/auth/login')
      .send({ email: 'sai@bill.com', password: SENHA, produto: 'clinic' })
      .expect(200);
    const auth = { Authorization: `Bearer ${l.body.accessToken}` };
    // Enxerga só a assinatura do próprio tenant.
    const a = await http().get('/assinatura').set(auth).expect(200);
    expect(a.body.numeroUsuarios).toBe(9);
    await ds.getRepository(Acesso).update({ id: acesso.id }, { ativo: false });
    await http().get('/modulos').set(auth).expect(401);
  });

  it('baixa só pelo backoffice, com a chave; auditada sem pessoa', async () => {
    const lista = await http()
      .get('/assinatura/faturas')
      .set(como('admin'))
      .expect(200);
    const f = lista.body.data.find(
      (x: { status: string }) => x.status === 'pendente',
    );
    // Há a complementar do aumento para 4 usuários.
    expect(f).toBeDefined();
    const pagar = (id: string) =>
      http().post(`/plataforma/faturas/${id}/pagar`);
    await pagar(f.id).expect(401);
    await pagar(f.id).set('X-Plataforma-Key', 'x'.repeat(40)).expect(401);
    await pagar(f.id).set(como('admin')).expect(401);
    const ok = await pagar(f.id).set('X-Plataforma-Key', CHAVE).expect(200);
    expect(ok.body).toMatchObject({ id: f.id, status: 'paga' });
    await pagar(f.id).set('X-Plataforma-Key', CHAVE).expect(409);
    await pagar(randomUUID()).set('X-Plataforma-Key', CHAVE).expect(404);
    const [log] = await ds.query(
      `SELECT usuario_id FROM crommos.auditoria
        WHERE action = 'pagar-plataforma' AND resource_id = $1`,
      [f.id],
    );
    expect(log).toEqual({ usuario_id: null });

    const config = app.get(ConfigService);
    const original = config.get.bind(config);
    const spy = jest
      .spyOn(config, 'get')
      .mockImplementation((k: string) =>
        k === 'PLATAFORMA_API_KEY' ? undefined : original(k),
      );
    try {
      await pagar(f.id).set('X-Plataforma-Key', CHAVE).expect(404);
    } finally {
      spy.mockRestore();
    }
  });
});
