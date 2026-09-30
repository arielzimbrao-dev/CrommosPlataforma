import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { Acesso } from 'src/auth/acesso.entity';
import { gerarConfirmacaoEmail } from 'src/auth/tokens';
import { AssinaturaService } from 'src/billing/assinatura.service';
import { ModuleCode } from 'src/billing/modules.catalog';
import { somarMeses } from 'src/billing/pro-rata';
import { hojeISO } from 'src/common/data-brasil';
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
  const T1 = randomUUID();
  const T2 = randomUUID();
  const T_SEM = randomUUID(); // sem assinatura (legado): sem cobrança

  jest.setTimeout(60_000);

  beforeAll(async () => {
    ({ app, ds } = await criarApp(mail));
    await limparBanco(ds);
    await criarAssinatura(ds, { tenantId: T1, tenantNome: 'Clínica T1' });
    // Ciclo corrente começando hoje: o pró-rata é o mês inteiro.
    const hoje = hojeISO();
    await criarAssinatura(ds, {
      tenantId: T2,
      cicloInicio: hoje,
      cicloFim: somarMeses(hoje, 1),
    });
    const dono = await criarPessoa(ds, { email: 'dono@exemplo.com' });
    await criarAcesso(ds, { usuarioId: dono.id, tenantId: T1 });
    await criarAcesso(ds, { usuarioId: dono.id, tenantId: T2 });
    const outro = await criarPessoa(ds, { email: 'outro@exemplo.com' });
    await criarAcesso(ds, { usuarioId: outro.id, tenantId: T2 });
  });

  afterAll(() => fecharApp(app));
  beforeEach(() => jest.clearAllMocks());

  const interno = (
    metodo: 'post' | 'patch' | 'get' | 'delete',
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
    expect(res.body).toEqual({
      usuarioId: expect.any(String),
      novo: true,
      convitePendente: true,
      emailEnviado: true,
    });
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

  it('pessoa que já tem senha: convite pendente + e-mail de aceite (como a nova); só entra depois de aceitar', async () => {
    const res = await interno('post', '/acessos')
      .send({
        tenantId: T1,
        email: 'outro@exemplo.com',
        nome: 'Outro',
        papel: 'financeiro',
      })
      .expect(201);
    expect(res.body).toMatchObject({
      novo: false,
      convitePendente: true,
      emailEnviado: true,
    });
    expect(mail.sendConvite).not.toHaveBeenCalled();
    expect(mail.sendConviteAceite).toHaveBeenCalledWith(
      'outro@exemplo.com',
      'Pessoa Teste',
      expect.any(String),
      'clinic',
      'Clínica T1',
    );
    // Antes de aceitar, a clínica nova não aparece no login.
    await login('outro@exemplo.com', T1).expect(401);
    const semTenant = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'outro@exemplo.com', password: SENHA, produto: 'clinic' })
      .expect(200);
    expect(semTenant.body.acesso.tenantId).toBe(T2);

    const token = ultimo(mail.sendConviteAceite, 2);
    await request(app.getHttpServer())
      .post('/auth/aceitar-convite')
      .send({ token })
      .expect(200);
    await request(app.getHttpServer())
      .post('/auth/aceitar-convite')
      .send({ token })
      .expect(409);
    const l = await login('outro@exemplo.com', T1).expect(200);
    expect(l.body.acesso).toEqual({
      produto: 'clinic',
      tenantId: T1,
      papel: 'financeiro',
    });
  });

  it('409: já tem acesso neste tenant', async () => {
    const dup = await interno('post', '/acessos')
      .send({
        tenantId: T1,
        email: 'DONO@exemplo.com',
        nome: 'Dono',
        papel: 'admin',
      })
      .expect(409);
    expect(dup.body.message).toBe('Esta pessoa já tem acesso a esta clínica.');
  });

  it('assento por módulo: sem limite de pessoas; convite e vínculo clínico cobram a diferença no pró-rata', async () => {
    const faturas = () =>
      ds.query<{ valor_bruto: string; itens: { motivo: string } }[]>(
        `SELECT f.valor_bruto, f.itens FROM crommos.faturas f
           JOIN crommos.assinaturas a ON a.id = f.assinatura_id
          WHERE a.tenant_id = $1 ORDER BY f.created_at`,
        [T2],
      );
    // T2: dono + outro (admin, sem vínculo clínico). + 1 recepção: 3 pessoas.
    const res = await interno('post', '/acessos')
      .send({
        tenantId: T2,
        email: 'mais@exemplo.com',
        nome: 'Mais',
        papel: 'recepcao',
      })
      .expect(201);
    let f = await faturas();
    expect(f).toHaveLength(1);
    // Agenda + Múltiplas unidades + Estoque: 25,50 + 12,75 + 8,50 no mês inteiro.
    expect(Number(f[0].valor_bruto)).toBe(46.75);
    expect(f[0].itens.motivo).toBe('assentos');

    // Vínculo com profissional: o dono ocupa Prontuário, Exames e Telemedicina.
    const dono = await ds
      .getRepository(Acesso)
      .findOneByOrFail({ tenantId: T2, papel: 'admin', clinico: false });
    const r = await interno('patch', '/acessos')
      .send({ tenantId: T2, usuarioId: dono.usuarioId, clinico: true })
      .expect(200);
    expect(r.body.clinico).toBe(true);
    f = await faturas();
    expect(Number(f[1].valor_bruto)).toBe(85); // 25,50 + 17 + 42,50

    // Compensação (vínculo não gravado no produto): desfaz a cobrança.
    await interno('delete', '/acessos')
      .send({ tenantId: T2, usuarioId: res.body.usuarioId })
      .expect(204);
    // A redução abate as pendentes do ciclo (a mais recente primeiro).
    f = await faturas();
    const total = f.reduce((t, x) => t + Number(x.valor_bruto), 0);
    expect(total).toBeCloseTo(85, 2);
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

  it('PATCH: papel; desativar revoga as sessões do tenant (não as de outro); reativar volta', async () => {
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

    // Sem limite de pessoas: reativar só volta a cobrar o assento.
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

  it('"Conta excluída" não volta a ativar (nem cobra assento); desativar segue', async () => {
    const p = await criarPessoa(ds, { email: 'excluida@exemplo.com' });
    await criarAcesso(ds, { usuarioId: p.id, tenantId: T1, papel: 'gestor' });
    await ds.query(
      `UPDATE crommos.usuarios SET deleted_at = now() WHERE id = $1`,
      [p.id],
    );
    await interno('patch', '/acessos')
      .send({ tenantId: T1, usuarioId: p.id, ativo: false })
      .expect(200);
    const r = await interno('patch', '/acessos')
      .send({ tenantId: T1, usuarioId: p.id, ativo: true })
      .expect(409);
    expect(r.body.message).toContain('excluiu a conta');
    const [a] = await ds.query<{ ativo: boolean }[]>(
      `SELECT ativo FROM crommos.acessos WHERE usuario_id = $1`,
      [p.id],
    );
    expect(a.ativo).toBe(false);
  });

  it('aceite — link reenviado substitui o anterior; convite cancelado (desativado) ou expirado não aceita; reset de senha não aceita', async () => {
    const p = await criarPessoa(ds, { email: 'aceite@exemplo.com' });
    await criarAcesso(ds, { usuarioId: p.id, tenantId: T2 });
    const aceitar = (token: string) =>
      request(app.getHttpServer())
        .post('/auth/aceitar-convite')
        .send({ token })
        .then((r) => r.status);
    const res = await interno('post', '/acessos')
      .send({
        tenantId: T_SEM,
        email: 'aceite@exemplo.com',
        nome: 'Aceite',
        papel: 'gestor',
      })
      .expect(201);
    const primeiro = ultimo(mail.sendConviteAceite, 2);
    await interno('post', '/acessos/reenviar-convite')
      .send({ tenantId: T_SEM, usuarioId: res.body.usuarioId })
      .expect(204);
    const segundo = ultimo(mail.sendConviteAceite, 2);
    expect(segundo).not.toBe(primeiro);
    expect(mail.sendConvite).not.toHaveBeenCalled();
    expect(await aceitar(primeiro)).toBe(400);

    // Redefinir a senha não aceita o convite de quem já tinha senha.
    await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email: 'aceite@exemplo.com' })
      .expect(202);
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({
        token: ultimo(mail.sendPasswordReset, 1),
        password: 'nova-senha-9',
      })
      .expect(204);
    await login('aceite@exemplo.com', T_SEM, 'nova-senha-9').expect(401);

    // Cancelado (desativado): o link não vale.
    await interno('patch', '/acessos')
      .send({ tenantId: T_SEM, usuarioId: p.id, ativo: false })
      .expect(200);
    expect(await aceitar(segundo)).toBe(400);
    await interno('patch', '/acessos')
      .send({ tenantId: T_SEM, usuarioId: p.id, ativo: true })
      .expect(200);
    // Expirado.
    await ds.query(
      `UPDATE crommos.acessos SET convite_expira_em = now() - interval '1 minute'
        WHERE usuario_id = $1 AND tenant_id = $2`,
      [p.id, T_SEM],
    );
    expect(await aceitar(segundo)).toBe(400);
    await interno('post', '/acessos/reenviar-convite')
      .send({ tenantId: T_SEM, usuarioId: p.id })
      .expect(204);
    expect(await aceitar(ultimo(mail.sendConviteAceite, 2))).toBe(200);
    await login('aceite@exemplo.com', T_SEM, 'nova-senha-9').expect(200);
    const r = await interno('post', '/acessos/reenviar-convite')
      .send({ tenantId: T_SEM, usuarioId: p.id })
      .expect(409);
    expect(r.body.message).toBe('Esta pessoa já aceitou o convite.');
  });

  it('em modo leitura (trial vencido) o produto ainda desativa acessos e reenvia convites', async () => {
    const T_LEITURA = randomUUID();
    await criarAssinatura(ds, {
      tenantId: T_LEITURA,
      numeroUsuarios: 5,
      cicloInicio: '2026-01-01',
      cicloFim: '2026-01-15',
      emTrialAte: '2026-01-15',
    });
    const p = await criarPessoa(ds, { email: 'leitura@exemplo.com' });
    await criarAcesso(ds, { usuarioId: p.id, tenantId: T_LEITURA });
    const convidado = await interno('post', '/acessos')
      .send({
        tenantId: T_LEITURA,
        email: 'pendente-leitura@exemplo.com',
        nome: 'Pendente',
        papel: 'recepcao',
      })
      .expect(201);
    await interno('post', '/acessos/reenviar-convite')
      .send({ tenantId: T_LEITURA, usuarioId: convidado.body.usuarioId })
      .expect(204);
    for (const usuarioId of [p.id, convidado.body.usuarioId as string]) {
      const r = await interno('patch', '/acessos')
        .send({ tenantId: T_LEITURA, usuarioId, ativo: false })
        .expect(200);
      expect(r.body.ativo).toBe(false);
    }
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

  it('convite registrado mas e-mail falhou → 201 { emailEnviado: false }; o acesso fica (reenviar resolve)', async () => {
    mail.sendConvite.mockRejectedValueOnce(new Error('smtp'));
    const res = await interno('post', '/acessos')
      .send({
        tenantId: T_SEM,
        email: 'falhou@exemplo.com',
        nome: 'Falhou',
        papel: 'gestor',
      })
      .expect(201);
    expect(res.body).toMatchObject({
      novo: true,
      convitePendente: true,
      emailEnviado: false,
    });
    const [{ n }] = await ds.query(
      `SELECT count(*)::int AS n FROM crommos.acessos a
         JOIN crommos.usuarios u ON u.id = a.usuario_id
        WHERE u.email = 'falhou@exemplo.com' AND a.convite_pendente`,
    );
    expect(n).toBe(1);
  });

  it('DELETE /acessos (compensação do produto): remove o acesso e libera a vaga; 404 sem acesso', async () => {
    const res = await interno('post', '/acessos')
      .send({
        tenantId: T_SEM,
        email: 'compensa@exemplo.com',
        nome: 'Compensa',
        papel: 'gestor',
      })
      .expect(201);
    await interno('delete', '/acessos')
      .send({ tenantId: T_SEM, usuarioId: res.body.usuarioId })
      .expect(204);
    expect(
      await ds.getRepository(Acesso).countBy({
        usuarioId: res.body.usuarioId,
        tenantId: T_SEM,
      }),
    ).toBe(0);
    await interno('delete', '/acessos')
      .send({ tenantId: T_SEM, usuarioId: res.body.usuarioId })
      .expect(404);
    // Convidar de novo funciona (não ficou "já tem acesso").
    await interno('post', '/acessos')
      .send({
        tenantId: T_SEM,
        email: 'compensa@exemplo.com',
        nome: 'Compensa',
        papel: 'gestor',
      })
      .expect(201);
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

  it('POST /teleconsultas: conta na franquia (idempotente); o excedente entra na fatura da renovação', async () => {
    const T_TELE = randomUUID();
    await criarAssinatura(ds, {
      tenantId: T_TELE,
      modulosAtivos: [ModuleCode.Telemedicina],
      cicloInicio: '2026-08-01',
      cicloFim: '2026-09-01',
    });
    const medico = await criarPessoa(ds, { email: 'tele@exemplo.com' });
    await criarAcesso(ds, {
      usuarioId: medico.id,
      tenantId: T_TELE,
      clinico: true,
    });
    const refs = Array.from({ length: 23 }, () => randomUUID());
    await interno('post', '/teleconsultas', null)
      .send({ tenantId: T_TELE, referencia: refs[0] })
      .expect(401);
    await interno('post', '/teleconsultas')
      .send({ tenantId: T_TELE, referencia: 'x' })
      .expect(400);
    for (const referencia of [...refs, refs[0]]) {
      await interno('post', '/teleconsultas')
        .send({ tenantId: T_TELE, referencia })
        .expect(204);
    }
    // realizadas no ciclo que fecha (agosto); o reenvio não contou de novo
    await ds.query(
      `UPDATE crommos.teleconsultas SET realizada_em = '2026-08-10T15:00:00Z'
        WHERE tenant_id = $1`,
      [T_TELE],
    );
    const [{ n }] = await ds.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM crommos.teleconsultas WHERE tenant_id = $1`,
      [T_TELE],
    );
    expect(n).toBe(23);

    const svc = app.get(AssinaturaService);
    await svc.renovarVencidas('2026-09-15');
    const [fatura] = await ds.query<
      { valor_bruto: string; itens: Record<string, unknown> }[]
    >(
      `SELECT f.valor_bruto, f.itens FROM crommos.faturas f
         JOIN crommos.assinaturas a ON a.id = f.assinatura_id
        WHERE a.tenant_id = $1`,
      [T_TELE],
    );
    // 1 médico: 42,50 + (23 − 20) × 2,00
    expect(Number(fatura.valor_bruto)).toBe(48.5);
    expect(fatura.itens.teleconsultasExcedentes).toEqual({
      quantidade: 3,
      valorUnitario: 2,
      valor: 6,
      realizadas: 23,
      incluidas: 20,
    });
    // o ciclo novo começa sem teleconsultas
    const view = await svc.getCurrent(
      { usuarioId: medico.id, produto: 'clinic', tenantId: T_TELE },
      '2026-09-15',
    );
    expect(view.teleconsultas).toEqual({ realizadas: 0, incluidas: 20 });
  });
});
