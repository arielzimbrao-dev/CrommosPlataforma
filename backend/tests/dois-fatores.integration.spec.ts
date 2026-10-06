import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { codigoTotp, passoDe } from 'src/auth/totp';
import { decifrar, recarregarChave } from 'src/common/crypto/cifra';
import { criarApp, fecharApp, limparBanco, mailFalso } from './support/app';
import {
  cookieRefresh,
  criarAcesso,
  criarAssinatura,
  criarPessoa,
  SENHA,
} from './support/dados';

/**
 * Verificação em duas etapas (TOTP). Ligar em Meu perfil (chave + link,
 * confirmar com um código, códigos de recuperação), login em dois passos,
 * código que não se reusa, limite de tentativas, desligar com a senha, e a
 * clínica que exige 2FA de admin e profissionais (o admin desliga o de quem
 * perdeu o celular).
 */
const describeDb =
  process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;

describeDb('Verificação em duas etapas (integração)', () => {
  let app: INestApplication;
  let ds: DataSource;
  const T1 = randomUUID();
  const T2 = randomUUID();
  const T3 = randomUUID(); // Clínica nova (trial) de quem ataca
  const mail = mailFalso();
  const ids: Record<string, string> = {};

  jest.setTimeout(60_000);

  beforeAll(async () => {
    ({ app, ds } = await criarApp(mail));
    await limparBanco(ds);
    await criarAssinatura(ds, { tenantId: T1, tenantNome: 'Clínica Um' });
    await criarAssinatura(ds, { tenantId: T2, tenantNome: 'Clínica Dois' });
    await criarAssinatura(ds, { tenantId: T3, tenantNome: 'Clínica Nova' });
    const pessoas: [string, string, string][] = [
      ['ana', T1, 'recepcao'],
      ['adm', T1, 'admin'],
      ['pro', T1, 'profissional'],
      ['rec', T1, 'recepcao'],
      ['lim', T1, 'recepcao'],
      ['out', T2, 'profissional'],
      ['atk', T3, 'admin'],
    ];
    for (const [nome, tenantId, papel] of pessoas) {
      const p = await criarPessoa(ds, { email: `${nome}@2fa.com`, nome });
      ids[nome] = p.id;
      await criarAcesso(ds, { usuarioId: p.id, tenantId, papel });
    }
    // Recepção com vínculo de profissional de saúde (vê prontuário).
    const cli = await criarPessoa(ds, { email: 'cli@2fa.com', nome: 'cli' });
    ids.cli = cli.id;
    await criarAcesso(ds, {
      usuarioId: cli.id,
      tenantId: T1,
      papel: 'recepcao',
      clinico: true,
    });
  });

  afterAll(() => fecharApp(app));

  const http = () => request(app.getHttpServer());
  const login = (nome: string) =>
    http()
      .post('/auth/login')
      .send({ email: `${nome}@2fa.com`, password: SENHA, produto: 'clinic' });
  const entrar = async (nome: string) => {
    const r = await login(nome).expect(200);
    expect(r.body.accessToken).toBeDefined();
    return `Bearer ${r.body.accessToken as string}`;
  };
  const codigo = (desafio: string, c: string) =>
    http().post('/auth/login/codigo').send({ desafio, codigo: c });

  /** Código válido e ainda não usado (passo depois do último usado). */
  async function proximoCodigo(nome: string): Promise<string> {
    const [u] = await ds.query<
      { totp_segredo: string; totp_ultimo_passo: string | null }[]
    >(
      'SELECT totp_segredo, totp_ultimo_passo FROM crommos.usuarios WHERE id = $1',
      [ids[nome]],
    );
    const segredo = Buffer.from(decifrar(u.totp_segredo), 'hex');
    const agora = passoDe(Date.now());
    const passo = Math.max(Number(u.totp_ultimo_passo ?? 0) + 1, agora - 1);
    return codigoTotp(segredo, passo);
  }

  let recuperacao: string[] = [];

  it('sem 2FA e clínica sem exigência: login como antes', async () => {
    const r = await login('ana').expect(200);
    expect(r.body.accessToken).toBeDefined();
    expect(r.body.doisFatores).toBeUndefined();
  });

  it('Meu perfil: ligar (chave + link), confirmar com o código, códigos de recuperação com hash e segredo cifrado', async () => {
    const auth = await entrar('ana');
    const est = await http()
      .get('/auth/2fa')
      .set('Authorization', auth)
      .expect(200);
    expect(est.body).toEqual({
      ativo: false,
      exigido: false,
      codigosRestantes: 0,
    });

    const ini = await http()
      .post('/auth/2fa/iniciar')
      .set('Authorization', auth)
      .expect(201);
    expect(ini.body.chave).toMatch(/^[A-Z2-7]{32}$/);
    expect(ini.body.link).toContain(`secret=${ini.body.chave as string}`);

    await http()
      .post('/auth/2fa/confirmar')
      .set('Authorization', auth)
      .send({ codigo: '000000' })
      .expect(400);
    const ok = await http()
      .post('/auth/2fa/confirmar')
      .set('Authorization', auth)
      .send({ codigo: await proximoCodigo('ana') })
      .expect(201);
    recuperacao = ok.body.codigosRecuperacao as string[];
    expect(recuperacao).toHaveLength(10);

    const [u] = await ds.query<
      { totp_segredo: string; totp_recuperacao: string[]; ativo: boolean }[]
    >(
      `SELECT totp_segredo, totp_recuperacao, totp_ativo_em IS NOT NULL AS ativo
         FROM crommos.usuarios WHERE id = $1`,
      [ids.ana],
    );
    expect(u.ativo).toBe(true);
    expect(u.totp_segredo.startsWith('enc:v1:')).toBe(true);
    expect(u.totp_recuperacao).toHaveLength(10);
    expect(u.totp_recuperacao).not.toContain(recuperacao[0]);

    await http()
      .post('/auth/2fa/iniciar')
      .set('Authorization', auth)
      .expect(409);
  });

  it('login em dois passos: senha → desafio (sem sessão); código certo → sessão; o mesmo código de novo → 400', async () => {
    const r1 = await login('ana').expect(200);
    expect(r1.body.accessToken).toBeUndefined();
    expect(r1.headers['set-cookie']).toBeUndefined();
    const desafio = r1.body.doisFatores.desafio as string;
    expect(r1.body.doisFatores.configurar).toBeUndefined();

    await codigo(desafio, '123456').expect(400);
    const c = await proximoCodigo('ana');
    const r2 = await codigo(desafio, c).expect(200);
    expect(r2.body.accessToken).toBeDefined();
    expect(cookieRefresh(r2.headers)).toContain('crommos_rt=');
    expect(r2.body.codigosRecuperacao).toBeUndefined();

    await codigo(desafio, c).expect(400); // já usado
    await codigo('desafio-invalido', await proximoCodigo('ana')).expect(401);
  });

  it('código de recuperação: vale uma vez (caixa e espaços não importam)', async () => {
    const d = (await login('ana').expect(200)).body.doisFatores
      .desafio as string;
    const rec = ` ${recuperacao[0].toLowerCase()} `;
    await codigo(d, rec).expect(200);
    await codigo(d, rec).expect(400);
    const auth = await (async () => {
      const d2 = (await login('ana')).body.doisFatores.desafio as string;
      const r = await codigo(d2, recuperacao[1]).expect(200);
      return `Bearer ${r.body.accessToken as string}`;
    })();
    const est = await http()
      .get('/auth/2fa')
      .set('Authorization', auth)
      .expect(200);
    expect(est.body.codigosRestantes).toBe(8);
  });

  it('limite: 5 códigos errados → 429, mesmo com o código certo', async () => {
    const auth = await entrar('lim');
    await http().post('/auth/2fa/iniciar').set('Authorization', auth);
    await http()
      .post('/auth/2fa/confirmar')
      .set('Authorization', auth)
      .send({ codigo: await proximoCodigo('lim') })
      .expect(201);
    const d = (await login('lim')).body.doisFatores.desafio as string;
    for (let i = 0; i < 5; i++) await codigo(d, '000000').expect(400);
    await codigo(d, await proximoCodigo('lim')).expect(429);
  });

  /**
   * Os testes anteriores erram códigos de propósito e gastam os passos da
   * janela de 30 s: zera o limite e o último passo usado.
   */
  async function recomecar(nome: string) {
    await ds.query(
      `DELETE FROM crommos.rate_limit WHERE chave LIKE '2fa-falha:%'`,
    );
    await ds.query(
      'UPDATE crommos.usuarios SET totp_ultimo_passo = NULL WHERE id = $1',
      [ids[nome]],
    );
  }

  it('novos códigos de recuperação: pede senha e código do app; os antigos deixam de valer (auditado)', async () => {
    await recomecar('ana');
    const d = (await login('ana')).body.doisFatores.desafio as string;
    const r = await codigo(d, await proximoCodigo('ana')).expect(200);
    const auth = `Bearer ${r.body.accessToken as string}`;
    const gerar = (body: object) =>
      http()
        .post('/auth/2fa/recuperacao')
        .set('Authorization', auth)
        .send(body);
    await gerar({ senha: SENHA }).expect(400); // sem código
    await gerar({
      senha: 'errada-123',
      codigo: await proximoCodigo('ana'),
    }).expect(400);
    // Código de recuperação não gera outros (precisa do celular).
    await gerar({ senha: SENHA, codigo: recuperacao[2] }).expect(400);
    const ok = await gerar({
      senha: SENHA,
      codigo: await proximoCodigo('ana'),
    }).expect(201);
    const novos = ok.body.codigosRecuperacao as string[];
    expect(novos).toHaveLength(10);
    expect(novos).not.toContain(recuperacao[3]);

    const d2 = (await login('ana')).body.doisFatores.desafio as string;
    await codigo(d2, recuperacao[3]).expect(400); // antigo: não vale mais
    await codigo(d2, novos[0]).expect(200);
    const [a] = await ds.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM crommos.auditoria
        WHERE usuario_id = $1 AND action = '2fa-recuperacao-gerada'`,
      [ids.ana],
    );
    expect(a.n).toBe(1);
    recuperacao = novos.slice(1);
  });

  it('desligar: pede senha e código; senha ou código errados → 400; certos → login volta a ser direto (auditado)', async () => {
    await recomecar('ana');
    const d = (await login('ana')).body.doisFatores.desafio as string;
    const r = await codigo(d, await proximoCodigo('ana')).expect(200);
    const auth = `Bearer ${r.body.accessToken as string}`;
    const desligar = (body: object) =>
      http().post('/auth/2fa/desligar').set('Authorization', auth).send(body);
    await desligar({ senha: SENHA }).expect(400); // sem código
    await desligar({
      senha: 'errada-123',
      codigo: await proximoCodigo('ana'),
    }).expect(400);
    await desligar({ senha: SENHA, codigo: '000000' }).expect(400);
    await desligar({
      senha: SENHA,
      codigo: await proximoCodigo('ana'),
    }).expect(204);
    await entrar('ana');
    const [a] = await ds.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM crommos.auditoria
        WHERE usuario_id = $1 AND action IN ('2fa-ligado', '2fa-desligado')`,
      [ids.ana],
    );
    expect(a.n).toBe(2);
  });

  it('clínica exige 2FA: só o admin liga; admin e profissional configuram no login; recepção entra direto; quem é exigido não desliga', async () => {
    const rec = await entrar('rec');
    await http()
      .patch('/auth/2fa/clinica')
      .set('Authorization', rec)
      .send({ exigir: true })
      .expect(403);
    const adm = await entrar('adm');
    // Conectados antes da exigência: quem é cobrado e não tem 2FA sai.
    const conectado = async (nome: string) =>
      cookieRefresh((await login(nome).expect(200)).headers);
    const [cPro, cCli, cRec] = [
      await conectado('pro'),
      await conectado('cli'),
      await conectado('rec'),
    ];
    const outraClinica = await conectado('out');
    await http()
      .patch('/auth/2fa/clinica')
      .set('Authorization', adm)
      .send({ exigir: true })
      .expect(200);
    const refresh = (c: string) =>
      http().post('/auth/refresh').set('Cookie', c);
    await refresh(cPro).expect(401);
    await refresh(cCli).expect(401);
    await refresh(cRec).expect(200); // recepção sem prontuário: segue
    await refresh(outraClinica).expect(200); // outra clínica: segue
    // Quem ligou a exigência continua (configura no próximo login).
    await http().get('/auth/2fa').set('Authorization', adm).expect(200);

    await entrar('rec'); // papel sem prontuário: direto
    const r1 = await login('pro').expect(200);
    const { desafio, configurar } = r1.body.doisFatores as {
      desafio: string;
      configurar: { chave: string; link: string };
    };
    expect(configurar.chave).toMatch(/^[A-Z2-7]{32}$/);
    const r2 = await codigo(desafio, await proximoCodigo('pro')).expect(200);
    expect(r2.body.codigosRecuperacao).toHaveLength(10);
    const pro = `Bearer ${r2.body.accessToken as string}`;
    const est = await http().get('/auth/2fa').set('Authorization', pro);
    expect(est.body).toMatchObject({ ativo: true, exigido: true });
    await http()
      .post('/auth/2fa/desligar')
      .set('Authorization', pro)
      .send({ senha: SENHA, codigo: await proximoCodigo('pro') })
      .expect(409);

    const clin = await http()
      .get('/auth/2fa/clinica')
      .set('Authorization', adm)
      .expect(200);
    expect(clin.body.exigir).toBe(true);
    expect([...clin.body.comDoisFatores].sort()).toEqual(
      [ids.pro, ids.lim].sort(),
    ); // a Ana desligou; a outra clínica não entra
  });

  it('admin desliga o 2FA de quem perdeu o celular (auditado); de outra clínica → 404; outro papel → 403', async () => {
    // O admin também é exigido agora: configura no login.
    const r1 = await login('adm').expect(200);
    expect(r1.body.doisFatores.configurar).toBeDefined();
    const d = r1.body.doisFatores.desafio as string;
    const r = await codigo(d, await proximoCodigo('adm')).expect(200);
    const auth = `Bearer ${r.body.accessToken as string}`;

    await http()
      .post(`/auth/2fa/desligar/${ids.out}`)
      .set('Authorization', auth)
      .expect(404);
    await http()
      .post(`/auth/2fa/desligar/${ids.pro}`)
      .set('Authorization', await entrar('rec'))
      .expect(403);
    // O profissional também trabalha (acesso aceito) na Clínica Dois.
    await criarAcesso(ds, {
      usuarioId: ids.pro,
      tenantId: T2,
      papel: 'profissional',
    });
    await http()
      .post(`/auth/2fa/desligar/${ids.pro}`)
      .set('Authorization', auth)
      .expect(204);
    const [u] = await ds.query<{ segredo: string | null }[]>(
      'SELECT totp_segredo AS segredo FROM crommos.usuarios WHERE id = $1',
      [ids.pro],
    );
    expect(u.segredo).toBeNull();
    const [a] = await ds.query<{ usuario_id: string }[]>(
      `SELECT usuario_id FROM crommos.auditoria
        WHERE action = '2fa-desligado-pelo-admin' AND resource_id = $1`,
      [ids.pro],
    );
    expect(a.usuario_id).toBe(ids.adm);
    // A pessoa é avisada por e-mail e o evento entra na trilha dela
    // em todas as clínicas em que trabalha (a do admin e a Clínica Dois).
    expect(mail.sendAvisoDoisFatoresDesligado).toHaveBeenCalledWith(
      'pro@2fa.com',
      'Clínica Um',
    );
    const trilha = await ds.query<
      { tenant_id: string; action: string; ip: string | null }[]
    >(
      `SELECT tenant_id, action, ip FROM crommos.auditoria
        WHERE action LIKE '2fa-desligado-por-%' AND usuario_id = $1
        ORDER BY tenant_id`,
      [ids.pro],
    );
    // Na clínica do admin, o registro completo; na outra, "por outra clínica",
    // sem o IP/navegador de quem desligou (não é da equipe dela).
    expect(trilha.find((t) => t.tenant_id === T1)?.action).toBe(
      '2fa-desligado-por-admin',
    );
    expect(trilha.find((t) => t.tenant_id === T2)).toMatchObject({
      action: '2fa-desligado-por-outra-clinica',
      ip: null,
    });
    await ds.query(
      'UPDATE crommos.acessos SET ativo = false WHERE usuario_id = $1 AND tenant_id = $2',
      [ids.pro, T2],
    );
    // Exigido e sem 2FA: configura de novo no próximo login.
    expect(
      (await login('pro').expect(200)).body.doisFatores.configurar,
    ).toBeDefined();
  });

  it('admin de outra clínica que só convidou (ou desativou) a pessoa não desliga o 2FA dela nem vê o selo', async () => {
    const d = (await login('pro').expect(200)).body.doisFatores
      .desafio as string;
    await codigo(d, await proximoCodigo('pro')).expect(200); // liga de novo
    // A clínica nova (trial) convida o e-mail do profissional: convite pendente.
    await criarAcesso(ds, {
      usuarioId: ids.pro,
      tenantId: T3,
      papel: 'recepcao',
      convitePendente: true,
    });
    mail.sendAvisoDoisFatoresDesligado.mockClear();
    const atk = await entrar('atk');
    await http()
      .post(`/auth/2fa/desligar/${ids.pro}`)
      .set('Authorization', atk)
      .expect(404);
    const clin = await http()
      .get('/auth/2fa/clinica')
      .set('Authorization', atk)
      .expect(200);
    expect(clin.body.comDoisFatores).not.toContain(ids.pro);
    // Aceito, mas desativado: também não.
    await ds.query(
      `UPDATE crommos.acessos SET convite_pendente = false, ativo = false
        WHERE usuario_id = $1 AND tenant_id = $2`,
      [ids.pro, T3],
    );
    await http()
      .post(`/auth/2fa/desligar/${ids.pro}`)
      .set('Authorization', atk)
      .expect(404);
    const [u] = await ds.query<{ ativo: boolean }[]>(
      `SELECT totp_ativo_em IS NOT NULL AS ativo FROM crommos.usuarios WHERE id = $1`,
      [ids.pro],
    );
    expect(u.ativo).toBe(true);
    expect(mail.sendAvisoDoisFatoresDesligado).not.toHaveBeenCalled();
  });

  it('sem DATA_ENCRYPTION_KEY: ligar responde 503 (nada em claro)', async () => {
    const auth = await entrar('rec');
    const chave = process.env.DATA_ENCRYPTION_KEY;
    delete process.env.DATA_ENCRYPTION_KEY;
    recarregarChave();
    try {
      await http()
        .post('/auth/2fa/iniciar')
        .set('Authorization', auth)
        .expect(503);
    } finally {
      process.env.DATA_ENCRYPTION_KEY = chave;
      recarregarChave();
    }
  });
});
