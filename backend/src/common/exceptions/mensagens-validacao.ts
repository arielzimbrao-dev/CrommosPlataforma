/**
 * O front mostra a mensagem de qualquer 400 como veio. As mensagens padrão do
 * class-validator (e dos pipes do Nest) são em inglês; aqui elas viram pt-BR
 * num lugar só (o `AllExceptionsFilter`), sem tocar em cada DTO. Mensagem que
 * não casa (já em português, própria do DTO) fica como está.
 *
 * Casa pelo texto padrão do class-validator 0.14; se ele mudar o texto, a
 * mensagem volta a sair em inglês (o teste aponta).
 */
const REGRAS: [RegExp, string][] = [
  [/^(.+) must be an email$/, '$1 deve ser um e-mail válido.'],
  [/^(.+) must be a string$/, '$1 deve ser um texto.'],
  [/^(.+) must be an integer number$/, '$1 deve ser um número inteiro.'],
  [
    /^(.+) must be a number conforming to the specified constraints$/,
    '$1 deve ser um número.',
  ],
  [/^(.+) must be a boolean value$/, '$1 deve ser verdadeiro ou falso.'],
  [/^(.+) must be a UUID$/, '$1 deve ser um identificador válido.'],
  [
    /^(.+) must be one of the following values: (.*)$/,
    '$1 deve ser um destes valores: $2.',
  ],
  [/^(.+) must not be less than (.+)$/, '$1 não pode ser menor que $2.'],
  [/^(.+) must not be greater than (.+)$/, '$1 não pode ser maior que $2.'],
  [
    /^(.+) must be longer than or equal to (\d+) characters$/,
    '$1 deve ter no mínimo $2 caracteres.',
  ],
  [
    /^(.+) must be shorter than or equal to (\d+) characters$/,
    '$1 deve ter no máximo $2 caracteres.',
  ],
  [/^(.+) must be an array$/, '$1 deve ser uma lista.'],
  [/^All (.+)'s elements must be unique$/, '$1 não pode ter itens repetidos.'],
  [/^(.+) should not be empty$/, '$1 é obrigatório.'],
  [/^(.+) should not be null or undefined$/, '$1 é obrigatório.'],
  [/^property (.+) should not exist$/, 'O campo $1 não é permitido.'],
  [
    /^(.+) must be a valid ISO 8601 date string$/,
    '$1 deve ser uma data válida.',
  ],
  [/^(.+) must match .* regular expression$/, '$1 está em formato inválido.'],
  [
    /^(.+) must contain at least (\d+) elements$/,
    '$1 deve ter pelo menos $2 item(ns).',
  ],
  [
    /^(.+) must contain no more than (\d+) elements$/,
    '$1 deve ter no máximo $2 item(ns).',
  ],
  [/^(.+) must be equal to (.+)$/, '$1 deve ser igual a $2.'],
  [/^(.+) must be a positive number$/, '$1 deve ser positivo.'],
  [/^(.+) must be an object$/, '$1 deve ser um objeto.'],
  [/^(.+) must be a URL address$/, '$1 deve ser uma URL válida.'],
  [/^Validation failed \(uuid is expected\)$/, 'Identificador inválido.'],
  [/^(.+) must be a boolean string$/, '$1 deve ser verdadeiro ou falso.'],
  [
    /^nested property (.+) must be either object or array$/,
    '$1 deve ser um objeto ou uma lista.',
  ],
];

export function traduzirMensagem(original: string): string {
  // Campo aninhado prefixa o caminho ("adicionar.") até a mensagem
  // própria do DTO (maiúscula); a padrão (minúscula) mantém o campo.
  const msg = original.replace(/^(?:\w+\.)+(?=\p{Lu})/u, '');
  // `each: true` prefixa "each value in <campo>".
  const cada = /^each value in /.exec(msg);
  const base = cada ? msg.slice(cada[0].length) : msg;
  const regra = REGRAS.find(([re]) => re.test(base));
  const r = regra ? base.replace(regra[0], regra[1]) : base;
  return cada ? `cada item de ${r}` : r;
}

/** Traduz a `message` de um 400 (string ou lista); outros formatos passam. */
export function traduzirValidacao(message: unknown): unknown {
  if (typeof message === 'string') return traduzirMensagem(message);
  if (Array.isArray(message)) {
    return (message as unknown[]).map((m) =>
      typeof m === 'string' ? traduzirMensagem(m) : m,
    );
  }
  return message;
}
