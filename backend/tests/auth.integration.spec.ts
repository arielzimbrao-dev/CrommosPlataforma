import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { Acesso } from 'src/auth/acesso.entity';
import { AuthController } from 'src/auth/auth.controller';
import { gerarConfirmacaoEmail } from 'src/auth/tokens';
import { Usuario } from 'src/auth/usuario.entity';
import { normalizarPem } from 'src/auth/chaves-jwt';
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
 * Login único ponta a ponta contra o Postgres (RUN_DB_TESTS=true): login,
 * escolha de clínica, refresh com rotação e reuso, logout, senha e
 * confirmação de e-mail.
 */
const describeDb =
  process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;

describeDb('Auth (integração)', () => {
  let app: INestApplication;
  let ds: DataSource;
  const mail = mailFalso();
  const T1 = randomUUID();
  const T2 = randomUUID();
  const T_ODONTO = randomUUID();
  let ana: Usuario; // um acesso (T1)
  let bia: Usuario; // dois acessos (T1, T2)

  jest.setTimeout(60_000);

  beforeAll(async () => {
    ({ app, ds } = await criarApp(mail));
    await limparBanco(ds);
    await criarAssinatura(ds, {
      tenantId: T1,
      tenantCodigo: 'AAAA1',
      tenantNome: 'Clínica Zeta',
    });
    await criarAssinatura(ds, {
      tenantId: T2,
      tenantCodigo: 'BBBB2',
      tenantNome: 'Clínica Alfa',
    });
    await criarAssinatura(ds, { tenantId: T_ODONTO, produto: 'odonto' });
    ana = await criarPessoa(ds, { email: 'ana@exemplo.com', nome: 'Ana' });
    bia = await criarPessoa(ds, { email: 'bia@exemplo.com', nome: 'Bia' });
    await criarAcesso(ds, { usuarioId: ana.id, tenantId: T1 });
    await criarAcesso(ds, { usuarioId: bia.id, tenantId: T1, papel: 'gestor' });
    await criarAcesso(ds, { usuarioId: bia.id, tenantId: T2 });
    await criarAcesso(ds, {
      usuarioId: bia.id,
      tenantId: T_ODONTO,
      produto: 'odonto',
    });
  });

  afterAll(() => fecharApp(app));

  const login = (body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/auth/login')
      .send({ password: SENHA, produto: 'clinic', ...body });

  describe('login', () => {
    it('um acesso ativo → sessão, cookie crommos_rt httpOnly em /auth e token RS256 com as claims do contrato', async () => {
      const res = await login({ email: 'ANA@exemplo.com' }).expect(200);
      expect(res.body.pessoa).toEqual({
        id: ana.id,
        nome: 'Ana',
        email: 'ana@exemplo.com',
      });
      expect(res.body.acesso).toEqual({
        produto: 'clinic',
        tenantId: T1,
        papel: 'admin',
      });
      const cookie = (res.headers['set-cookie'] as unknown as string[])[0];
      expect(cookie).toMatch(/^crommos_rt=/);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/Path=\/auth/);

      const claims = new JwtService().verify<Record<string, unknown>>(
        res.body.accessToken,
        {
          publicKey: normalizarPem(process.env.PLATAFORMA_JWT_PUBLIC_KEY!),
          algorithms: ['RS256'],
        },
      );
      expect(claims).toMatchObject({
        sub: ana.id,
        produto: 'clinic',
        tenantId: T1,
        typ: 'access',
      });
      expect(claims).not.toHaveProperty('papel');
      expect(Number(claims.exp) - Number(claims.iat)).toBe(15 * 60);
    });

    it('mais de um acesso sem tenantId → escolherClinica (ordenada), sem token nem cookie', async () => {
      const res = await login({ email: 'bia@exemplo.com' }).expect(200);
      expect(res.body).toEqual({
        escolherClinica: [
          { tenantId: T2, codigo: 'BBBB2', nome: 'Clínica Alfa' },
          { tenantId: T1, codigo: 'AAAA1', nome: 'Clínica Zeta' },
        ],
      });
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('tenantId por código (sem diferenciar maiúsculas) ou UUID', async () => {
      const porCodigo = await login({
        email: 'bia@exemplo.com',
        tenantId: 'aaaa1',
      }).expect(200);
      expect(porCodigo.body.acesso).toEqual({
        produto: 'clinic',
        tenantId: T1,
        papel: 'gestor',
      });
      const porUuid = await login({
        email: 'bia@exemplo.com',
        tenantId: T2,
      }).expect(200);
      expect(porUuid.body.acesso.tenantId).toBe(T2);
    });

    it('401 genérico: senha errada, e-mail inexistente, código inexistente, tenant sem acesso', async () => {
      const casos = [
        { email: 'ana@exemplo.com', password: 'outra-senha-1' },
        { email: 'ninguem@exemplo.com' },
        { email: 'ana@exemplo.com', tenantId: 'ZZZZ9' },
        { email: 'ana@exemplo.com', tenantId: T2 },
      ];
      for (const c of casos) {
        const res = await login(c).expect(401);
        expect(res.body.message).toBe('Credenciais inválidas.');
      }
    });

    it('produto: acesso só em outro produto → 401; o tenant do odonto só entra pelo odonto', async () => {
      await login({ email: 'ana@exemplo.com', produto: 'odonto' }).expect(401);
      await login({ email: 'bia@exemplo.com', tenantId: T_ODONTO }).expect(401);
      const res = await login({
        email: 'bia@exemplo.com',
        produto: 'odonto',
      }).expect(200);
      expect(res.body.acesso).toMatchObject({
        produto: 'odonto',
        tenantId: T_ODONTO,
      });
    });

    it('produto não configurado → 400; produto inválido → 400', async () => {
      await login({ email: 'ana@exemplo.com', produto: 'vet' }).expect(400);
      await login({ email: 'ana@exemplo.com', produto: 'x' }).expect(400);
    });

    it('acesso inativo não entra', async () => {
      const p = await criarPessoa(ds, { email: 'inativo@exemplo.com' });
      await criarAcesso(ds, { usuarioId: p.id, tenantId: T1, ativo: false });
      await login({ email: 'inativo@exemplo.com' }).expect(401);
    });
  });

  describe('refresh e logout', () => {
    it('rotaciona: o refresh novo vale; reapresentar o antigo (reuso) revoga todas as sessões da pessoa', async () => {
      const l = await login({ email: 'ana@exemplo.com' }).expect(200);
      const c1 = cookieRefresh(l.headers);

      const r1 = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', c1)
        .expect(200);
      expect(r1.body.acesso).toEqual({
        produto: 'clinic',
        tenantId: T1,
        papel: 'admin',
      });
      expect(r1.body.pessoa.id).toBe(ana.id);
      const c2 = cookieRefresh(r1.headers);
      expect(c2).not.toBe(c1);

      // Reuso do c1 (rotacionado há mais que a tolerância de abas): 401 e
      // revoga tudo (inclusive o c2).
      await ds.query(
        `UPDATE crommos.sessoes SET revogada_em = now() - interval '1 minute'
          WHERE usuario_id = $1 AND substituida_por IS NOT NULL`,
        [ana.id],
      );
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', c1)
        .expect(401);
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', c2)
        .expect(401);
      const [{ n }] = await ds.query(
        `SELECT count(*)::int AS n FROM crommos.auditoria
          WHERE usuario_id = $1 AND action = 'refresh-reutilizado'`,
        [ana.id],
      );
      expect(n).toBeGreaterThanOrEqual(1);
    });

    it('B1: duas abas renovando com o mesmo cookie → as duas ganham sessão, nada é revogado', async () => {
      const l = await login({ email: 'bia@exemplo.com', tenantId: T2 }).expect(
        200,
      );
      const c = cookieRefresh(l.headers);
      const [a, b] = await Promise.all([
        request(app.getHttpServer()).post('/auth/refresh').set('Cookie', c),
        request(app.getHttpServer()).post('/auth/refresh').set('Cookie', c),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      for (const r of [a, b]) {
        await request(app.getHttpServer())
          .post('/auth/refresh')
          .set('Cookie', cookieRefresh(r.headers))
          .expect(200);
      }
    });

    it('sem cookie ou com lixo → 401', async () => {
      await request(app.getHttpServer()).post('/auth/refresh').expect(401);
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', 'crommos_rt=lixo')
        .expect(401);
    });

    it('acesso desativado depois do login → o refresh falha', async () => {
      const p = await criarPessoa(ds, { email: 'desativar@exemplo.com' });
      const acesso = await criarAcesso(ds, { usuarioId: p.id, tenantId: T1 });
      const l = await login({ email: 'desativar@exemplo.com' }).expect(200);
      await ds
        .getRepository(Acesso)
        .update({ id: acesso.id }, { ativo: false });
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', cookieRefresh(l.headers))
        .expect(401);
    });

    it('logout revoga a sessão (204 sempre) e limpa o cookie', async () => {
      const l = await login({ email: 'ana@exemplo.com' }).expect(200);
      const c = cookieRefresh(l.headers);
      const out = await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Cookie', c)
        .expect(204);
      expect(String(out.headers['set-cookie'])).toMatch(/crommos_rt=;/);
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', c)
        .expect(401);
      // Sem cookie / repetido: continua 204.
      await request(app.getHttpServer()).post('/auth/logout').expect(204);
      await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Cookie', c)
        .expect(204);
    });
  });

  describe('senha', () => {
    it('forgot → 202 sempre; reset define a senha, fecha convites e revoga as sessões', async () => {
      const p = await criarPessoa(ds, { email: 'reset@exemplo.com' });
      await criarAcesso(ds, { usuarioId: p.id, tenantId: T1 });
      await criarAcesso(ds, {
        usuarioId: p.id,
        tenantId: T2,
        convitePendente: true,
      });
      const l = await login({
        email: 'reset@exemplo.com',
        tenantId: T1,
      }).expect(200);

      await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: 'naoexiste@exemplo.com' })
        .expect(202);
      expect(mail.sendPasswordReset).not.toHaveBeenCalled();
      await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: 'RESET@exemplo.com' })
        .expect(202);
      const token = ultimo(mail.sendPasswordReset, 1);

      await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token, password: 'fraca' })
        .expect(400);
      await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token, password: 'nova-senha-456' })
        .expect(204);
      // Uso único.
      await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token, password: 'nova-senha-789' })
        .expect(401);

      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', cookieRefresh(l.headers))
        .expect(401);
      const pendentes = await ds
        .getRepository(Acesso)
        .count({ where: { usuarioId: p.id, convitePendente: true } });
      expect(pendentes).toBe(0);
      await login({
        email: 'reset@exemplo.com',
        tenantId: T1,
        password: 'nova-senha-456',
      }).expect(200);
    });

    it('forgot: falha no envio não muda a resposta; pessoa sem acesso ativo não recebe', async () => {
      mail.sendPasswordReset.mockRejectedValueOnce(new Error('smtp'));
      await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: 'ana@exemplo.com' })
        .expect(202);
      const p = await criarPessoa(ds, { email: 'semacesso@exemplo.com' });
      await criarAcesso(ds, { usuarioId: p.id, tenantId: T1, ativo: false });
      mail.sendPasswordReset.mockClear();
      await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: 'semacesso@exemplo.com' })
        .expect(202);
      expect(mail.sendPasswordReset).not.toHaveBeenCalled();
    });

    it('trocar-senha: 400 com a atual errada; sucesso abre sessão nova e derruba as outras', async () => {
      const p = await criarPessoa(ds, { email: 'troca@exemplo.com' });
      await criarAcesso(ds, { usuarioId: p.id, tenantId: T1 });
      const l = await login({ email: 'troca@exemplo.com' }).expect(200);
      const auth = `Bearer ${l.body.accessToken}`;

      await request(app.getHttpServer())
        .post('/auth/trocar-senha')
        .send({ senhaAtual: SENHA, novaSenha: 'outra-senha-1' })
        .expect(401);
      await request(app.getHttpServer())
        .post('/auth/trocar-senha')
        .set('Authorization', auth)
        .send({ senhaAtual: 'errada-123', novaSenha: 'outra-senha-1' })
        .expect(400);
      const ok = await request(app.getHttpServer())
        .post('/auth/trocar-senha')
        .set('Authorization', auth)
        .send({ senhaAtual: SENHA, novaSenha: 'outra-senha-1' })
        .expect(200);
      expect(ok.body.acesso.tenantId).toBe(T1);
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', cookieRefresh(l.headers))
        .expect(401);
      await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', cookieRefresh(ok.headers))
        .expect(200);
    });

    it('refresh token não autentica rota (typ)', async () => {
      const l = await login({ email: 'ana@exemplo.com' }).expect(200);
      const refresh = cookieRefresh(l.headers).split('=')[1];
      await request(app.getHttpServer())
        .post('/auth/reenviar-confirmacao')
        .set('Authorization', `Bearer ${refresh}`)
        .expect(401);
    });
  });

  describe('confirmação de e-mail', () => {
    it('link válido confirma e redireciona com 1; inválido/usado com 0', async () => {
      const { token, campos } = gerarConfirmacaoEmail();
      const p = await criarPessoa(ds, {
        email: 'confirma@exemplo.com',
        ...campos,
      });
      await criarAcesso(ds, { usuarioId: p.id, tenantId: T1 });

      const ok = await request(app.getHttpServer())
        .get(`/auth/confirmar-email?token=${token}`)
        .expect(302);
      expect(ok.headers.location).toMatch(/\/login\?emailConfirmado=1$/);
      const de_novo = await request(app.getHttpServer())
        .get(`/auth/confirmar-email?token=${token}`)
        .expect(302);
      expect(de_novo.headers.location).toMatch(/emailConfirmado=0$/);
      const sem = await request(app.getHttpServer())
        .get('/auth/confirmar-email')
        .expect(302);
      expect(sem.headers.location).toMatch(/emailConfirmado=0$/);
    });

    it('reenviar-confirmacao: 204 com link novo; 409 se já confirmado', async () => {
      const { campos } = gerarConfirmacaoEmail();
      const p = await criarPessoa(ds, {
        email: 'reenvio@exemplo.com',
        ...campos,
      });
      await criarAcesso(ds, { usuarioId: p.id, tenantId: T1 });
      const l = await login({ email: 'reenvio@exemplo.com' }).expect(200);
      const auth = `Bearer ${l.body.accessToken}`;
      await request(app.getHttpServer())
        .post('/auth/reenviar-confirmacao')
        .set('Authorization', auth)
        .expect(204);
      const token = ultimo(mail.sendConfirmacaoEmail, 1);
      await request(app.getHttpServer())
        .get(`/auth/confirmar-email?token=${token}`)
        .expect(302);
      await request(app.getHttpServer())
        .post('/auth/reenviar-confirmacao')
        .set('Authorization', auth)
        .expect(409);
    });
  });

  describe('sessão no access token (QA-002)', () => {
    const http = () => request(app.getHttpServer());
    const claims = (token: string) =>
      new JwtService().decode<Record<string, unknown>>(token);
    const modulos = (token: string) =>
      http().get('/modulos').set('Authorization', `Bearer ${token}`);

    it('o access leva o sid (a família da sessão), que se mantém na rotação', async () => {
      const l = await login({ email: 'ana@exemplo.com' }).expect(200);
      const sid = claims(l.body.accessToken).sid as string;
      expect(sid).toMatch(/^[0-9a-f-]{36}$/);
      const r = await http()
        .post('/auth/refresh')
        .set('Cookie', cookieRefresh(l.headers))
        .expect(200);
      expect(claims(r.body.accessToken).sid).toBe(sid);
      // O access anterior segue valendo: a sessão (família) continua viva.
      await modulos(l.body.accessToken).expect(200);
      await modulos(r.body.accessToken).expect(200);
    });

    it('logout derruba na hora o access da sessão — inclusive o de outra aba que renovou junto', async () => {
      const l = await login({ email: 'ana@exemplo.com' }).expect(200);
      const c = cookieRefresh(l.headers);
      const [a, b] = await Promise.all([
        http().post('/auth/refresh').set('Cookie', c),
        http().post('/auth/refresh').set('Cookie', c),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      await http()
        .post('/auth/logout')
        .set('Cookie', cookieRefresh(b.headers))
        .expect(204);
      for (const t of [
        l.body.accessToken,
        a.body.accessToken,
        b.body.accessToken,
      ]) {
        const r = await modulos(t as string).expect(401);
        expect(r.body.message).toBe('Sessão encerrada.');
      }
      // Outra sessão da mesma pessoa não cai.
      const outra = await login({ email: 'ana@exemplo.com' }).expect(200);
      await modulos(outra.body.accessToken).expect(200);
    });

    it('redefinir a senha derruba o access na hora; trocar a senha só deixa a sessão nova', async () => {
      const p = await criarPessoa(ds, { email: 'sid-senha@exemplo.com' });
      await criarAcesso(ds, { usuarioId: p.id, tenantId: T1 });
      const l1 = await login({ email: 'sid-senha@exemplo.com' }).expect(200);
      const l2 = await login({ email: 'sid-senha@exemplo.com' }).expect(200);
      const troca = await http()
        .post('/auth/trocar-senha')
        .set('Authorization', `Bearer ${l1.body.accessToken}`)
        .send({ senhaAtual: SENHA, novaSenha: 'outra-senha-1' })
        .expect(200);
      await modulos(l1.body.accessToken).expect(401);
      await modulos(l2.body.accessToken).expect(401);
      await modulos(troca.body.accessToken).expect(200);

      await http()
        .post('/auth/forgot-password')
        .send({ email: 'sid-senha@exemplo.com' })
        .expect(202);
      await http()
        .post('/auth/reset-password')
        .send({
          token: ultimo(mail.sendPasswordReset, 1),
          password: 'mais-outra-2',
        })
        .expect(204);
      await modulos(troca.body.accessToken).expect(401);
    });

    it('transição: access antigo, sem sid, vale até expirar', async () => {
      const semSid = await app
        .get(JwtService)
        .signAsync(
          { sub: ana.id, produto: 'clinic', tenantId: T1, typ: 'access' },
          { expiresIn: '15m' },
        );
      await modulos(semSid).expect(200);
    });
  });

  describe('rate limit (QA-003)', () => {
    const http = () => request(app.getHttpServer());

    it('login: sucesso não consome (equipe atrás do mesmo IP)', async () => {
      for (let i = 0; i < 8; i++) {
        await login({ email: 'ana@exemplo.com' }).expect(200);
      }
    });

    it('login: 5 falhas por IP + e-mail bloqueiam o par (até a senha certa); outro e-mail segue', async () => {
      const p = await criarPessoa(ds, { email: 'forca@exemplo.com' });
      await criarAcesso(ds, { usuarioId: p.id, tenantId: T1 });
      for (let i = 0; i < 5; i++) {
        await login({
          email: 'forca@exemplo.com',
          password: 'errada-123',
        }).expect(401);
      }
      const bloqueado = await login({ email: 'FORCA@exemplo.com' }).expect(429);
      expect(bloqueado.body.message).toMatch(/Muitas tentativas/);
      await login({ email: 'ana@exemplo.com' }).expect(200);
    });

    it('login: acertar a senha zera as falhas do par', async () => {
      const p = await criarPessoa(ds, { email: 'zera@exemplo.com' });
      await criarAcesso(ds, { usuarioId: p.id, tenantId: T1 });
      for (let i = 0; i < 4; i++) {
        await login({
          email: 'zera@exemplo.com',
          password: 'errada-123',
        }).expect(401);
      }
      await login({ email: 'zera@exemplo.com' }).expect(200);
      for (let i = 0; i < 4; i++) {
        await login({
          email: 'zera@exemplo.com',
          password: 'errada-123',
        }).expect(401);
      }
      await login({ email: 'zera@exemplo.com' }).expect(200);
    });

    it('forgot-password: no máximo 3 e-mails por hora para o mesmo endereço (resposta igual)', async () => {
      const p = await criarPessoa(ds, { email: 'esqueci@exemplo.com' });
      await criarAcesso(ds, { usuarioId: p.id, tenantId: T1 });
      mail.sendPasswordReset.mockClear();
      for (let i = 0; i < 5; i++) {
        await http()
          .post('/auth/forgot-password')
          .send({ email: 'esqueci@exemplo.com' })
          .expect(202);
      }
      expect(mail.sendPasswordReset).toHaveBeenCalledTimes(3);
    });

    it('QA-100: refresh — 20 por minuto por sessão → 429, e a sessão continua valendo', async () => {
      const p = await criarPessoa(ds, { email: 'renova@exemplo.com' });
      await criarAcesso(ds, { usuarioId: p.id, tenantId: T1 });
      let c = cookieRefresh(
        (await login({ email: 'renova@exemplo.com' }).expect(200)).headers,
      );
      for (let i = 0; i < 20; i++) {
        const r = await http()
          .post('/auth/refresh')
          .set('Cookie', c)
          .expect(200);
        c = cookieRefresh(r.headers);
      }
      const bloqueado = await http()
        .post('/auth/refresh')
        .set('Cookie', c)
        .expect(429);
      expect(bloqueado.body.message).toMatch(/Muitas renovações/);
      // o 429 não consome o refresh: a sessão segue vigente
      const [{ vigentes }] = await ds.query<{ vigentes: string }[]>(
        `SELECT count(*) AS vigentes FROM crommos.sessoes
          WHERE usuario_id = $1 AND revogada_em IS NULL`,
        [p.id],
      );
      expect(Number(vigentes)).toBe(1);
      // outra pessoa (outra sessão) no mesmo IP segue renovando
      const outra = cookieRefresh(
        (await login({ email: 'ana@exemplo.com' }).expect(200)).headers,
      );
      await http().post('/auth/refresh').set('Cookie', outra).expect(200);
    });

    it('QA-100: o limite do refresh por IP comporta uma clínica atrás de NAT', () => {
      expect(
        Reflect.getMetadata(
          'THROTTLER:LIMITdefault',
          AuthController.prototype.refresh,
        ),
      ).toBe(300);
    });

    it('reenviar-confirmacao: 3 por hora por pessoa → 429', async () => {
      const { campos } = gerarConfirmacaoEmail();
      const p = await criarPessoa(ds, {
        email: 'reenvia3@exemplo.com',
        ...campos,
      });
      await criarAcesso(ds, { usuarioId: p.id, tenantId: T1 });
      const l = await login({ email: 'reenvia3@exemplo.com' }).expect(200);
      const auth = `Bearer ${l.body.accessToken}`;
      for (let i = 0; i < 3; i++) {
        await http()
          .post('/auth/reenviar-confirmacao')
          .set('Authorization', auth)
          .expect(204);
      }
      await http()
        .post('/auth/reenviar-confirmacao')
        .set('Authorization', auth)
        .expect(429);
    });
  });

  it('health responde sem token', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .expect(200, { status: 'ok', service: 'plataforma-api' });
  });
});
