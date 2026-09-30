# CLAUDE.md — Crommos Plataforma

Backend **da plataforma** (`plataforma-api`): login único, signup, acessos,
assinaturas e faturas, comuns a Clinic, Odonto e Vet. Escreve **só** no schema
`crommos` do Postgres compartilhado.

- **Contrato com os produtos:** [`docs/contrato.md`](docs/contrato.md) — mudou lá,
  muda nos dois lados no mesmo ciclo. Ambíguo? Escolha o mais simples e registre
  no contrato.
- **Código:** [`backend/context.md`](backend/context.md) (mapa, armadilhas, como rodar).
- **Diretrizes:** as do workspace (`Crommos/docs/14-diretrizes-de-codigo.md`) —
  Princípio nº 1: a solução mais **simples, eficiente e segura** primeiro
  (Correto → Seguro → Simples → Eficiente).
- **Idioma:** código, comentários, mensagens e docs em **português do Brasil**.
- **Testes:** TDD; unit + integração (Supertest, Postgres com `RUN_DB_TESTS=true`);
  gate de cobertura **85%**. CI verde antes do merge.
- **Commits:** Conventional Commits em português (`feat(auth): …`), direto na `main`.
- **Conta e acesso (estado em 30/09/2026):** login único com verificação em duas etapas (TOTP +
  códigos de recuperação; a clínica pode exigir, padrão desligado), registros de acesso com IP
  (retenção de 1 ano), exclusão de conta propagada aos produtos e erros sempre em pt-BR — detalhes
  em [`backend/context.md`](backend/context.md) e no contrato.
- **Segredos:** nunca versionar `.env` nem chaves (`*.pem`); nos testes o par RS256
  é gerado na hora.
