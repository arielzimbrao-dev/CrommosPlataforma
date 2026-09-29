import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { Acesso } from 'src/auth/acesso.entity';
import { hojeISO } from 'src/common/data-brasil';
import { AssinaturaService } from 'src/billing/assinatura.service';
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
      // Agenda: admin e gestor (o financeiro não abre a agenda) × 25,50.
      expect(a.body).toMatchObject({
        modulosAtivos: ['agenda'],
        numeroUsuarios: 3,
        valor: 51,
        faixa: { de: 1, ate: 5, desconto: 0 },
      });
      expect(
        a.body.itens.find((i: { code: string }) => i.code === 'financeiro'),
      ).toEqual({ code: 'financeiro', pessoas: 3, preco: 29.75 });
      await http().get('/assinatura/faturas').set(como(papel)).expect(200);
      await http()
        .post('/assinatura/simular')
        .set(como(papel))
        .send({ modulos: ['agenda'], plano: 'mensal' })
        .expect(201)
        // QA-006: fora do trial não há "1ª fatura" a mostrar.
        .expect((r) => expect(r.body.primeiraFatura).toBeNull());
    }
    await http().get('/assinatura').set(como('gestor')).expect(403);
    await http().get('/assinatura/faturas').set(como('gestor')).expect(403);
  });

  it('PATCH: só admin; upgrade gera fatura complementar (pró-rata do ciclo inteiro) e audita', async () => {
    for (const papel of ['financeiro', 'gestor']) {
      await http()
        .patch('/assinatura')
        .set(como(papel))
        .send({ modulosAtivos: ['agenda', 'financeiro'] })
        .expect(403);
    }
    // + Financeiro: 3 assentos (admin, financeiro, gestor) × 29,75
    const sim = await http()
      .post('/assinatura/simular')
      .set(como('admin'))
      .send({ modulos: ['agenda', 'financeiro'], plano: 'mensal' })
      .expect(201);
    expect(sim.body).toMatchObject({
      valor: 140.25,
      valorAtual: 51,
      ajuste: { tipo: 'complementar', valor: 89.25 },
    });
    const res = await http()
      .patch('/assinatura')
      .set(como('admin'))
      .send({ modulosAtivos: ['agenda', 'financeiro'] })
      .expect(200);
    expect(res.body.ajuste).toMatchObject({
      tipo: 'complementar',
      valor: 89.25,
    });
    expect(res.body.fatura).toMatchObject({
      tipo: 'complementar',
      valorLiquido: 89.25,
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
      .send({ modulosAtivos: ['agenda'] })
      .expect(200);
    expect(res.body.ajuste).toMatchObject({ tipo: 'credito', valor: 89.25 });
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

  it('assentos vêm dos acessos (convite pendente conta); simular o impacto de mais uma pessoa', async () => {
    const convidado = await criarPessoa(ds, { email: 'convite@bill.com' });
    await criarAcesso(ds, {
      usuarioId: convidado.id,
      tenantId: T,
      papel: 'recepcao',
      convitePendente: true,
    });
    const a = await http().get('/assinatura').set(como('admin')).expect(200);
    expect(a.body).toMatchObject({ numeroUsuarios: 4, valor: 76.5 });
    const sim = await http()
      .post('/assinatura/simular')
      .set(como('admin'))
      .send({
        modulos: ['agenda'],
        plano: 'mensal',
        adicionar: { papel: 'profissional', clinico: true },
      })
      .expect(201);
    expect(sim.body).toMatchObject({
      valorAtual: 76.5,
      valor: 102,
      numeroUsuarios: 5,
    });
    await http()
      .post('/assinatura/simular')
      .set(como('admin'))
      .send({ modulos: [], plano: 'mensal', adicionar: { papel: 'X!' } })
      .expect(400);
    // QA-180: papel fora da lista → 400 com a lista dos papéis.
    const inexistente = await http()
      .post('/assinatura/simular')
      .set(como('admin'))
      .send({
        modulos: ['agenda'],
        plano: 'mensal',
        adicionar: { papel: 'superusuario' },
      })
      .expect(400);
    expect(inexistente.body.message).toEqual([
      'Papel inválido: use admin, gestor, recepcao, profissional ou financeiro.',
    ]);
    // QA-167: desativar a recepção (remover) → 2 assentos de Agenda.
    const sem = await http()
      .post('/assinatura/simular')
      .set(como('admin'))
      .send({
        modulos: ['agenda'],
        plano: 'mensal',
        remover: { papel: 'recepcao' },
      })
      .expect(201);
    expect(sem.body).toMatchObject({
      valorAtual: 76.5,
      valor: 51,
      numeroUsuarios: 3,
    });
    // + Múltiplas unidades: 4 pessoas × 12,75 → complementar pendente.
    await http()
      .patch('/assinatura')
      .set(como('admin'))
      .send({ modulosAtivos: ['agenda', 'multiplas_unidades'] })
      .expect(200);
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
    expect(a.body.numeroUsuarios).toBe(1);
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
    // Há a complementar de Múltiplas unidades.
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

  it('inadimplência: vencida além da tolerância → modo leitura em /modulos; a baixa reativa na hora; fail-closed sem assinatura', async () => {
    const svc = app.get(AssinaturaService);
    const T_DEVEDOR = randomUUID();
    const a = await criarAssinatura(ds, { tenantId: T_DEVEDOR });
    const p = await criarPessoa(ds, { email: 'devedor@bill.com' });
    await criarAcesso(ds, { usuarioId: p.id, tenantId: T_DEVEDOR });
    const l = await http()
      .post('/auth/login')
      .send({ email: 'devedor@bill.com', password: SENHA, produto: 'clinic' })
      .expect(200);
    const auth = { Authorization: `Bearer ${l.body.accessToken as string}` };
    const [f] = await ds.query(
      `INSERT INTO crommos.faturas (tenant_id, assinatura_id, tipo, periodo_inicio,
         periodo_fim, valor_bruto, valor_liquido, vencimento)
       VALUES ($1, $2, 'ciclo', '2026-01-01', '2026-02-01', 10, 10, '2026-01-01')
       RETURNING id`,
      [T_DEVEDOR, a.id],
    );
    // Vencida há 7 dias: só aviso. Há 8: leitura.
    await svc.atualizarInadimplencia('2026-01-08');
    let m = await http().get('/modulos').set(auth).expect(200);
    expect(m.body.situacao.modoLeitura).toBeNull();
    await svc.atualizarInadimplencia('2026-01-09');
    m = await http().get('/modulos').set(auth).expect(200);
    expect(m.body.situacao).toMatchObject({
      modoLeitura: 'inadimplencia',
      faturaVencida: { vencimento: '2026-01-01', bloqueiaEm: '2026-01-09' },
    });
    await http()
      .post(`/plataforma/faturas/${f.id as string}/pagar`)
      .set('X-Plataforma-Key', CHAVE)
      .expect(200);
    m = await http().get('/modulos').set(auth).expect(200);
    expect(m.body.situacao.modoLeitura).toBeNull();

    // Assinatura removida (soft-delete): nenhum módulo.
    await ds.query(
      `UPDATE crommos.assinaturas SET deleted_at = now() WHERE id = $1`,
      [a.id],
    );
    m = await http().get('/modulos').set(auth).expect(200);
    expect(m.body.ativos).toEqual([]);
  });

  it('QA-007: validação em pt-BR (nº de usuários fora da faixa)', async () => {
    for (const numeroUsuarios of [5000, -1]) {
      const r = await http()
        .post('/assinatura/simular')
        .set(como('admin'))
        .send({ modulos: ['agenda'], numeroUsuarios, plano: 'mensal' })
        .expect(400);
      expect(r.body.message).toEqual(['Informe de 1 a 1000 usuários.']);
    }
    const r = await http()
      .post('/assinatura/simular')
      .set(como('admin'))
      .send({ modulos: ['agenda'], numeroUsuarios: 2, plano: 'x' })
      .expect(400);
    expect(r.body.message).toEqual([
      'plano deve ser um destes valores: mensal, semestral, anual.',
    ]);
  });

  it('QA-005: fatura que vence hoje não é "vencida"; a partir de amanhã é', async () => {
    const T_HOJE = randomUUID();
    const a = await criarAssinatura(ds, { tenantId: T_HOJE });
    const p = await criarPessoa(ds, { email: 'vencehoje@bill.com' });
    await criarAcesso(ds, { usuarioId: p.id, tenantId: T_HOJE });
    const l = await http()
      .post('/auth/login')
      .send({ email: 'vencehoje@bill.com', password: SENHA, produto: 'clinic' })
      .expect(200);
    const auth = { Authorization: `Bearer ${l.body.accessToken as string}` };
    const inserir = (vencimento: string) =>
      ds.query(
        `INSERT INTO crommos.faturas (tenant_id, assinatura_id, tipo, periodo_inicio,
           periodo_fim, valor_bruto, valor_liquido, vencimento)
         VALUES ($1, $2, 'ciclo', $3, $3, 10, 10, $3)`,
        [T_HOJE, a.id, vencimento],
      );
    const hoje = hojeISO();
    await inserir(hoje);
    let m = await http().get('/modulos').set(auth).expect(200);
    expect(m.body.situacao.faturaVencida).toBeNull();
    const ontem = new Date(Date.parse(`${hoje}T00:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10);
    await inserir(ontem);
    m = await http().get('/modulos').set(auth).expect(200);
    expect(m.body.situacao.faturaVencida).toMatchObject({ vencimento: ontem });
  });

  it('pagamento online: sem AbacatePay configurada → 503; fatura de outro tenant → 404', async () => {
    const r = await http().get('/assinatura').set(como('admin')).expect(200);
    expect(r.body.pagamentoOnline).toBe(false);
    const faturas = await http()
      .get('/assinatura/faturas')
      .set(como('admin'))
      .expect(200);
    const pendente = (
      faturas.body.data as { id: string; status: string }[]
    ).find((x) => x.status === 'pendente');
    if (pendente) {
      await http()
        .post(`/assinatura/faturas/${pendente.id}/pagamento`)
        .set(como('admin'))
        .expect(503);
    }
    await http()
      .post(`/assinatura/faturas/${randomUUID()}/pagamento`)
      .set(como('financeiro'))
      .expect(404);
    await http()
      .post(`/assinatura/faturas/${randomUUID()}/pagamento`)
      .set(como('gestor'))
      .expect(403);
    await http().post('/webhooks/abacatepay').send({}).expect(404);
  });
});
