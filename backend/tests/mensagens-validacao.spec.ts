import {
  traduzirMensagem,
  traduzirValidacao,
} from 'src/common/exceptions/mensagens-validacao';

describe('traduzirValidacao (400 do ValidationPipe em pt-BR)', () => {
  it.each([
    ['email must be an email', 'email deve ser um e-mail válido.'],
    ['nome must be a string', 'nome deve ser um texto.'],
    [
      'numeroUsuarios must be an integer number',
      'numeroUsuarios deve ser um número inteiro.',
    ],
    [
      'valor must be a number conforming to the specified constraints',
      'valor deve ser um número.',
    ],
    ['ativo must be a boolean value', 'ativo deve ser verdadeiro ou falso.'],
    ['tenantId must be a UUID', 'tenantId deve ser um identificador válido.'],
    [
      'plano must be one of the following values: mensal, semestral, anual',
      'plano deve ser um destes valores: mensal, semestral, anual.',
    ],
    [
      'each value in modulos must be one of the following values: agenda, financeiro',
      'cada item de modulos deve ser um destes valores: agenda, financeiro.',
    ],
    [
      'numeroUsuarios must not be less than 1',
      'numeroUsuarios não pode ser menor que 1.',
    ],
    [
      'numeroUsuarios must not be greater than 1000',
      'numeroUsuarios não pode ser maior que 1000.',
    ],
    [
      'nome must be longer than or equal to 2 characters',
      'nome deve ter no mínimo 2 caracteres.',
    ],
    [
      'nome must be shorter than or equal to 255 characters',
      'nome deve ter no máximo 255 caracteres.',
    ],
    ['modulos must be an array', 'modulos deve ser uma lista.'],
    [
      "All modulos's elements must be unique",
      'modulos não pode ter itens repetidos.',
    ],
    ['nome should not be empty', 'nome é obrigatório.'],
    ['nome should not be null or undefined', 'nome é obrigatório.'],
    ['property foo should not exist', 'O campo foo não é permitido.'],
    [
      'data must be a valid ISO 8601 date string',
      'data deve ser uma data válida.',
    ],
    [
      'cep must match /^\\d{8}$/ regular expression',
      'cep está em formato inválido.',
    ],
    [
      'itens must contain at least 1 elements',
      'itens deve ter pelo menos 1 item(ns).',
    ],
    [
      'itens must contain no more than 50 elements',
      'itens deve ter no máximo 50 item(ns).',
    ],
    ['aceite must be equal to true', 'aceite deve ser igual a true.'],
    ['valor must be a positive number', 'valor deve ser positivo.'],
    ['endereco must be an object', 'endereco deve ser um objeto.'],
    ['site must be a URL address', 'site deve ser uma URL válida.'],
    ['Validation failed (uuid is expected)', 'Identificador inválido.'],
    ['ativo must be a boolean string', 'ativo deve ser verdadeiro ou falso.'],
    [
      'nested property endereco must be either object or array',
      'endereco deve ser um objeto ou uma lista.',
    ],
    // Mensagem própria com `each: true`: só o prefixo muda.
    [
      'each value in datas deve ser uma data no formato AAAA-MM-DD',
      'cada item de datas deve ser uma data no formato AAAA-MM-DD',
    ],
  ])('%s', (en, pt) => {
    expect(traduzirMensagem(en)).toBe(pt);
  });

  it('mensagem já em português (ou desconhecida) fica como está', () => {
    expect(traduzirMensagem('Informe de 1 a 1000 usuários.')).toBe(
      'Informe de 1 a 1000 usuários.',
    );
  });

  it('mensagem própria de campo aninhado sai sem o caminho ("adicionar.")', () => {
    expect(traduzirMensagem('adicionar.Papel inválido.')).toBe(
      'Papel inválido.',
    );
    expect(traduzirMensagem('adicionar.papel must be a string')).toBe(
      'adicionar.papel deve ser um texto.',
    );
  });

  it('traduz string e lista; outros tipos passam', () => {
    expect(traduzirValidacao(['email must be an email', 'ok'])).toEqual([
      'email deve ser um e-mail válido.',
      'ok',
    ]);
    expect(traduzirValidacao('nome must be a string')).toBe(
      'nome deve ser um texto.',
    );
    expect(traduzirValidacao({ a: 1 })).toEqual({ a: 1 });
  });
});
