import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { criarApp, fecharApp, limparBanco, mailFalso } from './support/app';
import { cookieRefresh } from './support/dados';
import { cpfValido } from './support/documentos';
import { ProdutoStub } from './support/produto-stub';

/** Signup ponta a ponta com a API do produto falsa (servidor HTTP local). */
const describeDb =
  process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;

describeDb('Signup (integração)', () => {
  let app: INestApplication;
  let ds: DataSource;
  const mail = mailFalso();
  const produto = new ProdutoStub();
  const urlOriginal = process.env.CLINIC_API_URL;

  jest.setTimeout(60_000);

  beforeAll(async () => {
    process.env.CLINIC_API_URL = await produto.iniciar();
    ({ app, ds } = await criarApp(mail));
    await limparBanco(ds);
  });

  afterAll(async () => {
    process.env.CLINIC_API_URL = urlOriginal;
    await fecharApp(app);
    await produto.fechar();
  });

  beforeEach(() => {
    produto.status = 201;
    produto.chamadas.length = 0;
  });

  const corpo = (over: Record<string, unknown> = {}) => ({
    produto: 'clinic',
    tipoCliente: 'pf',
    documento: cpfValido(),
    nomeClinica: 'Clínica Nova',
    nome: 'Dona Clínica',
    email: `dona-${Math.random().toString(36).slice(2)}@exemplo.com`,
    senha: 'senha-forte-1',
    nomeUnidade: 'Matriz',
    aceiteTermos: true,
    ...over,
  });
  const signup = (body: Record<string, unknown>) =>
    request(app.getHttpServer()).post('/signup').send(body);
  const contar = async (sql: string, params: unknown[]): Promise<number> => {
    const [linha]: { n: number }[] = await ds.query(sql, params);
    return linha.n;
  };

  it('cria cliente, pessoa, assinatura em trial e acesso admin; provisiona o tenant no produto; já entra', async () => {
    const dados = corpo({ email: 'Dona@Exemplo.com', cnpj: '11222333000181' });
    const res = await signup(dados).expect(201);

    expect(res.body.codigo).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
    expect(res.body.pessoa).toMatchObject({
      nome: 'Dona Clínica',
      email: 'dona@exemplo.com',
    });
    expect(res.body.acesso).toMatchObject({
      produto: 'clinic',
      papel: 'admin',
    });
    const tenantId = res.body.acesso.tenantId as string;
    cookieRefresh(res.headers);

    expect(produto.chamadas).toHaveLength(1);
    const [chamada] = produto.chamadas;
    expect(chamada.method).toBe('POST');
    expect(chamada.url).toBe('/interno/tenants');
    expect(chamada.headers['x-servico-key']).toBe(
      process.env.SERVICO_KEY_CLINIC,
    );
    expect(chamada.body).toEqual({
      tenantId,
      codigo: res.body.codigo,
      nomeClinica: 'Clínica Nova',
      cnpj: '11222333000181',
      nomeUnidade: 'Matriz',
      admin: {
        usuarioId: res.body.pessoa.id,
        nome: 'Dona Clínica',
        email: 'dona@exemplo.com',
      },
    });

    const [a] = await ds.query(
      `SELECT produto, tenant_nome, tenant_codigo, em_trial_ate IS NOT NULL AS trial,
              numero_usuarios, cliente_id IS NOT NULL AS com_cliente
         FROM crommos.assinaturas WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(a).toEqual({
      produto: 'clinic',
      tenant_nome: 'Clínica Nova',
      tenant_codigo: res.body.codigo,
      trial: true,
      numero_usuarios: 1, // o admin; sem limite (assento por módulo)
      com_cliente: true,
    });
    expect(
      await contar(
        `SELECT count(*)::int AS n FROM crommos.acessos
          WHERE tenant_id = $1 AND papel = 'admin' AND ativo AND NOT convite_pendente`,
        [tenantId],
      ),
    ).toBe(1);
    expect(mail.sendConfirmacaoEmail).toHaveBeenCalledWith(
      'dona@exemplo.com',
      expect.any(String),
    );

    // O código gerado já vale no login.
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'dona@exemplo.com',
        password: 'senha-forte-1',
        produto: 'clinic',
        tenantId: res.body.codigo.toLowerCase(),
      })
      .expect(200);
  });

  it('409 para e-mail já cadastrado e para documento já cadastrado', async () => {
    const base = corpo();
    await signup(base).expect(201);
    const email = await signup(corpo({ email: base.email })).expect(409);
    expect(email.body.message).toBe(
      'Já existe uma conta com este e-mail. Entre com a sua conta (lá você pode criar outra clínica).',
    );
    const doc = await signup(corpo({ documento: base.documento })).expect(409);
    expect(doc.body.message).toBe('Já existe um cliente com este CPF/CNPJ.');
    expect(produto.chamadas).toHaveLength(1);
  });

  it.each([
    ['o produto responde erro', () => (produto.status = 500)],
    [
      'o produto está fora do ar',
      () => (process.env.CLINIC_API_URL = 'http://127.0.0.1:9'),
    ],
  ])('502 e desfaz tudo quando %s', async (_caso, quebrar) => {
    const url = process.env.CLINIC_API_URL;
    quebrar();
    const dados = corpo();
    try {
      await signup(dados).expect(502);
    } finally {
      process.env.CLINIC_API_URL = url;
    }
    expect(
      await contar(
        `SELECT count(*)::int AS n FROM crommos.usuarios WHERE email = $1`,
        [dados.email],
      ),
    ).toBe(0);
    expect(
      await contar(
        `SELECT count(*)::int AS n FROM crommos.clientes WHERE documento = $1`,
        [dados.documento],
      ),
    ).toBe(0);
    expect(
      await contar(
        `SELECT count(*)::int AS n FROM crommos.assinaturas WHERE tenant_nome = 'Clínica Nova'
           AND tenant_id NOT IN (SELECT tenant_id FROM crommos.acessos)`,
        [],
      ),
    ).toBe(0);
    // Refazer depois funciona (nada ficou preso nos índices únicos).
    produto.status = 201;
    await signup(dados).expect(201);
  });

  it('falha no e-mail de confirmação não desfaz a conta', async () => {
    mail.sendConfirmacaoEmail.mockRejectedValueOnce(new Error('smtp'));
    await signup(corpo()).expect(201);
  });

  describe('R2: outra clínica na mesma conta (POST /signup/clinica)', () => {
    const confirmar = (email: string) =>
      ds.query(
        `UPDATE crommos.usuarios SET email_confirmacao_hash = NULL WHERE email = $1`,
        [email],
      );
    const novaClinica = (token: string, over: Record<string, unknown> = {}) =>
      request(app.getHttpServer())
        .post('/signup/clinica')
        .set('Authorization', `Bearer ${token}`)
        .send({
          produto: 'clinic',
          tipoCliente: 'pf',
          nomeClinica: 'Segunda Clínica',
          nomeUnidade: 'Filial',
          ...over,
        });

    it('mesmo CPF: reaproveita o cliente, cria tenant novo em trial e entra nele; a pessoa escolhe a clínica no login', async () => {
      const base = corpo();
      const r1 = await signup(base).expect(201);
      await confirmar(base.email);
      produto.chamadas.length = 0;
      const r2 = await novaClinica(r1.body.accessToken as string, {
        documento: base.documento,
      }).expect(201);
      expect(r2.body.acesso.tenantId).not.toBe(r1.body.acesso.tenantId);
      expect(r2.body.pessoa.id).toBe(r1.body.pessoa.id);
      expect(produto.chamadas[0].body).toMatchObject({
        nomeClinica: 'Segunda Clínica',
        nomeUnidade: 'Filial',
        admin: { usuarioId: r1.body.pessoa.id, email: base.email },
      });
      const clientes = await ds.query(
        `SELECT DISTINCT cliente_id FROM crommos.assinaturas WHERE tenant_id = ANY($1)`,
        [[r1.body.acesso.tenantId, r2.body.acesso.tenantId]],
      );
      expect(clientes).toHaveLength(1);
      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: base.email, password: base.senha, produto: 'clinic' })
        .expect(200);
      expect(login.body.escolherClinica).toHaveLength(2);
    });

    it('CPF novo cria outro cliente; CPF de outra conta → 409; e-mail não confirmado → 403; sem token → 401', async () => {
      const a = corpo();
      const b = corpo();
      const ra = await signup(a).expect(201);
      await signup(b).expect(201);
      const token = ra.body.accessToken as string;
      await novaClinica(token, { documento: cpfValido() }).expect(403);
      await confirmar(a.email);
      await novaClinica(token, { documento: cpfValido() }).expect(201);
      const outra = await novaClinica(token, { documento: b.documento }).expect(
        409,
      );
      expect(outra.body.message).toBe(
        'Este CPF/CNPJ já está cadastrado em outra conta.',
      );
      await request(app.getHttpServer())
        .post('/signup/clinica')
        .send({})
        .expect(401);
    });

    it('produto falha → 502 e desfaz só o que criou (a pessoa e o cliente antigos ficam)', async () => {
      const base = corpo();
      const r1 = await signup(base).expect(201);
      await confirmar(base.email);
      produto.status = 500;
      await novaClinica(r1.body.accessToken as string, {
        documento: base.documento,
      }).expect(502);
      expect(
        await contar(
          `SELECT count(*)::int AS n FROM crommos.acessos a
             JOIN crommos.usuarios u ON u.id = a.usuario_id WHERE u.email = $1`,
          [base.email],
        ),
      ).toBe(1);
      expect(
        await contar(
          `SELECT count(*)::int AS n FROM crommos.clientes WHERE documento = $1`,
          [base.documento],
        ),
      ).toBe(1);
    });
  });

  it('400: produto indisponível, documento inválido, sem aceite, campo a mais', async () => {
    await signup(corpo({ produto: 'vet' })).expect(400);
    await signup(corpo({ documento: '12345678900' })).expect(400);
    await signup(corpo({ aceiteTermos: false })).expect(400);
    await signup(corpo({ papel: 'admin' })).expect(400);
    expect(produto.chamadas).toHaveLength(0);
  });
});
