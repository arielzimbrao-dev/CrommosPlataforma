import { iguaisEmTempoConstante, sha256 } from 'src/common/crypto/segredo';
import {
  configProduto,
  produtoDaChave,
  produtosDisponiveis,
} from 'src/common/produtos';

const K_CLINIC = 'k'.repeat(40);
const K_VET = 'v'.repeat(40);
const env = {
  CLINIC_API_URL: 'http://clinic-api:3000/ ',
  SERVICO_KEY_CLINIC: K_CLINIC,
  VET_API_URL: 'http://vet-api:3000',
  SERVICO_KEY_VET: K_VET,
  ODONTO_API_URL: 'http://odonto-api:3000', // sem chave → indisponível
};

describe('produtos', () => {
  it('configProduto: URL (sem barra final) + chave; faltando um → null', () => {
    expect(configProduto('clinic', env)).toEqual({
      produto: 'clinic',
      apiUrl: 'http://clinic-api:3000',
      chaveServico: K_CLINIC,
    });
    expect(configProduto('odonto', env)).toBeNull();
    expect(produtosDisponiveis(env).map((p) => p.produto)).toEqual([
      'clinic',
      'vet',
    ]);
  });

  it('produtoDaChave identifica o produto pela chave; errada → null', () => {
    expect(produtoDaChave(K_VET, env)).toBe('vet');
    expect(produtoDaChave(K_CLINIC, env)).toBe('clinic');
    expect(produtoDaChave('x', env)).toBeNull();
    expect(produtoDaChave(K_CLINIC, {})).toBeNull();
  });

  it('usa o process.env por padrão', () => {
    expect(configProduto('clinic')?.chaveServico).toBe(
      process.env.SERVICO_KEY_CLINIC,
    );
  });
});

describe('segredo', () => {
  it('sha256 hex e comparação em tempo constante (tamanhos diferentes também)', () => {
    expect(sha256('a')).toHaveLength(64);
    expect(iguaisEmTempoConstante('abc', 'abc')).toBe(true);
    expect(iguaisEmTempoConstante('abc', 'abcd')).toBe(false);
  });
});
