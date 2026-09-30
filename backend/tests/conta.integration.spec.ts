import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { ContaService } from 'src/conta/conta.service';
import { criarApp, fecharApp, limparBanco, mailFalso } from './support/app';
import { ProdutoStub } from './support/produto-stub';
import {
  criarAcesso,
  criarAssinatura,
  criarPessoa,
  SENHA,
} from './support/dados';

/** LGPD da pessoa: exportar e excluir (anonimizar) a conta. */
const describeDb =
  process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;

describeDb('Conta (LGPD, integração)', () => {
  let app: INestApplication;
  let ds: DataSource;
  const produto = new ProdutoStub();
  const urlOriginal = process.env.CLINIC_API_URL;
  const T1 = randomUUID();
  const T2 = randomUUID();

  jest.setTimeout(60_000);

  beforeAll(async () => {
    process.env.CLINIC_API_URL = await produto.iniciar();
    ({ app, ds } = await criarApp(mailFalso()));
    await limparBanco(ds);
    await criarAssinatura(ds, { tenantId: T1, tenantNome: 'Clínica Um' });
    await criarAssinatura(ds, { tenantId: T2, tenantNome: 'Clínica Dois' });
  });

  afterAll(async () => {
    process.env.CLINIC_API_URL = urlOriginal;
    await produto.fechar();
    await fecharApp(app);
  });

  const entrar = async (email: string, tenantId: string) => {
    const r = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: SENHA, produto: 'clinic', tenantId })
      .expect(200);
    return `Bearer ${r.body.accessToken as string}`;
  };

  it('exportar: pessoa, acessos com o nome da clínica, sessões e auditoria; sem token → 401', async () => {
    const p = await criarPessoa(ds, {
      email: 'exporta@x.com',
      nome: 'Exporta',
    });
    await criarAcesso(ds, { usuarioId: p.id, tenantId: T1, papel: 'gestor' });
    const auth = await entrar('exporta@x.com', T1);
    const r = await request(app.getHttpServer())
      .get('/conta/dados')
      .set('Authorization', auth)
      .expect(200);
    expect(r.body.pessoa).toMatchObject({
      id: p.id,
      nome: 'Exporta',
      email: 'exporta@x.com',
    });
    expect(r.body.acessos).toEqual([
      expect.objectContaining({
        tenantId: T1,
        clinica: 'Clínica Um',
        papel: 'gestor',
        ativo: true,
      }),
    ]);
    expect(r.body.sessoes.length).toBeGreaterThanOrEqual(1);
    expect(r.body.auditoria.map((a: { action: string }) => a.action)).toContain(
      'login',
    );
    // O registro de acesso vai com o IP na exportação.
    expect(
      r.body.auditoria.find((a: { action: string }) => a.action === 'login').ip,
    ).toBeTruthy();
    await request(app.getHttpServer()).get('/conta/dados').expect(401);
  });

  it('excluir: último admin da clínica → 409; com outro admin → anonimiza, desativa, revoga e não entra mais', async () => {
    const dono = await criarPessoa(ds, { email: 'dono@x.com' });
    await criarAcesso(ds, { usuarioId: dono.id, tenantId: T2 });
    const auth = await entrar('dono@x.com', T2);

    const r409 = await request(app.getHttpServer())
      .post('/conta/excluir')
      .set('Authorization', auth)
      .send({ senha: SENHA })
      .expect(409);
    expect(r409.body.message).toContain('Clínica Dois');

    await request(app.getHttpServer())
      .post('/conta/excluir')
      .set('Authorization', auth)
      .send({ senha: 'errada' })
      .expect(400);

    const outro = await criarPessoa(ds, { email: 'outro-admin@x.com' });
    await criarAcesso(ds, { usuarioId: outro.id, tenantId: T2 });
    await request(app.getHttpServer())
      .post('/conta/excluir')
      .set('Authorization', auth)
      .send({ senha: SENHA })
      .expect(204);

    const [u] = await ds.query(
      `SELECT email, nome, deleted_at IS NOT NULL AS excluida
         FROM crommos.usuarios WHERE id = $1`,
      [dono.id],
    );
    expect(u).toEqual({
      email: `excluida-${dono.id}@anonimizado.invalid`,
      nome: 'Conta excluída',
      excluida: true,
    });
    const [{ n }] = await ds.query(
      `SELECT count(*)::int AS n FROM crommos.acessos WHERE usuario_id = $1 AND ativo`,
      [dono.id],
    );
    expect(n).toBe(0);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'dono@x.com', password: SENHA, produto: 'clinic' })
      .expect(401);
    // O e-mail volta a ficar livre (outra pessoa pode se cadastrar com ele).
    await criarPessoa(ds, { email: 'dono@x.com' });
  });

  it('excluir pede ao produto que anonimize a cópia local; produto fora → pendente e o job tenta de novo', async () => {
    const pendente = async (id: string) =>
      (
        await ds.query<{ p: string[] | null }[]>(
          'SELECT exclusao_pendente AS p FROM crommos.usuarios WHERE id = $1',
          [id],
        )
      )[0].p;

    // Produto no ar: chamada com a chave de serviço; nada pendente.
    produto.chamadas.length = 0;
    produto.status = 204;
    const a = await criarPessoa(ds, { email: 'sai-a@x.com' });
    await criarAcesso(ds, { usuarioId: a.id, tenantId: T1, papel: 'gestor' });
    await request(app.getHttpServer())
      .post('/conta/excluir')
      .set('Authorization', await entrar('sai-a@x.com', T1))
      .send({ senha: SENHA })
      .expect(204);
    expect(produto.chamadas).toEqual([
      expect.objectContaining({
        method: 'POST',
        url: `/interno/usuarios/${a.id}/anonimizar`,
        headers: expect.objectContaining({
          'x-servico-key': process.env.SERVICO_KEY_CLINIC,
        }),
      }),
    ]);
    expect(await pendente(a.id)).toEqual([]);

    // Produto fora: a exclusão vale e o produto fica pendente.
    produto.status = 503;
    const b = await criarPessoa(ds, { email: 'sai-b@x.com' });
    await criarAcesso(ds, { usuarioId: b.id, tenantId: T1, papel: 'gestor' });
    await request(app.getHttpServer())
      .post('/conta/excluir')
      .set('Authorization', await entrar('sai-b@x.com', T1))
      .send({ senha: SENHA })
      .expect(204);
    expect(await pendente(b.id)).toEqual(['clinic']);

    const conta = app.get(ContaService);
    expect(await conta.reenviarExclusoes()).toBe(0); // ainda fora
    produto.status = 204;
    expect(await conta.reenviarExclusoes()).toBe(1);
    expect(await pendente(b.id)).toEqual([]);
    expect(await conta.reenviarExclusoes()).toBe(0);
    await expect(conta.cronExclusoes()).resolves.toBeUndefined();
  });
});
