/* talgui-busca: injetor da busca inteligente da Talgui. Gerado por build/montar.cjs; nao editar. Fontes em src/motor e src/injetor. */
(function () {
'use strict';
/* ---- src/motor/motor.js ---- */
/*
 * Motor de busca puro (só funções de texto e de lista; não toca na página, na rede nem no registro do navegador).
 * Origem: runSearch, normalizeText e levenshtein do injetor publicado na Fase 1
 *   (prototipo-baseline/cdn_repo/talgui_smart_search_injector.js,
 *    sha256 62c7f247a282f30ebc43880679e7f28819233c4002730f26f0bb10178dd04d7f, conforme prototipo-baseline/MANIFESTO.json).
 * Copiado em 2026-11-12 (plano 02-01), sem mudar a lógica: a ordem dos resultados é a medida na Fase 1.
 * AVISO: a pontuação de texto segue a da Fase 1; o teste tests/unidade/motor-paridade.test.cjs trava isso (num catálogo todo em estoque e sem cor
 * nem tamanho na busca, a ordem é idêntica).
 * Ajustes pedidos pelo Danilo em 16/11/2026 (quick 20261116-ajustes-previa-ux7), todos aditivos sobre o catálogo publicado (sem campo novo):
 *   1. selos calculados aqui (Melhores Ofertas > Best Seller > Últimas Peças), ver tgSelosDaBusca;
 *   2. peça com tamanho em estoque (sz não vazio) sempre antes da esgotada;
 *   3. tons de cor equivalentes, com prioridade explícita dentro de cada grupo (azul, amarelo, verde, branco);
 *   4. rodada 2: busca por tamanho ("vestido G", "calça 42", "tam g"), Best Seller só entre as mais vendidas do resultado, grade mínima de
 *      3 tamanhos na oferta e sinônimos de categoria ("conjunto" = Look Inteiro).
 *   5. busca curada por termo (wedding/casamento) em blocos com título, ver TG_BUSCAS_CURADAS (quick 20261116-busca-curada-wedding); usa o
 *      campo opcional g (tags de ocasião) do catálogo e degrada sem ele.
 *   6. quick 20261117-basico-producao (pacote A): (a) tecidos compostos em nome ("linh" acha Linho e Viscolinho; viscose + linho), ver
 *      TG_TECIDO_PARTES; (b) esgotado nominal: com a lista enxuta de esgotados (4º argumento de runSearch, carregada sob demanda pelo injetor),
 *      "pantalo" acha a Pantalona esgotada e oferece parecidas com grade completa, ver tgBuscaEsgotado. Sem a lista, nada muda.
 * A ORDEM do array do catálogo é a ordem real de vendas/boost; ela é o ranking de "mais vendido" (campo b vem em faixas, não serve de desempate fino).
 * Os marcadores node:inicio / node:fim delimitam a exportação para o Node; o build (plano 02-04) remove esse bloco do arquivo do navegador.
 */
function normalizeText(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b, maxDist) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (Math.abs(al - bl) > maxDist) return maxDist + 1;
  let prev = [], cur = [];
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    cur[0] = i;
    let minRow = cur[0];
    for (let j = 1; j <= bl; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (cur[j] < minRow) minRow = cur[j];
    }
    if (minRow > maxDist) return maxDist + 1;
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[bl];
}

// Palavra de cor no masculino (preta -> preto, branca -> branco); qualquer outra palavra volta igual.
function tgGenero(w) {
  return Object.prototype.hasOwnProperty.call(TG_MODELO_COR_GENERO, w) ? TG_MODELO_COR_GENERO[w] : w;
}
// Formas no masculino da tabela (preto, branco...); preenchidas logo depois de TG_MODELO_COR_GENERO, mais abaixo no arquivo.
var TG_GENERO_ALVOS = {};

// Troca de duas letras vizinhas ("vsetido" = "vestido", "fromatura" = "formatura"): conta como 1 erro de digitacao (distancia de Damerau).
// So a troca: mesmo tamanho, uma posicao trocada com a seguinte e o resto igual. O levenshtein acima continua o mesmo (paridade da Fase 1).
function tgUmaTroca(a, b) {
  var n = a.length, i = 0;
  if (n < 2 || n !== b.length || a === b) return false;
  while (i < n && a.charAt(i) === b.charAt(i)) i++;
  if (i >= n - 1) return false;
  if (a.charAt(i) !== b.charAt(i + 1) || a.charAt(i + 1) !== b.charAt(i)) return false;
  return a.slice(i + 2) === b.slice(i + 2);
}

// ---------------------------------------------------------------------------------------------------------------------
// Estoque, selos, cores, tamanhos e categorias (quick 20261116-ajustes-previa-ux7). Tudo calculado do catálogo já carregado, sem campo novo.
// ---------------------------------------------------------------------------------------------------------------------

// Peça disponível = tem pelo menos um tamanho em estoque (sz não vazio). Sem sz (ex.: catálogo de esgotados, que não traz sz) = esgotada.
function tgDisponivel(item) {
  return !!(item && Array.isArray(item.sz) && item.sz.length > 0);
}

// Selo "Melhores Ofertas para {categoria}": as TG_OFERTAS_POR_CATEGORIA peças em promoção (pp < p) com MAIOR % de desconto dentro da
// categoria (campo c) da peça. Só entra peça em estoque, com desconto de pelo menos TG_OFERTAS_DESCONTO_MIN e com pelo menos
// TG_OFERTAS_MIN_TAMANHOS tamanhos em estoque (3 = grade quebrada não ganha selo de oferta). Na busca por tamanho a regra dos 3 tamanhos
// não vale (a peça só precisa ter o tamanho pedido) e o top é calculado só entre as peças com aquele tamanho.
var TG_OFERTAS_POR_CATEGORIA = 3;
var TG_OFERTAS_DESCONTO_MIN = 0.10;
var TG_OFERTAS_MIN_TAMANHOS = 3;
// Texto da categoria no selo, pela chave normalizada (sem acento, minúscula). null = essa categoria não ganha selo de oferta.
// Categoria que não está na tabela usa o próprio nome de c. Só "Look Inteiro" é singular entre os nomes de hoje.
// 16/11 (verificacao da busca-v2, achado 3): categorias de vitrine (Outlet, Ultimas Oportunidades, Novidades, Best Sellers) nao ganham selo.
var TG_OFERTAS_ROTULOS = {
  'look inteiro': 'Looks Inteiros', 'geral': null,
  'outlet': null, 'ultimas oportunidades': null, 'novidades': null, 'novidade': null, 'best sellers': null, 'best seller': null
};

// Best Seller: no máximo TG_BEST_POR_BUSCA peças por busca, as primeiras do catálogo (= mais vendidas) entre as peças em estoque com t = 1
// que aparecem no resultado daquela busca. Não é mais "toda peça t = 1".
var TG_BEST_POR_BUSCA = 3;

// Precedência dos selos (um só por peça): oferta > best seller > últimas peças (t = 4, como sempre).
var TG_SELO_BEST = 'Mais Vendidos';
var TG_SELO_ULTIMAS = 'Últimas Peças';

function tgRotuloCategoria(c) {
  var chave = normalizeText(c);
  if (!chave) return null;
  if (Object.prototype.hasOwnProperty.call(TG_OFERTAS_ROTULOS, chave)) return TG_OFERTAS_ROTULOS[chave];
  return String(c).trim();
}

function tgDesconto(item) {
  var p = item && item.p, pp = item && item.pp;
  if (typeof p !== 'number' || typeof pp !== 'number' || !(p > 0) || !(pp > 0) || !(pp < p)) return 0;
  return 1 - pp / p;
}

// Tamanhos que a busca entende. Letras e números só viram tamanho nas condições de tgTamanhoDaConsulta.
var TG_TAM_LETRAS = ['xpp', 'pp', 'p', 'm', 'g', 'gg', 'u'];
var TG_TAM_NUMERO = /^(3[2-9]|4[0-9]|50)$/;
// Palavras que anunciam um tamanho ("tam g", "tamanho 40", "numero 42", "n 42").
var TG_TAM_PALAVRAS = ['tam', 'tamanho', 'tamanhos', 'numero', 'num', 'n'];

// Equivalência letra <-> número de tamanho. VAZIA DE PROPÓSITO: a equivalência oficial da Talgui (ex.: o que é "M" em número) ainda será confirmada
// pelo Danilo. Enquanto estiver vazia, "G" acha só quem tem o tamanho "G" e "42" só quem tem o "42".
// Formato: a letra (maiúscula) aponta para os números equivalentes, e o motor vale nos dois sentidos (quem pede 38 também aceita o que a tabela
// ligar a ele). Exemplo, só ilustrativo e NÃO confirmado:  { 'PP': ['34', '36'], 'P': ['38'], 'M': ['40'], 'G': ['42'], 'GG': ['44'] }
var TG_TAMANHO_EQUIVALENTE = {};

// Catálogo de sinônimos de categoria. A busca de uma palavra da esquerda também casa com as peças da categoria da direita (nome da categoria
// normalizado), com a mesma força de um acerto de categoria. Não substitui o nome da peça: se o nome tiver a palavra, vale a pontuação de sempre.
// Avaliados em 16/11 contra o catálogo publicado (palavras que davam zero resultado): conjunto, conjuntos, looks, bermuda, bermudas, casaco, casacos.
// Já funcionam sem tabela: vestido, calça, macacão, saia, short, cropped, corset/corselet, blazer, jaqueta, camisa, colete, blusa (nome ou categoria).
var TG_CATEGORIA_SINONIMOS = {
  'conjunto': 'look inteiro',
  'conjuntos': 'look inteiro',
  'looks': 'look inteiro',
  'bermuda': 'shorts',
  'bermudas': 'shorts',
  'casaco': 'blazers e jaquetas',
  'casacos': 'blazers e jaquetas'
};

// Grupos de tons de cor (chaves já normalizadas e no masculino). A ORDEM de "v" é a prioridade dentro do grupo (a 1ª é a que vem primeiro).
// "generico" é a palavra que a cliente usa para o grupo todo ("azul"): buscar o genérico ordena pela prioridade; buscar um tom específico
// traz esse tom primeiro e depois os demais, na prioridade. Tons fora da lista principal (azul celeste, verde água...) são tons próprios no fim.
// Branco: o Off White é o "branco" atual da Talgui, por isso vem antes do Branco.
var TG_COR_GRUPOS = [
  { g: 'branco', generico: 'branco', v: ['off white', 'branco'] },
  { g: 'amarelo', generico: 'amarelo', v: ['amarelo', 'amarelo sol', 'amarelo claro', 'mostarda', 'amarelo canario', 'amarelo ouro'] },
  { g: 'azul', generico: 'azul', v: ['azul', 'azul claro', 'azul marinho', 'petroleo', 'azul jeans', 'azul celeste', 'azul bebe', 'azul royal', 'azul turquesa'] },
  { g: 'verde', generico: 'verde', v: ['verde', 'verde claro', 'verde militar', 'verde floresta', 'verde agua', 'verde limao', 'verde oliva', 'verde musgo', 'verde esmeralda', 'verde menta'] }
];
// Só na BUSCA: "jeans" sozinho vale como o tom Azul Jeans (no nome da peça, só a frase "azul jeans" conta, porque jeans também é tecido).
var TG_COR_ALIAS_CONSULTA = [{ g: 'azul', v: 'azul jeans', t: ['jeans'] }];

var TG_COR_GRUPO_POR_G = {};
var TG_COR_FRASES = (function () {
  var out = [], i, j, tk;
  for (i = 0; i < TG_COR_GRUPOS.length; i++) {
    TG_COR_GRUPO_POR_G[TG_COR_GRUPOS[i].g] = TG_COR_GRUPOS[i];
    for (j = 0; j < TG_COR_GRUPOS[i].v.length; j++) {
      tk = TG_COR_GRUPOS[i].v[j].split(' ');
      out.push({ g: TG_COR_GRUPOS[i].g, v: TG_COR_GRUPOS[i].v[j], t: tk });
    }
  }
  out.sort(function (a, b) { return b.t.length - a.t.length; }); // a frase mais longa ganha ("azul marinho" antes de "azul")
  return out;
})();
var TG_COR_FRASES_CONSULTA = TG_COR_FRASES.concat(TG_COR_ALIAS_CONSULTA);
var TG_COR_PALAVRAS = ['branco', 'amarelo', 'mostarda', 'azul', 'petroleo', 'verde'];

// Palavra de cor na forma de comparação: feminino e plural viram o masculino singular; com "tolerante", um erro de digitação
// (distância 1, palavra de 5 letras ou mais) também. Qualquer outra palavra volta como está.
function tgCanonCor(tok, tolerante) {
  var t = tok, i;
  if (t === 'azuis') return 'azul';
  if (t === 'jeans') return t; // jeans termina em s mas nao e plural
  if (t.length > 4 && t.charAt(t.length - 1) === 's') t = t.slice(0, -1);
  if (t === 'branca') return 'branco';
  if (t === 'amarela') return 'amarelo';
  if (t === 'clara') return 'claro';
  if (t === 'claros') return 'claro';
  if (tolerante && t.length >= 5) {
    for (i = 0; i < TG_COR_PALAVRAS.length; i++) {
      if (levenshtein(t, TG_COR_PALAVRAS[i], 1) <= 1) return TG_COR_PALAVRAS[i];
    }
  }
  return t;
}

// Procura frases de cor numa lista de palavras normalizadas. Devolve { g, v, ini, fim } (fim exclusivo) da primeira (ou da última, com
// "ultima") ocorrência, ou null. Cada posição tenta a frase mais longa primeiro. "frases" = TG_COR_FRASES (nome) ou TG_COR_FRASES_CONSULTA.
function tgAcharCor(palavras, tolerante, ultima, frases) {
  var canon = [], i, k, f, ok, achou = null;
  for (i = 0; i < palavras.length; i++) canon.push(tgCanonCor(palavras[i], tolerante));
  for (i = 0; i < canon.length; i++) {
    for (k = 0; k < frases.length; k++) {
      f = frases[k];
      if (i + f.t.length > canon.length) continue;
      ok = true;
      for (var j = 0; j < f.t.length; j++) { if (canon[i + j] !== f.t[j]) { ok = false; break; } }
      if (!ok) continue;
      achou = { g: f.g, v: f.v, ini: i, fim: i + f.t.length };
      if (!ultima) return achou;
      i += f.t.length - 1;
      break;
    }
  }
  return achou;
}

function tgPalavrasCor(texto) {
  return normalizeText(texto).replace(/\boffwhite\b/g, 'off white').split(' ').filter(Boolean);
}

// Cor do produto, a partir do nome (campo n). A última cor citada no nome vale ("Blusa Kairi Em Malha Amarelo"). Cada tom é identificado à parte:
// "Azul Jeans", "Azul Celeste" e "Verde Claro" não contam como o azul ou o verde puro.
function tgCorDoNome(nome) { return tgAcharCor(tgPalavrasCor(nome), false, true, TG_COR_FRASES); }

// Cor da busca: palavras já normalizadas pelo runSearch. Tolera erro de digitação na cor e "offwhite" junto.
// Devolve { g, v, ini, fim, alvo } com ini/fim em posições de qTokens (fim exclusivo); alvo = o tom que vai primeiro
// (o próprio tom pedido; na busca pelo genérico, o 1º da prioridade: "branco" -> off white).
function tgCorDaConsulta(qTokens) {
  var palavras = [], origem = [], i, achou, grupo;
  for (i = 0; i < qTokens.length; i++) {
    if (qTokens[i] === 'offwhite') { palavras.push('off', 'white'); origem.push(i, i); } else { palavras.push(qTokens[i]); origem.push(i); }
  }
  achou = tgAcharCor(palavras, true, false, TG_COR_FRASES_CONSULTA);
  if (!achou) return null;
  achou.ini = origem[achou.ini];
  achou.fim = origem[achou.fim - 1] + 1;
  grupo = TG_COR_GRUPO_POR_G[achou.g];
  achou.alvo = achou.v === grupo.generico ? grupo.v[0] : achou.v;
  return achou;
}

// Posição do tom da peça na ordem do resultado: -1 = o tom específico pedido; depois a prioridade do grupo (0, 1, 2...); 1000 = outro grupo ou sem cor.
function tgRankCor(iCor, qCor) {
  var grupo;
  if (!iCor || iCor.g !== qCor.g) return 1000;
  grupo = TG_COR_GRUPO_POR_G[qCor.g];
  if (qCor.v !== grupo.generico && iCor.v === qCor.v) return -1;
  return grupo.v.indexOf(iCor.v);
}

// Tamanho na busca. Devolve null ou { tamanhos: ['G'], resto: [palavras que sobram], consumidos: [posições] }.
// Regras: um token de tamanho (XPP PP P M G GG U, 32 a 50) só vale se (a) vem logo depois de tam/tamanho/numero ou (b) a busca tem outro termo
// além de tamanhos e dessas palavras ("vestido g", "calça 42"). "g", "p" ou "42" sozinhos continuam texto comum.
function tgTamanhoDaConsulta(qTokens) {
  var n = qTokens.length, ehTam = [], kw = [], outros = 0, algumKw = false, aceitar, i, tamanhos = [], consumidos = [], resto = [], up;
  for (i = 0; i < n; i++) ehTam.push(TG_TAM_LETRAS.indexOf(qTokens[i]) >= 0 || TG_TAM_NUMERO.test(qTokens[i]));
  for (i = 0; i < n; i++) {
    kw.push(!ehTam[i] && TG_TAM_PALAVRAS.indexOf(qTokens[i]) >= 0 && i + 1 < n && ehTam[i + 1]);
    if (kw[i]) algumKw = true;
    if (!ehTam[i] && !kw[i]) outros++;
  }
  aceitar = outros > 0 || algumKw;
  for (i = 0; i < n; i++) {
    if (ehTam[i] && (aceitar || (i > 0 && kw[i - 1]))) {
      up = qTokens[i].toUpperCase();
      if (tamanhos.indexOf(up) < 0) tamanhos.push(up);
      consumidos.push(i);
      if (i > 0 && kw[i - 1]) consumidos.push(i - 1);
    }
  }
  if (!tamanhos.length) return null;
  for (i = 0; i < n; i++) { if (consumidos.indexOf(i) < 0) resto.push(qTokens[i]); }
  return { tamanhos: tamanhos, resto: resto, consumidos: consumidos };
}

// Conjunto de tamanhos aceitos para os pedidos: os próprios mais os que a tabela TG_TAMANHO_EQUIVALENTE liga a eles, nos dois sentidos.
function tgTamanhosAceitos(pedidos) {
  var set = {}, i, k, lista, j, achou;
  for (i = 0; i < pedidos.length; i++) {
    set[pedidos[i]] = true;
    lista = TG_TAMANHO_EQUIVALENTE[pedidos[i]];
    if (Array.isArray(lista)) { for (j = 0; j < lista.length; j++) set[String(lista[j]).toUpperCase()] = true; }
  }
  for (k in TG_TAMANHO_EQUIVALENTE) {
    if (!Object.prototype.hasOwnProperty.call(TG_TAMANHO_EQUIVALENTE, k) || !Array.isArray(TG_TAMANHO_EQUIVALENTE[k])) continue;
    achou = false;
    for (j = 0; j < TG_TAMANHO_EQUIVALENTE[k].length; j++) { if (set[String(TG_TAMANHO_EQUIVALENTE[k][j]).toUpperCase()]) achou = true; }
    if (achou) set[String(k).toUpperCase()] = true;
  }
  return set;
}

function tgTemTamanho(item, set) {
  var i;
  if (!tgDisponivel(item)) return false;
  for (i = 0; i < item.sz.length; i++) { if (set[String(item.sz[i]).toUpperCase()]) return true; }
  return false;
}

// Texto da busca sem o(s) tamanho(s), com as palavras como a cliente digitou quando dá (cada palavra digitada = um token).
function tgTextoSemTamanho(query, qTokens, tam) {
  var palavras = String(query).trim().split(/\s+/), i, out = [];
  if (palavras.length === qTokens.length) {
    for (i = 0; i < palavras.length; i++) {
      if (normalizeText(palavras[i]) === qTokens[i] && tam.consumidos.indexOf(i) < 0) out.push(palavras[i]);
    }
    if (out.length === tam.resto.length) return out.join(' ');
  }
  return tam.resto.join(' ');
}

// Categoria de sinônimo para uma palavra da busca (ou null). Tolera 1 erro de digitação em palavra de 6 letras ou mais.
function tgSinonimoCategoria(qt) {
  var k;
  if (Object.prototype.hasOwnProperty.call(TG_CATEGORIA_SINONIMOS, qt)) return { cat: TG_CATEGORIA_SINONIMOS[qt], exato: true };
  if (qt.length < 6) return null;
  for (k in TG_CATEGORIA_SINONIMOS) {
    if (Object.prototype.hasOwnProperty.call(TG_CATEGORIA_SINONIMOS, k) && k.length >= 6 && (levenshtein(qt, k, 1) <= 1 || tgUmaTroca(qt, k))) return { cat: TG_CATEGORIA_SINONIMOS[k], exato: false };
  }
  return null;
}

// Selos de oferta de um catálogo (ou de um recorte dele): Map item -> { tipo: 'oferta', texto }. "filtro" (opcional) escolhe as peças do recorte
// (ex.: as que têm o tamanho pedido) e "minTam" é a grade mínima exigida.
function tgCalcOfertas(catalogo, filtro, minTam) {
  var grupos = {}, ordem = [], ofertas = new Map(), i, it, desc, rot, chave, lista, k, a, b;
  for (i = 0; i < catalogo.length; i++) {
    it = catalogo[i];
    if (!it || typeof it !== 'object') continue;
    desc = tgDesconto(it);
    if (desc < TG_OFERTAS_DESCONTO_MIN - 1e-9 || !tgDisponivel(it) || it.sz.length < minTam) continue;
    if (filtro && !filtro(it)) continue;
    rot = tgRotuloCategoria(it.c);
    if (!rot) continue;
    chave = normalizeText(it.c);
    if (!grupos[chave]) { grupos[chave] = { rotulo: rot, itens: [] }; ordem.push(chave); }
    grupos[chave].itens.push({ item: it, desc: desc, pos: i });
  }
  for (k = 0; k < ordem.length; k++) {
    lista = grupos[ordem[k]].itens;
    // maior desconto primeiro; empate: maior boost, depois a ordem do catálogo (resultado sempre igual para o mesmo catálogo)
    lista.sort(function (x, y) {
      return (y.desc - x.desc) || ((y.item.b || 0) - (x.item.b || 0)) || (x.pos - y.pos);
    });
    for (a = 0, b = Math.min(TG_OFERTAS_POR_CATEGORIA, lista.length); a < b; a++) {
      ofertas.set(lista[a].item, { tipo: 'oferta', texto: 'Melhores Ofertas para ' + grupos[ordem[k]].rotulo });
    }
  }
  return ofertas;
}

// Tecidos compostos (17/11, quick basico-producao): a palavra do nome também vale pelas partes. "Viscolinho" é viscose + linho, então quem busca
// "linho", "linh" ou "viscose" acha as peças em viscolinho (antes "linh" dava zero resultado e "linho" caía em "Vinho"). As partes entram como
// palavras extras do nome (não mudam o nome mostrado). Só acerto exato ou por prefixo; o erro de digitação só vale se a palavra digitada NÃO
// existe inteira em nenhum nome do catálogo e também não está a 1 letra de uma palavra que existe (assim "vinho" e "inho" continuam sendo só
// vinho e não puxam o viscolinho por parecerem "linho").
var TG_TECIDO_PARTES = { 'viscolinho': ['viscose', 'linho'] };

// A palavra digitada pode ser tratada como erro de digitação de uma parte de tecido? Não, se ela já é uma palavra real do catálogo ou está a 1 letra de uma.
function tgTypoLivre(qt, prep) {
  var i, lista;
  if (!prep.typoLivre) prep.typoLivre = {};
  if (Object.prototype.hasOwnProperty.call(prep.typoLivre, qt)) return prep.typoLivre[qt];
  if (prep.vocab[qt]) { prep.typoLivre[qt] = false; return false; }
  lista = prep.vocabLista || (prep.vocabLista = Object.keys(prep.vocab));
  for (i = 0; i < lista.length; i++) {
    if (levenshtein(qt, lista[i], 1) <= 1) { prep.typoLivre[qt] = false; return false; }
  }
  prep.typoLivre[qt] = true;
  return true;
}

function tgTokensVirtuais(nTokens) {
  var out = [], i, j, partes;
  for (i = 0; i < nTokens.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(TG_TECIDO_PARTES, nTokens[i])) continue;
    partes = TG_TECIDO_PARTES[nTokens[i]];
    for (j = 0; j < partes.length; j++) { if (nTokens.indexOf(partes[j]) < 0 && out.indexOf(partes[j]) < 0) out.push(partes[j]); }
  }
  return out;
}

// Prepara (uma vez por catálogo carregado) as ofertas, as cores e a posição (ranking de vendas) dos produtos. Não muda o catálogo.
var tgPreparoCache = typeof WeakMap === 'function' ? new WeakMap() : null;

function tgPreparar(catalogo) {
  var prep, i, it, cores, pos, vocab, nt, k;
  if (tgPreparoCache && catalogo && typeof catalogo === 'object') {
    prep = tgPreparoCache.get(catalogo);
    if (prep) return prep;
  }
  cores = new Map();
  pos = new Map();
  vocab = {}; // todas as palavras que existem inteiras em algum nome (qualquer estoque)
  for (i = 0; i < catalogo.length; i++) {
    it = catalogo[i];
    if (!it || typeof it !== 'object') continue;
    cores.set(it, tgCorDoNome(it.n));
    pos.set(it, i);
    nt = normalizeText(it.n).split(' ');
    for (k = 0; k < nt.length; k++) vocab[nt[k]] = true;
  }
  prep = { ofertas: tgCalcOfertas(catalogo, null, TG_OFERTAS_MIN_TAMANHOS), cores: cores, pos: pos, nicho: {}, vocab: vocab };
  if (tgPreparoCache && catalogo && typeof catalogo === 'object') tgPreparoCache.set(catalogo, prep);
  return prep;
}

// Ofertas "nichadas" para um conjunto de tamanhos: o top de cada categoria só entre as peças que têm o tamanho (sem a regra dos 3 tamanhos).
function tgOfertasDoTamanho(catalogo, prep, aceitos) {
  var chave = Object.keys(aceitos).sort().join('|');
  if (!prep.nicho[chave]) prep.nicho[chave] = tgCalcOfertas(catalogo, function (it) { return tgTemTamanho(it, aceitos); }, 1);
  return prep.nicho[chave];
}

// Selos de uma lista de peças (o resultado de uma busca): Map item -> { tipo, texto }; peça sem selo não entra. Um selo só por peça:
// oferta (a de "ofertas", que já vem calculada) > Best Seller > Últimas Peças.
// Best Seller: as TG_BEST_POR_BUSCA primeiras da lista na ordem do catálogo (ranking de vendas), em estoque, t = 1 e sem oferta.
function tgSelosDaBusca(lista, prep, ofertas) {
  var selos = new Map(), cand = [], i, it, o;
  for (i = 0; i < lista.length; i++) {
    it = lista[i];
    o = ofertas.get(it);
    if (o) selos.set(it, o);
    else if (it && it.t === 1 && tgDisponivel(it)) cand.push(it);
  }
  cand.sort(function (a, b) {
    var pa = prep.pos.has(a) ? prep.pos.get(a) : Infinity, pb = prep.pos.has(b) ? prep.pos.get(b) : Infinity;
    return pa - pb;
  });
  for (i = 0; i < cand.length && i < TG_BEST_POR_BUSCA; i++) selos.set(cand[i], { tipo: 'best', texto: TG_SELO_BEST });
  for (i = 0; i < lista.length; i++) {
    it = lista[i];
    if (it && it.t === 4 && !selos.has(it)) selos.set(it, { tipo: 'ultimas', texto: TG_SELO_ULTIMAS });
  }
  return selos;
}

// Selos do catálogo inteiro tratado como um resultado só (útil em teste e em conferência): ofertas por categoria, os 3 Best Sellers mais vendidos, últimas peças.
function tgSelosDoCatalogo(catalogo) {
  var cat = catalogo || [], prep = tgPreparar(cat);
  return tgSelosDaBusca(cat, prep, prep.ofertas);
}

// Pontuação de texto da Fase 1 (sem mudança), mais as regras de cor e de sinônimo de categoria. Devolve a lista de { item, score, d, tp, cr } já
// sem ordenar. "qTokens" e "normQ" são só o texto da busca (sem o tamanho).
function tgPontuar(qTokens, normQ, catalog, prep) {
  const qCor = tgCorDaConsulta(qTokens); // cor pedida na busca (ou null): ela só muda a ordem dentro de cada grau, ver o sort no fim
  const sinon = qTokens.map(tgSinonimoCategoria);
  const scored = [];

  for (let i = 0; i < catalog.length; i++) {
    const item = catalog[i];
    const normN = normalizeText(item.n);
    const nTokens = normN.split(' ');
    const nVirt = tgTokensVirtuais(nTokens);
    const normC = normalizeText(item.c);

    let tokenScore = 0;
    let matchedCount = 0;
    const iCor = qCor ? prep.cores.get(item) : null;
    const mesmoGrupo = !!(iCor && iCor.g === qCor.g);
    let outrosTotal = 0, outrosCasou = 0; // palavras da busca que não são a cor
    let minPts = 99; // o acerto mais fraco entre as palavras da busca (0 = alguma nao casou); so a busca com intencao usa

    for (let t = 0; t < qTokens.length; t++) {
      const qt = qTokens[t];
      const naCor = !!(qCor && t >= qCor.ini && t < qCor.fim);
      const ql = qt.length;
      let matched = false;
      let maxPts = 0;
      // cor no masculino: "preta" = "preto" vale como acerto exato (25/11, contagem de fortes); so se a palavra da busca e uma dessas cores
      const qGen = tgGenero(qt);
      const qEhGen = qGen !== qt || TG_GENERO_ALVOS[qt] === true;

      for (let n = 0; n < nTokens.length; n++) {
        const nt = nTokens[n];
        if (nt === qt || (qEhGen && tgGenero(nt) === qGen)) {
          maxPts = Math.max(maxPts, 12);
          matched = true;
          break;
        } else if (nt.startsWith(qt) || (ql >= 4 && qt.startsWith(nt))) {
          maxPts = Math.max(maxPts, 8);
          matched = true;
        } else {
          const maxD = ql <= 4 ? 1 : 2;
          const d = levenshtein(qt, nt, maxD);
          // troca de letras vizinhas ("vsetido") vale como 1 erro, igual a uma letra errada (QA 25/11, item 1.2)
          if (d === 1 || (d > 1 && ql >= 4 && tgUmaTroca(qt, nt))) { maxPts = Math.max(maxPts, 7); matched = true; }
          else if (d === 2 && ql >= 5) { maxPts = Math.max(maxPts, 4); matched = true; }
        }
      }

      // partes de tecido composto ("linho" e "viscose" em "viscolinho"): exato e prefixo sempre; erro de digitação só se a palavra não existe inteira no catálogo
      for (let v = 0; v < nVirt.length; v++) {
        const nt = nVirt[v];
        if (nt === qt) { maxPts = Math.max(maxPts, 12); matched = true; }
        else if (nt.startsWith(qt)) { maxPts = Math.max(maxPts, 8); matched = true; }
        else if (tgTypoLivre(qt, prep)) {
          if (levenshtein(qt, nt, 1) === 1) { maxPts = Math.max(maxPts, 7); matched = true; } // só 1 letra de diferença (nas partes de tecido não há a faixa de 2)
        }
      }

      if (!matched && normC && normC.includes(qt)) {
        maxPts = Math.max(maxPts, 5);
        matched = true;
      }

      // sinônimo de categoria ("conjunto" = Look Inteiro): a peça da categoria conta como acerto da palavra
      if (sinon[t] && normC === sinon[t].cat) {
        maxPts = Math.max(maxPts, sinon[t].exato ? 8 : 7);
        matched = true;
      }

      // cor equivalente (mesmo grupo): conta como acerto da palavra de cor, um pouco abaixo da cor exata
      if (naCor && mesmoGrupo) {
        maxPts = Math.max(maxPts, iCor.v === qCor.v ? 12 : 9);
        matched = true;
      }

      if (!naCor) {
        outrosTotal++;
        if (matched) outrosCasou++;
      }

      minPts = Math.min(minPts, matched ? maxPts : 0);
      if (matched) {
        tokenScore += maxPts;
        matchedCount++;
      }
    }

    const coverage = matchedCount / qTokens.length;
    if (qTokens.length > 1 && coverage < 0.5) continue;

    let phraseBonus = 0;
    if (normN.includes(normQ)) phraseBonus = 15;
    else if (normN.startsWith(normQ)) phraseBonus = 25;

    let score = (tokenScore + phraseBonus) * coverage * (item.b || 1.0);
    if (item.t === 4) score *= 0.6; // Grade quebrada desce

    if (score >= 3.0) {
      // d: em estoque (1) antes de esgotada (0). tp: a busca tem cor e a peça casou com todo o resto da busca (o tipo).
      // cr: posição do tom da peça (tgRankCor): tom pedido, depois a prioridade do grupo, depois outras cores. Sem cor na busca, tp = 1 e cr = 0 para todos.
      scored.push({
        item: item, score: score,
        d: tgDisponivel(item) ? 1 : 0,
        tp: !qCor || outrosTotal === 0 || outrosCasou === outrosTotal ? 1 : 0,
        cr: qCor ? tgRankCor(iCor, qCor) : 0,
        mp: minPts,
        cg: !qCor || mesmoGrupo ? 1 : 0 // a busca nao tem cor de grupo, ou a peca e do grupo da cor pedida
      });
    }
  }
  return scored;
}

// ---------------------------------------------------------------------------------------------------------------------
// Busca curada (quick 20261116-busca-curada-wedding, decisao do Danilo em 16/11). Alguns termos (wedding, casamento...) nao usam a ordenacao
// convencional (cor/pontuacao): o motor devolve BLOCOS com titulo, cada um com uma regra e uma ordem so de tags + estoque.
// Tudo por configuracao: para criar outro termo (formatura, reveillon) basta mais um item em TG_BUSCAS_CURADAS, sem mexer no motor.
//
// Formato de uma busca curada:
//   id      identificador do grupo (so para teste e documentacao)
//   termos  palavras que ativam o grupo (minusculas, sem acento). Tolera 1 erro de digitacao em termo de 6+ letras e prefixo de 5+ letras.
//   blocos  lista, na ordem em que aparecem. Cada bloco: { id, titulo, regra }
// Regra do bloco (todas opcionais; a peca precisa passar em todas as que existirem):
//   tags          a peca precisa ter pelo menos uma destas tags (campo g do catalogo; sem g, nenhuma peca passa)
//   priorizarTags NAO filtra: as pecas com alguma destas tags vem na frente das demais do bloco
//   categoria     texto que precisa aparecer na categoria (c) ou comecar uma palavra do nome (ex.: 'vestido')
//   cor           tom que a peca precisa ter, como esta em TG_COR_GRUPOS ('off white')
//   excluirCor    tom que tira a peca do bloco
// Ordem dentro do bloco: (1) pecas com a tag priorizada/exigida, (2) mais tamanhos em estoque (sz.length), (3) ordem do catalogo (= mais vendido).
// Peca esgotada nunca entra. Uma peca aparece em um bloco so (o primeiro que a aceita). Nao usa data de tag nem de criacao: a cada catalogo novo a
// prioridade se recalcula sozinha. Bloco vazio nao aparece; se todos ficarem vazios, a busca volta ao caminho convencional.
// ---------------------------------------------------------------------------------------------------------------------
var TG_BUSCAS_CURADAS = [
  {
    id: 'wedding',
    termos: ['wedding', 'weding', 'wedings', 'casamento', 'casamentos', 'noiva', 'noivas', 'madrinha', 'madrinhas', 'convidada', 'convidadas'],
    blocos: [
      { id: 'noivas', titulo: 'Para as Noivas', regra: { categoria: 'vestido', cor: 'off white', priorizarTags: ['wedding', 'casamento'] } },
      { id: 'convidadas', titulo: 'Para as Convidadas', regra: { tags: ['wedding', 'casamento'], excluirCor: 'off white' } }
    ]
  }
];
// Palavras que nao decidem nada na busca curada: de ligacao ("vestido DE noiva") e o tipo de peca ("VESTIDO de noiva").
var TG_CURADA_LIGACAO = ['de', 'da', 'do', 'das', 'dos', 'para', 'pra', 'pro', 'e', 'a', 'o', 'as', 'os', 'um', 'uma'];
var TG_CURADA_NEUTRAS = ['vestido', 'vestidos', 'look', 'looks', 'roupa', 'roupas', 'moda', 'peca', 'pecas'];
// Quantas pecas por bloco no maximo na pagina /search (lista "completa").
// A tag so da posicao inicial no bloco se a peca tiver pelo menos tantos tamanhos em estoque (decisao do Danilo, 17/11). Abaixo disso vai depois das demais.
var TG_CURADA_TAG_MIN_TAMANHOS = 3;
var TG_CURADA_PAGINA_LIMITE = 1000;
// Na pagina /search, esconder a lista nativa enquanto os blocos estao na tela? false = os blocos ficam no topo e a nativa continua abaixo.
var TG_CURADA_ESCONDE_NATIVO = false;

function tgTermoCurado(tok, termos) {
  var i, t;
  for (i = 0; i < termos.length; i++) {
    t = termos[i];
    if (tok === t) return true;
    if (tok.length >= 5 && t.length >= 6 && levenshtein(tok, t, 1) <= 1) return true;
    if (tok.length >= 5 && tok.length < t.length && t.indexOf(tok) === 0) return true;
  }
  return false;
}

// Grupo curado de uma busca (palavras ja normalizadas e sem o tamanho), ou null. Vale quando TODAS as palavras que sobram, sem as de ligacao e
// sem o tipo de peca, sao termos do mesmo grupo ("vestido de noiva", "casamentos", "weding", "noiva madrinha"). "vestido azul casamento" nao vale.
function tgCuradaDaConsulta(qTokens) {
  var resto = [], i, k, ok;
  for (i = 0; i < qTokens.length; i++) {
    if (TG_CURADA_LIGACAO.indexOf(qTokens[i]) < 0 && TG_CURADA_NEUTRAS.indexOf(qTokens[i]) < 0) resto.push(qTokens[i]);
  }
  if (!resto.length) return null;
  for (k = 0; k < TG_BUSCAS_CURADAS.length; k++) {
    ok = true;
    for (i = 0; i < resto.length; i++) { if (!tgTermoCurado(resto[i], TG_BUSCAS_CURADAS[k].termos)) { ok = false; break; } }
    if (ok) return TG_BUSCAS_CURADAS[k];
  }
  return null;
}

// So pelo texto (sem catalogo): a busca e curada? Usado pela pagina /search para decidir se precisa do catalogo mesmo com a lista nativa na tela.
function tgEhBuscaCurada(query) {
  var q = normalizeText(query), t, tam;
  if (!q || q.length < 2) return false;
  t = q.split(' ').filter(Boolean);
  tam = tgTamanhoDaConsulta(t);
  return !!tgCuradaDaConsulta(tam ? tam.resto : t);
}

function tgTemTag(it, lista) {
  var i;
  if (!lista || !Array.isArray(it.g)) return false;
  for (i = 0; i < lista.length; i++) { if (it.g.indexOf(lista[i]) >= 0) return true; }
  return false;
}

// Texto normalizado de cada peca (so quando ha busca curada; calculado uma vez por catalogo).
function tgNormCurada(catalogo, prep) {
  var i, it;
  if (prep.norm) return prep.norm;
  prep.norm = new Map();
  for (i = 0; i < catalogo.length; i++) {
    it = catalogo[i];
    if (it && typeof it === 'object') prep.norm.set(it, { c: normalizeText(it.c), n: normalizeText(it.n).split(' ') });
  }
  return prep.norm;
}

function tgCasaCategoria(nm, cat) {
  var i;
  if (!cat) return true;
  if (nm.c.indexOf(cat) >= 0) return true;
  for (i = 0; i < nm.n.length; i++) { if (nm.n[i].indexOf(cat) === 0) return true; }
  return false;
}

// -1 = a peca nao entra no bloco; 1 = entra e tem a tag priorizada (vai na frente); 0 = entra.
function tgBlocoCasa(it, nm, cor, regra) {
  if (regra.tags && !tgTemTag(it, regra.tags)) return -1;
  if (regra.categoria && !tgCasaCategoria(nm, normalizeText(regra.categoria))) return -1;
  if (regra.cor && !(cor && cor.v === regra.cor)) return -1;
  if (regra.excluirCor && cor && cor.v === regra.excluirCor) return -1;
  return (tgTemTag(it, regra.priorizarTags || regra.tags) && it.sz.length >= TG_CURADA_TAG_MIN_TAMANHOS) ? 1 : 0;
}

// Todos os blocos de uma busca curada, completos e ordenados: [{ id, titulo, itens, comTag }]. "aceitos" (opcional) = tamanhos pedidos.
function tgMontarBlocos(busca, catalogo, prep, aceitos) {
  var norm = tgNormCurada(catalogo, prep), usados = new Set(), out = [], b, i, it, r, lista, k, regra;
  for (b = 0; b < busca.blocos.length; b++) {
    regra = busca.blocos[b].regra || {};
    lista = [];
    for (i = 0; i < catalogo.length; i++) {
      it = catalogo[i];
      if (!it || typeof it !== 'object' || usados.has(it) || !tgDisponivel(it)) continue;
      if (aceitos && !tgTemTamanho(it, aceitos)) continue;
      r = tgBlocoCasa(it, norm.get(it), prep.cores.get(it), regra);
      if (r < 0) continue;
      lista.push({ item: it, tag: r, tam: it.sz.length, pos: i });
    }
    lista.sort(function (x, y) { return (y.tag - x.tag) || (y.tam - x.tam) || (x.pos - y.pos); });
    for (k = 0; k < lista.length; k++) usados.add(lista[k].item);
    out.push({
      id: busca.blocos[b].id, titulo: busca.blocos[b].titulo,
      itens: lista.map(function (x) { return x.item; }),
      comTag: lista.filter(function (x) { return x.tag === 1; }).length
    });
  }
  return out;
}

// Reparte o limite entre os blocos: quota igual para cada um; o que um bloco nao usa vai para os que ainda tem peca (6 em 2 blocos = 3 + 3).
function tgRepartir(tamanhos, limite) {
  var n = tamanhos.length, q = n ? Math.floor(limite / n) : 0, take = [], usado = 0, i, add;
  for (i = 0; i < n; i++) { take[i] = Math.min(q, tamanhos[i]); usado += take[i]; }
  for (i = 0; i < n && usado < limite; i++) {
    add = Math.min(limite - usado, tamanhos[i] - take[i]);
    take[i] += add;
    usado += add;
  }
  return take;
}

// Resultado da busca curada ou null (nenhum bloco com peca). Com "aceitos" tenta so as pecas com o tamanho; se nenhuma, volta ao conjunto sem filtro.
function tgBuscaCurada(busca, catalogo, prep, limite, aceitos) {
  var blocos = tgMontarBlocos(busca, catalogo, prep, aceitos), aplicado = !!aceitos, ativos, take, total = 0, flat = [], i;
  ativos = blocos.filter(function (b) { return b.itens.length > 0; });
  if (aceitos && !ativos.length) {
    aplicado = false;
    blocos = tgMontarBlocos(busca, catalogo, prep, null);
    ativos = blocos.filter(function (b) { return b.itens.length > 0; });
  }
  if (!ativos.length) return null;
  take = tgRepartir(ativos.map(function (b) { return b.itens.length; }), limite);
  ativos = ativos.map(function (b, k) {
    total += b.itens.length;
    return { id: b.id, titulo: b.titulo, itens: b.itens.slice(0, take[k]), total: b.itens.length, comTag: b.comTag };
  });
  for (i = 0; i < ativos.length; i++) flat = flat.concat(ativos[i].itens);
  return { id: busca.id, blocos: ativos, total: total, flat: flat, aplicado: aplicado };
}

// ---------------------------------------------------------------------------------------------------------------------
// Esgotado nominal (REL-04, quick basico-producao de 17/11). Quando a cliente busca pelo NOME de uma peça que está com a grade esgotada, o motor
// mostra a peça marcada "Grade esgotada" e, abaixo, peças parecidas (mesmo tipo) com grade cheia, incluindo o Best Seller do tipo.
// O catálogo de esgotados (id, n, s, c, p, i) é carregado pelo injetor SÓ quando tgPrecisaEsgotados diz que vale a pena e chega aqui já validado como
// 4º argumento de runSearch. Sem ele, nada muda. Regras (REL-03 e fail-closed):
//   1. Só palavras "nominais" pedem esgotado: 4+ letras, não numéricas, que não estão na lista de palavras genéricas (tipo de peça, cor, tecido,
//      detalhe) e que NÃO casam com nenhuma peça em estoque. "vestido", "preto", "alfaiataria" ou "blusa" nunca trazem esgotado (busca ampla).
//   2. A palavra precisa aparecer em poucas peças esgotadas (TG_ESG_FREQ_MAX); palavra que aparece em muitas é genérica por natureza.
//   3. Todas as palavras nominais da busca precisam casar com o MESMO nome esgotado. Sem casamento, o resultado é o de sempre.
//   4. Busca com tamanho ("pantalona g") e busca curada (wedding) seguem o caminho de sempre.
// "Categoria" dos similares = o tipo da peça, a primeira palavra do nome (Vestido, Calça, Blusa...). O campo c das esgotadas quase sempre é
// "Sold out" (2.312 esgotadas em 17/11: 1.576 assim), então não serve para achar similares.
// ---------------------------------------------------------------------------------------------------------------------
var TG_ESG_MAX = 3;            // peças esgotadas mostradas no máximo
var TG_ESG_SIMILARES = 12;     // similares mostrados no máximo (v14, Danilo 24/11: pelo menos 12 opções do mesmo tipo)
var TG_ESG_MIN_TAMANHOS = 3;   // grade cheia = pelo menos 3 tamanhos em estoque
var TG_ESG_FREQ_MAX = 30;      // palavra presente em mais peças esgotadas que isso é genérica demais para pedir esgotado
var TG_ESG_PALAVRA_MIN = 4;    // palavra da busca com menos letras que isso nunca pede esgotado
var TG_SELO_ESGOTADO = 'Tamanho esgotado';
// Categorias de vitrine ou de sistema que não dizem o tipo da peça (não servem para "mesma categoria" nos similares).
var TG_ESG_CATEGORIAS_IGNORADAS = ['sold out', 'outlet', 'novidades', 'novidade', 'ultimas oportunidades', 'best sellers', 'best seller', 'geral', 'queridinhos da cindy', 'kits com desconto'];
var TG_ESG_PALAVRAS_VAZIAS = ['em', 'de', 'da', 'do', 'das', 'dos', 'com', 'sem', 'que', 'um', 'uma', 'e', 'a', 'o', 'para'];

// Palavras que descrevem muitas peças e nunca identificam uma peça só (já normalizadas). O limite por frequência (TG_ESG_FREQ_MAX) cobre o que faltar.
var TG_ESG_GENERICAS = (function () {
  var lista = [
    // tipo da peça
    'vestido', 'vestidos', 'blusa', 'blusas', 'calca', 'calcas', 'corset', 'corsets', 'corselet', 'macacao', 'macacoes', 'macaquinho', 'macaquinhos',
    'cropped', 'croppeds', 'saia', 'saias', 'camisa', 'camisas', 'colete', 'coletes', 'regata', 'regatas', 'blazer', 'blazers', 'jaqueta', 'jaquetas',
    'casaco', 'casacos', 'lenco', 'lencos', 'kit', 'kits', 'body', 'short', 'shorts', 'bermuda', 'bermudas', 'conjunto', 'conjuntos', 'look', 'looks',
    'top', 'tops', 'peca', 'pecas', 'roupa', 'roupas', 'moda', 'bata', 'cardigan', 'kimono', 'tricot', 'sobretudo', 'trench',
    // cor e tom
    'preto', 'preta', 'pretos', 'pretas', 'branco', 'branca', 'brancos', 'brancas', 'off', 'white', 'offwhite', 'azul', 'azuis', 'marinho', 'petroleo',
    'celeste', 'claro', 'clara', 'claros', 'escuro', 'escura', 'vinho', 'verde', 'verdes', 'militar', 'floresta', 'agua', 'limao', 'oliva', 'musgo',
    'esmeralda', 'menta', 'amarelo', 'amarela', 'amarelos', 'mostarda', 'canario', 'ouro', 'rosa', 'rosas', 'pink', 'bege', 'marrom', 'marrons',
    'vermelho', 'vermelha', 'vermelhos', 'caramelo', 'areia', 'cinza', 'laranja', 'roxo', 'roxa', 'lilas', 'nude', 'dourado', 'dourada', 'prata',
    'terracota', 'royal', 'turquesa', 'bebe', 'sol', 'estampado', 'estampada', 'listrado', 'listrada', 'floral', 'xadrez', 'colorido', 'colorida',
    // tecido
    'alfaiataria', 'alfaitaria', 'malha', 'crepe', 'tricoline', 'bengaline', 'viscolinho', 'viscose', 'linho', 'seda', 'cetim', 'veludo', 'jeans',
    'laise', 'sarja', 'sarjada', 'jacquard', 'acetinada', 'acetinado', 'renda', 'tule', 'poa', 'moletom', 'ribana', 'jersey', 'couro', 'organza',
    'chiffon', 'cotton', 'neoprene', 'suede', 'crepom', 'gabardine', 'cambraia',
    // modelo e detalhe
    'midi', 'mini', 'maxi', 'longo', 'longa', 'curto', 'curta', 'tomara', 'caia', 'ombro', 'ombros', 'decote', 'fenda', 'assimetrico', 'assimetrica',
    'transpasse', 'manga', 'mangas', 'babados', 'ombreiras', 'lisa', 'liso', 'reta', 'reto', 'amarracao', 'alca', 'alcas', 'gola', 'botoes', 'bolso',
    'bolsos', 'cinto', 'cintura', 'flare', 'skinny', 'cargo', 'jogger', 'wide', 'slim', 'tamanho', 'tamanhos', 'numero', 'novo', 'nova', 'novos', 'novas'
  ], out = {}, i;
  for (i = 0; i < lista.length; i++) out[lista[i]] = true;
  return out;
})();

// Grau de casamento da palavra da busca (qt) com uma palavra de nome (nt): 3 igual, 2 prefixo (ou a busca é o plural da palavra do nome), 1 erro de
// digitação, 0 nada. "folgado" usa a tolerância do motor de sempre (até 2 letras de diferença com 5+ letras) e serve para dizer que JÁ existe peça em estoque
// parecida; sem "folgado" a tolerância é de 1 letra e só com 5+ letras (usado para achar a esgotada).
function tgGrauEsg(qt, nt, folgado) {
  var ql = qt.length, d;
  if (nt === qt) return 3;
  if (ql >= TG_ESG_PALAVRA_MIN && nt.indexOf(qt) === 0) return 2;
  if (ql >= TG_ESG_PALAVRA_MIN && nt.length >= TG_ESG_PALAVRA_MIN && qt.indexOf(nt) === 0) return 2;
  if (folgado) {
    d = levenshtein(qt, nt, ql <= 4 ? 1 : 2);
    if (d === 1 || (d === 2 && ql >= 5)) return 1;
  } else if (ql >= 5) {
    if (levenshtein(qt, nt, 1) === 1) return 1;
  }
  return 0;
}

// A palavra é uma palavra genérica, um pedaço dela (alfaiat) ou erro de digitação de 1 letra dela (vestdo)?
function tgEhGenerica(t) {
  var k;
  if (TG_ESG_GENERICAS[t]) return true;
  for (k in TG_ESG_GENERICAS) {
    if (Object.prototype.hasOwnProperty.call(TG_ESG_GENERICAS, k) && tgGrauEsg(t, k, false) > 0) return true;
  }
  return false;
}

// Palavras da busca que podem pedir esgotado (ver regra 1).
function tgNominaisDaConsulta(qTokens) {
  var out = [], i, t;
  for (i = 0; i < qTokens.length; i++) {
    t = qTokens[i];
    if (t.length < TG_ESG_PALAVRA_MIN || /^[0-9]+$/.test(t) || TG_CURADA_LIGACAO.indexOf(t) >= 0 || tgEhGenerica(t)) continue;
    if (out.indexOf(t) < 0) out.push(t);
  }
  return out;
}

// Palavras (únicas) dos nomes das peças em estoque, com as partes de tecido. Uma vez por catálogo.
function tgPalavrasEmEstoque(catalogo, prep) {
  var vistos = {}, lista = [], i, it, tk, k, todos;
  if (prep.palavrasEstoque) return prep.palavrasEstoque;
  for (i = 0; i < catalogo.length; i++) {
    it = catalogo[i];
    if (!it || typeof it !== 'object' || !tgDisponivel(it)) continue;
    tk = normalizeText(it.n).split(' ');
    todos = tk.concat(tgTokensVirtuais(tk));
    for (k = 0; k < todos.length; k++) { if (todos[k] && !vistos[todos[k]]) { vistos[todos[k]] = true; lista.push(todos[k]); } }
  }
  prep.palavrasEstoque = lista;
  return lista;
}

// Das palavras nominais, as que NÃO têm peça em estoque com a mesma palavra (igual ou começo dela). Devolve { palavra: grau }, grau 0 = nada parecido
// em estoque; grau 1 = só uma palavra parecida (erro de digitação: "mercia" e a "Marcia" em estoque), caso em que a esgotada só vale se casar melhor.
function tgNominaisSemEstoque(nominais, catalogo, prep) {
  var palavras = tgPalavrasEmEstoque(catalogo, prep), out = {}, i, k, g, melhor;
  for (i = 0; i < nominais.length; i++) {
    melhor = 0;
    for (k = 0; k < palavras.length && melhor < 2; k++) { g = tgGrauEsg(nominais[i], palavras[k], true); if (g > melhor) melhor = g; }
    if (melhor < 2) out[nominais[i]] = melhor;
  }
  return out;
}

// O injetor chama isto com o catálogo normal já carregado: vale a pena baixar o catálogo de esgotados para esta busca? (só texto e catálogo em estoque)
function tgPrecisaEsgotados(query, catalogo) {
  var q = normalizeText(query), qTokens, nominais;
  if (!q || q.length < 2 || !catalogo || !catalogo.length) return false;
  qTokens = q.split(' ').filter(Boolean);
  if (tgTamanhoDaConsulta(qTokens) || tgCuradaDaConsulta(qTokens)) return false;
  // promocao, ocasiao, grupo, conjunto ou palavra generica: a busca nunca pede esgotado por essas palavras (so pelo que sobra)
  var det = tgIntencaoDaConsulta(qTokens, tgPreparar(catalogo));
  if (det) qTokens = det.resto;
  nominais = tgNominaisDaConsulta(qTokens);
  if (!nominais.length) return false;
  return Object.keys(tgNominaisSemEstoque(nominais, catalogo, tgPreparar(catalogo))).length > 0;
}

// Tipo da peça = primeira palavra do nome, no singular (Vestidos/Vestido, Shorts/Short).
function tgTipoPeca(n) {
  var t = normalizeText(n).split(' ')[0] || '';
  if (t.length > 4 && t.charAt(t.length - 1) === 's') t = t.slice(0, -1);
  return t;
}

// Índice dos esgotados (uma vez por lista): palavras de cada nome e tipo. Esgotada que tem o mesmo handle de uma peça do catálogo normal é ignorada
// (peça que está no catálogo em estoque nunca pode aparecer como esgotada).
var tgEsgIdxCache = typeof WeakMap === 'function' ? new WeakMap() : null;

function tgIndiceEsgotados(esgotados, catalogo) {
  var idx, handles = {}, i, it, lista = [], tk;
  if (tgEsgIdxCache) { idx = tgEsgIdxCache.get(esgotados); if (idx && idx.cat === catalogo) return idx; }
  for (i = 0; i < catalogo.length; i++) { if (catalogo[i] && typeof catalogo[i].s === 'string') handles[catalogo[i].s] = true; }
  for (i = 0; i < esgotados.length; i++) {
    it = esgotados[i];
    if (!it || typeof it !== 'object' || typeof it.n !== 'string' || handles[it.s]) continue;
    tk = normalizeText(it.n).split(' ');
    lista.push({ item: it, tokens: tk, tipo: tgTipoPeca(it.n), ordem: i });
  }
  idx = { cat: catalogo, lista: lista };
  if (tgEsgIdxCache) tgEsgIdxCache.set(esgotados, idx);
  return idx;
}

function tgMelhorGrau(qt, tokens) {
  var g = 0, k;
  for (k = 0; k < tokens.length && g < 3; k++) { g = Math.max(g, tgGrauEsg(qt, tokens[k], false)); }
  return g;
}

// Estampas que a cor do nome nao cobre (tgFamiliaCor so conhece cores): "Animal Print", "Onça", "Poá"... (ja normalizadas).
var TG_ESG_ESTAMPAS = [['animal print', 'animal'], ['animal', 'animal'], ['onca', 'animal'], ['oncinha', 'animal'], ['zebra', 'animal'], ['leopardo', 'animal'],
  ['cobra', 'animal'], ['poa', 'poa'], ['listrado', 'listrado'], ['listrada', 'listrado'], ['xadrez', 'xadrez'], ['vichy', 'xadrez'], ['floral', 'floral'],
  ['tie dye', 'tiedye'], ['estampado', 'estampado'], ['estampada', 'estampado']];
// Comprimentos que aparecem no nome (Longo, Midi, Curto...).
var TG_ESG_COMPRIMENTOS = { longo: 'longo', longa: 'longo', maxi: 'longo', midi: 'midi', curto: 'curto', curta: 'curto', mini: 'curto' };
// "Assinatura" de cor de uma peca: familia de cor (preto, off-white...) ou estampa; '' se nao der para dizer.
function tgCorAssinatura(it) {
  var f = tgFamiliaCor(it), n, i;
  if (f && f.chave) return 'cor:' + f.chave;
  n = ' ' + normalizeText(it && it.n) + ' ';
  for (i = 0; i < TG_ESG_ESTAMPAS.length; i++) { if (n.indexOf(' ' + TG_ESG_ESTAMPAS[i][0] + ' ') >= 0) return 'est:' + TG_ESG_ESTAMPAS[i][1]; }
  return '';
}
function tgComprimentoDoNome(tokens) {
  var i;
  for (i = 0; i < tokens.length; i++) { if (Object.prototype.hasOwnProperty.call(TG_ESG_COMPRIMENTOS, tokens[i])) return TG_ESG_COMPRIMENTOS[tokens[i]]; }
  return '';
}
// Peças parecidas em estoque para uma esgotada (v14, Danilo 24/11). So do MESMO tipo (vestido esgotado = so vestidos) e com grade cheia
// (TG_ESG_MIN_TAMANHOS ou mais tamanhos em estoque). Ordem:
//   1. mesma cor ou estampa (Animal Print) e mesmo comprimento; 2. mesma cor ou estampa; 3. mesmo comprimento com outras palavras do nome em comum;
//   4. o resto do tipo, na ordem de vendas, puxando primeiro cores que ainda nao apareceram (a lista sai com cores diferentes).
// Um modelo entra uma vez so (o "Vestido Alexandra" nao repete em duas cores). Ate "max" pecas (padrao TG_ESG_SIMILARES).
function tgSimilaresEsgotada(esg, catalogo, prep, max) {
  var tipo = esg.tipo, cand = [], melhor = null, ref, assin, comp, i, it, nm, comum, k, sc, out = [], mods = {}, cores = {}, N, passo, mod, a;
  N = typeof max === 'number' && max > 0 ? max : TG_ESG_SIMILARES;
  if (!tipo) return { itens: [], melhor: null };
  ref = esg.tokens.filter(function (t, n) { return n > 1 && TG_ESG_PALAVRAS_VAZIAS.indexOf(t) < 0; });
  assin = tgCorAssinatura(esg.item);
  comp = tgComprimentoDoNome(esg.tokens);
  for (i = 0; i < catalogo.length; i++) {
    it = catalogo[i];
    if (!it || typeof it !== 'object' || !tgDisponivel(it) || !Array.isArray(it.sz) || it.sz.length < TG_ESG_MIN_TAMANHOS || tgTipoPeca(it.n) !== tipo) continue;
    nm = normalizeText(it.n).split(' ');
    a = tgCorAssinatura(it);
    comum = 0;
    for (k = 0; k < ref.length; k++) { if (nm.indexOf(ref[k]) >= 0) comum++; }
    sc = 0;
    if (assin && a === assin) sc += 100;
    if (comp && tgComprimentoDoNome(nm) === comp) sc += 10;
    if (sc > 0) sc += comum;
    cand.push({ item: it, sc: sc, pos: i, cor: a, mod: normalizeText(tgModeloCor(it.n).modelo) });
    if (!melhor && it.t === 1) melhor = it;
  }
  cand.sort(function (x, y) { return (y.sc - x.sc) || (x.pos - y.pos); });
  // os parecidos de verdade (pontos > 0) entram na ordem dos pontos; o resto completa com cores novas primeiro
  for (i = 0; i < cand.length && out.length < N; i++) {
    if (cand[i].sc <= 0) break;
    if (mods[cand[i].mod]) continue;
    out.push(cand[i].item); mods[cand[i].mod] = true; if (cand[i].cor) cores[cand[i].cor] = true;
  }
  for (passo = 0; passo < 2 && out.length < N; passo++) {
    for (i = 0; i < cand.length && out.length < N; i++) {
      mod = cand[i].mod;
      if (mods[mod] || out.indexOf(cand[i].item) >= 0) continue;
      if (passo === 0 && cand[i].cor && cores[cand[i].cor]) continue;
      out.push(cand[i].item); mods[mod] = true; if (cand[i].cor) cores[cand[i].cor] = true;
    }
  }
  return { itens: out, melhor: out.indexOf(melhor) >= 0 ? melhor : null };
}

// Categoria da loja de cada tipo de peca (botao "Mais opções de Vestidos" da esgotada). Tipo sem categoria = null (a tela usa a busca do tipo).
var TG_TIPO_CATEGORIA = { vestido: ['/vestidos/', 'Vestidos'], blusa: ['/blusas/', 'Blusas'], calca: ['/calcas/', 'Calças'], saia: ['/saias/', 'Saias'],
  macacao: ['/macacoes/', 'Macacões'], cropped: ['/croppeds/', 'Croppeds'], short: ['/shorts/', 'Shorts'] };
function tgCategoriaDoTipo(tipo) {
  var c = Object.prototype.hasOwnProperty.call(TG_TIPO_CATEGORIA, tipo) ? TG_TIPO_CATEGORIA[tipo] : null;
  return c ? { url: c[0], rotulo: c[1] } : null;
}

// Resultado de esgotado nominal ou null. Devolve o mesmo formato do runSearch, mais { esgotado: { itens, similares, melhor, tipo, nominais } }.
function tgBuscaEsgotado(qTokens, catalogo, prep, esgotados, limite) {
  var nominais = tgNominaisDaConsulta(qTokens), semEstoque, pedem, idx, cand, i, qt, minGrau, todos, n, rank, itens, sim, nEsg, nSim, res, selos, k;
  if (!nominais.length) return null;
  semEstoque = tgNominaisSemEstoque(nominais, catalogo, prep);
  pedem = Object.keys(semEstoque);
  if (!pedem.length) return null;
  idx = tgIndiceEsgotados(esgotados, catalogo);
  cand = idx.lista;
  function casa(minimo, qtx) { return function (e) { return tgMelhorGrau(qtx, e.tokens) >= minimo; }; }
  for (i = 0; i < nominais.length; i++) {
    qt = nominais[i];
    if (Object.prototype.hasOwnProperty.call(semEstoque, qt)) {
      // sem peça em estoque com a palavra (grau 0) a esgotada pode casar até com 1 letra de erro; se só há uma parecida em estoque (grau 1, "Marcia"),
      // a esgotada precisa casar melhor (igual ou começo da palavra, "Mércia")
      minGrau = semEstoque[qt] === 0 ? 1 : 2;
      todos = cand.filter(casa(minGrau, qt));
      if (!todos.length) return null; // nenhuma esgotada tem a palavra junto com as outras: segue a busca de sempre
      n = idx.lista.filter(casa(minGrau, qt)).length;
      if (n > TG_ESG_FREQ_MAX) { delete semEstoque[qt]; continue; } // genérica demais para identificar uma peça: não pede esgotado
      cand = todos;
    } else {
      todos = cand.filter(casa(1, qt));
      n = idx.lista.filter(casa(1, qt)).length;
      if (todos.length && n <= TG_ESG_FREQ_MAX) cand = todos; // existe em estoque e também identifica a esgotada: estreita
    }
  }
  if (!Object.keys(semEstoque).length || !cand.length) return null;
  rank = cand.map(function (e) {
    var s = 0, j;
    for (j = 0; j < qTokens.length; j++) { if (qTokens[j].length >= 3) s += tgMelhorGrau(qTokens[j], e.tokens); }
    return { e: e, s: s };
  });
  rank.sort(function (a, b) { return (b.s - a.s) || (a.e.ordem - b.e.ordem); });
  nEsg = Math.min(rank.length, TG_ESG_MAX, Math.max(1, limite - 3));
  itens = rank.slice(0, nEsg).map(function (r) { return r.e.item; });
  sim = tgSimilaresEsgotada(rank[0].e, catalogo, prep);
  // v14: a esgotada vira so uma frase na tela; os similares podem ocupar o limite inteiro
  nSim = Math.max(0, Math.min(sim.itens.length, TG_ESG_SIMILARES, limite));
  sim = { itens: sim.itens.slice(0, nSim), melhor: sim.itens.slice(0, nSim).indexOf(sim.melhor) >= 0 ? sim.melhor : null };
  selos = new Map();
  for (k = 0; k < itens.length; k++) selos.set(itens[k], { tipo: 'esgotado', texto: TG_SELO_ESGOTADO });
  for (k = 0; k < sim.itens.length; k++) {
    if (sim.itens[k] === sim.melhor) selos.set(sim.itens[k], { tipo: 'best', texto: TG_SELO_BEST });
    else if (prep.ofertas.get(sim.itens[k])) selos.set(sim.itens[k], prep.ofertas.get(sim.itens[k]));
  }
  res = {
    results: itens.concat(sim.itens), suggestedTerm: null, selos: selos, tamanho: null, fortes: itens.length, fortesTotal: itens.length,
    esgotado: { itens: itens, similares: sim.itens, melhor: sim.melhor, tipo: rank[0].e.tipo, nominais: Object.keys(semEstoque) }
  };
  return res;
}

// ---------------------------------------------------------------------------------------------------------------------
// Intencao da busca (QA do Danilo, 25/11, itens 1.1, 1.4 e 1.5). Palavras de promocao, ocasiao, estacao, grupo de peca e conjunto sao
// reconhecidas ANTES do erro de digitacao, para nunca virarem nome de modelo ou cor: "verao" nao e a Calca Vera, "oferta" nao e o Macacao Ofelia,
// "black november" nao e a Calca Blair, "natal" nao e a Natalia, "festa" nao e "fenda", "roupa de baixo" nao e "rosa".
// Como funciona:
//   1. Cada palavra da busca e comparada com os termos das tabelas abaixo: igual sempre vale; comeco de termo (5+ letras, "promo", "forma") e
//      1 erro de digitacao (6+ letras, inclusive troca de letras vizinhas) so valem se a palavra NAO existe (nem como comeco) em nenhum nome do
//      catalogo. Assim o nome de uma peca nunca e engolido por uma intencao.
//   2. Com intencao, as palavras de ligacao (de, para, com...) e as genericas (roupa, peca, parte, look...) saem; o que sobra ("vestido" em
//      "vestido promocao") estreita a selecao pela pontuacao de sempre. Se o que sobra nao casa com nenhuma peca da selecao, vale a busca comum
//      dessas palavras.
//   3. Sem intencao, mas com palavra generica (roupa, peca, parte, moda): ela sai da busca. So ela ("roupa") = mais vendidos.
//   4. Casamento, madrinha, noiva e convidada continuam na busca curada (TG_BUSCAS_CURADAS e tgSelecaoVestidos); nada aqui muda isso.
// O resultado traz intencao: { tipo, id, titulo, total, resto, aplicado } para a tela mostrar um titulo ("Peças em promoção").
// ---------------------------------------------------------------------------------------------------------------------

// Promocao: pecas com preco promocional (pp < p), da maior % de desconto para a menor e, no empate, a mais vendida (b) primeiro.
var TG_INTENCAO_PROMO = {
  id: 'promocao', titulo: 'Peças em promoção',
  termos: ['promocao', 'promocoes', 'promo', 'promos', 'oferta', 'ofertas', 'desconto', 'descontos', 'sale', 'liquidacao', 'liquida', 'queima',
    'black', 'friday', 'blackfriday', 'november', 'novembro', 'blacknovember', 'cyber', 'barato', 'barata', 'baratos', 'baratas', 'baratinho', 'saldao']
};

// Conjunto (item 1.4): pecas de cima e de baixo (nunca vestido, macacao ou macaquinho). A tela mostra os pares reais do Recom; aqui o motor
// devolve 1) pecas com "Conjunto"/"Kit" no comeco do nome, 2) pares de peca de cima + peca de baixo da mesma familia de cor com 3+ tamanhos em comum,
// 3) o resto das pecas de cima e de baixo, intercaladas. Sem nenhuma peca de cima ou de baixo, vale o sinonimo antigo (Look Inteiro).
var TG_INTENCAO_CONJUNTO = {
  id: 'conjunto', titulo: 'Conjuntos',
  termos: ['conjunto', 'conjuntos', 'conjuntinho', 'conjuntinhos'],
  frases: [['look', 'completo'], ['looks', 'completos'], ['look', 'combinando'], ['looks', 'combinando'], ['looks', 'completo']],
  nomes: ['conjunto', 'conjuntos', 'kit'],
  cima: ['blusa', 'blusas', 'cropped', 'croppeds', 'regata', 'regatas', 'corset', 'camisa', 'body', 'top', 'colete', 'blazer'],
  baixo: ['calca', 'calcas', 'saia', 'saias', 'shorts', 'short', 'bermuda']
};

// Grupos de peca: "roupa de baixo", "partes de baixo", "peca de cima"... (tipo = 1a palavra do nome, sem acento). Ordem = mais vendidas.
var TG_INTENCAO_GRUPOS = [
  { id: 'partes-de-baixo', titulo: 'Partes de baixo', termos: ['baixo'], tipos: ['calca', 'calcas', 'saia', 'saias', 'shorts', 'short', 'bermuda'] },
  { id: 'partes-de-cima', titulo: 'Partes de cima', termos: ['cima'], tipos: ['blusa', 'blusas', 'cropped', 'croppeds', 'regata', 'regatas', 'corset', 'camisa', 'body', 'top', 'colete', 'blazer'] }
];

// OCASIOES E ESTACOES. PROPOSTA para o Danilo validar (o catalogo ainda nao tem tags de ocasiao; quando tiver, a tag entra aqui).
// Para ajustar, basta editar a tabela. Campos:
//   id, titulo   identificador e titulo que a tela pode mostrar
//   termos       palavras que ativam (minusculas, sem acento); frases = varias palavras em sequencia (["ano", "novo"])
//   faixas       lista em ordem de prioridade. A peca entra na PRIMEIRA faixa que aceitar. Faixa:
//                  tipos    tipos de peca aceitos (1a palavra do nome: vestido, blusa, calca, saia, shorts, cropped, regata, macacao, camisa...);
//                           sem tipos = qualquer peca
//                  nome     palavras (ou frases) que precisam estar no nome
//                  cores    cores aceitas (a cor do fim do nome, no masculino: 'vermelho', 'off white', 'verde militar'); "verde" NAO inclui
//                           "verde claro" (cada tom e escrito a parte)
//                           com nome E cores, basta um dos dois; sem nenhum dos dois, todo o tipo entra
//                  prefira  palavras que sobem a peca dentro da faixa (nao filtram)
//   excluir      palavras do nome que tiram a peca da ocasiao
//   intercalar   true = as faixas se alternam (1a da faixa 1, 1a da faixa 2, ...); false = faixa 1 inteira antes da 2
// Dentro de cada faixa: mais palavras de "prefira" primeiro, depois a ordem do catalogo (= mais vendidas). Peca sem estoque nunca entra.
var TG_OCASIOES = [
  { id: 'festa', titulo: 'Para festas', termos: ['festa', 'festas', 'balada', 'baladas', 'evento', 'eventos'],
    faixas: [
      { tipos: ['vestido'], nome: ['longo', 'longa', 'maxi', 'midi', 'veludo', 'tule', 'cetim', 'acetinado', 'acetinada', 'brilho', 'paete', 'lurex', 'fenda',
        'tomara que caia', 'um ombro', 'assimetrico', 'assimetrica'], prefira: ['longo', 'longa', 'veludo', 'tule', 'cetim', 'brilho', 'paete', 'fenda'] },
      { tipos: ['vestido'] }
    ],
    excluir: ['malha', 'tricoline', 'moletom', 'jeans'] },
  { id: 'formatura', titulo: 'Para formatura', termos: ['formatura', 'formaturas', 'colacao', 'baile', 'gala'],
    faixas: [
      { tipos: ['vestido'], nome: ['longo', 'longa', 'maxi'] },
      { tipos: ['vestido'], nome: ['midi'], prefira: ['veludo', 'tule', 'cetim', 'acetinado', 'fenda', 'um ombro', 'tomara que caia', 'alfaiataria'] }
    ],
    excluir: ['malha', 'tricoline', 'moletom', 'jeans', 'curto', 'mini'] },
  { id: 'reveillon', titulo: 'Para o Réveillon', termos: ['reveillon', 'reveilon', 'reveion', 'virada'], frases: [['ano', 'novo'], ['fim', 'de', 'ano']],
    faixas: [
      { tipos: ['vestido'], cores: ['off white', 'branco', 'white'] },
      { cores: ['off white', 'branco', 'white'] },
      { cores: ['dourado', 'prata'] }
    ] },
  { id: 'natal', titulo: 'Para o Natal', termos: ['natal', 'natalino', 'natalina', 'natalinos', 'natalinas', 'ceia'],
    faixas: [
      { tipos: ['vestido'], cores: ['vermelho', 'verde', 'verde militar', 'verde floresta', 'verde esmeralda', 'verde musgo', 'verde oliva', 'dourado', 'vinho'], nome: ['veludo'], prefira: ['veludo'] },
      { cores: ['vermelho', 'verde', 'verde militar', 'verde floresta', 'verde esmeralda', 'verde musgo', 'verde oliva', 'dourado', 'vinho'], nome: ['veludo'], prefira: ['veludo'] }
    ] },
  { id: 'jantar', titulo: 'Para um jantar', termos: ['jantar', 'jantares', 'restaurante', 'encontro'],
    faixas: [
      { tipos: ['vestido'], nome: ['midi', 'curto', 'mini'], prefira: ['alfaiataria', 'veludo', 'crepe'] },
      { tipos: ['blusa', 'calca', 'saia', 'colete', 'blazer', 'cropped', 'corset', 'shorts', 'camisa'], nome: ['alfaiataria'] }
    ],
    excluir: ['moletom'], intercalar: true },
  { id: 'trabalho', titulo: 'Para o trabalho', termos: ['trabalho', 'trabalhar', 'escritorio', 'office', 'corporativo', 'corporativa', 'social', 'reuniao', 'entrevista', 'executiva'],
    faixas: [
      { tipos: ['calca', 'blusa', 'camisa', 'colete', 'blazer', 'saia', 'vestido'], nome: ['alfaiataria'] },
      { tipos: ['camisa', 'calca', 'blusa', 'colete', 'blazer'] }
    ],
    excluir: ['tule', 'veludo', 'paete', 'brilho', 'tomara que caia'] },
  // Estacoes (proposta): pecas leves no verao, veludo/manga longa/blazer no inverno.
  { id: 'verao', titulo: 'Para o verão', termos: ['verao', 'praia', 'calor', 'ferias', 'resort'],
    faixas: [
      { tipos: ['vestido'], nome: ['curto', 'mini', 'tricoline', 'viscolinho', 'linho', 'alca', 'alcas', 'alcinha'] },
      { tipos: ['shorts', 'short', 'regata', 'cropped', 'body', 'top'] },
      { tipos: ['blusa', 'saia', 'macaquinho'], nome: ['tricoline', 'viscolinho', 'linho', 'manga curta', 'alca', 'alcas', 'alcinha', 'regata', 'tomara que caia'] }
    ],
    excluir: ['veludo', 'manga longa', 'tricot', 'trico', 'moletom'], intercalar: true },
  { id: 'inverno', titulo: 'Para o inverno', termos: ['inverno', 'frio'],
    faixas: [
      { nome: ['veludo', 'manga longa', 'tricot', 'trico'] },
      { tipos: ['blazer', 'jaqueta', 'casaco'] }
    ] }
];

// Palavras que saem da busca quando ha intencao. As "genericas" tambem saem sem intencao ("roupa preta" = "preta"); "look" so sai com intencao.
var TG_INTENCAO_LIGACAO = ['de', 'da', 'do', 'das', 'dos', 'para', 'pra', 'pro', 'e', 'a', 'o', 'as', 'os', 'um', 'uma', 'com', 'em', 'na', 'no', 'nas', 'nos'];
var TG_INTENCAO_GENERICAS = ['roupa', 'roupas', 'roupinha', 'roupinhas', 'peca', 'pecas', 'pecinha', 'pecinhas', 'parte', 'partes', 'moda'];
var TG_INTENCAO_NEUTRAS = TG_INTENCAO_GENERICAS.concat(['look', 'looks', 'feminina', 'feminino', 'femininas', 'femininos', 'mulher', 'mulheres', 'estoque']);
var TG_INTENCAO_GENERICO_TITULO = 'Mais vendidos';

// Todas as intencoes, na ordem de prioridade (a 1a que casar com a palavra fica com ela).
function tgListaIntencoes() {
  var out = [{ tipo: 'conjunto', def: TG_INTENCAO_CONJUNTO }], i;
  for (i = 0; i < TG_INTENCAO_GRUPOS.length; i++) out.push({ tipo: 'grupo', def: TG_INTENCAO_GRUPOS[i] });
  for (i = 0; i < TG_OCASIOES.length; i++) out.push({ tipo: 'ocasiao', def: TG_OCASIOES[i] });
  out.push({ tipo: 'promo', def: TG_INTENCAO_PROMO });
  return out;
}

// A palavra existe inteira, ou como comeco, em algum nome do catalogo? (uma vez por palavra e catalogo)
function tgPalavraDoCatalogo(tok, prep) {
  var lista, i, achou = false;
  if (!prep) return false;
  if (!prep.palavraCat) prep.palavraCat = {};
  if (Object.prototype.hasOwnProperty.call(prep.palavraCat, tok)) return prep.palavraCat[tok];
  if (prep.vocab[tok]) achou = true;
  else {
    lista = prep.vocabLista || (prep.vocabLista = Object.keys(prep.vocab));
    for (i = 0; i < lista.length; i++) { if (lista[i].indexOf(tok) === 0) { achou = true; break; } }
  }
  prep.palavraCat[tok] = achou;
  return achou;
}

// A palavra digitada vale pelo termo? Igual sempre; comeco (5+ letras) e 1 erro (6+ letras) so se a palavra nao for de nenhum nome do catalogo.
function tgCasaTermo(tok, termo, prep) {
  if (tok === termo) return true;
  if (tok.length < 5) return false;
  if (tgPalavraDoCatalogo(tok, prep)) return false;
  if (termo.length > tok.length && termo.indexOf(tok) === 0) return true;
  if (tok.length >= 6 && termo.length >= 6 && (levenshtein(tok, termo, 1) <= 1 || tgUmaTroca(tok, termo))) return true;
  return false;
}

// Intencoes de uma busca (palavras ja normalizadas e sem o tamanho). prep (opcional) liga a protecao dos nomes do catalogo.
// Devolve null (nada a fazer) ou { achadas: [{ tipo, def }], resto: [palavras que sobram], genericas: n }.
function tgIntencaoDaConsulta(qTokens, prep) {
  var lista = tgListaIntencoes(), usados = [], achadas = [], resto = [], genericas = 0, i, k, j, f, n, ok, t;
  function anotar(x) { if (achadas.indexOf(x) < 0) achadas.push(x); }
  for (i = 0; i < qTokens.length; i++) usados.push(false);
  for (k = 0; k < lista.length; k++) {
    if (!lista[k].def.frases) continue;
    for (j = 0; j < lista[k].def.frases.length; j++) {
      f = lista[k].def.frases[j];
      for (i = 0; i + f.length <= qTokens.length; i++) {
        ok = true;
        for (n = 0; n < f.length; n++) { if (usados[i + n] || qTokens[i + n] !== f[n]) { ok = false; break; } }
        if (!ok) continue;
        for (n = 0; n < f.length; n++) usados[i + n] = true;
        anotar(lista[k]);
      }
    }
  }
  for (i = 0; i < qTokens.length; i++) {
    t = qTokens[i];
    if (usados[i] || TG_INTENCAO_LIGACAO.indexOf(t) >= 0 || TG_INTENCAO_NEUTRAS.indexOf(t) >= 0) continue;
    for (k = 0; k < lista.length && !usados[i]; k++) {
      for (j = 0; j < lista[k].def.termos.length; j++) {
        if (tgCasaTermo(t, lista[k].def.termos[j], prep)) { usados[i] = true; anotar(lista[k]); break; }
      }
    }
  }
  for (i = 0; i < qTokens.length; i++) { if (TG_INTENCAO_GENERICAS.indexOf(qTokens[i]) >= 0) genericas++; }
  if (!achadas.length && !genericas) return null;
  for (i = 0; i < qTokens.length; i++) {
    t = qTokens[i];
    if (usados[i] || TG_INTENCAO_LIGACAO.indexOf(t) >= 0 || TG_INTENCAO_NEUTRAS.indexOf(t) >= 0) continue;
    resto.push(t);
  }
  return { achadas: achadas, resto: resto, genericas: genericas };
}

// Texto de comparacao de uma peca: tipo (1a palavra), nome com as cores no masculino (' blusa benita preto ') e a cor do fim do nome.
function tgInfoIntencao(it, prep) {
  var info, tk, i, cor;
  if (!prep.infoInt) prep.infoInt = new Map();
  info = prep.infoInt.get(it);
  if (info) return info;
  tk = normalizeText(it.n).replace(/\boffwhite\b/g, 'off white').split(' ');
  for (i = 0; i < tk.length; i++) { if (Object.prototype.hasOwnProperty.call(TG_MODELO_COR_GENERO, tk[i])) tk[i] = TG_MODELO_COR_GENERO[tk[i]]; }
  cor = tgPalavrasCor(tgModeloCor(it.n).cor).map(function (w) { return TG_MODELO_COR_GENERO[w] || w; }).join(' ');
  info = { tipo: tk[0] || '', txt: ' ' + tk.join(' ') + ' ', cor: cor };
  prep.infoInt.set(it, info);
  return info;
}
function tgTemAlguma(info, lista) {
  var i;
  if (!lista) return false;
  for (i = 0; i < lista.length; i++) { if (info.txt.indexOf(' ' + lista[i] + ' ') >= 0) return true; }
  return false;
}
function tgContaAlgumas(info, lista) {
  var i, n = 0;
  if (!lista) return 0;
  for (i = 0; i < lista.length; i++) { if (info.txt.indexOf(' ' + lista[i] + ' ') >= 0) n++; }
  return n;
}
function tgCorCasa(info, cores) {
  var i;
  if (!cores) return false;
  for (i = 0; i < cores.length; i++) {
    if (info.cor ? info.cor === cores[i] : info.txt.indexOf(' ' + cores[i] + ' ') >= 0) return true;
  }
  return false;
}
function tgFaixaCasa(info, f) {
  if (f.tipos && f.tipos.indexOf(info.tipo) < 0) return false;
  if (!f.nome && !f.cores) return true;
  return tgTemAlguma(info, f.nome) || tgCorCasa(info, f.cores);
}

// Selecao (ordenada) de uma intencao no catalogo; uma vez por catalogo e intencao.
function tgPoolIntencao(x, catalog, prep) {
  var chave = x.tipo + ':' + x.def.id, out;
  if (!prep.poolInt) prep.poolInt = {};
  if (prep.poolInt[chave]) return prep.poolInt[chave];
  if (x.tipo === 'promo') out = tgPoolPromo(catalog);
  else if (x.tipo === 'grupo') out = catalog.filter(function (it) { return it && typeof it.n === 'string' && tgDisponivel(it) && x.def.tipos.indexOf(tgInfoIntencao(it, prep).tipo) >= 0; });
  else if (x.tipo === 'conjunto') out = tgPoolConjunto(x.def, catalog, prep);
  else out = tgPoolOcasiao(x.def, catalog, prep);
  prep.poolInt[chave] = out;
  return out;
}
function tgPoolPromo(catalog) {
  var v = [], i, it;
  for (i = 0; i < catalog.length; i++) { it = catalog[i]; if (it && typeof it.n === 'string' && tgDisponivel(it) && tgDesconto(it) > 0) v.push({ it: it, d: tgDesconto(it), pos: i }); }
  v.sort(function (a, b) { return (b.d - a.d) || ((b.it.b || 0) - (a.it.b || 0)) || (a.pos - b.pos); });
  return v.map(function (x) { return x.it; });
}
function tgPoolConjunto(def, catalog, prep) {
  var nomeados = [], cima = [], baixo = [], out = [], usados = new Set(), i, it, tipo, fa, k, b, ri, rj;
  for (i = 0; i < catalog.length; i++) {
    it = catalog[i];
    if (!it || typeof it.n !== 'string' || !tgDisponivel(it)) continue;
    tipo = tgInfoIntencao(it, prep).tipo;
    if (def.nomes.indexOf(tipo) >= 0) nomeados.push(it);
    else if (def.cima.indexOf(tipo) >= 0) cima.push({ it: it, f: tgFamiliaCor(it) });
    else if (def.baixo.indexOf(tipo) >= 0) baixo.push({ it: it, f: tgFamiliaCor(it) });
  }
  out = nomeados.slice();
  // pares: peca de cima (na ordem de vendas) + a peca de baixo mais vendida ainda livre da mesma familia de cor, com 3+ tamanhos em comum
  for (i = 0; i < cima.length; i++) {
    fa = cima[i].f;
    if (!fa) continue;
    for (k = 0; k < baixo.length; k++) {
      b = baixo[k];
      if (usados.has(b.it) || !b.f || b.f.chave !== fa.chave) continue;
      if (tgTapeteComuns(cima[i].it.sz, b.it.sz).length < TG_TAPETE_MIN_TAMANHOS) continue;
      out.push(cima[i].it, b.it); usados.add(cima[i].it); usados.add(b.it);
      break;
    }
  }
  // o resto, intercalado (cima, baixo, cima...)
  for (ri = 0, rj = 0; ri < cima.length || rj < baixo.length;) {
    while (ri < cima.length && usados.has(cima[ri].it)) ri++;
    if (ri < cima.length) { out.push(cima[ri].it); ri++; }
    while (rj < baixo.length && usados.has(baixo[rj].it)) rj++;
    if (rj < baixo.length) { out.push(baixo[rj].it); rj++; }
  }
  return out;
}
function tgPoolOcasiao(def, catalog, prep) {
  var faixas = def.faixas || [], por = [], i, k, it, info, termoNoNome, out = [], rodada, algum;
  for (k = 0; k < faixas.length; k++) por.push([]);
  for (i = 0; i < catalog.length; i++) {
    it = catalog[i];
    if (!it || typeof it.n !== 'string' || !tgDisponivel(it)) continue;
    info = tgInfoIntencao(it, prep);
    if (tgTemAlguma(info, def.excluir)) continue;
    for (k = 0; k < faixas.length; k++) {
      if (!tgFaixaCasa(info, faixas[k])) continue;
      termoNoNome = tgTemAlguma(info, def.termos) ? 100 : 0; // peca com a propria palavra no nome ("Vestido Festa") vem na frente
      por[k].push({ it: it, pts: termoNoNome + tgContaAlgumas(info, faixas[k].prefira), pos: i });
      break;
    }
  }
  for (k = 0; k < por.length; k++) por[k].sort(function (a, b) { return (b.pts - a.pts) || (a.pos - b.pos); });
  if (def.intercalar) {
    for (rodada = 0; ; rodada++) {
      algum = false;
      for (k = 0; k < por.length; k++) { if (por[k].length > rodada) { out.push(por[k][rodada].it); algum = true; } }
      if (!algum) break;
    }
  } else {
    for (k = 0; k < por.length; k++) for (i = 0; i < por[k].length; i++) out.push(por[k][i].it);
  }
  return out;
}

// Resultado da busca com intencao, ou null (sem intencao: segue o caminho de sempre). Mesmo formato do runSearch, mais "intencao".
function tgBuscaIntencao(query, qTokens, catalog, prep, limit, tam, aceitos, textoSemTam, esgotados) {
  var det = tgIntencaoDaConsulta(qTokens, prep), prim = null, pool, outros, i, k, lista, pontuados, casou, base, consultaResto, info, tamanho = null, comTam, top, ofertas;
  if (!det) return null;
  consultaResto = det.resto.concat(tam ? tam.tamanhos.map(function (x) { return x.toLowerCase(); }) : []).join(' ');
  if (!det.achadas.length) {
    // so palavra generica: "roupa preta" = "preta"; "roupa" sozinha = mais vendidas
    if (det.resto.length) { base = tgBuscaBase(consultaResto, catalog, limit, esgotados); base.query = query; return base; }
    pool = catalog.filter(function (it) { return it && typeof it.n === 'string' && tgDisponivel(it); });
    info = { tipo: 'generico', id: 'generico', titulo: TG_INTENCAO_GENERICO_TITULO };
  } else {
    for (i = 0; i < det.achadas.length && !prim; i++) { if (det.achadas[i].tipo !== 'promo') prim = det.achadas[i]; }
    if (!prim) prim = det.achadas[0];
    pool = tgPoolIntencao(prim, catalog, prep);
    // outras intencoes juntas ("festa promocao") filtram a selecao principal; se nada sobra, fica so a principal
    outros = pool;
    for (k = 0; k < det.achadas.length; k++) {
      if (det.achadas[k] === prim) continue;
      outros = (function (set) { return outros.filter(function (it) { return set.has(it); }); })(new Set(tgPoolIntencao(det.achadas[k], catalog, prep)));
    }
    if (outros.length) pool = outros;
    if (!pool.length && prim.tipo === 'conjunto') return null; // catalogo sem peca de cima/baixo: vale o sinonimo antigo (Look Inteiro)
    info = { tipo: prim.tipo, id: prim.def.id, titulo: prim.def.titulo };
  }
  lista = pool;
  if (det.resto.length) {
    pontuados = tgPontuar(det.resto, det.resto.join(' '), pool, prep);
    // so a melhor faixa de acerto que existir: 1) todas as palavras iguais ou comeco (8+), 2) ate 1 erro, categoria ou cor (5+), 3) qualquer.
    // Assim "conjunto preto" nao traz "reta" (2 erros) e "roupa de baixo preta" nao traz "Reta ... Marrom" (1 erro) quando ha peca preta de verdade.
    k = pontuados.filter(function (s) { return s.mp >= 8; });
    if (!k.length) k = pontuados.filter(function (s) { return s.mp >= 5; });
    if (k.length) pontuados = k;
    casou = new Set(pontuados.map(function (s) { return s.item; }));
    lista = pool.filter(function (it) { return casou.has(it); });
    if (!lista.length) {
      // o resto nao existe na selecao ("body promocao" sem body em promocao): vale a busca comum do resto
      base = tgBuscaBase(consultaResto, catalog, limit, esgotados);
      base.query = query;
      base.intencao = { tipo: info.tipo, id: info.id, titulo: info.titulo, total: 0, resto: det.resto.join(' '), aplicado: false };
      return base;
    }
  }
  if (tam) {
    comTam = lista.filter(function (it) { return tgTemTamanho(it, aceitos); });
    if (comTam.length) lista = comTam;
    tamanho = { pedido: tam.tamanhos, aplicado: comTam.length > 0, texto: textoSemTam, rotulo: tam.tamanhos.join(' ou '), aceitos: Object.keys(aceitos) };
  }
  top = lista.slice(0, limit);
  ofertas = tamanho && tamanho.aplicado ? tgOfertasDoTamanho(catalog, prep, aceitos) : prep.ofertas;
  info.total = lista.length;
  info.resto = det.resto.join(' ');
  info.aplicado = true;
  return { query: query, results: top, suggestedTerm: null, buscandoPor: null, selos: tgSelosDaBusca(top, prep, ofertas), tamanho: tamanho, fortes: top.length, fortesTotal: lista.length, intencao: info };
}

// So pelo texto (sem catalogo, sem a protecao dos nomes): a intencao principal da busca, ou null. Para a tela decidir o titulo antes do resultado.
// Devolve { tipo: 'promo' | 'ocasiao' | 'grupo' | 'conjunto' | 'generico', id, titulo }.
function tgIntencaoDaBusca(q, catalog) {
  var n = normalizeText(q), t, tam, det, i, prim = null;
  if (!n || n.length < 2) return null;
  t = n.split(' ').filter(Boolean);
  tam = tgTamanhoDaConsulta(t);
  if (tam) t = tam.resto;
  if (!t.length || tgCuradaDaConsulta(t)) return null;
  det = tgIntencaoDaConsulta(t, Array.isArray(catalog) && catalog.length ? tgPreparar(catalog) : null);
  if (!det) return null;
  if (!det.achadas.length) return det.resto.length ? null : { tipo: 'generico', id: 'generico', titulo: TG_INTENCAO_GENERICO_TITULO };
  for (i = 0; i < det.achadas.length && !prim; i++) { if (det.achadas[i].tipo !== 'promo') prim = det.achadas[i]; }
  if (!prim) prim = det.achadas[0];
  return { tipo: prim.tipo, id: prim.def.id, titulo: prim.def.titulo };
}

// A busca pede conjunto? (conjunto, conjuntos, conjuntinho, look completo...; tolera comeco e 1 erro de digitacao). Usado pela tela para mostrar os pares do Recom.
function tgEhIntencaoConjunto(q) {
  var i = tgIntencaoDaBusca(q);
  return !!(i && i.tipo === 'conjunto');
}

// 2. Ranqueamento e Busca em Memória
// "esgotados" (opcional): lista do catálogo de esgotados já validada. Só o injetor a passa, e só depois de tgPrecisaEsgotados.
function tgBuscaBase(query, catalog, limit, esgotados) {
  limit = limit || 6;
  let normQ = normalizeText(query);
  const prep = tgPreparar(catalog);
  if (!normQ || normQ.length < 2) {
    const inicio = catalog.slice(0, limit);
    return { query: query, results: inicio, suggestedTerm: null, selos: tgSelosDaBusca(inicio, prep, prep.ofertas), tamanho: null, fortes: inicio.length, fortesTotal: inicio.length };
  }

  let qTokens = normQ.split(' ').filter(Boolean);
  const tam = tgTamanhoDaConsulta(qTokens);
  let aceitos = null;
  let textoSemTam = null;
  if (tam) {
    // o tamanho sai do texto (assim "g" e "p" não bagunçam a tolerância a erro de digitação) e vira filtro depois da pontuação
    aceitos = tgTamanhosAceitos(tam.tamanhos);
    textoSemTam = tgTextoSemTamanho(query, qTokens, tam);
    qTokens = tam.resto;
    normQ = qTokens.join(' ');
  }

  // Busca curada (wedding, casamento...): blocos com titulo no lugar da ordenacao convencional. Se nenhum bloco tem peca, segue o caminho normal.
  if (qTokens.length) {
    const busca = tgCuradaDaConsulta(qTokens);
    const cur = busca ? tgBuscaCurada(busca, catalog, prep, limit, aceitos) : null;
    if (cur) {
      const tamCur = tam ? { pedido: tam.tamanhos, aplicado: cur.aplicado, texto: textoSemTam, rotulo: tam.tamanhos.join(' ou '), aceitos: Object.keys(aceitos) } : null;
      const ofertasCur = cur.aplicado ? tgOfertasDoTamanho(catalog, prep, aceitos) : prep.ofertas;
      return {
        query: query,
        results: cur.flat,
        suggestedTerm: null,
        selos: tgSelosDaBusca(cur.flat, prep, ofertasCur),
        tamanho: tamCur,
        fortes: cur.flat.length,
        fortesTotal: cur.total,
        curada: { id: cur.id, blocos: cur.blocos, total: cur.total }
      };
    }
  }

  // Intencao (promocao, ocasiao, estacao, grupo, conjunto) e palavra generica (roupa, peca): antes do esgotado e do erro de digitacao (QA 25/11).
  if (qTokens.length) {
    const intRes = tgBuscaIntencao(query, qTokens, catalog, prep, limit, tam, aceitos, textoSemTam, esgotados);
    if (intRes) return intRes;
  }

  // Esgotado nominal: só com o catálogo de esgotados já validado, sem tamanho na busca e quando a palavra pedida não casa com nenhuma peça em estoque.
  if (esgotados && esgotados.length && !tam && qTokens.length) {
    const esg = tgBuscaEsgotado(qTokens, catalog, prep, esgotados, limit);
    if (esg) { esg.query = query; return esg; }
  }

  let scored;
  if (tam && !qTokens.length) {
    // só tamanho ("tam g"): todas as peças, na ordem do catálogo (ranking de vendas)
    scored = catalog.map(function (item) { return { item: item, score: 1, d: tgDisponivel(item) ? 1 : 0, tp: 1, cr: 0, fo: 1 }; });
  } else {
    scored = tgPontuar(qTokens, normQ, catalog, prep);
    tgMarcarFortes(scored);
  }

  // Ordem: em estoque antes de esgotada; acerto forte (ver tgMarcarFortes) antes do parecido; (com cor na busca) tipo completo, depois o tom
  // (pedido, prioridade do grupo, outras); por fim a pontuação. O sort é estável: no empate vale a ordem do catálogo, como na Fase 1.
  // A ordem por "fo" so vale com 2+ palavras ("vestido preto"): com 1 palavra a ordem completa continua travada na paridade da Fase 1
  // (motor-paridade e ordem-termos-sem-cor), e la os fortes so se misturam com os parecidos bem no fundo da lista (posicao 250+ em "blusa").
  const porForca = qTokens.length >= 2 ? 1 : 0;
  scored.sort((a, b) => (b.d - a.d) || porForca * (b.fo - a.fo) || (b.tp - a.tp) || (a.cr - b.cr) || (b.score - a.score));

  let tamanho = null;
  if (tam) {
    const comTam = scored.filter(function (s) { return tgTemTamanho(s.item, aceitos); });
    const aplicado = comTam.length > 0;
    if (aplicado) scored = comTam;
    else if (!qTokens.length) scored = [];
    // aceitos: os tamanhos que valem como o pedido (com a tabela de equivalencia), para o injetor destacar a pilula
    tamanho = { pedido: tam.tamanhos, aplicado: aplicado, texto: textoSemTam, rotulo: tam.tamanhos.join(' ou '), aceitos: Object.keys(aceitos) };
  }

  const topResults = scored.slice(0, limit).map(s => s.item);
  const ofertas = tamanho && tamanho.aplicado ? tgOfertasDoTamanho(catalog, prep, aceitos) : prep.ofertas;
  // fortes: com 2+ palavras, a sequencia de fortes em estoque no topo (eles vem primeiro); com 1 palavra, quantas pecas fortes em estoque ha
  // (mesmo que alguma fique depois de uma parecida no fundo da lista)
  let fortesTotal = 0, fortesTop = 0;
  if (porForca) {
    while (fortesTotal < scored.length && scored[fortesTotal].fo && scored[fortesTotal].d) fortesTotal++;
    fortesTop = Math.min(fortesTotal, topResults.length);
  } else {
    for (let k = 0; k < scored.length; k++) { if (scored[k].fo && scored[k].d) { fortesTotal++; if (k < topResults.length) fortesTop++; } }
  }

  // "Buscando por": o nome da 1ª peça, como na Fase 1. Na busca por tamanho com filtro aplicado quem fala é o aviso do tamanho (tamanho.texto + rotulo).
  let suggested = null, buscandoPor = null;
  if (topResults.length > 0 && !(tamanho && tamanho.aplicado) && normalizeText(topResults[0].n) !== normQ) {
    // so sugere a peca se a cliente digitou o comeco do nome proprio (ou grafia parecida); so o grupo vira "Vestidos" (19/11)
    if (tgCitouNomeProprio(qTokens, topResults[0])) { suggested = topResults[0].n; }
    else if (qTokens.length === 1 && (qTokens[0] === normalizeText(topResults[0].n).split(' ')[0] || qTokens[0] === normalizeText(topResults[0].n).split(' ')[0] + 's' || tgUmaTroca(qTokens[0], normalizeText(topResults[0].n).split(' ')[0]))) { buscandoPor = tgPluralGrupo(topResults[0].n.split(' ')[0]); }
  }

  return {
    query: query,
    results: topResults,
    suggestedTerm: suggested,
    buscandoPor: buscandoPor,
    selos: tgSelosDaBusca(topResults, prep, ofertas),
    tamanho: tamanho,
    fortes: fortesTop,
    fortesTotal: fortesTotal
  };
}

// Acerto forte (25/11, contador "X peças encontradas"): a peca casa com TODAS as palavras da busca (tipo, cor, nome do modelo...) e, com cor de
// grupo na busca (azul, verde, branco, amarelo), e daquele grupo. A forca exigida e a melhor faixa que existir no resultado:
//   1. toda palavra igual ou comeco de palavra do nome (8+ pontos; "preta" = "preto"; cor equivalente do grupo vale);
//   2. senao, ate 1 erro de digitacao, sinonimo ou categoria (5+);   3. senao, qualquer acerto de todas as palavras.
// Assim "vestido preto" conta so os vestidos pretos e "calca vera" so as Calcas Vera; o resto (pecas parecidas) continua na lista, depois.
function tgMarcarFortes(scored) {
  var tier = 1, i, s;
  for (i = 0; i < scored.length; i++) { s = scored[i]; if (s.cg && s.mp >= 8) { tier = 8; break; } if (s.cg && s.mp >= 5) tier = 5; }
  for (i = 0; i < scored.length; i++) { s = scored[i]; s.fo = s.cg && s.mp >= tier ? 1 : 0; }
}

// ---------------------------------------------------------------------------------------------------------------------
// Enriquecimento do motor (19/11, documento "Enriquecimento Search Engine"): aneis de sinonimos, "Buscando por" so com nome proprio e sugestoes por grupo.
// ---------------------------------------------------------------------------------------------------------------------

// Aneis de sinonimos: quem busca uma palavra do anel tambem acha as pecas das outras (a peca com a palavra digitada vem primeiro).
// Plural e acento ja valem igual (normalizeText), por isso macacao/macacoes e calca/calcas nao precisam de anel.
var TG_ANEIS_SINONIMOS = [
  ['blusa', 'blusinha', 'camiseta', 't shirt', 'tshirt', 'regata'],
  ['corset', 'corpete', 'corselet', 'corselete', 'espartilho'],
  ['macaquinho', 'macacao curto'],
  ['short', 'shorts', 'bermuda', 'bermudas']
];

// Sugestoes por grupo de produto (a lista do Danilo, das buscas mais comuns). Aparecem quando a cliente digita so o grupo.
var TG_SUGESTOES_GRUPO = {
  'vestido': ['Vestido Midi', 'Vestido Longo', 'Vestido Curto', 'Vestido de Festa', 'Vestido Alfaiataria'],
  'blusa': ['Blusa Bengaline', 'Blusa Tomara Que Caia', 'Blusa Manga Curta', 'Blusa Manga Longa', 'Blusa Ombro Só'],
  'calca': ['Calça Alfaiataria', 'Calça Reta', 'Calça Pantalona', 'Calça Aladim', 'Calça Justa'],
  'corset': ['Corset Preto', 'Corset Alfaiataria', 'Corset Tomara Que Caia', 'Corset Off White', 'Corselete'],
  'camisa': ['Camisa Social', 'Camisa Branca', 'Camisa Preta', 'Camisa Trabalho', 'Camisa Tricoline'],
  'colete': ['Colete Alfaiataria', 'Colete Branco', 'Colete Preto', 'Colete Cinza'],
  'short': ['Short Alfaiataria', 'Short Saia'],
  'shorts': ['Short Alfaiataria', 'Short Saia'],
  'saia': ['Saia Midi', 'Saia Longa']
};

// Sugestoes curadas para o que foi digitado, ou null: so quando e exatamente o grupo (vestido, vestidos, calca, calcas...).
function tgSugestoesDoGrupo(consulta) {
  var n = normalizeText(consulta), chave = n;
  if (!n) return null;
  if (!Object.prototype.hasOwnProperty.call(TG_SUGESTOES_GRUPO, chave) && n.length > 3 && n.charAt(n.length - 1) === 's') chave = n.slice(0, -1);
  return Object.prototype.hasOwnProperty.call(TG_SUGESTOES_GRUPO, chave) ? TG_SUGESTOES_GRUPO[chave].slice() : null;
}

// Plural do grupo para o "Buscando por": Vestido -> Vestidos, Macacao -> Macacoes, Shorts fica.
function tgPluralGrupo(palavra) {
  var p = String(palavra == null ? '' : palavra);
  if (!p) return '';
  if (/s$/i.test(p)) return p;
  if (/ão$/i.test(p)) return p.slice(0, -2) + 'ões';
  return p + 's';
}

// O nome da peca e "Grupo NomeProprio ...". A peca so e sugerida no "Buscando por" quando a cliente digitou (alem do grupo) o comeco do nome proprio
// (A, Al, Ale, Alex...) ou uma grafia parecida (Alessandra para Alexandra). Digitar so o grupo ou uma cor nao sugere peca nenhuma.
function tgCitouNomeProprio(qTokens, item) {
  var ws = normalizeText(item && item.n).split(' '), grupo = ws[0], proprio = ws[1] || '', i, t, dist;
  if (!proprio || ws.length < 2) return false;
  for (i = 0; i < qTokens.length; i++) {
    t = qTokens[i];
    if (!t || t === grupo || t === grupo + 's' || t === proprio + 's') continue;
    if (proprio.indexOf(t) === 0) return true;
    // erro de digitacao do proprio grupo (vestdo, blsa, calca1): continua o "voce quis dizer" de sempre
    if (t.length >= 4 && grupo.length >= 4 && levenshtein(t, grupo, 1) <= 1) return true;
    if (t.length >= 5) { dist = levenshtein(t, proprio, t.length >= 8 ? 2 : 1); if (dist <= (t.length >= 8 ? 2 : 1)) return true; }
  }
  return false;
}

// Alternativas de consulta pelos aneis: troca a palavra (ou frase) do anel pelas outras do mesmo anel. Vazio se a consulta nao tem palavra de anel.
function tgAlternativasSinonimos(normQ) {
  var toks = normQ.split(' ').filter(Boolean), a, m, i, tam, frase, antes, depois, out = [];
  for (i = 0; i < toks.length; i++) {
    for (tam = 2; tam >= 1; tam--) {
      if (i + tam > toks.length) continue;
      frase = toks.slice(i, i + tam).join(' ');
      for (a = 0; a < TG_ANEIS_SINONIMOS.length; a++) {
        if (TG_ANEIS_SINONIMOS[a].indexOf(frase) < 0) continue;
        antes = toks.slice(0, i); depois = toks.slice(i + tam);
        for (m = 0; m < TG_ANEIS_SINONIMOS[a].length; m++) {
          if (TG_ANEIS_SINONIMOS[a][m] === frase) continue;
          out.push({ consulta: antes.concat([TG_ANEIS_SINONIMOS[a][m]], depois).join(' '), digitada: frase, membro: TG_ANEIS_SINONIMOS[a][m] });
        }
        return out;
      }
    }
  }
  return out;
}

// runSearch com aneis de sinonimos. Sem palavra de anel na consulta (ou com esgotado nominal/busca curada) devolve exatamente o resultado base.
function runSearch(query, catalog, limit, esgotados) {
  var base = tgBuscaBase(query, catalog, limit, esgotados), lim = limit || 6, normQ = normalizeText(query), alts, i, j, r, it, nome, exatos = [], sinon = [], resto = [], vistos = {}, selos, prep, final, digitada, noBase;
  if (!normQ || normQ.length < 2 || base.esgotado || base.curada || base.intencao) return base;
  alts = tgAlternativasSinonimos(normQ);
  if (!alts.length) return base;
  digitada = alts[0].digitada;
  function tokensDe(item) { return ' ' + normalizeText(item.n) + ' '; }
  function tem(item, frase) { return tokensDe(item).indexOf(' ' + frase + ' ') >= 0; }
  for (i = 0; i < base.results.length; i++) {
    it = base.results[i];
    if (tem(it, digitada)) { if (!vistos[it.id]) { vistos[it.id] = 1; exatos.push(it); } } else { resto.push(it); }
  }
  for (i = 0; i < alts.length; i++) {
    r = tgBuscaBase(alts[i].consulta, catalog, Math.max(lim, 12), esgotados);
    if (r.esgotado || r.curada || r.intencao) continue;
    for (j = 0; j < r.results.length; j++) {
      it = r.results[j];
      if (!vistos[it.id] && tem(it, alts[i].membro)) { vistos[it.id] = 1; sinon.push(it); }
    }
  }
  if (!sinon.length) return base;
  // com a palavra digitada achando pecas, a ordem de sempre fica intacta e as do anel entram DEPOIS; sem nenhuma, as do anel assumem
  // a palavra do anel junto de outras ("blusa rafa") e busca por peca com nome: nao amplia
  if (exatos.length && normQ.split(' ').length > digitada.split(' ').length) return base;
  if (exatos.length) {
    noBase = {};
    for (i = 0; i < base.results.length; i++) { noBase[base.results[i].id] = 1; }
    sinon = sinon.filter(function (x) { return !noBase[x.id]; });
    if (!sinon.length) return base;
    final = base.results.concat(sinon).slice(0, lim);
  } else { final = sinon.slice(0, lim); }
  prep = tgPreparar(catalog);
  selos = tgSelosDaBusca(final, prep, base.tamanho && base.tamanho.aplicado ? tgOfertasDoTamanho(catalog, prep, tgTamanhosAceitos(base.tamanho.aceitos || [])) : prep.ofertas);
  // fortes: com a palavra digitada achando pecas, as do anel vem depois das fortes da base; sem nenhuma, as do anel sao o acerto
  return { query: base.query, results: final, suggestedTerm: null, buscandoPor: null, selos: selos, tamanho: base.tamanho,
    fortes: exatos.length ? base.fortes : final.length, fortesTotal: exatos.length ? base.fortesTotal : final.length };
}

// ---------------------------------------------------------------------------------------------------------------------
// Redesign da busca (quick 20261118-redesign-busca, pacote M): modelo e cor do nome, agrupar as cores de um modelo, ordenar, filtrar e chips.
// Na Talgui cada cor é um produto separado ("Vestido Alexandra Um Ombro Só Preto / Off White"), então as cores de um modelo são os produtos
// irmãos: mesmo nome sem a cor do final e mesma categoria. Só puro e aditivo: nada aqui muda a ordem nem o resultado do runSearch.
// ---------------------------------------------------------------------------------------------------------------------

// Cores simples (e "claro/escuro") que existem no catálogo mas não estão nos grupos de TG_COR_GRUPOS (que só têm branco, amarelo, azul e verde).
var TG_MODELO_CORES_SIMPLES = ['preto', 'marrom', 'rosa', 'bege', 'cinza', 'vinho', 'areia', 'caramelo', 'roxo', 'lilas', 'vermelho', 'pink', 'laranja', 'nude', 'dourado', 'prata', 'terracota', 'coral', 'goiaba', 'white', 'off white', 'marinho', 'petroleo', 'mostarda', 'branco', 'amarelo', 'azul', 'verde'];
var TG_MODELO_CORES_COMPOSTAS = ['azul bebe', 'verde oliva'];
var TG_MODELO_CORES_TOM = ['claro', 'escuro'];
// Feminino de cor vira o masculino (Preta = Preto). Só estas; plural nunca (lilás vira "lilas", que termina em s).
var TG_MODELO_COR_GENERO = { preta: 'preto', branca: 'branco', amarela: 'amarelo', vermelha: 'vermelho', roxa: 'roxo', clara: 'claro', escura: 'escuro' };
(function () { var k; for (k in TG_MODELO_COR_GENERO) { if (Object.prototype.hasOwnProperty.call(TG_MODELO_COR_GENERO, k)) TG_GENERO_ALVOS[TG_MODELO_COR_GENERO[k]] = true; } })();

// Frases de cor do modelo, da mais longa para a mais curta: as de TG_COR_FRASES (compostas dos 4 grupos) + simples + "cor claro/escuro".
var TG_MODELO_COR_FRASES = (function () {
  var vistos = {}, out = [], i, j, base = TG_MODELO_CORES_SIMPLES.concat(TG_COR_FRASES.map(function (f) { return f.v; })), todas;
  todas = base.slice();
  for (i = 0; i < TG_MODELO_CORES_SIMPLES.length; i++) {
    for (j = 0; j < TG_MODELO_CORES_TOM.length; j++) todas.push(TG_MODELO_CORES_SIMPLES[i] + ' ' + TG_MODELO_CORES_TOM[j]);
  }
  todas = todas.concat(TG_MODELO_CORES_COMPOSTAS);
  for (i = 0; i < todas.length; i++) {
    if (vistos[todas[i]]) continue;
    vistos[todas[i]] = true;
    out.push(todas[i].split(' '));
  }
  out.sort(function (a, b) { return b.length - a.length; });
  return out;
})();

// "Vestido Maria Alice Off White" -> { modelo: 'Vestido Maria Alice', cor: 'Off White' }. A cor é a frase de cor (a mais longa que couber) no FIM do
// nome; o resto é o modelo. Sem cor no final (ou se sobrar menos de 2 palavras de modelo, ex. "Vestido Preto") -> { modelo: nome, cor: '' }.
// Cor no meio do nome não conta (Calça Animal Print, Blusa Preta Lisa ficam sem cor). Texto devolvido com as palavras como no nome (acento e caixa).
function tgModeloCor(nome) {
  var texto = String(nome == null ? '' : nome).replace(/\s+/g, ' ').trim(), bruto, palavras = [], canon = [], i, k, f, n, ok, ini, c;
  if (!texto) return { modelo: '', cor: '' };
  bruto = texto.split(' ');
  for (i = 0; i < bruto.length; i++) {
    c = normalizeText(bruto[i]).replace(/\s+/g, '');
    if (c === 'offwhite') { palavras.push('Off', 'White'); canon.push('off', 'white'); continue; } // "OffWhite" junto vale como "Off White"
    palavras.push(bruto[i]);
    canon.push(Object.prototype.hasOwnProperty.call(TG_MODELO_COR_GENERO, c) ? TG_MODELO_COR_GENERO[c] : c);
  }
  for (k = 0; k < TG_MODELO_COR_FRASES.length; k++) {
    f = TG_MODELO_COR_FRASES[k];
    n = f.length;
    ini = canon.length - n;
    if (ini < 2) continue; // o modelo precisa de pelo menos 2 palavras
    ok = true;
    for (i = 0; i < n; i++) { if (canon[ini + i] !== f[i]) { ok = false; break; } }
    if (!ok) continue;
    return { modelo: palavras.slice(0, ini).join(' '), cor: palavras.slice(ini).join(' ') };
  }
  return { modelo: texto, cor: '' };
}

// Agrupa as cores de cada modelo. Devolve um mapa id -> { modelo, cor, irmaos: [item...] }. Irmãos = itens do mesmo modelo (sem a cor) e da mesma
// categoria (c), incluindo o próprio; com estoque primeiro e, dentro disso, a ordem da lista recebida (estável). O array de irmãos é o mesmo para
// todo o grupo, então as bolinhas de cor não mudam de ordem de um card para o outro. Item sem cor no nome fica sozinho no grupo (irmaos = [ele]).
// O mapa é um objeto simples (mapa[item.id]); tem também mapa.get(id) e mapa.has(id) (não enumeráveis).
// opcoes.ignorarCategoria = true: agrupa só pelo modelo (o nome já começa pelo tipo da peça). No catálogo real a categoria principal (c) de um mesmo
// modelo varia entre as cores (Vestidos x Look Inteiro, Partes de Cima x Últimas Oportunidades), o que quebra a fila de bolinhas de cor.
// Nesse modo, se duas peças do grupo têm a mesma cor (Preta = Preto), só a 1ª (a com estoque, depois a da frente na lista) fica nos irmãos
// (a repetida recebe a mesma lista e não aparece nela).
function tgAgruparCores(itens, opcoes) {
  var mapa = {}, lista = Array.isArray(itens) ? itens : [], grupos = {}, i, it, mc, chave, g, k, irmaos, j, infos = [], semCat = !!(opcoes && opcoes.ignorarCategoria), vistas;
  Object.defineProperty(mapa, 'get', { value: function (id) { return Object.prototype.hasOwnProperty.call(mapa, id) ? mapa[id] : undefined; } });
  Object.defineProperty(mapa, 'has', { value: function (id) { return Object.prototype.hasOwnProperty.call(mapa, id); } });
  for (i = 0; i < lista.length; i++) {
    it = lista[i];
    if (!it || typeof it !== 'object' || it.id == null) { infos.push(null); continue; }
    mc = tgModeloCor(it.n);
    if (mc.cor) {
      chave = normalizeText(mc.modelo) + '|' + (semCat ? '' : normalizeText(it.c));
      if (!grupos[chave]) grupos[chave] = [];
      grupos[chave].push(it);
    } else {
      chave = null;
    }
    infos.push({ it: it, mc: mc, chave: chave });
  }
  for (k in grupos) {
    if (!Object.prototype.hasOwnProperty.call(grupos, k)) continue;
    g = grupos[k];
    irmaos = g.filter(tgDisponivel).concat(g.filter(function (x) { return !tgDisponivel(x); }));
    if (semCat) {
      vistas = {};
      irmaos = irmaos.filter(function (x) {
        var c = normalizeText(tgModeloCor(x.n).cor).split(' ').map(function (w) { return TG_MODELO_COR_GENERO[w] || w; }).join(' ');
        if (vistas[c]) return false;
        vistas[c] = true;
        return true;
      });
    }
    grupos[k] = irmaos;
  }
  for (j = 0; j < infos.length; j++) {
    if (!infos[j]) continue;
    mapa[infos[j].it.id] = { modelo: infos[j].mc.modelo, cor: infos[j].mc.cor, irmaos: infos[j].chave ? grupos[infos[j].chave] : [infos[j].it] };
  }
  return mapa;
}

var TG_ORDENAR_MODOS = ['relevancia', 'menor-preco', 'maior-preco', 'maior-desconto', 'mais-vendidos', 'melhores-ofertas', 'lancamentos', 'best-sellers'];
// Nomes novos da barra Ordenar (19/11): melhores-ofertas = maior-desconto; best-sellers = mais-vendidos; lancamentos = a ordem da categoria Novidades da Semana.
var TG_ORDENAR_APELIDOS = { 'melhores-ofertas': 'maior-desconto', 'best-sellers': 'mais-vendidos' };

// Preço que a cliente paga: o promocional (pp) quando é menor que o cheio (p); senão p. Sem preço válido = Infinity (vai para o fim do grupo).
function tgPrecoPago(item) {
  var p = item && item.p, pp = item && item.pp;
  if (typeof p === 'number' && p > 0) return (typeof pp === 'number' && pp > 0 && pp < p) ? pp : p;
  return Infinity;
}

// Ordena uma cópia da lista (a original não muda). relevancia = a ordem recebida, sem mexer (é a do runSearch, que já põe o estoque antes e
// preserva o esgotado nominal de propósito); nos outros modos as peças esgotadas (sem tamanho em estoque) vão SEMPRE para o fim e a ordem é estável.
// maior-desconto: só pp < p conta como desconto; quem não tem desconto vem depois, na ordem recebida. mais-vendidos: b maior primeiro, depois t menor.
function tgOrdenar(lista, modo, ordemHandles) {
  var itens = Array.isArray(lista) ? lista.slice() : [], dec, cmp, pos = null, h;
  if (Object.prototype.hasOwnProperty.call(TG_ORDENAR_APELIDOS, modo)) modo = TG_ORDENAR_APELIDOS[modo];
  if (modo === 'relevancia' || TG_ORDENAR_MODOS.indexOf(modo) < 0) return itens;
  if (modo === 'lancamentos') {
    // ordemHandles = lista de handles na ordem da categoria Novidades da Semana; quem esta nela vem primeiro (nessa ordem), o resto segue na ordem recebida
    if (!Array.isArray(ordemHandles) || !ordemHandles.length) return itens;
    pos = {};
    for (h = 0; h < ordemHandles.length; h++) { if (typeof ordemHandles[h] === 'string' && !(ordemHandles[h] in pos)) pos[ordemHandles[h]] = h; }
    cmp = function (a, b) {
      var pa = pos[a.s] === undefined ? 1e9 : pos[a.s], pb = pos[b.s] === undefined ? 1e9 : pos[b.s];
      return pa - pb;
    };
  } else
  if (cmp) { /* lancamentos */ }
  else if (modo === 'menor-preco') cmp = function (a, b) { return tgPrecoPago(a) - tgPrecoPago(b); };
  else if (modo === 'maior-preco') cmp = function (a, b) {
    var pa = tgPrecoPago(a), pb = tgPrecoPago(b);
    if (pa === pb) return 0;
    if (pa === Infinity) return 1;
    if (pb === Infinity) return -1;
    return pb - pa;
  };
  else if (modo === 'maior-desconto') cmp = function (a, b) { return tgDesconto(b) - tgDesconto(a); };
  else cmp = function (a, b) {
    var ba = typeof a.b === 'number' ? a.b : 0, bb = typeof b.b === 'number' ? b.b : 0, ta = typeof a.t === 'number' ? a.t : 99, tb = typeof b.t === 'number' ? b.t : 99;
    return (bb - ba) || (ta - tb);
  };
  dec = itens.map(function (it, i) { return { it: it, i: i, esg: tgDisponivel(it) ? 0 : 1 }; });
  dec.sort(function (a, b) {
    var c = a.esg - b.esg;
    if (c) return c;
    c = (a.it && b.it) ? cmp(a.it, b.it) : 0;
    return c || (a.i - b.i);
  });
  return dec.map(function (d) { return d.it; });
}

// Filtra uma cópia da lista. opcoes.tamanho = rótulo de sz ("M", "40"): fica quem tem esse tamanho em estoque (usa a tabela de equivalência se ela
// for preenchida). opcoes.categoria = nome da categoria (c), sem diferença de acento ou caixa; aceita também uma lista de nomes. Vazio = não filtra.
// Grupos de tamanho do filtro (Danilo, 19/11): cada botao do filtro vale a letra e o numero. Vale so no filtro da pagina de resultados;
// a busca por texto continua com TG_TAMANHO_EQUIVALENTE (vazia).
var TG_TAMANHO_GRUPOS = [
  { id: 'XPP', rotulo: 'XPP / 34', v: ['XPP', '34'] },
  { id: 'PP', rotulo: 'PP / 36', v: ['PP', '36'] },
  { id: 'P', rotulo: 'P / 38', v: ['P', '38'] },
  { id: 'M', rotulo: 'M / 40', v: ['M', '40'] },
  { id: 'G', rotulo: 'G / 42', v: ['G', '42'] },
  { id: 'GG', rotulo: 'GG / 44', v: ['GG', '44'] }
];

// Tamanhos (maiusculos) aceitos por um ou mais valores do filtro: o id do grupo ("M"), a letra ou o numero ("40"), ou um tamanho avulso.
function tgTamanhosDoFiltro(valores) {
  var lista = Array.isArray(valores) ? valores : [valores], set = {}, i, j, k, v, achou;
  for (i = 0; i < lista.length; i++) {
    v = String(lista[i] == null ? '' : lista[i]).trim().toUpperCase();
    if (!v) continue;
    achou = false;
    for (k = 0; k < TG_TAMANHO_GRUPOS.length; k++) {
      if (TG_TAMANHO_GRUPOS[k].v.indexOf(v) >= 0) { achou = true; for (j = 0; j < TG_TAMANHO_GRUPOS[k].v.length; j++) set[TG_TAMANHO_GRUPOS[k].v[j]] = true; }
    }
    if (!achou) set[v] = true;
  }
  return set;
}

// Familia de cor de uma peca, para o filtro de cores: o grupo de TG_COR_GRUPOS (Branco = Branco + Off White, Azul = todos os azuis...) ou a propria cor.
// { chave, rotulo } ou null quando o nome nao traz cor.
function tgFamiliaCor(item) {
  var cor = tgModeloCor(item && item.n).cor, n, i, rotulo;
  if (!cor) return null;
  n = tgPalavrasCor(cor).join(' ');
  for (i = 0; i < TG_COR_GRUPOS.length; i++) {
    if (TG_COR_GRUPOS[i].v.indexOf(n) >= 0) { rotulo = TG_COR_GRUPOS[i].g === 'branco' ? 'off-white' : TG_COR_GRUPOS[i].g; return { chave: TG_COR_GRUPOS[i].g, rotulo: rotulo === 'off-white' ? 'Off-White' : rotulo.charAt(0).toUpperCase() + rotulo.slice(1) }; }
  }
  return { chave: n, rotulo: cor };
}

// Filtra uma copia da lista. opcoes.tamanho = um valor ou uma lista (ver tgTamanhosDoFiltro; com varios, basta ter um deles em estoque).
// opcoes.cor = chave ou lista de chaves de tgFamiliaCor (basta uma). opcoes.categoria = nome da categoria (c), sem diferenca de acento ou caixa;
// aceita tambem uma lista de nomes. Vazio = nao filtra. Todos os criterios juntos valem em conjunto (E).
function tgFiltrar(lista, opcoes) {
  var itens = Array.isArray(lista) ? lista.slice() : [], o = opcoes || {}, set = null, cats = null, cores = null, tam, i, c, f;
  tam = o.tamanho == null ? [] : (Array.isArray(o.tamanho) ? o.tamanho : [o.tamanho]);
  tam = tam.filter(function (x) { return String(x == null ? '' : x).trim() !== ''; });
  if (tam.length) set = tgTamanhosDoFiltro(tam);
  if (o.cor != null && o.cor !== '' && !(Array.isArray(o.cor) && !o.cor.length)) {
    cores = {};
    c = Array.isArray(o.cor) ? o.cor : [o.cor];
    for (i = 0; i < c.length; i++) { if (c[i]) cores[String(c[i])] = true; }
  }
  if (o.categoria != null && o.categoria !== '') {
    cats = {};
    c = Array.isArray(o.categoria) ? o.categoria : [o.categoria];
    for (i = 0; i < c.length; i++) { if (normalizeText(c[i])) cats[normalizeText(c[i])] = true; }
  }
  itens = itens.filter(function (it) {
    if (!it || typeof it !== 'object') return false;
    if (set && !tgTemTamanho(it, set)) return false;
    if (cores) { f = tgFamiliaCor(it); if (!f || !cores[f.chave]) return false; }
    if (cats && !cats[normalizeText(it.c)]) return false;
    return true;
  });
  // Branco = Off-White: no filtro de cor, quem e Off White vem antes do Branco antigo (a ordem de cada grupo se mantem)
  if (cores && cores.branco) {
    itens = itens.filter(function (it) { return tgEhOffWhite(it); }).concat(itens.filter(function (it) { return !tgEhOffWhite(it); }));
  }
  return itens;
}
function tgEhOffWhite(it) { return tgPalavrasCor(tgModeloCor(it && it.n).cor || '').join(' ') === 'off white'; }

var TG_CHIPS_EM_ALTA = [
  { rotulo: 'Vestidos', consulta: 'vestido' },
  { rotulo: 'Blusas', consulta: 'blusa' },
  { rotulo: 'Calças', consulta: 'calça' },
  { rotulo: 'Novidades', href: '/novidades/', novidades: true }
];
// Chips de ocasiao (ao lado dos de categoria, so na pagina de resultados). Casual, Eventos e Office sairam (Danilo, 24/11): voltam quando as pecas
// forem marcadas em massa com as tags certas. Na V1 ficam Vestidos, Blusas, Calcas, Conjuntos, Wedding e Novidades.
var TG_CHIPS_OCASIAO = [
  { rotulo: 'Wedding', consulta: 'regra:wedding' }
];
// Selecao dos chips Wedding e Madrinhas/Convidadas (Danilo, 19/11): so vestidos com estoque.
// Wedding = vestidos Off-White (a familia de cor branco inclui o Branco antigo); Madrinhas/Convidadas = todos os outros vestidos. Enquanto nao ha tag no catalogo, vale esta regra.
function tgSelecaoVestidos(catalog, tipo) {
  var out = [], i, it, f, branco;
  if (!Array.isArray(catalog)) return out;
  for (i = 0; i < catalog.length; i++) {
    it = catalog[i];
    if (!it || typeof it.n !== 'string' || !tgDisponivel(it)) continue;
    if (normalizeText(it.n).split(' ')[0] !== 'vestido') continue;
    f = tgFamiliaCor(it);
    branco = !!(f && f.chave === 'branco');
    if (tipo === 'wedding' ? branco : !branco) out.push(it);
  }
  return tgOrdenar(out, 'best-sellers');
}
// Tapete de boas-vindas da busca inicial (Danilo, 23/11): faixa "Pecas Unicas" (2 vestidos mais vendidos + 1 macaquinho + 1 macacao em cores
// proximas) e faixa "Conjuntos" (4 pares monocromaticos de peca de cima + peca de baixo). Enquanto nao ha tag de conjunto, os pares vivem aqui.
// Cada vaga tem o par pedido e uma lista de reserva; a TRAVA escolhe o primeiro par em que as duas pecas existem, estao em estoque e tem
// TG_TAPETE_MIN_TAMANHOS ou mais tamanhos em comum. A conta e feita sobre o catalogo carregado (a cada abertura da busca), nada fica guardado.
var TG_TAPETE_MIN_TAMANHOS = 3;
var TG_TAPETE_CIMA = ['blusa', 'regata', 'top', 'cropped'];
var TG_TAPETE_BAIXO = ['calca', 'shorts', 'short', 'saia'];
var TG_TAPETE_VAGAS = [
  [['augusta', 'lexa', ['azul claro']], ['augusta', 'lexa', ['rosa claro']], ['augusta', 'lexa', ['amarelo claro']], ['augusta', 'lexa', ['marrom']]],
  [['emma', 'blair', ['preta', 'preto']], ['emma', 'blair', ['azul claro']], ['emma', 'blair', ['rosa claro']], ['emma', 'blair', ['verde claro']]],
  [['daniele', 'felicia', ['marrom']], ['benicia', 'felicia', ['azul claro']], ['benicia', 'felicia', ['rosa claro']], ['benicia', 'felicia', ['amarelo claro']]],
  [['benicia', 'felicia', ['marrom']], ['benicia', 'felicia', ['azul claro']], ['benicia', 'felicia', ['rosa claro']], ['benicia', 'felicia', ['amarelo claro']]]
];
function tgTapetePeca(catalog, tipos, modelo, cores) {
  var i, it, p, cor, achado = null;
  for (i = 0; i < catalog.length; i++) {
    it = catalog[i];
    if (!it || typeof it.n !== 'string' || !tgDisponivel(it)) continue;
    p = normalizeText(it.n).split(' ');
    if (tipos.indexOf(p[0]) < 0 || p[1] !== modelo) continue;
    cor = normalizeText(tgModeloCor(it.n).cor);
    if (cores.indexOf(cor) < 0) continue;
    if (!achado || (it.b || 0) > (achado.b || 0)) achado = it;
  }
  return achado;
}
// Tamanhos em comum entre duas pecas, contando letra e numero como o mesmo tamanho (PP = 36, M = 40...): devolve os ids dos grupos.
function tgTapeteGrupo(t) {
  var v = String(t == null ? '' : t).trim().toUpperCase(), i;
  for (i = 0; i < TG_TAMANHO_GRUPOS.length; i++) { if (TG_TAMANHO_GRUPOS[i].v.indexOf(v) >= 0) return TG_TAMANHO_GRUPOS[i].id; }
  return v;
}
function tgTapeteComuns(a, b) {
  var ga = {}, out = [], i, g;
  for (i = 0; i < a.length; i++) ga[tgTapeteGrupo(a[i])] = true;
  for (i = 0; i < b.length; i++) { g = tgTapeteGrupo(b[i]); if (ga[g] && out.indexOf(g) < 0) out.push(g); }
  return out;
}
// Pecas do tapete por tipo (vestido, blusa, calca): as mais vendidas, em estoque, com tamanhos suficientes, de modelos diferentes.
function tgTapetePorTipo(cat, tipos, n, excluir) {
  var v = [], out = [], i, it, mod, vistos = {}, k;
  for (i = 0; i < cat.length; i++) {
    it = cat[i];
    if (it && typeof it.n === 'string' && tgDisponivel(it) && it.sz.length >= TG_TAPETE_MIN_TAMANHOS && tipos.indexOf(normalizeText(it.n).split(' ')[0]) >= 0) v.push(it);
  }
  v = tgOrdenar(v, 'best-sellers');
  if (excluir) { for (k = 0; k < excluir.length; k++) vistos[normalizeText(tgModeloCor(excluir[k].n).modelo)] = true; }
  for (i = 0; i < v.length && out.length < n; i++) {
    mod = normalizeText(tgModeloCor(v[i].n).modelo);
    if (vistos[mod]) continue;
    vistos[mod] = true;
    out.push(v[i]);
  }
  return out;
}
// Tapete de boas-vindas (Danilo, 23/11, revisado 24/11): 2 vestidos, 2 conjuntos, 2 blusas, 2 calcas (e 2 novidades, ver tgTapeteNovidades).
function tgTapete(catalog) {
  var out = { vestidos: [], conjuntos: [], blusas: [], calcas: [] }, cat = Array.isArray(catalog) ? catalog : [], usados = {}, i, j, vaga, par, cima, baixo, comum, usadoChave;
  out.vestidos = tgTapetePorTipo(cat, ['vestido'], 2);
  out.blusas = tgTapetePorTipo(cat, ['blusa'], 2);
  out.calcas = tgTapetePorTipo(cat, ['calca'], 2);
  for (i = 0; i < TG_TAPETE_VAGAS.length && out.conjuntos.length < 2; i++) {
    vaga = TG_TAPETE_VAGAS[i];
    for (j = 0; j < vaga.length; j++) {
      par = vaga[j];
      usadoChave = par[0] + '|' + par[1] + '|' + par[2][0];
      if (usados[usadoChave]) continue;
      cima = tgTapetePeca(cat, TG_TAPETE_CIMA, par[0], par[2]);
      baixo = tgTapetePeca(cat, TG_TAPETE_BAIXO, par[1], par[2]);
      if (!cima || !baixo) continue;
      comum = tgTapeteComuns(cima.sz, baixo.sz);
      if (comum.length < TG_TAPETE_MIN_TAMANHOS) continue;
      usados[usadoChave] = true;
      out.conjuntos.push({ cima: cima, baixo: baixo, tamanhos: comum, cor: tgModeloCor(cima.n).cor });
      break;
    }
  }
  return out;
}
// 2 novidades para o tapete: as primeiras da categoria Novidades da Semana (handles na ordem dela) que estao em estoque, de modelos diferentes e fora de "excluir".
function tgTapeteNovidades(catalog, handles, excluir) {
  var cat = Array.isArray(catalog) ? catalog : [], pos = {}, v = [], out = [], i, it, vistos = {}, k, mod;
  if (!Array.isArray(handles)) return out;
  for (i = 0; i < handles.length; i++) { if (typeof handles[i] === 'string' && !Object.prototype.hasOwnProperty.call(pos, handles[i])) pos[handles[i]] = i; }
  for (i = 0; i < cat.length; i++) {
    it = cat[i];
    if (it && typeof it.n === 'string' && Object.prototype.hasOwnProperty.call(pos, it.s) && tgDisponivel(it) && it.sz.length >= TG_TAPETE_MIN_TAMANHOS) v.push(it);
  }
  v.sort(function (a, b) { return pos[a.s] - pos[b.s]; });
  if (excluir) { for (k = 0; k < excluir.length; k++) vistos[normalizeText(tgModeloCor(excluir[k].n).modelo)] = true; }
  for (i = 0; i < v.length && out.length < 2; i++) {
    mod = normalizeText(tgModeloCor(v[i].n).modelo);
    if (vistos[mod]) continue;
    vistos[mod] = true;
    out.push(v[i]);
  }
  return out;
}

// ---------------------------------------------------------------- v12 (Danilo, 24/11): vitrine da busca inicial e conjuntos do Recom
// Categoria Novidades inteira (nao so a da semana): as 100 mais novas vem de /novidades/?results_only=true&limit=100 (o ?mpage nao pagina nesta loja).
var TG_NOVIDADES_CATEGORIA = '/novidades/';
// Cores neutras da vitrine inicial (familias de tgFamiliaCor): Preto, Marrom, Cinza e Off-White (o grupo branco inclui o Branco antigo).
var TG_VITRINE_NEUTRAS = ['preto', 'preta', 'marrom', 'cinza', 'branco'];
var TG_VITRINE_POR_GRUPO = 2;
function tgCorNeutra(it) { var f = tgFamiliaCor(it); return !!(f && TG_VITRINE_NEUTRAS.indexOf(f.chave) >= 0); }
// Pecas da categoria Novidades (handles na ordem dela), em estoque; grupo (vestidos | blusas | calcas) opcional.
function tgNovidadesDoGrupo(catalog, handles, grupo) {
  var cat = Array.isArray(catalog) ? catalog : [], pos = {}, v = [], i, it;
  if (!Array.isArray(handles)) return v;
  for (i = 0; i < handles.length; i++) { if (typeof handles[i] === 'string' && !Object.prototype.hasOwnProperty.call(pos, handles[i])) pos[handles[i]] = i; }
  for (i = 0; i < cat.length; i++) {
    it = cat[i];
    if (!it || typeof it.n !== 'string' || !Object.prototype.hasOwnProperty.call(pos, it.s) || !tgDisponivel(it)) continue;
    if (grupo && tgGrupoDoItem(it) !== grupo) continue;
    v.push(it);
  }
  v.sort(function (a, b) { return pos[a.s] - pos[b.s]; });
  return v;
}
// Vitrine da busca inicial: 2 Vestidos, 2 Blusas e 2 Calcas. Regra (Danilo, 24/11): da categoria Novidades, na ordem dela; cor neutra; 3 ou mais
// tamanhos em estoque; modelo com outras cores; modelos diferentes e, quando der, cores diferentes entre as duas. Faltando peca nessa regra, a regra
// afrouxa nesta ordem: neutra sem outras cores, qualquer cor das Novidades, e por fim as mais vendidas (sem a lista das Novidades).
// porGrupo (opcional): quantas pecas por grupo (celular 2; desktop 4, v13).
function tgVitrineInicial(catalog, handles, porGrupo) {
  var N = typeof porGrupo === 'number' && porGrupo > 0 ? Math.min(porGrupo, 8) : TG_VITRINE_POR_GRUPO;
  var cat = Array.isArray(catalog) ? catalog : [], mapa = tgAgruparCores(cat, { ignorarCategoria: true }), out = {}, gs = ['vestidos', 'blusas', 'calcas'], k;
  function outrasCores(it) { var g = mapa.get(it.id); return !!(g && Array.isArray(g.irmaos) && g.irmaos.filter(tgDisponivel).length >= 2); }
  function cheia(it) { return Array.isArray(it.sz) && it.sz.length >= TG_TAPETE_MIN_TAMANHOS; }
  function escolher(grupo) {
    var nov = tgNovidadesDoGrupo(cat, handles, grupo).filter(cheia), best = tgOrdenar(tgItensDoGrupo(cat, grupo).filter(cheia), 'best-sellers'), esc = [], mods = {}, cores = {}, i, t, it, mod, f, passo, faixas;
    function neutraCores(x) { return tgCorNeutra(x) && outrasCores(x); }
    // faixas em ordem de preferencia; dentro de cada faixa, 1a volta pede modelo e cor novos e a 2a so modelo novo (a cor neutra vale mais que a cor diferente)
    faixas = [nov.filter(neutraCores), nov.filter(tgCorNeutra), nov, best.filter(neutraCores), best.filter(tgCorNeutra), best];
    for (t = 0; t < faixas.length && esc.length < N; t++) {
      for (passo = 0; passo < 2 && esc.length < N; passo++) {
        for (i = 0; i < faixas[t].length && esc.length < N; i++) {
          it = faixas[t][i];
          mod = normalizeText(tgModeloCor(it.n).modelo);
          f = tgFamiliaCor(it);
          if (mods[mod] || esc.indexOf(it) >= 0) continue;
          if (passo === 0 && f && cores[f.chave]) continue;
          esc.push(it); mods[mod] = true; if (f) cores[f.chave] = true;
        }
      }
    }
    return esc;
  }
  for (k = 0; k < gs.length; k++) out[gs[k]] = escolher(gs[k]);
  return out;
}
// Conjuntos do Recom (GET /api/conjuntos): o par e a cor sao do Recom (nao recalcular). Aqui so se confere, no catalogo da hora, que as duas pecas
// existem, estao em estoque e tem TG_TAPETE_MIN_TAMANHOS ou mais tamanhos em comum (a lista do Recom muda 1 vez por dia).
// resposta: { conjuntos: [{ id, color, top: { id }, bottom: { id } }] }. Devolve [{ id, cor, cima, baixo, tamanhos }] na ordem do Recom.
function tgConjuntosDoRecom(catalog, resposta) {
  var cat = Array.isArray(catalog) ? catalog : [], lista = resposta && Array.isArray(resposta.conjuntos) ? resposta.conjuntos : [], porId = {}, out = [], vistos = {}, i, c, cima, baixo, comum;
  for (i = 0; i < cat.length; i++) { if (cat[i] && cat[i].id != null) porId[String(cat[i].id)] = cat[i]; }
  for (i = 0; i < lista.length; i++) {
    c = lista[i];
    if (!c || !c.top || !c.bottom || c.top.id == null || c.bottom.id == null) continue;
    cima = porId[String(c.top.id)]; baixo = porId[String(c.bottom.id)];
    if (!cima || !baixo || cima === baixo || !tgDisponivel(cima) || !tgDisponivel(baixo)) continue;
    if (vistos[cima.id + '-' + baixo.id]) continue;
    comum = tgTapeteComuns(cima.sz, baixo.sz);
    if (comum.length < TG_TAPETE_MIN_TAMANHOS) continue;
    vistos[cima.id + '-' + baixo.id] = true;
    out.push({ id: cima.id + '-' + baixo.id, cor: typeof c.color === 'string' && c.color ? c.color : tgModeloCor(cima.n).cor, cima: cima, baixo: baixo, tamanhos: comum });
  }
  return out;
}

// Pagina de Conjuntos (v14, Danilo 24/11): as cores se alternam (Amarelo, Azul, Preto, ... e de novo Amarelo, Azul...), para a grade dar sensacao de
// variedade; dentro de cada cor fica a ordem do Recom. Cor = familia de cor da peca de cima (tgFamiliaCor) ou, sem familia, a cor do Recom.
function tgConjuntosIntercalados(lista) {
  var filas = {}, ordem = [], out = [], i, c, k, f, rodada, algum;
  if (!Array.isArray(lista)) return [];
  for (i = 0; i < lista.length; i++) {
    c = lista[i];
    if (!c) continue;
    // a cor do par vem do Recom (Preto/Preta viram a mesma); sem ela, a familia de cor da peca de cima
    f = c.cima ? tgFamiliaCor(c.cima) : null;
    k = normalizeText(c.cor || '').replace(/^(pret|branc|amarel|vermelh|roxa?)[ao]?/, '$1') || (f && f.chave) || '?';
    if (!filas[k]) { filas[k] = []; ordem.push(k); }
    filas[k].push(c);
  }
  for (rodada = 0; ; rodada++) {
    algum = false;
    for (i = 0; i < ordem.length; i++) { if (filas[ordem[i]].length > rodada) { out.push(filas[ordem[i]][rodada]); algum = true; } }
    if (!algum) break;
  }
  return out;
}

// Grupos da pagina de resultados (Danilo, 24/11): ao entrar em Vestidos, Blusas ou Calcas os chips mudam para os do grupo.
// Cada chip casa a peca por TAG (g do catalogo: ex. "midi", "manga-curta", "pantalona", quando o catalogo passar a trazer) ou, enquanto nao ha tag,
// por palavra no nome. Chip sem nenhuma peca no grupo nao aparece (so Novidades fica sempre). Wedding usa a regra dos vestidos Off-White.
var TG_GRUPOS = {
  vestidos: { rotulo: 'Vestidos', tipos: ['vestido', 'vestidos'], chips: [
    { id: 'curtos', rotulo: 'Curtos', tags: ['curto', 'curtos', 'mini'], nomes: ['curto', 'mini'] },
    { id: 'midi', rotulo: 'Midi', tags: ['midi'], nomes: ['midi'] },
    { id: 'longos', rotulo: 'Longos', tags: ['longo', 'longos', 'maxi'], nomes: ['longo', 'maxi'] },
    { id: 'wedding', rotulo: 'Wedding', regra: 'wedding' },
    { id: 'novidades', rotulo: 'Novidades', novidades: true }
  ] },
  blusas: { rotulo: 'Blusas', tipos: ['blusa', 'blusas'], chips: [
    { id: 'novidades', rotulo: 'Novidades', novidades: true },
    { id: 'manga-curta', rotulo: 'Manga Curta', tags: ['manga-curta', 'manga curta'], nomes: ['manga curta'] },
    { id: 'manga-longa', rotulo: 'Manga Longa', tags: ['manga-longa', 'manga longa'], nomes: ['manga longa'] }
  ] },
  // v14 (Danilo, 24/11): Justa, Reta e Pantalona ficam fora ate as tags de Modelagem serem gravadas em massa (voltam como estavam).
  calcas: { rotulo: 'Calças', tipos: ['calca', 'calcas'], chips: [] }
};
// Grupo (vestidos | blusas | calcas) de uma peca pelo primeiro termo do nome; '' se for outro tipo.
function tgGrupoDoItem(it) {
  var p = it && typeof it.n === 'string' ? normalizeText(it.n).split(' ')[0] : '', id;
  for (id in TG_GRUPOS) { if (Object.prototype.hasOwnProperty.call(TG_GRUPOS, id) && TG_GRUPOS[id].tipos.indexOf(p) >= 0) return id; }
  return '';
}
// Grupo da busca digitada: so se o primeiro termo for o tipo ("vestido midi" -> vestidos). Senao ''.
function tgGrupoDaBusca(q) {
  var p = normalizeText(q || '').split(' ')[0], id;
  for (id in TG_GRUPOS) { if (Object.prototype.hasOwnProperty.call(TG_GRUPOS, id) && TG_GRUPOS[id].tipos.indexOf(p) >= 0) return id; }
  return '';
}
function tgItensDoGrupo(catalog, grupo) {
  var out = [], i, it;
  if (!Array.isArray(catalog) || !TG_GRUPOS[grupo]) return out;
  for (i = 0; i < catalog.length; i++) { it = catalog[i]; if (it && typeof it.n === 'string' && tgDisponivel(it) && tgGrupoDoItem(it) === grupo) out.push(it); }
  return out;
}
function tgChipDoGrupo(grupo, id) {
  var g = TG_GRUPOS[grupo], i;
  if (!g) return null;
  for (i = 0; i < g.chips.length; i++) { if (g.chips[i].id === id) return g.chips[i]; }
  return null;
}
function tgItensDoChip(catalog, grupo, id) {
  var chip = tgChipDoGrupo(grupo, id), base, out = [], i, it, n, tags, t, j, achou;
  if (!chip || chip.novidades) return tgItensDoGrupo(catalog, grupo);
  if (chip.regra === 'wedding') return tgSelecaoVestidos(catalog, 'wedding');
  base = tgItensDoGrupo(catalog, grupo);
  for (i = 0; i < base.length; i++) {
    it = base[i]; achou = false;
    tags = Array.isArray(it.g) ? it.g : [];
    for (j = 0; j < tags.length && !achou; j++) { t = String(tags[j]).toLowerCase(); if (chip.tags && chip.tags.indexOf(t) >= 0) achou = true; }
    if (!achou && chip.nomes) {
      n = ' ' + normalizeText(it.n) + ' ';
      for (j = 0; j < chip.nomes.length && !achou; j++) { if (n.indexOf(' ' + chip.nomes[j] + ' ') >= 0) achou = true; }
    }
    if (achou) out.push(it);
  }
  return out;
}
// Chips do grupo que valem a pena mostrar: [{ id, rotulo, novidades? }]. Chip sem peca no grupo some (Novidades fica).
function tgChipsDoGrupo(catalog, grupo) {
  var g = TG_GRUPOS[grupo], out = [], i, c;
  if (!g) return out;
  for (i = 0; i < g.chips.length; i++) {
    c = g.chips[i];
    if (c.novidades || tgItensDoChip(catalog, grupo, c.id).length) out.push({ id: c.id, rotulo: c.rotulo, novidades: !!c.novidades });
  }
  return out;
}
// Categoria "Novidades da Semana" (a ordem dela vale para Lancamentos e para o chip Novidades).
var TG_NOVIDADES_URL = '/novidades/novidades-da-semana/';


/* ---- src/injetor/seguro.js ---- */
/*
 * Saida segura (SEG-01). Toda a pagina que o injetor escreve passa por aqui.
 * Regra: texto de fora (URL, campo de busca, catalogo) vira no de texto ou valor de atributo gravado por setAttribute.
 * Nenhuma API que interprete texto como HTML, nenhum atributo on*, enderecos so no formato esperado.
 * Os marcadores node:inicio / node:fim delimitam a exportacao para o Node; o build remove esse bloco.
 */
var TG_IMG = 'https://acdn-us.mitiendanube.com/stores/007/014/041/products/';
var TG_RE_HANDLE = /^[a-z0-9][a-z0-9-]{0,200}$/;
var TG_RE_IMG = /^[\w.-]{1,300}$/;
var TG_RE_ATTR = /^(class|id|href|src|alt|loading|decoding|width|height|role|type|aria-[a-z-]+|data-[a-z0-9-]+)$/;

// Valor de href aceito: caminho do proprio site (comeca com uma barra, nao com duas). Nada de esquema, nada de outro host.
function tgHrefOk(v) { return /^\/(?![\/\\])[^\s\u0000-\u001f]*$/.test(v); }
// Valor de src aceito: so o prefixo fixo das imagens da loja.
function tgSrcOk(v) { return v.indexOf(TG_IMG) === 0 && TG_RE_IMG.test(v.slice(TG_IMG.length)); }

function el(tag, atributos, filhos) {
  var no = document.createElement(tag), k, nome, v, i, f;
  if (atributos) {
    for (k in atributos) {
      if (!Object.prototype.hasOwnProperty.call(atributos, k)) { continue; }
      nome = String(k).toLowerCase();
      v = atributos[k];
      if (v == null || /^on/.test(nome) || !TG_RE_ATTR.test(nome)) { continue; }
      v = String(v);
      if (nome === 'href' && !tgHrefOk(v)) { continue; }
      if (nome === 'src' && !tgSrcOk(v)) { continue; }
      no.setAttribute(nome, v);
    }
  }
  if (filhos) {
    for (i = 0; i < filhos.length; i++) {
      f = filhos[i];
      if (f == null) { continue; }
      no.appendChild(typeof f === 'object' ? f : document.createTextNode(String(f)));
    }
  }
  return no;
}

function urlProduto(s) { return typeof s === 'string' && TG_RE_HANDLE.test(s) ? '/produtos/' + s + '/' : null; }
function urlImagem(i) { return typeof i === 'string' && TG_RE_IMG.test(i) ? TG_IMG + i : null; }
function urlBusca(termo) { return '/search/?q=' + encodeURIComponent(String(termo)); }

// Foto do item: sem nome de imagem valido nao existe <img>. O alt e atributo (texto), nunca HTML.
// Liga/desliga a classe que esconde a busca nativa enquanto a nossa nao assumiu (o CSS esta no topo do tema e em estilos.js).
function tgPend(ligar) {
  try { document.documentElement.classList[ligar ? 'add' : 'remove']('tg-busca-pendente'); if (!ligar) { document.documentElement.classList.remove('tg-busca-pg'); } } catch (e) {}
}

// Foto leve (so a tela do celular liga, em estilos.js): o CDN da loja tem a mesma foto em webp nas larguras 100/320/480/640; a de 1024 em JPG pesa
// cerca de 99 KB e a de 640 em webp cerca de 20 KB. Se a versao leve falhar, a <img> volta sozinha para a original (uma vez).
var tgFotoLeve = false;
function urlImagemLeve(i, larg) {
  var u = urlImagem(i);
  if (!u || !tgFotoLeve || !/^(100|320|480|640)$/.test(String(larg))) { return u; }
  return u.replace(/-1024-1024\.(jpe?g|png|webp)$/i, '-' + larg + '-0.webp');
}
function tgFotoReserva(img, original) {
  if (img && original && img.getAttribute('src') !== original) {
    img.addEventListener('error', function () { try { if (img.getAttribute('src') !== original) { img.setAttribute('src', original); } } catch (e) {} }, { once: true });
  }
  return img;
}

function foto(item, classe) {
  var src = urlImagem(item && item.i);
  if (!src) { return null; }
  return tgFotoReserva(el('img', { 'class': classe, src: urlImagemLeve(item.i, 640), alt: item.n, loading: 'lazy', decoding: 'async' }), src);
}

// Pilulas de tamanho: so texto, ate "max". "destaque" (opcional, lista de tamanhos em maiusculas): na busca por tamanho a pilula do tamanho pedido
// sempre aparece (mesmo alem do corte de "max") e ganha a classe tg-busca-pilula-pedida; a ordem natural dos tamanhos e mantida.
function pilulas(sz, max, destaque) {
  var validos = [], pedidos = {}, escolhidos = {}, usados = 0, out = [], i, v;
  if (!Array.isArray(sz)) { return null; }
  for (i = 0; i < sz.length; i++) { if (typeof sz[i] === 'string' && sz[i]) { validos.push(sz[i]); } }
  if (Array.isArray(destaque)) {
    for (i = 0; i < destaque.length; i++) { if (typeof destaque[i] === 'string') { pedidos[destaque[i].toUpperCase()] = true; } }
    for (i = 0; i < validos.length && usados < max; i++) { if (pedidos[validos[i].toUpperCase()]) { escolhidos[i] = true; usados++; } }
  }
  for (i = 0; i < validos.length && usados < max; i++) { if (!escolhidos[i]) { escolhidos[i] = true; usados++; } }
  for (i = 0; i < validos.length; i++) {
    if (!escolhidos[i]) { continue; }
    v = validos[i];
    out.push(el('span', { 'class': pedidos[v.toUpperCase()] ? 'tg-busca-pilula tg-busca-pilula-pedida' : 'tg-busca-pilula' }, [v]));
  }
  return out.length ? el('div', { 'class': 'tg-busca-pilulas' }, out) : null;
}


/* ---- src/injetor/preco.js ---- */
/*
 * Preco como na vitrine (AUTO-02): promocional em destaque e cheio riscado quando pp < p; so o cheio sem promocao.
 * O catalogo traz p (cheio) e pp (promocional da mesma variante). Item sem preco valido nao aparece.
 * Sem linha de Pix nesta fase (DP5).
 */
var TG_FMT = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function tgNum(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }

function precoFinal(item) {
  if (!item) { return null; }
  var p = tgNum(item.p), pp = tgNum(item.pp);
  if (!(p > 0)) { return null; }
  return pp > 0 && pp < p ? { final: pp, de: p } : { final: p, de: null };
}

// "R$59,90", "R$1.299,00" (sem espaco, como a vitrine)
function reais(v) { return 'R$' + TG_FMT.format(v); }

// Bloco de preco para a lista e para os cards: <span><strong>final</strong><s>cheio</s></span>. Devolve null se o item nao tem preco valido.
function blocoPreco(item) {
  var pr = precoFinal(item);
  if (!pr) { return null; }
  return el('span', { 'class': 'tg-busca-preco' }, [
    el('strong', null, [reais(pr.final)]),
    pr.de ? el('s', { 'class': 'tg-busca-de' }, [reais(pr.de)]) : null,
    linhaPix(pr.final)
  ]);
}
// QA 3.4 (Danilo, 25/11): o card mostra o preco no Pix (5% de desconto da loja, o mesmo que o modal le da pagina da peca), numa linha discreta
var TG_PIX_DESCONTO = 0.05;
// conta em centavos inteiros, meio centavo arredonda para cima (como a loja: R$89,90 -> R$85,41)
function precoPix(v) { var n = tgNum(v), c; if (!(n > 0)) { return null; } c = Math.round(n * 100); return Math.round(c * Math.round((1 - TG_PIX_DESCONTO) * 100) / 100) / 100; }
function linhaPix(v) { var x = precoPix(v); return x ? el('span', { 'class': 'tg-busca-pix' }, [el('span', { 'class': 'tg-busca-pix-v' }, [reais(x)]), ' no Pix']) : null; }


/* ---- src/injetor/rastreio.js ---- */
/*
 * Medicao (MED-02), no mesmo caminho do tema (padrao do tg-medidas): gtagTN com send_to, espelho no dataLayer, fila do Clarity.
 * Nunca define window.gtagTN nem window.clarity. Nunca cria tag no GTM. Parametros so de uma lista fechada,
 * nunca o texto digitado nem a URL.
 */
var TG_GA4 = 'G-QK83GW3WCR';
var TG_PARAMS = ['engine_version', 'engine_mode', 'engine_group', 'page_type', 'position', 'query_len', 'had_correction', 'results_count', 'rescue_type', 'reason'];
var tgFilaC = [], tgTimerC = 0;

// Fila do Clarity: tenta a cada 250 ms por ate cerca de 10 s e nunca cria window.clarity.
function clarityFila(args) {
  var n = 0;
  tgFilaC.push(args);
  if (tgTimerC) { return; }
  tgTimerC = setInterval(function () {
    try {
      if (typeof window.clarity === 'function') { tgFilaC.splice(0).forEach(function (a) { window.clarity.apply(window, a); }); }
    } catch (e) { tgFilaC = []; }
    if (!tgFilaC.length || ++n > 40) { clearInterval(tgTimerC); tgTimerC = 0; tgFilaC = []; }
  }, 250);
}

// Valor aceito: numero finito, ou texto de ate 100 caracteres sem e-mail e sem sequencia longa de digitos.
function tgValor(v) {
  if (typeof v === 'number') { return isFinite(v) ? v : undefined; }
  if (typeof v !== 'string') { return undefined; }
  v = v.slice(0, 100);
  return v.indexOf('@') >= 0 || /\d{9,}/.test(v) ? undefined : v;
}

function emitir(nome, params) {
  try {
    if (typeof window.gtagTN !== 'function') { return; }
    var ev = {}, k, i, v;
    for (i = 0; i < TG_PARAMS.length; i++) {
      k = TG_PARAMS[i];
      if (params && Object.prototype.hasOwnProperty.call(params, k)) {
        v = tgValor(params[k]);
        if (v !== undefined) { ev[k] = v; }
      }
    }
    // Teste A/B (pacote D): todo evento tg_busca_* leva o grupo da visitante ('novo'), vindo do contexto do carregador. Sem grupo (modos preview/on), nada.
    if (typeof tgCtx !== 'undefined' && tgCtx && tgCtx.grupo === 'novo') { ev.engine_group = 'novo'; }
    try {
      if (window.dataLayer && typeof window.dataLayer.push === 'function') {
        var d = { event: nome }; for (k in ev) { d[k] = ev[k]; }
        window.dataLayer.push(d);
      }
    } catch (e) {}
    try {
      var g = { send_to: TG_GA4 }; for (k in ev) { g[k] = ev[k]; }
      window.gtagTN('event', nome, g);
    } catch (e) {}
    clarityFila(['event', nome]);
  } catch (e) {}
}


/* ---- src/injetor/catalogo.js ---- */
/*
 * Catalogo que falha fechado (PRV-03): qualquer problema devolve { motivo } e o motor desiste em silencio.
 * Sem copia no armazenamento da sessao, sem global da pagina. Campos do catalogo: id, n, s, c, p, pp, i, t, b, sz e g (opcional, tags de ocasiao).
 */
var TG_CAT_MAX_BYTES = 2 * 1024 * 1024;
var TG_CAT_MIN = 50;
// Tempo limite do catalogo (L21): 4 s. Em 3G o arquivo (65 KB comprimido) leva cerca de 2,5 s mesmo sozinho e, com a pagina da loja
// ocupando a linha principal (CPU lenta), o limite antigo de 2 s vencia com o catalogo ja baixado. A nativa segue usavel durante a espera.
var TG_CAT_TIMEOUT_MS = 4000;

// Tag de ocasiao aceita no campo g: minuscula, sem acento, 1 a 30 caracteres de a-z, 0-9, espaco, sublinhado e hifen.
var TG_CAT_G_RE = /^[a-z0-9][a-z0-9 _-]{0,29}$/;
var TG_CAT_G_MAX = 8;

function tgHandleOk(s) { return typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,200}$/.test(s); }
function tgNumOk(v) { return typeof v === 'number' && isFinite(v); }

// Devolve uma lista limpa (itens invalidos descartados) ou null. "bytes" e o tamanho do corpo, quando se sabe.
function validarCatalogo(dados, bytes) {
  var out = [], i, x, o, j, sz, g, tag;
  if (!Array.isArray(dados) || dados.length < TG_CAT_MIN) { return null; }
  if (typeof bytes === 'number' && bytes > TG_CAT_MAX_BYTES) { return null; }
  for (i = 0; i < dados.length; i++) {
    x = dados[i];
    if (!x || typeof x !== 'object') { continue; }
    if (typeof x.n !== 'string' || !x.n || !tgHandleOk(x.s) || !tgNumOk(x.p) || !(x.p > 0)) { continue; }
    o = { id: x.id, n: x.n, s: x.s, c: typeof x.c === 'string' ? x.c : '', p: x.p };
    if (tgNumOk(x.pp)) { o.pp = x.pp; }
    if (typeof x.i === 'string') { o.i = x.i; }
    if (tgNumOk(x.t)) { o.t = x.t; }
    if (tgNumOk(x.b)) { o.b = x.b; }
    if (Array.isArray(x.sz)) {
      sz = [];
      for (j = 0; j < x.sz.length; j++) { if (typeof x.sz[j] === 'string' && x.sz[j]) { sz.push(x.sz[j]); } }
      o.sz = sz;
    }
    // g (opcional): tags de ocasiao da peca (ex.: wedding). So texto simples em minusculas, ate TG_CAT_G_MAX; nunca e mostrado na tela, so comparado
    // com a configuracao da busca curada. Qualquer valor fora do formato e descartado sem derrubar a peca.
    if (Array.isArray(x.g)) {
      g = [];
      for (j = 0; j < x.g.length && g.length < TG_CAT_G_MAX; j++) {
        tag = typeof x.g[j] === 'string' ? x.g[j].toLowerCase() : '';
        if (TG_CAT_G_RE.test(tag) && g.indexOf(tag) < 0) { g.push(tag); }
      }
      if (g.length) { o.g = g; }
    }
    out.push(o);
  }
  return out.length >= TG_CAT_MIN ? out : null;
}

// Catalogo de esgotados (REL-04): mesmas regras do catalogo normal (formato de cada item, minimo de itens, 2 MB, falha fechada), mas o que sai daqui
// NUNCA tem tamanho em estoque: de cada item so ficam id, n, s, c, p e i, marcados com so = 1. Se o arquivo trouxer sz, pp, t, b ou g, e ignorado,
// entao nada que venha desse arquivo pode aparecer como peca em estoque.
function validarEsgotados(dados, bytes) {
  var base = validarCatalogo(dados, bytes), out = [], i, x, o;
  if (!base) { return null; }
  for (i = 0; i < base.length; i++) {
    x = base[i];
    o = { id: x.id, n: x.n, s: x.s, c: x.c, p: x.p, so: 1 };
    if (typeof x.i === 'string') { o.i = x.i; }
    out.push(o);
  }
  return out;
}

// Endereco do catalogo de esgotados, a partir do endereco do catalogo normal (mesma pasta, outro arquivo). Qualquer outro formato = sem esgotados.
var TG_ESG_ARQUIVO = /\/search_catalog\.min\.json$/;
function urlEsgotados(urlCatalogo) {
  if (typeof urlCatalogo !== 'string' || !TG_ESG_ARQUIVO.test(urlCatalogo)) { return null; }
  return urlCatalogo.replace(TG_ESG_ARQUIVO, '/search_catalog_soldout.min.json');
}

// Nunca lanca. Devolve { itens } ou { motivo }: cat_rede, cat_timeout, cat_http, cat_json, cat_formato, cat_poucos.
// "validar" (opcional): quem valida e limpa a lista (padrao: validarCatalogo; os esgotados usam validarEsgotados).
function carregarCatalogo(url, timeoutMs, validar) {
  var ctl, tm, esgotou = false;
  validar = validar || validarCatalogo;
  function fim(r) { clearTimeout(tm); return r; }
  try {
    if (typeof fetch !== 'function' || typeof AbortController !== 'function') { return Promise.resolve({ motivo: 'cat_rede' }); }
    ctl = new AbortController();
    tm = setTimeout(function () { esgotou = true; ctl.abort(); }, timeoutMs || TG_CAT_TIMEOUT_MS);
    return fetch(url, { cache: 'no-cache', credentials: 'omit', signal: ctl.signal }).then(function (r) {
      var cl;
      if (!r || !r.ok || r.status !== 200) { return fim({ motivo: 'cat_http' }); }
      cl = r.headers && r.headers.get ? Number(r.headers.get('content-length')) : 0;
      if (cl > TG_CAT_MAX_BYTES) { return fim({ motivo: 'cat_formato' }); }
      return r.text().then(function (txt) {
        var dados, itens;
        if (txt.length > TG_CAT_MAX_BYTES) { return fim({ motivo: 'cat_formato' }); }
        try { dados = JSON.parse(txt); } catch (e) { return fim({ motivo: 'cat_json' }); }
        if (!Array.isArray(dados)) { return fim({ motivo: 'cat_formato' }); }
        if (dados.length < TG_CAT_MIN) { return fim({ motivo: 'cat_poucos' }); }
        itens = validar(dados, txt.length);
        return fim(itens ? { itens: itens } : { motivo: 'cat_poucos' });
      });
    })['catch'](function () {
      return fim({ motivo: esgotou ? 'cat_timeout' : 'cat_rede' });
    });
  } catch (e) {
    return Promise.resolve(fim({ motivo: 'cat_rede' }));
  }
}


function tgFrenteCelular() {
/* ---- src/injetor/estilos.js ---- */
/*
 * Estilos do injetor (redesign 18/11/2026). Todas as classes sob o prefixo .tg-busca- e os ids sob #tg-busca-, para nao colidir com o tema nem com os apps.
 * Entra por <style> com textContent, uma vez.
 *
 * TODO valor de design e uma variavel CSS --tgb-* com o padrao definido em TG_TOKENS (uma linha por variavel, formato fixo: a bancada
 * tools/bancada/aplicar-parametros.cjs regrava o padrao lendo esta lista). As variaveis ficam em :root (especificidade minima), entao quem quiser
 * ajustar ao vivo basta fazer document.documentElement.style.setProperty('--tgb-...', valor).
 * Fonte, cor do texto, fundo e destaque HERDAM do tema da Talgui (Morelia: --body-font, --heading-font, --main-foreground, --main-background,
 * --accent-color, --label-background), com reserva para quando a variavel do tema nao existe (bancada, testes).
 */
// A tela do celular usa as fotos leves do CDN (webp 640/320) com volta automatica para a original; o desktop segue com as fotos de sempre.
try { tgFotoLeve = true; } catch (e) {}

var TG_TOKENS = [
  // tipografia
  ['--tgb-fonte', 'var(--body-font,"Poppins"),"Poppins",Arial,sans-serif'],
  ['--tgb-fonte-titulo', 'var(--heading-font,"Graphik"),var(--tgb-fonte)'],
  // cores
  ['--tgb-cor-texto', 'var(--main-foreground,#111111)'],
  ['--tgb-cor-texto-suave', '#6f6a64'],
  ['--tgb-cor-fundo', 'var(--main-background,#ffffff)'],
  ['--tgb-cor-fundo-suave', '#f5f2ed'],
  ['--tgb-cor-borda', '#d6d0c8'],
  ['--tgb-cor-destaque', 'var(--accent-color,#000000)'],
  ['--tgb-cor-destaque-texto', '#ffffff'],
  ['--tgb-cor-promo', 'var(--tgb-cor-texto)'],
  ['--tgb-cor-selo-texto', '#111111'],
  ['--tgb-cor-selo-oferta', 'var(--label-background,#c80003)'],
  ['--tgb-cor-selo-best', '#ffffff'],
  ['--tgb-cor-selo-ultimas', '#ffffff'],
  ['--tgb-cor-selo-esgotado', '#ffffff'],
  ['--tgb-cor-sucesso', 'var(--success,#2e8b63)'],
  ['--tgb-cor-erro', 'var(--danger,#c0392b)'],
  // pagina e grade
  ['--tgb-pad-pagina', '16px'],
  ['--tgb-pad-card', '0px'],
  ['--tgb-gap-grade', '9px'],
  ['--tgb-gap-linha', '24px'],
  ['--tgb-colunas-mobile', '2'],
  ['--tgb-colunas-desktop', '4'],
  ['--tgb-raio-card', '0px'],
  ['--tgb-sombra-card', 'none'],
  ['--tgb-foto-proporcao', '2 / 3'],
  ['--tgb-foto-ajuste', 'cover'],
  ['--tgb-foto-fundo', '#f1eee9'],
  // nome, preco e selo
  ['--tgb-nome-tam', '13.5px'],
  ['--tgb-nome-peso', '300'],
  ['--tgb-nome-linhas', '2'],
  ['--tgb-nome-transformacao', 'none'],
  ['--tgb-preco-tam', '13px'],
  ['--tgb-preco-peso', '400'],
  ['--tgb-preco-de-tam', '11.5px'],
  ['--tgb-selo-tam', '10px'],
  ['--tgb-selo-raio', '0px'],
  ['--tgb-selo-espaco', '0px'],
  // bolinhas de cor, tamanhos, botao e chips
  ['--tgb-bolinha-tam', '18px'],
  ['--tgb-bolinha-gap', '8px'],
  ['--tgb-tamanho-btn', '24px'],
  ['--tgb-tamanho-fonte', '11.5px'],
  ['--tgb-tamanho-gap', '4px'],
  ['--tgb-tamanho-raio', '0'],
  ['--tgb-botao-altura', '40px'],
  ['--tgb-botao-raio', '2px'],
  ['--tgb-botao-fonte', '12.5px'],
  ['--tgb-botao-peso', '600'],
  ['--tgb-botao-transformacao', 'uppercase'],
  ['--tgb-botao-espaco', '0.06em'],
  ['--tgb-chip-tam', '11px'],
  ['--tgb-chip-altura', '28px'],
  ['--tgb-chip-raio', '2px'],
  ['--tgb-chip-gap', '2px'],
  // overlay de busca
  ['--tgb-z', '99990'],
  ['--tgb-ov-campo-altura', '46px'],
  ['--tgb-ov-campo-fonte', '15px'],
  ['--tgb-ov-termo-tam', '13.5px'],
  ['--tgb-ov-titulo-tam', '12px'],
  ['--tgb-ov-max-largura', '1190px'],
  ['--tgb-ov-raio', '0 0 14px 14px'],
  ['--tgb-ov-fundo-escuro', 'rgba(0,0,0,.7)'],
  ['--tgb-ov-colunas-mobile', '2'],
  ['--tgb-ov-colunas-desktop', '6'],
  // barra da pagina de resultados
  ['--tgb-barra-altura', '36px'],
  ['--tgb-barra-fonte', '11px'],
  ['--tgb-barra-posicao', 'sticky'],
  ['--tgb-barra-topo', '0px'],
  ['--tgb-barra-fundo', 'var(--tgb-cor-fundo)']
];

// Cor da bolinha: o nome da cor (sem acento, minuscula, espacos viram hifen) escolhe o tom, SEM atributo style (a saida segura nao aceita style).
// Cada linha: [nomes (masculino e feminino), tom]. Nome fora da lista usa o tom neutro (data-cor="outro").
var TG_COR_TONS = [
  [['preto', 'preta'], '#161616'], [['branco', 'branca'], '#fafafa'], [['off-white', 'offwhite', 'cru', 'creme'], '#f0e9dc'],
  [['bege', 'nude', 'areia', 'fendi'], '#d8c3a5'], [['marrom', 'cafe', 'chocolate'], '#6b4a35'], [['caramelo', 'camel', 'terracota'], '#b97a47'],
  [['cinza', 'grafite', 'chumbo'], '#8d8d8d'], [['prata'], '#c4c7cc'], [['dourado', 'dourada', 'ouro'], '#c9a54a'],
  [['vermelho', 'vermelha', 'goiaba', 'coral'], '#c62828'], [['vinho', 'bordo', 'marsala'], '#6e1423'], [['rosa', 'rose', 'salmao'], '#e8a2b4'],
  [['pink', 'fucsia', 'magenta'], '#d81b79'], [['rosa-claro'], '#f4cdd6'], [['laranja'], '#e8742a'],
  [['amarelo', 'amarela', 'amarelo-sol', 'amarelo-ouro', 'amarelo-canario'], '#f2c230'], [['amarelo-claro', 'amarela-claro', 'manteiga'], '#f6e7a4'],
  [['mostarda'], '#c99a1d'], [['verde'], '#3f8f5b'], [['verde-claro', 'verde-agua', 'verde-menta', 'menta'], '#a8d8be'],
  [['verde-militar', 'verde-oliva', 'verde-musgo', 'oliva', 'musgo'], '#5b6b3a'], [['verde-floresta', 'verde-esmeralda', 'esmeralda'], '#1f5d3f'],
  [['verde-limao'], '#b5d334'], [['azul'], '#2f63b5'], [['azul-claro', 'azul-bebe', 'azul-celeste', 'celeste'], '#9cc6ec'],
  [['azul-marinho', 'marinho'], '#18284d'], [['azul-royal', 'azul-turquesa', 'turquesa'], '#1c7fc2'], [['azul-jeans', 'jeans'], '#4a6a94'],
  [['petroleo'], '#1d4b57'], [['roxo', 'roxa', 'uva'], '#6a3f93'], [['lilas', 'lavanda'], '#b9a4d6']
];

var TG_CSS_BASE = [
  '.tg-busca-oculto,#tg-busca-overlay.tg-busca-oculto{display:none!important}',
  '.tg-busca-sr{position:absolute!important;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
  'html.tg-busca-trava,html.tg-busca-trava body{overflow:hidden!important}',
  '.tg-busca-nativo-oculto{display:none!important}',
  // enquanto a busca nova nao assumiu (classe no <html>, posta pelo topo do tema ou pela lupa), a lista e as sugestoes da nativa ficam escondidas
  'html.tg-busca-pendente.tg-busca-pg .js-product-table,html.tg-busca-pendente.tg-busca-pg .js-load-more,html.tg-busca-pendente.tg-busca-pg #js-infinite-scroll-spinner,html.tg-busca-pendente #nav-search [class*="search-suggest"],html.tg-busca-pendente #nav-search .search-initial-products{display:none!important}',
  // celular: entre o toque na lupa e a abertura da busca nova, o modal nativo nao aparece (o overlay abre por cima no mesmo instante)
  'html.tg-busca-pendente #nav-search .modal-scrollable-area{opacity:0!important}',
  '#tg-busca-conselheira{display:none}',
  // base comum a tudo que o injetor desenha
  '#tg-busca-overlay,#tg-busca-resultados,#tg-busca-resgate,#tg-busca-curada{font-family:var(--tgb-fonte);color:var(--tgb-cor-texto);-webkit-font-smoothing:antialiased;line-height:1.35}',
  '#tg-busca-overlay *,#tg-busca-resultados *,#tg-busca-resgate *,#tg-busca-curada *{box-sizing:border-box}',
  '#tg-busca-overlay button,#tg-busca-resultados button,#tg-busca-resgate button,#tg-busca-curada button{font-family:inherit}',
  '#tg-busca-overlay :focus-visible,#tg-busca-resultados :focus-visible,#tg-busca-resgate :focus-visible,#tg-busca-curada :focus-visible{outline:2px solid var(--tgb-cor-destaque);outline-offset:2px}',
  // icones feitos em CSS (a saida segura nao aceita SVG)
  // lupa com a mesma geometria e o mesmo peso (1,6px) da lupa do tema, que combina com o icone do Menu; so CSS (a saida segura nao aceita SVG nem url())
  '.tg-busca-ico-lupa{position:relative;display:inline-block;width:18px;height:18px;flex:0 0 18px;color:inherit}',
  '.tg-busca-ico-lupa::before{content:"";position:absolute;left:0;top:.2px;width:13.9px;height:13.9px;border:1.6px solid currentColor;border-radius:50%;box-sizing:border-box}',
  '.tg-busca-ico-lupa::after{content:"";position:absolute;left:11.9px;top:12.4px;width:7px;height:1.7px;border-radius:1px;background:currentColor;transform:rotate(45deg);transform-origin:0 50%}'
];

var TG_CSS_OVERLAY = [
  '#tg-busca-overlay{position:fixed;top:0;right:0;bottom:0;left:0;z-index:var(--tgb-z);display:flex;flex-direction:column;background:var(--tgb-cor-fundo)}',
  '#tg-busca-overlay.tg-busca-aberto{animation:tg-busca-entra .18s ease-out}',
  '.tg-busca-ov-painel{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:var(--tgb-cor-fundo)}',
  '.tg-busca-ov-form{display:flex;align-items:center;gap:2px;flex:0 0 auto;height:var(--tgb-ov-campo-altura);margin:0;padding:0 6px;border-bottom:1px solid var(--tgb-cor-borda)}',
  '.tg-busca-ov-campo{flex:1;min-width:0;height:100%;margin:0;padding:0 6px;border:0;border-radius:0;outline:0;background:transparent;color:inherit;font-family:inherit;font-size:var(--tgb-ov-campo-fonte);-webkit-appearance:none;appearance:none;box-shadow:none}',
  '#tg-busca-overlay .tg-busca-ov-campo:focus,#tg-busca-overlay .tg-busca-ov-campo:focus-visible{outline:0;box-shadow:none}',
  '.tg-busca-ov-campo::-webkit-search-cancel-button,.tg-busca-ov-campo::-webkit-search-decoration{display:none;-webkit-appearance:none}',
  '.tg-busca-ov-campo::placeholder{color:var(--tgb-cor-texto-suave);opacity:1}',
  '.tg-busca-ov-btn{display:flex;align-items:center;justify-content:center;flex:0 0 44px;width:44px;height:44px;margin:0;padding:0;border:0;border-radius:50%;background:transparent;color:inherit;font-size:26px;line-height:1;cursor:pointer}',
  '.tg-busca-ov-btn:hover{background:var(--tgb-cor-fundo-suave)}',
  // voltar: chevron em CSS com o mesmo traco (1,6px) da lupa, no lugar do caractere fino
  '.tg-busca-ico-voltar{display:block;width:11px;height:11px;margin-left:5px;border-left:1.6px solid currentColor;border-bottom:1.6px solid currentColor;transform:rotate(45deg)}',
  '.tg-busca-ov-corpo{flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:0 var(--tgb-pad-pagina) 28px}',
  '#tg-busca-sugestoes{margin:0;background:transparent;border:0;box-shadow:none;max-height:none;overflow:visible}',
  '.tg-busca-secao-titulo{margin:20px 0 8px;font-family:var(--tgb-fonte-titulo);font-size:var(--tgb-ov-titulo-tam);font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--tgb-cor-texto-suave)}',
  '.tg-busca-secao-titulo:first-child{margin-top:16px}',
  '.tg-busca-termos{list-style:none;margin:6px 0 0;padding:0}',
  '.tg-busca-termos li{display:flex;align-items:center}',
  '.tg-busca-termo{display:flex;align-items:center;flex:1;gap:12px;min-width:0;min-height:48px;color:inherit;text-decoration:none;font-size:var(--tgb-ov-termo-tam)}',
  '.tg-busca-termo-texto{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
  '.tg-busca-termo-texto strong{font-weight:700}',
  '.tg-busca-recentes{list-style:none;margin:0;padding:0}',
  '.tg-busca-recentes li{display:flex;align-items:center}',
  '.tg-busca-recentes-topo{display:flex;align-items:baseline;justify-content:space-between;gap:12px}',
  '.tg-busca-recentes-topo .tg-busca-limpar{padding:6px 0 6px 12px;letter-spacing:0;text-transform:none;font-weight:400}',
  '.tg-busca-limpar{margin:0;padding:6px 0;border:0;background:none;color:var(--tgb-cor-texto-suave);font-size:12px;text-decoration:underline;cursor:pointer}',
  '.tg-busca-banner{margin:12px 0 0;padding:10px 12px;background:var(--tgb-cor-fundo-suave);border-radius:var(--tgb-raio-card);font-size:13px;color:var(--tgb-cor-texto-suave)}',
  '.tg-busca-banner strong,.tg-busca-sugerido{color:var(--tgb-cor-texto);font-weight:700}',
  '.tg-busca-sugerido{cursor:pointer;text-decoration:underline;background:none;border:0;padding:0;font:inherit;font-weight:700}',
  // peca na lista do overlay: card enxuto (foto, nome, preco, selo, tamanhos), sem botao de adicionar
  '.tg-busca-lista{display:grid;grid-template-columns:repeat(var(--tgb-ov-colunas-mobile),minmax(0,1fr));gap:var(--tgb-gap-linha) var(--tgb-gap-grade);margin:0;padding:0;list-style:none}',
  '.tg-busca-item{display:flex;flex-direction:column;min-width:0;color:inherit;text-decoration:none}',
  '.tg-busca-info{min-width:0;margin-top:8px}',
  '.tg-busca-meta{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;margin-bottom:6px}',
  '.tg-busca-pilulas{display:flex;flex-wrap:wrap;gap:4px}',
  '.tg-busca-meta .tg-busca-selo{padding:0;box-shadow:none;background:none;color:var(--tgb-cor-texto-suave);font-size:10px;letter-spacing:.08em}',
  '.tg-busca-pilula{padding:2px 6px;border:1px solid var(--tgb-cor-borda);border-radius:var(--tgb-tamanho-raio);color:var(--tgb-cor-texto-suave);font-size:10px;font-weight:500;line-height:1.3}',
  '.tg-busca-pilula-pedida{border-color:var(--tgb-cor-destaque);background:var(--tgb-cor-destaque);color:var(--tgb-cor-destaque-texto);font-weight:700}',
  '.tg-busca-item-esgotado .tg-busca-thumb{filter:grayscale(1);opacity:.55}',
  '.tg-busca-bloco-titulo{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:20px 0 8px;font-family:var(--tgb-fonte-titulo);font-size:var(--tgb-ov-titulo-tam);font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--tgb-cor-texto-suave)}',
  '.tg-busca-bloco-qtd{font-weight:500;letter-spacing:.04em}',
  '.tg-busca-todos{display:flex;align-items:center;justify-content:center;width:100%;height:var(--tgb-botao-altura);margin:22px 0 0;border:1px solid var(--tgb-cor-destaque);border-radius:var(--tgb-botao-raio);background:var(--tgb-cor-destaque);color:var(--tgb-cor-destaque-texto);font-size:var(--tgb-botao-fonte);font-weight:var(--tgb-botao-peso);letter-spacing:var(--tgb-botao-espaco);text-transform:var(--tgb-botao-transformacao);text-decoration:none}'
];

var TG_CSS_CARD = [
  '.tg-busca-thumb{display:block;width:100%;height:auto;aspect-ratio:var(--tgb-foto-proporcao);object-fit:var(--tgb-foto-ajuste);background:var(--tgb-foto-fundo);border-radius:var(--tgb-raio-card)}',
  '.tg-busca-nome{min-height:calc(var(--tgb-nome-linhas) * 1.3em);display:-webkit-box;word-break:break-word;-webkit-box-orient:vertical;-webkit-line-clamp:var(--tgb-nome-linhas);overflow:hidden;margin:0 0 4px;font-size:var(--tgb-nome-tam);font-weight:var(--tgb-nome-peso);line-height:1.3;text-transform:var(--tgb-nome-transformacao)}',
  '.tg-busca-preco{display:inline-flex;align-items:baseline;flex-wrap:wrap;gap:2px 6px;font-size:var(--tgb-preco-tam)}',
  '.tg-busca-preco strong{font-weight:var(--tgb-preco-peso)}',
  '.tg-busca-preco strong:not(:last-child){color:var(--tgb-cor-promo)}',
  '.tg-busca-de{font-size:var(--tgb-preco-de-tam);font-weight:400;color:var(--tgb-cor-texto-suave);text-decoration:line-through}',
  '.tg-busca-selo{display:inline-block;padding:5px 8px;box-shadow:0 1px 2px rgba(0,0,0,.12);border-radius:var(--tgb-selo-raio);color:var(--tgb-cor-selo-texto);font-size:var(--tgb-selo-tam);font-weight:600;line-height:1;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap}',
  '.tg-busca-selo-campeao{background:var(--tgb-cor-selo-best)}',
  '.tg-busca-selo-ultimas{background:var(--tgb-cor-selo-ultimas)}',
  '.tg-busca-selo-oferta{background:var(--tgb-cor-selo-oferta);color:#fff}',
  '.tg-busca-selo-esgotado{background:var(--tgb-cor-selo-esgotado)}',
  '.tg-busca-grade{display:grid;grid-template-columns:repeat(var(--tgb-colunas-mobile),minmax(0,1fr));gap:var(--tgb-gap-linha) var(--tgb-gap-grade);margin:0;padding:0;text-align:left}',
  '.tg-busca-grade.tg-busca-grade-um{grid-template-columns:minmax(0,1fr)}',
  '.tg-busca-grade.tg-busca-grade-um .tg-busca-card .tg-busca-add.tg-busca-ver{width:calc(50% - var(--tgb-gap-grade) / 2 - 16px)}',  // v14: igual ao da grade de 2
  '.tg-busca-card{position:relative;display:flex;flex-direction:column;min-width:0;padding:var(--tgb-pad-card);border-radius:var(--tgb-raio-card);box-shadow:var(--tgb-sombra-card);background:var(--tgb-cor-fundo);color:inherit}',
  '.tg-busca-card-midia{position:relative;display:block}',
  '.tg-busca-card-midia .tg-busca-selo{position:absolute;left:var(--tgb-selo-espaco);bottom:var(--tgb-selo-espaco);max-width:calc(100% - 8px);overflow:hidden;text-overflow:ellipsis;pointer-events:none}',
  '.tg-busca-card-link{display:block;color:inherit;text-decoration:none}',
  '.tg-busca-card-texto{margin-top:10px}',
  '.tg-busca-card-esgotado .tg-busca-thumb{filter:grayscale(1);opacity:.55}',
  '.tg-busca-cores-vazio{visibility:hidden}',
  '.tg-busca-cores{display:flex;align-items:center;flex-wrap:wrap;gap:var(--tgb-bolinha-gap);min-height:var(--tgb-bolinha-tam);margin:10px 0 0}',
  '.tg-busca-bolinha{position:relative;flex:0 0 auto;width:var(--tgb-bolinha-tam);height:var(--tgb-bolinha-tam);margin:0;padding:0;border:1px solid rgba(0,0,0,.2);border-radius:50%;background:#cfcac3;cursor:pointer}',
  '.tg-busca-bolinha::after{content:"";position:absolute;top:-11px;right:-3px;bottom:-11px;left:-3px}',
  '.tg-busca-bolinha[data-cor="outro"]{background:conic-gradient(#d9a7b0,#e9d28a,#9ec8a6,#9cb7e0,#d9a7b0)}',
  '.tg-busca-bolinha-atual{box-shadow:0 0 0 2px var(--tgb-cor-fundo),0 0 0 3px var(--tgb-cor-texto)}',
  '.tg-busca-bolinha-esgotada::before{content:"";position:absolute;top:0;right:0;bottom:0;left:0;border-radius:50%;background:linear-gradient(135deg,transparent 45%,rgba(0,0,0,.6) 46%,rgba(0,0,0,.6) 54%,transparent 55%)}',
  '.tg-busca-bolinha-mais{width:auto;height:auto;border:0;border-radius:0;background:none;color:var(--tgb-cor-texto-suave);font-size:11px}',
  '.tg-busca-bolinha-mais::after{display:none}',
  // tamanhos no padrao da pagina de categoria: abaixo do nome, alinhados a esquerda, quadradinhos de 22px com borda fina, preco depois
  '.tg-busca-tams{display:flex;flex-wrap:wrap;justify-content:flex-start;gap:var(--tgb-tamanho-gap);margin:7px 0 0}',
  '.tg-busca-tam{position:relative;flex:0 0 auto;min-width:var(--tgb-tamanho-btn);height:var(--tgb-tamanho-btn);margin:0;padding:0 3px;display:flex;align-items:center;justify-content:center;border:1px solid #555;border-radius:var(--tgb-tamanho-raio);background:var(--tgb-cor-fundo);color:var(--tgb-cor-texto);font-size:var(--tgb-tamanho-fonte);font-weight:400;text-transform:uppercase;line-height:1;cursor:pointer}',
  '.tg-busca-tam::after{content:"";position:absolute;top:-9px;right:0;bottom:-9px;left:0}',
  '.tg-busca-tam:hover{border-color:var(--tgb-cor-texto)}',
  '.tg-busca-card-preco{display:block;margin-top:8px;color:inherit;text-decoration:none}',
  '.tg-busca-tam[aria-pressed="true"]{border-color:var(--tgb-cor-destaque);background:var(--tgb-cor-destaque);color:var(--tgb-cor-destaque-texto)}',
  '.tg-busca-card-pede .tg-busca-tam{border-color:var(--tgb-cor-erro)}',
  '.tg-busca-card-pede .tg-busca-tams{animation:tg-busca-treme .35s ease-in-out}',
  '.tg-busca-tapete{display:grid;grid-template-columns:minmax(0,1fr);gap:0}',
  '.tg-busca-tapete-secao{min-width:0}',
  '.tg-busca-tapete-grade{grid-template-columns:repeat(2,minmax(0,1fr))}',
  // card padrao do tapete: foto 3/4 (peca unica = 1 foto; conjunto = 2 fotos lado a lado na MESMA altura), cor, nome, preco; tudo abre o quick view
  '.tg-busca-tp-foto{position:relative;display:grid;grid-template-columns:minmax(0,1fr);gap:2px;aspect-ratio:3 / 4;overflow:hidden;border-radius:var(--tgb-raio-card);background:var(--tgb-foto-fundo);color:inherit;text-decoration:none}',
  '.tg-busca-tp-foto-dupla{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}',
  '.tg-busca-tp-foto .tg-busca-thumb{width:100%;height:100%;aspect-ratio:auto;border-radius:0;object-position:50% 18%}',
  '.tg-busca-conj-mais{position:absolute;left:50%;top:42%;transform:translate(-50%,-50%);width:20px;height:20px;border-radius:50%;background:var(--tgb-cor-fundo);color:var(--tgb-cor-texto);font-size:14px;line-height:19px;text-align:center;box-shadow:0 0 0 1px var(--tgb-cor-borda)}',
  '.tg-busca-tp .tg-busca-cores{margin:8px 0 0;min-height:0}',
  '.tg-busca-tp .tg-busca-nome{margin:4px 0 0;-webkit-line-clamp:2;min-height:2.6em}',
  '.tg-busca-tp .tg-busca-card-preco{margin-top:4px}',
  '.tg-busca-tp-foto{padding:0;border:0;cursor:pointer;font:inherit}',
  'button.tg-busca-conj-nome{padding:0;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer}',
  '.tg-busca-conj-nome{color:inherit;text-decoration:none}',
  '.tg-busca-conj-cor{font-size:11px;color:var(--tgb-cor-texto-suave)}',
  '.tg-busca-add{display:block;width:100%;height:var(--tgb-botao-altura);margin:10px 0 0;padding:0 8px;border:1px solid var(--tgb-cor-destaque);border-radius:var(--tgb-botao-raio);background:var(--tgb-cor-destaque);color:var(--tgb-cor-destaque-texto);font-size:var(--tgb-botao-fonte);font-weight:var(--tgb-botao-peso);letter-spacing:var(--tgb-botao-espaco);text-transform:var(--tgb-botao-transformacao);cursor:pointer}',
  '.tg-busca-add[aria-disabled="true"]{border-color:var(--tgb-cor-texto);background:var(--tgb-cor-fundo);color:var(--tgb-cor-texto)}',
  '.tg-busca-add.tg-busca-add-ok{border-color:var(--tgb-cor-sucesso);background:var(--tgb-cor-sucesso);color:#fff}',
  '.tg-busca-msg{margin:6px 0 0;font-size:11.5px;color:var(--tgb-cor-erro)}',
  '.tg-busca-msg:empty{display:none}',
  '.tg-busca-chips{display:flex;flex-wrap:wrap;gap:var(--tgb-chip-gap);margin:0;padding:0;list-style:none}',
  '.tg-busca-chip{display:inline-flex;align-items:center;flex:0 0 auto;min-height:var(--tgb-chip-altura);margin:0;padding:0 16px;border:1px solid var(--tgb-cor-borda);border-radius:var(--tgb-chip-raio);background:var(--tgb-cor-fundo);color:var(--tgb-cor-texto);font-size:var(--tgb-chip-tam);text-decoration:none;white-space:nowrap;cursor:pointer}',
  '.tg-busca-chip:hover{border-color:var(--tgb-cor-texto)}',
  '.tg-busca-chip-ativo{border-color:var(--tgb-cor-destaque);background:var(--tgb-cor-destaque);color:var(--tgb-cor-destaque-texto)}',
  // card horizontal (v12, padrao do modal Influenciadoras): foto a esquerda; nome, preco, cores, tamanhos e "Detalhes da peca" a direita
  '.tg-busca-hc-lista{display:grid;grid-template-columns:minmax(0,1fr);gap:26px}',
  '.tg-busca-hc-par{display:grid;grid-template-columns:minmax(0,1fr);gap:26px}',
  '.tg-busca-hc{display:grid;grid-template-columns:42% minmax(0,1fr);gap:0 14px;align-items:start;min-width:0}',
  '.tg-busca-hc-foto{display:block;width:100%;margin:0;padding:0;border:0;border-radius:0;background:var(--tgb-foto-fundo);aspect-ratio:2 / 3;overflow:hidden;cursor:pointer;font:inherit}',
  '.tg-busca-hc-foto .tg-busca-thumb{width:100%;height:100%;aspect-ratio:auto;object-position:50% 20%}',
  '.tg-busca-hc-inf{display:flex;flex-direction:column;align-items:flex-start;min-width:0;padding-top:2px}',
  '.tg-busca-hc-nome{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:0;padding:0;border:0;background:none;color:inherit;font:inherit;font-size:14px;font-weight:400;line-height:1.35;text-align:left}',
  '.tg-busca-hc .tg-busca-hc-foto{cursor:default}',
  '.tg-busca-hc-preco{margin:6px 0 0;font-size:14px}',
  '.tg-busca-hc-preco strong{font-weight:600}',
  '.tg-busca-hc .tg-busca-hc-cores{margin:12px 0 0;gap:9px;min-height:0}',
  '.tg-busca-hc .tg-busca-bolinha{width:14px;height:14px}',
  '.tg-busca-hc-cor{font-size:12px;color:var(--tgb-cor-texto-suave)}',
  '.tg-busca-hc-tams{display:flex;flex-wrap:wrap;gap:4px;margin:12px 0 0}',
  '.tg-busca-hc-tam{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:22px;padding:0 4px;border:1px solid var(--tgb-cor-borda);font-size:10.5px;line-height:1;color:var(--tgb-cor-texto)}',
  'button.tg-busca-hc-det{display:inline-flex;align-items:center;gap:8px;min-height:40px;margin:14px 0 0;padding:0 14px;border:1px solid var(--tgb-cor-texto);border-radius:0;background:var(--tgb-cor-fundo);color:var(--tgb-cor-texto);font:inherit;font-size:12.5px;line-height:1.2;cursor:pointer}',
  'button.tg-busca-hc-det::after{content:"";width:6px;height:6px;border-top:1.5px solid currentColor;border-right:1.5px solid currentColor;transform:rotate(45deg)}',
  // vitrine inicial: respiro de ~12% da tela entre uma secao e a proxima (a atencao so passa para o proximo bloco ao rolar)
  '.tg-busca-tapete{margin-top:6px}',
  '.tg-busca-tapete-secao>.tg-busca-secao-titulo{margin:22px 0 14px}',
  '.tg-busca-tapete-secao+.tg-busca-tapete-secao{margin-top:clamp(56px,12vh,104px)}',
  '.tg-busca-tapete-todos{display:inline-block;margin:18px 0 0;font-size:12.5px;color:inherit;text-decoration:underline;text-underline-offset:3px}',
  // esqueleto da vitrine (mesma altura dos cards: a tela nao pula quando as pecas chegam)
  '.tg-busca-hc-esq .tg-busca-hc-foto{animation:tg-busca-pulsa 1.2s ease-in-out infinite}',
  '.tg-busca-hc-esq .tg-busca-hc-inf i{display:block;width:85%;height:12px;margin:4px 0 12px;background:var(--tgb-cor-fundo-suave);animation:tg-busca-pulsa 1.2s ease-in-out infinite}',
  '.tg-busca-hc-esq .tg-busca-hc-inf i:nth-child(2){width:40%}',
  '.tg-busca-hc-esq .tg-busca-hc-inf i:nth-child(3){width:62%}',
  '.tg-busca-esq-titulo{width:90px;height:12px;margin:22px 0 14px;background:var(--tgb-cor-fundo-suave)}',
  '.tg-busca-carregando{text-align:center}',
  // pagina de Conjuntos: um par por bloco, com linha fina entre os pares
  '.tg-busca-pagina-conj .tg-busca-hc-lista{gap:0}',
  '.tg-busca-pagina-conj .tg-busca-hc-par{padding:24px 0;border-bottom:1px solid var(--tgb-cor-borda)}',
  '.tg-busca-pagina-conj .tg-busca-hc-par:first-child{padding-top:4px}',
  '.tg-busca-cj-sub{margin:0 0 14px;text-align:center;font-size:12.5px;color:var(--tgb-cor-texto-suave)}',
  // barra grudada: os pais da pagina que cortavam (overflow) deixam o sticky funcionar (corte so na horizontal, sem criar rolagem)
  '.tg-busca-pai-solto{overflow:visible!important;overflow-x:clip!important}',
  'a.tg-busca-ver-nov{display:flex;align-items:center;justify-content:center;text-decoration:none}',
  '@keyframes tg-busca-pulsa{50%{opacity:.5}}',
  // card da busca (v12, Danilo 24/11): tamanhos e bolinhas so informam; VER PECA (contorno) abre o modal e fica no pe do card, alinhado na linha
  'span.tg-busca-tam,span.tg-busca-bolinha{cursor:default}',
  'span.tg-busca-tam::after,span.tg-busca-bolinha::after{display:none}',
  'span.tg-busca-tam:hover{border-color:#555}',
  '.tg-busca-tam-pedido{border-color:var(--tgb-cor-destaque);background:var(--tgb-cor-destaque);color:var(--tgb-cor-destaque-texto)}',
  '.tg-busca-card .tg-busca-tams{flex-wrap:nowrap;overflow:hidden;min-height:var(--tgb-tamanho-btn)}',
  // v14 (Danilo, 24/11): moldura sutil nos cards da grade (antes so o espaco separava um card do outro); a foto vai de borda a borda e o texto ganha respiro
  '.tg-busca-grade .tg-busca-card{border:1px solid #e6e1da;padding-bottom:10px}',
  '.tg-busca-grade .tg-busca-card>:not(.tg-busca-card-midia){margin-left:8px;margin-right:8px}',
  '.tg-busca-grade .tg-busca-card .tg-busca-add.tg-busca-ver{width:auto}',
  '.tg-busca-tams-vazio{visibility:hidden}',
  '.tg-busca-card .tg-busca-card-preco{margin-bottom:12px}',
  '.tg-busca-card .tg-busca-add.tg-busca-ver{margin-top:auto;border-color:var(--tgb-cor-texto);background:var(--tgb-cor-fundo);color:var(--tgb-cor-texto)}',
  // filtros aplicados: microchips discretos dentro da barra grudada + "Limpar busca"
  '.tg-busca-ativos{display:flex;align-items:center;gap:12px;padding:7px 0 8px;border-top:1px solid var(--tgb-cor-borda)}',
  '.tg-busca-ativos-lista{display:flex;flex:1 1 auto;min-width:0;gap:6px;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch}',
  '.tg-busca-ativos-lista::-webkit-scrollbar{display:none}',
  '.tg-busca-micro{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;height:26px;margin:0;padding:0 8px 0 10px;border:1px solid var(--tgb-cor-texto);border-radius:var(--tgb-chip-raio);background:var(--tgb-cor-fundo);color:var(--tgb-cor-texto);font:inherit;font-size:11px;line-height:1;white-space:nowrap;cursor:pointer}',
  '.tg-busca-micro-x{font-size:14px;line-height:1;color:var(--tgb-cor-texto-suave)}',
  '.tg-busca-limpar-busca{flex:0 0 auto;margin:0;padding:6px 0;border:0;background:none;color:var(--tgb-cor-texto);font:inherit;font-size:11.5px;white-space:nowrap;text-decoration:underline;text-underline-offset:3px;cursor:pointer}'
];

var TG_CSS_PAGINA = [
  '#tg-busca-resultados{max-width:1400px;margin:0 auto;padding:0 var(--tgb-pad-pagina) 36px}',
  '.tg-busca-pg-titulo{margin:18px 0 4px;font-family:var(--tgb-fonte-titulo);font-size:20px;font-weight:600;line-height:1.25}',
  '.tg-busca-voce{margin:16px 0 4px;padding:0 12px;text-align:center;font-family:var(--tgb-fonte-titulo);font-size:11.5px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:var(--tgb-cor-texto-suave);line-height:1.5}',
  '.tg-busca-voce strong{font-weight:700;color:var(--tgb-cor-texto)}',
  '.tg-busca-aviso-nome{margin:12px 0 0;padding:10px 12px;background:var(--tgb-cor-fundo-suave);font-size:13px;line-height:1.45;color:var(--tgb-cor-texto)}',
  '.tg-busca-voce::after{content:"";display:block;width:28px;height:1px;margin:10px auto 0;background:var(--tgb-cor-texto)}',
  '.tg-busca-grade-titulo{grid-column:1 / -1;margin:14px 0 0;padding:0 0 8px;border-bottom:1px solid var(--tgb-cor-borda);font-family:var(--tgb-fonte-titulo);font-size:12px;font-weight:600;letter-spacing:.12em;text-transform:uppercase}',
  '.tg-busca-grade-titulo:first-child{margin-top:0}',
  '.tg-busca-pg-sub{margin:0 0 4px;font-size:13px;color:var(--tgb-cor-texto-suave)}',
  '.tg-busca-barra{position:var(--tgb-barra-posicao);top:var(--tgb-barra-topo);z-index:5;margin:12px 0 14px;border-top:1px solid var(--tgb-cor-borda);border-bottom:1px solid var(--tgb-cor-borda);background:var(--tgb-barra-fundo)}',
  '.tg-busca-barra-linha{display:flex;align-items:center;gap:6px;min-height:var(--tgb-barra-altura);font-size:var(--tgb-barra-fonte)}',
  '.tg-busca-barra-btn{display:inline-flex;align-items:center;gap:7px;height:40px;margin:0;padding:0 4px;border:0;background:none;color:inherit;font-size:var(--tgb-barra-fonte);font-weight:600;cursor:pointer}',
  '.tg-busca-barra-btn::after{content:"";width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg) translateY(-2px)}',
  '.tg-busca-barra-espaco{flex:1}',
  '.tg-busca-menu-wrap{position:relative}',
  '.tg-busca-menu{position:absolute;top:100%;left:0;z-index:6;min-width:210px;max-height:60vh;overflow-y:auto;margin:2px 0 0;padding:6px 0;list-style:none;border:1px solid var(--tgb-cor-borda);border-radius:6px;background:var(--tgb-cor-fundo);box-shadow:0 12px 32px rgba(0,0,0,.16)}',
  '.tg-busca-menu-dir .tg-busca-menu{left:auto;right:0}',
  '.tg-busca-menu button{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;margin:0;padding:11px 16px;border:0;background:none;color:inherit;font-size:14px;text-align:left;cursor:pointer}',
  '.tg-busca-menu button:hover{background:var(--tgb-cor-fundo-suave)}',
  '.tg-busca-menu button[aria-checked="true"]{font-weight:700}',
  '.tg-busca-menu button[aria-checked="true"]::after{content:"\\2713";font-size:13px}',
  '.tg-busca-vazio{margin:30px 0;text-align:center;color:var(--tgb-cor-texto-suave);font-size:14px}',
  '.tg-busca-vazio .tg-busca-chip{margin-top:8px}',
  '.tg-busca-togg{display:inline-flex;gap:2px;margin-left:2px}',
  '.tg-busca-togg button{display:flex;align-items:center;justify-content:center;gap:2px;width:40px;height:44px;margin:0;padding:0;border:0;border-radius:4px;background:none;color:var(--tgb-cor-texto);opacity:.55;cursor:pointer}',
  '.tg-busca-togg button[aria-pressed="true"]{opacity:1;background:var(--tgb-cor-fundo-suave)}',
  '.tg-busca-togg-q{display:block;width:6px;height:14px;border-radius:1px;background:currentColor}',
  '.tg-busca-togg-1 .tg-busca-togg-q{width:12px;background:none;border:1.5px solid currentColor;box-sizing:border-box}',
  '.tg-busca-chips-linha{flex-wrap:nowrap;overflow-x:auto;margin:0 0 18px;padding:2px 0 4px;-webkit-overflow-scrolling:touch;scrollbar-width:none}',
  '.tg-busca-chips-linha::-webkit-scrollbar{display:none}',
  // v14 (Danilo, 24/11): "VER MAIS" preto com letra branca, do tamanho do texto
  '.tg-busca-mais{display:flex;align-items:center;justify-content:center;width:-webkit-fit-content;width:fit-content;min-width:0;height:var(--tgb-botao-altura);margin:30px auto 0;padding:0 28px;border:1px solid #000;border-radius:var(--tgb-botao-raio);background:#000;color:#fff;font-size:var(--tgb-botao-fonte);font-weight:var(--tgb-botao-peso);letter-spacing:var(--tgb-botao-espaco);text-transform:var(--tgb-botao-transformacao);text-decoration:none;cursor:pointer}',
  '.tg-busca-mais.tg-busca-oculto{display:none}',
  'a.tg-busca-mais:hover,a.tg-busca-mais:focus{color:#fff;text-decoration:none}',
  // v14: peca esgotada vira so a frase; as parecidas vem logo abaixo
  '.tg-busca-esg-frase{margin:18px auto 22px;max-width:560px;padding:0 8px;text-align:center;font-size:14px;line-height:1.5;color:var(--tgb-cor-texto)}',
  '.tg-busca-esg-frase strong{font-weight:600}',
  '.tg-busca-ov-corpo .tg-busca-esg-frase{margin:14px 0 16px;text-align:left;padding:0}',
  '.tg-busca-esg .tg-busca-grade{margin-top:4px}',
  // pagina de busca curada (blocos) e estado sem resultado
  '.tg-busca-curada{max-width:1400px;margin:20px auto;padding:0 var(--tgb-pad-pagina)}',
  '.tg-busca-curada .tg-busca-bloco-titulo{margin:0 0 14px;padding:0 0 10px;border-bottom:2px solid var(--tgb-cor-texto);font-size:16px;letter-spacing:.06em;color:var(--tgb-cor-texto)}',
  '.tg-busca-curada .tg-busca-bloco{margin-bottom:30px}',
  '.tg-busca-zero{max-width:1100px;margin:28px auto;padding:0 var(--tgb-pad-pagina);text-align:center}',
  '.tg-busca-zero-titulo{margin:16px 0 4px}',  // v14: o titulo da busca sem resultado segue o titulo da pagina de resultados (tg-busca-voce)
  '.tg-busca-zero-desc{margin:22px 0 18px;font-size:14px;color:var(--tgb-cor-texto-suave)}',
  '.tg-busca-zero-desc a{color:var(--tgb-cor-texto);font-weight:700;text-decoration:underline}',
  '.tg-busca-zero-form{display:flex;gap:8px;max-width:520px;margin:0 auto 22px}',
  '.tg-busca-zero-campo{flex:1;min-width:0;height:46px;margin:0;padding:0 14px;border:1px solid var(--tgb-cor-borda);border-radius:var(--tgb-botao-raio);background:var(--tgb-cor-fundo);color:inherit;font-family:inherit;font-size:16px;-webkit-appearance:none;appearance:none}',
  '.tg-busca-zero-ok{height:46px;margin:0;padding:0 22px;border:1px solid var(--tgb-cor-destaque);border-radius:var(--tgb-botao-raio);background:var(--tgb-cor-destaque);color:var(--tgb-cor-destaque-texto);font-size:var(--tgb-botao-fonte);font-weight:var(--tgb-botao-peso);letter-spacing:var(--tgb-botao-espaco);text-transform:var(--tgb-botao-transformacao);cursor:pointer}',
  '.tg-busca-zero .tg-busca-chips{justify-content:center}',
  '.tg-busca-zero .tg-busca-secao-titulo{margin:26px 0 10px}',
  '.tg-busca-zero .tg-busca-bloco-titulo{justify-content:center;margin:26px 0 12px}',
  '@keyframes tg-busca-entra{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
  '@keyframes tg-busca-treme{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}',
  '@media (prefers-reduced-motion:reduce){#tg-busca-overlay.tg-busca-aberto,.tg-busca-card-pede .tg-busca-tams,.tg-busca-hc-esq .tg-busca-hc-foto,.tg-busca-hc-esq .tg-busca-hc-inf i{animation:none}}',
  // celular (95% do publico): campo com 16px (o iPhone nao da zoom), toque sem atraso, area segura, sem rolagem lateral
  '@media (max-width:1023px){' +
    '.tg-busca-ov-campo{font-size:16px}' +
    '#tg-busca-overlay a,#tg-busca-overlay button,#tg-busca-resultados a,#tg-busca-resultados button{touch-action:manipulation;-webkit-tap-highlight-color:transparent}' +
    '.tg-busca-ov-form{padding-top:env(safe-area-inset-top,0px);height:calc(var(--tgb-ov-campo-altura) + env(safe-area-inset-top,0px))}' +
    '.tg-busca-ov-corpo{overflow-x:hidden;padding:0 12px calc(28px + env(safe-area-inset-bottom,0px))}' +
    '.tg-busca-secao-titulo{margin:18px 0 8px}' +
    '.tg-busca-chip{min-height:36px;padding:0 14px;font-size:12px}' +
    '.tg-busca-chips{gap:6px}' +
    '.tg-busca-chips-linha{gap:8px;margin:16px 0 16px;padding:2px 0 6px}' +
    '.tg-busca-barra{margin:0 0 20px}' +
    '.tg-busca-termo{min-height:44px}' +
    '.tg-busca-todos{height:44px}' +
    '.tg-busca-barra-btn{height:44px;padding:0 6px;font-size:12px}' +
    '.tg-busca-mais{height:40px}' +
    '.tg-busca-tp .tg-busca-nome{font-size:12.5px}' +
  '}',
  '@media (min-width:1024px){' +
    '#tg-busca-overlay{background:var(--tgb-ov-fundo-escuro);align-items:center}' +
    '.tg-busca-ov-painel{width:min(var(--tgb-ov-max-largura),100%);height:auto;max-height:90vh;border-radius:var(--tgb-ov-raio)}' +
    '.tg-busca-ov-corpo{padding:0 28px 32px}' +
    '.tg-busca-lista{grid-template-columns:repeat(var(--tgb-ov-colunas-desktop),minmax(0,1fr))}' +
    '.tg-busca-grade{grid-template-columns:repeat(var(--tgb-colunas-desktop),minmax(0,1fr))}' +
    '.tg-busca-grade.tg-busca-grade-um{grid-template-columns:repeat(var(--tgb-colunas-desktop),minmax(0,1fr))}' +
    '.tg-busca-tapete{grid-template-columns:repeat(3,minmax(0,1fr));column-gap:28px}' +
    '.tg-busca-tp-foto{aspect-ratio:3 / 4}' +
    '.tg-busca-togg{display:none}' +
    '.tg-busca-chips-linha{flex-wrap:wrap;overflow:visible}' +
    '.tg-busca-todos{width:auto;min-width:300px;margin-left:auto;margin-right:auto}' +
  '}',
  // ---- v15 (Danilo, 25/11): polimento da busca inicial
  // chips Em alta numa linha so (Vestidos, Blusas, Calcas, Conjuntos, Novidades); em tela estreita a linha rola para o lado, nunca quebra
  '#tg-busca-overlay .tg-busca-chips-emalta{flex-wrap:nowrap;gap:6px;overflow-x:auto;margin:0 -12px;padding:0 12px 2px;scrollbar-width:none}',
  '#tg-busca-overlay .tg-busca-chips-emalta::-webkit-scrollbar{display:none}',
  '#tg-busca-overlay .tg-busca-chips-emalta li{flex:1 0 auto}',
  '#tg-busca-overlay .tg-busca-chips-emalta .tg-busca-chip{width:100%;justify-content:center;min-height:34px;padding:0 7px;font-size:11.5px}',
  // carrossel por grupo: colunas de 2 cards; a proxima coluna aparece na borda; no fim o cartao Ver todos
  '.tg-busca-carrossel{display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;overscroll-behavior-x:contain;margin:0 -12px;padding:0 12px 6px;scroll-padding-left:12px;scrollbar-width:none;-webkit-overflow-scrolling:touch}',
  '.tg-busca-carrossel::-webkit-scrollbar{display:none}',
  '.tg-busca-car-col{display:grid;grid-template-columns:minmax(0,1fr);align-content:start;gap:10px;flex:0 0 90%;min-width:0;scroll-snap-align:start}',
  '.tg-busca-car-col>.tg-busca-hc-par{gap:10px}',
  '.tg-busca-car-col-todos{flex-basis:auto;align-content:center;padding:0 8px 0 4px}',
  '.tg-busca-car-todos{display:flex;align-items:center;gap:10px;padding:8px 0;border:0;color:inherit;font-size:13px;line-height:1.3;white-space:nowrap;text-decoration:none}',
  '.tg-busca-car-seta{position:relative;width:38px;height:38px;border:1px solid currentColor;border-radius:50%}',
  '.tg-busca-car-seta::after{content:"";position:absolute;top:50%;left:50%;width:8px;height:8px;margin:-4px 0 0 -6px;border-top:1.5px solid currentColor;border-right:1.5px solid currentColor;transform:rotate(45deg)}',
  // card da vitrine: moldura sutil e foto 20% menor; as informacoes ficam como na versao anterior (a esquerda, a partir do topo) - Danilo 25/11
  '.tg-busca-tapete .tg-busca-hc{grid-template-columns:40% minmax(0,1fr);gap:0 11px;padding:10px;border:1px solid #e6e1da;background:var(--tgb-cor-fundo)}',
  // nome numa linha so (Danilo, 25/11: nome longo em 2 linhas desalinhava os cards); o que nao couber termina em reticencias
  '.tg-busca-tapete .tg-busca-hc-nome{display:block;overflow:hidden;font-size:12px;letter-spacing:-.01em;white-space:nowrap;text-overflow:ellipsis;max-width:100%}',
  '.tg-busca-tapete .tg-busca-hc-inf{align-items:flex-start;text-align:left}',
  '.tg-busca-tapete .tg-busca-hc .tg-busca-hc-cores{margin-top:10px}',
  '.tg-busca-tapete .tg-busca-hc-tams{margin-top:10px}',
  '.tg-busca-tapete button.tg-busca-hc-det{min-height:36px;margin-top:12px;padding:0 10px;font-size:12px;white-space:nowrap;gap:6px}',
  '.tg-busca-hc-toca,.tg-busca-hc.tg-busca-hc-toca .tg-busca-hc-foto{cursor:pointer}',
  // respiro entre os grupos 20% menor (era clamp(56px,12vh,104px))
  '.tg-busca-tapete-secao+.tg-busca-tapete-secao{margin-top:clamp(34px,7.2vh,62px)}',
  '.tg-busca-tapete-car>.tg-busca-tapete-todos{margin-top:12px}',
  // "Buscando resultados": aparece no toque de um chip ou de Ver todos, enquanto a proxima pagina carrega
  '.tg-busca-buscando{position:fixed;top:0;right:0;bottom:0;left:0;z-index:20;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:rgba(255,255,255,.94);color:var(--tgb-cor-texto);font-size:13px;letter-spacing:.08em;animation:tg-busca-surge .2s ease-out}',
  '.tg-busca-buscando-anel{width:30px;height:30px;border:2px solid var(--tgb-cor-borda);border-top-color:var(--tgb-cor-texto);border-radius:50%;animation:tg-busca-gira .8s linear infinite}',
  '@keyframes tg-busca-gira{to{transform:rotate(360deg)}}',
  '@keyframes tg-busca-surge{from{opacity:0}to{opacity:1}}',
  // ---- QA (Danilo, 25/11)
  // 3.4: linha do Pix abaixo do preco, discreta (cabe na grade de 2 em 360 px)
  '.tg-busca-pix{display:block;flex-basis:100%;margin-top:1px;font-size:11px;font-weight:400;line-height:1.3;color:var(--tgb-cor-texto-suave);white-space:nowrap}',
  '.tg-busca-pix-v{font-weight:600;color:var(--tgb-cor-texto)}',
  // 5.1: quantas pecas a busca (com os filtros) encontrou, abaixo do titulo do topo
  '.tg-busca-contador{margin:-2px 0 14px;text-align:center;font-size:12px;color:var(--tgb-cor-texto-suave)}',
  '.tg-busca-contador:empty{display:none}',
  // 5.3: tamanho sem peca na combinacao atual fica apagado no menu
  '.tg-busca-menu button.tg-busca-menu-sem{color:var(--tgb-cor-texto-suave);opacity:.45;text-decoration:line-through;cursor:default}',
  // 4.1: celular de 360 px na grade de 2: bolinhas + o +N numa linha so, e os 6 tamanhos (XPP a GG) sem corte na borda
  '@media (max-width:374px){body .tg-busca-grade:not(.tg-busca-grade-um) .tg-busca-card .tg-busca-cores{flex-wrap:nowrap;gap:5px}body .tg-busca-grade:not(.tg-busca-grade-um) .tg-busca-card .tg-busca-bolinha{width:16px;height:16px}body .tg-busca-grade:not(.tg-busca-grade-um) .tg-busca-card .tg-busca-bolinha-mais{width:auto;height:auto;font-size:10.5px}body .tg-busca-grade:not(.tg-busca-grade-um) .tg-busca-card .tg-busca-tams{gap:2px}body .tg-busca-grade:not(.tg-busca-grade-um) .tg-busca-card .tg-busca-tam{min-width:17px;height:19px;padding:0 1px;font-size:9px}body .tg-busca-grade:not(.tg-busca-grade-um) .tg-busca-card>:not(.tg-busca-card-midia){margin-left:6px;margin-right:6px}}',
  // 1.4 e 4.2: os conjuntos (digitando conjunto) e as Novidades da semana (sem resultado) usam o carrossel da busca inicial
  '.tg-busca-conj-digitado{margin:6px 0 22px}',
  '.tg-busca-zero-nov{margin-top:22px}',
  // ---- v15: pagina de resultados
  // R2: tamanhos 15% menores na grade de 2 (com XPP ate GG o ultimo encostava na moldura)
  '.tg-busca-grade:not(.tg-busca-grade-um) .tg-busca-card .tg-busca-tams{gap:3px}',
  '.tg-busca-grade:not(.tg-busca-grade-um) .tg-busca-card .tg-busca-tam{min-width:20.5px;height:20.5px;padding:0 2px;font-size:9.8px}',
  '.tg-busca-grade:not(.tg-busca-grade-um) .tg-busca-card .tg-busca-tams{min-height:20.5px}',
  // R3 (Danilo, 25/11): grade de 1 coluna igual a anterior; so o VER PECA fica centralizado no card
  '.tg-busca-grade.tg-busca-grade-um .tg-busca-card .tg-busca-add.tg-busca-ver{margin-left:auto;margin-right:auto}',
  // R4: titulo da ordenacao junto dos cards + a grade entra de novo ao ordenar
  '.tg-busca-ord-cab{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 6px;margin:0 0 12px;font-size:12.5px;letter-spacing:.02em;color:var(--tgb-cor-texto-suave);animation:tg-busca-surge .3s ease-out}',
  '.tg-busca-ord-cab strong{font-weight:600;color:var(--tgb-cor-texto)}',
  '.tg-busca-grade-nova{animation:tg-busca-renova .38s ease-out}',
  '@keyframes tg-busca-renova{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}',
  // R5: filtro de Cor em 3 colunas (5 por coluna), bolinha da cor ao lado do nome; os menus usam a largura da barra
  '.tg-busca-barra-linha{position:relative}',
  '.tg-busca-barra .tg-busca-menu-wrap{position:static}',
  '.tg-busca-barra .tg-busca-menu-dir .tg-busca-menu{right:0}',
  '.tg-busca-menu.tg-busca-menu-cores{left:0;right:0;min-width:0;max-height:none;padding:8px 6px;column-count:3;column-gap:4px}',
  '.tg-busca-menu.tg-busca-menu-cores button{justify-content:flex-start;gap:8px;padding:10px 6px;font-size:13px;break-inside:avoid}',
  '.tg-busca-menu.tg-busca-menu-cores button>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.tg-busca-menu.tg-busca-menu-cores button[aria-checked="true"]::after{margin-left:auto}',
  '.tg-busca-menu-bolinha{width:16px;height:16px;cursor:inherit}',
  '.tg-busca-menu-bolinha::after{display:none}',
  // R6: gaveta ao abrir e ao fechar; a seta do botao gira
  '.tg-busca-menu{transform-origin:top center;animation:tg-busca-gaveta .24s cubic-bezier(.2,.7,.3,1)}',
  '.tg-busca-menu.tg-busca-menu-fechando{animation:tg-busca-gaveta-fecha .17s ease-in forwards;pointer-events:none}',
  '@keyframes tg-busca-gaveta{from{opacity:0;transform:translateY(-6px);clip-path:inset(0 0 100% 0)}to{opacity:1;transform:none;clip-path:inset(0 0 0 0)}}',
  '@keyframes tg-busca-gaveta-fecha{from{opacity:1;clip-path:inset(0 0 0 0)}to{opacity:0;transform:translateY(-6px);clip-path:inset(0 0 100% 0)}}',
  '.tg-busca-barra-btn::after{transition:transform .2s ease}',
  '.tg-busca-barra-btn[aria-expanded="true"]::after{transform:rotate(225deg) translateY(-2px)}',
  '@media (prefers-reduced-motion:reduce){.tg-busca-buscando,.tg-busca-buscando-anel,.tg-busca-menu,.tg-busca-menu.tg-busca-menu-fechando,.tg-busca-grade-nova,.tg-busca-ord-cab{animation:none}.tg-busca-carrossel{scroll-behavior:auto}.tg-busca-barra-btn::after{transition:none}}'
];

// Regras de cor das bolinhas, geradas da tabela TG_COR_TONS.
function tgCssCores() {
  var out = [], i, j, nomes;
  for (i = 0; i < TG_COR_TONS.length; i++) {
    nomes = TG_COR_TONS[i][0];
    for (j = 0; j < nomes.length; j++) { out.push('.tg-busca-bolinha[data-cor="' + nomes[j] + '"]{background:' + TG_COR_TONS[i][1] + '}'); }
  }
  return out;
}

function tgCssVars() {
  var out = ':root{', i;
  for (i = 0; i < TG_TOKENS.length; i++) { out += TG_TOKENS[i][0] + ':' + TG_TOKENS[i][1] + ';'; }
  return out + '}';
}

var TG_CSS = [tgCssVars()].concat(TG_CSS_BASE, TG_CSS_OVERLAY, TG_CSS_CARD, tgCssCores(), TG_CSS_PAGINA).join('\n');

function injetarEstilos() {
  if (document.getElementById('tg-busca-estilos')) { return; }
  var st = el('style', { id: 'tg-busca-estilos' }, [TG_CSS]);
  document.head.appendChild(st);
}


/* tgb:bancada:inicio (gerado por tools/bancada/aplicar-parametros.cjs; nao edite a mao, rode a bancada de novo) */
if (typeof TG_CSS === 'string') {
  TG_CSS += '\n' + [
    ':root{--tgb-qv-chip-tam:42px;--tgb-qv-foto-larg:180px;--tgb-qv-largura-desk:680px;--tgb-qv-pad:16px;--tgb-qv-preco-tam:16px;--tgb-qv-raio:14px;--tgb-qv-raio-desk:13px;--tgb-qv-scrim:rgba(0,0,0,.4);--tgb-qv-tamanho-btn:38px}'
  ].join('\n');
}
/* tgb:bancada:fim */

/* ---- src/injetor/quickview.js ---- */
/*
 * Quick view (pacote Q do redesign). Bottom sheet no celular, modal centralizado no desktop, aberto a partir do card da busca.
 * Design e comportamento portados da pagina Influenciadoras (influencer-piece-detail / influencer-story-sheet / store-cart),
 * reescritos em JS simples (ES5, sem TypeScript). Na Talgui cada cor e um produto proprio: o quick view mostra UMA cor
 * (um produto) e troca de produto quando a cliente escolhe outra cor dos irmaos.
 *
 * Dados: a pagina do produto (mesma origem, so GET) traz data-variants (id, option0 = cor, option1 = tamanho, available, preco)
 * e a galeria. Tudo que vem dela passa por validacao (id so numerico, foto so do prefixo da loja, texto limitado) e
 * so chega ao DOM por textContent / setAttribute (helpers de seguro.js). Qualquer falha cai para o link da pagina do produto.
 *
 * Expoe (funcoes globais da IIFE): tgQuickViewAbrir, tgQuickViewPrefetch, tgVariantesDoProduto, tgAdicionarSacola.
 * Estilos: injetados uma vez, todos sob .tg-busca-qv- e variaveis --tgb-* (padroes definidos aqui com var(--tgb-x, padrao)).
 * Os marcadores node:inicio / node:fim delimitam a exportacao para o Node; o build remove esse bloco.
 * v15 (Danilo, 25/11): rodape escondido ate a rolagem passar do preco, Voltar entre cores, gavetas animadas, entrada/saida animadas, troca de cor
 * como pagina virando (com volta ao topo), foto ampliada (classe tg-busca-qv-lupa) e confirmacao da sacola dentro do modal.
 */
var TG_QV_Z = 2147483500;
var TG_QV_TIMEOUT_MS = 6000;
var TG_QV_MAX_HTML = 8 * 1024 * 1024;
var TG_QV_MAX_FOTOS = 10;
var TG_QV_MAX_TEXTO = 24;
var TG_QV_MAX_CACHE = 80;
var tgQvCache = {};        // handle -> Promise (resultado de tgVariantesDoProduto)
var tgQvProdutoDaVariante = {}; // id da variante (texto numerico) -> id do produto
var tgQvAtivo = null;      // quick view aberto (so um por vez)
var TG_QV_TOKENS = {};     // nome da variavel -> padrao (a bancada le esta lista)

// ---------------------------------------------------------------- validacao e leitura da pagina
function tgQvIdOk(v) {
  if (typeof v === 'number') { return isFinite(v) && v > 0 && Math.floor(v) === v && v < 1e15 ? String(v) : null; }
  if (typeof v === 'string' && /^[0-9]{1,15}$/.test(v) && v.replace(/^0+/, '') !== '') { return v.replace(/^0+/, ''); }
  return null;
}

function tgQvQtdOk(v) {
  var n = typeof v === 'number' ? v : parseInt(v, 10);
  return isFinite(n) && n >= 1 && n <= 10 && Math.floor(n) === n ? n : null;
}

// Texto curto vindo da pagina (cor, tamanho): sem controle, sem espacos nas pontas, ate 24 caracteres. Vazio vira null.
function tgQvTexto(v) {
  var t;
  if (typeof v !== 'string') { return null; }
  t = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').replace(/^ | $/g, '');
  return t && t.length <= TG_QV_MAX_TEXTO ? t : null;
}

function tgQvDecode(s) {
  return s.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function tgQvNumPositivo(v) { return typeof v === 'number' && isFinite(v) && v > 0 ? v : null; }

// Foto aceita: so o prefixo fixo das imagens da loja e nome de arquivo simples. Aceita o formato "//acdn..." da pagina.
function tgQvFotoOk(u) {
  if (typeof u !== 'string') { return null; }
  if (u.indexOf('//') === 0) { u = 'https:' + u; }
  return u.indexOf(TG_IMG) === 0 && /^[\w.-]{1,300}$/.test(u.slice(TG_IMG.length)) ? u : null;
}

// A pagina lista as variantes na ordem do cadastro (P, M, G, PP, GG...). Aqui a ordem natural: XPP, PP, P, M, G, GG, XG...; numeros crescentes; o resto no fim.
var TG_QV_ORDEM = { XXS: 0, XPP: 0, XS: 0, PP: 1, P: 2, S: 2, M: 3, G: 4, L: 4, GG: 5, XL: 5, XG: 6, XGG: 7, XXG: 7, EG: 6, EGG: 7, U: 8, UN: 8, UNICO: 8, 'ÚNICO': 8 };
function tgQvOrdenarTamanhos(lista) {
  var chaves = lista.map(function (t, i) {
    var r = String(t.rotulo).toUpperCase(), k;
    if (/^[0-9]{1,3}$/.test(r)) { k = 100 + parseInt(r, 10); } else if (Object.prototype.hasOwnProperty.call(TG_QV_ORDEM, r)) { k = TG_QV_ORDEM[r]; } else { k = 1000 + i; }
    return { t: t, k: k, i: i };
  });
  chaves.sort(function (a, b) { return a.k - b.k || a.i - b.i; });
  return chaves.map(function (c) { return c.t; });
}

// Le o HTML da pagina do produto. item.id (id do produto no catalogo) escolhe o data-variants certo: a pagina traz outros
// (produtos relacionados). Devolve { ok:true, ... } ou { ok:false, motivo }.
function tgQvParse(html, item) {
  var re = /data-variants="([^"]*)"/g, m, lista, escolhida = null, vs = [], i, v, id, opt0, opt1, rotulo, cor = null, usaOpt0 = false;
  var sem1 = true, precoV = null, de = null, fotos = [], vistos = {}, tamanhos = [], porRotulo = {}, rg, u, produtoId = null, sz = null, k;
  if (typeof html !== 'string' || html.length > TG_QV_MAX_HTML) { return { ok: false, motivo: 'html' }; }
  while ((m = re.exec(html)) !== null) {
    try { lista = JSON.parse(tgQvDecode(m[1])); } catch (e) { continue; }
    if (!Array.isArray(lista) || !lista.length || !lista[0] || typeof lista[0] !== 'object') { continue; }
    if (item && typeof item.id === 'number') {
      if (lista[0].product_id === item.id) { escolhida = lista; break; }
    } else { escolhida = lista; break; }
  }
  if (!escolhida) { return { ok: false, motivo: 'sem-variantes' }; }
  for (i = 0; i < escolhida.length; i++) {
    v = escolhida[i];
    if (!v || typeof v !== 'object') { continue; }
    id = tgQvIdOk(v.id);
    if (!id) { continue; }
    vs.push({ id: id, o0: tgQvTexto(v.option0), o1: tgQvTexto(v.option1), ok: v.available === true, p: tgQvNumPositivo(v.price_number), c: tgQvNumPositivo(v.compare_at_price_number), parc: tgQvParcelas(v.installments_data), pix: tgQvPix(v) });
    if (vs[vs.length - 1].o1) { sem1 = false; }
    if (produtoId === null && tgQvIdOk(v.product_id)) { produtoId = tgQvIdOk(v.product_id); }
  }
  if (!vs.length || !produtoId) { return { ok: false, motivo: 'sem-variantes' }; }
  // Produto sem a segunda opcao: a unica opcao e o tamanho, se os valores batem com os tamanhos do catalogo.
  if (sem1 && item && Array.isArray(item.sz) && item.sz.length) {
    sz = {};
    for (k = 0; k < item.sz.length; k++) { if (typeof item.sz[k] === 'string') { sz[item.sz[k].toUpperCase()] = true; } }
    usaOpt0 = true;
    for (i = 0; i < vs.length; i++) { if (!vs[i].o0 || !sz[vs[i].o0.toUpperCase()]) { usaOpt0 = false; break; } }
  }
  for (i = 0; i < vs.length; i++) {
    v = vs[i];
    rotulo = usaOpt0 ? v.o0 : v.o1;
    if (!usaOpt0 && !cor && v.o0) { cor = v.o0; }
    if (!rotulo) { continue; }
    if (Object.prototype.hasOwnProperty.call(porRotulo, rotulo)) {
      // mesmo tamanho repetido: vale o que esta disponivel
      if (v.ok && !tamanhos[porRotulo[rotulo]].disponivel) { tamanhos[porRotulo[rotulo]].variantId = v.id; tamanhos[porRotulo[rotulo]].disponivel = true; }
      continue;
    }
    porRotulo[rotulo] = tamanhos.length;
    tamanhos.push({ rotulo: rotulo, variantId: v.id, disponivel: v.ok });
    tgQvProdutoDaVariante[v.id] = produtoId;
  }
  tamanhos = tgQvOrdenarTamanhos(tamanhos);
  // Preco: da primeira variante disponivel (senao da primeira com preco). "De" so se for maior que o preco.
  for (i = 0; i < vs.length; i++) { if (vs[i].p && vs[i].ok) { precoV = vs[i]; break; } }
  if (!precoV) { for (i = 0; i < vs.length; i++) { if (vs[i].p) { precoV = vs[i]; break; } } }
  if (precoV && precoV.c && precoV.c > precoV.p) { de = precoV.c; }
  rg = /href="([^"]+)"\s+data-fancybox="product-gallery"/g;
  while ((m = rg.exec(html)) !== null && fotos.length < TG_QV_MAX_FOTOS) {
    u = tgQvFotoOk(tgQvDecode(m[1]));
    if (u && !vistos[u]) { vistos[u] = true; fotos.push(u); }
  }
  if (!fotos.length && item) { u = urlImagem(item.i); if (u) { fotos.push(u); } }
  return {
    ok: true, productId: produtoId, cor: cor, preco: precoV ? precoV.p : null, precoDe: de, fotos: fotos, tamanhos: tamanhos, url: item ? urlProduto(item.s) : null,
    parcelas: precoV && precoV.parc && Math.abs(precoV.parc.n * precoV.parc.v - precoV.p) < 1 ? precoV.parc : null,
    pix: precoV && precoV.pix && precoV.pix < precoV.p ? precoV.pix : null,
    descricao: tgQvDescricao(html)
  };
}

// Parcelamento sem juros da variante (installments_data da pagina do produto: JSON em texto, por meio de pagamento).
// Devolve a maior quantidade sem juros, entre 2 e 12, com o valor da parcela: { n, v }. Qualquer formato estranho = null.
function tgQvParcelas(bruto) {
  var obj, g, n, x, melhor = null;
  try {
    obj = typeof bruto === 'string' && bruto.length < 20000 ? JSON.parse(bruto) : null;
    if (!obj || typeof obj !== 'object') { return null; }
    for (g in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, g) || !obj[g] || typeof obj[g] !== 'object') { continue; }
      for (n in obj[g]) {
        if (!Object.prototype.hasOwnProperty.call(obj[g], n) || !/^[0-9]{1,2}$/.test(n)) { continue; }
        x = obj[g][n];
        if (!x || x.without_interests !== true || !tgQvNumPositivo(x.installment_value)) { continue; }
        if (+n >= 2 && +n <= 12 && (!melhor || +n > melhor.n)) { melhor = { n: +n, v: x.installment_value }; }
      }
    }
  } catch (e) { return null; }
  return melhor;
}

// Preco no Pix da variante: so quando a loja mostra o desconto do Pix (popup_discount_visibility) e o texto e um valor em reais.
function tgQvPix(v) {
  var vis, m, n;
  try {
    vis = v.popup_discount_visibility;
    if (!vis || typeof vis !== 'object') { return null; }
    for (m in vis) {
      if (Object.prototype.hasOwnProperty.call(vis, m) && vis[m] && vis[m].methods && vis[m].methods.pix && vis[m].methods.pix.show_discount === true) {
        m = /^R\$\s?([0-9]{1,3}(?:\.[0-9]{3})*),([0-9]{2})$/.exec(String(v.price_with_payment_discount_short || '').trim());
        if (!m) { return null; }
        n = parseFloat(m[1].replace(/\./g, '') + '.' + m[2]);
        return n > 0 && isFinite(n) ? n : null;
      }
    }
  } catch (e) {}
  return null;
}

// Descricao da pagina do produto (bloco .user-content), so como TEXTO estruturado, no padrao das descricoes da Talgui
// (o mesmo que a pagina Influenciadoras le): introducao, "Destaques da Peca" e "Detalhes Tecnicos" / "Ficha Tecnica".
// Nunca devolve HTML; o DOM recebe tudo por textContent. Sem descricao reconhecivel = null.
var TG_QV_ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', ordm: 'º', ordf: 'ª', deg: '°', middot: '·', bull: '•', times: '×', ccedil: 'ç', Ccedil: 'Ç',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', atilde: 'ã', otilde: 'õ', Atilde: 'Ã', Otilde: 'Õ', acirc: 'â', ecirc: 'ê', ocirc: 'ô', Acirc: 'Â', Ecirc: 'Ê', Ocirc: 'Ô', agrave: 'à', Agrave: 'À', uuml: 'ü' };
function tgQvTextoHtml(f) {
  var t = String(f).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, function (todo, c) {
    var n;
    if (c.charAt(0) === '#') {
      n = c.charAt(1) === 'x' || c.charAt(1) === 'X' ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10);
      return isFinite(n) && n > 31 && n < 0xFFFF ? String.fromCharCode(n) : '';
    }
    return Object.prototype.hasOwnProperty.call(TG_QV_ENT, c) ? TG_QV_ENT[c] : todo;
  });
  return t.replace(/\s+/g, ' ').trim();
}
function tgQvCorte(t, max) { return t.length > max ? t.slice(0, max - 1).replace(/\s+$/, '') + '…' : t; }
function tgQvItens(corpo) {
  var out = [], re = /<li\b[^>]*>([\s\S]*?)<\/li>/gi, m, t, k;
  while ((m = re.exec(corpo)) !== null && out.length < 8) {
    t = tgQvTextoHtml(m[1]);
    if (!t) { continue; }
    k = t.indexOf(':');
    if (k > 0 && k <= 60 && t.slice(k + 1).trim()) { out.push({ rotulo: t.slice(0, k).trim(), texto: tgQvCorte(t.slice(k + 1).trim(), 400) }); }
    else { out.push({ rotulo: null, texto: tgQvCorte(t, 400) }); }
  }
  return out;
}
function tgQvDescricao(html) {
  var i, bloco, partes, cabeca, secoes = [], k, intro = [], re, m, t, dest, ficha, alt;
  try {
    if (typeof html !== 'string') { return null; }
    i = html.indexOf('class="user-content"');
    if (i < 0) { return null; }
    bloco = html.slice(i, i + 60000);
    // o bloco termina na primeira tabela (institucional) ou no fim do formulario/coluna da descricao
    k = bloco.search(/<table\b|<form\b|data-store="product-|<script\b/i);
    if (k > 0) { bloco = bloco.slice(0, k); }
    bloco = bloco.replace(/^[^>]*>/, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<h1\b[\s\S]*?<\/h1>/gi, ' ');
    partes = bloco.split(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i);
    cabeca = partes[0] || '';
    for (k = 1; k < partes.length; k += 2) { secoes.push({ titulo: tgQvTextoHtml(partes[k] || ''), corpo: partes[k + 1] || '' }); }
    re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
    while ((m = re.exec(cabeca)) !== null && intro.length < 3) { t = tgQvTextoHtml(m[1]); if (t) { intro.push(tgQvCorte(t, 600)); } }
    for (k = 0; k < secoes.length; k++) {
      if (!dest && /destaque|diferencia/i.test(secoes[k].titulo)) { dest = secoes[k]; }
      if (!ficha && /t[eé]cnic|ficha/i.test(secoes[k].titulo)) { ficha = secoes[k]; }
    }
    if (!dest) { for (k = 0; k < secoes.length; k++) { if (secoes[k] !== ficha && /<li\b/i.test(secoes[k].corpo)) { alt = secoes[k]; break; } } dest = alt || null; }
    dest = dest ? tgQvItens(dest.corpo) : [];
    ficha = ficha ? tgQvItens(ficha.corpo) : [];
    if (!intro.length && !dest.length && !ficha.length) { return null; }
    return { intro: intro, destaques: dest, ficha: ficha };
  } catch (e) { return null; }
}

function tgQvBuscar(url, item) {
  return new Promise(function (resolve) {
    var ctl = null, timer = 0, fim = false;
    function sair(r) { if (fim) { return; } fim = true; clearTimeout(timer); resolve(r); }
    try {
      if (typeof fetch !== 'function') { sair({ ok: false, motivo: 'sem-fetch' }); return; }
      if (typeof AbortController === 'function') { ctl = new AbortController(); }
      timer = setTimeout(function () { try { if (ctl) { ctl.abort(); } } catch (e) {} sair({ ok: false, motivo: 'timeout' }); }, TG_QV_TIMEOUT_MS);
      fetch(url, { credentials: 'same-origin', headers: { 'Accept': 'text/html' }, signal: ctl ? ctl.signal : undefined }).then(function (r) {
        if (!r || !r.ok) { sair({ ok: false, motivo: 'http' }); return null; }
        return r.text();
      }).then(function (html) {
        if (html === null || html === undefined) { return; }
        var d = tgQvParse(html, item);
        if (d.ok) { d.url = url; }
        sair(d);
      }).then(null, function () { sair({ ok: false, motivo: 'rede' }); });
    } catch (e) { sair({ ok: false, motivo: 'erro' }); }
  });
}

// Promise sempre resolvida: { ok, cor, preco, precoDe, fotos[], tamanhos:[{rotulo, variantId, disponivel}], url, productId } ou { ok:false, motivo }.
// Cache por handle na pagina; falha nao fica no cache (a proxima abertura tenta de novo).
function tgVariantesDoProduto(item) {
  var url = item && typeof item === 'object' ? urlProduto(item.s) : null, p, n = 0, k;
  if (!url) { return Promise.resolve({ ok: false, motivo: 'item' }); }
  if (Object.prototype.hasOwnProperty.call(tgQvCache, item.s)) { return tgQvCache[item.s]; }
  for (k in tgQvCache) { if (Object.prototype.hasOwnProperty.call(tgQvCache, k)) { n++; } }
  if (n >= TG_QV_MAX_CACHE) { tgQvCache = {}; }
  p = tgQvBuscar(url, item).then(function (r) {
    if (!r.ok) { delete tgQvCache[item.s]; }
    return r;
  });
  tgQvCache[item.s] = p;
  return p;
}

function tgQuickViewPrefetch(item) {
  try { tgVariantesDoProduto(item).then(null, function () {}); } catch (e) {}
}

// ---------------------------------------------------------------- sacola (porta de store-cart.ts)
// Abre a sacola do tema pelo MESMO toque no icone visivel (o Morelia grava a entrada de historico que o back() dele espera).
// v15 (Danilo, 25/11): peca adicionada pelo modal NAO abre a sacola sozinha; a sacola so abre no "Ver sacola". Se a plataforma (LS.addToCartEnhanced
// com carrinho ajax) abrir o #modal-cart por conta propria logo depois de adicionar, ele e fechado na hora (por 4 s; depois disso, ou se a cliente
// pediu a sacola, nada e mexido).
var tgQvSacolaPedida = 0;
function tgQvSegurarSacola() {
  var modal, fim, obs = null, t = 0, conferir, parar;
  try {
    modal = document.querySelector('#modal-cart');
    if (!modal) { return; }
    fim = Date.now() + 4000;
    parar = function () { try { if (obs) { obs.disconnect(); } } catch (e) {} clearInterval(t); };
    conferir = function () {
      var x;
      try {
        if (Date.now() > fim || tgQvSacolaPedida > fim - 4000 || !modal.classList) { parar(); return; }
        if (modal.classList.contains('modal-show')) {
          x = modal.querySelector ? modal.querySelector('.js-modal-close') : null;
          if (x && x.click) { x.click(); } else { modal.classList.remove('modal-show'); }
        }
      } catch (e) { parar(); }
    };
    if (typeof MutationObserver === 'function') { obs = new MutationObserver(conferir); obs.observe(modal, { attributes: true, attributeFilter: ['class'] }); }
    t = setInterval(conferir, 150);
    setTimeout(parar, 4100);
    conferir();
  } catch (e) {}
}
function tgAbrirSacolaDoTema() {
  try {
    var modal = document.querySelector('#modal-cart'), gatilhos, i, g, vis = null;
    if (!modal || (modal.classList && modal.classList.contains('modal-show'))) { return; }
    gatilhos = document.querySelectorAll('.js-modal-open[data-toggle="#modal-cart"], .js-modal-open-private[data-target="#modal-cart"]');
    for (i = 0; i < gatilhos.length; i++) {
      g = gatilhos[i];
      if (g.offsetParent !== null || (g.getClientRects && g.getClientRects().length)) { vis = g; break; }
    }
    if (vis) { vis.click(); return; }
    if (typeof window.modalOpen === 'function') { window.modalOpen('#modal-cart', 'openFullScreenWithoutClick'); return; }
    if (gatilhos[0]) { gatilhos[0].click(); }
  } catch (e) {}
}

function tgQvCampo(nome, valor) {
  var i = document.createElement('input');
  i.setAttribute('type', 'hidden');
  i.setAttribute('name', nome);
  i.setAttribute('value', valor);
  return i;
}

// Poe a peca na sacola pela funcao da propria loja (LS.addToCartEnhanced). Resolve { ok:true } ou { ok:false, motivo }.
// So variante numerica e quantidade de 1 a 10. opcoes: { productId (senao o lembrado da leitura da pagina), abrirSacola (padrao true),
// antesDeAbrir (funcao: o chamador fecha o proprio overlay aqui) }. Em caso de sucesso fecha o quick view aberto e SO ENTAO abre #modal-cart.
// v15: manterQuickView (o proprio quick view confirma a sacola e oferece "Ver sacola"; nao fecha). O contador da sacola do tema e
// atualizado pela propria LS.addToCartEnhanced.
function tgAdicionarSacola(variantId, qtd, opcoes) {
  return new Promise(function (resolve) {
    var vid = tgQvIdOk(variantId), n = tgQvQtdOk(qtd === undefined ? 1 : qtd), pid = null, w, ls, acao = '/comprar/', ex, form, fim = false, timer = 0;
    function sair(r) {
      if (fim) { return; }
      fim = true;
      clearTimeout(timer);
      if (r.ok) {
        if (!opcoes || !opcoes.manterQuickView) { try { tgQvFechar('sacola'); } catch (e) {} }
        try { if (opcoes && typeof opcoes.antesDeAbrir === 'function') { opcoes.antesDeAbrir(); } } catch (e) {}
        if (!opcoes || opcoes.abrirSacola !== false) { setTimeout(tgAbrirSacolaDoTema, 80); } else { tgQvSegurarSacola(); }
      }
      resolve(r);
    }
    try {
      if (!vid || !n) { sair({ ok: false, motivo: 'dados' }); return; }
      pid = tgQvIdOk(opcoes && opcoes.productId) || tgQvProdutoDaVariante[vid] || null;
      if (!pid) { sair({ ok: false, motivo: 'produto' }); return; }
      w = typeof window !== 'undefined' ? window : null;
      ls = w && w.LS;
      if (!ls || typeof ls.addToCartEnhanced !== 'function') { sair({ ok: false, motivo: 'sem-ls' }); return; }
      if (typeof document.querySelector === 'function') {
        ex = document.querySelector('form[action*="buy"], form[action*="comprar"]');
        if (ex && /^\/(?![\/\\])[^\s\u0000-\u001f]*$/.test(ex.getAttribute('action') || '')) { acao = ex.getAttribute('action'); }
      }
      form = document.createElement('form');
      form.setAttribute('action', acao);
      form.setAttribute('method', 'post');
      form.appendChild(tgQvCampo('add_to_cart', pid));
      form.appendChild(tgQvCampo('variant_id', vid)); // sem isto a plataforma escolhe outra variante sozinha
      form.appendChild(tgQvCampo('quantity', String(n)));
      timer = setTimeout(function () { sair({ ok: false, motivo: 'timeout' }); }, 10000);
      var alvo = typeof w.jQuery === 'function' ? w.jQuery(form) : form, ret;
      ret = ls.addToCartEnhanced(alvo, '', '', '', true, function () { sair({ ok: true }); }, function () { sair({ ok: false, motivo: 'recusado' }); });
      if (ret && typeof ret.then === 'function') { ret.then(null, function () { sair({ ok: false, motivo: 'recusado' }); }); }
    } catch (e) { sair({ ok: false, motivo: 'erro' }); }
  });
}

// ---------------------------------------------------------------- estilos
function tgQvVar(nome, padrao) { TG_QV_TOKENS['--tgb-' + nome] = padrao; return 'var(--tgb-' + nome + ',' + padrao + ')'; }

function tgQvMontarCss() {
  var V = tgQvVar, P = '.tg-busca-qv-', R = '.tg-busca-qv-raiz ';
  var fonte = V('fonte', 'inherit'), texto = V('cor-texto', '#202020'), fundo = V('cor-fundo', '#fff'), dest = V('cor-destaque', '#000');
  var suave = V('qv-cor-suave', '#6d6d6d'), linha = V('qv-cor-linha', '#e3e3e3'), borda = V('qv-cor-borda', '#bdbdbd'), erro = V('qv-cor-erro', '#991b1b');
  var pad = V('qv-pad', '16px'), btnAlt = V('qv-botao-altura', '48px'), btnRaio = V('botao-raio', '0px');
  var tam = V('qv-tamanho-btn', '38px'), chip = V('qv-chip-tam', '34px');
  return [
    P + 'raiz{position:fixed;top:0;right:0;bottom:0;left:0;z-index:' + TG_QV_Z + ';display:flex;align-items:flex-end;justify-content:center;font-family:' + fonte + ';color:' + texto + ';font-size:14px;line-height:1.4;-webkit-text-size-adjust:100%;text-align:left}',
    R + '*{box-sizing:border-box}',
    P + 'fundo{position:absolute;top:0;right:0;bottom:0;left:0;background:' + V('qv-scrim', 'rgba(0,0,0,.4)') + ';animation:tg-busca-qv-fade .2s ease}',
    // v14 (Danilo, 24/11): 10% menor (94 -> 84); no iPhone o vh conta a area atras da barra do Safari, entao o dvh (area visivel) vale quando existir
    P + 'painel{position:relative;display:flex;flex-direction:column;width:100%;max-height:' + V('qv-altura-max', '84vh') + ';background:' + fundo + ';border-radius:' + V('qv-raio', '14px') + ' ' + V('qv-raio', '14px') + ' 0 0;overflow:hidden;animation:tg-busca-qv-sobe .28s ease}',
    '@supports (height:1dvh){' + P + 'painel{max-height:' + V('qv-altura-max-dvh', '84dvh') + '}}',
    P + 'painel[data-arrastando="true"],' + P + 'painel.tg-busca-qv-assentado{animation:none}',
    P + 'painel:focus{outline:0}',
    P + 'cab{flex:none;display:grid;grid-template-columns:1fr auto;align-items:center;gap:0 8px;padding:14px ' + pad + ' 10px;border-bottom:1px solid ' + linha + '}',
    P + 'alca{grid-column:1/-1;display:flex;align-items:center;justify-content:center;height:16px;margin:-6px calc(-1*' + pad + ') 0;touch-action:none}',
    P + 'alca span{display:block;width:40px;height:4px;border-radius:4px;background:#d4d4d4}',
    // cabecalho como na pagina Influenciadoras: rotulo pequeno (caixa alta, cinza) e o nome da peca vai para o corpo, junto do preco
    R + 'p' + P + 'cab-rotulo{margin:0;padding:0;min-width:0;font-size:11px;font-weight:400;line-height:1.3;letter-spacing:.08em;text-transform:uppercase;color:' + suave + '}',
    R + 'h2' + P + 'titulo{display:flex;align-items:flex-start;gap:8px;margin:16px 0 0;padding:0;min-width:0;font-family:inherit;font-size:17px;font-weight:500;line-height:1.3;letter-spacing:normal;text-transform:none;color:' + texto + '}',
    P + 'bolinha{flex:none;display:block;width:14px;height:14px;margin-top:4px;border-radius:50%;box-shadow:inset 0 0 0 1px rgba(0,0,0,.2)}',
    P + 'parc{margin:2px 0 0;font-size:12px;line-height:1.4;color:' + suave + '}',
    P + 'parc b{font-weight:600;color:' + texto + '}',
    P + 'dest{display:grid;gap:8px;margin:14px 0 0;padding:0;list-style:none}',
    P + 'dest li{margin:0;padding:0;font-size:13px;line-height:1.5;color:#3a3a3a}',
    P + 'dest b{font-weight:500;color:' + texto + '}',
    P + 'acc{margin:0;border-top:1px solid ' + linha + '}',
    P + 'acc:last-of-type{border-bottom:1px solid ' + linha + '}',
    P + 'accs{margin-top:18px}',
    R + 'button' + P + 'acc-bt{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:48px;margin:0;padding:0;border:0;background:none;color:' + texto + ';font-family:inherit;font-size:10px;font-weight:400;line-height:1.3;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;-webkit-appearance:none;appearance:none}',
    R + 'button' + P + 'acc-bt::after{content:"+";font-size:18px;letter-spacing:0;color:' + texto + '}',
    R + 'button' + P + 'acc-bt[aria-expanded="true"]::after{content:"\\2212"}',
    P + 'acc-corpo{padding:0 0 12px}',
    P + 'acc-corpo[hidden]{display:none}',
    // v15: Descricao e Detalhes abrem como gaveta (a altura anima de 0 ao conteudo); fechada, o conteudo fica invisivel para o leitor e o Tab
    P + 'acc-gaveta{display:grid;grid-template-rows:0fr;visibility:hidden;transition:grid-template-rows .3s ease,visibility 0s linear .3s}',
    P + 'acc-gaveta' + P + 'acc-aberta{grid-template-rows:1fr;visibility:visible;transition:grid-template-rows .3s ease,visibility 0s}',
    P + 'acc-dentro{min-height:0;overflow:hidden}',
    P + 'texto{margin:0 0 10px;font-size:13.5px;line-height:1.65;color:#3a3a3a}',
    P + 'ficha{display:grid;grid-template-columns:minmax(0,40%) minmax(0,1fr);gap:8px;margin:0;padding:8px 0;border-top:1px solid #f2f2f2;font-size:12.5px;line-height:1.5;color:#3a3a3a}',
    P + 'ficha:first-child{border-top:0}',
    P + 'ficha dt{margin:0;font-weight:600;color:' + texto + '}',
    P + 'ficha dd{margin:0}',
    P + 'pe-peca{display:flex;align-items:center;gap:10px;min-width:0;margin:0 0 8px}',
    R + P + 'pe-peca img{flex:none;display:block;width:40px;height:50px;max-width:none;object-fit:cover;background:#f2f2f2}',
    P + 'pe-inf{display:grid;gap:1px;min-width:0}',
    P + 'pe-nome{margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:1.35;color:' + texto + '}',
    P + 'pe-preco{display:flex;align-items:baseline;gap:8px;margin:0;font-size:14px;font-weight:600;line-height:1.3}',
    P + 'pe-preco span{font-size:11.5px;font-weight:400;color:' + suave + '}',
    R + 'button' + P + 'fechar{display:flex;align-items:center;justify-content:center;width:44px;height:44px;margin:0;padding:0;border:1px solid #d6d6d6;border-radius:50%;background:#f2f2f2;color:' + texto + ';font:inherit;font-size:20px;line-height:1;cursor:pointer;-webkit-appearance:none;appearance:none}',
    R + 'button:focus-visible,' + R + 'a:focus-visible{outline:2px solid #000;outline-offset:2px}',
    P + 'rolagem{flex:1 1 auto;min-height:0;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:0 ' + pad + ' 8px}',
    P + 'gal{margin:12px calc(-1*' + pad + ') 0;min-width:0}',
    P + 'palco{position:relative;min-width:0}',
    P + 'trilho{position:relative;display:flex;gap:6px;min-width:0;overflow-x:auto;overscroll-behavior-x:contain;scroll-snap-type:x mandatory;scroll-padding-left:' + pad + ';padding:0 ' + pad + ';scrollbar-width:none}',
    P + 'trilho::-webkit-scrollbar{display:none}',
    // galeria como na pagina Influenciadoras: uma foto por tela (a proxima aparece na borda), contador e miniaturas 44x56
    P + 'quadro{flex:0 0 calc(100% - 34px);min-width:0;aspect-ratio:' + V('qv-foto-proporcao', '2 / 3') + ';overflow:hidden;scroll-snap-align:start;background:#f2f2f2}',
    P + 'trilho-uma ' + P + 'quadro{flex-basis:100%}',
    R + P + 'quadro img{display:block;width:100%;max-width:none;height:100%;object-fit:cover}',
    P + 'conta{position:absolute;right:' + 'calc(' + pad + ' + 42px);bottom:8px;padding:2px 8px;border-radius:999px;background:rgba(0,0,0,.45);color:#fff;font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums;pointer-events:none}',
    P + 'minis{display:flex;gap:6px;min-width:0;margin:8px 0 0;padding:0 ' + pad + ';overflow-x:auto;scrollbar-width:none}',
    P + 'minis::-webkit-scrollbar{display:none}',
    R + 'button' + P + 'mini{position:relative;overflow:hidden;flex:none;width:44px;height:56px;margin:0;padding:0;border:1px solid transparent;border-radius:0;background:none;cursor:pointer;-webkit-appearance:none;appearance:none}',
    R + 'button' + P + 'mini[aria-current="true"]{border-color:' + texto + '}',
    R + P + 'mini img{position:absolute;top:0;right:0;bottom:0;left:0;display:block;width:100%;max-width:none;height:100%;max-height:none;object-fit:cover;object-position:50% 20%}',  // QA 3.3: preenche a moldura 44x56 mesmo com foto quadrada
    P + 'inf{display:grid;grid-template-columns:minmax(0,1fr);grid-auto-rows:max-content;align-content:start;min-width:0;padding:0 0 6px}',
    P + 'inf>*{min-width:0}',
    P + 'preco{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;margin:4px 0 0;font-size:' + V('qv-preco-tam', '16px') + ';font-weight:' + V('qv-preco-peso', '600') + ';line-height:1.3}',
    P + 'preco s{font-size:13px;font-weight:400;color:' + suave + '}',
    P + 'rotulo{margin:18px 0 8px;font-size:10px;font-weight:400;line-height:1.3;text-transform:uppercase;letter-spacing:.08em;color:' + suave + '}',
    P + 'rotulo span{text-transform:none;letter-spacing:0;font-size:12px;color:' + texto + '}',
    P + 'pe ' + P + 'rotulo{margin:0 0 6px}',
    P + 'cores,' + P + 'tamanhos{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}',
    // outras cores em cards pequenos com foto e nome (como "Tambem em outras cores" da pagina Influenciadoras), em trilho horizontal
    P + 'cores{flex:none;align-items:flex-start;min-height:-webkit-max-content;min-height:max-content;flex-wrap:nowrap;gap:10px;margin:0 calc(-1*' + pad + ');padding:0 ' + pad + ' 2px;overflow-x:auto;scroll-snap-type:x proximity;scroll-padding-left:' + pad + ';scrollbar-width:none}',
    P + 'cores::-webkit-scrollbar{display:none}',
    R + 'button' + P + 'cor{position:relative;display:grid;gap:4px;flex:none;width:76px;margin:0;padding:0;border:0;border-radius:0;background:none;color:' + texto + ';font-family:inherit;text-align:left;scroll-snap-align:start;cursor:pointer;-webkit-appearance:none;appearance:none}',
    R + P + 'cor img,' + R + P + 'cor-sem{display:block;width:76px;height:95px;max-width:none;object-fit:cover;background:#f2f2f2;outline:1px solid transparent;outline-offset:-1px}',
    R + 'button' + P + 'cor[aria-pressed="true"] img,' + R + 'button' + P + 'cor[aria-pressed="true"] ' + P + 'cor-sem{outline:2px solid ' + dest + ';outline-offset:-2px}',
    P + 'cor-nome{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:11px;line-height:1.3}',
    R + 'button' + P + 'cor[aria-pressed="true"] ' + P + 'cor-nome{font-weight:600}',
    R + 'button' + P + 'cor-esg img{opacity:.4}',
    R + 'button' + P + 'cor-esg ' + P + 'cor-nome{color:' + suave + '}',
    R + 'button' + P + 'tam{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;min-width:' + tam + ';height:' + tam + ';margin:0;padding:0 8px;border:1px solid ' + borda + ';border-radius:0;background:' + fundo + ';color:' + texto + ';font-family:inherit;font-size:12.5px;font-weight:400;line-height:1;letter-spacing:normal;text-transform:none;font-variant-numeric:tabular-nums;cursor:pointer;-webkit-appearance:none;appearance:none}',
    // area de toque de 44 px sem aumentar o desenho do botao
    R + 'button' + P + 'tam::before{content:"";position:absolute;top:-3px;right:-3px;bottom:-3px;left:-3px}',
    R + 'button' + P + 'tam[aria-pressed="true"]{background:' + dest + ';border-color:' + dest + ';color:#fff}',
    R + 'button' + P + 'tam-esg{color:#a6a6a6;border-color:#e1e1e1;background:' + fundo + ' linear-gradient(to top right,transparent calc(50% - .5px),#c4c4c4 50%,transparent calc(50% + .5px));cursor:not-allowed}',
    P + 'treme{animation:tg-busca-qv-treme .35s ease-in-out}',
    P + 'esq{display:flex;gap:6px}',
    P + 'esq i{display:block;width:' + tam + ';height:' + tam + ';background:#eee;animation:tg-busca-qv-pulsa 1.2s ease-in-out infinite}',
    P + 'msg{min-height:0;margin:6px 0 0;font-size:12px;line-height:1.4;color:' + suave + '}',
    P + 'msg:empty{display:none}',
    P + 'msg-erro{color:' + erro + '}',
    P + 'pe{position:relative;flex:none;display:grid;gap:4px;padding:12px ' + pad + ' calc(12px + env(safe-area-inset-bottom,0px));border-top:1px solid ' + linha + ';background:' + fundo + '}',
    R + 'button' + P + 'add{display:flex;align-items:center;justify-content:center;width:100%;min-height:' + btnAlt + ';margin:0;padding:0 16px;border:1px solid ' + dest + ';border-radius:' + btnRaio + ';background:' + dest + ';color:#fff;font-family:inherit;font-size:14px;font-weight:500;line-height:1.2;letter-spacing:normal;text-transform:none;cursor:pointer;-webkit-appearance:none;appearance:none}',
    R + 'button' + P + 'add:disabled{background:#e6e6e6;border-color:#e6e6e6;color:#8a8a8a;cursor:not-allowed}',
    R + 'a' + P + 'pagina{display:flex;align-items:center;justify-self:start;min-height:44px;margin:14px 0 0;padding:0;color:' + texto + ';font-size:10px;line-height:1.3;letter-spacing:.08em;text-transform:uppercase;text-decoration:underline;text-underline-offset:3px}',
    R + P + 'pe a' + P + 'pagina{justify-self:stretch;justify-content:center;margin:0;font-size:13px;letter-spacing:normal;text-transform:none}',
    R + 'a' + P + 'pagina-prim{min-height:' + btnAlt + ';border:1px solid ' + dest + ';border-radius:' + btnRaio + ';background:' + dest + ';color:#fff;font-weight:500;text-decoration:none}',
    P + 'peca{display:grid;grid-template-columns:' + V('qv-peca-foto', '84px') + ' minmax(0,1fr);gap:0 12px;padding:14px 0;border-bottom:1px solid ' + linha + '}',
    P + 'peca:last-child{border-bottom:0}',
    P + 'peca-foto{display:block;align-self:start;aspect-ratio:2 / 3;overflow:hidden;background:#f2f2f2}',
    R + P + 'peca-foto img{display:block;width:100%;max-width:none;height:100%;object-fit:cover}',
    P + 'peca-inf{min-width:0}',
    R + 'a' + P + 'peca-nome{display:block;margin:0 0 4px;color:' + texto + ';font-size:13px;font-weight:500;line-height:1.35;text-decoration:none}',
    P + 'peca-inf ' + P + 'rotulo{margin:10px 0 6px}',
    P + 'total{margin:0;font-size:13px;color:' + suave + ';text-align:center}',
    // conjunto no padrao Influenciadoras: um card por peca (foto a esquerda; nome com bolinha, preco, parcelas, destaques e "Detalhes da peca")
    P + 'cj-sub{margin:4px 0 6px;font-size:12px;line-height:1.45;color:' + suave + '}',
    P + 'cj{display:grid;grid-template-columns:' + V('qv-cj-foto', '40%') + ' minmax(0,1fr);gap:0 14px;align-items:start;padding:16px 0;border-bottom:1px solid ' + linha + '}',
    P + 'cj:last-child{border-bottom:0;padding-bottom:calc(16px + env(safe-area-inset-bottom,0px))}',
    R + 'button' + P + 'cj-foto{display:block;width:100%;margin:0;padding:0;border:0;border-radius:0;background:#f2f2f2;aspect-ratio:2 / 3;overflow:hidden;cursor:pointer;-webkit-appearance:none;appearance:none}',
    R + P + 'cj-foto img{display:block;width:100%;max-width:none;height:100%;object-fit:cover}',
    P + 'cj-inf{display:flex;flex-direction:column;align-items:flex-start;min-width:0;padding-top:2px}',
    R + 'p' + P + 'cj-nome{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;width:100%;margin:0;font-size:14px;font-weight:400;line-height:1.35;color:' + texto + '}',
    P + 'cj-nome ' + P + 'bolinha{margin-top:2px}',
    P + 'cj-inf ' + P + 'preco{margin:6px 0 0;font-size:14px}',
    P + 'cj-extra{min-height:0}',
    P + 'cj-extra ' + P + 'parc{margin:2px 0 0}',
    R + 'p' + P + 'cj-dest{margin:8px 0 0;font-size:12px;line-height:1.45;color:#3a3a3a}',
    R + 'button' + P + 'cj-det{display:inline-flex;align-items:center;gap:8px;min-height:44px;margin:14px 0 0;padding:0 16px;border:1px solid ' + texto + ';border-radius:0;background:' + fundo + ';color:' + texto + ';font-family:inherit;font-size:13px;font-weight:400;line-height:1.2;cursor:pointer;-webkit-appearance:none;appearance:none}',
    R + 'button' + P + 'cj-det::after{content:"";width:6px;height:6px;border-top:1.5px solid currentColor;border-right:1.5px solid currentColor;transform:rotate(45deg)}',
    // v15 (revisao do Danilo, 25/11): Voltar no cabecalho, foto que amplia, confirmacao da sacola, saida animada e troca de cor como pagina virando
    P + 'cab-esq{display:flex;align-items:center;gap:4px;min-width:0}',
    R + 'button' + P + 'voltar{display:inline-flex;align-items:center;gap:6px;flex:none;min-height:44px;margin:0 0 0 -10px;padding:0 10px;border:0;border-radius:999px;background:none;color:' + texto + ';font-family:inherit;font-size:12px;font-weight:500;line-height:1;letter-spacing:normal;text-transform:none;cursor:pointer;-webkit-appearance:none;appearance:none}',
    R + 'button' + P + 'voltar::before{content:"";width:7px;height:7px;margin-left:2px;border-left:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg)}',
    R + 'button' + P + 'voltar:hover{background:#f2f2f2}',
    R + 'button' + P + 'voltar[hidden]{display:none}',
    R + 'button' + P + 'quadro{display:block;margin:0;padding:0;border:0;border-radius:0;cursor:zoom-in;-webkit-appearance:none;appearance:none}',
    R + 'button' + P + 'add' + P + 'add-ok{gap:10px;background:' + V('qv-cor-ok', '#1d6b40') + ';border-color:' + V('qv-cor-ok', '#1d6b40') + ';color:#fff}',
    R + 'button' + P + 'add-ok::before{content:"";width:12px;height:6px;margin-top:-4px;border-left:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(-45deg)}',
    P + 'aviso{position:absolute;right:' + pad + ';bottom:calc(100% + 10px);left:' + pad + ';z-index:3;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 8px 8px 14px;border-radius:10px;background:#1f1f1f;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.18);animation:tg-busca-qv-aviso .26s ease}',
    P + 'aviso[hidden]{display:none}',
    R + 'p' + P + 'aviso-txt{display:flex;align-items:center;gap:10px;min-width:0;margin:0;font-size:13px;line-height:1.35;color:#fff}',
    R + 'p' + P + 'aviso-txt::before{content:"";flex:none;width:10px;height:5px;margin-top:-3px;border-left:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(-45deg)}',
    R + 'button' + P + 'aviso-ver{flex:none;min-height:40px;margin:0;padding:0 14px;border:1px solid #fff;border-radius:999px;background:#fff;color:#111;font-family:inherit;font-size:12.5px;font-weight:600;line-height:1;letter-spacing:normal;text-transform:none;cursor:pointer;-webkit-appearance:none;appearance:none}',
    P + 'saindo{pointer-events:none}',
    P + 'saindo ' + P + 'fundo{animation:tg-busca-qv-some .22s ease forwards}',
    P + 'raiz' + P + 'saindo ' + P + 'painel{animation:tg-busca-qv-desce .22s ease-in forwards}',
    P + 'virando{animation:tg-busca-qv-vira .34s cubic-bezier(.2,.7,.2,1);transform-origin:left center;-webkit-backface-visibility:hidden;backface-visibility:hidden}',
    P + 'virando' + P + 'virando-volta{animation-name:tg-busca-qv-vira-volta;transform-origin:right center}',
    // foto ampliada: fundo escuro sobre tudo, foto inteira (contain), passa com o dedo; setas no desktop
    P + 'lupa{position:fixed;top:0;right:0;bottom:0;left:0;z-index:5;display:flex;flex-direction:column;background:rgba(0,0,0,.94);color:#fff;animation:tg-busca-qv-fade .2s ease}',
    P + 'lupa-trilho{flex:1 1 auto;display:flex;min-height:0;overflow-x:auto;overflow-y:hidden;overscroll-behavior:contain;scroll-snap-type:x mandatory;scrollbar-width:none}',
    P + 'lupa-trilho::-webkit-scrollbar{display:none}',
    P + 'lupa-quadro{flex:0 0 100%;display:flex;align-items:center;justify-content:center;min-width:0;padding:64px 12px calc(40px + env(safe-area-inset-bottom,0px));scroll-snap-align:center;scroll-snap-stop:always}',
    R + P + 'lupa-quadro img{display:block;width:auto;height:auto;max-width:100%;max-height:100%;object-fit:contain}',
    R + 'p' + P + 'lupa-conta{position:absolute;top:calc(22px + env(safe-area-inset-top,0px));left:50%;margin:0;padding:3px 10px;border-radius:999px;background:rgba(255,255,255,.14);color:#fff;font-size:13px;line-height:1.5;font-variant-numeric:tabular-nums;transform:translateX(-50%)}',
    R + 'button' + P + 'lupa-fechar{position:absolute;top:calc(12px + env(safe-area-inset-top,0px));right:12px;display:flex;align-items:center;justify-content:center;width:44px;height:44px;margin:0;padding:0;border:1px solid rgba(255,255,255,.4);border-radius:50%;background:rgba(0,0,0,.45);color:#fff;font-family:inherit;font-size:22px;line-height:1;cursor:pointer;-webkit-appearance:none;appearance:none}',
    R + 'button' + P + 'lupa-ant,' + R + 'button' + P + 'lupa-prox{position:absolute;top:50%;display:flex;align-items:center;justify-content:center;width:48px;height:48px;margin:-24px 0 0;padding:0;border:1px solid rgba(255,255,255,.4);border-radius:50%;background:rgba(0,0,0,.45);color:#fff;cursor:pointer;-webkit-appearance:none;appearance:none}',
    R + 'button' + P + 'lupa-ant{left:16px}',
    R + 'button' + P + 'lupa-prox{right:16px}',
    R + 'button' + P + 'lupa-ant::before,' + R + 'button' + P + 'lupa-prox::before{content:"";width:10px;height:10px;border-top:2px solid currentColor;border-right:2px solid currentColor}',
    R + 'button' + P + 'lupa-ant::before{margin-left:5px;transform:rotate(-135deg)}',
    R + 'button' + P + 'lupa-prox::before{margin-right:5px;transform:rotate(45deg)}',
    R + P + 'lupa button:focus-visible{outline:2px solid #fff;outline-offset:2px}',
    // v15 (so celular): o rodape fixo comeca escondido (a foto aparece inteira) e sobe quando a rolagem passa do bloco de preco
    P + 'painel-pe-flutua ' + P + 'pe{position:absolute;right:0;bottom:0;left:0;z-index:2;box-shadow:0 -8px 20px rgba(0,0,0,.08);transition:transform .3s cubic-bezier(.2,.8,.2,1),visibility 0s}',
    P + 'painel-pe-flutua ' + P + 'pe' + P + 'pe-oculto{transform:translateY(calc(100% + 24px));visibility:hidden;box-shadow:none;transition:transform .24s ease-in,visibility 0s linear .24s}',
    P + 'pe-espaco{display:block;height:0}',
    P + 'marca,' + P + 'marca-fim{display:block;height:1px;margin-top:-1px;pointer-events:none}',
    '@media (max-width:767px){' + R + 'button' + P + 'lupa-ant,' + R + 'button' + P + 'lupa-prox{display:none}}',
    '@keyframes tg-busca-qv-sobe{from{transform:translateY(24px);opacity:.6}}',
    '@keyframes tg-busca-qv-desce{to{transform:translateY(100%)}}',
    '@keyframes tg-busca-qv-some{to{opacity:0}}',
    '@keyframes tg-busca-qv-entra{from{opacity:0;transform:scale(.96)}}',
    '@keyframes tg-busca-qv-sai{to{opacity:0;transform:scale(.96)}}',
    '@keyframes tg-busca-qv-vira{from{opacity:.15;transform:perspective(1200px) rotateY(-14deg) translateX(28px)}}',
    '@keyframes tg-busca-qv-vira-volta{from{opacity:.15;transform:perspective(1200px) rotateY(14deg) translateX(-28px)}}',
    '@keyframes tg-busca-qv-aviso{from{opacity:0;transform:translateY(8px)}}',
    '@keyframes tg-busca-qv-fade{from{opacity:0}}',
    '@keyframes tg-busca-qv-pulsa{50%{opacity:.5}}',
    '@keyframes tg-busca-qv-treme{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}',
    '@media (prefers-reduced-motion:reduce){' + P + 'painel,' + P + 'fundo,' + P + 'esq i,' + P + 'treme{animation:none}}',
    '@media (min-width:768px){',
    P + 'raiz{align-items:center}',
    P + 'painel{width:min(' + V('qv-largura-desk', '880px') + ',94vw);max-height:' + V('qv-altura-max-desk', '88vh') + ';border-radius:' + V('qv-raio-desk', '12px') + ';display:grid;grid-template-columns:minmax(0,5fr) minmax(0,6fr);grid-template-rows:auto minmax(0,1fr) auto;grid-template-areas:"gal cab" "gal inf" "gal pe"}',
    P + 'alca{display:none}',
    P + 'cab{grid-area:cab;grid-template-columns:1fr auto}',
    P + 'rolagem{display:contents}',
    P + 'gal{grid-area:gal;margin:0;display:block;min-height:0;overflow-y:auto;background:#f7f7f7;padding:0 0 8px}',
    P + 'trilho{padding:0;scroll-padding-left:0;gap:0}',
    P + 'palco{align-self:start}',
    P + 'quadro{flex:0 0 100%}',
    P + 'conta{display:block;position:absolute;right:8px;bottom:8px;padding:2px 8px;border-radius:999px;background:rgba(0,0,0,.45);color:#fff;font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums;pointer-events:none}',
    P + 'minis{display:flex;gap:6px;margin:8px 8px 0;overflow-x:auto;scrollbar-width:none}',
    R + 'button' + P + 'mini{position:relative;overflow:hidden;flex:none;width:44px;height:56px;margin:0;padding:0;border:1px solid transparent;border-radius:0;background:none;cursor:pointer;-webkit-appearance:none;appearance:none}',
    R + 'button' + P + 'mini[aria-current="true"]{border-color:' + texto + '}',
    R + P + 'mini img{position:absolute;top:0;right:0;bottom:0;left:0;display:block;width:100%;max-width:none;height:100%;max-height:none;object-fit:cover;object-position:50% 20%}',  // QA 3.3: preenche a moldura 44x56 mesmo com foto quadrada
    P + 'inf{grid-area:inf;overflow-y:auto;overscroll-behavior:contain;padding:14px ' + pad + ' 6px}',
    P + 'pe{grid-area:pe}',
    // v15: no desktop o modal entra e sai com fade e uma leve escala
    P + 'painel{animation:tg-busca-qv-entra .24s ease}',
    P + 'raiz' + P + 'saindo ' + P + 'painel{animation:tg-busca-qv-sai .2s ease-in forwards}',
    P + 'painel-conj{display:flex;flex-direction:column;width:min(' + V('qv-conj-largura-desk', '560px') + ',94vw)}',
    P + 'painel-conj ' + P + 'rolagem{display:block;flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:0 ' + pad + ' 8px}',
    '}',
    // movimento reduzido: nada anima (fica depois do bloco do desktop para valer sobre ele); o JS tambem tira o modal na hora
    '@media (prefers-reduced-motion:reduce){' + P + 'painel,' + P + 'fundo,' + P + 'virando,' + P + 'aviso,' + P + 'lupa,' + P + 'raiz' + P + 'saindo ' + P + 'painel,' + P + 'saindo ' + P + 'fundo{animation:none}' +
      P + 'acc-gaveta,' + P + 'acc-gaveta' + P + 'acc-aberta,' + P + 'painel-pe-flutua ' + P + 'pe,' + P + 'painel-pe-flutua ' + P + 'pe' + P + 'pe-oculto{transition:none}}'
  ].join('\n');
}

var TG_QV_CSS = tgQvMontarCss();

function tgQvEstilos() {
  if (document.getElementById('tg-busca-qv-estilos')) { return; }
  document.head.appendChild(el('style', { id: 'tg-busca-qv-estilos' }, [TG_QV_CSS]));
}

// ---------------------------------------------------------------- medicao (sem dado pessoal: so origem, posicao e contagem)
function tgQvEmitir(S, nome, extra) {
  try {
    var ev = { page_type: S.origem }, k;
    if (extra) { for (k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) { ev[k] = extra[k]; } } }
    if (typeof emitir === 'function') { emitir(nome, ev); }
  } catch (e) {}
}

// ---------------------------------------------------------------- cores (irmaos)
function tgQvRotuloCor(item, lista) {
  var r, tk, i, j, comum = 0, base, outro;
  try {
    if (typeof tgModeloCor === 'function') { r = tgModeloCor(item.n); if (r && r.cor) { return String(r.cor); } }
  } catch (e) {}
  if (!lista || lista.length < 2 || typeof item.n !== 'string') { return ''; }
  base = item.n.split(/\s+/);
  comum = base.length;
  for (i = 0; i < lista.length; i++) {
    if (lista[i] === item || typeof lista[i].n !== 'string') { continue; }
    outro = lista[i].n.split(/\s+/);
    for (j = 0; j < comum && j < outro.length && base[j] === outro[j]; j++) {}
    comum = j;
  }
  tk = base.slice(comum).join(' ');
  return comum > 0 && tk ? tk : '';
}

function tgQvIrmaos(item, irmaos) {
  var out = [], vistos = {}, i, x, achou = false;
  if (Array.isArray(irmaos)) {
    for (i = 0; i < irmaos.length; i++) {
      x = irmaos[i];
      if (!x || typeof x !== 'object' || !urlProduto(x.s) || vistos[x.s]) { continue; }
      vistos[x.s] = true;
      if (x.s === item.s) { x = item; achou = true; }
      out.push(x);
    }
  }
  if (!achou) { out.unshift(item); }
  return out;
}

// ---------------------------------------------------------------- quick view
function tgQvNo(tag, classe, filhos, attrs) {
  var a = attrs || {};
  if (classe) { a['class'] = classe; }
  return el(tag, a, filhos || null);
}

function tgQvFocaveis(raiz) {
  var lista = raiz.querySelectorAll('button, a[href]'), out = [], i;
  for (i = 0; i < lista.length; i++) {
    if (lista[i].disabled || lista[i].getAttribute('aria-hidden') === 'true') { continue; }
    if (lista[i].closest && lista[i].closest('[aria-hidden="true"],[inert],[hidden]')) { continue; }
    if (lista[i].offsetParent === null && !(lista[i].getClientRects && lista[i].getClientRects().length)) { continue; }
    out.push(lista[i]);
  }
  return out;
}

// ---------------------------------------------------------------- v15 (revisao do Danilo, 25/11)
// Saida animada, Voltar entre as cores, troca de cor como pagina virando, foto ampliada e confirmacao da sacola dentro do modal.
var TG_QV_SAIDA_MS = 320;  // a saida anima ~220 ms; se o animationend nao vier, o modal sai assim mesmo neste tempo
var TG_QV_OK_MS = 2200;    // tempo do "Adicionada a sacola" no botao
var TG_QV_AVISO_MS = 6000; // tempo do aviso com "Ver sacola"
var TG_QV_HIST_MAX = 20;   // cores guardadas para o "Voltar"

function tgQvReduzido() {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
}

// Poe o modal na pagina. Se outro ainda esta saindo (animacao de fechar), o novo entra ANTES dele no DOM: o que sai some por cima e quem
// procura o modal (querySelector) acha o novo primeiro.
function tgQvPor(raiz) {
  var saindo = null;
  try { saindo = document.querySelector('.tg-busca-qv-saindo'); } catch (e) {}
  if (saindo && saindo.parentNode === document.body) { document.body.insertBefore(raiz, saindo); } else { document.body.appendChild(raiz); }
}

// Tira o modal da tela. Tudo que importa (foco, rolagem da pagina, aoFechar) ja aconteceu em tgQvFechar; aqui so a parte visual: o no perde o id
// e os ids internos na hora (outro modal ja pode abrir), nao recebe toque e sai no fim da animacao ou no tempo limite (o primeiro que vier).
function tgQvSair(S, animar) {
  var raiz = S && S.raiz, feito = false, ids, i;
  function tirar() { if (feito) { return; } feito = true; try { if (raiz && raiz.parentNode) { raiz.parentNode.removeChild(raiz); } } catch (e) {} }
  try {
    if (!raiz || !raiz.parentNode) { return; }
    if (!animar || tgQvReduzido()) { tirar(); return; }
    raiz.removeAttribute('id');
    ids = raiz.querySelectorAll('[id]');
    for (i = 0; i < ids.length; i++) { ids[i].removeAttribute('id'); }
    raiz.setAttribute('aria-hidden', 'true');
    raiz.classList.add('tg-busca-qv-saindo');
    S.painel.addEventListener('animationend', function (ev) { if (ev.target === S.painel) { tirar(); } });
    setTimeout(tirar, TG_QV_SAIDA_MS);
  } catch (e) { tirar(); }
}

function tgQvLimpar(S) {
  try { clearTimeout(S.tOk); clearTimeout(S.tAviso); clearTimeout(S.tVira); } catch (e) {}
  try { if (S.peIo) { S.peIo.disconnect(); } if (S.peIoFim) { S.peIoFim.disconnect(); } if (S.peRo) { S.peRo.disconnect(); } } catch (e) {}
  S.lupa = null;
}

// "Voltar" do cabecalho: so aparece depois que a cliente trocou de cor dentro do modal; cada toque volta uma cor, ate a original.
function tgQvAtualizarVoltar(S) {
  try {
    if (!S.bVoltar) { return; }
    if (S.historico && S.historico.length) { S.bVoltar.removeAttribute('hidden'); return; }
    if (document.activeElement === S.bVoltar) { try { S.painel.focus({ preventScroll: true }); } catch (e) {} }
    S.bVoltar.setAttribute('hidden', 'hidden');
  } catch (e) {}
}

function tgQvVoltar(S) {
  var alvo = null;
  if (S.fechado || S.ocupado || !S.historico) { return; }
  while (S.historico.length && (!alvo || alvo === S.item)) { alvo = S.historico.pop(); }
  if (!alvo || alvo === S.item) { tgQvAtualizarVoltar(S); return; }
  tgQvTrocarItem(S, alvo, true);
}

// Troca a peca mostrada (outra cor) sem fechar o modal: guarda a anterior para o "Voltar", vira a pagina e volta ao topo (a foto).
function tgQvTrocarItem(S, alvo, volta) {
  if (!alvo || alvo === S.item || S.ocupado || S.fechado) { return; }
  if (!volta) {
    S.historico.push(S.item);
    if (S.historico.length > TG_QV_HIST_MAX) { S.historico.shift(); }
  }
  S.item = alvo;
  S.confirmado = false;
  clearTimeout(S.tOk);
  tgQvAvisoFechar(S);
  tgQvEmitir(S, 'tg_qv_cor', { position: S.irmaos.indexOf(alvo), reason: volta ? 'voltar' : 'cor' });
  tgQvCarregar(S);
  tgQvPintar(S);
  tgQvAtualizarVoltar(S);
  tgQvVirar(S, volta);
  tgQvTopo(S);
}

// Pagina virando (foto e informacoes giram de leve e entram de lado, ~0,34 s); para tras no "Voltar". Sem animacao com movimento reduzido.
function tgQvVirar(S, volta) {
  var alvos = [S.gal, S.inf], i, n;
  if (tgQvReduzido()) { return; }
  try {
    clearTimeout(S.tVira);
    for (i = 0; i < alvos.length; i++) {
      n = alvos[i];
      if (!n) { continue; }
      n.classList.remove('tg-busca-qv-virando');
      n.classList.remove('tg-busca-qv-virando-volta');
      void n.offsetWidth;
      n.classList.add('tg-busca-qv-virando');
      if (volta) { n.classList.add('tg-busca-qv-virando-volta'); }
    }
    S.tVira = setTimeout(function () {
      for (i = 0; i < alvos.length; i++) { if (alvos[i]) { alvos[i].classList.remove('tg-busca-qv-virando'); alvos[i].classList.remove('tg-busca-qv-virando-volta'); } }
    }, 450);
  } catch (e) {}
}

// Volta a rolagem do modal ao topo (a foto). No celular rola o corpo; no desktop, as colunas da foto e das informacoes.
function tgQvTopo(S) {
  var caixas = [S.rolagem, S.gal, S.inf], suave = !tgQvReduzido(), i, c;
  for (i = 0; i < caixas.length; i++) {
    c = caixas[i];
    if (!c || !c.scrollTop) { continue; }
    try { c.scrollTo({ top: 0, behavior: suave ? 'smooth' : 'auto' }); } catch (e) { try { c.scrollTop = 0; } catch (e2) {} }
  }
}

// Foto ampliada (toque/clique na foto): fundo escuro sobre tudo, foto inteira (contain), passa as fotos com o dedo (celular) ou com as setas e o
// teclado (desktop), contador, x e Esc. O foco vai para o x e volta para a foto que estiver na tela ao fechar.
function tgQvLupaAbrir(S, fotos, k, origem, aoFechar) {
  var lupa = null, trilho, conta = null, bAnt = null, bProx = null, bFechar, n = fotos ? fotos.length : 0, raf = 0, atual = 0;
  try {
    if (S.fechado || !n) { return; }
    if (S.lupa) { tgQvLupaFechar(S); }
    trilho = tgQvNo('div', 'tg-busca-qv-lupa-trilho');
    fotos.forEach(function (u, i) {
      trilho.appendChild(tgQvNo('div', 'tg-busca-qv-lupa-quadro', [el('img', { src: u, alt: 'Foto ' + (i + 1) + ' de ' + n + ': ' + S.item.n, decoding: 'async', loading: Math.abs(i - k) < 2 ? 'eager' : 'lazy' })]));
    });
    bFechar = tgQvNo('button', 'tg-busca-qv-lupa-fechar', ['×'], { type: 'button', 'aria-label': 'Fechar fotos' });
    if (n > 1) {
      conta = tgQvNo('p', 'tg-busca-qv-lupa-conta', null, { 'aria-live': 'polite' });
      bAnt = tgQvNo('button', 'tg-busca-qv-lupa-ant', null, { type: 'button', 'aria-label': 'Foto anterior' });
      bProx = tgQvNo('button', 'tg-busca-qv-lupa-prox', null, { type: 'button', 'aria-label': 'Próxima foto' });
    }
    lupa = tgQvNo('div', 'tg-busca-qv-lupa', [trilho, conta, bAnt, bProx, bFechar], { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Fotos ampliadas: ' + S.item.n });
    function largura() { return trilho.clientWidth || 1; }
    function marcar() {
      atual = Math.min(Math.max(Math.round(trilho.scrollLeft / largura()), 0), n - 1);
      if (conta) { conta.textContent = (atual + 1) + ' / ' + n; }
    }
    function ir(i, suave) {
      i = ((i % n) + n) % n;
      try { trilho.scrollTo({ left: i * largura(), behavior: suave && !tgQvReduzido() ? 'smooth' : 'auto' }); } catch (e) { trilho.scrollLeft = i * largura(); }
      if (!suave) { marcar(); }
    }
    trilho.addEventListener('scroll', function () {
      if (raf) { return; }
      raf = (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(function () { raf = 0; marcar(); });
    }, { passive: true });
    // tocar no escuro (fora da foto) tambem fecha
    trilho.addEventListener('click', function (ev) { if (ev.target && ev.target.tagName !== 'IMG') { tgQvLupaFechar(S); } });
    bFechar.addEventListener('click', function () { tgQvLupaFechar(S); });
    if (bAnt) { bAnt.addEventListener('click', function () { ir(atual - 1, true); }); }
    if (bProx) { bProx.addEventListener('click', function () { ir(atual + 1, true); }); }
    S.lupa = { no: lupa, passo: function (d) { ir(atual + d, true); }, atual: function () { return atual; }, origem: origem, aoFechar: aoFechar };
    S.painel.setAttribute('aria-hidden', 'true');
    S.raiz.appendChild(lupa);
    ir(k, false);
    try { bFechar.focus({ preventScroll: true }); } catch (e) {}
    tgQvEmitir(S, 'tg_qv_foto', { position: k });
  } catch (e) {
    try { if (lupa && lupa.parentNode) { lupa.parentNode.removeChild(lupa); } } catch (e2) {}
    S.lupa = null;
    try { S.painel.removeAttribute('aria-hidden'); } catch (e3) {}
  }
}

function tgQvLupaFechar(S) {
  var L = S.lupa, i = 0, alvo = null;
  if (!L) { return; }
  S.lupa = null;
  try { i = L.atual(); } catch (e) {}
  try { if (L.no.parentNode) { L.no.parentNode.removeChild(L.no); } } catch (e) {}
  try { S.painel.removeAttribute('aria-hidden'); } catch (e) {}
  try { if (typeof L.aoFechar === 'function') { alvo = L.aoFechar(i); } } catch (e) {}
  alvo = alvo || L.origem;
  try { if (alvo && document.contains(alvo)) { alvo.focus({ preventScroll: true }); } else { S.painel.focus({ preventScroll: true }); } } catch (e) {}
}

// Setas com a foto ampliada aberta passam as fotos. Esc (fecha so a foto) e Tab (fica dentro da foto ampliada) estao no teclado do modal.
function tgQvLupaSetas(S, ev) {
  var L = S.lupa;
  if (!L) { return false; }
  if (ev.key === 'ArrowLeft' || ev.keyCode === 37) { L.passo(-1); return true; }
  if (ev.key === 'ArrowRight' || ev.keyCode === 39) { L.passo(1); return true; }
  return false;
}

// Sacola (v15): o modal fica aberto e confirma ali mesmo. O botao vira "Adicionada a sacola" com check por ~2 s e um aviso discreto oferece
// "Ver sacola" (o aviso fica numa regiao role=status que ja existe, para o leitor de tela anunciar).
function tgQvConfirmar(S) {
  S.confirmado = true;
  tgQvAtualizarRodape(S);
  clearTimeout(S.tOk);
  S.tOk = setTimeout(function () {
    if (S.fechado || !S.confirmado) { return; }
    var foco = document.activeElement === S.bAdd;
    S.confirmado = false;
    tgQvAtualizarRodape(S);
    if (foco) { try { S.bAdd.focus({ preventScroll: true }); } catch (e) {} }
  }, TG_QV_OK_MS);
  tgQvAvisoMostrar(S);
}

function tgQvAvisoMostrar(S) {
  var ver;
  try {
    if (!S.aviso) { return; }
    clearTimeout(S.tAviso);
    S.aviso.textContent = '';
    ver = tgQvNo('button', 'tg-busca-qv-aviso-ver', ['Ver sacola'], { type: 'button' });
    ver.addEventListener('click', function () { tgQvVerSacola(S); });
    S.aviso.appendChild(tgQvNo('p', 'tg-busca-qv-aviso-txt', ['Peça adicionada à sacola']));
    S.aviso.appendChild(ver);
    S.aviso.removeAttribute('hidden');
    S.tAviso = setTimeout(function () { tgQvAvisoFechar(S); }, TG_QV_AVISO_MS);
  } catch (e) {}
}

function tgQvAvisoFechar(S) {
  try {
    clearTimeout(S.tAviso);
    if (!S.aviso || S.aviso.hasAttribute('hidden')) { return; }
    if (S.aviso.contains(document.activeElement)) { try { S.bAdd.focus({ preventScroll: true }); } catch (e) {} }
    S.aviso.setAttribute('hidden', 'hidden');
    S.aviso.textContent = '';
  } catch (e) {}
}

// "Ver sacola": fecha o modal e, se a busca (overlay #tg-busca-overlay) estiver aberta, fecha a busca tambem; so entao abre a sacola do tema.
// Causa do "nada acontece" na busca inicial (25/11): la o modal abre dentro do overlay da busca (z-index alto) e a sacola do tema abria ATRAS dele.
function tgQvVerSacola(S) {
  var ov = null, espera = 80;
  tgQvEmitir(S, 'tg_qv_ver_sacola');
  tgQvSacolaPedida = Date.now();
  try { ov = document.querySelector('#tg-busca-overlay.tg-busca-aberto'); } catch (e) {}
  tgQvFechar('sacola');
  if (ov) {
    try { if (typeof tgOvFechar === 'function') { tgOvFechar(); espera = 450; } } catch (e) {}
  }
  setTimeout(tgAbrirSacolaDoTema, espera);
}

function tgQvFechar(motivo) {
  var S = tgQvAtivo;
  if (!S) { return; }
  tgQvAtivo = null;
  S.fechado = true;
  try { if (motivo !== 'voltar' && motivo !== 'trocou' && typeof tgHistFechar === 'function') { tgHistFechar('modal'); } } catch (e) {}
  try { document.removeEventListener('keydown', S.teclas, true); } catch (e) {}
  try { tgQvLimpar(S); } catch (e) {}
  // trocar de modal (ou falha) tira na hora; os demais motivos saem animados (deslizando no celular, fade + escala no desktop)
  tgQvSair(S, motivo !== 'trocou' && motivo !== 'erro');
  try { document.body.style.overflow = S.overflowCorpo; document.documentElement.style.overflow = S.overflowHtml; } catch (e) {}
  try { if (S.foco && S.foco.focus && document.contains(S.foco)) { S.foco.focus({ preventScroll: true }); } } catch (e) {}
  try { if (typeof S.opcoes.aoFechar === 'function') { S.opcoes.aoFechar(motivo || 'fechar'); } } catch (e) {}
}

function tgQuickViewAbrir(item, opcoes) {
  var S, raiz, fundo, painel, cab, titulo, bFechar, bVoltar, rolagem, gal, inf, pe, bAdd, aPagina;
  try {
    if (!item || typeof item !== 'object' || !urlProduto(item.s)) { return; }
    opcoes = opcoes && typeof opcoes === 'object' ? opcoes : {};
    if (tgQvAtivo) { tgQvFechar('trocou'); }
    tgQvEstilos();
    S = {
      item: item, opcoes: opcoes, irmaos: tgQvIrmaos(item, opcoes.irmaos), dados: null, erro: null, carregando: true, seq: 0,
      tam: typeof opcoes.tamanhoInicial === 'string' ? opcoes.tamanhoInicial : null, msg: '', msgErro: false, ocupado: false,
      origem: typeof opcoes.origem === 'string' && /^[a-z0-9_-]{1,30}$/.test(opcoes.origem) ? opcoes.origem : 'qv',
      foco: document.activeElement, overflowCorpo: document.body.style.overflow, overflowHtml: document.documentElement.style.overflow,
      botoesTam: [], fechado: false, historico: [], confirmado: false
    };
    tgQvAtivo = S;
    // QA 4.4 (25/11): o Voltar do celular fecha so o modal (a busca continua aberta atras)
    try { if (typeof tgHistAbrir === "function" && !(tgHistPilha && tgHistPilha.length && tgHistPilha[tgHistPilha.length - 1].tipo === "modal")) { tgHistAbrir("modal", function () { tgQvFechar("voltar"); }); } } catch (e) {}

    raiz = tgQvNo('div', 'tg-busca-qv-raiz', null, { id: 'tg-busca-qv' });
    fundo = tgQvNo('div', 'tg-busca-qv-fundo');
    painel = tgQvNo('div', 'tg-busca-qv-painel', null, { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tg-busca-qv-titulo' });
    painel.setAttribute('tabindex', '-1');
    // Como o modal da pagina Influenciadoras: rotulo no cabecalho; nome, preco, cores e descricao no corpo; peca, tamanhos e botao no rodape fixo.
    titulo = tgQvNo('h2', 'tg-busca-qv-titulo', [item.n], { id: 'tg-busca-qv-titulo' });
    bFechar = tgQvNo('button', 'tg-busca-qv-fechar', ['×'], { type: 'button', 'aria-label': 'Fechar' });
    // v15: "Voltar" antes do rotulo, escondido ate a cliente trocar de cor dentro do modal
    bVoltar = tgQvNo('button', 'tg-busca-qv-voltar', ['Voltar'], { type: 'button', 'aria-label': 'Voltar para a cor anterior' });
    bVoltar.setAttribute('hidden', 'hidden');
    cab = tgQvNo('div', 'tg-busca-qv-cab', [tgQvNo('div', 'tg-busca-qv-alca', [el('span')]), tgQvNo('div', 'tg-busca-qv-cab-esq', [bVoltar, tgQvNo('p', 'tg-busca-qv-cab-rotulo', ['Detalhes da peça'])]), bFechar]);
    gal = tgQvNo('div', 'tg-busca-qv-gal');
    inf = tgQvNo('div', 'tg-busca-qv-inf');
    rolagem = tgQvNo('div', 'tg-busca-qv-rolagem', [gal, inf]);
    bAdd = tgQvNo('button', 'tg-busca-qv-add', ['Adicionar à sacola'], { type: 'button' });
    aPagina = tgQvNo('a', 'tg-busca-qv-pagina', ['Ver página completa'], { href: urlProduto(item.s) });
    S.pePeca = tgQvNo('div', 'tg-busca-qv-pe-peca');
    S.peTam = tgQvNo('div', 'tg-busca-qv-pe-tam');
    // aviso da sacola ("Peca adicionada" + "Ver sacola"): regiao role=status criada vazia para o leitor de tela anunciar quando encher
    S.aviso = tgQvNo('div', 'tg-busca-qv-aviso', null, { role: 'status', 'aria-live': 'polite' });
    S.aviso.setAttribute('hidden', 'hidden');
    pe = tgQvNo('div', 'tg-busca-qv-pe', [S.aviso, S.pePeca, S.peTam, bAdd]);
    painel.appendChild(cab); painel.appendChild(rolagem); painel.appendChild(pe);
    raiz.appendChild(fundo); raiz.appendChild(painel);
    S.raiz = raiz; S.painel = painel; S.titulo = titulo; S.gal = gal; S.inf = inf; S.bAdd = bAdd; S.aPagina = aPagina; S.bFechar = bFechar; S.bVoltar = bVoltar; S.pe = pe; S.rolagem = rolagem;

    fundo.addEventListener('click', function () { tgQvFechar('fundo'); });
    bFechar.addEventListener('click', function () { tgQvFechar('botao'); });
    bAdd.addEventListener('click', function () { tgQvAdicionar(S); });
    bVoltar.addEventListener('click', function () { tgQvVoltar(S); });
    aPagina.addEventListener('click', function () { tgQvEmitir(S, 'tg_qv_ver_pagina'); });
    S.teclas = function (ev) {
      var f, a;
      if (S.fechado) { return; }
      if (S.lupa && tgQvLupaSetas(S, ev)) { return; }
      if (ev.key === 'Escape' || ev.keyCode === 27) { ev.preventDefault(); ev.stopPropagation(); if (S.lupa) { tgQvLupaFechar(S); return; } tgQvFechar('esc'); return; }
      if (ev.key === 'Tab' || ev.keyCode === 9) {
        f = tgQvFocaveis(S.lupa ? S.lupa.no : S.painel);
        if (!f.length) { ev.preventDefault(); return; }
        a = document.activeElement;
        if (!(S.lupa ? S.lupa.no : S.painel).contains(a)) { ev.preventDefault(); f[0].focus(); return; }
        if (a === S.painel) { ev.preventDefault(); (ev.shiftKey ? f[f.length - 1] : f[0]).focus(); return; }
        if (ev.shiftKey && a === f[0]) { ev.preventDefault(); f[f.length - 1].focus(); } else if (!ev.shiftKey && a === f[f.length - 1]) { ev.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener('keydown', S.teclas, true);
    tgQvArrastar(S, cab);

    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    tgQvPor(raiz);
    try { painel.focus({ preventScroll: true }); } catch (e) {}
    tgQvEmitir(S, 'tg_qv_abrir', { position: S.irmaos.indexOf(item), results_count: S.irmaos.length });
    tgQvPeIniciar(S);
    tgQvPintar(S);
    tgQvCarregar(S);
  } catch (e) {
    try { tgQvFechar('erro'); } catch (e2) {}
    try { if (item && urlProduto(item.s) && typeof window !== 'undefined') { window.location.assign(urlProduto(item.s)); } } catch (e3) {}
  }
}

// Busca as variantes do item atual e repinta. Resposta velha (outra cor ja escolhida) e ignorada.
function tgQvCarregar(S) {
  var meu = ++S.seq, item = S.item;
  S.dados = null; S.erro = null; S.carregando = true;
  tgVariantesDoProduto(item).then(function (d) {
    var i, t, ini;
    if (S.fechado || meu !== S.seq) { return; }
    S.carregando = false;
    if (!d || !d.ok || !d.tamanhos || !d.tamanhos.length) { S.erro = d && d.motivo ? d.motivo : 'erro'; S.dados = null; tgQvPintar(S); return; }
    S.dados = d;
    // tamanho: mantem o escolhido se existe e esta disponivel nesta cor; senao o inicial pedido; senao nenhum
    ini = S.tam; S.tam = null; S.msg = ''; S.msgErro = false;
    if (ini) {
      for (i = 0; i < d.tamanhos.length; i++) {
        t = d.tamanhos[i];
        if (t.rotulo.toUpperCase() === ini.toUpperCase()) {
          if (t.disponivel) { S.tam = t.rotulo; } else { S.msg = 'O tamanho ' + t.rotulo + ' não está disponível nesta cor.'; }
        }
      }
    }
    tgQvPintar(S);
  });
}

function tgQvPreco(S) {
  var d = S.dados, p, de, pr;
  if (d && d.preco) { p = d.preco; de = d.precoDe; } else {
    pr = precoFinal(S.item);
    if (!pr) { return null; }
    p = pr.final; de = pr.de;
  }
  return tgQvNo('p', 'tg-busca-qv-preco', [el('strong', null, [reais(p)]), de ? el('s', null, [reais(de)]) : null]);
}

function tgQvPintarGaleria(S) {
  var fotos = S.dados && S.dados.fotos && S.dados.fotos.length ? S.dados.fotos : (urlImagem(S.item.i) ? [urlImagem(S.item.i)] : []);
  var trilho, palco, quadros = [], minis = [], conta = null, minisBox = null, i, atual = 0, raf = 0;
  S.gal.textContent = '';
  if (!fotos.length) { S.gal.style.display = 'none'; return; }
  S.gal.style.display = '';
  trilho = tgQvNo('div', 'tg-busca-qv-trilho' + (fotos.length === 1 ? ' tg-busca-qv-trilho-uma' : ''), null, { role: 'group', 'aria-label': 'Fotos de ' + S.item.n });
  fotos.forEach(function (u, k) {
    // v15: tocar/clicar na foto abre a foto ampliada (fundo escuro, foto inteira); ao fechar, a galeria fica na foto que estava na tela
    var q = tgQvNo('button', 'tg-busca-qv-quadro', [el('img', { src: u, alt: k === 0 ? S.item.n : '', loading: k < 2 ? 'eager' : 'lazy', decoding: 'async' })], { type: 'button', 'aria-label': 'Ampliar foto ' + (k + 1) + ' de ' + fotos.length });
    q.addEventListener('click', function () {
      tgQvLupaAbrir(S, fotos, k, q, function (i) {
        if (!quadros[i]) { return null; }
        try { trilho.scrollLeft = quadros[i].offsetLeft - quadros[0].offsetLeft; } catch (e) {}
        return quadros[i];
      });
    });
    quadros.push(q); trilho.appendChild(q);
  });
  palco = tgQvNo('div', 'tg-busca-qv-palco', [trilho]);
  S.gal.appendChild(palco);
  if (fotos.length > 1) {
    conta = tgQvNo('span', 'tg-busca-qv-conta', ['1 / ' + fotos.length], { 'aria-hidden': 'true' });
    palco.appendChild(conta);
    minisBox = tgQvNo('div', 'tg-busca-qv-minis');
    fotos.forEach(function (u, k) {
      var b = tgQvNo('button', 'tg-busca-qv-mini', [el('img', { src: u, alt: '', loading: 'lazy', width: '44', height: '56' })], { type: 'button', 'aria-label': 'Foto ' + (k + 1) + ' de ' + fotos.length });
      if (k === 0) { b.setAttribute('aria-current', 'true'); }
      b.addEventListener('click', function () {
        try { trilho.scrollTo({ left: quadros[k].offsetLeft - quadros[0].offsetLeft, behavior: 'smooth' }); } catch (e) { trilho.scrollLeft = quadros[k].offsetLeft - quadros[0].offsetLeft; }
      });
      minis.push(b); minisBox.appendChild(b);
    });
    S.gal.appendChild(minisBox);
    trilho.addEventListener('scroll', function () {
      if (raf) { return; }
      raf = (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(function () {
        var passo = quadros[0].offsetWidth + 6, k;
        raf = 0;
        if (passo <= 0) { return; }
        k = Math.min(Math.max(Math.round(trilho.scrollLeft / passo), 0), fotos.length - 1);
        if (k === atual) { return; }
        atual = k;
        conta.textContent = (k + 1) + ' / ' + fotos.length;
        for (i = 0; i < minis.length; i++) { if (i === k) { minis[i].setAttribute('aria-current', 'true'); } else { minis[i].removeAttribute('aria-current'); } }
      });
    }, { passive: true });
  }
}

function tgQvPintarTamanhos(S) {
  var d = S.dados, caixa, i, t, b, algum = false;
  S.botoesTam = [];
  if (S.carregando) {
    return tgQvNo('div', 'tg-busca-qv-esq', [el('i'), el('i'), el('i'), el('i'), el('i')], { role: 'status', 'aria-label': 'Carregando tamanhos' });
  }
  if (!d) { return null; }
  caixa = tgQvNo('div', 'tg-busca-qv-tamanhos', null, { role: 'group', 'aria-label': 'Tamanho' });
  for (i = 0; i < d.tamanhos.length; i++) {
    t = d.tamanhos[i];
    b = tgQvNo('button', 'tg-busca-qv-tam' + (t.disponivel ? '' : ' tg-busca-qv-tam-esg'), [t.rotulo], { type: 'button', 'aria-pressed': S.tam === t.rotulo ? 'true' : 'false', 'data-tamanho': t.rotulo });
    if (!t.disponivel) { b.setAttribute('aria-disabled', 'true'); b.setAttribute('aria-label', t.rotulo + ', esgotado'); } else { algum = true; }
    (function (tt, idx) {
      b.addEventListener('click', function () {
        if (!tt.disponivel || S.ocupado) { return; }
        if (S.confirmado) { S.confirmado = false; clearTimeout(S.tOk); }
        S.tam = S.tam === tt.rotulo ? null : tt.rotulo;
        S.msg = ''; S.msgErro = false;
        if (S.tam) { tgQvEmitir(S, 'tg_qv_tamanho', { position: idx }); }
        tgQvAtualizarEscolha(S);
      });
    })(t, i);
    S.botoesTam.push(b); caixa.appendChild(b);
  }
  S.algumDisponivel = algum;
  return caixa;
}

// Marca o tamanho escolhido sem repintar a tela (a rolagem e o foco ficam onde estao).
function tgQvAtualizarEscolha(S) {
  var i, t;
  if (S.dados) {
    for (i = 0; i < S.botoesTam.length; i++) {
      t = S.dados.tamanhos[i];
      S.botoesTam[i].setAttribute('aria-pressed', S.tam === t.rotulo ? 'true' : 'false');
    }
  }
  if (S.rotuloTam) { S.rotuloTam.textContent = S.tam ? ': ' + S.tam : ''; }
  tgQvAtualizarRodape(S);
}

function tgQvAtualizarRodape(S) {
  var d = S.dados, pronto = !!(d && S.tam), esgotada = !!(d && !S.algumDisponivel), texto;
  // falha ao ler a pagina: o link da pagina vira o botao principal do rodape; senao fica discreto no fim do corpo
  if (S.erro) { S.bAdd.style.display = 'none'; S.aPagina.setAttribute('class', 'tg-busca-qv-pagina tg-busca-qv-pagina-prim'); if (S.pe && S.aPagina.parentNode !== S.pe) { S.pe.appendChild(S.aPagina); } } else {
    S.bAdd.style.display = '';
    S.aPagina.setAttribute('class', 'tg-busca-qv-pagina');
    if (S.inf && S.aPagina.parentNode !== S.inf) { S.inf.appendChild(S.aPagina); }
  }
  if (S.ocupado) { texto = 'Adicionando…'; } else if (S.confirmado) { texto = 'Adicionada à sacola'; } else if (esgotada) { texto = 'Peça esgotada nesta cor'; } else { texto = 'Adicionar à sacola'; }
  S.bAdd.textContent = texto;
  if (S.confirmado && !S.ocupado) { S.bAdd.classList.add('tg-busca-qv-add-ok'); } else { S.bAdd.classList.remove('tg-busca-qv-add-ok'); }
  if (d && S.algumDisponivel && !S.ocupado) { S.bAdd.removeAttribute('disabled'); S.bAdd.removeAttribute('aria-disabled'); } else { S.bAdd.setAttribute('disabled', 'disabled'); S.bAdd.setAttribute('aria-disabled', 'true'); }
  if (S.msgEl) {
    // sem dica fixa: o botao fica ativo e, se a cliente tocar sem tamanho, a mensagem pede o tamanho (o rodape fica mais baixo)
    S.msgEl.textContent = S.msg || '';
    S.msgEl.setAttribute('class', 'tg-busca-qv-msg' + (S.msgErro ? ' tg-busca-qv-msg-erro' : ''));
  }
  try { S.aPagina.setAttribute('href', urlProduto(S.item.s)); } catch (e) {}
}

// "R$ 350,55 no Pix" e "ou 5x de R$ 73,80 sem juros", lidos da pagina da peca (so aparecem depois que ela chega).
function tgQvLinhaParcelas(S) {
  var d = S.dados, linhas = [];
  if (!d) { return null; }
  if (d.pix) { linhas.push(tgQvNo('p', 'tg-busca-qv-parc', [el('b', null, [reais(d.pix)]), ' no Pix'])); }
  if (d.parcelas) { linhas.push(tgQvNo('p', 'tg-busca-qv-parc', ['ou ' + d.parcelas.n + 'x de ' + reais(d.parcelas.v) + ' sem juros'])); }
  return linhas.length ? tgQvNo('div', 'tg-busca-qv-parcs', linhas) : null;
}

// Destaques (ate 3, sempre visiveis) e Descricao / Detalhes da peca recolhidos, como na pagina Influenciadoras. So texto.
function tgQvPintarDescricao(S) {
  var ds = S.dados && S.dados.descricao, lista, accs, i, x, corpo, dl;
  if (!ds) { return; }
  if (ds.destaques.length) {
    lista = tgQvNo('ul', 'tg-busca-qv-dest');
    for (i = 0; i < ds.destaques.length && i < 3; i++) {
      x = ds.destaques[i];
      lista.appendChild(el('li', null, [x.rotulo ? el('b', null, [x.rotulo + ':']) : null, x.rotulo ? ' ' : null, x.texto]));
    }
    S.inf.appendChild(lista);
  }
  accs = tgQvNo('div', 'tg-busca-qv-accs');
  if (ds.intro.length) {
    corpo = tgQvNo('div', 'tg-busca-qv-acc-corpo');
    for (i = 0; i < ds.intro.length; i++) { corpo.appendChild(tgQvNo('p', 'tg-busca-qv-texto', [ds.intro[i]])); }
    accs.appendChild(tgQvSanfona(S, 'Descrição', corpo, 'desc'));
  }
  if (ds.ficha.length) {
    dl = tgQvNo('dl', 'tg-busca-qv-acc-corpo');
    for (i = 0; i < ds.ficha.length; i++) { dl.appendChild(tgQvNo('div', 'tg-busca-qv-ficha', [el('dt', null, [ds.ficha[i].rotulo || '—']), el('dd', null, [ds.ficha[i].texto])])); }
    accs.appendChild(tgQvSanfona(S, 'Detalhes da peça', dl, 'ficha'));
  }
  if (accs.firstChild) { S.inf.appendChild(accs); }
}

// Bloco recolhivel em gaveta (v15): a altura anima de 0 ao conteudo (grid-template-rows 0fr -> 1fr, classe tg-busca-qv-acc-aberta). Fechado, o
// conteudo fica com visibility:hidden (fora do leitor de tela e do Tab); o botao anuncia o estado por aria-expanded.
function tgQvSanfona(S, titulo, corpo, chave) {
  var id = 'tg-busca-qv-acc-' + chave, aberto = !!(S.abertos && S.abertos[chave]), bt, caixa, gaveta;
  corpo.setAttribute('id', id);
  gaveta = tgQvNo('div', 'tg-busca-qv-acc-gaveta' + (aberto ? ' tg-busca-qv-acc-aberta' : ''), [tgQvNo('div', 'tg-busca-qv-acc-dentro', [corpo])]);
  bt = tgQvNo('button', 'tg-busca-qv-acc-bt', [titulo], { type: 'button', 'aria-expanded': aberto ? 'true' : 'false', 'aria-controls': id });
  bt.addEventListener('click', function () {
    var abrir = bt.getAttribute('aria-expanded') !== 'true';
    bt.setAttribute('aria-expanded', abrir ? 'true' : 'false');
    if (abrir) { gaveta.classList.add('tg-busca-qv-acc-aberta'); } else { gaveta.classList.remove('tg-busca-qv-acc-aberta'); }
    S.abertos = S.abertos || {};
    S.abertos[chave] = abrir;
    if (abrir) { tgQvEmitir(S, 'tg_qv_detalhes', { reason: chave }); }
  });
  caixa = tgQvNo('div', 'tg-busca-qv-acc', [bt, gaveta]);
  return caixa;
}

// Rodape: miniatura, nome e preco da peca atual (a cliente ve o que vai para a sacola em qualquer ponto da rolagem).
function tgQvPintarPePeca(S) {
  var d = S.dados, foto = urlImagem(S.item.i), p = d && d.preco ? d.preco : (precoFinal(S.item) || {}).final, info;
  S.pePeca.textContent = '';
  if (foto) { S.pePeca.appendChild(tgFotoReserva(el('img', { src: urlImagemLeve(S.item.i, 100), alt: '', width: '40', height: '50', decoding: 'async' }), foto)); }
  info = tgQvNo('div', 'tg-busca-qv-pe-inf', [
    tgQvNo('p', 'tg-busca-qv-pe-nome', [S.item.n]),
    p ? tgQvNo('p', 'tg-busca-qv-pe-preco', [reais(p), d && d.parcelas ? el('span', null, [d.parcelas.n + 'x sem juros']) : null]) : null
  ]);
  S.pePeca.appendChild(info);
}

function tgQvPintar(S) {
  var d = S.dados, cores, nomeCor, rot, lista, i, x, b, idx, tams, foco = null, focoCor = null, ativo;
  if (S.fechado) { return; }
  ativo = document.activeElement;
  if (ativo && ativo.getAttribute && S.inf.contains(ativo)) { focoCor = ativo.getAttribute('data-qv-cor'); }
  tgQvPintarGaleria(S);
  S.inf.textContent = '';
  // nome da peca com a bolinha da cor (como na pagina Influenciadoras), preco e parcelamento
  nomeCor = d && d.cor ? d.cor : tgQvRotuloCor(S.item, S.irmaos);
  S.titulo.textContent = '';
  S.titulo.appendChild(el('span', null, [S.item.n]));
  if (nomeCor && typeof tgCorSlug === 'function' && tgCorSlug(nomeCor) !== 'outro') {
    S.titulo.appendChild(el('span', { 'class': 'tg-busca-bolinha tg-busca-qv-bolinha', 'data-cor': tgCorSlug(nomeCor), role: 'img', 'aria-label': 'Cor: ' + nomeCor }));
  }
  S.inf.appendChild(S.titulo);
  rot = tgQvPreco(S);
  if (rot) { S.inf.appendChild(rot); }
  rot = tgQvLinhaParcelas(S);
  if (rot) { S.inf.appendChild(rot); }
  // v15: marca do fim do bloco de preco (preco, Pix, parcelas): o rodape fixo so aparece quando a rolagem passa dela
  if (S.peIo) { S.marcaPreco = tgQvNo('div', 'tg-busca-qv-marca', null, { 'aria-hidden': 'true' }); S.inf.appendChild(S.marcaPreco); tgQvPeMarcar(S); }
  // cores (irmaos) e rotulo da cor atual
  if (S.irmaos.length > 1) {
    S.inf.appendChild(tgQvNo('p', 'tg-busca-qv-rotulo', ['Cor', nomeCor ? el('span', null, [': ' + nomeCor]) : null]));
    cores = tgQvNo('div', 'tg-busca-qv-cores', null, { role: 'group', 'aria-label': 'Cor' });
    for (i = 0; i < S.irmaos.length; i++) {
      x = S.irmaos[i];
      lista = tgQvRotuloCor(x, S.irmaos) || x.n;
      b = tgQvNo('button', 'tg-busca-qv-cor' + (Array.isArray(x.sz) && !x.sz.length ? ' tg-busca-qv-cor-esg' : ''), [urlImagem(x.i) ? tgFotoReserva(el('img', { src: urlImagemLeve(x.i, 320), alt: '', loading: 'lazy', decoding: 'async' }), urlImagem(x.i)) : tgQvNo('span', 'tg-busca-qv-cor-sem'), tgQvNo('span', 'tg-busca-qv-cor-nome', [(lista || x.n) + (Array.isArray(x.sz) && !x.sz.length ? ' (esgotada)' : '')], { 'aria-hidden': 'true' })], {
        type: 'button', 'aria-pressed': x === S.item ? 'true' : 'false', 'aria-label': 'Cor ' + lista, 'data-qv-cor': x.s
      });
      (function (alvo, pos) {
        b.addEventListener('click', function () { tgQvTrocarItem(S, alvo, false); });
        b.addEventListener('mouseenter', function () { tgQuickViewPrefetch(alvo); });
        b.addEventListener('focus', function () { tgQuickViewPrefetch(alvo); });
      })(x, i);
      cores.appendChild(b);
    }
    S.inf.appendChild(cores);
  } else if (nomeCor) {
    S.inf.appendChild(tgQvNo('p', 'tg-busca-qv-rotulo', ['Cor', el('span', null, [': ' + nomeCor])]));
  }
  // destaques e descricao (so quando a pagina da peca trouxe a descricao no padrao da loja)
  tgQvPintarDescricao(S);
  // rodape fixo: a peca (miniatura, nome e preco), os tamanhos e o aviso
  tgQvPintarPePeca(S);
  S.peTam.textContent = '';
  S.rotuloTam = el('span', null, [S.tam ? ': ' + S.tam : '']);
  if (!S.erro) { S.peTam.appendChild(tgQvNo('p', 'tg-busca-qv-rotulo', ['Tamanho', S.rotuloTam])); }
  tams = S.erro ? null : tgQvPintarTamanhos(S);
  if (tams) { S.peTam.appendChild(tams); }
  S.msgEl = tgQvNo('p', 'tg-busca-qv-msg', null, { role: 'status', 'aria-live': 'polite' });
  S.peTam.appendChild(S.msgEl);
  if (S.erro) {
    S.msg = 'Não conseguimos carregar os tamanhos agora. Abra a página da peça para escolher e comprar.'; S.msgErro = true;
  }
  tgQvAtualizarRodape(S);
  tgQvPeMedir(S);
  if (focoCor) {
    idx = S.inf.querySelectorAll('[data-qv-cor]');
    for (i = 0; i < idx.length; i++) { if (idx[i].getAttribute('data-qv-cor') === focoCor) { foco = idx[i]; break; } }
    if (foco) { try { foco.focus({ preventScroll: true }); } catch (e) {} }
  }
}

// Adicionar a sacola com o tamanho escolhido. Falha mostra aviso e deixa o link da pagina como saida.
function tgQvAdicionar(S) {
  var d = S.dados, t, i, escolhido = null, caixa;
  if (!d || S.ocupado || S.confirmado) { return; }
  if (!S.tam) {
    S.msg = 'Escolha seu tamanho.'; S.msgErro = true;
    tgQvAtualizarRodape(S);
    caixa = S.peTam ? S.peTam.querySelector('.tg-busca-qv-tamanhos') : null;
    if (caixa) { caixa.classList.remove('tg-busca-qv-treme'); void caixa.offsetWidth; caixa.classList.add('tg-busca-qv-treme'); }
    return;
  }
  for (i = 0; i < d.tamanhos.length; i++) { t = d.tamanhos[i]; if (t.rotulo === S.tam && t.disponivel) { escolhido = t; } }
  if (!escolhido) { return; }
  S.ocupado = true; S.msg = ''; S.msgErro = false;
  tgQvAvisoFechar(S);
  tgQvAtualizarRodape(S);
  // v15: o modal fica aberto e confirma ali (antes fechava e abria a sacola do tema, que na busca inicial ficava atras do overlay da busca)
  tgAdicionarSacola(escolhido.variantId, 1, { productId: d.productId, abrirSacola: false, manterQuickView: true }).then(function (r) {
    if (r && r.ok) {
      tgQvEmitir(S, 'tg_qv_add', { reason: 'ok' });
      if (S.fechado) { return; }
      S.ocupado = false; S.msg = ''; S.msgErro = false;
      tgQvConfirmar(S);
      return;
    }
    if (S.fechado) { return; }
    S.ocupado = false;
    tgQvEmitir(S, 'tg_qv_add', { reason: r && r.motivo === 'recusado' ? 'recusado' : 'erro' });
    if (r && r.motivo === 'recusado') {
      escolhido.disponivel = false; S.tam = null;
      S.msg = 'O tamanho acabou de esgotar. Escolha outro.';
      tgQvPintar(S);
    } else {
      if (r && r.motivo === 'timeout') { S.msg = 'A loja demorou para responder. Confira a sacola antes de tentar de novo.'; }
      else if (r && (r.motivo === 'sem-ls' || r.motivo === 'produto' || r.motivo === 'dados')) { S.msg = 'Não deu para adicionar por aqui. Abra a página da peça para comprar.'; }
      else { S.msg = 'Não foi possível adicionar agora. Verifique a conexão e tente de novo.'; }
      tgQvAtualizarRodape(S);
    }
    S.msgErro = true;
    tgQvAtualizarRodape(S);
  });
}

// ---------------------------------------------------------------- quick view do conjunto (peca de cima + peca de baixo)
// v12 (Danilo, 24/11): no padrao do modal das Influenciadoras. Cada peca e um card (foto, nome com a bolinha da cor, preco, parcelas e destaques) com
// "Detalhes da peca", que abre o quick view daquela peca (tamanhos e sacola). Ao fechar o quick view da peca, o conjunto volta. Comprar as duas e
// opcao da cliente: cada peca vai para a sacola pelo proprio quick view. Qualquer falha deixa o link da pagina de cada peca como saida.
function tgQvConjDestaques(d) {
  var ds = d && d.descricao, out = [], i;
  if (!ds || !Array.isArray(ds.destaques)) { return ''; }
  for (i = 0; i < ds.destaques.length && out.length < 2; i++) { if (ds.destaques[i] && ds.destaques[i].rotulo) { out.push(String(ds.destaques[i].rotulo).replace(/[:\s]+$/, '')); } }
  return out.join(' · ');
}

function tgQvConjPintarParte(S, x) {
  var d = x.dados, linhas = [];
  x.extra.textContent = '';
  if (d && d.parcelas) { linhas.push(tgQvNo('p', 'tg-busca-qv-parc', ['ou ' + d.parcelas.n + 'x de ' + reais(d.parcelas.v) + ' sem juros'])); }
  if (d && tgQvConjDestaques(d)) { linhas.push(tgQvNo('p', 'tg-busca-qv-cj-dest', [tgQvConjDestaques(d)])); }
  linhas.forEach(function (n) { x.extra.appendChild(n); });
}

function tgQuickViewConjunto(conj, opcoes) {
  var S, raiz, fundo, painel, cab, titulo, bFechar, rolagem, k, mc, mb;
  try {
    if (!conj || !conj.cima || !conj.baixo || !urlProduto(conj.cima.s) || !urlProduto(conj.baixo.s)) { return; }
    opcoes = opcoes && typeof opcoes === 'object' ? opcoes : {};
    if (tgQvAtivo) { tgQvFechar('trocou'); }
    tgQvEstilos();
    S = {
      conj: conj, opcoes: opcoes, fechado: false,
      origem: typeof opcoes.origem === 'string' && /^[a-z0-9_-]{1,30}$/.test(opcoes.origem) ? opcoes.origem : 'qv',
      foco: document.activeElement, overflowCorpo: document.body.style.overflow, overflowHtml: document.documentElement.style.overflow
    };
    S.partes = [{ item: conj.cima, dados: null }, { item: conj.baixo, dados: null }];
    tgQvAtivo = S;
    // QA 4.4 (25/11): o Voltar do celular fecha so o modal (a busca continua aberta atras)
    try { if (typeof tgHistAbrir === "function" && !(tgHistPilha && tgHistPilha.length && tgHistPilha[tgHistPilha.length - 1].tipo === "modal")) { tgHistAbrir("modal", function () { tgQvFechar("voltar"); }); } } catch (e) {}
    mc = typeof tgModeloCor === 'function' ? tgModeloCor(conj.cima.n) : { modelo: conj.cima.n, cor: '' };
    mb = typeof tgModeloCor === 'function' ? tgModeloCor(conj.baixo.n) : { modelo: conj.baixo.n, cor: '' };
    raiz = tgQvNo('div', 'tg-busca-qv-raiz', null, { id: 'tg-busca-qv' });
    fundo = tgQvNo('div', 'tg-busca-qv-fundo');
    painel = tgQvNo('div', 'tg-busca-qv-painel tg-busca-qv-painel-conj', null, { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tg-busca-qv-titulo' });
    painel.setAttribute('tabindex', '-1');
    titulo = tgQvNo('h2', 'tg-busca-qv-titulo', [mc.modelo.replace(/^\S+\s+/, '') + ' + ' + mb.modelo.replace(/^\S+\s+/, '') + (conj.cor ? ' · ' + conj.cor : '')], { id: 'tg-busca-qv-titulo' });
    bFechar = tgQvNo('button', 'tg-busca-qv-fechar', ['×'], { type: 'button', 'aria-label': 'Fechar' });
    cab = tgQvNo('div', 'tg-busca-qv-cab', [tgQvNo('div', 'tg-busca-qv-alca', [el('span')]), tgQvNo('p', 'tg-busca-qv-cab-rotulo', ['Conjunto']), bFechar]);
    rolagem = tgQvNo('div', 'tg-busca-qv-rolagem', [titulo, tgQvNo('p', 'tg-busca-qv-cj-sub', ['As peças são vendidas separadamente. Leve uma ou as duas.'])]);
    for (k = 0; k < S.partes.length; k++) {
      (function (x, pos) {
        var pr = precoFinal(x.item), foto = urlImagem(x.item.i), cor = typeof tgModeloCor === 'function' ? tgModeloCor(x.item.n).cor : '', nome, det, fotoBt;
        x.extra = tgQvNo('div', 'tg-busca-qv-cj-extra');
        nome = tgQvNo('p', 'tg-busca-qv-cj-nome', [el('span', null, [x.item.n]), cor && typeof tgCorSlug === 'function' && tgCorSlug(cor) !== 'outro' ? el('span', { 'class': 'tg-busca-bolinha tg-busca-qv-bolinha', 'data-cor': tgCorSlug(cor), role: 'img', 'aria-label': 'Cor: ' + cor }) : null]);
        det = tgQvNo('button', 'tg-busca-qv-cj-det', ['Detalhes da peça'], { type: 'button', 'aria-label': 'Detalhes da peça: ' + x.item.n });
        fotoBt = tgQvNo('button', 'tg-busca-qv-cj-foto', foto ? [tgFotoReserva(el('img', { src: urlImagemLeve(x.item.i, 320), alt: '', loading: 'eager', decoding: 'async' }), foto)] : null, { type: 'button', 'aria-label': 'Detalhes da peça: ' + x.item.n, tabindex: '-1' });
        function abrir() { tgQvConjDetalhe(S, x.item, pos); }
        det.addEventListener('click', abrir);
        fotoBt.addEventListener('click', abrir);
        rolagem.appendChild(tgQvNo('div', 'tg-busca-qv-cj', [
          fotoBt,
          tgQvNo('div', 'tg-busca-qv-cj-inf', [
            nome,
            pr ? tgQvNo('p', 'tg-busca-qv-preco', [el('strong', null, [reais(pr.final)]), pr.de ? el('s', null, [reais(pr.de)]) : null]) : null,
            x.extra,
            det
          ])
        ]));
      })(S.partes[k], k);
    }
    painel.appendChild(cab); painel.appendChild(rolagem);
    raiz.appendChild(fundo); raiz.appendChild(painel);
    S.raiz = raiz; S.painel = painel; S.bFechar = bFechar;
    fundo.addEventListener('click', function () { tgQvFechar('fundo'); });
    bFechar.addEventListener('click', function () { tgQvFechar('botao'); });
    S.teclas = function (ev) {
      var f, a;
      if (S.fechado) { return; }
      if (S.lupa && tgQvLupaSetas(S, ev)) { return; }
      if (ev.key === 'Escape' || ev.keyCode === 27) { ev.preventDefault(); ev.stopPropagation(); if (S.lupa) { tgQvLupaFechar(S); return; } tgQvFechar('esc'); return; }
      if (ev.key === 'Tab' || ev.keyCode === 9) {
        f = tgQvFocaveis(S.lupa ? S.lupa.no : S.painel);
        if (!f.length) { ev.preventDefault(); return; }
        a = document.activeElement;
        if (!(S.lupa ? S.lupa.no : S.painel).contains(a)) { ev.preventDefault(); f[0].focus(); return; }
        if (a === S.painel) { ev.preventDefault(); (ev.shiftKey ? f[f.length - 1] : f[0]).focus(); return; }
        if (ev.shiftKey && a === f[0]) { ev.preventDefault(); f[f.length - 1].focus(); } else if (!ev.shiftKey && a === f[f.length - 1]) { ev.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener('keydown', S.teclas, true);
    tgQvArrastar(S, cab);
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    tgQvPor(raiz);
    try { painel.focus({ preventScroll: true }); } catch (e) {}
    tgQvEmitir(S, 'tg_qv_abrir', { position: 0, results_count: 2, reason: 'conjunto' });
    S.partes.forEach(function (x) {
      tgQvConjPintarParte(S, x);
      tgVariantesDoProduto(x.item).then(function (d) {
        if (S.fechado) { return; }
        x.dados = d && d.ok ? d : null;
        tgQvConjPintarParte(S, x);
      });
    });
  } catch (e) {
    try { tgQvFechar('erro'); } catch (e2) {}
    try { if (conj && conj.cima && urlProduto(conj.cima.s) && typeof window !== 'undefined') { window.location.assign(urlProduto(conj.cima.s)); } } catch (e3) {}
  }
}

// "Detalhes da peca" dentro do conjunto: abre o quick view da peca (tamanhos e sacola). Fechar volta ao conjunto; adicionar a sacola nao volta.
function tgQvConjDetalhe(S, item, pos) {
  var conj = S.conj, op = S.opcoes;
  tgQvEmitir(S, 'tg_qv_conj_peca', { position: pos + 1 });
  // o quick view da peca troca o do conjunto (tgQuickViewAbrir fecha o ativo com 'trocou'); o aoFechar do conjunto nao deve devolver o foco agora
  S.opcoes = { origem: op.origem };
  tgQuickViewAbrir(item, {
    irmaos: [item], origem: S.origem,
    aoFechar: function (motivo) {
      if (motivo === 'sacola' || motivo === 'trocou') { try { if (typeof op.aoFechar === 'function') { op.aoFechar(motivo); } } catch (e) {} return; }
      setTimeout(function () { try { tgQuickViewConjunto(conj, op); } catch (e) {} }, 0);
    }
  });
}

// ---------------------------------------------------------------- rodape que aparece com a rolagem (v15, so celular)
// Na abertura o rodape fixo (peca, tamanhos e "Adicionar") fica escondido para a foto aparecer inteira. Ele sobe e fica fixo quando a rolagem
// passa do bloco de preco (preco, Pix e parcelas): a marca no fim desse bloco sobe acima da metade da area de rolagem (TG_QV_PE_LINHA) ou some
// por cima; ou quando a cliente chega ao fim do conteudo. Voltar para a foto esconde de novo (desce). Escondido: aria-hidden + inert (fora do Tab).
// Sem IntersectionObserver, ou na tela larga, o rodape fica sempre visivel, como antes.
var TG_QV_PE_LINHA = '-50%';
function tgQvPeIniciar(S) {
  try {
    if (typeof IntersectionObserver !== 'function' || !S.rolagem || !S.pe) { return; }
    if (window.matchMedia && window.matchMedia('(min-width:768px)').matches) { return; }
    S.peEspaco = tgQvNo('div', 'tg-busca-qv-pe-espaco', null, { 'aria-hidden': 'true' });
    S.marcaFim = tgQvNo('div', 'tg-busca-qv-marca-fim', null, { 'aria-hidden': 'true' });
    S.rolagem.appendChild(S.peEspaco);
    S.rolagem.appendChild(S.marcaFim);
    S.pePassou = false; S.peFim = false; S.peVisivel = null;
    S.peIo = new IntersectionObserver(function (lista) {
      var i, e, topo;
      for (i = 0; i < lista.length; i++) {
        e = lista[i];
        if (e.target !== S.marcaPreco) { continue; }
        topo = e.rootBounds ? e.rootBounds.top : S.rolagem.getBoundingClientRect().top;
        S.pePassou = e.isIntersecting || e.boundingClientRect.bottom <= topo;
      }
      tgQvPeMostrar(S);
    }, { root: S.rolagem, rootMargin: '0px 0px ' + TG_QV_PE_LINHA + ' 0px', threshold: 0 });
    S.peIoFim = new IntersectionObserver(function (lista) {
      S.peFim = !!(lista.length && lista[lista.length - 1].isIntersecting);
      tgQvPeMostrar(S);
    }, { root: S.rolagem, threshold: 0 });
    S.peIoFim.observe(S.marcaFim);
    if (typeof ResizeObserver === 'function') { S.peRo = new ResizeObserver(function () { tgQvPeMedir(S); }); S.peRo.observe(S.pe); }
    S.painel.classList.add('tg-busca-qv-painel-pe-flutua');
    tgQvPeMostrar(S);
  } catch (e) {
    try { S.painel.classList.remove('tg-busca-qv-painel-pe-flutua'); S.pe.classList.remove('tg-busca-qv-pe-oculto'); S.pe.removeAttribute('aria-hidden'); S.pe.removeAttribute('inert'); } catch (e2) {}
    try { if (S.peIo) { S.peIo.disconnect(); } if (S.peIoFim) { S.peIoFim.disconnect(); } } catch (e3) {}
    S.peIo = null; S.peIoFim = null;
  }
}

// Observa a marca nova (o corpo e repintado a cada cor).
function tgQvPeMarcar(S) {
  try { if (!S.peIo) { return; } S.peIo.disconnect(); if (S.marcaPreco) { S.peIo.observe(S.marcaPreco); } } catch (e) {}
}

function tgQvPeMostrar(S) {
  var ver = !!(S.pePassou || S.peFim);
  try {
    if (!S.peIo || S.peVisivel === ver) { return; }
    S.peVisivel = ver;
    if (ver) {
      S.pe.classList.remove('tg-busca-qv-pe-oculto'); S.pe.classList.add('tg-busca-qv-pe-visivel');
      S.pe.removeAttribute('aria-hidden'); S.pe.removeAttribute('inert');
      tgQvPeMedir(S);
    } else {
      if (S.pe.contains(document.activeElement)) { try { S.painel.focus({ preventScroll: true }); } catch (e) {} }
      S.pe.classList.add('tg-busca-qv-pe-oculto'); S.pe.classList.remove('tg-busca-qv-pe-visivel');
      S.pe.setAttribute('aria-hidden', 'true'); S.pe.setAttribute('inert', '');
    }
  } catch (e) {}
}

// Espaco no fim da rolagem com a altura do rodape: com ele por cima, o fim do conteudo ainda sobe acima do rodape.
function tgQvPeMedir(S) {
  try { if (S.peEspaco && S.pe) { S.peEspaco.style.height = S.pe.offsetHeight + 'px'; } } catch (e) {}
}

// Arrastar a alca (celular) para baixo fecha: mais de 1/3 da altura ou velocidade alta.
// v14 (bug do x, Danilo 24/11): a animacao de abertura roda uma vez so (depois o painel fica "assentado"), e o arrastar so comeca se o dedo andar
// mais de 6 px; um toque no x e so um clique (antes o painel refazia a animacao ao soltar o dedo e o clique caia na alca).
function tgQvArrastar(S, cab) {
  var y0 = 0, t0 = 0, delta = 0, ativo = false, movendo = false;
  function larga() { return (window.innerWidth || 0) >= 768; }
  function assentar() { try { S.painel.classList.add('tg-busca-qv-assentado'); } catch (e) {} }
  S.painel.addEventListener('animationend', assentar);
  setTimeout(assentar, 600);
  cab.addEventListener('touchstart', function (ev) {
    if (larga() || !ev.touches || !ev.touches[0]) { return; }
    if (ev.target && ev.target.closest && ev.target.closest('.tg-busca-qv-fechar')) { return; }
    ativo = true; movendo = false; y0 = ev.touches[0].clientY; t0 = Date.now(); delta = 0;
  }, { passive: true });
  cab.addEventListener('touchmove', function (ev) {
    if (!ativo || !ev.touches || !ev.touches[0]) { return; }
    delta = Math.max(0, ev.touches[0].clientY - y0);
    if (!movendo && delta > 6) { movendo = true; assentar(); S.painel.setAttribute('data-arrastando', 'true'); }
    if (movendo) { S.painel.style.transform = 'translateY(' + delta + 'px)'; }
  }, { passive: true });
  function fim() {
    if (!ativo) { return; }
    ativo = false;
    if (!movendo) { return; }
    movendo = false;
    S.painel.removeAttribute('data-arrastando');
    // fecha: o painel desce a partir de onde o dedo soltou (a animacao de saida parte do transform atual); senao volta ao lugar
    if (delta > S.painel.offsetHeight / 3 || delta / Math.max(1, Date.now() - t0) > 0.6) { tgQvFechar('arrastar'); return; }
    S.painel.style.transform = '';
  }
  cab.addEventListener('touchend', fim);
  cab.addEventListener('touchcancel', fim);
}


/* ---- src/injetor/autocomplete.js ---- */
/*
 * Autocomplete em overlay (redesign 18/11/2026). Origem: initAutocomplete do protótipo, reescrito sem HTML cru.
 * Mesmo comportamento de base: minimo de 2 caracteres, debounce de 90 ms, ate 6 pecas, "Ver todos".
 * Busca curada (wedding, casamento...): os mesmos 6 resultados em blocos com titulo (3 + 3), ver tgAcPintar.
 *
 * O que mudou no redesign: a busca abre em um OVERLAY proprio (#tg-busca-overlay: tela cheia no celular, painel no desktop) com campo no topo,
 * ate 6 sugestoes de termo (trecho digitado em negrito), depois "Pecas" em cards enxutos. Campo vazio mostra os chips "Em alta" e as buscas
 * recentes (localStorage, opcional). O overlay so abre DEPOIS que o catalogo carregou (falha fechada: sem catalogo a pagina fica sem rastro e a
 * busca nativa segue como sempre). Fechar o overlay fecha tambem o modal nativo do tema. Nunca mexe no formulario nativo, nunca cancela nem
 * interrompe eventos do tema (so ouve focus, input e clique).
 * Reserva #tg-busca-conselheira (vazio, display:none) para o bloco futuro da IA.
 */
var TG_AC_MIN = 2;
var TG_AC_LIMITE = 6;
var TG_AC_ESPERA = 90;
var TG_AC_TERMOS_MAX = 6;
var TG_REC_CHAVE = 'tg_busca_recentes';
var TG_REC_MAX = 5;
var TG_AC_PARADAS = { de: 1, da: 1, do: 1, das: 1, dos: 1, em: 1, com: 1, sem: 1, para: 1, um: 1, uma: 1, na: 1, no: 1, e: 1, a: 1, o: 1, ao: 1 };
var tgOv = null; // estado do overlay (null enquanto nao foi montado)
var tgAcDesistiu = false; // o catalogo falhou nesta pagina: a busca nativa fica com a tela (o overlay nao reabre a cada foco)

function tgAcLimpar(caixa) { while (caixa.firstChild) { caixa.removeChild(caixa.firstChild); } }

// Atributos que a saida segura (el) nao aceita, gravados so com valores FIXOS do proprio codigo (name, placeholder, action...).
function tgAttr(no, obj) {
  var k;
  for (k in obj) { if (Object.prototype.hasOwnProperty.call(obj, k)) { no.setAttribute(k, String(obj[k])); } }
  return no;
}

// Reserva para o bloco da IA (dez/jan): contêiner vazio e escondido, sem conteudo e sem efeito.
function tgConselheira() { return el('div', { id: 'tg-busca-conselheira', 'class': 'tg-busca-oculto', 'aria-hidden': 'true' }); }

// ---------------------------------------------------------------- buscas recentes (localStorage; tudo opcional, nunca lanca)
function tgRecLer() {
  var out = [], bruto, lista, i;
  try {
    if (typeof window === 'undefined' || !window.localStorage) { return out; }
    bruto = window.localStorage.getItem(TG_REC_CHAVE);
    lista = bruto ? JSON.parse(bruto) : [];
    if (!Array.isArray(lista)) { return out; }
    for (i = 0; i < lista.length && out.length < TG_REC_MAX; i++) {
      if (typeof lista[i] === 'string' && lista[i].trim() && lista[i].length <= 60) { out.push(lista[i].trim()); }
    }
  } catch (e) {}
  return out;
}
function tgRecSalvar(q) {
  var v = String(q == null ? '' : q).trim(), lista, i, out;
  try {
    if (typeof window === 'undefined' || !window.localStorage || v.length < TG_AC_MIN || v.length > 60) { return; }
    lista = tgRecLer();
    out = [v];
    for (i = 0; i < lista.length && out.length < TG_REC_MAX; i++) { if (lista[i].toLowerCase() !== v.toLowerCase()) { out.push(lista[i]); } }
    window.localStorage.setItem(TG_REC_CHAVE, JSON.stringify(out));
  } catch (e) {}
}
function tgRecLimpar() { try { window.localStorage.removeItem(TG_REC_CHAVE); } catch (e) {} }

// ---------------------------------------------------------------- chips "Em alta" (lista vem do motor: TG_CHIPS_EM_ALTA)
// origem: 'overlay' | 'pagina' | 'zero' (so vai para a medicao, no parametro reason). Devolve [<a class="tg-busca-chip">] (so os chips validos).
function tgChipsNos(origem) {
  var lista = typeof TG_CHIPS_EM_ALTA !== 'undefined' && Array.isArray(TG_CHIPS_EM_ALTA) ? TG_CHIPS_EM_ALTA : [], nos = [], i, c, href, a;
  function ligar(no, pos) { no.addEventListener('click', function () { try { emitir('tg_busca_chip', { position: pos, reason: origem }); } catch (e) {} }); }
  for (i = 0; i < lista.length; i++) {
    c = lista[i];
    if (!c || typeof c.rotulo !== 'string' || !c.rotulo) { continue; }
    href = typeof c.href === 'string' ? c.href : (typeof c.consulta === 'string' && c.consulta ? urlBusca(c.consulta) : null);
    if (!href || !tgHrefOk(href)) { continue; }
    a = el('a', { 'class': 'tg-busca-chip', href: href }, [c.rotulo]);
    ligar(a, nos.length + 1);
    nos.push(a);
  }
  return nos;
}
// Lista de chips (ul > li > a). Null sem chips validos.
function tgChipsLista(origem, extra) {
  var nos = tgChipsNos(origem), itens = [], i;
  for (i = 0; i < nos.length; i++) { itens.push(el('li', null, [nos[i]])); }
  return itens.length ? el('ul', { 'class': 'tg-busca-chips' + (extra ? ' ' + extra : '') }, itens) : null;
}

// ---------------------------------------------------------------- sugestoes de termo (calculadas do proprio catalogo, sem campo novo)
// "vest" -> vestido, vestidos...; "vestido" -> vestido preto, vestido off white... (cores mais comuns entre as pecas). So texto.
// Devolve [{ texto }] (ate TG_AC_TERMOS_MAX), cada texto comecando exatamente pelo que foi digitado (sem acento), para o trecho digitado ir em negrito.
function tgAcCorDoItem(it) {
  var mc, c;
  if (typeof tgModeloCor === 'function') { mc = tgModeloCor(it.n); return mc && mc.cor ? String(mc.cor).toLowerCase() : ''; }
  if (typeof tgCorDoNome === 'function') { c = tgCorDoNome(it.n); return c && c.v ? c.v : ''; }
  return '';
}
function tgAcTermos(consulta, cat) {
  var nq = normalizeText(consulta), toks, ult, ant, base, i, j, k, it, ws, nws, antOk, nw, ent, comp = {}, compLista = [], exato = false, cores = {}, coresLista = [];
  var out = [], vistos = {}, cor, ck, cn, n, curadas;
  if (!nq || !Array.isArray(cat)) { return out; }
  // so o grupo digitado (vestido, calcas...): as buscas mais comuns da lista da Talgui (mistura de comprimento, tecido, modelo), nao so cores
  curadas = typeof tgSugestoesDoGrupo === 'function' ? tgSugestoesDoGrupo(consulta) : null;
  if (curadas) {
    for (i = 0; i < curadas.length && out.length < TG_AC_TERMOS_MAX; i++) { out.push({ texto: tgAcSemRepetir(curadas[i]) }); }
    return out;
  }
  toks = nq.split(' ');
  ult = toks.pop();
  ant = toks;
  base = ant.length ? ant.join(' ') + ' ' : '';
  if (ult.length < 2) { return out; }
  function achar(nome, token) { var q; for (q = 0; q < nome.length; q++) { if (nome[q].indexOf(token) === 0) { return true; } } return false; }
  for (i = 0; i < cat.length; i++) {
    it = cat[i];
    if (!it || typeof it.n !== 'string') { continue; }
    ws = it.n.split(/\s+/);
    nws = [];
    for (j = 0; j < ws.length; j++) { nws.push(normalizeText(ws[j])); }
    antOk = true;
    for (k = 0; k < ant.length; k++) { if (!achar(nws, ant[k])) { antOk = false; break; } }
    if (!antOk) { continue; }
    for (j = 0; j < nws.length; j++) {
      nw = nws[j];
      if (nw.length < 3 || TG_AC_PARADAS[nw] === 1 || nw.indexOf(ult) !== 0) { continue; }
      if (nw === ult) {
        exato = true;
        cor = tgAcCorDoItem(it);
        ck = normalizeText(cor);
        if (ck && ck !== ult) {
          if (!Object.prototype.hasOwnProperty.call(cores, ck)) { cores[ck] = { o: cor, c: 0 }; coresLista.push(ck); }
          cores[ck].c++;
        }
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(comp, nw)) { comp[nw] = { n: nw, o: ws[j].toLowerCase().replace(/[^a-zà-ú0-9]/g, ''), c: 0 }; compLista.push(nw); }
      comp[nw].c++;
    }
  }
  compLista.sort(function (a, b) { return (comp[b].c - comp[a].c) || (a.length - b.length); });
  coresLista.sort(function (a, b) { return cores[b].c - cores[a].c; });
  function juntar(texto) {
    var chave = normalizeText(texto);
    if (!chave || chave === nq || vistos[chave] || out.length >= TG_AC_TERMOS_MAX) { return; }
    vistos[chave] = true;
    out.push({ texto: texto });
  }
  n = exato ? 3 : TG_AC_TERMOS_MAX;
  for (i = 0; i < compLista.length && i < n; i++) { juntar(base + comp[compLista[i]].o); }
  for (i = 0; i < coresLista.length; i++) { juntar(tgAcSemRepetir(base + ult + ' ' + cores[coresLista[i]].o)); }
  return out;
}
// QA 1.3 (25/11): tira a palavra repetida em sequencia ("vestido azul azul claro" -> "vestido azul claro"), comparando sem acento
function tgAcSemRepetir(texto) {
  var ws = String(texto || '').split(/\s+/), out = [], i;
  for (i = 0; i < ws.length; i++) { if (!ws[i]) { continue; } if (out.length && normalizeText(out[out.length - 1]) === normalizeText(ws[i])) { continue; } out.push(ws[i]); }
  return out.join(' ');
}

// Bloco "Sugestoes": cada termo e um link para a busca; o botao ao lado copia o termo para o campo (sem buscar).
function tgAcTermosBloco(termos, consulta, input, pegarCaixa) {
  var lis = [], nq = normalizeText(consulta).length, i, t, a, texto;
  function ligar(a2, tx, pos) {
    a2.addEventListener('click', function () {
      tgRecSalvar(tx);
      try { emitir('tg_busca_termo_click', { position: pos, query_len: consulta.length }); } catch (e) {}
    });
  }
  for (i = 0; i < termos.length; i++) {
    t = termos[i].texto;
    texto = el('span', { 'class': 'tg-busca-termo-texto' }, [el('strong', null, [t.slice(0, nq)]), t.slice(nq)]);
    a = el('a', { 'class': 'tg-busca-termo', href: urlBusca(t) }, [el('span', { 'class': 'tg-busca-ico-lupa', 'aria-hidden': 'true' }), texto]);
    ligar(a, t, i + 1);
    lis.push(el('li', null, [a]));
  }
  return el('div', { 'class': 'tg-busca-termos-bloco' }, [el('div', { 'class': 'tg-busca-secao-titulo' }, ['Sugestões']), el('ul', { 'class': 'tg-busca-termos' }, lis)]);
}

// ---------------------------------------------------------------- pecas
// Selo da peca (um so, a precedencia esta no motor: Melhores Ofertas > Best Seller > Ultimas Pecas). "info" vem de res.selos
// (calculado pelo motor para o resultado daquela busca). false = o motor decidiu que a peca nao tem selo (Best Seller agora e so das mais
// vendidas do resultado, nao de toda peca t = 1); sem informacao nenhuma (null/undefined), cai no selo pelo tier t, como antes.
function tgAcSelo(p, info) {
  if (info === false) { return null; }
  if (!info) { info = p.t === 1 ? { tipo: 'best', texto: TG_SELO_BEST } : (p.t === 4 ? { tipo: 'ultimas', texto: TG_SELO_ULTIMAS } : null); }
  if (!info) { return null; }
  // oferta (v12, Danilo 24/11): so "Melhores Ofertas" (o nome da categoria cortava no celular) e o mesmo desenho do Mais Vendidos
  if (info.tipo === 'oferta') { info = { tipo: 'best', texto: 'Melhores Ofertas' }; }
  // a classe -campeao segue como estava (so o texto virou Best Seller)
  return el('span', { 'class': 'tg-busca-selo tg-busca-selo-' + (info.tipo === 'oferta' ? 'oferta' : (info.tipo === 'best' ? 'campeao' : (info.tipo === 'esgotado' ? 'esgotado' : 'ultimas'))) }, [info.texto]);
}

// Uma peca da lista do overlay (card enxuto: foto, nome, preco, selo, tamanhos). Devolve null se o item nao tem link ou preco validos (nao aparece).
// "extra" (opcional): { curada: true } marca a busca curada na telemetria (rescue_type = 'curada'); { esgotado: true } marca o esgotado nominal
// (rescue_type = 'esgotado'; a peca sem tamanho em estoque ganha a classe tg-busca-item-esgotado); { tamanhos: [...] } destaca a pilula do tamanho pedido.
function tgAcLinha(p, posicao, consulta, corrigiu, info, extra) {
  var href = urlProduto(p.s), preco = blocoPreco(p), selo, a, curada = !!(extra && extra.curada), esgotado = !!(extra && extra.esgotado), soldout = esgotado && !tgDisponivel(p);
  if (!href || !preco) { return null; }
  selo = tgAcSelo(p, info);
  a = el('a', { 'class': soldout ? 'tg-busca-item tg-busca-item-esgotado' : 'tg-busca-item', href: href }, [
    foto(p, 'tg-busca-thumb'),
    el('div', { 'class': 'tg-busca-info' }, [
      el('div', { 'class': 'tg-busca-nome' }, [p.n]),
      el('div', { 'class': 'tg-busca-meta' }, [preco, selo]),
      pilulas(p.sz, 8, extra && extra.tamanhos)
    ])
  ]);
  a.addEventListener('click', function (ev2) {
    var ev = { position: posicao, query_len: consulta.length, had_correction: corrigiu ? 'sim' : 'nao', engine_version: tgCtx.versao };
    if (curada) { ev.rescue_type = 'curada'; }
    if (esgotado) { ev.rescue_type = 'esgotado'; }
    tgRecSalvar(consulta);
    try { emitir('tg_busca_sugestao_click', ev); } catch (e) {}
    // QA 3.2 (25/11): tgAcAbrirQv - a peca abre no modal, sem sair da busca (antes ia para a pagina da peca e a sessao de busca acabava)
    try {
      if (ev2.defaultPrevented || soldout || ev2.ctrlKey || ev2.metaKey || ev2.shiftKey || ev2.button > 0 || typeof tgRgAbrirQuickView !== 'function') { return; }
      ev2.preventDefault();
      tgAcAbrirQv(p, extra && extra.tamanhos, a);
    } catch (e) {}
  });
  return el('li', null, [a]);
}
// Abre o modal da peca da lista da digitacao: as outras cores vem do catalogo; o tamanho buscado ("vestido g") ja chega escolhido (QA 2).
function tgAcAbrirQv(p, tamanhos, foco) {
  var tam = null, i, j, up;
  if (Array.isArray(tamanhos) && Array.isArray(p.sz)) {
    for (i = 0; i < p.sz.length && !tam; i++) { up = String(p.sz[i]).toUpperCase(); for (j = 0; j < tamanhos.length; j++) { if (String(tamanhos[j]).toUpperCase() === up) { tam = p.sz[i]; break; } } }
  }
  obterCatalogo().then(function (cat) {
    var mapa = null, g;
    try { mapa = cat ? tgGruposCores(cat) : null; } catch (e) {}
    g = mapa ? tgGrupoDe(mapa, p) : null;
    tgRgAbrirQuickView(p, g && g.irmaos && g.irmaos.length ? g.irmaos : [p], tam, foco);
  })['catch'](function () { tgRgAbrirQuickView(p, [p], tam, foco); });
}

// Aviso da busca por tamanho ("vestido G"): diz o tamanho que esta valendo, ou que nao ha em estoque e o que se mostra no lugar.
function tgAcAviso(t) {
  var texto = t.texto || '';
  if (t.aplicado) {
    return el('div', { 'class': 'tg-busca-banner' }, ['Buscando por: ', el('strong', null, [texto || 'todas as peças']), ' no tamanho ', el('strong', null, [t.rotulo])]);
  }
  return el('div', { 'class': 'tg-busca-banner' }, ['Não temos ', el('strong', null, [texto || 'peças']), ' no tamanho ', el('strong', null, [t.rotulo]), ' em estoque agora. Mostrando as opções de outros tamanhos.']);
}

// Titulo de um bloco da busca curada ("Para as Noivas" + quantas pecas ha). So texto.
function tgBlocoTitulo(titulo, total, tag) {
  return el(tag || 'div', { 'class': 'tg-busca-bloco-titulo' }, [el('span', null, [titulo])]);
}

// Frase da peca esgotada (v14, Danilo 24/11): a esgotada vira so texto; o nome e o da 1a esgotada achada (a mais parecida com o que foi digitado).
function tgEsgFrase(e) {
  var nome = e && e.itens && e.itens[0] && typeof e.itens[0].n === 'string' ? e.itens[0].n : '';
  return el('p', { 'class': 'tg-busca-esg-frase', role: 'status' }, nome ? ['A peça “', el('strong', null, [nome]), '” está esgotada, confira outras opções abaixo:'] : ['Esta peça está esgotada, confira outras opções abaixo:']);
}

// Esgotado nominal (REL-04; v14): a frase da esgotada e, abaixo, as parecidas (mesmo tipo, grade cheia). A esgotada nao vira linha.
// Mesmos cuidados do resto: so texto, link normal para a PDP, "Ver todos" para a busca da pagina com o que foi digitado.
function tgAcPintarEsgotado(caixa, consulta, res) {
  var e = res.esgotado, extra = { esgotado: true }, n = 0, i, li, lis = [], todos, total;
  for (i = 0; i < e.similares.length; i++) {
    li = tgAcLinha(e.similares[i], n + 1, consulta, false, res.selos ? (res.selos.get(e.similares[i]) || false) : false, extra);
    if (li) { n++; lis.push(li); }
  }
  if (!n) {
    caixa.appendChild(el('div', { 'class': 'tg-busca-banner' }, ['Não encontramos resultados para "', el('strong', null, [consulta]), '".']));
    caixa.classList.remove('tg-busca-oculto');
    return;
  }
  caixa.appendChild(tgEsgFrase(e));
  caixa.appendChild(el('div', { 'class': 'tg-busca-bloco' }, [el('ul', { 'class': 'tg-busca-lista' }, lis)]));
  total = n;
  todos = el('a', { 'class': 'tg-busca-todos', href: urlBusca(consulta) }, ['Ver todos os resultados']);
  todos.addEventListener('click', function () {
    tgRecSalvar(consulta);
    try { emitir('tg_busca_ver_todos', { query_len: consulta.length, results_count: total, rescue_type: 'esgotado' }); } catch (err) {}
  });
  caixa.appendChild(todos);
  caixa.classList.remove('tg-busca-oculto');
}

// "res.termos" (opcional, calculado por tgAcDesenhar): sugestoes de termo no topo, antes das pecas.
function tgAcPintar(pegarCaixa, input, consulta, res) {
  var linhas = [], blocos = [], i, b, li, lis, ul, todos, sugerido, botao, caixa = pegarCaixa(), extra, total, termoTodos, porNome, termosBloco;
  if (!caixa) { return; }
  tgAcLimpar(caixa);
  if (res.esgotado) { tgAcPintarEsgotado(caixa, consulta, res); return; }
  extra = { curada: !!res.curada, tamanhos: res.tamanho && res.tamanho.aplicado ? res.tamanho.aceitos : null };
  if (res.curada) {
    // busca curada: um bloco por titulo, na ordem do motor (as pecas ja vem na ordem de cada bloco)
    for (b = 0; b < res.curada.blocos.length; b++) {
      lis = [];
      for (i = 0; i < res.curada.blocos[b].itens.length; i++) {
        li = tgAcLinha(res.curada.blocos[b].itens[i], linhas.length + 1, consulta, false, res.selos ? (res.selos.get(res.curada.blocos[b].itens[i]) || false) : null, extra);
        if (li) { linhas.push(li); lis.push(li); }
      }
      if (lis.length) { blocos.push(el('div', { 'class': 'tg-busca-bloco' }, [tgBlocoTitulo(res.curada.blocos[b].titulo, res.curada.blocos[b].total), el('ul', { 'class': 'tg-busca-lista' }, lis)])); }
    }
  } else {
    for (i = 0; i < res.results.length; i++) {
      li = tgAcLinha(res.results[i], linhas.length + 1, consulta, !!res.suggestedTerm, res.selos ? (res.selos.get(res.results[i]) || false) : null, extra);
      if (li) { linhas.push(li); }
    }
  }
  if (!linhas.length) {
    caixa.appendChild(el('div', { 'class': 'tg-busca-banner' }, ['Não encontramos resultados para "', el('strong', null, [consulta]), '".']));
    // saida util tambem no overlay: chips Em alta (com Conjuntos) e, abaixo, as Novidades da semana (QA 4.2: nada de tela vazia)
    li = tgChipsLista('overlay', 'tg-busca-chips-emalta');
    if (li) { caixa.appendChild(el('div', { 'class': 'tg-busca-secao-titulo' }, ['Em alta'])); caixa.appendChild(li); tgAcChipConjSeHouver(li); }
    tgAcNovidadesSemana(caixa, consulta);
    caixa.classList.remove('tg-busca-oculto');
    return;
  }
  // busca pelo nome da peca (84% das buscas): as pecas vem antes das sugestoes, que ficam em no maximo 2
  porNome = !!res.suggestedTerm && !res.curada;
  termosBloco = res.termos && res.termos.length && !res.curada ? tgAcTermosBloco(porNome ? res.termos.slice(0, 2) : res.termos, consulta, input, pegarCaixa) : null;
  if (termosBloco && !porNome) { caixa.appendChild(termosBloco); }
  if (res.tamanho) { caixa.appendChild(tgAcAviso(res.tamanho)); }
  // so avisa quando a grafia foi corrigida de verdade, com o nome do modelo (sem a cor): nao prende a busca numa cor so.
  // O "Buscando por: Vestidos" do grupo saiu: repetia o que esta no campo.
  if (res.suggestedTerm && tgAcCorrigiu(consulta, res.suggestedTerm)) {
    sugerido = typeof tgModeloCor === 'function' ? (tgModeloCor(res.suggestedTerm).modelo || res.suggestedTerm) : res.suggestedTerm;
    botao = el('button', { type: 'button', 'class': 'tg-busca-sugerido' }, [sugerido]);
    botao.addEventListener('click', function () {
      try { input.value = sugerido; tgAcDesenhar(pegarCaixa, input, sugerido); } catch (e) {}
    });
    caixa.appendChild(el('div', { 'class': 'tg-busca-banner' }, ['Mostrando resultados para ', botao]));
  }
  if (res.curada) {
    for (i = 0; i < blocos.length; i++) { caixa.appendChild(blocos[i]); }
  } else {
    // QA 1.1/1.5 (25/11): busca por intencao ("promocao", "festa", "roupa de baixo") ganha o titulo dela ("Peças em promoção", "Para festas")
    caixa.appendChild(el('div', { 'class': 'tg-busca-secao-titulo' }, [res.intencao && res.intencao.aplicado !== false && res.intencao.titulo ? res.intencao.titulo : 'Peças']));
    ul = el('ul', { 'class': 'tg-busca-lista' }, linhas);
    caixa.appendChild(ul);
  }
  if (termosBloco && porNome) { caixa.appendChild(termosBloco); }
  // "Ver todos": a busca da pagina nao filtra por tamanho, entao na busca por tamanho o link leva so o texto sem o tamanho ("vestido g" -> /search/?q=vestido).
  // Se so sobrou o tamanho ("tam g"), nao ha busca nativa equivalente: o botao nao aparece (a lista acima ja mostra as pecas do tamanho).
  termoTodos = res.tamanho ? (res.tamanho.texto || '') : consulta;
  total = res.curada ? res.curada.total : res.results.length;
  if (termoTodos) {
    todos = el('a', { 'class': 'tg-busca-todos', href: urlBusca(termoTodos) }, ['Ver todos os resultados']);
    todos.addEventListener('click', function () {
      var ev = { query_len: consulta.length, results_count: total };
      if (res.curada) { ev.rescue_type = 'curada'; }
      tgRecSalvar(consulta);
      try { emitir('tg_busca_ver_todos', ev); } catch (e) {}
    });
    caixa.appendChild(todos);
  }
  caixa.classList.remove('tg-busca-oculto');
}

// QA 4.2 (25/11): chip Conjuntos tambem nos atalhos do "nao encontramos" (so com a lista do Recom no ar)
function tgAcChipConjSeHouver(ul) {
  try { if (typeof tgConjuntosBaixar === 'function') { tgConjuntosBaixar().then(function (d) { if (d) { tgTapeteChipConj(ul); } }, function () {}); } } catch (e) {}
}
// "Novidades da semana" no overlay sem resultado: as pecas mais novas (categoria Novidades), em estoque, num carrossel como o da busca inicial
function tgAcNovidadesSemana(caixa, consulta) {
  try {
    Promise.all([obterCatalogo(), typeof tgPgNovidades === 'function' ? tgPgNovidades() : []]).then(function (r) {
      var cat = r[0], itens, mapa, cards = [], i, c, s;
      if (!cat || !caixa.parentNode || (tgOv && tgOv.campo && tgOv.campo.value.trim() !== consulta)) { return; }
      itens = tgNovidadesItens(cat, r[1], 6);
      if (!itens.length) { return; }
      mapa = tgGruposCores(cat);
      for (i = 0; i < itens.length; i++) { c = tgHCard(itens[i], { mapa: mapa, posicao: i + 1, secao: 'novidades-zero' }); if (c) { cards.push(c); } }
      s = tgTapeteCarrossel('Novidades da semana', tgTapeteColunas(cards), 'novidades');
      if (s) { caixa.appendChild(el('div', { 'class': 'tg-busca-tapete tg-busca-zero-nov' }, [s])); }
    }, function () {});
  } catch (e) {}
}
// As pecas das Novidades (na ordem da categoria), em estoque e com 3+ tamanhos; sem a lista das Novidades, as mais vendidas em estoque
function tgNovidadesItens(cat, handles, max) {
  var porS = {}, out = [], i, it;
  for (i = 0; i < cat.length; i++) { if (cat[i] && cat[i].s) { porS[cat[i].s] = cat[i]; } }
  handles = Array.isArray(handles) ? handles : [];
  for (i = 0; i < handles.length && out.length < max; i++) { it = porS[handles[i]]; if (it && tgDisponivel(it) && Array.isArray(it.sz) && it.sz.length >= 3) { out.push(it); } }
  for (i = 0; i < cat.length && out.length < max; i++) { it = cat[i]; if (it && out.indexOf(it) < 0 && it.t === 1 && tgDisponivel(it) && Array.isArray(it.sz) && it.sz.length >= 3) { out.push(it); } }
  return out;
}

// Vitrine da busca inicial (v12, Danilo 24/11): com o campo vazio, Vestidos, Conjuntos, Blusas e Calcas, 2 cards horizontais por secao (padrao do modal
// das Influenciadoras), com as cores e os tamanhos em estoque de cada peca. Vestidos, Blusas e Calcas vem da categoria Novidades (regra no motor:
// tgVitrineInicial); o Conjunto vem do Recom (as duas pecas em cards separados; tocar em qualquer uma abre o modal com as duas). Enquanto os dados
// chegam, um esqueleto com a mesma altura segura o lugar (a tela nao pula). Novidades e Conjuntos esperam no maximo TG_TAPETE_ESPERA; depois disso a
// vitrine sai com o que houver (sem Novidades = mais vendidas neutras; sem Recom = sem a secao Conjuntos).
var TG_TAPETE_ESPERA = 4000;
// v15 (Danilo, 25/11: a vitrine e o "tapete de boas-vindas", precisa aparecer quase no toque): o Recom nao segura mais a vitrine (espera 250 ms;
// se chegar depois, a faixa de Conjuntos entra sozinha) e as Novidades seguram no maximo 1,5 s (depois sai com as mais vendidas). Os dados sao
// aquecidos logo depois da pagina carregar (tgTapeteAquecer), entao na pratica ja estao prontos no 1o toque.
var TG_TAPETE_ESPERA_NOV = 1500;
var TG_TAPETE_ESPERA_CONJ = 250;
var TG_TAPETE_POR_GRUPO = 6;
var TG_TAPETE_CONJ_MAX = 3;
var TG_TAPETE_ROTULO_TODOS = { vestidos: 'Ver todos os vestidos', blusas: 'Ver todas as blusas', calcas: 'Ver todas as calças', conjuntos: 'Ver todos os conjuntos' };
var TG_TAPETE_BUSCA_TODOS = { vestidos: 'vestido', blusas: 'blusa', calcas: 'calça', conjuntos: 'conjuntos' };
TG_TAPETE_ROTULO_TODOS.novidades = 'Ver todas as novidades';
function tgTapeteAquecer() {
  try { if (typeof obterCatalogo === 'function') { obterCatalogo(); } } catch (e) {}
  try { if (typeof tgPgNovidades === 'function') { tgPgNovidades(); } } catch (e) {}
  try { if (typeof tgConjuntosBaixar === 'function') { tgConjuntosBaixar(); } } catch (e) {}
}
function tgTapeteSecao(titulo, cards, rodape, id) {
  if (!cards.length) { return null; }
  return el('section', { 'class': 'tg-busca-tapete-secao', 'data-secao': id || '' }, [el('h2', { 'class': 'tg-busca-secao-titulo' }, [titulo]), el('div', { 'class': 'tg-busca-hc-lista' }, cards), rodape || null]);
}
// v15 (Danilo, 25/11): cada grupo vira um carrossel (a vitrine nao depende so da rolagem para baixo). Cada coluna tem 2 cards (Vestidos: um em cima,
// outro embaixo; Conjuntos: as duas pecas do conjunto); arrastar para o lado mostra a proxima coluna (a borda dela aparece, para convidar o gesto).
// Ate 6 pecas (ou 3 conjuntos) e, no fim, o cartao "Ver todos". O link "Ver todos" tambem fica abaixo do carrossel.
function tgTapeteTodosLink(id, cls) {
  var rot = TG_TAPETE_ROTULO_TODOS[id] || 'Ver todos', a;
  a = el('a', { 'class': cls, href: id === 'novidades' ? (typeof TG_NOVIDADES_CATEGORIA === 'string' ? TG_NOVIDADES_CATEGORIA : '/novidades/') : urlBusca(TG_TAPETE_BUSCA_TODOS[id] || id) }, cls === 'tg-busca-car-todos' ? [el('span', { 'class': 'tg-busca-car-todos-txt' }, [rot]), el('span', { 'class': 'tg-busca-car-seta', 'aria-hidden': 'true' })] : [rot]);
  a.addEventListener('click', function () { try { emitir('tg_busca_tapete_todos', { reason: id }); tgAcBuscando(); } catch (e) {} });
  return a;
}
function tgTapeteCarrossel(titulo, colunas, id) {
  var cols = [], i, car;
  if (!colunas.length) { return null; }
  for (i = 0; i < colunas.length; i++) { cols.push(el('div', { 'class': 'tg-busca-car-col' }, colunas[i])); }
  cols.push(el('div', { 'class': 'tg-busca-car-col tg-busca-car-col-todos' }, [tgTapeteTodosLink(id, 'tg-busca-car-todos')]));
  car = el('div', { 'class': 'tg-busca-carrossel', role: 'group', 'aria-label': titulo + ': arraste para o lado para ver mais' }, cols);
  return el('section', { 'class': 'tg-busca-tapete-secao tg-busca-tapete-car', 'data-secao': id || '' }, [el('h2', { 'class': 'tg-busca-secao-titulo' }, [titulo]), car, tgTapeteTodosLink(id, 'tg-busca-tapete-todos')]);
}
// colunas de 2: [[a,b],[c,d],[e,f]]
function tgTapeteColunas(cards) { var out = [], i; for (i = 0; i < cards.length; i += 2) { out.push(cards.slice(i, i + 2)); } return out; }
function tgTapeteSecaoConj(conjs, handles, max) {
  var lista = [], cols = [], esc = tgTapeteConjuntoEscolhido(conjs, handles), i, p, TG_TAPETE_CONJ_MAX = typeof max === 'number' ? max : 3;
  if (esc) { lista.push(esc); }
  if (typeof tgConjuntosIntercalados === 'function') { conjs = tgConjuntosIntercalados(conjs); }
  for (i = 0; i < conjs.length && lista.length < TG_TAPETE_CONJ_MAX; i++) { if (lista.indexOf(conjs[i]) < 0 && (!esc || conjs[i].cor !== esc.cor)) { lista.push(conjs[i]); } }
  for (i = 0; i < conjs.length && lista.length < TG_TAPETE_CONJ_MAX; i++) { if (lista.indexOf(conjs[i]) < 0) { lista.push(conjs[i]); } }
  for (i = 0; i < lista.length; i++) { p = tgHConjunto(lista[i], i + 1, 'conjuntos'); if (p) { cols.push([p]); } }
  return tgTapeteCarrossel('Conjuntos', cols, 'conjuntos');
}
// v15 (R1): tocar num chip ou em "Ver todos" leva a outra pagina; enquanto ela carrega, a busca mostra "Buscando resultados" (nunca a tela parada).
function tgAcBuscando() {
  var caixa;
  try {
    caixa = tgOv && tgOv.corpo ? tgOv.corpo : null;
    if (!caixa || caixa.querySelector('.tg-busca-buscando')) { return; }
    caixa.appendChild(el('div', { 'class': 'tg-busca-buscando', role: 'status' }, [el('span', { 'class': 'tg-busca-buscando-anel', 'aria-hidden': 'true' }), el('span', { 'class': 'tg-busca-buscando-txt' }, ['Buscando resultados'])]));
  } catch (e) {}
}
function tgTapeteEsqueleto() {
  var secs = [], s, k;
  for (s = 0; s < 2; s++) {
    k = [];
    k.push(el('div', { 'class': 'tg-busca-hc tg-busca-hc-esq', 'aria-hidden': 'true' }, [el('span', { 'class': 'tg-busca-hc-foto' }), el('span', { 'class': 'tg-busca-hc-inf' }, [el('i'), el('i'), el('i')])]));
    k.push(el('div', { 'class': 'tg-busca-hc tg-busca-hc-esq', 'aria-hidden': 'true' }, [el('span', { 'class': 'tg-busca-hc-foto' }), el('span', { 'class': 'tg-busca-hc-inf' }, [el('i'), el('i'), el('i')])]));
    secs.push(el('div', { 'class': 'tg-busca-tapete-secao' }, [el('div', { 'class': 'tg-busca-esq-titulo' }), el('div', { 'class': 'tg-busca-hc-lista' }, k)]));
  }
  return el('div', { 'class': 'tg-busca-tapete-esq', role: 'status', 'aria-label': 'Carregando peças' }, secs);
}
function tgTapeteLimite(prom, padrao, ms) {
  return new Promise(function (ok) {
    var t = setTimeout(function () { ok(padrao); }, typeof ms === 'number' ? ms : TG_TAPETE_ESPERA);
    Promise.resolve(prom).then(function (v) { clearTimeout(t); ok(v); }, function () { clearTimeout(t); ok(padrao); });
  });
}
// O conjunto da vitrine: o primeiro do Recom com alguma das pecas nas Novidades; senao o primeiro da lista.
function tgTapeteConjuntoEscolhido(conjs, handles) {
  var set = {}, i;
  if (!conjs.length) { return null; }
  for (i = 0; i < handles.length; i++) { set[handles[i]] = true; }
  for (i = 0; i < conjs.length; i++) { if (set[conjs[i].cima.s] || set[conjs[i].baixo.s]) { return conjs[i]; } }
  return conjs[0];
}
// Chip Conjuntos no Em alta, antes do Novidades (so com a lista do Recom no ar).
function tgTapeteChipConj(chipsUl) {
  var a, li;
  if (!chipsUl || !chipsUl.parentNode || chipsUl.querySelector('[data-tg-chip="conjuntos"]')) { return; }
  a = el('a', { 'class': 'tg-busca-chip', href: urlBusca('conjuntos') }, ['Conjuntos']);
  a.setAttribute('data-tg-chip', 'conjuntos');
  a.addEventListener('click', function () { try { emitir('tg_busca_chip', { reason: 'conjuntos' }); } catch (e) {} });
  li = el('li', null, [a]);
  chipsUl.insertBefore(li, chipsUl.lastChild || null);
}
function tgTapetePreencher(holder, cat, chipsUl) {
  var esq, pConj;
  try {
    if (typeof tgVitrineInicial !== 'function' || !holder.parentNode) { return; }
    esq = holder.querySelector('.tg-busca-tapete-esq');
    if (!esq) { esq = tgTapeteEsqueleto(); holder.appendChild(esq); }
    pConj = typeof tgConjuntosLista === 'function' ? tgConjuntosLista(cat) : Promise.resolve([]);
    Promise.all([
      tgTapeteLimite(typeof tgPgNovidades === 'function' ? tgPgNovidades() : [], [], TG_TAPETE_ESPERA_NOV),
      tgTapeteLimite(pConj, [], TG_TAPETE_ESPERA_CONJ)
    ]).then(function (r) {
      var handles = Array.isArray(r[0]) ? r[0] : [], conjs = Array.isArray(r[1]) ? r[1] : [], v, mapa, ordem = ['vestidos', 'conjuntos', 'blusas', 'calcas'], tit = { vestidos: 'Vestidos', conjuntos: 'Conjuntos', blusas: 'Blusas', calcas: 'Calças' }, k, i, cards, sec;
      if (!holder.parentNode) { return; }
      try {
      v = tgVitrineInicial(cat, handles, TG_TAPETE_POR_GRUPO);
      mapa = tgGruposCores(cat);
      if (esq.parentNode) { esq.parentNode.removeChild(esq); }
      for (k = 0; k < ordem.length; k++) {
        cards = [];
        if (ordem[k] === 'conjuntos') {
          sec = conjs.length ? tgTapeteSecaoConj(conjs, handles) : null;
        } else {
          for (i = 0; i < v[ordem[k]].length; i++) { sec = tgHCard(v[ordem[k]][i], { mapa: mapa, posicao: i + 1, secao: ordem[k], cardAbre: true }); if (sec) { cards.push(sec); } }
          sec = tgTapeteCarrossel(tit[ordem[k]], tgTapeteColunas(cards), ordem[k]);
        }
        if (sec) { holder.appendChild(sec); }
      }
      if (conjs.length) { tgTapeteChipConj(chipsUl); }
      // v14: a lista do Recom chegou depois da espera (4G lento na 1a abertura): a secao e o chip entram quando ela chegar, sem mexer no resto
      else {
        Promise.resolve(pConj).then(function (l) {
          var s, antes;
          try {
            if (!Array.isArray(l) || !l.length || !holder.parentNode || holder.querySelector('[data-secao="conjuntos"]')) { return; }
            s = tgTapeteSecaoConj(l, handles);
            if (!s) { return; }
            antes = holder.querySelector('[data-secao="blusas"]') || holder.querySelector('[data-secao="calcas"]');
            holder.insertBefore(s, antes || null);
            tgTapeteChipConj(chipsUl);
          } catch (e4) {}
        }, function () {});
      }
      emitir('tg_busca_tapete_view', { reason: handles.length ? 'novidades' : 'reserva', results_count: holder.querySelectorAll('.tg-busca-hc').length });
      } catch (e2) { try { if (esq.parentNode) { esq.parentNode.removeChild(esq); } } catch (e3) {} }
    })['catch'](function () { try { if (esq.parentNode) { esq.parentNode.removeChild(esq); } } catch (e) {} });
  } catch (e) {}
}

// Campo vazio: chips "Em alta" e buscas recentes (ou uma dica, se nao houver nada para mostrar).
function tgAcVazio(caixa) {
  var chips = tgChipsLista('overlay', 'tg-busca-chips-emalta'), rec = tgRecLer(), lis = [], i, limpar, topo, holder;
  tgAcLimpar(caixa);
  // buscas recentes no topo (no maximo 3), antes de Em alta e do tapete: quem volta para comparar acha a busca de ontem sem rolar
  if (rec.length) {
    limpar = el('button', { type: 'button', 'class': 'tg-busca-limpar' }, ['Limpar']);
    limpar.addEventListener('click', function () { tgRecLimpar(); tgAcVazio(caixa); });
    topo = el('div', { 'class': 'tg-busca-secao-titulo tg-busca-recentes-topo' }, [el('span', null, ['Buscas recentes']), limpar]);
    caixa.appendChild(topo);
    for (i = 0; i < rec.length && i < 3; i++) {
      lis.push(el('li', null, [el('a', { 'class': 'tg-busca-termo', href: urlBusca(rec[i]) }, [el('span', { 'class': 'tg-busca-ico-lupa', 'aria-hidden': 'true' }), el('span', { 'class': 'tg-busca-termo-texto' }, [rec[i]])])]));
    }
    caixa.appendChild(el('ul', { 'class': 'tg-busca-recentes' }, lis));
  }
  if (chips) {
    caixa.appendChild(el('div', { 'class': 'tg-busca-secao-titulo' }, ['Em alta']));
    caixa.appendChild(chips);
  }
  if (chips) { chips.addEventListener('click', function (ev) { try { if (ev.target && ev.target.closest && ev.target.closest('a.tg-busca-chip')) { tgAcBuscando(); } } catch (e) {} }); }
  holder = el('div', { 'class': 'tg-busca-tapete' }, [tgTapeteEsqueleto()]);
  caixa.appendChild(holder);
  tgTapeteAquecer(); // v15: Novidades e Recom baixam junto com o catalogo (antes, so depois dele)
  try { if (typeof obterCatalogo === 'function') { obterCatalogo().then(function (cat) { if (cat) { tgTapetePreencher(holder, cat, chips); } })['catch'](function () {}); } } catch (e) {}
  if (!chips && !rec.length) { caixa.appendChild(el('div', { 'class': 'tg-busca-banner' }, ['Digite o tipo da peça, o nome ou a cor.'])); }
  caixa.classList.remove('tg-busca-oculto');
}

// Texto para leitor de tela: quantas pecas apareceram (o resto da lista nao e lido a cada letra).
function tgAcStatus(texto) {
  try { if (tgOv && tgOv.status) { tgOv.status.textContent = texto; } } catch (e) {}
}

// Desenha a resposta para o que esta no campo. Com o overlay aberto, campo curto mostra o estado vazio; fora dele, esconde a caixa.
// O catalogo e baixado so na primeira interacao (L6).
// Houve correcao de grafia de verdade? Cada palavra digitada (3+ letras) precisa aparecer no nome sugerido; se alguma nao aparece, o motor corrigiu.
function tgAcCorrigiu(consulta, sugerido) {
  var q = normalizeText(consulta).split(' '), s = ' ' + normalizeText(sugerido) + ' ', i;
  for (i = 0; i < q.length; i++) { if (q[i].length >= 3 && s.indexOf(q[i]) < 0) { return true; } }
  return false;
}

function tgAcDesenhar(pegarCaixa, input, consulta) {
  var existente, caixa;
  if (consulta.length < TG_AC_MIN) {
    caixa = pegarCaixa();
    if (caixa && tgOv && caixa === tgOv.caixa) { tgAcVazio(caixa); tgAcStatus(''); return; }
    existente = document.getElementById('tg-busca-sugestoes');
    if (existente) { tgAcLimpar(existente); existente.classList.add('tg-busca-oculto'); }
    return;
  }
  // catalogo ainda chegando (o overlay abre no toque): um aviso discreto no lugar das pecas, so se a espera passar de um instante
  var pronto = false;
  setTimeout(function () {
    var cx;
    try { if (!pronto && tgOv && tgOv.aberto && input.value.trim() === consulta) { cx = pegarCaixa(); if (cx && cx === tgOv.caixa) { tgAcLimpar(cx); cx.appendChild(el('div', { 'class': 'tg-busca-banner tg-busca-carregando', role: 'status' }, ['Carregando as peças…'])); cx.classList.remove('tg-busca-oculto'); } } } catch (e) {}
  }, 150);
  obterCatalogo().then(function (cat) {
    pronto = true;
    if (!cat || input.value.trim() !== consulta) { return; }
    // QA 1.2 (25/11): a lista da digitacao anterior sai na hora (nunca fica congelada com outro termo no campo)
    try { var cx0 = pegarCaixa(); if (cx0 && cx0.getAttribute('data-consulta') !== consulta) { cx0.setAttribute('data-consulta', consulta); } } catch (e) {}
    function desenhar(res) {
      if (!res.esgotado && !res.curada && !res.intencao) { res.termos = tgAcTermos(consulta, cat); }
      tgAcPintar(pegarCaixa, input, consulta, res);
      tgAcStatus(res.esgotado ? 'Peça esgotada. Veja outras opções.' : 'Peças encontradas.');
      // QA 1.4 (25/11): busca por conjunto mostra primeiro os pares reais (Recom), em carrossel, com "Ver todos os conjuntos"
      if (typeof tgEhBuscaConjuntos === 'function' && tgEhBuscaConjuntos(consulta) && typeof tgConjuntosLista === 'function') {
        tgConjuntosLista(cat).then(function (l) {
          var cx = pegarCaixa(), s;
          try {
            if (!Array.isArray(l) || !l.length || !cx || input.value.trim() !== consulta || cx.querySelector('[data-secao="conjuntos"]')) { return; }
            s = tgTapeteSecaoConj(l, [], 6);
            if (s) { s.classList.add('tg-busca-conj-digitado'); cx.insertBefore(s, cx.firstChild); }
          } catch (e) {}
        }, function () {});
      }
    }
    // Esgotado nominal: so quando a palavra pedida nao casa com nenhuma peca em estoque (tgPrecisaEsgotados). O catalogo de esgotados e baixado
    // uma vez, sob demanda; se falhar (ou demorar mais que o limite), a busca de sempre aparece, sem nenhum aviso.
    if (tgPrecisaEsgotados(consulta, cat)) {
      return obterEsgotados().then(function (esg) {
        if (input.value.trim() !== consulta) { return; }
        desenhar(runSearch(consulta, cat, TG_AC_LIMITE, esg));
      })['catch'](function () { try { if (input.value.trim() === consulta) { desenhar(runSearch(consulta, cat, TG_AC_LIMITE)); } } catch (e) {} });
    }
    desenhar(runSearch(consulta, cat, TG_AC_LIMITE));
  })['catch'](function () {
    // QA 1.2: algo falhou ao desenhar: limpa a lista anterior e mostra a mensagem de nada encontrado (nunca a lista velha)
    try { var cx = pegarCaixa(); if (cx && input.value.trim() === consulta) { tgAcLimpar(cx); cx.appendChild(el('div', { 'class': 'tg-busca-banner' }, ['Não encontramos resultados para "', el('strong', null, [consulta]), '".'])); cx.classList.remove('tg-busca-oculto'); } } catch (e) {}
  });
}

// ---------------------------------------------------------------- Voltar do celular (QA 4.4, 25/11)
// Cada camada aberta (busca, modal da peca) ganha uma entrada no historico do navegador (mesma URL, so um marcador no state). O gesto ou botao Voltar
// tira essa entrada e fecha so a camada de cima; fechar pela tela (x, voltar) tira a entrada tambem, para o Voltar seguinte agir na pagina.
var tgHistPilha = [], tgHistIgnorar = 0, tgHistLigado = false;
function tgHistAbrir(tipo, aoVoltar) {
  try {
    if (!window.history || typeof window.history.pushState !== 'function') { return; }
    if (!tgHistLigado) {
      tgHistLigado = true;
      window.addEventListener('popstate', function () {
        var topo;
        try {
          if (tgHistIgnorar > 0) { tgHistIgnorar--; return; }
          topo = tgHistPilha.pop();
          if (topo && typeof topo.aoVoltar === 'function') { topo.aoVoltar(); }
        } catch (e) {}
      });
    }
    window.history.pushState({ tgBusca: tipo, n: tgHistPilha.length + 1 }, '', window.location.href);
    tgHistPilha.push({ tipo: tipo, aoVoltar: aoVoltar });
  } catch (e) {}
}
// a camada fechou pela tela: tira a entrada dela do historico (sem chamar o aoVoltar)
function tgHistFechar(tipo) {
  var i;
  try {
    for (i = tgHistPilha.length - 1; i >= 0; i--) {
      if (tgHistPilha[i].tipo === tipo) {
        if (i === tgHistPilha.length - 1) { tgHistPilha.pop(); tgHistIgnorar++; window.history.back(); }
        else { tgHistPilha.splice(i, 1); }
        return;
      }
    }
  } catch (e) {}
}

// ---------------------------------------------------------------- overlay
function tgOvFocaveis() {
  var todos = tgOv.raiz.querySelectorAll('a[href],button,input'), out = [], i;
  for (i = 0; i < todos.length; i++) { if (todos[i].offsetParent !== null || todos[i] === document.activeElement) { out.push(todos[i]); } }
  return out;
}

function tgOvMontar() {
  var raiz, painel, form, voltar, campo, limpar, enviar, corpo, caixa, status, espera = null;
  injetarEstilos();
  campo = el('input', { type: 'search', 'class': 'tg-busca-ov-campo', 'aria-label': 'Buscar peças' });
  tgAttr(campo, { name: 'q', placeholder: 'Busque pelo nome, tipo ou cor', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search', inputmode: 'search', maxlength: '200' });
  voltar = el('button', { type: 'button', 'class': 'tg-busca-ov-btn tg-busca-ov-voltar', 'aria-label': 'Fechar a busca' }, [el('span', { 'class': 'tg-busca-ico-voltar', 'aria-hidden': 'true' })]);
  limpar = el('button', { type: 'button', 'class': 'tg-busca-ov-btn tg-busca-ov-limpar tg-busca-oculto', 'aria-label': 'Limpar o campo' }, ['×']);
  enviar = el('button', { type: 'submit', 'class': 'tg-busca-ov-btn tg-busca-ov-enviar', 'aria-label': 'Buscar' }, [el('span', { 'class': 'tg-busca-ico-lupa', 'aria-hidden': 'true' })]);
  form = el('form', { 'class': 'tg-busca-ov-form', role: 'search' }, [voltar, campo, limpar, enviar]);
  tgAttr(form, { action: '/search/', method: 'get' });
  caixa = el('div', { id: 'tg-busca-sugestoes' });
  status = el('div', { 'class': 'tg-busca-sr', role: 'status', 'aria-live': 'polite' });
  corpo = el('div', { 'class': 'tg-busca-ov-corpo' }, [tgConselheira(), caixa, status]);
  painel = el('div', { 'class': 'tg-busca-ov-painel' }, [form, corpo]);
  raiz = el('div', { id: 'tg-busca-overlay', 'class': 'tg-busca-oculto', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Busca' }, [painel]);
  tgOv = { raiz: raiz, campo: campo, caixa: caixa, corpo: corpo, limpar: limpar, status: status, aberto: false, pegarCaixa: function () { return tgOv ? tgOv.caixa : null; } };

  function atualizar(ja) {
    var v = campo.value.trim();
    if (v) { limpar.classList.remove('tg-busca-oculto'); } else { limpar.classList.add('tg-busca-oculto'); }
    clearTimeout(espera);
    if (ja) { tgAcDesenhar(tgOv.pegarCaixa, campo, v); return; }
    espera = setTimeout(function () { try { tgAcDesenhar(tgOv.pegarCaixa, campo, v); } catch (e) {} }, TG_AC_ESPERA);
  }
  tgOv.atualizar = atualizar;
  // o teclado desce quando a cliente rola a lista (as pecas ficam a vista)
  corpo.addEventListener('touchmove', function () { try { if (document.activeElement === campo) { campo.blur(); } } catch (e) {} }, { passive: true });
  // o texto tambem vai para o campo nativo do tema (sem disparar eventos): se a busca nova desistir, a nativa ja tem o que foi digitado
  campo.addEventListener('input', function () { try { if (tgOv && tgOv.nativo) { tgOv.nativo.value = campo.value; } } catch (e) {} try { atualizar(false); } catch (e) {} });
  voltar.addEventListener('click', function () { try { tgOvFechar(); } catch (e) {} });
  limpar.addEventListener('click', function () { try { campo.value = ''; atualizar(true); campo.focus(); } catch (e) {} });
  form.addEventListener('submit', function (ev) {
    var v = campo.value.trim();
    if (!v) { try { ev.preventDefault(); } catch (e) {} return; }
    tgRecSalvar(v);
  });
  raiz.addEventListener('click', function (ev) { if (ev.target === raiz) { try { tgOvFechar(); } catch (e) {} } });
  raiz.addEventListener('keydown', function (ev) {
    var f, ini, fim;
    try {
      if (ev.key === 'Escape') { tgOvFechar(); return; }
      if (ev.key !== 'Tab') { return; }
      f = tgOvFocaveis();
      if (!f.length) { return; }
      ini = f[0]; fim = f[f.length - 1];
      if (ev.shiftKey && document.activeElement === ini) { fim.focus(); ev.preventDefault(); }
      else if (!ev.shiftKey && document.activeElement === fim) { ini.focus(); ev.preventDefault(); }
    } catch (e) {}
  });
  document.body.appendChild(raiz);
  return tgOv;
}

// Abre o overlay (monta na primeira vez). "valor" (opcional): texto que ja estava no campo nativo do tema.
function tgOvAbrir(valor, nativo) {
  var ja;
  if (!tgOv) { tgOvMontar(); }
  if (nativo) { tgOv.nativo = nativo; }
  ja = tgOv.aberto;
  tgOv.aberto = true;
  tgOv.raiz.classList.remove('tg-busca-oculto');
  tgOv.raiz.classList.add('tg-busca-aberto');
  document.documentElement.classList.add('tg-busca-trava');
  if (typeof valor === 'string' && (!ja || tgOv.campo.value !== valor)) { tgOv.campo.value = valor; }
  // a entrada do Voltar vem antes de desenhar o conteudo (uma falha ao desenhar nao pode deixar a busca sem o Voltar)
  if (!ja) { tgHistAbrir('busca', function () { try { tgOvFechar(true); } catch (e) {} }); }
  try { tgOv.atualizar(true); } catch (e) { dbg('overlay', e); }
  try { tgOv.campo.focus(); } catch (e) {}
}

// Sem catalogo: o overlay sai sem fechar o modal nativo (a busca nativa assume na hora, com o foco no campo dela).
function tgOvDesistir(nativo) {
  var st, estava;
  tgAcDesistiu = true;
  if (!tgOv) { return; }
  estava = tgOv.aberto;
  if (estava) { tgHistFechar('busca'); }
  // sem rastro (falha fechada): o overlay sai do DOM e, se nada mais da busca nova esta na pagina, os estilos tambem
  try { if (nativo && tgOv.campo.value && !nativo.value) { nativo.value = tgOv.campo.value; } } catch (e) {}
  try { if (tgOv.raiz.parentNode) { tgOv.raiz.parentNode.removeChild(tgOv.raiz); } } catch (e) {}
  tgOv = null;
  document.documentElement.classList.remove('tg-busca-trava');
  try { if (!document.querySelector('#tg-busca-resultados, #tg-busca-resgate, #tg-busca-curada')) { st = document.getElementById('tg-busca-estilos'); if (st && st.parentNode) { st.parentNode.removeChild(st); } } } catch (e) {}
  try { if (estava && nativo && nativo.focus) { nativo.focus(); } } catch (e) {}
}

function tgOvFechar(peloVoltar) {
  var nav, fechar;
  if (!tgOv || !tgOv.aberto) { return; }
  tgOv.aberto = false;
  if (!peloVoltar) { tgHistFechar('busca'); }
  tgOv.raiz.classList.add('tg-busca-oculto');
  tgOv.raiz.classList.remove('tg-busca-aberto');
  document.documentElement.classList.remove('tg-busca-trava');
  try { tgOv.campo.blur(); } catch (e) {}
  // o modal nativo do tema ficou aberto por baixo: fecha com o proprio botao dele (clique normal, nada e cancelado)
  try {
    nav = document.getElementById('nav-search');
    fechar = nav ? nav.querySelector('.js-modal-close') : null;
    if (fechar && window.getComputedStyle(nav).display !== 'none') { fechar.click(); }
  } catch (e) {}
}

// falha fechada: sem catalogo, nada da busca nova fica na pagina (nem a area de toque da lupa)
function tgLupaTirar() { try { var st = document.getElementById('tg-busca-lupa'); if (st && st.parentNode) { st.parentNode.removeChild(st); } } catch (e) {} }
// A busca nova desistiu depois de a lupa ter sido tocada: a lupa passa a abrir a busca nativa, e ela abre agora (se ainda nao estiver aberta).
var tgLupaNativa = false;
function tgAbrirNativa() {
  var nav, b;
  try {
    tgLupaNativa = true;
    tgLupaTirar();
    nav = document.getElementById('nav-search');
    if (nav && nav.classList.contains('modal-show')) { return; }
    b = document.querySelector('.js-search-button');
    if (b) { b.click(); }
  } catch (e) {}
}

function ligarAutocomplete() {
  var inputs = document.querySelectorAll('.js-search-input'), tocou = false, botoes, i;
  if (!inputs || !inputs.length) { return; }
  function primeira() { if (!tocou) { tocou = true; obterCatalogo(); } }
  // v12 (Danilo, 24/11): o overlay abre NO TOQUE, sem esperar o catalogo (antes, no 4G, a busca nativa ficava segundos na tela). O que depende do
  // catalogo (vitrine, pecas) chega depois, com esqueleto. Sem catalogo (falha ou tempo esgotado), o overlay sai e a busca nativa assume, com o foco no campo dela.
  function abrir(nativo) {
    if (tgAcDesistiu) { return; }
    tgPend(true);
    try { tgOvAbrir(nativo.value, nativo); } catch (e) {}
    obterCatalogo().then(function (cat) {
      tgPend(false);
      if (!cat) { tgOvDesistir(nativo); tgAbrirNativa(); }
    })['catch'](function () { tgPend(false); tgOvDesistir(nativo); tgAbrirNativa(); });
  }
  function ligar(nativo) {
    nativo.addEventListener('focus', function () {
      try {
        primeira();
        if (tgOv && tgOv.aberto) { tgOv.campo.focus(); return; } // o tema devolveu o foco ao campo nativo: o foco volta para o overlay
        abrir(nativo);
      } catch (e) {}
    });
    nativo.addEventListener('input', function () {
      try {
        primeira();
        if (tgOv && tgOv.aberto) { tgOv.campo.value = nativo.value; tgOv.atualizar(false); return; }
        abrir(nativo);
      } catch (e) {}
    });
  }
  for (i = 0; i < inputs.length; i++) { ligar(inputs[i]); }
  // v15: aquece catalogo, Novidades e Conjuntos logo depois da pagina carregar (quando o aparelho estiver ocioso), para a vitrine abrir no toque
  try {
    (function () {
      function aquecer() { tocou = true; tgTapeteAquecer(); try { obterCatalogo().then(function (c) { if (!c) { tgLupaTirar(); } }, function () { tgLupaTirar(); }); } catch (e) {} }
      function ja() { var ric = window.requestIdleCallback; if (typeof ric === 'function') { ric(aquecer, { timeout: 2500 }); } else { setTimeout(aquecer, 1200); } }
      if (document.readyState === 'complete') { ja(); } else { window.addEventListener('load', ja); }
    })();
  } catch (e) {}
  // a cliente tocou na lupa antes de a busca nova chegar: o modal nativo ja esta aberto, entao a nossa abre por cima dele agora
  try {
    (function () {
      var nav = document.getElementById('nav-search'), campo = nav ? nav.querySelector('.js-search-input') : null;
      var cs = campo ? window.getComputedStyle(nav) : null, r = campo ? nav.getBoundingClientRect() : null;
      if (campo && nav.classList.contains('modal-show') && cs.display !== 'none' && cs.visibility !== 'hidden' && r.height > 0 && r.bottom > 0 && r.top < (window.innerHeight || 0)) { primeira(); abrir(campo); }
    })();
  } catch (e) {}
  // QA 6.1 (25/11): com a busca nova ligada, a lupa abre SO o nosso overlay: o clique nao chega ao tema (o #nav-search e as classes de bloqueio do
  // body nao entram). Se a busca nova desistir (catalogo fora), a lupa volta a abrir a nativa (tgLupaNativa).
  // o tema abre a nativa no touchend e no click da lupa: os dois sao interceptados (o toque abre a nossa; o click que vem logo depois so e engolido)
  var tgLupaUltimo = 0;
  function tgLupaToque(ev) {
    var b, campo;
    try {
      b = ev.target && ev.target.closest ? ev.target.closest('.js-search-button') : null;
      if (!b || tgAcDesistiu || tgLupaNativa) { return; }
      campo = document.querySelector('#nav-search .js-search-input') || inputs[0];
      if (!campo) { return; }
      ev.preventDefault(); ev.stopPropagation(); if (ev.stopImmediatePropagation) { ev.stopImmediatePropagation(); }
      if (Date.now() - tgLupaUltimo < 700) { return; }
      tgLupaUltimo = Date.now();
      primeira();
      if (tgOv && tgOv.aberto) { tgOv.campo.focus(); return; }
      abrir(campo);
    } catch (e) {}
  }
  document.addEventListener('touchend', tgLupaToque, true);
  document.addEventListener('click', tgLupaToque, true);
  botoes = document.querySelectorAll('.js-search-button');
  // QA 7.1 (25/11): a lupa do topo tem 36x49 px; uma area invisivel em volta leva o toque para 48x48 (o desenho nao muda). Entra ja no inicio.
  try { if (!document.getElementById('tg-busca-lupa')) { var stl = document.createElement('style'); stl.id = 'tg-busca-lupa'; stl.textContent = '.js-search-button{position:relative}.js-search-button::before{content:"";position:absolute;top:50%;left:50%;width:48px;height:48px;margin:-24px 0 0 -24px}'; document.head.appendChild(stl); } } catch (e) {}
  for (i = 0; i < botoes.length; i++) {
    // pointerdown vem antes do click: o pedido do catalogo (L21) sai um pouco mais cedo, sem passar a pedir nada sem interacao (L6)
    botoes[i].addEventListener('pointerdown', function () { try { if (tgAcDesistiu) { return; } primeira(); injetarEstilos(); tgPend(true); setTimeout(function () { tgPend(false); }, 5000); } catch (e) {} }, { passive: true });
    botoes[i].addEventListener('click', function () { try { primeira(); } catch (e) {} });
  }
}

/* ---- src/injetor/resgate.js ---- */
/*
 * Pagina /search/?q=... (redesign 18/11/2026). Origem: initSearchPageRescue do protótipo, reescrito sem HTML cru
 * (o ponto 10 da pesquisa, o termo da URL no titulo, era XSS refletido por link). O termo da URL entra so como texto.
 *
 * Tres telas, todas com o contêiner reservado #tg-busca-conselheira (vazio, escondido) para o bloco da IA:
 *   1. RESULTADOS (tgPgMontar): barra no topo (contagem, Ordenar, Tamanho, alternar grade 1/2 colunas, chips Em alta) e grade de cards.
 *      A lista nativa so some DEPOIS que a nossa foi montada (falha em qualquer ponto = a nativa continua na tela). Interruptor: features.resultados === false
 *      (no contexto do carregador) volta ao comportamento antigo (so resgate quando nao ha resultado nativo).
 *   2. SEM RESULTADO (tgRgMontar): editar a busca, termos proximos, chips Em alta, pecas populares.
 *   3. ESGOTADO NOMINAL e BUSCA CURADA: como antes, com os cards novos.
 * Card (tgRgCard): foto, selo unico, bolinhas de cor dos irmaos (abrem o quick view), nome, preco, tamanhos em estoque clicaveis e botao
 * "Adicionar" (so com tamanho escolhido). Os pacotes M (tgAgruparCores, tgOrdenar, tgFiltrar, TG_CHIPS_EM_ALTA) e Q (tgQuickViewAbrir,
 * tgQuickViewPrefetch, tgVariantesDoProduto, tgAdicionarSacola) sao chamados de forma defensiva (typeof ... === 'function').
 */
var TG_RG_LIMITE = 4;
var TG_RG_ESG_LIMITE = 12; // esgotado nominal (v14): a esgotada vira frase; ate 12 parecidas do mesmo tipo
var TG_PG_LIMITE = 1000;  // a pagina de resultados recebe a lista inteira; os cards entram em lotes
var TG_PG_LOTE = 24;
var TG_PG_ESCONDE_NATIVO = true;
var TG_PG_BEST_MAX = 8;   // Best Sellers por categoria: quantas pecas em cada "Mais Vendidos em ..."
var TG_PG_BOLINHAS_MAX = 5; // 5 bolinhas de 22px + o "+N" cabem numa linha do card de 2 colunas no celular (auditoria A16)
var TG_PG_ORDENS = [['relevancia', 'Relevância'], ['melhores-ofertas', 'Melhores Ofertas'], ['lancamentos', 'Lançamentos'], ['best-sellers', 'Mais Vendidos']];
var TG_PG_TAM_ORDEM = ['XPP', 'PP', 'P', 'M', 'G', 'GG', 'XG', 'XGG', 'U'];
var tgCorConhecidas = null;

// Troca o texto de um no (sem textContent, que o DOM falso dos testes nao aceita gravar).
function tgTexto(no, texto) {
  while (no.firstChild) { no.removeChild(no.firstChild); }
  no.appendChild(document.createTextNode(String(texto)));
}

// ---------------------------------------------------------------- cores e agrupamento (pacote M)
// Slug da cor para o atributo data-cor (a cor da bolinha vem do CSS, sem style). Nome fora da tabela de tons vira "outro".
function tgCorSlug(cor) {
  var s = String(cor == null ? '' : cor), i, j;
  s = (typeof normalizeText === 'function' ? normalizeText(s) : s.toLowerCase()).replace(/ /g, '-');
  if (!/^[a-z0-9-]{1,30}$/.test(s)) { return 'outro'; }
  if (typeof TG_COR_TONS !== 'undefined') {
    if (!tgCorConhecidas) {
      tgCorConhecidas = {};
      for (i = 0; i < TG_COR_TONS.length; i++) { for (j = 0; j < TG_COR_TONS[i][0].length; j++) { tgCorConhecidas[TG_COR_TONS[i][0][j]] = 1; } }
    }
    if (tgCorConhecidas[s] !== 1) { return 'outro'; }
  }
  return s;
}

// Mapa id -> { modelo, cor, irmaos } do motor (agrupa so pelo modelo: 75 modelos aparecem em mais de uma categoria). null se o motor nao tem a funcao.
function tgGruposCores(lista) {
  try { if (typeof tgAgruparCores === 'function') { return tgAgruparCores(lista, { ignorarCategoria: true }) || null; } } catch (e) {}
  return null;
}
function tgGrupoDe(mapa, item) {
  if (!mapa || !item || item.id == null) { return null; }
  try { return (typeof mapa.get === 'function' ? mapa.get(item.id) : mapa[item.id]) || null; } catch (e) { return null; }
}

// ---------------------------------------------------------------- sacola e quick view (pacote Q)
// Adiciona 1 unidade do tamanho escolhido. Sempre devolve uma promessa { ok } (nunca rejeita). Sem o pacote Q, ok = false e o card cai no link da peca.
function tgRgAdicionar(item, rotulo) {
  var alvo = String(rotulo).trim().toUpperCase();
  try {
    if (typeof tgVariantesDoProduto !== 'function' || typeof tgAdicionarSacola !== 'function') { return Promise.resolve({ ok: false }); }
    return Promise.resolve(tgVariantesDoProduto(item)).then(function (v) {
      var i, t;
      if (!v || !v.ok || !Array.isArray(v.tamanhos)) { return { ok: false }; }
      for (i = 0; i < v.tamanhos.length; i++) {
        t = v.tamanhos[i];
        if (t && String(t.rotulo).trim().toUpperCase() === alvo) {
          if (!t.disponivel || !t.variantId) { return { ok: false, semTamanho: true }; }
          return Promise.resolve(tgAdicionarSacola(t.variantId, 1, { abrirSacola: false })).then(function (r) { return { ok: !!(r && r.ok) }; });
        }
      }
      return { ok: false, semTamanho: true };
    })['catch'](function () { return { ok: false }; });
  } catch (e) { return Promise.resolve({ ok: false }); }
}

function tgRgPrefetch(item) { try { if (typeof tgQuickViewPrefetch === 'function') { tgQuickViewPrefetch(item); } } catch (e) {} }

// Abre o quick view da cor clicada; sem o pacote Q (ou se ele falhar) leva para a pagina da peca.
function tgRgAbrirQuickView(item, irmaos, tamanho, foco) {
  var href;
  try {
    if (typeof tgQuickViewAbrir === 'function') {
      tgQuickViewAbrir(item, { irmaos: irmaos, tamanhoInicial: tamanho || null, aoFechar: function () { try { if (foco && foco.focus) { foco.focus(); } } catch (e) {} }, origem: 'busca' });
      return;
    }
  } catch (e) {}
  href = urlProduto(item.s);
  if (href) { try { window.location.assign(href); } catch (e2) {} }
}

// ---------------------------------------------------------------- card
// Bolinhas de cor dos irmaos do modelo (v12, Danilo 24/11): so informacao visual, sem clique (a escolha de cor e tamanho fica no modal).
// Menos de 2 cores, ou sem o agrupamento do motor = sem bolinhas.
function tgRgCores(p, op) {
  var g = tgGrupoDe(op && op.mapa, p), lista = [], bolas = [], nomes = [], i, ir, gi, cor, atual;
  if (!g || !Array.isArray(g.irmaos)) { return null; }
  atual = typeof normalizeText === 'function' ? normalizeText(g.cor || '') : '';
  for (i = 0; i < g.irmaos.length; i++) {
    ir = g.irmaos[i];
    gi = tgGrupoDe(op.mapa, ir);
    cor = gi && typeof gi.cor === 'string' ? gi.cor : '';
    if (ir && urlProduto(ir.s) && cor) { lista.push({ item: ir, cor: cor }); }
  }
  if (lista.length < 2) { return null; }
  for (i = 0; i < lista.length && i < TG_PG_BOLINHAS_MAX; i++) {
    bolas.push(el('span', { 'class': 'tg-busca-bolinha' + (lista[i].item === p || (atual && normalizeText(lista[i].cor) === atual) ? ' tg-busca-bolinha-atual' : '') + (tgDisponivel(lista[i].item) ? '' : ' tg-busca-bolinha-esgotada'), 'data-cor': tgCorSlug(lista[i].cor), 'aria-hidden': 'true' }));
    nomes.push(lista[i].cor);
  }
  if (lista.length > TG_PG_BOLINHAS_MAX) { bolas.push(el('span', { 'class': 'tg-busca-bolinha-mais', 'aria-hidden': 'true' }, ['+' + (lista.length - TG_PG_BOLINHAS_MAX)])); }
  return el('div', { 'class': 'tg-busca-cores', role: 'img', 'aria-label': 'Cores: ' + nomes.join(', ') + (lista.length > TG_PG_BOLINHAS_MAX ? ' e mais ' + (lista.length - TG_PG_BOLINHAS_MAX) : '') }, bolas);
}

// Tamanhos em estoque (so informacao, sem clique) e o botao VER PECA, o unico que abre o modal (v12, Danilo 24/11).
// Na busca por tamanho ("vestido G") o tamanho pedido vem marcado e ja chega escolhido no modal.
function tgRgVer(p, op) {
  var tams = [], i, v, ver, pedido = null, destaque = {}, k, irmaos;
  if (Array.isArray(op && op.destaque)) { for (k = 0; k < op.destaque.length; k++) { if (typeof op.destaque[k] === 'string') { destaque[op.destaque[k].toUpperCase()] = true; } } }
  if (tgDisponivel(p) && Array.isArray(p.sz)) {
    for (i = 0; i < p.sz.length && i < 12; i++) {
      v = p.sz[i];
      if (typeof v !== 'string' || !v) { continue; }
      if (destaque[v.toUpperCase()] && !pedido) { pedido = v; }
      tams.push(el('span', { 'class': 'tg-busca-tam' + (destaque[v.toUpperCase()] ? ' tg-busca-tam-pedido' : '') }, [v]));
    }
  }
  irmaos = (tgGrupoDe(op && op.mapa, p) || {}).irmaos || [p];
  ver = el('button', { type: 'button', 'class': 'tg-busca-add tg-busca-ver', 'aria-label': 'Ver peça: ' + p.n }, ['Ver peça']);
  ver.addEventListener('click', function () {
    try { tgRgAbrirQuickView(p, irmaos, pedido, ver); } catch (e) {}
    try { emitir('tg_busca_ver_peca', { position: (op && op.posicao) || 0 }); } catch (e2) {}
  });
  ver.addEventListener('pointerdown', function () { tgRgPrefetch(p); });
  return { tams: tams.length ? el('div', { 'class': 'tg-busca-tams', role: 'img', 'aria-label': 'Tamanhos em estoque: ' + p.sz.join(', ') }, tams) : el('div', { 'class': 'tg-busca-tams tg-busca-tams-vazio', 'aria-hidden': 'true' }), ver: ver };
}

// Card da peca. "info" (opcional): o selo do motor (false = sem selo; undefined = nao mostra selo nenhum). "tamanhos" (opcional): tamanho pedido na busca.
// "op" (opcional): { mapa (tgAgruparCores), posicao, esgotada: true (card simples, sem tamanhos nem botao) }.
// Estrutura fixa (foto, cores, nome em 2 linhas, tamanhos, preco, VER PECA): cards de nome curto e longo ficam alinhados na mesma linha da grade.
function tgRgCard(p, info, tamanhos, op) {
  var href = urlProduto(p.s), preco = blocoPreco(p), selo, imagem, esgotada, card, filhos, cores, ver, i, pf, pp;
  if (!href || !preco) { return null; }
  op = op || {};
  esgotada = !!op.esgotada || !tgDisponivel(p);
  selo = info === undefined ? null : tgAcSelo(p, info);
  if (!selo && info !== undefined && esgotada) { selo = tgAcSelo(p, { tipo: 'esgotado', texto: typeof TG_SELO_ESGOTADO !== 'undefined' ? TG_SELO_ESGOTADO : 'Tamanho esgotado' }); }
  imagem = foto(p, 'tg-busca-thumb') || el('span', { 'class': 'tg-busca-thumb' });
  card = el('div', { 'class': esgotada && (op.esgotada || info !== undefined) ? 'tg-busca-card tg-busca-card-esgotado' : 'tg-busca-card' });
  pf = el('a', { 'class': 'tg-busca-card-link', href: href, 'aria-hidden': 'true' }, [imagem]);
  pf.setAttribute('tabindex', '-1');
  pp = el('a', { 'class': 'tg-busca-card-link tg-busca-card-preco', href: href, 'aria-hidden': 'true' }, [preco]);
  pp.setAttribute('tabindex', '-1');
  filhos = [
    el('div', { 'class': 'tg-busca-card-midia' }, [pf, selo]),
    el('a', { 'class': 'tg-busca-card-link tg-busca-card-texto', href: href }, [el('div', { 'class': 'tg-busca-nome' }, [p.n])])
  ];
  if (!op.esgotada) {
    cores = tgRgCores(p, op);
    // sem outras cores: o espaco das bolinhas fica reservado (o grid nao muda de altura)
    if (!cores) { cores = el('div', { 'class': 'tg-busca-cores tg-busca-cores-vazio', 'aria-hidden': 'true' }); }
    filhos.splice(1, 0, cores);
    ver = tgRgVer(p, { posicao: op.posicao, destaque: tamanhos, mapa: op.mapa });
    filhos.push(ver.tams);
    filhos.push(pp);
    filhos.push(ver.ver);
  } else { filhos.push(pp); }
  for (i = 0; i < filhos.length; i++) { if (filhos[i]) { card.appendChild(filhos[i]); } }
  card.addEventListener('pointerdown', function () { tgRgPrefetch(p); });
  // v15 (Danilo, 25/11): com o modal, tocar no card nao leva mais para a pagina da peca (o toque acidental gerava frustracao): abre o modal, igual ao VER PECA.
  // Ctrl/Cmd + clique (abrir em nova aba) continua indo para a pagina.
  if (ver) {
    card.addEventListener('click', function (ev) {
      var a;
      try {
        a = ev.target && ev.target.closest ? ev.target.closest('a.tg-busca-card-link') : null;
        if (!a || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button > 0) { return; }
        ev.preventDefault();
        ver.ver.click();
      } catch (e) {}
    });
  }
  return card;
}

// ---------------------------------------------------------------- busca curada (blocos), esgotado nominal e sem resultado
// v14 (Danilo, 24/11): toda tela da busca usa o nosso titulo e a nossa tipografia; somem o "Resultados da pesquisa" / "Não encontramos nada para",
// o "Exibindo resultados para:", o "Escreva de outro jeito" e o "Mostrar mais produtos" da Nuvem. lista: true tambem esconde a lista nativa.
function tgRgEsconderNativos(lista) {
  var sels = ['.js-load-more', '#js-infinite-scroll-spinner', '[data-store="page-title"]'], i, n;
  if (lista) { sels.push('.js-product-table'); }
  try {
    for (i = 0; i < sels.length; i++) { n = document.querySelector(sels[i]); if (n) { n.classList.add('tg-busca-nativo-oculto'); } }
    n = document.querySelector('.category-body h2');
    if (n && /exibindo resultados/i.test(n.textContent || '')) { n.classList.add('tg-busca-nativo-oculto'); }
    n = document.querySelectorAll('.category-body .my-4');
    for (i = 0; i < n.length; i++) { if (/escreva de outro jeito/i.test(n[i].textContent || '')) { n[i].classList.add('tg-busca-nativo-oculto'); } }
  } catch (e) {}
}
function tgRgDestino() { return document.querySelector('.category-body') || document.querySelector('main') || document.body; }

// Pagina /search de uma busca curada (wedding, casamento...): os blocos completos, cada um com titulo, no topo da area de resultados.
// Nao tira nada da pagina nativa (a lista nativa so some se TG_CURADA_ESCONDE_NATIVO for true). Devolve true se montou.
function tgCuMontar(res) {
  var secoes = [], filhos = [tgConselheira()], b, i, c, cards, item, total = 0, destaque, destino, caixa, nativo, mapa;
  destaque = res.tamanho && res.tamanho.aplicado ? res.tamanho.aceitos : null;
  mapa = tgGruposCores(res.results);
  for (b = 0; b < res.curada.blocos.length; b++) {
    cards = [];
    for (i = 0; i < res.curada.blocos[b].itens.length; i++) {
      item = res.curada.blocos[b].itens[i];
      c = tgRgCard(item, res.selos ? (res.selos.get(item) || false) : false, destaque, { mapa: mapa, posicao: total + cards.length + 1 });
      if (c) { cards.push(c); }
    }
    if (cards.length) {
      total += cards.length;
      secoes.push(el('section', { 'class': 'tg-busca-bloco', 'data-bloco': res.curada.blocos[b].id }, [
        tgBlocoTitulo(res.curada.blocos[b].titulo, cards.length, 'h2'),
        el('div', { 'class': 'tg-busca-grade' }, cards)
      ]));
    }
  }
  if (!secoes.length) { return false; }
  if (res.tamanho) { filhos.push(tgAcAviso(res.tamanho)); }
  caixa = el('div', { id: 'tg-busca-curada', 'class': 'tg-busca-curada container' }, filhos.concat(secoes));
  destino = tgRgDestino();
  if (!destino) { return false; }
  injetarEstilos();
  destino.insertBefore(caixa, destino.firstChild || null);
  if (TG_CURADA_ESCONDE_NATIVO) {
    nativo = document.querySelector('.js-product-table');
    if (nativo) { nativo.classList.add('tg-busca-nativo-oculto'); }
  }
  tgRgEsconderNativos(false);
  emitir('tg_busca_resgate_view', { rescue_type: 'curada', results_count: total });
  return true;
}

// Esgotado nominal na pagina /search (REL-04; v14, Danilo 24/11): a esgotada NAO vira card (nao ocupa o lugar de peca disponivel); vira so a frase
// "A peça “X” está esgotada, confira outras opções abaixo:" e as parecidas sobem para a primeira dobra (ate TG_ESG_SIMILARES, do mesmo tipo, grade
// cheia; regra no motor). No fim, "Mais opções de Vestidos" leva para a categoria do tipo. Devolve true se montou.
function tgRgMontarEsgotado(q, res) {
  var e = res.esgotado, cards = [], i, c, destino, caixa, mapa = tgGruposCores(e.similares), cat, mais = null;
  for (i = 0; i < e.similares.length; i++) {
    c = tgRgCard(e.similares[i], res.selos ? (res.selos.get(e.similares[i]) || false) : false, null, { mapa: mapa, posicao: cards.length + 1 });
    if (c) { cards.push(c); }
  }
  if (!cards.length) { return false; }
  cat = typeof tgCategoriaDoTipo === 'function' ? tgCategoriaDoTipo(e.tipo) : null;
  if (cat) { mais = el('a', { 'class': 'tg-busca-mais tg-busca-mais-link', href: cat.url }, ['Mais opções de ' + cat.rotulo]); }
  caixa = el('div', { id: 'tg-busca-resgate', 'class': 'tg-busca-zero tg-busca-esg container' }, [
    tgConselheira(),
    tgEsgFrase(e),
    el('div', { 'class': 'tg-busca-grade' }, cards),
    mais
  ]);
  destino = tgRgDestino();
  if (!destino) { return false; }
  injetarEstilos();
  destino.insertBefore(caixa, destino.firstChild || null);
  tgRgEsconderNativos(!!TG_PG_ESCONDE_NATIVO);
  emitir('tg_busca_resgate_view', { rescue_type: 'esgotado', results_count: cards.length });
  return true;
}

// Formulario para editar a busca (GET normal para a busca da loja; o termo da URL entra so como valor do campo).
function tgRgForm(q) {
  var campo = el('input', { type: 'search', 'class': 'tg-busca-zero-campo', 'aria-label': 'Buscar peças' }), form;
  tgAttr(campo, { name: 'q', value: q, placeholder: 'Buscar outra peça', autocomplete: 'off', maxlength: '200' });
  form = el('form', { 'class': 'tg-busca-zero-form', role: 'search' }, [campo, el('button', { type: 'submit', 'class': 'tg-busca-zero-ok' }, ['Buscar'])]);
  tgAttr(form, { action: '/search/', method: 'get' });
  campo.addEventListener('focus', function () { try { if (typeof tgOvAbrir === 'function') { campo.blur(); tgOvAbrir(campo.value); } } catch (e) {} });
  return form;
}

// Termos proximos: palavras do catalogo que comecam como o inicio do que foi digitado ("vestdo" -> vestido).
function tgRgTermosProximos(q, cat) {
  var base = typeof normalizeText === 'function' ? normalizeText(q).split(' ')[0] : '', termos, nos = [], i;
  if (!base || base.length < 3) { return null; }
  termos = tgAcTermos(base.slice(0, Math.min(4, base.length)), cat);
  for (i = 0; i < termos.length && nos.length < 5; i++) {
    nos.push(el('li', null, [el('a', { 'class': 'tg-busca-chip', href: urlBusca(termos[i].texto) }, [termos[i].texto])]));
  }
  return nos.length ? el('div', { 'class': 'tg-busca-termos-proximos' }, [el('div', { 'class': 'tg-busca-secao-titulo' }, ['Termos próximos']), el('ul', { 'class': 'tg-busca-chips' }, nos)]) : null;
}

function tgRgMontar(q, cat, esg) {
  var res, cards = [], i, c, desc, tipo, destino, caixa, filhos, chips, proximos, mapa, descTopo = null, descGrade = null;
  if (esg) {
    res = runSearch(q, cat, TG_RG_ESG_LIMITE, esg);
    if (res.esgotado && tgRgMontarEsgotado(q, res)) { return; }
  }
  res = runSearch(q, cat, TG_RG_LIMITE);
  // nada casou (termo sem sentido): as pecas populares sao as primeiras do catalogo (a ordem dele e a de vendas), em estoque
  if (!res.results.length) { res = runSearch('', cat, TG_RG_LIMITE); res.suggestedTerm = null; res.tamanho = null; }
  mapa = tgGruposCores(res.results);
  for (i = 0; i < res.results.length; i++) {
    c = tgRgCard(res.results[i], undefined, null, { mapa: mapa, posicao: cards.length + 1 });
    if (c) { cards.push(c); }
  }
  if (res.suggestedTerm) {
    tipo = 'voce_quis_dizer';
    descTopo = el('div', { 'class': 'tg-busca-zero-desc' }, ['Você quis dizer: ', el('a', { href: urlBusca(res.suggestedTerm) }, [res.suggestedTerm]), '?']);
  } else {
    tipo = 'campeoes';
    descGrade = el('div', { 'class': 'tg-busca-zero-desc' }, [res.tamanho && res.tamanho.aplicado ? 'Confira as peças no tamanho ' + res.tamanho.rotulo + ' disponíveis para envio imediato:' : 'Confira os Mais Vendidos disponíveis para envio imediato:']);
  }
  proximos = tgRgTermosProximos(q, cat);
  chips = tgChipsLista('zero');
  if (chips && typeof tgAcChipConjSeHouver === 'function') { tgAcChipConjSeHouver(chips); }
  filhos = [tgConselheira(), el('h1', { 'class': 'tg-busca-voce tg-busca-zero-titulo' }, ['Não encontramos “' + q + '”']), descTopo, tgRgForm(q), proximos];
  if (chips) { filhos.push(el('div', { 'class': 'tg-busca-secao-titulo' }, ['Em alta'])); filhos.push(chips); }
  filhos.push(descGrade);
  var gradeZero = el('div', { 'class': 'tg-busca-grade' }, cards);
  filhos.push(gradeZero);
  // QA 4.2 (25/11): sem o "voce quis dizer", a vitrine de resgate vira "Novidades da semana" (8 pecas em estoque) assim que a lista chegar
  if (!res.suggestedTerm && typeof tgPgNovidades === 'function' && typeof tgNovidadesItens === 'function') {
    tgPgNovidades().then(function (h) {
      var its = tgNovidadesItens(cat, h, 8), mp, j, cc, novos = [];
      try {
        if (!its.length || !gradeZero.parentNode) { return; }
        mp = tgGruposCores(cat);
        for (j = 0; j < its.length; j++) { cc = tgRgCard(its[j], undefined, null, { mapa: mp, posicao: j + 1 }); if (cc) { novos.push(cc); } }
        if (!novos.length) { return; }
        while (gradeZero.firstChild) { gradeZero.removeChild(gradeZero.firstChild); }
        novos.forEach(function (n) { gradeZero.appendChild(n); });
        if (descGrade) { tgTexto(descGrade, 'Novidades da semana, disponíveis para envio imediato:'); }
      } catch (e) {}
    }, function () {});
  }
  caixa = el('div', { id: 'tg-busca-resgate', 'class': 'tg-busca-zero container' }, filhos);
  destino = tgRgDestino();
  if (!destino) { return; }
  injetarEstilos();
  destino.insertBefore(caixa, destino.firstChild || null);
  tgRgEsconderNativos(false);
  emitir('tg_busca_resgate_view', { rescue_type: tipo, results_count: cards.length });
}

// ---------------------------------------------------------------- pagina de resultados
// Categoria Novidades (v12, 24/11): as 100 pecas mais novas da categoria inteira numa so leitura (results_only + limit; o ?mpage nao pagina nesta
// loja e trazia so 16). So leitura, mesma origem. Os handles ficam na sessao por 30 min (uma leitura por visita). Falha ou demora (8 s) = lista vazia:
// Novidades e Lancamentos simplesmente nao mudam nada.
var TG_NOV_LIMITE = 100;
var TG_NOV_CHAVE = 'tg_busca_nov';
var TG_NOV_VALIDADE = 30 * 60 * 1000;
var tgPgNovidadesCache = null;
function tgPgHandlesDoHtml(txt) {
  var saida = [], vistos = {}, doc, links, i, m;
  try {
    doc = new DOMParser().parseFromString(txt, 'text/html');
    links = doc.querySelectorAll('a[href*="/produtos/"]');
    for (i = 0; i < links.length; i++) {
      m = /\/produtos\/([a-z0-9][a-z0-9-]*)\/?/.exec(links[i].getAttribute('href') || '');
      if (m && urlProduto(m[1]) && !vistos[m[1]]) { vistos[m[1]] = true; saida.push(m[1]); }
    }
  } catch (e) {}
  return saida;
}
function tgPgNovidades() {
  var base = typeof TG_NOVIDADES_CATEGORIA === 'string' ? TG_NOVIDADES_CATEGORIA : '/novidades/', guardado, agora = Date.now(), h;
  if (tgPgNovidadesCache) { return tgPgNovidadesCache; }
  try {
    guardado = JSON.parse(window.sessionStorage.getItem(TG_NOV_CHAVE) || 'null');
    if (guardado && Array.isArray(guardado.h) && typeof guardado.t === 'number' && agora >= guardado.t && agora - guardado.t < TG_NOV_VALIDADE) {
      h = guardado.h.filter(function (x) { return typeof x === 'string' && !!urlProduto(x); }).slice(0, TG_NOV_LIMITE);
      if (h.length) { tgPgNovidadesCache = Promise.resolve(h); return tgPgNovidadesCache; }
    }
  } catch (e) {}
  tgPgNovidadesCache = new Promise(function (ok) {
    var feito = false, t = setTimeout(function () { fim([]); }, 8000);
    function fim(lista) {
      if (feito) { return; }
      feito = true; clearTimeout(t);
      if (!lista.length) { tgPgNovidadesCache = null; } else { try { window.sessionStorage.setItem(TG_NOV_CHAVE, JSON.stringify({ t: Date.now(), h: lista })); } catch (e) {} }
      ok(lista);
    }
    try {
      fetch(base + '?results_only=true&limit=' + TG_NOV_LIMITE, { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.text() : ''; }).then(function (txt) { fim(txt ? tgPgHandlesDoHtml(txt).slice(0, TG_NOV_LIMITE) : []); }, function () { fim([]); });
    } catch (e) { fim([]); }
  });
  return tgPgNovidadesCache;
}

// Conjuntos do Recom (v12, 24/11): GET /api/conjuntos (o par e a cor sao do Recom; o CDN dele guarda 1 dia). So ids e cor sao aproveitados; o resto
// (nome, foto, preco, tamanhos) vem do catalogo da busca, conferido na hora (tgConjuntosDoRecom). Guardado na sessao por 1 h. Falha = sem conjuntos:
// o chip e a faixa de Conjuntos simplesmente nao aparecem.
var TG_CONJUNTOS_URL = 'https://app-partners-recomendados.vercel.app/api/conjuntos';
var TG_CONJ_CHAVE = 'tg_busca_conj';
var TG_CONJ_VALIDADE = 60 * 60 * 1000;
var tgConjCache = null;
function tgConjValidar(d) {
  var out = [], i, c, cor;
  if (!d || typeof d !== 'object' || !Array.isArray(d.conjuntos)) { return null; }
  for (i = 0; i < d.conjuntos.length && out.length < 400; i++) {
    c = d.conjuntos[i];
    if (!c || !c.top || !c.bottom) { continue; }
    if (!/^\d{1,15}$/.test(String(c.top.id)) || !/^\d{1,15}$/.test(String(c.bottom.id))) { continue; }
    cor = typeof c.color === 'string' && c.color.length <= 40 ? c.color : '';
    out.push({ color: cor, top: { id: String(c.top.id) }, bottom: { id: String(c.bottom.id) } });
  }
  return out.length ? { conjuntos: out } : null;
}
function tgConjuntosBaixar() {
  var guardado, agora = Date.now(), v;
  if (tgConjCache) { return tgConjCache; }
  try {
    guardado = JSON.parse(window.sessionStorage.getItem(TG_CONJ_CHAVE) || 'null');
    if (guardado && typeof guardado.t === 'number' && agora >= guardado.t && agora - guardado.t < TG_CONJ_VALIDADE) {
      v = tgConjValidar(guardado.d);
      if (v) { tgConjCache = Promise.resolve(v); return tgConjCache; }
    }
  } catch (e) {}
  tgConjCache = new Promise(function (ok) {
    var feito = false, t = setTimeout(function () { fim(null); }, 5000);
    function fim(d) {
      if (feito) { return; }
      feito = true; clearTimeout(t);
      if (!d) { tgConjCache = null; } else { try { window.sessionStorage.setItem(TG_CONJ_CHAVE, JSON.stringify({ t: Date.now(), d: d })); } catch (e) {} }
      ok(d);
    }
    try {
      fetch(TG_CONJUNTOS_URL, { credentials: 'omit', mode: 'cors' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) { fim(tgConjValidar(j)); }, function () { fim(null); });
    } catch (e) { fim(null); }
  });
  return tgConjCache;
}
// Conjuntos prontos para a tela (lista vazia se o Recom nao respondeu ou nada passou na conferencia de estoque).
function tgConjuntosLista(cat) {
  return tgConjuntosBaixar().then(function (d) {
    try { return d && typeof tgConjuntosDoRecom === 'function' ? tgConjuntosDoRecom(cat, d) : []; } catch (e) { return []; }
  })['catch'](function () { return []; });
}
function tgEhBuscaConjuntos(q) {
  var n = typeof normalizeText === 'function' ? normalizeText(q || '') : String(q || '').toLowerCase().trim();
  return n === 'conjunto' || n === 'conjuntos';
}

// ---------------------------------------------------------------- card horizontal (v12, padrao do modal das Influenciadoras)
// Foto a esquerda; nome, bolinhas de cor, preco, tamanhos em estoque e "Detalhes da peca" a direita. Usado na tela inicial e na pagina de Conjuntos.
// op: { mapa (tgGruposCores), conjunto (o par: tocar em qualquer parte abre o modal do conjunto), posicao, secao, aoAbrir }.
function tgHCard(p, op) {
  var href = urlProduto(p.s), pr = precoFinal(p), mc, abrir, f, nome, det, cores = null, tams = [], i, card, corUnica, g, bolas = [], lista = [], gi, ir;
  if (!href || !pr) { return null; }
  op = op || {};
  mc = typeof tgModeloCor === 'function' ? tgModeloCor(p.n) : { modelo: p.n, cor: '' };
  abrir = function (no, alvo) {
    try {
      if (typeof op.aoAbrir === 'function') { op.aoAbrir(no, alvo || p); }
      else if (op.conjunto && typeof tgQuickViewConjunto === 'function') { tgQuickViewConjunto(op.conjunto, { aoFechar: function () { try { if (no && no.focus) { no.focus(); } } catch (e) {} }, origem: op.secao || 'conjuntos' }); }
      else { tgRgAbrirQuickView(alvo || p, op.irmaos || (tgGrupoDe(op.mapa, p) || {}).irmaos || [p], null, no); }
      emitir('tg_busca_tapete_click', { position: op.posicao || 0, reason: op.secao || '' });
    } catch (e) {}
  };
  // so o botao "Detalhes da peca" abre o modal (Danilo, 24/11); foto, nome e bolinhas sao so informacao
  f = el('div', { 'class': 'tg-busca-hc-foto', 'aria-hidden': 'true' }, [foto(p, 'tg-busca-thumb') || el('span', { 'class': 'tg-busca-thumb' })]);
  nome = el('p', { 'class': 'tg-busca-hc-nome' }, [p.n]);
  det = el('button', { type: 'button', 'class': 'tg-busca-hc-det', 'aria-label': 'Detalhes da peça: ' + p.n }, ['Detalhes da peça']);
  [det].forEach(function (b) {
    b.addEventListener('click', function () { abrir(b); });
    b.addEventListener('pointerdown', function () { tgRgPrefetch(p); if (op.conjunto) { tgRgPrefetch(op.conjunto.cima); tgRgPrefetch(op.conjunto.baixo); } });
  });
  // cores: peca do conjunto mostra so a cor do par; peca avulsa mostra as cores do modelo (cada bolinha abre aquela cor)
  g = op.conjunto ? null : tgGrupoDe(op.mapa, p);
  if (g && Array.isArray(g.irmaos)) {
    for (i = 0; i < g.irmaos.length; i++) {
      ir = g.irmaos[i]; gi = tgGrupoDe(op.mapa, ir);
      if (ir && urlProduto(ir.s) && gi && gi.cor && tgDisponivel(ir)) { lista.push({ item: ir, cor: gi.cor }); }
    }
  }
  if (lista.length >= 2) {
    for (i = 0; i < lista.length && i < TG_PG_BOLINHAS_MAX; i++) {
      (function (alvo) {
        var bo = el('span', { 'class': 'tg-busca-bolinha' + (alvo === p ? ' tg-busca-bolinha-atual' : ''), 'data-cor': tgCorSlug(lista[i].cor), 'aria-hidden': 'true' });
        bo.addEventListener('click', function () { abrir(det, alvo); }); // QA 3.1 (25/11): a cor tocada e a que abre no modal
        bolas.push(bo);
      })(lista[i].item);
    }
    if (lista.length > TG_PG_BOLINHAS_MAX) { bolas.push(el('span', { 'class': 'tg-busca-bolinha-mais', 'aria-label': 'Mais ' + (lista.length - TG_PG_BOLINHAS_MAX) + ' cores' }, ['+' + (lista.length - TG_PG_BOLINHAS_MAX)])); }
    cores = el('div', { 'class': 'tg-busca-cores tg-busca-hc-cores', role: 'img', 'aria-label': 'Cores: ' + lista.map(function (x) { return x.cor; }).join(', ') }, bolas);
  } else if (mc.cor) {
    corUnica = el('div', { 'class': 'tg-busca-cores tg-busca-hc-cores' }, [el('span', { 'class': 'tg-busca-bolinha tg-busca-bolinha-atual', 'data-cor': tgCorSlug(mc.cor), 'aria-hidden': 'true' }), el('span', { 'class': 'tg-busca-hc-cor' }, [mc.cor])]);
    cores = corUnica;
  }
  if (Array.isArray(p.sz)) { for (i = 0; i < p.sz.length && i < 10; i++) { if (typeof p.sz[i] === 'string' && p.sz[i]) { tams.push(el('span', { 'class': 'tg-busca-hc-tam' }, [p.sz[i]])); } } }
  card = el('div', { 'class': 'tg-busca-hc tg-busca-hc-toca' + (op.conjunto ? ' tg-busca-hc-conj' : '') }, [
    f,
    el('div', { 'class': 'tg-busca-hc-inf' }, [
      nome,
      el('div', { 'class': 'tg-busca-preco tg-busca-hc-preco' }, [el('strong', null, [reais(pr.final)]), pr.de ? el('s', { 'class': 'tg-busca-de' }, [reais(pr.de)]) : null, linhaPix(pr.final)]),
      cores,
      tams.length ? el('div', { 'class': 'tg-busca-hc-tams', role: 'img', 'aria-label': 'Tamanhos em estoque: ' + p.sz.join(', ') }, tams) : null,
      det
    ])
  ]);
  // v15 (Danilo, 25/11): tocar em qualquer parte do card abre o modal (antes so o botao); nunca leva para a pagina da peca
  card.addEventListener('click', function (ev) {
    try { if (ev.target && ev.target.closest && ev.target.closest('.tg-busca-hc-det, .tg-busca-bolinha')) { return; } } catch (e) {}
    abrir(det);
  });
  card.addEventListener('pointerdown', function () { tgRgPrefetch(p); });
  return card;
}
// Um conjunto = as duas pecas em cards separados (Danilo, 24/11): tocar em qualquer uma abre o modal com as duas.
function tgHConjunto(c, pos, secao) {
  var a = tgHCard(c.cima, { conjunto: c, posicao: pos, secao: secao }), b = tgHCard(c.baixo, { conjunto: c, posicao: pos, secao: secao });
  if (!a || !b) { return null; }
  return el('div', { 'class': 'tg-busca-hc-par', role: 'group', 'aria-label': 'Conjunto ' + (c.cor || '') }, [a, b]);
}

// ---------------------------------------------------------------- pagina de Conjuntos (/search/?q=conjuntos)
// Os pares do Recom em cards separados, com filtro de Tamanho (as duas pecas tem o tamanho) e de Cor (a cor do par). Devolve true se montou.
var TG_CJ_LOTE = 8;
function tgCjMontar(lista) {
  var destino = tgRgDestino(), raiz, grade, mais, barra, ativos = null, tam = null, cor = null, menus = [], est = { tamanhos: [], cores: [], mostrados: 0, atual: lista }, voce, vazio, i, n2, opCores = [];
  if (!destino || !lista.length) { return false; }
  // v14 (Danilo, 24/11): cores alternadas na grade (nao todos os amarelos, depois todos os azuis...)
  if (typeof tgConjuntosIntercalados === 'function') { lista = tgConjuntosIntercalados(lista); est.atual = lista; }
  grade = el('div', { 'class': 'tg-busca-hc-lista' });
  mais = el('button', { type: 'button', 'class': 'tg-busca-mais tg-busca-oculto' }, ['Ver mais']);
  vazio = el('div', { 'class': 'tg-busca-vazio tg-busca-oculto', role: 'status' });
  voce = el('h1', { 'class': 'tg-busca-voce' }, ['Você está buscando por: ', el('strong', null, ['Conjuntos'])]);
  function corDo(c) { var f = typeof tgFamiliaCor === 'function' ? tgFamiliaCor(c.cima) : null; return f ? f : null; }
  (function () {
    var vistos = {}, j, f;
    for (j = 0; j < lista.length; j++) { f = corDo(lista[j]); if (f && !vistos[f.chave]) { vistos[f.chave] = true; opCores.push({ valor: f.chave, rotulo: f.rotulo }); } }
  })();
  function filtrar() {
    return lista.filter(function (c) {
      var f;
      if (est.tamanhos.length && typeof tgFiltrar === 'function' && !(tgFiltrar([c.cima], { tamanho: est.tamanhos }).length && tgFiltrar([c.baixo], { tamanho: est.tamanhos }).length)) { return false; }
      if (est.cores.length) { f = corDo(c); if (!f || est.cores.indexOf(f.chave) < 0) { return false; } }
      return true;
    });
  }
  function lote() {
    var fim = Math.min(est.atual.length, est.mostrados + TG_CJ_LOTE), p, no;
    for (p = est.mostrados; p < fim; p++) { no = tgHConjunto(est.atual[p], p + 1, 'conjuntos'); if (no) { grade.appendChild(no); } }
    est.mostrados = fim;
    if (fim < est.atual.length) { mais.classList.remove('tg-busca-oculto'); } else { mais.classList.add('tg-busca-oculto'); }
  }
  function desenhar() {
    var limpar;
    while (grade.firstChild) { grade.removeChild(grade.firstChild); }
    est.atual = filtrar(); est.mostrados = 0;
    lote();
    while (vazio.firstChild) { vazio.removeChild(vazio.firstChild); }
    if (!est.atual.length) {
      limpar = el('button', { type: 'button', 'class': 'tg-busca-chip tg-busca-chip-ativo' }, ['Limpar filtros']);
      limpar.addEventListener('click', function () { est.tamanhos = []; est.cores = []; desenhar(); });
      vazio.appendChild(el('p', null, ['Nenhum conjunto com essa combinação de filtros.']));
      vazio.appendChild(limpar);
      vazio.classList.remove('tg-busca-oculto');
    } else { vazio.classList.add('tg-busca-oculto'); }
    if (tam) { tgTexto(tam.botao, est.tamanhos.length ? 'Tamanho (' + est.tamanhos.length + ')' : 'Tamanho'); tam.pintar(null, est.tamanhos); }
    if (cor) { tgTexto(cor.botao, est.cores.length ? 'Cor (' + est.cores.length + ')' : 'Cor'); cor.pintar(null, est.cores); }
    pintarAtivos();
  }
  // filtros aplicados: microchips na barra grudada + Limpar busca (mesmo padrao da pagina de resultados)
  function pintarAtivos() {
    var itens = [], lim;
    if (!ativos) { return; }
    while (ativos.firstChild) { ativos.removeChild(ativos.firstChild); }
    function micro(texto, tirar) {
      var b = el('button', { type: 'button', 'class': 'tg-busca-micro', 'aria-label': 'Tirar o filtro ' + texto }, [texto, el('span', { 'class': 'tg-busca-micro-x', 'aria-hidden': 'true' }, ['×'])]);
      b.addEventListener('click', function () { try { tirar(); desenhar(); } catch (e) {} });
      itens.push(b);
    }
    est.tamanhos.forEach(function (v) { micro('Tamanho ' + v, function () { alternar(est.tamanhos, v); }); });
    est.cores.forEach(function (v) { var r = v, k; for (k = 0; k < opCores.length; k++) { if (opCores[k].valor === v) { r = opCores[k].rotulo; } } micro(r, function () { alternar(est.cores, v); }); });
    if (!itens.length) { ativos.classList.add('tg-busca-oculto'); return; }
    lim = el('button', { type: 'button', 'class': 'tg-busca-limpar-busca' }, ['Limpar filtros']);
    lim.addEventListener('click', function () { try { est.tamanhos = []; est.cores = []; desenhar(); } catch (e) {} });
    ativos.appendChild(el('div', { 'class': 'tg-busca-ativos-lista' }, itens));
    ativos.appendChild(lim);
    ativos.classList.remove('tg-busca-oculto');
  }
  function alternar(l, v) { var p = l.indexOf(v); if (p >= 0) { l.splice(p, 1); } else { l.push(v); } }
  mais.addEventListener('click', function () { try { lote(); } catch (e) {} });
  tam = tgPgMenu('Tamanho', tgPgOpcoesTamanho(), [], function (v) { alternar(est.tamanhos, v); desenhar(); try { emitir('tg_busca_filtro_tamanho', { reason: est.tamanhos.join(','), page_type: 'conjuntos' }); } catch (e) {} }, false, true);
  menus.push(tam);
  if (opCores.length > 1) { cor = tgPgMenu('Cor', opCores, [], function (v) { alternar(est.cores, v); desenhar(); try { emitir('tg_busca_filtro_cor', { reason: est.cores.join(','), page_type: 'conjuntos' }); } catch (e) {} }, true, true); menus.push(cor); }
  ativos = el('div', { 'class': 'tg-busca-ativos tg-busca-oculto', role: 'group', 'aria-label': 'Filtros aplicados' });
  barra = el('div', { 'class': 'tg-busca-barra' }, [el('div', { 'class': 'tg-busca-barra-linha' }, [tam.no, el('span', { 'class': 'tg-busca-barra-espaco' }), cor ? cor.no : null]), ativos]);
  document.addEventListener('click', function (ev) { var j; try { for (j = 0; j < menus.length; j++) { if (!menus[j].no.contains(ev.target)) { menus[j].fechar(); } } } catch (e) {} });
  raiz = el('section', { id: 'tg-busca-resultados', 'class': 'tg-busca-pagina tg-busca-pagina-conj', 'aria-label': 'Conjuntos' }, [tgConselheira(), voce, el('p', { 'class': 'tg-busca-cj-sub' }, ['Compre o Look. Descubra os conjuntos da Talgui e adicione sua peça favorita na sacola']), barra, grade, vazio, mais]);
  injetarEstilos();
  desenhar();
  destino.insertBefore(raiz, destino.firstChild || null);
  tgPgTopoBarra(raiz);
  tgRgEsconderNativos(true);
  emitir('tg_busca_pagina_view', { results_count: lista.length, page_type: 'conjuntos' });
  return true;
}

function tgPgOrdenar(lista, modo, handles) {
  try { if (typeof tgOrdenar === 'function') { return tgOrdenar(lista, modo, handles) || lista; } } catch (e) {}
  return lista;
}
// Filtros combinados (tamanhos e cores valem em conjunto). tamanhos: ids dos grupos ("M"); cores: chaves de tgFamiliaCor.
function tgPgFiltrar(lista, tamanhos, cores) {
  var out = [], i, j, k, it, achou;
  if ((!tamanhos || !tamanhos.length) && (!cores || !cores.length)) { return lista; }
  try { if (typeof tgFiltrar === 'function') { return tgFiltrar(lista, { tamanho: tamanhos || [], cor: cores || [] }) || lista; } } catch (e) {}
  for (i = 0; i < lista.length; i++) {
    it = lista[i]; achou = !(tamanhos && tamanhos.length);
    for (j = 0; !achou && it && Array.isArray(it.sz) && j < it.sz.length; j++) { for (k = 0; k < tamanhos.length; k++) { if (String(it.sz[j]).toUpperCase() === String(tamanhos[k]).toUpperCase()) { achou = true; } } }
    if (achou) { out.push(it); }
  }
  return out;
}

// Tamanhos que existem nos resultados, na ordem natural (PP, P, M, G, GG..., depois os numeros), com quantas pecas tem cada um.
function tgPgTamanhos(lista) {
  var cont = {}, nomes = [], i, j, v, k;
  for (i = 0; i < lista.length; i++) {
    if (!lista[i] || !Array.isArray(lista[i].sz)) { continue; }
    for (j = 0; j < lista[i].sz.length; j++) {
      v = lista[i].sz[j];
      if (typeof v !== 'string' || !v) { continue; }
      k = v.toUpperCase();
      if (!Object.prototype.hasOwnProperty.call(cont, k)) { cont[k] = { rotulo: v, qtd: 0 }; nomes.push(k); }
      cont[k].qtd++;
    }
  }
  function peso(n) {
    var p = TG_PG_TAM_ORDEM.indexOf(n);
    if (p >= 0) { return p; }
    return /^\d+$/.test(n) ? 100 + parseInt(n, 10) : 1000;
  }
  nomes.sort(function (a, b) { return (peso(a) - peso(b)) || (a < b ? -1 : 1); });
  return nomes.map(function (n) { return cont[n]; });
}

// Opcoes do filtro de tamanho: sempre os 6 grupos (XPP / 34 ... GG / 44), sem quantidade.
function tgPgOpcoesTamanho() {
  var g = typeof TG_TAMANHO_GRUPOS !== 'undefined' && Array.isArray(TG_TAMANHO_GRUPOS) ? TG_TAMANHO_GRUPOS : [], o = [], i;
  for (i = 0; i < g.length; i++) { o.push({ valor: g[i].id, rotulo: g[i].rotulo }); }
  return o;
}
// Opcoes do filtro de cor: as familias de cor das pecas da lista, da mais comum para a menos comum (sem quantidade).
function tgPgOpcoesCor(lista) {
  var cont = {}, nomes = [], i, f, o = [];
  if (typeof tgFamiliaCor !== 'function') { return o; }
  for (i = 0; i < lista.length; i++) {
    f = tgFamiliaCor(lista[i]);
    if (!f || !f.chave) { continue; }
    if (!Object.prototype.hasOwnProperty.call(cont, f.chave)) { cont[f.chave] = { rotulo: f.rotulo, n: 0 }; nomes.push(f.chave); }
    cont[f.chave].n++;
  }
  nomes.sort(function (a, b) { return (cont[b].n - cont[a].n) || (a < b ? -1 : 1); });
  for (i = 0; i < nomes.length; i++) { o.push({ valor: nomes[i], rotulo: cont[nomes[i]].rotulo }); }
  return o;
}

// Menu suspenso: botao + lista. multi = varias opcoes marcadas (a lista fica aberta; aoEscolher(valor) alterna); sem multi, uma so (fecha ao escolher).
// opcoes: [{ valor, rotulo }]. atual: valor (ou lista de valores no multi). pintar(opcoesNovas, atual) redesenha.
// v15 (Danilo, 25/11): o menu abre e fecha como uma gaveta; cores = 3 colunas com a bolinha da cor ao lado do nome (comCores).
function tgPgMenu(rotuloBotao, opcoes, atual, aoEscolher, direita, multi, comCores) {
  var wrap, botao, lista, vigente = atual, opts = opcoes, tFecha = 0;
  botao = el('button', { type: 'button', 'class': 'tg-busca-barra-btn', 'aria-haspopup': 'true', 'aria-expanded': 'false' }, [rotuloBotao]);
  lista = el('div', { 'class': 'tg-busca-menu tg-busca-oculto' + (comCores ? ' tg-busca-menu-cores' : ''), role: 'menu' });
  wrap = el('div', { 'class': 'tg-busca-menu-wrap' + (direita ? ' tg-busca-menu-dir' : '') + (comCores ? ' tg-busca-menu-wrap-cores' : '') }, [botao, lista]);
  function aberto() { return botao.getAttribute('aria-expanded') === 'true'; }
  function fechar() {
    if (!aberto()) { return; }
    botao.setAttribute('aria-expanded', 'false');
    lista.classList.add('tg-busca-menu-fechando');
    clearTimeout(tFecha);
    tFecha = setTimeout(function () { lista.classList.remove('tg-busca-menu-fechando'); if (!aberto()) { lista.classList.add('tg-busca-oculto'); } }, 170);
  }
  botao.addEventListener('click', function () {
    try {
      if (!aberto()) { clearTimeout(tFecha); lista.classList.remove('tg-busca-menu-fechando'); lista.classList.remove('tg-busca-oculto'); botao.setAttribute('aria-expanded', 'true'); } else { fechar(); }
    } catch (e) {}
  });
  function marcado(v) { return multi ? (Array.isArray(vigente) && vigente.indexOf(v) >= 0) : v === vigente; }
  function pintar(novasOpcoes, novoAtual) {
    var j;
    if (novasOpcoes) { opts = novasOpcoes; }
    if (novoAtual !== undefined) { vigente = novoAtual; }
    while (lista.firstChild) { lista.removeChild(lista.firstChild); }
    for (j = 0; j < opts.length; j++) {
      (function (o) {
        var b = el('button', { type: 'button', 'class': o.desligado && !marcado(o.valor) ? 'tg-busca-menu-sem' : null, role: multi ? 'menuitemcheckbox' : 'menuitemradio', 'aria-checked': marcado(o.valor) ? 'true' : 'false', 'aria-disabled': o.desligado && !marcado(o.valor) ? 'true' : null }, [comCores ? el('span', { 'class': 'tg-busca-bolinha tg-busca-menu-bolinha', 'data-cor': tgCorSlug(o.rotulo), 'aria-hidden': 'true' }) : null, el('span', null, [o.rotulo])]);
        b.addEventListener('click', function () {
          try { if (o.desligado && !marcado(o.valor)) { return; } if (!multi) { fechar(); } aoEscolher(o.valor); } catch (e) {}
        });
        lista.appendChild(b);
      })(opts[j]);
    }
  }
  pintar();
  return { no: wrap, botao: botao, fechar: fechar, pintar: pintar, aberto: aberto };
}

// As pecas que casam de verdade com a busca (as primeiras res.fortesTotal da lista do motor), por id; null = todas contam.
function tgPgFortes(lista, res) {
  var out = {}, n, i;
  if (!res || typeof res.fortesTotal !== 'number' || !Array.isArray(res.results) || res.fortesTotal >= res.results.length) { return null; }
  n = res.fortesTotal;
  for (i = 0; i < res.results.length && i < n; i++) { if (res.results[i]) { out[res.results[i].id] = true; } }
  return out;
}
function tgPgSemMovimento() { try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } }
// Monta a pagina de resultados. Devolve true se montou (so entao a lista nativa so some).
// Filtros que valem juntos: chip de categoria/ocasiao (troca a lista-base pela busca do chip), Novidades, tamanhos (varios) e cores (varias).
function tgPgMontar(q, cat, res) {
  var conjOk = false, verNov, ativos = null, itens = [], i, destino, raiz, nativo, mapa, selos = res.selos, destaque, est, grade, mais, barra, menus = [], ordem = null, tam = null, cor = null, togg, tg1, tg2, chipsLinha, filhos, aviso = null, vazio, bases = {}, voce, grupoQ = typeof tgGrupoDaBusca === 'function' ? tgGrupoDaBusca(q) : '';
  for (i = 0; i < res.results.length; i++) { if (urlProduto(res.results[i].s) && precoFinal(res.results[i])) { itens.push(res.results[i]); } }
  if (!itens.length) { return false; }
  destino = tgRgDestino();
  if (!destino) { return false; }
  destaque = res.tamanho && res.tamanho.aplicado ? res.tamanho.aceitos : null;
  mapa = tgGruposCores(itens);
  est = { ordem: 'relevancia', tamanhos: [], cores: [], base: '', grupo: '', chip: '', novidades: false, handles: null, um: false, mostrados: 0, atual: itens };
  grade = el('div', { 'class': 'tg-busca-grade' });
  mais = el('button', { type: 'button', 'class': 'tg-busca-mais tg-busca-oculto' }, ['Ver mais']);
  verNov = el('a', { 'class': 'tg-busca-mais tg-busca-ver-nov tg-busca-oculto', href: typeof TG_NOVIDADES_CATEGORIA === 'string' ? TG_NOVIDADES_CATEGORIA : '/novidades/' }, ['Ver Novidades']);
  voce = el('h1', { 'class': 'tg-busca-voce' });
  var ordCab = el('p', { 'class': 'tg-busca-ord-cab tg-busca-oculto', role: 'status' });
  var contador = el('p', { 'class': 'tg-busca-contador', role: 'status', 'aria-live': 'polite' }); // QA 5.1 (25/11)
  var fortesIds = tgPgFortes(itens, res);
  vazio = el('div', { 'class': 'tg-busca-vazio tg-busca-oculto', role: 'status' });

  // lista-base: a da busca da URL, ou a do chip de categoria/ocasiao escolhido
  function gAtivo() { return est.grupo || grupoQ; }
  function baseItens() {
    var r, lista, j, chave, bruta, g = gAtivo();
    if (est.chip && g && typeof tgItensDoChip === 'function') { chave = 'c:' + g + ':' + est.chip; bruta = function () { return tgItensDoChip(cat, g, est.chip); }; }
    else if (est.grupo && typeof tgItensDoGrupo === 'function') { chave = 'g:' + est.grupo; bruta = function () { return tgItensDoGrupo(cat, est.grupo); }; }
    if (chave) {
      if (bases[chave]) { return bases[chave]; }
      lista = [];
      try { r = bruta(); for (j = 0; j < r.length; j++) { if (urlProduto(r[j].s) && precoFinal(r[j])) { lista.push(r[j]); } } } catch (e) {}
      bases[chave] = lista;
      return lista;
    }
    if (!est.base) { return itens; }
    if (bases[est.base]) { return bases[est.base]; }
    lista = [];
    try {
      if (est.base === 'regra:wedding' || est.base === 'regra:madrinhas') {
        r = { results: typeof tgSelecaoVestidos === 'function' ? tgSelecaoVestidos(cat, est.base === 'regra:wedding' ? 'wedding' : 'madrinhas') : [] };
      } else { r = runSearch(est.base, cat, TG_PG_LIMITE); }
      for (j = 0; j < r.results.length; j++) { if (urlProduto(r.results[j].s) && precoFinal(r.results[j])) { lista.push(r.results[j]); } }
    } catch (e) {}
    bases[est.base] = lista;
    return lista;
  }
  function soNovidades(lista) {
    var set = {}, j, out = [];
    if (!est.novidades || !est.handles || !est.handles.length) { return lista; }
    for (j = 0; j < est.handles.length; j++) { set[est.handles[j]] = true; }
    for (j = 0; j < lista.length; j++) { if (set[lista[j].s]) { out.push(lista[j]); } }
    return out;
  }
  // cores oferecidas: so as que existem no que a cliente ja filtrou (tamanho, categoria, novidades); as ja marcadas ficam sempre
  function opcoesCor() {
    var todas = tgPgOpcoesCor(baseItens()), vivas = tgPgOpcoesCor(tgPgFiltrar(soNovidades(baseItens()), est.tamanhos, [])), out = [], j, k, achou;
    for (j = 0; j < todas.length; j++) {
      achou = est.cores.indexOf(todas[j].valor) >= 0;
      for (k = 0; !achou && k < vivas.length; k++) { if (vivas[k].valor === todas[j].valor) { achou = true; } }
      if (achou) { out.push(todas[j]); }
    }
    return out;
  }
  // QA 5.3 (25/11): tamanhos oferecidos = os 6 grupos, apagados quando nenhuma peca da combinacao atual (chip, Novidades, cores) tem aquele tamanho
  function opcoesTamanho() {
    var base = tgPgFiltrar(soNovidades(baseItens()), [], est.cores);
    return tgPgOpcoesTamanho().map(function (o) { return { valor: o.valor, rotulo: o.rotulo, desligado: !tgPgFiltrar(base, [o.valor], []).length }; });
  }
  // Novidades (filtro exclusivo, so combina com Tamanho e Cor): na ordem da categoria Novidades
  function lista() { return tgPgOrdenar(tgPgFiltrar(soNovidades(baseItens()), est.tamanhos, est.cores), est.novidades ? 'lancamentos' : est.ordem, est.handles); }
  // Novidades sem grupo (Danilo, 24/11): 2 Vestidos, 2 Blusas e 2 Calcas, uma secao por grupo, e o botao Ver Novidades
  function secoesNov(l) {
    var out = [], gs = ['vestidos', 'blusas', 'calcas'], j, its;
    if (typeof tgGrupoDoItem !== 'function' || typeof TG_GRUPOS === 'undefined') { return null; }
    for (j = 0; j < gs.length; j++) {
      its = l.filter(function (it) { return tgGrupoDoItem(it) === gs[j]; }).slice(0, 2);
      if (its.length) { out.push({ titulo: TG_GRUPOS[gs[j]].rotulo, itens: its }); }
    }
    return out.length ? out : null;
  }
  function lote() {
    var fim = Math.min(est.atual.length, est.mostrados + TG_PG_LOTE), c, p;
    for (p = est.mostrados; p < fim; p++) {
      c = tgRgCard(est.atual[p], selos ? (selos.get(est.atual[p]) || false) : false, destaque, { mapa: mapa, posicao: p + 1 });
      if (c) { grade.appendChild(c); }
    }
    est.mostrados = fim;
    // so aparece se ainda ha pecas para mostrar (e diz quantas); sem mais pecas o botao nao existe
    if (fim < est.atual.length) { tgTexto(mais, 'Ver mais'); mais.classList.remove('tg-busca-oculto'); } else { mais.classList.add('tg-busca-oculto'); }
  }
  // "Mais Vendidos em Vestidos / Blusas / Calças": no Best Sellers sem grupo definido a lista vira uma secao por categoria (as mais vendidas de cada)
  function secoesBest(lista) {
    var out = [], gs = ['vestidos', 'blusas', 'calcas'], j, its, resto;
    if (typeof tgGrupoDoItem !== 'function' || typeof TG_GRUPOS === 'undefined') { return null; }
    for (j = 0; j < gs.length; j++) {
      its = lista.filter(function (it) { return tgGrupoDoItem(it) === gs[j]; }).slice(0, TG_PG_BEST_MAX);
      if (its.length) { out.push({ titulo: 'Mais Vendidos em ' + TG_GRUPOS[gs[j]].rotulo, itens: its }); }
    }
    resto = lista.filter(function (it) { return !tgGrupoDoItem(it); }).slice(0, TG_PG_BEST_MAX);
    if (resto.length && out.length) { out.push({ titulo: 'Mais Vendidos em Outras Peças', itens: resto }); }
    return out.length ? out : null;
  }
  function tituloCaso(t) {
    return String(t || '').trim().slice(0, 60).split(/\s+/).map(function (w, i) { w = w.toLowerCase(); return i && /^(de|da|do|das|dos|e|em|com|para|no|na)$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
  }
  // "Você está buscando por: Vestidos" (ou o que foi digitado, ou grupo + chip)
  function pintarTitulo() {
    var g = gAtivo(), rot, c, j, ocas, pre;
    if (est.chip && g) { c = tgChipDoGrupo(g, est.chip); rot = TG_GRUPOS[g].rotulo + (c ? ' · ' + c.rotulo : ''); }
    else if (est.grupo) { rot = TG_GRUPOS[est.grupo].rotulo; }
    else if (est.base) {
      rot = tituloCaso(q);
      ocas = typeof TG_CHIPS_OCASIAO !== 'undefined' && Array.isArray(TG_CHIPS_OCASIAO) ? TG_CHIPS_OCASIAO : [];
      for (j = 0; j < ocas.length; j++) { if (ocas[j] && ocas[j].consulta === est.base) { rot = ocas[j].rotulo; } }
    } else if (res.intencao && res.intencao.aplicado !== false && res.intencao.titulo) { rot = res.intencao.titulo; // QA 1.5 (25/11)
    } else if (grupoQ && normalizeText(q).split(' ').length === 1) { rot = TG_GRUPOS[grupoQ].rotulo; } else { rot = tituloCaso(q); }
    // titulo da ordenacao (Danilo, 24/11): "Lançamentos em Vestidos", "Melhores Ofertas em Vestidos"; Novidades: "Novidades em Vestidos"
    // v15 (Danilo, 25/11): no topo o titulo fica so "Você está buscando por"; a ordenacao (e Novidades) aparece junto dos cards, antes do 1o
    pre = '';
    if (est.novidades) { pre = 'Novidades em '; }
    else if (est.ordem !== 'relevancia') { for (j = 0; j < TG_PG_ORDENS.length; j++) { if (TG_PG_ORDENS[j][0] === est.ordem) { pre = TG_PG_ORDENS[j][1] + ' em '; } } }
    while (voce.firstChild) { voce.removeChild(voce.firstChild); }
    voce.appendChild(document.createTextNode('Você está buscando por: '));
    voce.appendChild(el('strong', null, [rot]));
    var nCont = est.atual ? est.atual.length : 0;
    // QA 5.1 (25/11): com a busca da URL (sem chip de grupo/categoria), contam so as pecas que casam de verdade (res.fortesTotal do motor)
    if (fortesIds && !est.base && !est.grupo && !est.chip && !est.novidades) { nCont = est.atual.filter(function (it) { return fortesIds[it.id]; }).length; }
    tgTexto(contador, nCont ? (nCont === 1 ? '1 peça encontrada' : nCont + ' peças encontradas') : '');
    while (ordCab.firstChild) { ordCab.removeChild(ordCab.firstChild); }
    if (pre && est.atual && est.atual.length) {
      ordCab.appendChild(document.createTextNode(pre));
      ordCab.appendChild(el('strong', null, [rot]));
      ordCab.classList.remove('tg-busca-oculto');
    } else { ordCab.classList.add('tg-busca-oculto'); }
  }
  // retorno visual de que a lista mudou: a grade entra de novo (suave) e, se a cliente estava la embaixo, a tela volta ao comeco da lista
  function renovar() {
    var y, off;
    try {
      grade.classList.remove('tg-busca-grade-nova');
      void grade.offsetWidth;
      grade.classList.add('tg-busca-grade-nova');
      y = (ordCab.classList.contains('tg-busca-oculto') ? grade : ordCab).getBoundingClientRect().top;
      off = (barra && barra.getBoundingClientRect ? barra.getBoundingClientRect().height : 50) + 76; // a barra grudada + o topo do tema
      if (y < off || y > (window.innerHeight || 0) * 0.6) { window.scrollTo({ top: Math.max(0, window.pageYOffset + y - off), behavior: tgPgSemMovimento() ? 'auto' : 'smooth' }); }
    } catch (e) {}
  }
  function rotuloContado(base, n) { return n ? base + ' (' + n + ')' : base; }
  function desenhar() {
    var opCor;
    while (grade.firstChild) { grade.removeChild(grade.firstChild); }
    est.atual = lista();
    est.mostrados = 0;
    est.secoes = est.novidades && !gAtivo() ? secoesNov(est.atual) : (est.ordem === 'best-sellers' && !gAtivo() ? secoesBest(est.atual) : null);
    if (est.secoes) {
      // uma secao por categoria, sem paginacao (cada uma ja traz as mais vendidas)
      est.secoes.forEach(function (sec) {
        var p2, c2;
        grade.appendChild(el('h2', { 'class': 'tg-busca-grade-titulo' }, [sec.titulo]));
        for (p2 = 0; p2 < sec.itens.length; p2++) {
          c2 = tgRgCard(sec.itens[p2], selos ? (selos.get(sec.itens[p2]) || false) : false, destaque, { mapa: mapa, posicao: p2 + 1 });
          if (c2) { grade.appendChild(c2); }
        }
      });
      est.mostrados = est.atual.length;
      mais.classList.add('tg-busca-oculto');
    } else {
      lote();
    }
    pintarTitulo();
    if (est.novidades && est.atual.length) { verNov.classList.remove('tg-busca-oculto'); } else { verNov.classList.add('tg-busca-oculto'); }
    // sem peca na combinacao: mensagem com saida
    while (vazio.firstChild) { vazio.removeChild(vazio.firstChild); }
    if (!est.atual.length) {
      limpar = el('button', { type: 'button', 'class': 'tg-busca-chip tg-busca-chip-ativo' }, ['Limpar filtros']);
      limpar.addEventListener('click', function () { try { limparTudo(); } catch (e) {} });
      vazio.appendChild(el('p', null, ['Nenhuma peça com essa combinação de filtros.']));
      vazio.appendChild(limpar);
      vazio.classList.remove('tg-busca-oculto');
    } else { vazio.classList.add('tg-busca-oculto'); }
    chips();
    pintarAtivos();
    if (ordem) { ordem.pintar(null, est.ordem); }
    if (tam) { tgTexto(tam.botao, rotuloContado('Tamanho', est.tamanhos.length)); tam.pintar(opcoesTamanho(), est.tamanhos); }
    if (cor) {
      est.cores = est.cores.filter(function (c) { return tgPgOpcoesCor(baseItens()).some(function (o) { return o.valor === c; }); });
      opCor = opcoesCor();
      tgTexto(cor.botao, rotuloContado('Cor', est.cores.length)); cor.pintar(opCor, est.cores);
    }
    urlGravar();
  }
  // ---- link compartilhavel: a combinacao de filtros vai na URL (tg_cat, tg_tam, tg_cor, tg_ord, tg_nov) e quem abrir o link ve a mesma busca
  function tgPgConsultasValidas() {
    var out = [], l = [], j, k;
    if (typeof TG_CHIPS_EM_ALTA !== 'undefined' && Array.isArray(TG_CHIPS_EM_ALTA)) { l = l.concat(TG_CHIPS_EM_ALTA); }
    if (typeof TG_CHIPS_OCASIAO !== 'undefined' && Array.isArray(TG_CHIPS_OCASIAO)) { l = l.concat(TG_CHIPS_OCASIAO); }
    for (j = 0; j < l.length; j++) { if (l[j] && typeof l[j].consulta === 'string') { out.push(l[j].consulta); } }
    return out;
  }
  function urlGravar() {
    var sp, qs, ks = ['tg_cat', 'tg_tam', 'tg_cor', 'tg_ord', 'tg_nov', 'tg_gr', 'tg_ch'], vs, j;
    try {
      sp = new URLSearchParams(window.location.search);
      vs = [est.base || '', est.tamanhos.join(','), est.cores.join(','), est.ordem !== 'relevancia' ? est.ordem : '', est.novidades ? '1' : '', est.grupo || '', est.chip || ''];
      for (j = 0; j < ks.length; j++) { if (vs[j]) { sp.set(ks[j], vs[j]); } else { sp['delete'](ks[j]); } }
      qs = sp.toString().replace(/%2C/gi, ',');
      window.history.replaceState(window.history.state, '', window.location.pathname + (qs ? '?' + qs : '') + (window.location.hash || ''));
    } catch (e) {}
  }
  function urlLer() {
    var sp, v, partes, j, k, ids, validas, precisaNov = false;
    try {
      sp = new URLSearchParams(window.location.search);
      v = sp.get('tg_ord');
      if (v) { for (j = 0; j < TG_PG_ORDENS.length; j++) { if (TG_PG_ORDENS[j][0] === v) { est.ordem = v; } } }
      v = sp.get('tg_cat');
      if (v && tgPgConsultasValidas().indexOf(v) >= 0) { est.base = v; }
      v = sp.get('tg_gr');
      if (v && typeof TG_GRUPOS !== 'undefined' && Object.prototype.hasOwnProperty.call(TG_GRUPOS, v) && v !== grupoQ) { est.grupo = v; est.base = ''; }
      v = sp.get('tg_ch');
      if (v && gAtivo() && typeof tgChipDoGrupo === 'function' && tgChipDoGrupo(gAtivo(), v) && !tgChipDoGrupo(gAtivo(), v).novidades) { est.chip = v; est.base = ''; }
      v = sp.get('tg_tam');
      if (v) {
        ids = tgPgOpcoesTamanho().map(function (o) { return o.valor; });
        partes = v.split(',');
        for (j = 0; j < partes.length && j < 7; j++) { if (ids.indexOf(partes[j]) >= 0 && est.tamanhos.indexOf(partes[j]) < 0) { est.tamanhos.push(partes[j]); } }
      }
      v = sp.get('tg_cor');
      if (v) {
        partes = v.split(',');
        for (j = 0; j < partes.length && j < 8; j++) { if (/^[a-z0-9 \-]{1,40}$/.test(partes[j]) && est.cores.indexOf(partes[j]) < 0) { est.cores.push(partes[j]); } }
      }
      // Novidades pelo link: so liga quando a lista das Novidades chegar (antes disso a tela mostraria pecas que nao sao novidades)
      if (sp.get('tg_nov') === '1') { est.novPend = true; est.chip = ''; est.base = ''; est.ordem = 'relevancia'; }
      // cor que nao existe nessa busca some do link (nada de chip fantasma nem lista vazia por link editado)
      if (est.cores.length && typeof tgPgOpcoesCor === 'function') { validas = tgPgOpcoesCor(baseItens()).map(function (o) { return o.valor; }); est.cores = est.cores.filter(function (c) { return validas.indexOf(c) >= 0; }); }
      if (est.ordem === 'lancamentos' || est.novPend) { precisaNov = true; }
    } catch (e) {}
    return precisaNov;
  }
  var limpar;
  function limparTudo() { est.tamanhos = []; est.cores = []; est.base = ''; est.grupo = ''; est.chip = ''; est.novidades = false; est.ordem = 'relevancia'; desenhar(); }
  mais.addEventListener('click', function () { try { lote(); } catch (e) {} });

  function alternar(lista, v) { var p = lista.indexOf(v); if (p >= 0) { lista.splice(p, 1); } else { lista.push(v); } }
  function escolherOrdem(v) {
    function aplicar() { est.ordem = v; if (v !== 'relevancia') { est.novidades = false; } if (ordem) { ordem.pintar(null, v); } desenhar(); renovar(); try { emitir('tg_busca_ordenar', { reason: v, results_count: est.atual.length }); } catch (e) {} }
    if (v === 'lancamentos' && !(est.handles && est.handles.length)) { tgPgNovidades().then(function (h) { est.handles = h; aplicar(); }); return; }
    aplicar();
  }
  function escolherTamanho(v) {
    alternar(est.tamanhos, v);
    desenhar();
    try { emitir('tg_busca_filtro_tamanho', { reason: est.tamanhos.join(','), results_count: est.atual.length }); } catch (e) {}
  }
  function escolherCor(v) {
    alternar(est.cores, v);
    desenhar();
    try { emitir('tg_busca_filtro_cor', { reason: est.cores.join(','), results_count: est.atual.length }); } catch (e) {}
  }
  function escolherBase(consulta) {
    est.base = est.base === consulta ? '' : consulta;
    est.novidades = false;
    desenhar();
    try { emitir('tg_busca_chip', { reason: est.base || 'limpar', results_count: est.atual.length }); } catch (e) {}
  }
  function entrarGrupo(id) {
    est.grupo = id; est.chip = ''; est.base = ''; est.novidades = false;
    desenhar();
    try { emitir('tg_busca_chip', { reason: id, results_count: est.atual.length }); } catch (e) {}
  }
  function voltarTodas() {
    est.grupo = ''; est.chip = ''; est.base = ''; est.novidades = false;
    desenhar();
    try { emitir('tg_busca_chip', { reason: 'limpar', results_count: est.atual.length }); } catch (e) {}
  }
  function escolherChipGrupo(id) {
    est.chip = est.chip === id ? '' : id;
    est.novidades = false;
    desenhar();
    try { emitir('tg_busca_chip', { reason: (gAtivo() || '') + ':' + (est.chip || 'limpar'), results_count: est.atual.length }); } catch (e) {}
  }
  function escolherNovidades(botao) {
    function aplicar() { est.novidades = !est.novidades; if (est.novidades) { est.chip = ''; est.base = ''; est.ordem = 'relevancia'; } desenhar(); try { emitir('tg_busca_chip', { reason: est.novidades ? 'novidades' : 'limpar', results_count: est.atual.length }); } catch (e) {} }
    if (!(est.handles && est.handles.length)) { botao.setAttribute('aria-busy', 'true'); tgPgNovidades().then(function (h) { est.handles = h; botao.removeAttribute('aria-busy'); if (h.length) { aplicar(); } }); return; }
    if (est.handles.length) { aplicar(); }
  }

  // Filtros aplicados (Danilo, 24/11): microchips discretos na barra que gruda no topo, cada um com x para tirar, e "Limpar busca".
  // So aparece com algum filtro; acompanha a rolagem junto com a barra.
  function pintarAtivos() {
    var itens = [], opC, g = gAtivo(), c, lim, rot, j, todos;
    if (!ativos) { return; }
    while (ativos.firstChild) { ativos.removeChild(ativos.firstChild); }
    function micro(texto, tirar) {
      var b = el('button', { type: 'button', 'class': 'tg-busca-micro', 'aria-label': 'Tirar o filtro ' + texto }, [texto, el('span', { 'class': 'tg-busca-micro-x', 'aria-hidden': 'true' }, ['×'])]);
      b.addEventListener('click', function () { try { tirar(); } catch (e) {} });
      itens.push(b);
    }
    if (est.grupo && !grupoQ && TG_GRUPOS[est.grupo]) { micro(TG_GRUPOS[est.grupo].rotulo, function () { voltarTodas(); }); }
    if (est.chip && g && typeof tgChipDoGrupo === 'function') { c = tgChipDoGrupo(g, est.chip); if (c) { micro(c.rotulo, function () { escolherChipGrupo(est.chip); }); } }
    if (est.base) {
      rot = est.base;
      todos = [].concat(typeof TG_CHIPS_EM_ALTA !== 'undefined' ? TG_CHIPS_EM_ALTA : [], typeof TG_CHIPS_OCASIAO !== 'undefined' ? TG_CHIPS_OCASIAO : []);
      for (j = 0; j < todos.length; j++) { if (todos[j] && todos[j].consulta === est.base) { rot = todos[j].rotulo; } }
      micro(rot, function () { escolherBase(est.base); });
    }
    if (est.novidades) { micro('Novidades', function () { est.novidades = false; desenhar(); }); }
    est.tamanhos.forEach(function (t) { micro('Tamanho ' + t, function () { escolherTamanho(t); }); });
    opC = est.cores.length ? tgPgOpcoesCor(baseItens()) : [];
    est.cores.forEach(function (v) {
      var r = v, k;
      for (k = 0; k < opC.length; k++) { if (opC[k].valor === v) { r = opC[k].rotulo; } }
      micro(r, function () { escolherCor(v); });
    });
    if (!itens.length) { ativos.classList.add('tg-busca-oculto'); return; }
    lim = el('button', { type: 'button', 'class': 'tg-busca-limpar-busca' }, ['Limpar filtros']);
    lim.addEventListener('click', function () { try { limparTudo(); emitir('tg_busca_chip', { reason: 'limpar' }); } catch (e) {} });
    ativos.appendChild(el('div', { 'class': 'tg-busca-ativos-lista' }, itens));
    ativos.appendChild(lim);
    ativos.classList.remove('tg-busca-oculto');
  }
  // linha de chips: filtros ativos (tirar ao clicar) + categorias, ocasioes e Novidades (botoes que combinam com tamanho e cor)
  chipsLinha = el('div', { 'class': 'tg-busca-chips tg-busca-chips-linha' });
  function chipBotao(rotulo, ativo, aoClicar, ariaTirar) {
    var b = el('button', { type: 'button', 'class': 'tg-busca-chip' + (ativo ? ' tg-busca-chip-ativo' : ''), 'aria-pressed': ativo ? 'true' : 'false' }, [rotulo]);
    if (ariaTirar) { b.setAttribute('aria-label', ariaTirar); }
    b.addEventListener('click', function () { try { aoClicar(b); } catch (e) {} });
    return b;
  }
  function rotuloTam(id) { var o = tgPgOpcoesTamanho(), j; for (j = 0; j < o.length; j++) { if (o[j].valor === id) { return o[j].rotulo; } } return id; }
  function chips() {
    var cats = typeof TG_CHIPS_EM_ALTA !== 'undefined' && Array.isArray(TG_CHIPS_EM_ALTA) ? TG_CHIPS_EM_ALTA : [], ocas = typeof TG_CHIPS_OCASIAO !== 'undefined' && Array.isArray(TG_CHIPS_OCASIAO) ? TG_CHIPS_OCASIAO : [], j, c, ordemChips = [], nov = null, opCor, gcs;
    while (chipsLinha.firstChild) { chipsLinha.removeChild(chipsLinha.firstChild); }
    // os filtros aplicados (Tamanho, Cor, Novidades...) ficam na linha de microchips da barra grudada (pintarAtivos), nao aqui
    opCor = typeof tgPgOpcoesCor === 'function' ? tgPgOpcoesCor(baseItens()) : [];  // rotulos: lista completa
    // dentro de um grupo (Vestidos, Blusas, Calças), pela busca ou por chip: os chips passam a ser os do grupo
    gcs = null;
    try { if (gAtivo() && typeof tgChipsDoGrupo === 'function') { gcs = tgChipsDoGrupo(cat, gAtivo()); } } catch (e) { gcs = null; }
    if (gcs) {
      if (est.grupo && !grupoQ) { chipsLinha.appendChild(chipBotao('‹ Todas', false, function () { voltarTodas(); }, 'Voltar para todas as peças')); }
      gcs.forEach(function (gc) {
        if (gc.novidades) { chipsLinha.appendChild(chipBotao(gc.rotulo, est.novidades, function (b) { escolherNovidades(b); })); }
        else { chipsLinha.appendChild(chipBotao(gc.rotulo, est.chip === gc.id, function () { escolherChipGrupo(gc.id); })); }
      });
      // v14: Conjuntos (blusa + calca/saia da mesma cor) tambem aparece dentro de Blusas e de Calças
      if (conjOk && (gAtivo() === 'blusas' || gAtivo() === 'calcas')) { chipsLinha.appendChild(el('a', { 'class': 'tg-busca-chip', href: urlBusca('conjuntos') }, ['Conjuntos'])); }
      if (!chipsLinha.firstChild) { chipsLinha.classList.add('tg-busca-oculto'); } else { chipsLinha.classList.remove('tg-busca-oculto'); }
      return;
    }
    for (j = 0; j < cats.length; j++) {
      c = cats[j];
      if (!c || typeof c.rotulo !== 'string' || !c.rotulo) { continue; }
      if (c.novidades || c.href === '/novidades/') { nov = c; continue; }
      if (typeof c.consulta === 'string' && c.consulta) { ordemChips.push(c); }
    }
    ordemChips = ordemChips.concat(ocas.filter(function (o) { return o && typeof o.rotulo === 'string' && typeof o.consulta === 'string' && o.consulta; }));
    ordemChips.forEach(function (o) {
      var gid = typeof tgGrupoDaBusca === 'function' ? tgGrupoDaBusca(o.consulta) : '';
      chipsLinha.appendChild(chipBotao(o.rotulo, est.base === o.consulta, function () { if (gid) { entrarGrupo(gid); } else { escolherBase(o.consulta); } }));
    });
    if (conjOk) { chipsLinha.appendChild(el('a', { 'class': 'tg-busca-chip', href: urlBusca('conjuntos') }, ['Conjuntos'])); }
    if (nov) { chipsLinha.appendChild(chipBotao(nov.rotulo, est.novidades, function (b) { escolherNovidades(b); })); }
    if (!chipsLinha.firstChild) { chipsLinha.classList.add('tg-busca-oculto'); } else { chipsLinha.classList.remove('tg-busca-oculto'); }
  }

  // a barra: Ordenar | (espaco) | Tamanho | Cor | grade 1/2
  if (typeof tgOrdenar === 'function') {
    ordem = tgPgMenu('Ordenar', TG_PG_ORDENS.map(function (o) { return { valor: o[0], rotulo: o[1] }; }), 'relevancia', escolherOrdem, false, false);
    menus.push(ordem);
  }
  if (typeof tgFiltrar === 'function') {
    tam = tgPgMenu('Tamanho', tgPgOpcoesTamanho(), [], escolherTamanho, true, true);
    menus.push(tam);
    if (tgPgOpcoesCor(itens).length) { cor = tgPgMenu('Cor', tgPgOpcoesCor(itens), [], escolherCor, true, true, true); menus.push(cor); }
  }
  tg1 = el('button', { type: 'button', 'class': 'tg-busca-togg-1', 'aria-pressed': 'false', 'aria-label': 'Uma peça por linha' }, [el('span', { 'class': 'tg-busca-togg-q' })]);
  tg2 = el('button', { type: 'button', 'class': 'tg-busca-togg-2', 'aria-pressed': 'true', 'aria-label': 'Duas peças por linha' }, [el('span', { 'class': 'tg-busca-togg-q' }), el('span', { 'class': 'tg-busca-togg-q' })]);
  function colunas(um) {
    est.um = um;
    tg1.setAttribute('aria-pressed', um ? 'true' : 'false');
    tg2.setAttribute('aria-pressed', um ? 'false' : 'true');
    if (um) { grade.classList.add('tg-busca-grade-um'); } else { grade.classList.remove('tg-busca-grade-um'); }
    try { emitir('tg_busca_grade', { reason: um ? '1' : '2' }); } catch (e) {}
  }
  tg1.addEventListener('click', function () { try { colunas(true); } catch (e) {} });
  tg2.addEventListener('click', function () { try { colunas(false); } catch (e) {} });
  togg = el('div', { 'class': 'tg-busca-togg', role: 'group', 'aria-label': 'Tamanho da grade' }, [tg1, tg2]);
  ativos = el('div', { 'class': 'tg-busca-ativos tg-busca-oculto', role: 'group', 'aria-label': 'Filtros aplicados' });
  barra = el('div', { 'class': 'tg-busca-barra' }, [el('div', { 'class': 'tg-busca-barra-linha' }, [ordem ? ordem.no : null, el('span', { 'class': 'tg-busca-barra-espaco' }), tam ? tam.no : null, cor ? cor.no : null, togg]), ativos]);

  // fecha os menus ao clicar fora ou com Esc (um unico ouvinte por pagina). v15: o toque que fecha o menu so fecha (nao abre o card que estava embaixo).
  document.addEventListener('click', function (ev) {
    var j, engoliu = false;
    try {
      for (j = 0; j < menus.length; j++) {
        if (menus[j].aberto() && !menus[j].no.contains(ev.target)) { menus[j].fechar(); if (!(ev.target && ev.target.closest && ev.target.closest('.tg-busca-barra'))) { engoliu = true; } }
      }
      if (engoliu) { ev.preventDefault(); ev.stopPropagation(); }
    } catch (e) {}
  }, true);
  document.addEventListener('keydown', function (ev) {
    var j;
    try { if (ev.key === 'Escape') { for (j = 0; j < menus.length; j++) { menus[j].fechar(); } } } catch (e) {}
  });

  // QA 2 (25/11): o tamanho da busca vira o filtro Tamanho da barra (a lista-base passa a ser a busca sem o tamanho, para o x do filtro funcionar)
  try {
    if (res.tamanho && res.tamanho.aplicado && res.tamanho.texto && typeof tgPgOpcoesTamanho === 'function') {
      (function () {
        var pedidos = (res.tamanho.pedido || []).map(function (t) { return String(t).toUpperCase(); }), ids = [], semTam, j, k, g = typeof TG_TAMANHO_GRUPOS !== 'undefined' ? TG_TAMANHO_GRUPOS : [];
        for (j = 0; j < g.length; j++) { for (k = 0; k < g[j].v.length; k++) { if (pedidos.indexOf(String(g[j].v[k]).toUpperCase()) >= 0 && ids.indexOf(g[j].id) < 0) { ids.push(g[j].id); } } }
        if (!ids.length) { return; }
        semTam = runSearch(res.tamanho.texto, cat, TG_PG_LIMITE).results.filter(function (it) { return urlProduto(it.s) && precoFinal(it); });
        if (!semTam.length) { return; }
        fortesIds = tgPgFortes(semTam, runSearch(res.tamanho.texto, cat, TG_PG_LIMITE));
        itens = semTam; mapa = tgGruposCores(itens); est.atual = itens; est.tamanhos = ids;
      })();
    }
  } catch (e) {}
  if (res.tamanho) { aviso = tgAcAviso(res.tamanho); }
  else if (!grupoQ && !tgPgCasaNome(q, itens.slice(0, 6))) { aviso = el('div', { 'class': 'tg-busca-aviso-nome', role: 'status' }, ['Não encontramos “' + String(q).trim().slice(0, 60) + '”. Veja peças com nome parecido:']); }
  var precisaNov = urlLer();
  // chips acima da barra (Danilo, 24/11): ficam a vista, com respiro, e a barra (Ordenar, Tamanho, Cor, grade) gruda no topo ao rolar
  filhos = [tgConselheira(), voce, contador, aviso, chipsLinha, barra, ordCab, grade, vazio, mais, verNov];
  raiz = el('section', { id: 'tg-busca-resultados', 'class': 'tg-busca-pagina', 'aria-label': 'Resultados da busca' }, filhos);
  injetarEstilos();
  desenhar();
  destino.insertBefore(raiz, destino.firstChild || null);
  tgPgTopoBarra(raiz);
  // chip Conjuntos (so com a lista do Recom no ar e com pelo menos um par em estoque)
  try { tgConjuntosLista(cat).then(function (l) { if (l.length && (!gAtivo() || gAtivo() === 'blusas' || gAtivo() === 'calcas')) { conjOk = true; chips(); } }); } catch (e) {}
  if (precisaNov) {
    tgPgNovidades().then(function (h) { est.handles = h; if (est.novPend && h.length) { est.novidades = true; } est.novPend = false; desenhar(); });
  }
  if (TG_PG_ESCONDE_NATIVO) {
    nativo = document.querySelector('.js-product-table');
    if (nativo) { nativo.classList.add('tg-busca-nativo-oculto'); }
  }
  // a nossa tela tem o proprio titulo e a propria paginacao: somem os titulos nativos e o "Mostrar mais produtos" da Nuvem
  tgRgEsconderNativos(false);
  emitir('tg_busca_pagina_view', { results_count: itens.length, page_type: 'search' });
  return true;
}

// Alguma palavra digitada (3+ letras) aparece no texto das primeiras pecas? Se nenhuma aparece, a lista e "parecida", nao o que foi pedido.
function tgPgCasaNome(q, itens) {
  var ws = normalizeText(q).split(' ').filter(function (w) { return w.length >= 3; }), i, j, k, txt, v;
  if (!ws.length || !itens.length) { return true; }
  for (i = 0; i < itens.length; i++) {
    txt = '';
    for (k in itens[i]) { if (Object.prototype.hasOwnProperty.call(itens[i], k)) { v = itens[i][k]; if (typeof v === 'string') { txt += ' ' + v; } else if (Array.isArray(v)) { txt += ' ' + v.join(' '); } } }
    txt = ' ' + normalizeText(txt) + ' ';
    for (j = 0; j < ws.length; j++) { if (txt.indexOf(ws[j]) >= 0) { return true; } }
  }
  return false;
}

// Barra grudada no topo (v12, 24/11). Dois problemas do tema: (1) a .category-body tem overflow:hidden, que desliga o sticky de quem esta dentro;
// os pais da nossa pagina passam a overflow visivel (com corte so na horizontal, sem criar rolagem); (2) o cabecalho do tema encolhe ao rolar
// (84 -> 47 px no celular): o topo da barra acompanha a borda de baixo do cabecalho a cada quadro de rolagem. Sem cabecalho fixo, fica em 0.
function tgPgTopoBarra(raiz) {
  var hs, pedido = 0, ultimo = -1, barra = null;
  try {
    (function soltar() {
      var n = raiz.parentElement, cs;
      while (n && n !== document.body && n !== document.documentElement) {
        cs = window.getComputedStyle(n);
        if (/(hidden|clip)/.test(cs.overflowX + ' ' + cs.overflowY) && !/(auto|scroll)/.test(cs.overflowX + ' ' + cs.overflowY)) { n.classList.add('tg-busca-pai-solto'); }
        n = n.parentElement;
      }
    })();
  } catch (e) {}
  function medir() {
    var i, cs, r, h = 0;
    pedido = 0;
    try {
      if (!hs) { hs = document.querySelectorAll('.js-head-main, header, .head-main'); }
      for (i = 0; i < hs.length; i++) {
        cs = window.getComputedStyle(hs[i]);
        if (cs.position !== 'fixed' && cs.position !== 'sticky') { continue; }
        r = hs[i].getBoundingClientRect();
        if (r.height > 0 && r.height < 200 && r.bottom > 0 && r.top <= 1) { h = Math.max(h, Math.round(r.bottom)); }
      }
      if (h !== ultimo && (h > 0 || ultimo > 0)) { ultimo = h; raiz.style.setProperty('--tgb-barra-topo', h + 'px'); if (!barra) { barra = raiz.querySelector('.tg-busca-barra'); } if (barra) { barra.style.top = h + 'px'; } }
    } catch (e) {}
  }
  function pedir() { if (!pedido) { pedido = (window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); })(medir); } }
  medir();
  try { window.addEventListener('scroll', pedir, { passive: true }); window.addEventListener('resize', pedir); } catch (e) {}
}

// Esgotado nominal pela pagina de resultados: true se montou a tela de esgotada + parecidas.
function tgRgEsgotadoPagina(q, cat, esg) {
  var res = runSearch(q, cat, TG_RG_ESG_LIMITE, esg);
  return !!(res.esgotado && tgRgMontarEsgotado(q, res));
}

function ligarResgate() {
  var q, curada, resultados;
  if (!/^\/search/.test(window.location.pathname)) { return; }
  q = String(new URLSearchParams(window.location.search).get('q') || '').trim().slice(0, 200);
  if (!q) { tgPend(false); return; }
  // busca curada: os blocos aparecem mesmo com a lista nativa na tela (so ai o catalogo e baixado com resultados nativos)
  curada = tgEhBuscaCurada(q);
  // resultados novos: valem com a lista nativa na tela (a nossa a substitui); features.resultados === false volta ao comportamento antigo
  resultados = !curada && !(tgCtx && tgCtx.features && tgCtx.features.resultados === false);
  if (!curada && !resultados && document.querySelector('.js-product-table')) { tgPend(false); return; }
  function jaMontado() { return !!(document.getElementById('tg-busca-resgate') || document.getElementById('tg-busca-resultados')); }
  // esconde a lista nativa ja na largada (sem piscar a nativa antes da nossa); se a nossa nao subir, a nativa volta (fail-safe)
  function devolverNativa() {
    var n;
    try { if (!jaMontado() && !document.getElementById('tg-busca-curada')) { n = document.querySelector('.js-product-table'); if (n) { n.classList.remove('tg-busca-nativo-oculto'); } } } catch (e) {}
  }
  if (resultados) {
    try { if (document.querySelector('.js-product-table')) { document.querySelector('.js-product-table').classList.add('tg-busca-nativo-oculto'); setTimeout(function () { devolverNativa(); tgPend(false); }, 7000); } } catch (e) {}
  }
  function seguir(cat, esg) {
    var res;
    if (jaMontado()) { return; }
    // Conjuntos (v12): a pagina de pares do Recom; sem a lista do Recom, segue a busca de sempre
    if (resultados && tgEhBuscaConjuntos(q)) {
      return tgConjuntosLista(cat).then(function (l) { if (jaMontado()) { return; } if (l.length && tgCjMontar(l)) { return; } seguirBusca(cat, esg); });
    }
    return seguirBusca(cat, esg);
  }
  function seguirBusca(cat, esg) {
    var res;
    if (jaMontado()) { return; }
    if (resultados) {
      if (esg && tgRgEsgotadoPagina(q, cat, esg)) { return; }
      res = runSearch(q, cat, TG_PG_LIMITE);
      if (res.results.length && tgPgMontar(q, cat, res)) { return; }
      if (document.querySelector('.js-product-table')) { return; } // nada nosso para mostrar e a nativa tem resultado: fica a nativa
      tgRgMontar(q, cat, null);
      return;
    }
    if (document.querySelector('.js-product-table')) { return; }
    tgRgMontar(q, cat, esg);
  }
  obterCatalogo().then(function (cat) {
    var res;
    if (!cat) { return; }
    if (curada) {
      if (document.getElementById('tg-busca-curada')) { return; }
      res = runSearch(q, cat, TG_CURADA_PAGINA_LIMITE);
      if (res.curada && tgCuMontar(res)) { return; }
    }
    if (jaMontado() || (!resultados && document.querySelector('.js-product-table'))) { return; }
    // esgotado nominal: baixa o catalogo de esgotados so se a palavra pedida nao casa com nenhuma peca em estoque; falha = resultado de sempre
    if (tgPrecisaEsgotados(q, cat)) {
      return obterEsgotados().then(function (esg) { return seguir(cat, esg); });
    }
    return seguir(cat, null);
  })['catch'](function () {}).then(function () { if (resultados) { devolverNativa(); } tgPend(false); });
}


return { ligarAutocomplete: ligarAutocomplete, ligarResgate: ligarResgate };
}

function tgFrenteDesktop() {
/* ---- src/injetor/desktop/estilos.js ---- */
/*
 * Estilos do injetor - FRENTE DO DESKTOP (v13, 24/11: base do celular + camada TG_CSS_DESK no fim).
 * Estilos do injetor (redesign 18/11/2026). Todas as classes sob o prefixo .tg-busca- e os ids sob #tg-busca-, para nao colidir com o tema nem com os apps.
 * Entra por <style> com textContent, uma vez.
 *
 * TODO valor de design e uma variavel CSS --tgb-* com o padrao definido em TG_TOKENS (uma linha por variavel, formato fixo: a bancada
 * tools/bancada/aplicar-parametros.cjs regrava o padrao lendo esta lista). As variaveis ficam em :root (especificidade minima), entao quem quiser
 * ajustar ao vivo basta fazer document.documentElement.style.setProperty('--tgb-...', valor).
 * Fonte, cor do texto, fundo e destaque HERDAM do tema da Talgui (Morelia: --body-font, --heading-font, --main-foreground, --main-background,
 * --accent-color, --label-background), com reserva para quando a variavel do tema nao existe (bancada, testes).
 */
// A tela do celular usa as fotos leves do CDN (webp 640/320) com volta automatica para a original; o desktop segue com as fotos de sempre.
// Desktop (v13): fotos de sempre (as leves do CDN sao do celular).

var TG_TOKENS = [
  // tipografia
  ['--tgb-fonte', 'var(--body-font,"Poppins"),"Poppins",Arial,sans-serif'],
  ['--tgb-fonte-titulo', 'var(--heading-font,"Graphik"),var(--tgb-fonte)'],
  // cores
  ['--tgb-cor-texto', 'var(--main-foreground,#111111)'],
  ['--tgb-cor-texto-suave', '#6f6a64'],
  ['--tgb-cor-fundo', 'var(--main-background,#ffffff)'],
  ['--tgb-cor-fundo-suave', '#f5f2ed'],
  ['--tgb-cor-borda', '#d6d0c8'],
  ['--tgb-cor-destaque', 'var(--accent-color,#000000)'],
  ['--tgb-cor-destaque-texto', '#ffffff'],
  ['--tgb-cor-promo', 'var(--tgb-cor-texto)'],
  ['--tgb-cor-selo-texto', '#111111'],
  ['--tgb-cor-selo-oferta', 'var(--label-background,#c80003)'],
  ['--tgb-cor-selo-best', '#ffffff'],
  ['--tgb-cor-selo-ultimas', '#ffffff'],
  ['--tgb-cor-selo-esgotado', '#ffffff'],
  ['--tgb-cor-sucesso', 'var(--success,#2e8b63)'],
  ['--tgb-cor-erro', 'var(--danger,#c0392b)'],
  // pagina e grade
  ['--tgb-pad-pagina', '16px'],
  ['--tgb-pad-card', '0px'],
  ['--tgb-gap-grade', '9px'],
  ['--tgb-gap-linha', '24px'],
  ['--tgb-colunas-mobile', '2'],
  ['--tgb-colunas-desktop', '4'],
  ['--tgb-raio-card', '0px'],
  ['--tgb-sombra-card', 'none'],
  ['--tgb-foto-proporcao', '2 / 3'],
  ['--tgb-foto-ajuste', 'cover'],
  ['--tgb-foto-fundo', '#f1eee9'],
  // nome, preco e selo
  ['--tgb-nome-tam', '13.5px'],
  ['--tgb-nome-peso', '300'],
  ['--tgb-nome-linhas', '2'],
  ['--tgb-nome-transformacao', 'none'],
  ['--tgb-preco-tam', '13px'],
  ['--tgb-preco-peso', '400'],
  ['--tgb-preco-de-tam', '11.5px'],
  ['--tgb-selo-tam', '10px'],
  ['--tgb-selo-raio', '0px'],
  ['--tgb-selo-espaco', '0px'],
  // bolinhas de cor, tamanhos, botao e chips
  ['--tgb-bolinha-tam', '18px'],
  ['--tgb-bolinha-gap', '8px'],
  ['--tgb-tamanho-btn', '24px'],
  ['--tgb-tamanho-fonte', '11.5px'],
  ['--tgb-tamanho-gap', '4px'],
  ['--tgb-tamanho-raio', '0'],
  ['--tgb-botao-altura', '40px'],
  ['--tgb-botao-raio', '2px'],
  ['--tgb-botao-fonte', '12.5px'],
  ['--tgb-botao-peso', '600'],
  ['--tgb-botao-transformacao', 'uppercase'],
  ['--tgb-botao-espaco', '0.06em'],
  ['--tgb-chip-tam', '11px'],
  ['--tgb-chip-altura', '28px'],
  ['--tgb-chip-raio', '2px'],
  ['--tgb-chip-gap', '2px'],
  // overlay de busca
  ['--tgb-z', '99990'],
  ['--tgb-ov-campo-altura', '46px'],
  ['--tgb-ov-campo-fonte', '15px'],
  ['--tgb-ov-termo-tam', '13.5px'],
  ['--tgb-ov-titulo-tam', '12px'],
  ['--tgb-ov-max-largura', '1190px'],
  ['--tgb-ov-raio', '0 0 14px 14px'],
  ['--tgb-ov-fundo-escuro', 'rgba(0,0,0,.7)'],
  ['--tgb-ov-colunas-mobile', '2'],
  ['--tgb-ov-colunas-desktop', '4'],
  // barra da pagina de resultados
  ['--tgb-barra-altura', '36px'],
  ['--tgb-barra-fonte', '11px'],
  ['--tgb-barra-posicao', 'sticky'],
  ['--tgb-barra-topo', '0px'],
  ['--tgb-barra-fundo', 'var(--tgb-cor-fundo)']
];

// Cor da bolinha: o nome da cor (sem acento, minuscula, espacos viram hifen) escolhe o tom, SEM atributo style (a saida segura nao aceita style).
// Cada linha: [nomes (masculino e feminino), tom]. Nome fora da lista usa o tom neutro (data-cor="outro").
var TG_COR_TONS = [
  [['preto', 'preta'], '#161616'], [['branco', 'branca'], '#fafafa'], [['off-white', 'offwhite', 'cru', 'creme'], '#f0e9dc'],
  [['bege', 'nude', 'areia', 'fendi'], '#d8c3a5'], [['marrom', 'cafe', 'chocolate'], '#6b4a35'], [['caramelo', 'camel', 'terracota'], '#b97a47'],
  [['cinza', 'grafite', 'chumbo'], '#8d8d8d'], [['prata'], '#c4c7cc'], [['dourado', 'dourada', 'ouro'], '#c9a54a'],
  [['vermelho', 'vermelha', 'goiaba', 'coral'], '#c62828'], [['vinho', 'bordo', 'marsala'], '#6e1423'], [['rosa', 'rose', 'salmao'], '#e8a2b4'],
  [['pink', 'fucsia', 'magenta'], '#d81b79'], [['rosa-claro'], '#f4cdd6'], [['laranja'], '#e8742a'],
  [['amarelo', 'amarela', 'amarelo-sol', 'amarelo-ouro', 'amarelo-canario'], '#f2c230'], [['amarelo-claro', 'amarela-claro', 'manteiga'], '#f6e7a4'],
  [['mostarda'], '#c99a1d'], [['verde'], '#3f8f5b'], [['verde-claro', 'verde-agua', 'verde-menta', 'menta'], '#a8d8be'],
  [['verde-militar', 'verde-oliva', 'verde-musgo', 'oliva', 'musgo'], '#5b6b3a'], [['verde-floresta', 'verde-esmeralda', 'esmeralda'], '#1f5d3f'],
  [['verde-limao'], '#b5d334'], [['azul'], '#2f63b5'], [['azul-claro', 'azul-bebe', 'azul-celeste', 'celeste'], '#9cc6ec'],
  [['azul-marinho', 'marinho'], '#18284d'], [['azul-royal', 'azul-turquesa', 'turquesa'], '#1c7fc2'], [['azul-jeans', 'jeans'], '#4a6a94'],
  [['petroleo'], '#1d4b57'], [['roxo', 'roxa', 'uva'], '#6a3f93'], [['lilas', 'lavanda'], '#b9a4d6']
];

var TG_CSS_BASE = [
  '.tg-busca-oculto,#tg-busca-overlay.tg-busca-oculto{display:none!important}',
  '.tg-busca-sr{position:absolute!important;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
  'html.tg-busca-trava,html.tg-busca-trava body{overflow:hidden!important}',
  '.tg-busca-nativo-oculto{display:none!important}',
  // enquanto a busca nova nao assumiu (classe no <html>, posta pelo topo do tema ou pela lupa), a lista e as sugestoes da nativa ficam escondidas
  'html.tg-busca-pendente.tg-busca-pg .js-product-table,html.tg-busca-pendente.tg-busca-pg .js-load-more,html.tg-busca-pendente.tg-busca-pg #js-infinite-scroll-spinner,html.tg-busca-pendente #nav-search [class*="search-suggest"],html.tg-busca-pendente #nav-search .search-initial-products{display:none!important}',
  // celular: entre o toque na lupa e a abertura da busca nova, o modal nativo nao aparece (o overlay abre por cima no mesmo instante)
  'html.tg-busca-pendente #nav-search .modal-scrollable-area{opacity:0!important}',
  '#tg-busca-conselheira{display:none}',
  // base comum a tudo que o injetor desenha
  '#tg-busca-overlay,#tg-busca-resultados,#tg-busca-resgate,#tg-busca-curada{font-family:var(--tgb-fonte);color:var(--tgb-cor-texto);-webkit-font-smoothing:antialiased;line-height:1.35}',
  '#tg-busca-overlay *,#tg-busca-resultados *,#tg-busca-resgate *,#tg-busca-curada *{box-sizing:border-box}',
  '#tg-busca-overlay button,#tg-busca-resultados button,#tg-busca-resgate button,#tg-busca-curada button{font-family:inherit}',
  '#tg-busca-overlay :focus-visible,#tg-busca-resultados :focus-visible,#tg-busca-resgate :focus-visible,#tg-busca-curada :focus-visible{outline:2px solid var(--tgb-cor-destaque);outline-offset:2px}',
  // icones feitos em CSS (a saida segura nao aceita SVG)
  // lupa com a mesma geometria e o mesmo peso (1,6px) da lupa do tema, que combina com o icone do Menu; so CSS (a saida segura nao aceita SVG nem url())
  '.tg-busca-ico-lupa{position:relative;display:inline-block;width:18px;height:18px;flex:0 0 18px;color:inherit}',
  '.tg-busca-ico-lupa::before{content:"";position:absolute;left:0;top:.2px;width:13.9px;height:13.9px;border:1.6px solid currentColor;border-radius:50%;box-sizing:border-box}',
  '.tg-busca-ico-lupa::after{content:"";position:absolute;left:11.9px;top:12.4px;width:7px;height:1.7px;border-radius:1px;background:currentColor;transform:rotate(45deg);transform-origin:0 50%}'
];

var TG_CSS_OVERLAY = [
  '#tg-busca-overlay{position:fixed;top:0;right:0;bottom:0;left:0;z-index:var(--tgb-z);display:flex;flex-direction:column;background:var(--tgb-cor-fundo)}',
  '#tg-busca-overlay.tg-busca-aberto{animation:tg-busca-entra .18s ease-out}',
  '.tg-busca-ov-painel{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:var(--tgb-cor-fundo)}',
  '.tg-busca-ov-form{display:flex;align-items:center;gap:2px;flex:0 0 auto;height:var(--tgb-ov-campo-altura);margin:0;padding:0 6px;border-bottom:1px solid var(--tgb-cor-borda)}',
  '.tg-busca-ov-campo{flex:1;min-width:0;height:100%;margin:0;padding:0 6px;border:0;border-radius:0;outline:0;background:transparent;color:inherit;font-family:inherit;font-size:var(--tgb-ov-campo-fonte);-webkit-appearance:none;appearance:none;box-shadow:none}',
  '#tg-busca-overlay .tg-busca-ov-campo:focus,#tg-busca-overlay .tg-busca-ov-campo:focus-visible{outline:0;box-shadow:none}',
  '.tg-busca-ov-campo::-webkit-search-cancel-button,.tg-busca-ov-campo::-webkit-search-decoration{display:none;-webkit-appearance:none}',
  '.tg-busca-ov-campo::placeholder{color:var(--tgb-cor-texto-suave);opacity:1}',
  '.tg-busca-ov-btn{display:flex;align-items:center;justify-content:center;flex:0 0 44px;width:44px;height:44px;margin:0;padding:0;border:0;border-radius:50%;background:transparent;color:inherit;font-size:26px;line-height:1;cursor:pointer}',
  '.tg-busca-ov-btn:hover{background:var(--tgb-cor-fundo-suave)}',
  // voltar: chevron em CSS com o mesmo traco (1,6px) da lupa, no lugar do caractere fino
  '.tg-busca-ico-voltar{display:block;width:11px;height:11px;margin-left:5px;border-left:1.6px solid currentColor;border-bottom:1.6px solid currentColor;transform:rotate(45deg)}',
  '.tg-busca-ov-corpo{flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:0 var(--tgb-pad-pagina) 28px}',
  '#tg-busca-sugestoes{margin:0;background:transparent;border:0;box-shadow:none;max-height:none;overflow:visible}',
  '.tg-busca-secao-titulo{margin:20px 0 8px;font-family:var(--tgb-fonte-titulo);font-size:var(--tgb-ov-titulo-tam);font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--tgb-cor-texto-suave)}',
  '.tg-busca-secao-titulo:first-child{margin-top:16px}',
  '.tg-busca-termos{list-style:none;margin:6px 0 0;padding:0}',
  '.tg-busca-termos li{display:flex;align-items:center}',
  '.tg-busca-termo{display:flex;align-items:center;flex:1;gap:12px;min-width:0;min-height:48px;color:inherit;text-decoration:none;font-size:var(--tgb-ov-termo-tam)}',
  '.tg-busca-termo-texto{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
  '.tg-busca-termo-texto strong{font-weight:700}',
  '.tg-busca-recentes{list-style:none;margin:0;padding:0}',
  '.tg-busca-recentes li{display:flex;align-items:center}',
  '.tg-busca-recentes-topo{display:flex;align-items:baseline;justify-content:space-between;gap:12px}',
  '.tg-busca-recentes-topo .tg-busca-limpar{padding:6px 0 6px 12px;letter-spacing:0;text-transform:none;font-weight:400}',
  '.tg-busca-limpar{margin:0;padding:6px 0;border:0;background:none;color:var(--tgb-cor-texto-suave);font-size:12px;text-decoration:underline;cursor:pointer}',
  '.tg-busca-banner{margin:12px 0 0;padding:10px 12px;background:var(--tgb-cor-fundo-suave);border-radius:var(--tgb-raio-card);font-size:13px;color:var(--tgb-cor-texto-suave)}',
  '.tg-busca-banner strong,.tg-busca-sugerido{color:var(--tgb-cor-texto);font-weight:700}',
  '.tg-busca-sugerido{cursor:pointer;text-decoration:underline;background:none;border:0;padding:0;font:inherit;font-weight:700}',
  // peca na lista do overlay: card enxuto (foto, nome, preco, selo, tamanhos), sem botao de adicionar
  '.tg-busca-lista{display:grid;grid-template-columns:repeat(var(--tgb-ov-colunas-mobile),minmax(0,1fr));gap:var(--tgb-gap-linha) var(--tgb-gap-grade);margin:0;padding:0;list-style:none}',
  '.tg-busca-item{display:flex;flex-direction:column;min-width:0;color:inherit;text-decoration:none}',
  '.tg-busca-info{min-width:0;margin-top:8px}',
  '.tg-busca-meta{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;margin-bottom:6px}',
  '.tg-busca-pilulas{display:flex;flex-wrap:wrap;gap:4px}',
  '.tg-busca-meta .tg-busca-selo{padding:0;box-shadow:none;background:none;color:var(--tgb-cor-texto-suave);font-size:10px;letter-spacing:.08em}',
  '.tg-busca-pilula{padding:2px 6px;border:1px solid var(--tgb-cor-borda);border-radius:var(--tgb-tamanho-raio);color:var(--tgb-cor-texto-suave);font-size:10px;font-weight:500;line-height:1.3}',
  '.tg-busca-pilula-pedida{border-color:var(--tgb-cor-destaque);background:var(--tgb-cor-destaque);color:var(--tgb-cor-destaque-texto);font-weight:700}',
  '.tg-busca-item-esgotado .tg-busca-thumb{filter:grayscale(1);opacity:.55}',
  '.tg-busca-bloco-titulo{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:20px 0 8px;font-family:var(--tgb-fonte-titulo);font-size:var(--tgb-ov-titulo-tam);font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--tgb-cor-texto-suave)}',
  '.tg-busca-bloco-qtd{font-weight:500;letter-spacing:.04em}',
  '.tg-busca-todos{display:flex;align-items:center;justify-content:center;width:100%;height:var(--tgb-botao-altura);margin:22px 0 0;border:1px solid var(--tgb-cor-destaque);border-radius:var(--tgb-botao-raio);background:var(--tgb-cor-destaque);color:var(--tgb-cor-destaque-texto);font-size:var(--tgb-botao-fonte);font-weight:var(--tgb-botao-peso);letter-spacing:var(--tgb-botao-espaco);text-transform:var(--tgb-botao-transformacao);text-decoration:none}'
];

var TG_CSS_CARD = [
  '.tg-busca-thumb{display:block;width:100%;height:auto;aspect-ratio:var(--tgb-foto-proporcao);object-fit:var(--tgb-foto-ajuste);background:var(--tgb-foto-fundo);border-radius:var(--tgb-raio-card)}',
  '.tg-busca-nome{min-height:calc(var(--tgb-nome-linhas) * 1.3em);display:-webkit-box;word-break:break-word;-webkit-box-orient:vertical;-webkit-line-clamp:var(--tgb-nome-linhas);overflow:hidden;margin:0 0 4px;font-size:var(--tgb-nome-tam);font-weight:var(--tgb-nome-peso);line-height:1.3;text-transform:var(--tgb-nome-transformacao)}',
  '.tg-busca-preco{display:inline-flex;align-items:baseline;flex-wrap:wrap;gap:2px 6px;font-size:var(--tgb-preco-tam)}',
  '.tg-busca-preco strong{font-weight:var(--tgb-preco-peso)}',
  '.tg-busca-preco strong:not(:last-child){color:var(--tgb-cor-promo)}',
  '.tg-busca-de{font-size:var(--tgb-preco-de-tam);font-weight:400;color:var(--tgb-cor-texto-suave);text-decoration:line-through}',
  '.tg-busca-selo{display:inline-block;padding:5px 8px;box-shadow:0 1px 2px rgba(0,0,0,.12);border-radius:var(--tgb-selo-raio);color:var(--tgb-cor-selo-texto);font-size:var(--tgb-selo-tam);font-weight:600;line-height:1;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap}',
  '.tg-busca-selo-campeao{background:var(--tgb-cor-selo-best)}',
  '.tg-busca-selo-ultimas{background:var(--tgb-cor-selo-ultimas)}',
  '.tg-busca-selo-oferta{background:var(--tgb-cor-selo-oferta);color:#fff}',
  '.tg-busca-selo-esgotado{background:var(--tgb-cor-selo-esgotado)}',
  '.tg-busca-grade{display:grid;grid-template-columns:repeat(var(--tgb-colunas-mobile),minmax(0,1fr));gap:var(--tgb-gap-linha) var(--tgb-gap-grade);margin:0;padding:0;text-align:left}',
  '.tg-busca-grade.tg-busca-grade-um{grid-template-columns:minmax(0,1fr)}',
  '.tg-busca-card{position:relative;display:flex;flex-direction:column;min-width:0;padding:var(--tgb-pad-card);border-radius:var(--tgb-raio-card);box-shadow:var(--tgb-sombra-card);background:var(--tgb-cor-fundo);color:inherit}',
  '.tg-busca-card-midia{position:relative;display:block}',
  '.tg-busca-card-midia .tg-busca-selo{position:absolute;left:var(--tgb-selo-espaco);bottom:var(--tgb-selo-espaco);max-width:calc(100% - 8px);overflow:hidden;text-overflow:ellipsis;pointer-events:none}',
  '.tg-busca-card-link{display:block;color:inherit;text-decoration:none}',
  '.tg-busca-card-texto{margin-top:10px}',
  '.tg-busca-card-esgotado .tg-busca-thumb{filter:grayscale(1);opacity:.55}',
  '.tg-busca-cores-vazio{visibility:hidden}',
  '.tg-busca-cores{display:flex;align-items:center;flex-wrap:wrap;gap:var(--tgb-bolinha-gap);min-height:var(--tgb-bolinha-tam);margin:10px 0 0}',
  '.tg-busca-bolinha{position:relative;flex:0 0 auto;width:var(--tgb-bolinha-tam);height:var(--tgb-bolinha-tam);margin:0;padding:0;border:1px solid rgba(0,0,0,.2);border-radius:50%;background:#cfcac3;cursor:pointer}',
  '.tg-busca-bolinha::after{content:"";position:absolute;top:-11px;right:-3px;bottom:-11px;left:-3px}',
  '.tg-busca-bolinha[data-cor="outro"]{background:conic-gradient(#d9a7b0,#e9d28a,#9ec8a6,#9cb7e0,#d9a7b0)}',
  '.tg-busca-bolinha-atual{box-shadow:0 0 0 2px var(--tgb-cor-fundo),0 0 0 3px var(--tgb-cor-texto)}',
  '.tg-busca-bolinha-esgotada::before{content:"";position:absolute;top:0;right:0;bottom:0;left:0;border-radius:50%;background:linear-gradient(135deg,transparent 45%,rgba(0,0,0,.6) 46%,rgba(0,0,0,.6) 54%,transparent 55%)}',
  '.tg-busca-bolinha-mais{width:auto;height:auto;border:0;border-radius:0;background:none;color:var(--tgb-cor-texto-suave);font-size:11px}',
  '.tg-busca-bolinha-mais::after{display:none}',
  // tamanhos no padrao da pagina de categoria: abaixo do nome, alinhados a esquerda, quadradinhos de 22px com borda fina, preco depois
  '.tg-busca-tams{display:flex;flex-wrap:wrap;justify-content:flex-start;gap:var(--tgb-tamanho-gap);margin:7px 0 0}',
  '.tg-busca-tam{position:relative;flex:0 0 auto;min-width:var(--tgb-tamanho-btn);height:var(--tgb-tamanho-btn);margin:0;padding:0 3px;display:flex;align-items:center;justify-content:center;border:1px solid #555;border-radius:var(--tgb-tamanho-raio);background:var(--tgb-cor-fundo);color:var(--tgb-cor-texto);font-size:var(--tgb-tamanho-fonte);font-weight:400;text-transform:uppercase;line-height:1;cursor:pointer}',
  '.tg-busca-tam::after{content:"";position:absolute;top:-9px;right:0;bottom:-9px;left:0}',
  '.tg-busca-tam:hover{border-color:var(--tgb-cor-texto)}',
  '.tg-busca-card-preco{display:block;margin-top:8px;color:inherit;text-decoration:none}',
  '.tg-busca-tam[aria-pressed="true"]{border-color:var(--tgb-cor-destaque);background:var(--tgb-cor-destaque);color:var(--tgb-cor-destaque-texto)}',
  '.tg-busca-card-pede .tg-busca-tam{border-color:var(--tgb-cor-erro)}',
  '.tg-busca-card-pede .tg-busca-tams{animation:tg-busca-treme .35s ease-in-out}',
  '.tg-busca-tapete{display:grid;grid-template-columns:minmax(0,1fr);gap:0}',
  '.tg-busca-tapete-secao{min-width:0}',
  '.tg-busca-tapete-grade{grid-template-columns:repeat(2,minmax(0,1fr))}',
  // card padrao do tapete: foto 3/4 (peca unica = 1 foto; conjunto = 2 fotos lado a lado na MESMA altura), cor, nome, preco; tudo abre o quick view
  '.tg-busca-tp-foto{position:relative;display:grid;grid-template-columns:minmax(0,1fr);gap:2px;aspect-ratio:3 / 4;overflow:hidden;border-radius:var(--tgb-raio-card);background:var(--tgb-foto-fundo);color:inherit;text-decoration:none}',
  '.tg-busca-tp-foto-dupla{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}',
  '.tg-busca-tp-foto .tg-busca-thumb{width:100%;height:100%;aspect-ratio:auto;border-radius:0;object-position:50% 18%}',
  '.tg-busca-conj-mais{position:absolute;left:50%;top:42%;transform:translate(-50%,-50%);width:20px;height:20px;border-radius:50%;background:var(--tgb-cor-fundo);color:var(--tgb-cor-texto);font-size:14px;line-height:19px;text-align:center;box-shadow:0 0 0 1px var(--tgb-cor-borda)}',
  '.tg-busca-tp .tg-busca-cores{margin:8px 0 0;min-height:0}',
  '.tg-busca-tp .tg-busca-nome{margin:4px 0 0;-webkit-line-clamp:2;min-height:2.6em}',
  '.tg-busca-tp .tg-busca-card-preco{margin-top:4px}',
  '.tg-busca-tp-foto{padding:0;border:0;cursor:pointer;font:inherit}',
  'button.tg-busca-conj-nome{padding:0;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer}',
  '.tg-busca-conj-nome{color:inherit;text-decoration:none}',
  '.tg-busca-conj-cor{font-size:11px;color:var(--tgb-cor-texto-suave)}',
  '.tg-busca-add{display:block;width:100%;height:var(--tgb-botao-altura);margin:10px 0 0;padding:0 8px;border:1px solid var(--tgb-cor-destaque);border-radius:var(--tgb-botao-raio);background:var(--tgb-cor-destaque);color:var(--tgb-cor-destaque-texto);font-size:var(--tgb-botao-fonte);font-weight:var(--tgb-botao-peso);letter-spacing:var(--tgb-botao-espaco);text-transform:var(--tgb-botao-transformacao);cursor:pointer}',
  '.tg-busca-add[aria-disabled="true"]{border-color:var(--tgb-cor-texto);background:var(--tgb-cor-fundo);color:var(--tgb-cor-texto)}',
  '.tg-busca-add.tg-busca-add-ok{border-color:var(--tgb-cor-sucesso);background:var(--tgb-cor-sucesso);color:#fff}',
  '.tg-busca-msg{margin:6px 0 0;font-size:11.5px;color:var(--tgb-cor-erro)}',
  '.tg-busca-msg:empty{display:none}',
  '.tg-busca-chips{display:flex;flex-wrap:wrap;gap:var(--tgb-chip-gap);margin:0;padding:0;list-style:none}',
  '.tg-busca-chip{display:inline-flex;align-items:center;flex:0 0 auto;min-height:var(--tgb-chip-altura);margin:0;padding:0 16px;border:1px solid var(--tgb-cor-borda);border-radius:var(--tgb-chip-raio);background:var(--tgb-cor-fundo);color:var(--tgb-cor-texto);font-size:var(--tgb-chip-tam);text-decoration:none;white-space:nowrap;cursor:pointer}',
  '.tg-busca-chip:hover{border-color:var(--tgb-cor-texto)}',
  '.tg-busca-chip-ativo{border-color:var(--tgb-cor-destaque);background:var(--tgb-cor-destaque);color:var(--tgb-cor-destaque-texto)}',
  // card horizontal (v12, padrao do modal Influenciadoras): foto a esquerda; nome, preco, cores, tamanhos e "Detalhes da peca" a direita
  '.tg-busca-hc-lista{display:grid;grid-template-columns:minmax(0,1fr);gap:26px}',
  '.tg-busca-hc-par{display:grid;grid-template-columns:minmax(0,1fr);gap:26px}',
  '.tg-busca-hc{display:grid;grid-template-columns:42% minmax(0,1fr);gap:0 14px;align-items:start;min-width:0}',
  '.tg-busca-hc-foto{display:block;width:100%;margin:0;padding:0;border:0;border-radius:0;background:var(--tgb-foto-fundo);aspect-ratio:2 / 3;overflow:hidden;cursor:pointer;font:inherit}',
  '.tg-busca-hc-foto .tg-busca-thumb{width:100%;height:100%;aspect-ratio:auto;object-position:50% 20%}',
  '.tg-busca-hc-inf{display:flex;flex-direction:column;align-items:flex-start;min-width:0;padding-top:2px}',
  '.tg-busca-hc-nome{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:0;padding:0;border:0;background:none;color:inherit;font:inherit;font-size:14px;font-weight:400;line-height:1.35;text-align:left}',
  '.tg-busca-hc .tg-busca-hc-foto{cursor:default}',
  '.tg-busca-hc-preco{margin:6px 0 0;font-size:14px}',
  '.tg-busca-hc-preco strong{font-weight:600}',
  '.tg-busca-hc .tg-busca-hc-cores{margin:12px 0 0;gap:9px;min-height:0}',
  '.tg-busca-hc .tg-busca-bolinha{width:14px;height:14px}',
  '.tg-busca-hc-cor{font-size:12px;color:var(--tgb-cor-texto-suave)}',
  '.tg-busca-hc-tams{display:flex;flex-wrap:wrap;gap:4px;margin:12px 0 0}',
  '.tg-busca-hc-tam{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:22px;padding:0 4px;border:1px solid var(--tgb-cor-borda);font-size:10.5px;line-height:1;color:var(--tgb-cor-texto)}',
  'button.tg-busca-hc-det{display:inline-flex;align-items:center;gap:8px;min-height:40px;margin:14px 0 0;padding:0 14px;border:1px solid var(--tgb-cor-texto);border-radius:0;background:var(--tgb-cor-fundo);color:var(--tgb-cor-texto);font:inherit;font-size:12.5px;line-height:1.2;cursor:pointer}',
  'button.tg-busca-hc-det::after{content:"";width:6px;height:6px;border-top:1.5px solid currentColor;border-right:1.5px solid currentColor;transform:rotate(45deg)}',
  // vitrine inicial: respiro de ~12% da tela entre uma secao e a proxima (a atencao so passa para o proximo bloco ao rolar)
  '.tg-busca-tapete{margin-top:6px}',
  '.tg-busca-tapete-secao>.tg-busca-secao-titulo{margin:22px 0 14px}',
  '.tg-busca-tapete-secao+.tg-busca-tapete-secao{margin-top:clamp(56px,12vh,104px)}',
  '.tg-busca-tapete-todos{display:inline-block;margin:18px 0 0;font-size:12.5px;color:inherit;text-decoration:underline;text-underline-offset:3px}',
  // esqueleto da vitrine (mesma altura dos cards: a tela nao pula quando as pecas chegam)
  '.tg-busca-hc-esq .tg-busca-hc-foto{animation:tg-busca-pulsa 1.2s ease-in-out infinite}',
  '.tg-busca-hc-esq .tg-busca-hc-inf i{display:block;width:85%;height:12px;margin:4px 0 12px;background:var(--tgb-cor-fundo-suave);animation:tg-busca-pulsa 1.2s ease-in-out infinite}',
  '.tg-busca-hc-esq .tg-busca-hc-inf i:nth-child(2){width:40%}',
  '.tg-busca-hc-esq .tg-busca-hc-inf i:nth-child(3){width:62%}',
  '.tg-busca-esq-titulo{width:90px;height:12px;margin:22px 0 14px;background:var(--tgb-cor-fundo-suave)}',
  '.tg-busca-carregando{text-align:center}',
  // pagina de Conjuntos: um par por bloco, com linha fina entre os pares
  '.tg-busca-pagina-conj .tg-busca-hc-lista{gap:0}',
  '.tg-busca-pagina-conj .tg-busca-hc-par{padding:24px 0;border-bottom:1px solid var(--tgb-cor-borda)}',
  '.tg-busca-pagina-conj .tg-busca-hc-par:first-child{padding-top:4px}',
  '.tg-busca-cj-sub{margin:0 0 14px;text-align:center;font-size:12.5px;color:var(--tgb-cor-texto-suave)}',
  // barra grudada: os pais da pagina que cortavam (overflow) deixam o sticky funcionar (corte so na horizontal, sem criar rolagem)
  '.tg-busca-pai-solto{overflow:visible!important;overflow-x:clip!important}',
  'a.tg-busca-ver-nov{display:flex;align-items:center;justify-content:center;text-decoration:none}',
  '@keyframes tg-busca-pulsa{50%{opacity:.5}}',
  // card da busca (v12, Danilo 24/11): tamanhos e bolinhas so informam; VER PECA (contorno) abre o modal e fica no pe do card, alinhado na linha
  'span.tg-busca-tam,span.tg-busca-bolinha{cursor:default}',
  'span.tg-busca-tam::after,span.tg-busca-bolinha::after{display:none}',
  'span.tg-busca-tam:hover{border-color:#555}',
  '.tg-busca-tam-pedido{border-color:var(--tgb-cor-destaque);background:var(--tgb-cor-destaque);color:var(--tgb-cor-destaque-texto)}',
  '.tg-busca-card .tg-busca-tams{flex-wrap:nowrap;overflow:hidden;min-height:var(--tgb-tamanho-btn)}',
  // v14 (Danilo, 24/11): moldura sutil nos cards da grade (antes so o espaco separava um card do outro); a foto vai de borda a borda e o texto ganha respiro
  '.tg-busca-grade .tg-busca-card{border:1px solid #e6e1da;padding-bottom:10px}',
  '.tg-busca-grade .tg-busca-card>:not(.tg-busca-card-midia){margin-left:8px;margin-right:8px}',
  '.tg-busca-grade .tg-busca-card .tg-busca-add.tg-busca-ver{width:auto}',
  '.tg-busca-tams-vazio{visibility:hidden}',
  '.tg-busca-card .tg-busca-card-preco{margin-bottom:12px}',
  '.tg-busca-card .tg-busca-add.tg-busca-ver{margin-top:auto;border-color:var(--tgb-cor-texto);background:var(--tgb-cor-fundo);color:var(--tgb-cor-texto)}',
  // filtros aplicados: microchips discretos dentro da barra grudada + "Limpar busca"
  '.tg-busca-ativos{display:flex;align-items:center;gap:12px;padding:7px 0 8px;border-top:1px solid var(--tgb-cor-borda)}',
  '.tg-busca-ativos-lista{display:flex;flex:1 1 auto;min-width:0;gap:6px;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch}',
  '.tg-busca-ativos-lista::-webkit-scrollbar{display:none}',
  '.tg-busca-micro{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;height:26px;margin:0;padding:0 8px 0 10px;border:1px solid var(--tgb-cor-texto);border-radius:var(--tgb-chip-raio);background:var(--tgb-cor-fundo);color:var(--tgb-cor-texto);font:inherit;font-size:11px;line-height:1;white-space:nowrap;cursor:pointer}',
  '.tg-busca-micro-x{font-size:14px;line-height:1;color:var(--tgb-cor-texto-suave)}',
  '.tg-busca-limpar-busca{flex:0 0 auto;margin:0;padding:6px 0;border:0;background:none;color:var(--tgb-cor-texto);font:inherit;font-size:11.5px;white-space:nowrap;text-decoration:underline;text-underline-offset:3px;cursor:pointer}'
];

var TG_CSS_PAGINA = [
  '#tg-busca-resultados{max-width:1400px;margin:0 auto;padding:0 var(--tgb-pad-pagina) 36px}',
  '.tg-busca-pg-titulo{margin:18px 0 4px;font-family:var(--tgb-fonte-titulo);font-size:20px;font-weight:600;line-height:1.25}',
  '.tg-busca-voce{margin:16px 0 4px;padding:0 12px;text-align:center;font-family:var(--tgb-fonte-titulo);font-size:11.5px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:var(--tgb-cor-texto-suave);line-height:1.5}',
  '.tg-busca-voce strong{font-weight:700;color:var(--tgb-cor-texto)}',
  '.tg-busca-aviso-nome{margin:12px 0 0;padding:10px 12px;background:var(--tgb-cor-fundo-suave);font-size:13px;line-height:1.45;color:var(--tgb-cor-texto)}',
  '.tg-busca-voce::after{content:"";display:block;width:28px;height:1px;margin:10px auto 0;background:var(--tgb-cor-texto)}',
  '.tg-busca-grade-titulo{grid-column:1 / -1;margin:14px 0 0;padding:0 0 8px;border-bottom:1px solid var(--tgb-cor-borda);font-family:var(--tgb-fonte-titulo);font-size:12px;font-weight:600;letter-spacing:.12em;text-transform:uppercase}',
  '.tg-busca-grade-titulo:first-child{margin-top:0}',
  '.tg-busca-pg-sub{margin:0 0 4px;font-size:13px;color:var(--tgb-cor-texto-suave)}',
  '.tg-busca-barra{position:var(--tgb-barra-posicao);top:var(--tgb-barra-topo);z-index:5;margin:12px 0 14px;border-top:1px solid var(--tgb-cor-borda);border-bottom:1px solid var(--tgb-cor-borda);background:var(--tgb-barra-fundo)}',
  '.tg-busca-barra-linha{display:flex;align-items:center;gap:6px;min-height:var(--tgb-barra-altura);font-size:var(--tgb-barra-fonte)}',
  '.tg-busca-barra-btn{display:inline-flex;align-items:center;gap:7px;height:40px;margin:0;padding:0 4px;border:0;background:none;color:inherit;font-size:var(--tgb-barra-fonte);font-weight:600;cursor:pointer}',
  '.tg-busca-barra-btn::after{content:"";width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg) translateY(-2px)}',
  '.tg-busca-barra-espaco{flex:1}',
  '.tg-busca-menu-wrap{position:relative}',
  '.tg-busca-menu{position:absolute;top:100%;left:0;z-index:6;min-width:210px;max-height:60vh;overflow-y:auto;margin:2px 0 0;padding:6px 0;list-style:none;border:1px solid var(--tgb-cor-borda);border-radius:6px;background:var(--tgb-cor-fundo);box-shadow:0 12px 32px rgba(0,0,0,.16)}',
  '.tg-busca-menu-dir .tg-busca-menu{left:auto;right:0}',
  '.tg-busca-menu button{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;margin:0;padding:11px 16px;border:0;background:none;color:inherit;font-size:14px;text-align:left;cursor:pointer}',
  '.tg-busca-menu button:hover{background:var(--tgb-cor-fundo-suave)}',
  '.tg-busca-menu button[aria-checked="true"]{font-weight:700}',
  '.tg-busca-menu button[aria-checked="true"]::after{content:"\\2713";font-size:13px}',
  '.tg-busca-vazio{margin:30px 0;text-align:center;color:var(--tgb-cor-texto-suave);font-size:14px}',
  '.tg-busca-vazio .tg-busca-chip{margin-top:8px}',
  '.tg-busca-togg{display:inline-flex;gap:2px;margin-left:2px}',
  '.tg-busca-togg button{display:flex;align-items:center;justify-content:center;gap:2px;width:40px;height:44px;margin:0;padding:0;border:0;border-radius:4px;background:none;color:var(--tgb-cor-texto);opacity:.55;cursor:pointer}',
  '.tg-busca-togg button[aria-pressed="true"]{opacity:1;background:var(--tgb-cor-fundo-suave)}',
  '.tg-busca-togg-q{display:block;width:6px;height:14px;border-radius:1px;background:currentColor}',
  '.tg-busca-togg-1 .tg-busca-togg-q{width:12px;background:none;border:1.5px solid currentColor;box-sizing:border-box}',
  '.tg-busca-chips-linha{flex-wrap:nowrap;overflow-x:auto;margin:0 0 18px;padding:2px 0 4px;-webkit-overflow-scrolling:touch;scrollbar-width:none}',
  '.tg-busca-chips-linha::-webkit-scrollbar{display:none}',
  // v14 (Danilo, 24/11): "VER MAIS" preto com letra branca, do tamanho do texto
  '.tg-busca-mais{display:flex;align-items:center;justify-content:center;width:-webkit-fit-content;width:fit-content;min-width:0;height:var(--tgb-botao-altura);margin:30px auto 0;padding:0 28px;border:1px solid #000;border-radius:var(--tgb-botao-raio);background:#000;color:#fff;font-size:var(--tgb-botao-fonte);font-weight:var(--tgb-botao-peso);letter-spacing:var(--tgb-botao-espaco);text-transform:var(--tgb-botao-transformacao);text-decoration:none;cursor:pointer}',
  '.tg-busca-mais.tg-busca-oculto{display:none}',
  'a.tg-busca-mais:hover,a.tg-busca-mais:focus{color:#fff;text-decoration:none}',
  // v14: peca esgotada vira so a frase; as parecidas vem logo abaixo
  '.tg-busca-esg-frase{margin:18px auto 22px;max-width:560px;padding:0 8px;text-align:center;font-size:14px;line-height:1.5;color:var(--tgb-cor-texto)}',
  '.tg-busca-esg-frase strong{font-weight:600}',
  '.tg-busca-ov-corpo .tg-busca-esg-frase{margin:14px 0 16px;text-align:left;padding:0}',
  '.tg-busca-esg .tg-busca-grade{margin-top:4px}',
  // pagina de busca curada (blocos) e estado sem resultado
  '.tg-busca-curada{max-width:1400px;margin:20px auto;padding:0 var(--tgb-pad-pagina)}',
  '.tg-busca-curada .tg-busca-bloco-titulo{margin:0 0 14px;padding:0 0 10px;border-bottom:2px solid var(--tgb-cor-texto);font-size:16px;letter-spacing:.06em;color:var(--tgb-cor-texto)}',
  '.tg-busca-curada .tg-busca-bloco{margin-bottom:30px}',
  '.tg-busca-zero{max-width:1100px;margin:28px auto;padding:0 var(--tgb-pad-pagina);text-align:center}',
  '.tg-busca-zero-titulo{margin:16px 0 4px}',  // v14: o titulo da busca sem resultado segue o titulo da pagina de resultados (tg-busca-voce)
  '.tg-busca-zero-desc{margin:22px 0 18px;font-size:14px;color:var(--tgb-cor-texto-suave)}',
  '.tg-busca-zero-desc a{color:var(--tgb-cor-texto);font-weight:700;text-decoration:underline}',
  '.tg-busca-zero-form{display:flex;gap:8px;max-width:520px;margin:0 auto 22px}',
  '.tg-busca-zero-campo{flex:1;min-width:0;height:46px;margin:0;padding:0 14px;border:1px solid var(--tgb-cor-borda);border-radius:var(--tgb-botao-raio);background:var(--tgb-cor-fundo);color:inherit;font-family:inherit;font-size:16px;-webkit-appearance:none;appearance:none}',
  '.tg-busca-zero-ok{height:46px;margin:0;padding:0 22px;border:1px solid var(--tgb-cor-destaque);border-radius:var(--tgb-botao-raio);background:var(--tgb-cor-destaque);color:var(--tgb-cor-destaque-texto);font-size:var(--tgb-botao-fonte);font-weight:var(--tgb-botao-peso);letter-spacing:var(--tgb-botao-espaco);text-transform:var(--tgb-botao-transformacao);cursor:pointer}',
  '.tg-busca-zero .tg-busca-chips{justify-content:center}',
  '.tg-busca-zero .tg-busca-secao-titulo{margin:26px 0 10px}',
  '.tg-busca-zero .tg-busca-bloco-titulo{justify-content:center;margin:26px 0 12px}',
  '@keyframes tg-busca-entra{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
  '@keyframes tg-busca-treme{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}',
  '@media (prefers-reduced-motion:reduce){#tg-busca-overlay.tg-busca-aberto,.tg-busca-card-pede .tg-busca-tams,.tg-busca-hc-esq .tg-busca-hc-foto,.tg-busca-hc-esq .tg-busca-hc-inf i{animation:none}}',
  // celular (95% do publico): campo com 16px (o iPhone nao da zoom), toque sem atraso, area segura, sem rolagem lateral
  '@media (max-width:1023px){' +
    '.tg-busca-ov-campo{font-size:16px}' +
    '#tg-busca-overlay a,#tg-busca-overlay button,#tg-busca-resultados a,#tg-busca-resultados button{touch-action:manipulation;-webkit-tap-highlight-color:transparent}' +
    '.tg-busca-ov-form{padding-top:env(safe-area-inset-top,0px);height:calc(var(--tgb-ov-campo-altura) + env(safe-area-inset-top,0px))}' +
    '.tg-busca-ov-corpo{overflow-x:hidden;padding:0 12px calc(28px + env(safe-area-inset-bottom,0px))}' +
    '.tg-busca-secao-titulo{margin:18px 0 8px}' +
    '.tg-busca-chip{min-height:36px;padding:0 14px;font-size:12px}' +
    '.tg-busca-chips{gap:6px}' +
    '.tg-busca-chips-linha{gap:8px;margin:16px 0 16px;padding:2px 0 6px}' +
    '.tg-busca-barra{margin:0 0 20px}' +
    '.tg-busca-termo{min-height:44px}' +
    '.tg-busca-todos{height:44px}' +
    '.tg-busca-barra-btn{height:44px;padding:0 6px;font-size:12px}' +
    '.tg-busca-mais{height:44px}' +
    '.tg-busca-tp .tg-busca-nome{font-size:12.5px}' +
  '}',
  '@media (min-width:1024px){' +
    '#tg-busca-overlay{background:var(--tgb-ov-fundo-escuro);align-items:center}' +
    '.tg-busca-ov-painel{width:min(var(--tgb-ov-max-largura),100%);height:auto;max-height:90vh;border-radius:var(--tgb-ov-raio)}' +
    '.tg-busca-ov-corpo{padding:0 28px 32px}' +
    '.tg-busca-lista{grid-template-columns:repeat(var(--tgb-ov-colunas-desktop),minmax(0,1fr))}' +
    '.tg-busca-grade{grid-template-columns:repeat(var(--tgb-colunas-desktop),minmax(0,1fr))}' +
    '.tg-busca-grade.tg-busca-grade-um{grid-template-columns:repeat(var(--tgb-colunas-desktop),minmax(0,1fr))}' +
    '.tg-busca-tapete{grid-template-columns:repeat(3,minmax(0,1fr));column-gap:28px}' +
    '.tg-busca-tp-foto{aspect-ratio:3 / 4}' +
    '.tg-busca-togg{display:none}' +
    '.tg-busca-chips-linha{flex-wrap:wrap;overflow:visible}' +
    '.tg-busca-todos{width:auto;min-width:300px;margin-left:auto;margin-right:auto}' +
  '}'
];

// ---------------------------------------------------------------- camada do DESKTOP (v13, Danilo 24/11)
// Busca larga (usa as laterais e a altura da tela, duas colunas), vitrine com 4 pecas por grupo, pagina de resultados com respiro, barra com
// grade 2/3/4, Filtrar e Ordenar em paineis de ~70% (largura e altura) que abrem ao passar o mouse. Vale de 768 px para cima (a frente do desktop).
var TG_CSS_DESK = [
  // busca (overlay): painel do topo da tela, largo e alto
  '#tg-busca-overlay{background:rgba(17,17,17,.55);align-items:center;justify-content:flex-start}',
  '.tg-busca-ov-painel{width:min(1360px,calc(100vw - 48px));height:calc(100vh - 40px);max-height:none;border-radius:0 0 16px 16px;box-shadow:0 24px 60px rgba(0,0,0,.18)}',
  '.tg-busca-ov-form{height:68px;padding:0 24px;gap:8px}',
  '.tg-busca-ov-campo{font-size:17px;padding:0 10px}',
  '.tg-busca-ov-corpo{padding:0 44px 48px}',
  '.tg-busca-ov-duas{display:grid;grid-template-columns:220px minmax(0,1fr);gap:0 56px;align-items:start}',
  '.tg-busca-ov-uma{grid-template-columns:minmax(0,1fr)}',
  '.tg-busca-ov-lado{position:sticky;top:0;padding-bottom:24px}',
  '.tg-busca-ov-lado .tg-busca-secao-titulo{margin:28px 0 12px}',
  '.tg-busca-ov-lado .tg-busca-chips{gap:8px}',
  '.tg-busca-ov-lado .tg-busca-chip{min-height:34px;padding:0 16px;font-size:12px}',
  '.tg-busca-ov-lado .tg-busca-termo{min-height:40px;font-size:14px}',
  '.tg-busca-ov-principal{min-width:0}',
  '.tg-busca-ov-principal>.tg-busca-secao-titulo:first-child,.tg-busca-ov-principal>.tg-busca-banner:first-child{margin-top:28px}',
  '.tg-busca-lista{grid-template-columns:repeat(4,minmax(0,1fr));gap:32px 24px}',
  '.tg-busca-todos{width:auto;min-width:300px;margin:36px auto 0}',
  // vitrine: 4 pecas por grupo numa linha; Conjuntos = 2 pares (cada par ocupa 2 colunas)
  '.tg-busca-tapete{display:block;margin:0}',
  '.tg-busca-tapete-secao{padding-top:28px}',
  '.tg-busca-tapete-secao+.tg-busca-tapete-secao{margin-top:clamp(40px,7vh,72px);border-top:1px solid var(--tgb-cor-borda);padding-top:clamp(28px,4vh,40px)}',
  '.tg-busca-vt-topo{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin:0 0 20px}',
  '.tg-busca-vt-topo .tg-busca-secao-titulo{margin:0;font-size:13px;letter-spacing:.16em;color:var(--tgb-cor-texto)}',
  '.tg-busca-vt-topo .tg-busca-tapete-todos{margin:0;font-size:12.5px;white-space:nowrap}',
  '.tg-busca-vt-grade{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:36px 24px;align-items:stretch}',
  '.tg-busca-vt-par{grid-column:span 2;display:flex;flex-direction:column;min-width:0}',
  '.tg-busca-vt-par-rotulo{display:flex;align-items:center;gap:12px;margin:0 0 12px;font-size:12px;color:var(--tgb-cor-texto-suave)}',
  '.tg-busca-vt-par-rotulo::after{content:"";flex:1;height:1px;background:var(--tgb-cor-borda)}',
  '.tg-busca-vt-par-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;flex:1}',
  '.tg-busca-vt-esq{display:flex;flex-direction:column}',
  '.tg-busca-vt-esq-foto{display:block;aspect-ratio:2 / 3;background:var(--tgb-cor-fundo-suave);animation:tg-busca-pulsa 1.2s ease-in-out infinite}',
  '.tg-busca-vt-esq i{display:block;width:80%;height:11px;margin:12px 0 0;background:var(--tgb-cor-fundo-suave);animation:tg-busca-pulsa 1.2s ease-in-out infinite}',
  '.tg-busca-vt-esq i:nth-child(3){width:45%}',
  '.tg-busca-vt-esq i:nth-child(4){width:100%;height:44px;margin-top:16px}',
  '.tg-busca-tapete-esq .tg-busca-tapete-secao+.tg-busca-tapete-secao{border-top:0}',
  '.tg-busca-tapete-esq .tg-busca-esq-titulo{margin:0 0 20px}',
  // card (busca, vitrine e resultados): mais ar no desktop
  '.tg-busca-card .tg-busca-nome{font-size:14px}',
  '.tg-busca-card .tg-busca-card-preco{font-size:14px}',
  '.tg-busca-card .tg-busca-add.tg-busca-ver{height:44px;transition:background .15s,color .15s}',
  '.tg-busca-card .tg-busca-add.tg-busca-ver:hover{background:var(--tgb-cor-texto);color:var(--tgb-cor-fundo)}',
  '.tg-busca-cor-nome{font-size:12px;color:var(--tgb-cor-texto-suave)}',
  '.tg-busca-card .tg-busca-cores{min-height:22px}',
  // pagina de resultados
  '#tg-busca-resultados{max-width:1440px;padding:0 40px 72px}',
  '.tg-busca-voce{margin:44px 0 6px;font-size:14px;letter-spacing:.18em}',
  '.tg-busca-voce::after{width:40px;margin-top:16px}',
  '.tg-busca-chips-linha{justify-content:center;flex-wrap:wrap;gap:10px;margin:24px 0 32px;padding:0;overflow:visible}',
  '.tg-busca-chips-linha .tg-busca-chip{min-height:38px;padding:0 22px;font-size:12.5px}',
  '.tg-busca-aviso-nome{max-width:720px;margin:16px auto 0;text-align:center}',
  '.tg-busca-togg{display:none}',
  '.tg-busca-barra{position:var(--tgb-barra-posicao);margin:0 0 36px;padding:0;border-top:1px solid var(--tgb-cor-borda);border-bottom:1px solid var(--tgb-cor-borda)}',
  '.tg-busca-barra-linha{gap:20px;min-height:64px;padding:10px 0}',
  '.tg-busca-barra .tg-busca-ativos{flex:1 1 auto;min-width:0;padding:0;border-top:0;gap:16px}',
  '.tg-busca-barra .tg-busca-ativos-lista{flex-wrap:wrap;overflow:visible;gap:8px}',
  '.tg-busca-barra .tg-busca-ativos.tg-busca-oculto+.tg-busca-barra-espaco{flex:1}',
  '.tg-busca-micro{height:30px;padding:0 10px 0 12px;font-size:12px}',
  '.tg-busca-limpar-busca{font-size:12.5px}',
  '.tg-busca-barra-espaco{flex:0 0 0}',
  // seletor de grade 2/3/4 (quadradinhos, como na Farm)
  '.tg-busca-dk-grades{display:flex;align-items:center;gap:6px;margin-right:8px}',
  '.tg-busca-dk-grade{display:flex;align-items:center;justify-content:center;width:40px;height:44px;margin:0;padding:0;border:0;background:none;color:var(--tgb-cor-texto);cursor:pointer;opacity:.28;transition:opacity .15s}',
  '.tg-busca-dk-grade:hover{opacity:.6}',
  '.tg-busca-dk-grade[aria-pressed="true"]{opacity:1;box-shadow:inset 0 -2px 0 currentColor}',
  '.tg-busca-dk-grade-ico{display:grid;width:20px;height:20px;gap:2px}',
  '.tg-busca-dk-grade-2 .tg-busca-dk-grade-ico{grid-template-columns:repeat(2,1fr)}',
  '.tg-busca-dk-grade-3 .tg-busca-dk-grade-ico{grid-template-columns:repeat(3,1fr)}',
  '.tg-busca-dk-grade-4 .tg-busca-dk-grade-ico{grid-template-columns:repeat(4,1fr);gap:1.5px}',
  '.tg-busca-dk-grade-ico i{display:block;background:currentColor}',
  // Filtrar e Ordenar: botoes de contorno com seta que gira ao abrir
  '.tg-busca-dk-wrap{position:static}',
  '.tg-busca-barra-btn.tg-busca-dk-btn{justify-content:space-between;gap:14px;width:176px;height:46px;padding:0 18px;border:1px solid var(--tgb-cor-borda);background:var(--tgb-cor-fundo);font-size:13px;font-weight:400;letter-spacing:.02em;transition:border-color .15s}',
  '.tg-busca-barra-btn.tg-busca-dk-btn::after{display:none}',
  '.tg-busca-dk-btn:hover,.tg-busca-dk-btn[aria-expanded="true"]{border-color:var(--tgb-cor-texto)}',
  '.tg-busca-dk-btn-rot{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
  '.tg-busca-dk-seta{flex:0 0 auto;width:7px;height:7px;margin-top:-4px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg);transition:transform .25s ease,margin .25s ease}',
  '.tg-busca-dk-btn:hover .tg-busca-dk-seta{margin-top:0}',
  '.tg-busca-dk-btn[aria-expanded="true"] .tg-busca-dk-seta{transform:rotate(-135deg);margin-top:4px}',
  // o painel: ~70% da largura e da altura, alinhado a direita sob a barra; o resto da vitrine continua a vista
  '.tg-busca-dk-painel{position:absolute;top:100%;right:0;z-index:7;width:70%;max-height:70vh;overflow-y:auto;margin:0;padding:32px 40px 22px;border:1px solid var(--tgb-cor-borda);border-top:0;background:var(--tgb-cor-fundo);box-shadow:0 22px 44px rgba(0,0,0,.12);animation:tg-busca-desce .2s ease-out}',
  '.tg-busca-dk-ordenar{width:min(70%,640px)}',
  '.tg-busca-dk-cols{display:grid;grid-template-columns:minmax(200px,1fr) minmax(0,auto) minmax(0,1.3fr);gap:0 56px;align-items:start}',
  '.tg-busca-dk-tit{margin:0 0 18px;font-size:14px;font-weight:500;color:var(--tgb-cor-texto)}',
  '.tg-busca-dk-tams{display:grid;grid-template-columns:repeat(3,52px);gap:12px}',
  '.tg-busca-dk-tam{display:flex;flex-direction:column;align-items:center;justify-content:center;width:52px;height:52px;margin:0;padding:0;border:1px solid var(--tgb-cor-borda);border-radius:50%;background:var(--tgb-cor-fundo);color:var(--tgb-cor-texto);line-height:1.05;cursor:pointer;transition:border-color .15s,background .15s,color .15s}',
  '.tg-busca-dk-tam span{font-size:13.5px}',
  '.tg-busca-dk-tam small{font-size:10px;color:var(--tgb-cor-texto-suave)}',
  '.tg-busca-dk-tam:hover{border-color:var(--tgb-cor-texto)}',
  '.tg-busca-dk-tam[aria-pressed="true"]{border-color:var(--tgb-cor-texto);background:var(--tgb-cor-texto);color:var(--tgb-cor-fundo)}',
  '.tg-busca-dk-tam[aria-pressed="true"] small{color:inherit;opacity:.75}',
  '.tg-busca-dk-cores{display:grid;grid-template-columns:repeat(2,minmax(0,150px));gap:10px 14px}',
  '.tg-busca-dk-cor{display:flex;align-items:center;gap:10px;height:36px;margin:0;padding:0 14px 0 6px;border:1px solid var(--tgb-cor-borda);border-radius:18px;background:var(--tgb-cor-fundo);color:var(--tgb-cor-texto);font-size:12.5px;text-align:left;cursor:pointer;transition:border-color .15s,background .15s,color .15s}',
  '.tg-busca-dk-cor span:last-child{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
  '.tg-busca-dk-cor .tg-busca-bolinha{width:24px;height:24px;cursor:inherit}',
  '.tg-busca-dk-cor .tg-busca-bolinha::after{display:none}',
  '.tg-busca-dk-cor:hover{border-color:var(--tgb-cor-texto)}',
  '.tg-busca-dk-cor[aria-pressed="true"]{border-color:var(--tgb-cor-texto);background:var(--tgb-cor-texto);color:var(--tgb-cor-fundo)}',
  '.tg-busca-dk-valores{display:flex;justify-content:space-between;margin:0 0 14px;font-size:12.5px;color:var(--tgb-cor-texto-suave)}',
  '.tg-busca-dk-trilho{position:relative;height:24px}',
  '.tg-busca-dk-trilho::before{content:"";position:absolute;left:0;right:0;top:11px;height:2px;background:var(--tgb-cor-borda)}',
  '.tg-busca-dk-faixa{position:absolute;top:11px;height:2px;background:var(--tgb-cor-texto)}',
  '.tg-busca-dk-range{position:absolute;left:0;top:0;width:100%;height:24px;margin:0;padding:0;background:none;pointer-events:none;-webkit-appearance:none;appearance:none}',
  '.tg-busca-dk-range::-webkit-slider-runnable-track{height:24px;background:none}',
  '.tg-busca-dk-range::-moz-range-track{height:24px;background:none}',
  '.tg-busca-dk-range::-webkit-slider-thumb{width:14px;height:14px;margin-top:5px;border:0;border-radius:50%;background:var(--tgb-cor-texto);pointer-events:auto;cursor:grab;-webkit-appearance:none;appearance:none}',
  '.tg-busca-dk-range::-moz-range-thumb{width:14px;height:14px;border:0;border-radius:50%;background:var(--tgb-cor-texto);pointer-events:auto;cursor:grab}',
  '.tg-busca-dk-range:focus-visible{outline:0}',
  '.tg-busca-dk-range:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 3px var(--tgb-cor-fundo),0 0 0 4px var(--tgb-cor-texto)}',
  '.tg-busca-dk-pe{display:flex;justify-content:flex-end;margin:26px 0 0}',
  '.tg-busca-dk-limpar{margin:0;padding:6px 0;border:0;background:none;color:var(--tgb-cor-texto);font-size:13px;text-decoration:underline;text-underline-offset:3px;cursor:pointer}',
  '.tg-busca-dk-limpar[aria-disabled="true"]{color:var(--tgb-cor-texto-suave);text-decoration:none;cursor:default}',
  // Ordenar: chips circulares com icone (desenhados em CSS; a saida segura nao aceita SVG nem url())
  '.tg-busca-dk-ords{display:flex;justify-content:center;gap:56px;padding:4px 0 10px}',
  '.tg-busca-dk-ord{display:flex;flex-direction:column;align-items:center;gap:12px;margin:0;padding:0;border:0;background:none;color:var(--tgb-cor-texto);font-size:13px;cursor:pointer}',
  '.tg-busca-dk-ico{display:flex;align-items:center;justify-content:center;width:56px;height:56px;border:1px solid var(--tgb-cor-borda);border-radius:50%;background:var(--tgb-cor-fundo);color:var(--tgb-cor-texto);transition:border-color .15s,background .15s,color .15s,transform .2s}',
  '.tg-busca-dk-ord:hover .tg-busca-dk-ico{border-color:var(--tgb-cor-texto);transform:translateY(-2px)}',
  '.tg-busca-dk-ord[aria-pressed="true"] .tg-busca-dk-ico{border-color:var(--tgb-cor-texto);background:var(--tgb-cor-texto);color:var(--tgb-cor-fundo)}',
  '.tg-busca-dk-ord[aria-pressed="true"] .tg-busca-dk-ord-rot{font-weight:600}',
  '.tg-busca-dk-ico i{position:relative;display:block}',
  '.tg-busca-dk-ico-best i{width:20px;height:20px;background:currentColor;clip-path:polygon(50% 0,61.8% 35.4%,100% 38.2%,69.1% 61.8%,80.9% 100%,50% 76.4%,19.1% 100%,30.9% 61.8%,0 38.2%,38.2% 35.4%)}',
  '.tg-busca-dk-ico-novo i{width:22px;height:22px;background:currentColor;clip-path:polygon(50% 0,58% 42%,100% 50%,58% 58%,50% 100%,42% 58%,0 50%,42% 42%)}',
  '.tg-busca-dk-ico-novo i::after{content:"";position:absolute;right:-1px;top:1px;width:6px;height:6px;background:currentColor;clip-path:polygon(50% 0,60% 40%,100% 50%,60% 60%,50% 100%,40% 60%,0 50%,40% 40%)}',
  '.tg-busca-dk-ico-oferta i{width:20px;height:13px;background:currentColor;clip-path:polygon(0 50%,28% 0,100% 0,100% 100%,28% 100%);transform:rotate(-45deg)}',
  '.tg-busca-dk-ico-oferta i::after{content:"";position:absolute;left:5px;top:4.5px;width:4px;height:4px;border-radius:50%;background:var(--tgb-cor-fundo)}',
  '.tg-busca-dk-ord[aria-pressed="true"] .tg-busca-dk-ico-oferta i::after{background:var(--tgb-cor-texto)}',
  // grade 2/3/4 da pagina de resultados
  '.tg-busca-grade.tg-busca-grade-c2{grid-template-columns:repeat(2,minmax(0,1fr));gap:56px 32px}',
  '.tg-busca-grade.tg-busca-grade-c3{grid-template-columns:repeat(3,minmax(0,1fr));gap:48px 28px}',
  '.tg-busca-grade.tg-busca-grade-c4{grid-template-columns:repeat(4,minmax(0,1fr));gap:44px 22px}',
  '.tg-busca-grade-c2 .tg-busca-nome,.tg-busca-grade-c2 .tg-busca-card-preco{font-size:15px}',
  '.tg-busca-grade-titulo{margin:28px 0 0;font-size:13px}',
  '.tg-busca-mais{margin-top:48px;height:46px;padding:0 36px}',
  // pagina de Conjuntos: um par por linha, as duas pecas lado a lado
  '.tg-busca-pagina-conj .tg-busca-hc-par{grid-template-columns:repeat(2,minmax(0,1fr));gap:48px;padding:36px 0}',
  '.tg-busca-pagina-conj .tg-busca-hc{grid-template-columns:40% minmax(0,1fr);gap:0 24px}',
  '.tg-busca-cj-sub{margin:0 0 24px;font-size:13px}',
  // sem resultado e busca curada
  '.tg-busca-zero{max-width:1360px;padding:0 40px}',
  '.tg-busca-zero .tg-busca-grade{grid-template-columns:repeat(4,minmax(0,1fr));gap:44px 22px;text-align:left}',
  '.tg-busca-curada{max-width:1440px;padding:0 40px}',
  // ---- QA (Danilo, 25/11)
  // 3.4: linha do Pix abaixo do preco, discreta, em todo card (lista da digitacao, vitrine, resultados, conjuntos)
  '.tg-busca-pix{display:block;flex-basis:100%;margin-top:2px;font-size:12px;font-weight:400;line-height:1.35;color:var(--tgb-cor-texto-suave);white-space:nowrap}',
  '.tg-busca-pix b{font-weight:600;color:var(--tgb-cor-texto)}',
  '.tg-busca-meta{align-items:flex-start}',
  '.tg-busca-meta .tg-busca-selo{margin-top:3px}',
  '.tg-busca-hc-preco .tg-busca-pix{margin-top:3px}',
  // 5.1: quantas pecas a busca (com os filtros) encontrou, logo abaixo do titulo do topo
  '.tg-busca-contador{margin:12px 0 0;text-align:center;font-size:13px;letter-spacing:.02em;color:var(--tgb-cor-texto-suave);font-variant-numeric:tabular-nums}',
  '.tg-busca-contador:empty{display:none}',
  // 5.3: tamanho sem peca na combinacao atual: apagado, riscado e sem clique
  '.tg-busca-dk-tam.tg-busca-dk-tam-sem{border-color:var(--tgb-cor-borda);background:var(--tgb-cor-fundo);color:var(--tgb-cor-texto-suave);opacity:.4;cursor:default;background-image:linear-gradient(135deg,transparent calc(50% - .5px),var(--tgb-cor-texto-suave) calc(50% - .5px),var(--tgb-cor-texto-suave) calc(50% + .5px),transparent calc(50% + .5px))}',
  '.tg-busca-dk-tam.tg-busca-dk-tam-sem:hover{border-color:var(--tgb-cor-borda)}',
  // 4.3: item destacado pelas setas do teclado (o foco continua no campo)
  '#tg-busca-overlay .tg-busca-tecla{outline:2px solid var(--tgb-cor-texto);outline-offset:4px}',
  '#tg-busca-overlay a.tg-busca-termo.tg-busca-tecla{outline-offset:0;background:var(--tgb-cor-fundo-suave)}',
  '#tg-busca-overlay .tg-busca-chip.tg-busca-tecla{outline-offset:2px;border-color:var(--tgb-cor-texto)}',
  // 1.4 e 4.2: os conjuntos (digitando conjunto) e as Novidades da semana (sem resultado) usam a vitrine do desktop
  '.tg-busca-ov-principal>.tg-busca-conj-digitado{padding-top:28px;margin-bottom:8px}',
  '.tg-busca-ov-principal>.tg-busca-zero-nov{padding-top:32px}',
  '@keyframes tg-busca-desce{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}',
  '@media (prefers-reduced-motion:reduce){.tg-busca-dk-painel,.tg-busca-vt-esq-foto,.tg-busca-vt-esq i{animation:none}.tg-busca-dk-seta,.tg-busca-dk-ico{transition:none}}',
  // tablet (768 a 1023): a mesma tela com menos colunas
  '@media (max-width:1023px){' +
    '.tg-busca-ov-duas{grid-template-columns:minmax(0,1fr)}' +
    '.tg-busca-ov-lado{position:static}' +
    '.tg-busca-vt-grade{grid-template-columns:repeat(2,minmax(0,1fr))}' +
    '.tg-busca-lista{grid-template-columns:repeat(3,minmax(0,1fr))}' +
    '#tg-busca-resultados{padding:0 24px 56px}' +
    '.tg-busca-dk-painel{width:100%}' +
    '.tg-busca-dk-cols{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:28px 40px}' +
    '.tg-busca-dk-col-preco{grid-column:1 / -1}' +
    '.tg-busca-grade.tg-busca-grade-c4{grid-template-columns:repeat(3,minmax(0,1fr))}' +
  '}'
];

// Regras de cor das bolinhas, geradas da tabela TG_COR_TONS.
function tgCssCores() {
  var out = [], i, j, nomes;
  for (i = 0; i < TG_COR_TONS.length; i++) {
    nomes = TG_COR_TONS[i][0];
    for (j = 0; j < nomes.length; j++) { out.push('.tg-busca-bolinha[data-cor="' + nomes[j] + '"]{background:' + TG_COR_TONS[i][1] + '}'); }
  }
  return out;
}

function tgCssVars() {
  var out = ':root{', i;
  for (i = 0; i < TG_TOKENS.length; i++) { out += TG_TOKENS[i][0] + ':' + TG_TOKENS[i][1] + ';'; }
  return out + '}';
}

var TG_CSS = [tgCssVars()].concat(TG_CSS_BASE, TG_CSS_OVERLAY, TG_CSS_CARD, tgCssCores(), TG_CSS_PAGINA, TG_CSS_DESK).join('\n');

function injetarEstilos() {
  if (document.getElementById('tg-busca-estilos')) { return; }
  var st = el('style', { id: 'tg-busca-estilos' }, [TG_CSS]);
  document.head.appendChild(st);
}


/* ---- src/injetor/desktop/quickview.js ---- */
/*
 * Quick view (pacote Q do redesign). Bottom sheet no celular, modal centralizado no desktop, aberto a partir do card da busca.
 * Design e comportamento portados da pagina Influenciadoras (influencer-piece-detail / influencer-story-sheet / store-cart),
 * reescritos em JS simples (ES5, sem TypeScript). Na Talgui cada cor e um produto proprio: o quick view mostra UMA cor
 * (um produto) e troca de produto quando a cliente escolhe outra cor dos irmaos.
 *
 * Dados: a pagina do produto (mesma origem, so GET) traz data-variants (id, option0 = cor, option1 = tamanho, available, preco)
 * e a galeria. Tudo que vem dela passa por validacao (id so numerico, foto so do prefixo da loja, texto limitado) e
 * so chega ao DOM por textContent / setAttribute (helpers de seguro.js). Qualquer falha cai para o link da pagina do produto.
 *
 * Expoe (funcoes globais da IIFE): tgQuickViewAbrir, tgQuickViewPrefetch, tgVariantesDoProduto, tgAdicionarSacola.
 * Estilos: injetados uma vez, todos sob .tg-busca-qv- e variaveis --tgb-* (padroes definidos aqui com var(--tgb-x, padrao)).
 * Os marcadores node:inicio / node:fim delimitam a exportacao para o Node; o build remove esse bloco.
 * v15 (Danilo, 25/11): Voltar entre cores, gavetas animadas, entrada/saida animadas, troca de cor
 * como pagina virando (com volta ao topo), foto ampliada (classe tg-busca-qv-lupa) e confirmacao da sacola dentro do modal.
 */
var TG_QV_Z = 2147483500;
var TG_QV_TIMEOUT_MS = 6000;
var TG_QV_MAX_HTML = 8 * 1024 * 1024;
var TG_QV_MAX_FOTOS = 10;
var TG_QV_MAX_TEXTO = 24;
var TG_QV_MAX_CACHE = 80;
var tgQvCache = {};        // handle -> Promise (resultado de tgVariantesDoProduto)
var tgQvProdutoDaVariante = {}; // id da variante (texto numerico) -> id do produto
var tgQvAtivo = null;      // quick view aberto (so um por vez)
var TG_QV_TOKENS = {};     // nome da variavel -> padrao (a bancada le esta lista)

// ---------------------------------------------------------------- validacao e leitura da pagina
function tgQvIdOk(v) {
  if (typeof v === 'number') { return isFinite(v) && v > 0 && Math.floor(v) === v && v < 1e15 ? String(v) : null; }
  if (typeof v === 'string' && /^[0-9]{1,15}$/.test(v) && v.replace(/^0+/, '') !== '') { return v.replace(/^0+/, ''); }
  return null;
}

function tgQvQtdOk(v) {
  var n = typeof v === 'number' ? v : parseInt(v, 10);
  return isFinite(n) && n >= 1 && n <= 10 && Math.floor(n) === n ? n : null;
}

// Texto curto vindo da pagina (cor, tamanho): sem controle, sem espacos nas pontas, ate 24 caracteres. Vazio vira null.
function tgQvTexto(v) {
  var t;
  if (typeof v !== 'string') { return null; }
  t = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').replace(/^ | $/g, '');
  return t && t.length <= TG_QV_MAX_TEXTO ? t : null;
}

function tgQvDecode(s) {
  return s.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function tgQvNumPositivo(v) { return typeof v === 'number' && isFinite(v) && v > 0 ? v : null; }

// Foto aceita: so o prefixo fixo das imagens da loja e nome de arquivo simples. Aceita o formato "//acdn..." da pagina.
function tgQvFotoOk(u) {
  if (typeof u !== 'string') { return null; }
  if (u.indexOf('//') === 0) { u = 'https:' + u; }
  return u.indexOf(TG_IMG) === 0 && /^[\w.-]{1,300}$/.test(u.slice(TG_IMG.length)) ? u : null;
}

// A pagina lista as variantes na ordem do cadastro (P, M, G, PP, GG...). Aqui a ordem natural: XPP, PP, P, M, G, GG, XG...; numeros crescentes; o resto no fim.
var TG_QV_ORDEM = { XXS: 0, XPP: 0, XS: 0, PP: 1, P: 2, S: 2, M: 3, G: 4, L: 4, GG: 5, XL: 5, XG: 6, XGG: 7, XXG: 7, EG: 6, EGG: 7, U: 8, UN: 8, UNICO: 8, 'ÚNICO': 8 };
function tgQvOrdenarTamanhos(lista) {
  var chaves = lista.map(function (t, i) {
    var r = String(t.rotulo).toUpperCase(), k;
    if (/^[0-9]{1,3}$/.test(r)) { k = 100 + parseInt(r, 10); } else if (Object.prototype.hasOwnProperty.call(TG_QV_ORDEM, r)) { k = TG_QV_ORDEM[r]; } else { k = 1000 + i; }
    return { t: t, k: k, i: i };
  });
  chaves.sort(function (a, b) { return a.k - b.k || a.i - b.i; });
  return chaves.map(function (c) { return c.t; });
}

// Le o HTML da pagina do produto. item.id (id do produto no catalogo) escolhe o data-variants certo: a pagina traz outros
// (produtos relacionados). Devolve { ok:true, ... } ou { ok:false, motivo }.
function tgQvParse(html, item) {
  var re = /data-variants="([^"]*)"/g, m, lista, escolhida = null, vs = [], i, v, id, opt0, opt1, rotulo, cor = null, usaOpt0 = false;
  var sem1 = true, precoV = null, de = null, fotos = [], vistos = {}, tamanhos = [], porRotulo = {}, rg, u, produtoId = null, sz = null, k;
  if (typeof html !== 'string' || html.length > TG_QV_MAX_HTML) { return { ok: false, motivo: 'html' }; }
  while ((m = re.exec(html)) !== null) {
    try { lista = JSON.parse(tgQvDecode(m[1])); } catch (e) { continue; }
    if (!Array.isArray(lista) || !lista.length || !lista[0] || typeof lista[0] !== 'object') { continue; }
    if (item && typeof item.id === 'number') {
      if (lista[0].product_id === item.id) { escolhida = lista; break; }
    } else { escolhida = lista; break; }
  }
  if (!escolhida) { return { ok: false, motivo: 'sem-variantes' }; }
  for (i = 0; i < escolhida.length; i++) {
    v = escolhida[i];
    if (!v || typeof v !== 'object') { continue; }
    id = tgQvIdOk(v.id);
    if (!id) { continue; }
    vs.push({ id: id, o0: tgQvTexto(v.option0), o1: tgQvTexto(v.option1), ok: v.available === true, p: tgQvNumPositivo(v.price_number), c: tgQvNumPositivo(v.compare_at_price_number), parc: tgQvParcelas(v.installments_data), pix: tgQvPix(v) });
    if (vs[vs.length - 1].o1) { sem1 = false; }
    if (produtoId === null && tgQvIdOk(v.product_id)) { produtoId = tgQvIdOk(v.product_id); }
  }
  if (!vs.length || !produtoId) { return { ok: false, motivo: 'sem-variantes' }; }
  // Produto sem a segunda opcao: a unica opcao e o tamanho, se os valores batem com os tamanhos do catalogo.
  if (sem1 && item && Array.isArray(item.sz) && item.sz.length) {
    sz = {};
    for (k = 0; k < item.sz.length; k++) { if (typeof item.sz[k] === 'string') { sz[item.sz[k].toUpperCase()] = true; } }
    usaOpt0 = true;
    for (i = 0; i < vs.length; i++) { if (!vs[i].o0 || !sz[vs[i].o0.toUpperCase()]) { usaOpt0 = false; break; } }
  }
  for (i = 0; i < vs.length; i++) {
    v = vs[i];
    rotulo = usaOpt0 ? v.o0 : v.o1;
    if (!usaOpt0 && !cor && v.o0) { cor = v.o0; }
    if (!rotulo) { continue; }
    if (Object.prototype.hasOwnProperty.call(porRotulo, rotulo)) {
      // mesmo tamanho repetido: vale o que esta disponivel
      if (v.ok && !tamanhos[porRotulo[rotulo]].disponivel) { tamanhos[porRotulo[rotulo]].variantId = v.id; tamanhos[porRotulo[rotulo]].disponivel = true; }
      continue;
    }
    porRotulo[rotulo] = tamanhos.length;
    tamanhos.push({ rotulo: rotulo, variantId: v.id, disponivel: v.ok });
    tgQvProdutoDaVariante[v.id] = produtoId;
  }
  tamanhos = tgQvOrdenarTamanhos(tamanhos);
  // Preco: da primeira variante disponivel (senao da primeira com preco). "De" so se for maior que o preco.
  for (i = 0; i < vs.length; i++) { if (vs[i].p && vs[i].ok) { precoV = vs[i]; break; } }
  if (!precoV) { for (i = 0; i < vs.length; i++) { if (vs[i].p) { precoV = vs[i]; break; } } }
  if (precoV && precoV.c && precoV.c > precoV.p) { de = precoV.c; }
  rg = /href="([^"]+)"\s+data-fancybox="product-gallery"/g;
  while ((m = rg.exec(html)) !== null && fotos.length < TG_QV_MAX_FOTOS) {
    u = tgQvFotoOk(tgQvDecode(m[1]));
    if (u && !vistos[u]) { vistos[u] = true; fotos.push(u); }
  }
  if (!fotos.length && item) { u = urlImagem(item.i); if (u) { fotos.push(u); } }
  return {
    ok: true, productId: produtoId, cor: cor, preco: precoV ? precoV.p : null, precoDe: de, fotos: fotos, tamanhos: tamanhos, url: item ? urlProduto(item.s) : null,
    parcelas: precoV && precoV.parc && Math.abs(precoV.parc.n * precoV.parc.v - precoV.p) < 1 ? precoV.parc : null,
    pix: precoV && precoV.pix && precoV.pix < precoV.p ? precoV.pix : null,
    descricao: tgQvDescricao(html)
  };
}

// Parcelamento sem juros da variante (installments_data da pagina do produto: JSON em texto, por meio de pagamento).
// Devolve a maior quantidade sem juros, entre 2 e 12, com o valor da parcela: { n, v }. Qualquer formato estranho = null.
function tgQvParcelas(bruto) {
  var obj, g, n, x, melhor = null;
  try {
    obj = typeof bruto === 'string' && bruto.length < 20000 ? JSON.parse(bruto) : null;
    if (!obj || typeof obj !== 'object') { return null; }
    for (g in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, g) || !obj[g] || typeof obj[g] !== 'object') { continue; }
      for (n in obj[g]) {
        if (!Object.prototype.hasOwnProperty.call(obj[g], n) || !/^[0-9]{1,2}$/.test(n)) { continue; }
        x = obj[g][n];
        if (!x || x.without_interests !== true || !tgQvNumPositivo(x.installment_value)) { continue; }
        if (+n >= 2 && +n <= 12 && (!melhor || +n > melhor.n)) { melhor = { n: +n, v: x.installment_value }; }
      }
    }
  } catch (e) { return null; }
  return melhor;
}

// Preco no Pix da variante: so quando a loja mostra o desconto do Pix (popup_discount_visibility) e o texto e um valor em reais.
function tgQvPix(v) {
  var vis, m, n;
  try {
    vis = v.popup_discount_visibility;
    if (!vis || typeof vis !== 'object') { return null; }
    for (m in vis) {
      if (Object.prototype.hasOwnProperty.call(vis, m) && vis[m] && vis[m].methods && vis[m].methods.pix && vis[m].methods.pix.show_discount === true) {
        m = /^R\$\s?([0-9]{1,3}(?:\.[0-9]{3})*),([0-9]{2})$/.exec(String(v.price_with_payment_discount_short || '').trim());
        if (!m) { return null; }
        n = parseFloat(m[1].replace(/\./g, '') + '.' + m[2]);
        return n > 0 && isFinite(n) ? n : null;
      }
    }
  } catch (e) {}
  return null;
}

// Descricao da pagina do produto (bloco .user-content), so como TEXTO estruturado, no padrao das descricoes da Talgui
// (o mesmo que a pagina Influenciadoras le): introducao, "Destaques da Peca" e "Detalhes Tecnicos" / "Ficha Tecnica".
// Nunca devolve HTML; o DOM recebe tudo por textContent. Sem descricao reconhecivel = null.
var TG_QV_ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', ordm: 'º', ordf: 'ª', deg: '°', middot: '·', bull: '•', times: '×', ccedil: 'ç', Ccedil: 'Ç',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', atilde: 'ã', otilde: 'õ', Atilde: 'Ã', Otilde: 'Õ', acirc: 'â', ecirc: 'ê', ocirc: 'ô', Acirc: 'Â', Ecirc: 'Ê', Ocirc: 'Ô', agrave: 'à', Agrave: 'À', uuml: 'ü' };
function tgQvTextoHtml(f) {
  var t = String(f).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, function (todo, c) {
    var n;
    if (c.charAt(0) === '#') {
      n = c.charAt(1) === 'x' || c.charAt(1) === 'X' ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10);
      return isFinite(n) && n > 31 && n < 0xFFFF ? String.fromCharCode(n) : '';
    }
    return Object.prototype.hasOwnProperty.call(TG_QV_ENT, c) ? TG_QV_ENT[c] : todo;
  });
  return t.replace(/\s+/g, ' ').trim();
}
function tgQvCorte(t, max) { return t.length > max ? t.slice(0, max - 1).replace(/\s+$/, '') + '…' : t; }
function tgQvItens(corpo) {
  var out = [], re = /<li\b[^>]*>([\s\S]*?)<\/li>/gi, m, t, k;
  while ((m = re.exec(corpo)) !== null && out.length < 8) {
    t = tgQvTextoHtml(m[1]);
    if (!t) { continue; }
    k = t.indexOf(':');
    if (k > 0 && k <= 60 && t.slice(k + 1).trim()) { out.push({ rotulo: t.slice(0, k).trim(), texto: tgQvCorte(t.slice(k + 1).trim(), 400) }); }
    else { out.push({ rotulo: null, texto: tgQvCorte(t, 400) }); }
  }
  return out;
}
function tgQvDescricao(html) {
  var i, bloco, partes, cabeca, secoes = [], k, intro = [], re, m, t, dest, ficha, alt;
  try {
    if (typeof html !== 'string') { return null; }
    i = html.indexOf('class="user-content"');
    if (i < 0) { return null; }
    bloco = html.slice(i, i + 60000);
    // o bloco termina na primeira tabela (institucional) ou no fim do formulario/coluna da descricao
    k = bloco.search(/<table\b|<form\b|data-store="product-|<script\b/i);
    if (k > 0) { bloco = bloco.slice(0, k); }
    bloco = bloco.replace(/^[^>]*>/, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<h1\b[\s\S]*?<\/h1>/gi, ' ');
    partes = bloco.split(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/i);
    cabeca = partes[0] || '';
    for (k = 1; k < partes.length; k += 2) { secoes.push({ titulo: tgQvTextoHtml(partes[k] || ''), corpo: partes[k + 1] || '' }); }
    re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
    while ((m = re.exec(cabeca)) !== null && intro.length < 3) { t = tgQvTextoHtml(m[1]); if (t) { intro.push(tgQvCorte(t, 600)); } }
    for (k = 0; k < secoes.length; k++) {
      if (!dest && /destaque|diferencia/i.test(secoes[k].titulo)) { dest = secoes[k]; }
      if (!ficha && /t[eé]cnic|ficha/i.test(secoes[k].titulo)) { ficha = secoes[k]; }
    }
    if (!dest) { for (k = 0; k < secoes.length; k++) { if (secoes[k] !== ficha && /<li\b/i.test(secoes[k].corpo)) { alt = secoes[k]; break; } } dest = alt || null; }
    dest = dest ? tgQvItens(dest.corpo) : [];
    ficha = ficha ? tgQvItens(ficha.corpo) : [];
    if (!intro.length && !dest.length && !ficha.length) { return null; }
    return { intro: intro, destaques: dest, ficha: ficha };
  } catch (e) { return null; }
}

function tgQvBuscar(url, item) {
  return new Promise(function (resolve) {
    var ctl = null, timer = 0, fim = false;
    function sair(r) { if (fim) { return; } fim = true; clearTimeout(timer); resolve(r); }
    try {
      if (typeof fetch !== 'function') { sair({ ok: false, motivo: 'sem-fetch' }); return; }
      if (typeof AbortController === 'function') { ctl = new AbortController(); }
      timer = setTimeout(function () { try { if (ctl) { ctl.abort(); } } catch (e) {} sair({ ok: false, motivo: 'timeout' }); }, TG_QV_TIMEOUT_MS);
      fetch(url, { credentials: 'same-origin', headers: { 'Accept': 'text/html' }, signal: ctl ? ctl.signal : undefined }).then(function (r) {
        if (!r || !r.ok) { sair({ ok: false, motivo: 'http' }); return null; }
        return r.text();
      }).then(function (html) {
        if (html === null || html === undefined) { return; }
        var d = tgQvParse(html, item);
        if (d.ok) { d.url = url; }
        sair(d);
      }).then(null, function () { sair({ ok: false, motivo: 'rede' }); });
    } catch (e) { sair({ ok: false, motivo: 'erro' }); }
  });
}

// Promise sempre resolvida: { ok, cor, preco, precoDe, fotos[], tamanhos:[{rotulo, variantId, disponivel}], url, productId } ou { ok:false, motivo }.
// Cache por handle na pagina; falha nao fica no cache (a proxima abertura tenta de novo).
function tgVariantesDoProduto(item) {
  var url = item && typeof item === 'object' ? urlProduto(item.s) : null, p, n = 0, k;
  if (!url) { return Promise.resolve({ ok: false, motivo: 'item' }); }
  if (Object.prototype.hasOwnProperty.call(tgQvCache, item.s)) { return tgQvCache[item.s]; }
  for (k in tgQvCache) { if (Object.prototype.hasOwnProperty.call(tgQvCache, k)) { n++; } }
  if (n >= TG_QV_MAX_CACHE) { tgQvCache = {}; }
  p = tgQvBuscar(url, item).then(function (r) {
    if (!r.ok) { delete tgQvCache[item.s]; }
    return r;
  });
  tgQvCache[item.s] = p;
  return p;
}

function tgQuickViewPrefetch(item) {
  try { tgVariantesDoProduto(item).then(null, function () {}); } catch (e) {}
}

// ---------------------------------------------------------------- sacola (porta de store-cart.ts)
// Abre a sacola do tema pelo MESMO toque no icone visivel (o Morelia grava a entrada de historico que o back() dele espera).
// v15 (Danilo, 25/11): peca adicionada pelo modal NAO abre a sacola sozinha; a sacola so abre no "Ver sacola". Se a plataforma (LS.addToCartEnhanced
// com carrinho ajax) abrir o #modal-cart por conta propria logo depois de adicionar, ele e fechado na hora (por 4 s; depois disso, ou se a cliente
// pediu a sacola, nada e mexido).
var tgQvSacolaPedida = 0;
function tgQvSegurarSacola() {
  var modal, fim, obs = null, t = 0, conferir, parar;
  try {
    modal = document.querySelector('#modal-cart');
    if (!modal) { return; }
    fim = Date.now() + 4000;
    parar = function () { try { if (obs) { obs.disconnect(); } } catch (e) {} clearInterval(t); };
    conferir = function () {
      var x;
      try {
        if (Date.now() > fim || tgQvSacolaPedida > fim - 4000 || !modal.classList) { parar(); return; }
        if (modal.classList.contains('modal-show')) {
          x = modal.querySelector ? modal.querySelector('.js-modal-close') : null;
          if (x && x.click) { x.click(); } else { modal.classList.remove('modal-show'); }
        }
      } catch (e) { parar(); }
    };
    if (typeof MutationObserver === 'function') { obs = new MutationObserver(conferir); obs.observe(modal, { attributes: true, attributeFilter: ['class'] }); }
    t = setInterval(conferir, 150);
    setTimeout(parar, 4100);
    conferir();
  } catch (e) {}
}
function tgAbrirSacolaDoTema() {
  try {
    var modal = document.querySelector('#modal-cart'), gatilhos, i, g, vis = null;
    if (!modal || (modal.classList && modal.classList.contains('modal-show'))) { return; }
    gatilhos = document.querySelectorAll('.js-modal-open[data-toggle="#modal-cart"], .js-modal-open-private[data-target="#modal-cart"]');
    for (i = 0; i < gatilhos.length; i++) {
      g = gatilhos[i];
      if (g.offsetParent !== null || (g.getClientRects && g.getClientRects().length)) { vis = g; break; }
    }
    if (vis) { vis.click(); return; }
    if (typeof window.modalOpen === 'function') { window.modalOpen('#modal-cart', 'openFullScreenWithoutClick'); return; }
    if (gatilhos[0]) { gatilhos[0].click(); }
  } catch (e) {}
}

function tgQvCampo(nome, valor) {
  var i = document.createElement('input');
  i.setAttribute('type', 'hidden');
  i.setAttribute('name', nome);
  i.setAttribute('value', valor);
  return i;
}

// Poe a peca na sacola pela funcao da propria loja (LS.addToCartEnhanced). Resolve { ok:true } ou { ok:false, motivo }.
// So variante numerica e quantidade de 1 a 10. opcoes: { productId (senao o lembrado da leitura da pagina), abrirSacola (padrao true),
// antesDeAbrir (funcao: o chamador fecha o proprio overlay aqui) }. Em caso de sucesso fecha o quick view aberto e SO ENTAO abre #modal-cart.
// v15: manterQuickView (o proprio quick view confirma a sacola e oferece "Ver sacola"; nao fecha). O contador da sacola do tema e
// atualizado pela propria LS.addToCartEnhanced.
function tgAdicionarSacola(variantId, qtd, opcoes) {
  return new Promise(function (resolve) {
    var vid = tgQvIdOk(variantId), n = tgQvQtdOk(qtd === undefined ? 1 : qtd), pid = null, w, ls, acao = '/comprar/', ex, form, fim = false, timer = 0;
    function sair(r) {
      if (fim) { return; }
      fim = true;
      clearTimeout(timer);
      if (r.ok) {
        if (!opcoes || !opcoes.manterQuickView) { try { tgQvFechar('sacola'); } catch (e) {} }
        try { if (opcoes && typeof opcoes.antesDeAbrir === 'function') { opcoes.antesDeAbrir(); } } catch (e) {}
        if (!opcoes || opcoes.abrirSacola !== false) { setTimeout(tgAbrirSacolaDoTema, 80); } else { tgQvSegurarSacola(); }
      }
      resolve(r);
    }
    try {
      if (!vid || !n) { sair({ ok: false, motivo: 'dados' }); return; }
      pid = tgQvIdOk(opcoes && opcoes.productId) || tgQvProdutoDaVariante[vid] || null;
      if (!pid) { sair({ ok: false, motivo: 'produto' }); return; }
      w = typeof window !== 'undefined' ? window : null;
      ls = w && w.LS;
      if (!ls || typeof ls.addToCartEnhanced !== 'function') { sair({ ok: false, motivo: 'sem-ls' }); return; }
      if (typeof document.querySelector === 'function') {
        ex = document.querySelector('form[action*="buy"], form[action*="comprar"]');
        if (ex && /^\/(?![\/\\])[^\s\u0000-\u001f]*$/.test(ex.getAttribute('action') || '')) { acao = ex.getAttribute('action'); }
      }
      form = document.createElement('form');
      form.setAttribute('action', acao);
      form.setAttribute('method', 'post');
      form.appendChild(tgQvCampo('add_to_cart', pid));
      form.appendChild(tgQvCampo('variant_id', vid)); // sem isto a plataforma escolhe outra variante sozinha
      form.appendChild(tgQvCampo('quantity', String(n)));
      timer = setTimeout(function () { sair({ ok: false, motivo: 'timeout' }); }, 10000);
      var alvo = typeof w.jQuery === 'function' ? w.jQuery(form) : form, ret;
      ret = ls.addToCartEnhanced(alvo, '', '', '', true, function () { sair({ ok: true }); }, function () { sair({ ok: false, motivo: 'recusado' }); });
      if (ret && typeof ret.then === 'function') { ret.then(null, function () { sair({ ok: false, motivo: 'recusado' }); }); }
    } catch (e) { sair({ ok: false, motivo: 'erro' }); }
  });
}

// ---------------------------------------------------------------- estilos
function tgQvVar(nome, padrao) { TG_QV_TOKENS['--tgb-' + nome] = padrao; return 'var(--tgb-' + nome + ',' + padrao + ')'; }

function tgQvMontarCss() {
  var V = tgQvVar, P = '.tg-busca-qv-', R = '.tg-busca-qv-raiz ';
  var fonte = V('fonte', 'inherit'), texto = V('cor-texto', '#202020'), fundo = V('cor-fundo', '#fff'), dest = V('cor-destaque', '#000');
  var suave = V('qv-cor-suave', '#6d6d6d'), linha = V('qv-cor-linha', '#e3e3e3'), borda = V('qv-cor-borda', '#bdbdbd'), erro = V('qv-cor-erro', '#991b1b');
  var pad = V('qv-pad', '16px'), btnAlt = V('qv-botao-altura', '48px'), btnRaio = V('botao-raio', '0px');
  var tam = V('qv-tamanho-btn', '38px'), chip = V('qv-chip-tam', '34px');
  return [
    P + 'raiz{position:fixed;top:0;right:0;bottom:0;left:0;z-index:' + TG_QV_Z + ';display:flex;align-items:flex-end;justify-content:center;font-family:' + fonte + ';color:' + texto + ';font-size:14px;line-height:1.4;-webkit-text-size-adjust:100%;text-align:left}',
    R + '*{box-sizing:border-box}',
    P + 'fundo{position:absolute;top:0;right:0;bottom:0;left:0;background:' + V('qv-scrim', 'rgba(0,0,0,.4)') + ';animation:tg-busca-qv-fade .2s ease}',
    P + 'painel{position:relative;display:flex;flex-direction:column;width:100%;max-height:' + V('qv-altura-max', '94vh') + ';background:' + fundo + ';border-radius:' + V('qv-raio', '14px') + ' ' + V('qv-raio', '14px') + ' 0 0;overflow:hidden;animation:tg-busca-qv-sobe .28s ease}',
    P + 'painel[data-arrastando="true"],' + P + 'painel.tg-busca-qv-assentado{animation:none}',
    P + 'painel:focus{outline:0}',
    P + 'cab{flex:none;display:grid;grid-template-columns:1fr auto;align-items:center;gap:0 8px;padding:10px ' + pad + ' 8px;border-bottom:1px solid ' + linha + '}',
    P + 'alca{grid-column:1/-1;display:flex;align-items:center;justify-content:center;height:16px;margin:-6px calc(-1*' + pad + ') 0;touch-action:none}',
    P + 'alca span{display:block;width:40px;height:4px;border-radius:4px;background:#d4d4d4}',
    // cabecalho como na pagina Influenciadoras: rotulo pequeno (caixa alta, cinza) e o nome da peca vai para o corpo, junto do preco
    R + 'p' + P + 'cab-rotulo{margin:0;padding:0;min-width:0;font-size:10px;font-weight:400;line-height:1.3;letter-spacing:.08em;text-transform:uppercase;color:' + suave + '}',
    R + 'h2' + P + 'titulo{display:flex;align-items:flex-start;gap:8px;margin:16px 0 0;padding:0;min-width:0;font-family:inherit;font-size:17px;font-weight:500;line-height:1.3;letter-spacing:normal;text-transform:none;color:' + texto + '}',
    P + 'bolinha{flex:none;display:block;width:14px;height:14px;margin-top:4px;border-radius:50%;box-shadow:inset 0 0 0 1px rgba(0,0,0,.2)}',
    P + 'parc{margin:2px 0 0;font-size:12px;line-height:1.4;color:' + suave + '}',
    P + 'parc b{font-weight:600;color:' + texto + '}',
    P + 'dest{display:grid;gap:8px;margin:14px 0 0;padding:0;list-style:none}',
    P + 'dest li{margin:0;padding:0;font-size:13px;line-height:1.5;color:#3a3a3a}',
    P + 'dest b{font-weight:500;color:' + texto + '}',
    P + 'acc{margin:0;border-top:1px solid ' + linha + '}',
    P + 'acc:last-of-type{border-bottom:1px solid ' + linha + '}',
    P + 'accs{margin-top:18px}',
    R + 'button' + P + 'acc-bt{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:48px;margin:0;padding:0;border:0;background:none;color:' + texto + ';font-family:inherit;font-size:10px;font-weight:400;line-height:1.3;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;-webkit-appearance:none;appearance:none}',
    R + 'button' + P + 'acc-bt::after{content:"+";font-size:18px;letter-spacing:0;color:' + texto + '}',
    R + 'button' + P + 'acc-bt[aria-expanded="true"]::after{content:"\\2212"}',
    P + 'acc-corpo{padding:0 0 12px}',
    P + 'acc-corpo[hidden]{display:none}',
    // v15: Descricao e Detalhes abrem como gaveta (a altura anima de 0 ao conteudo); fechada, o conteudo fica invisivel para o leitor e o Tab
    P + 'acc-gaveta{display:grid;grid-template-rows:0fr;visibility:hidden;transition:grid-template-rows .3s ease,visibility 0s linear .3s}',
    P + 'acc-gaveta' + P + 'acc-aberta{grid-template-rows:1fr;visibility:visible;transition:grid-template-rows .3s ease,visibility 0s}',
    P + 'acc-dentro{min-height:0;overflow:hidden}',
    P + 'texto{margin:0 0 10px;font-size:13.5px;line-height:1.65;color:#3a3a3a}',
    P + 'ficha{display:grid;grid-template-columns:minmax(0,40%) minmax(0,1fr);gap:8px;margin:0;padding:8px 0;border-top:1px solid #f2f2f2;font-size:12.5px;line-height:1.5;color:#3a3a3a}',
    P + 'ficha:first-child{border-top:0}',
    P + 'ficha dt{margin:0;font-weight:600;color:' + texto + '}',
    P + 'ficha dd{margin:0}',
    P + 'pe-peca{display:flex;align-items:center;gap:10px;min-width:0;margin:0 0 8px}',
    R + P + 'pe-peca img{flex:none;display:block;width:40px;height:50px;max-width:none;object-fit:cover;background:#f2f2f2}',
    P + 'pe-inf{display:grid;gap:1px;min-width:0}',
    P + 'pe-nome{margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:1.35;color:' + texto + '}',
    P + 'pe-preco{display:flex;align-items:baseline;gap:8px;margin:0;font-size:14px;font-weight:600;line-height:1.3}',
    P + 'pe-preco span{font-size:11.5px;font-weight:400;color:' + suave + '}',
    R + 'button' + P + 'fechar{display:flex;align-items:center;justify-content:center;width:44px;height:44px;margin:0;padding:0;border:0;border-radius:50%;background:#f2f2f2;color:' + texto + ';font:inherit;font-size:20px;line-height:1;cursor:pointer;-webkit-appearance:none;appearance:none}',
    R + 'button:focus-visible,' + R + 'a:focus-visible{outline:2px solid #000;outline-offset:2px}',
    P + 'rolagem{flex:1 1 auto;min-height:0;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:0 ' + pad + ' 8px}',
    P + 'gal{margin:12px calc(-1*' + pad + ') 0;min-width:0}',
    P + 'palco{position:relative;min-width:0}',
    P + 'trilho{position:relative;display:flex;gap:6px;min-width:0;overflow-x:auto;overscroll-behavior-x:contain;scroll-snap-type:x mandatory;scroll-padding-left:' + pad + ';padding:0 ' + pad + ';scrollbar-width:none}',
    P + 'trilho::-webkit-scrollbar{display:none}',
    // galeria como na pagina Influenciadoras: uma foto por tela (a proxima aparece na borda), contador e miniaturas 44x56
    P + 'quadro{flex:0 0 calc(100% - 34px);min-width:0;aspect-ratio:' + V('qv-foto-proporcao', '2 / 3') + ';overflow:hidden;scroll-snap-align:start;background:#f2f2f2}',
    P + 'trilho-uma ' + P + 'quadro{flex-basis:100%}',
    R + P + 'quadro img{display:block;width:100%;max-width:none;height:100%;object-fit:cover}',
    P + 'conta{position:absolute;right:' + 'calc(' + pad + ' + 42px);bottom:8px;padding:2px 8px;border-radius:999px;background:rgba(0,0,0,.45);color:#fff;font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums;pointer-events:none}',
    P + 'minis{display:flex;gap:6px;min-width:0;margin:8px 0 0;padding:0 ' + pad + ';overflow-x:auto;scrollbar-width:none}',
    P + 'minis::-webkit-scrollbar{display:none}',
    R + 'button' + P + 'mini{position:relative;overflow:hidden;flex:none;width:44px;height:56px;margin:0;padding:0;border:1px solid transparent;border-radius:0;background:none;cursor:pointer;-webkit-appearance:none;appearance:none}',
    R + 'button' + P + 'mini[aria-current="true"]{border-color:' + texto + '}',
    R + P + 'mini img{position:absolute;top:0;right:0;bottom:0;left:0;display:block;width:100%;max-width:none;height:100%;max-height:none;object-fit:cover;object-position:50% 20%}',  // QA 3.3: preenche a moldura 44x56 mesmo com foto quadrada
    P + 'inf{display:grid;grid-template-columns:minmax(0,1fr);grid-auto-rows:max-content;align-content:start;min-width:0;padding:0 0 6px}',
    P + 'inf>*{min-width:0}',
    P + 'preco{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;margin:4px 0 0;font-size:' + V('qv-preco-tam', '16px') + ';font-weight:' + V('qv-preco-peso', '600') + ';line-height:1.3}',
    P + 'preco s{font-size:13px;font-weight:400;color:' + suave + '}',
    P + 'rotulo{margin:18px 0 8px;font-size:10px;font-weight:400;line-height:1.3;text-transform:uppercase;letter-spacing:.08em;color:' + suave + '}',
    P + 'rotulo span{text-transform:none;letter-spacing:0;font-size:12px;color:' + texto + '}',
    P + 'pe ' + P + 'rotulo{margin:0 0 6px}',
    P + 'cores,' + P + 'tamanhos{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}',
    // outras cores em cards pequenos com foto e nome (como "Tambem em outras cores" da pagina Influenciadoras), em trilho horizontal
    P + 'cores{flex:none;align-items:flex-start;min-height:-webkit-max-content;min-height:max-content;flex-wrap:nowrap;gap:10px;margin:0 calc(-1*' + pad + ');padding:0 ' + pad + ' 2px;overflow-x:auto;scroll-snap-type:x proximity;scroll-padding-left:' + pad + ';scrollbar-width:none}',
    P + 'cores::-webkit-scrollbar{display:none}',
    R + 'button' + P + 'cor{position:relative;display:grid;gap:4px;flex:none;width:76px;margin:0;padding:0;border:0;border-radius:0;background:none;color:' + texto + ';font-family:inherit;text-align:left;scroll-snap-align:start;cursor:pointer;-webkit-appearance:none;appearance:none}',
    R + P + 'cor img,' + R + P + 'cor-sem{display:block;width:76px;height:95px;max-width:none;object-fit:cover;background:#f2f2f2;outline:1px solid transparent;outline-offset:-1px}',
    R + 'button' + P + 'cor[aria-pressed="true"] img,' + R + 'button' + P + 'cor[aria-pressed="true"] ' + P + 'cor-sem{outline:2px solid ' + dest + ';outline-offset:-2px}',
    P + 'cor-nome{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:11px;line-height:1.3}',
    R + 'button' + P + 'cor[aria-pressed="true"] ' + P + 'cor-nome{font-weight:600}',
    R + 'button' + P + 'cor-esg img{opacity:.4}',
    R + 'button' + P + 'cor-esg ' + P + 'cor-nome{color:' + suave + '}',
    R + 'button' + P + 'tam{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;min-width:' + tam + ';height:' + tam + ';margin:0;padding:0 8px;border:1px solid ' + borda + ';border-radius:0;background:' + fundo + ';color:' + texto + ';font-family:inherit;font-size:12.5px;font-weight:400;line-height:1;letter-spacing:normal;text-transform:none;font-variant-numeric:tabular-nums;cursor:pointer;-webkit-appearance:none;appearance:none}',
    // area de toque de 44 px sem aumentar o desenho do botao
    R + 'button' + P + 'tam::before{content:"";position:absolute;top:-3px;right:-3px;bottom:-3px;left:-3px}',
    R + 'button' + P + 'tam[aria-pressed="true"]{background:' + dest + ';border-color:' + dest + ';color:#fff}',
    R + 'button' + P + 'tam-esg{color:#a6a6a6;border-color:#e1e1e1;background:' + fundo + ' linear-gradient(to top right,transparent calc(50% - .5px),#c4c4c4 50%,transparent calc(50% + .5px));cursor:not-allowed}',
    P + 'treme{animation:tg-busca-qv-treme .35s ease-in-out}',
    P + 'esq{display:flex;gap:6px}',
    P + 'esq i{display:block;width:' + tam + ';height:' + tam + ';background:#eee;animation:tg-busca-qv-pulsa 1.2s ease-in-out infinite}',
    P + 'msg{min-height:0;margin:6px 0 0;font-size:12px;line-height:1.4;color:' + suave + '}',
    P + 'msg:empty{display:none}',
    P + 'msg-erro{color:' + erro + '}',
    P + 'pe{position:relative;flex:none;display:grid;gap:4px;padding:12px ' + pad + ' calc(12px + env(safe-area-inset-bottom,0px));border-top:1px solid ' + linha + ';background:' + fundo + '}',
    R + 'button' + P + 'add{display:flex;align-items:center;justify-content:center;width:100%;min-height:' + btnAlt + ';margin:0;padding:0 16px;border:1px solid ' + dest + ';border-radius:' + btnRaio + ';background:' + dest + ';color:#fff;font-family:inherit;font-size:14px;font-weight:500;line-height:1.2;letter-spacing:normal;text-transform:none;cursor:pointer;-webkit-appearance:none;appearance:none}',
    R + 'button' + P + 'add:disabled{background:#e6e6e6;border-color:#e6e6e6;color:#8a8a8a;cursor:not-allowed}',
    R + 'a' + P + 'pagina{display:flex;align-items:center;justify-self:start;min-height:44px;margin:14px 0 0;padding:0;color:' + texto + ';font-size:10px;line-height:1.3;letter-spacing:.08em;text-transform:uppercase;text-decoration:underline;text-underline-offset:3px}',
    R + P + 'pe a' + P + 'pagina{justify-self:stretch;justify-content:center;margin:0;font-size:13px;letter-spacing:normal;text-transform:none}',
    R + 'a' + P + 'pagina-prim{min-height:' + btnAlt + ';border:1px solid ' + dest + ';border-radius:' + btnRaio + ';background:' + dest + ';color:#fff;font-weight:500;text-decoration:none}',
    P + 'peca{display:grid;grid-template-columns:' + V('qv-peca-foto', '84px') + ' minmax(0,1fr);gap:0 12px;padding:14px 0;border-bottom:1px solid ' + linha + '}',
    P + 'peca:last-child{border-bottom:0}',
    P + 'peca-foto{display:block;align-self:start;aspect-ratio:2 / 3;overflow:hidden;background:#f2f2f2}',
    R + P + 'peca-foto img{display:block;width:100%;max-width:none;height:100%;object-fit:cover}',
    P + 'peca-inf{min-width:0}',
    R + 'a' + P + 'peca-nome{display:block;margin:0 0 4px;color:' + texto + ';font-size:13px;font-weight:500;line-height:1.35;text-decoration:none}',
    P + 'peca-inf ' + P + 'rotulo{margin:10px 0 6px}',
    P + 'total{margin:0;font-size:13px;color:' + suave + ';text-align:center}',
    // conjunto no padrao Influenciadoras: um card por peca (foto a esquerda; nome com bolinha, preco, parcelas, destaques e "Detalhes da peca")
    P + 'cj-sub{margin:4px 0 6px;font-size:12px;line-height:1.45;color:' + suave + '}',
    P + 'cj{display:grid;grid-template-columns:' + V('qv-cj-foto', '40%') + ' minmax(0,1fr);gap:0 14px;align-items:start;padding:16px 0;border-bottom:1px solid ' + linha + '}',
    P + 'cj:last-child{border-bottom:0;padding-bottom:calc(16px + env(safe-area-inset-bottom,0px))}',
    R + 'button' + P + 'cj-foto{display:block;width:100%;margin:0;padding:0;border:0;border-radius:0;background:#f2f2f2;aspect-ratio:2 / 3;overflow:hidden;cursor:pointer;-webkit-appearance:none;appearance:none}',
    R + P + 'cj-foto img{display:block;width:100%;max-width:none;height:100%;object-fit:cover}',
    P + 'cj-inf{display:flex;flex-direction:column;align-items:flex-start;min-width:0;padding-top:2px}',
    R + 'p' + P + 'cj-nome{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;width:100%;margin:0;font-size:14px;font-weight:400;line-height:1.35;color:' + texto + '}',
    P + 'cj-nome ' + P + 'bolinha{margin-top:2px}',
    P + 'cj-inf ' + P + 'preco{margin:6px 0 0;font-size:14px}',
    P + 'cj-extra{min-height:0}',
    P + 'cj-extra ' + P + 'parc{margin:2px 0 0}',
    R + 'p' + P + 'cj-dest{margin:8px 0 0;font-size:12px;line-height:1.45;color:#3a3a3a}',
    R + 'button' + P + 'cj-det{display:inline-flex;align-items:center;gap:8px;min-height:44px;margin:14px 0 0;padding:0 16px;border:1px solid ' + texto + ';border-radius:0;background:' + fundo + ';color:' + texto + ';font-family:inherit;font-size:13px;font-weight:400;line-height:1.2;cursor:pointer;-webkit-appearance:none;appearance:none}',
    R + 'button' + P + 'cj-det::after{content:"";width:6px;height:6px;border-top:1.5px solid currentColor;border-right:1.5px solid currentColor;transform:rotate(45deg)}',
    // v15 (revisao do Danilo, 25/11): Voltar no cabecalho, foto que amplia, confirmacao da sacola, saida animada e troca de cor como pagina virando
    P + 'cab-esq{display:flex;align-items:center;gap:4px;min-width:0}',
    R + 'button' + P + 'voltar{display:inline-flex;align-items:center;gap:6px;flex:none;min-height:44px;margin:0 0 0 -10px;padding:0 10px;border:0;border-radius:999px;background:none;color:' + texto + ';font-family:inherit;font-size:12px;font-weight:500;line-height:1;letter-spacing:normal;text-transform:none;cursor:pointer;-webkit-appearance:none;appearance:none}',
    R + 'button' + P + 'voltar::before{content:"";width:7px;height:7px;margin-left:2px;border-left:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg)}',
    R + 'button' + P + 'voltar:hover{background:#f2f2f2}',
    R + 'button' + P + 'voltar[hidden]{display:none}',
    R + 'button' + P + 'quadro{display:block;margin:0;padding:0;border:0;border-radius:0;cursor:zoom-in;-webkit-appearance:none;appearance:none}',
    R + 'button' + P + 'add' + P + 'add-ok{gap:10px;background:' + V('qv-cor-ok', '#1d6b40') + ';border-color:' + V('qv-cor-ok', '#1d6b40') + ';color:#fff}',
    R + 'button' + P + 'add-ok::before{content:"";width:12px;height:6px;margin-top:-4px;border-left:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(-45deg)}',
    P + 'aviso{position:absolute;right:' + pad + ';bottom:calc(100% + 10px);left:' + pad + ';z-index:3;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 8px 8px 14px;border-radius:10px;background:#1f1f1f;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.18);animation:tg-busca-qv-aviso .26s ease}',
    P + 'aviso[hidden]{display:none}',
    R + 'p' + P + 'aviso-txt{display:flex;align-items:center;gap:10px;min-width:0;margin:0;font-size:13px;line-height:1.35;color:#fff}',
    R + 'p' + P + 'aviso-txt::before{content:"";flex:none;width:10px;height:5px;margin-top:-3px;border-left:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(-45deg)}',
    R + 'button' + P + 'aviso-ver{flex:none;min-height:40px;margin:0;padding:0 14px;border:1px solid #fff;border-radius:999px;background:#fff;color:#111;font-family:inherit;font-size:12.5px;font-weight:600;line-height:1;letter-spacing:normal;text-transform:none;cursor:pointer;-webkit-appearance:none;appearance:none}',
    P + 'saindo{pointer-events:none}',
    P + 'saindo ' + P + 'fundo{animation:tg-busca-qv-some .22s ease forwards}',
    P + 'raiz' + P + 'saindo ' + P + 'painel{animation:tg-busca-qv-desce .22s ease-in forwards}',
    P + 'virando{animation:tg-busca-qv-vira .34s cubic-bezier(.2,.7,.2,1);transform-origin:left center;-webkit-backface-visibility:hidden;backface-visibility:hidden}',
    P + 'virando' + P + 'virando-volta{animation-name:tg-busca-qv-vira-volta;transform-origin:right center}',
    // foto ampliada: fundo escuro sobre tudo, foto inteira (contain), passa com o dedo; setas no desktop
    P + 'lupa{position:fixed;top:0;right:0;bottom:0;left:0;z-index:5;display:flex;flex-direction:column;background:rgba(0,0,0,.94);color:#fff;animation:tg-busca-qv-fade .2s ease}',
    P + 'lupa-trilho{flex:1 1 auto;display:flex;min-height:0;overflow-x:auto;overflow-y:hidden;overscroll-behavior:contain;scroll-snap-type:x mandatory;scrollbar-width:none}',
    P + 'lupa-trilho::-webkit-scrollbar{display:none}',
    P + 'lupa-quadro{flex:0 0 100%;display:flex;align-items:center;justify-content:center;min-width:0;padding:64px 12px calc(40px + env(safe-area-inset-bottom,0px));scroll-snap-align:center;scroll-snap-stop:always}',
    R + P + 'lupa-quadro img{display:block;width:auto;height:auto;max-width:100%;max-height:100%;object-fit:contain}',
    R + 'p' + P + 'lupa-conta{position:absolute;top:calc(22px + env(safe-area-inset-top,0px));left:50%;margin:0;padding:3px 10px;border-radius:999px;background:rgba(255,255,255,.14);color:#fff;font-size:13px;line-height:1.5;font-variant-numeric:tabular-nums;transform:translateX(-50%)}',
    R + 'button' + P + 'lupa-fechar{position:absolute;top:calc(12px + env(safe-area-inset-top,0px));right:12px;display:flex;align-items:center;justify-content:center;width:44px;height:44px;margin:0;padding:0;border:1px solid rgba(255,255,255,.4);border-radius:50%;background:rgba(0,0,0,.45);color:#fff;font-family:inherit;font-size:22px;line-height:1;cursor:pointer;-webkit-appearance:none;appearance:none}',
    R + 'button' + P + 'lupa-ant,' + R + 'button' + P + 'lupa-prox{position:absolute;top:50%;display:flex;align-items:center;justify-content:center;width:48px;height:48px;margin:-24px 0 0;padding:0;border:1px solid rgba(255,255,255,.4);border-radius:50%;background:rgba(0,0,0,.45);color:#fff;cursor:pointer;-webkit-appearance:none;appearance:none}',
    R + 'button' + P + 'lupa-ant{left:16px}',
    R + 'button' + P + 'lupa-prox{right:16px}',
    R + 'button' + P + 'lupa-ant::before,' + R + 'button' + P + 'lupa-prox::before{content:"";width:10px;height:10px;border-top:2px solid currentColor;border-right:2px solid currentColor}',
    R + 'button' + P + 'lupa-ant::before{margin-left:5px;transform:rotate(-135deg)}',
    R + 'button' + P + 'lupa-prox::before{margin-right:5px;transform:rotate(45deg)}',
    R + P + 'lupa button:focus-visible{outline:2px solid #fff;outline-offset:2px}',
    '@keyframes tg-busca-qv-sobe{from{transform:translateY(24px);opacity:.6}}',
    '@keyframes tg-busca-qv-desce{to{transform:translateY(100%)}}',
    '@keyframes tg-busca-qv-some{to{opacity:0}}',
    '@keyframes tg-busca-qv-entra{from{opacity:0;transform:scale(.96)}}',
    '@keyframes tg-busca-qv-sai{to{opacity:0;transform:scale(.96)}}',
    '@keyframes tg-busca-qv-vira{from{opacity:.15;transform:perspective(1200px) rotateY(-14deg) translateX(28px)}}',
    '@keyframes tg-busca-qv-vira-volta{from{opacity:.15;transform:perspective(1200px) rotateY(14deg) translateX(-28px)}}',
    '@keyframes tg-busca-qv-aviso{from{opacity:0;transform:translateY(8px)}}',
    '@keyframes tg-busca-qv-fade{from{opacity:0}}',
    '@keyframes tg-busca-qv-pulsa{50%{opacity:.5}}',
    '@keyframes tg-busca-qv-treme{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}',
    '@media (prefers-reduced-motion:reduce){' + P + 'painel,' + P + 'fundo,' + P + 'esq i,' + P + 'treme{animation:none}}',
    '@media (min-width:768px){',
    P + 'raiz{align-items:center}',
    P + 'painel{width:min(' + V('qv-largura-desk', '960px') + ',94vw);max-height:' + V('qv-altura-max-desk', '88vh') + ';border-radius:' + V('qv-raio-desk', '12px') + ';display:grid;grid-template-columns:minmax(0,5fr) minmax(0,6fr);grid-template-rows:auto minmax(0,1fr) auto;grid-template-areas:"gal cab" "gal inf" "gal pe"}',
    P + 'alca{display:none}',
    P + 'cab{grid-area:cab;grid-template-columns:1fr auto}',
    P + 'rolagem{display:contents}',
    P + 'gal{grid-area:gal;margin:0;display:block;min-height:0;overflow-y:auto;background:#f7f7f7;padding:0 0 8px}',
    P + 'trilho{padding:0;scroll-padding-left:0;gap:0}',
    P + 'palco{align-self:start}',
    P + 'quadro{flex:0 0 100%}',
    P + 'conta{display:block;position:absolute;right:8px;bottom:8px;padding:2px 8px;border-radius:999px;background:rgba(0,0,0,.45);color:#fff;font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums;pointer-events:none}',
    P + 'minis{display:flex;gap:6px;margin:8px 8px 0;overflow-x:auto;scrollbar-width:none}',
    R + 'button' + P + 'mini{position:relative;overflow:hidden;flex:none;width:44px;height:56px;margin:0;padding:0;border:1px solid transparent;border-radius:0;background:none;cursor:pointer;-webkit-appearance:none;appearance:none}',
    R + 'button' + P + 'mini[aria-current="true"]{border-color:' + texto + '}',
    R + P + 'mini img{position:absolute;top:0;right:0;bottom:0;left:0;display:block;width:100%;max-width:none;height:100%;max-height:none;object-fit:cover;object-position:50% 20%}',  // QA 3.3: preenche a moldura 44x56 mesmo com foto quadrada
    P + 'inf{grid-area:inf;overflow-y:auto;overscroll-behavior:contain;padding:14px ' + pad + ' 6px}',
    P + 'pe{grid-area:pe}',
    // v15: no desktop o modal entra e sai com fade e uma leve escala
    P + 'painel{animation:tg-busca-qv-entra .24s ease}',
    P + 'raiz' + P + 'saindo ' + P + 'painel{animation:tg-busca-qv-sai .2s ease-in forwards}',
    P + 'painel-conj{display:flex;flex-direction:column;width:min(' + V('qv-conj-largura-desk', '560px') + ',94vw)}',
    P + 'painel-conj ' + P + 'rolagem{display:block;flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:0 ' + pad + ' 8px}',
    '}',
    // movimento reduzido: nada anima (fica depois do bloco do desktop para valer sobre ele); o JS tambem tira o modal na hora
    '@media (prefers-reduced-motion:reduce){' + P + 'painel,' + P + 'fundo,' + P + 'virando,' + P + 'aviso,' + P + 'lupa,' + P + 'raiz' + P + 'saindo ' + P + 'painel,' + P + 'saindo ' + P + 'fundo{animation:none}' +
      P + 'acc-gaveta,' + P + 'acc-gaveta' + P + 'acc-aberta,' + P + 'painel-pe-flutua ' + P + 'pe,' + P + 'painel-pe-flutua ' + P + 'pe' + P + 'pe-oculto{transition:none}}'
  ].join('\n');
}

var TG_QV_CSS = tgQvMontarCss();

function tgQvEstilos() {
  if (document.getElementById('tg-busca-qv-estilos')) { return; }
  document.head.appendChild(el('style', { id: 'tg-busca-qv-estilos' }, [TG_QV_CSS]));
}

// ---------------------------------------------------------------- medicao (sem dado pessoal: so origem, posicao e contagem)
function tgQvEmitir(S, nome, extra) {
  try {
    var ev = { page_type: S.origem }, k;
    if (extra) { for (k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) { ev[k] = extra[k]; } } }
    if (typeof emitir === 'function') { emitir(nome, ev); }
  } catch (e) {}
}

// ---------------------------------------------------------------- cores (irmaos)
function tgQvRotuloCor(item, lista) {
  var r, tk, i, j, comum = 0, base, outro;
  try {
    if (typeof tgModeloCor === 'function') { r = tgModeloCor(item.n); if (r && r.cor) { return String(r.cor); } }
  } catch (e) {}
  if (!lista || lista.length < 2 || typeof item.n !== 'string') { return ''; }
  base = item.n.split(/\s+/);
  comum = base.length;
  for (i = 0; i < lista.length; i++) {
    if (lista[i] === item || typeof lista[i].n !== 'string') { continue; }
    outro = lista[i].n.split(/\s+/);
    for (j = 0; j < comum && j < outro.length && base[j] === outro[j]; j++) {}
    comum = j;
  }
  tk = base.slice(comum).join(' ');
  return comum > 0 && tk ? tk : '';
}

function tgQvIrmaos(item, irmaos) {
  var out = [], vistos = {}, i, x, achou = false;
  if (Array.isArray(irmaos)) {
    for (i = 0; i < irmaos.length; i++) {
      x = irmaos[i];
      if (!x || typeof x !== 'object' || !urlProduto(x.s) || vistos[x.s]) { continue; }
      vistos[x.s] = true;
      if (x.s === item.s) { x = item; achou = true; }
      out.push(x);
    }
  }
  if (!achou) { out.unshift(item); }
  return out;
}

// ---------------------------------------------------------------- quick view
function tgQvNo(tag, classe, filhos, attrs) {
  var a = attrs || {};
  if (classe) { a['class'] = classe; }
  return el(tag, a, filhos || null);
}

function tgQvFocaveis(raiz) {
  var lista = raiz.querySelectorAll('button, a[href]'), out = [], i;
  for (i = 0; i < lista.length; i++) {
    if (lista[i].disabled || lista[i].getAttribute('aria-hidden') === 'true') { continue; }
    if (lista[i].closest && lista[i].closest('[aria-hidden="true"],[inert],[hidden]')) { continue; }
    if (lista[i].offsetParent === null && !(lista[i].getClientRects && lista[i].getClientRects().length)) { continue; }
    out.push(lista[i]);
  }
  return out;
}

// ---------------------------------------------------------------- v15 (revisao do Danilo, 25/11)
// Saida animada, Voltar entre as cores, troca de cor como pagina virando, foto ampliada e confirmacao da sacola dentro do modal.
var TG_QV_SAIDA_MS = 320;  // a saida anima ~220 ms; se o animationend nao vier, o modal sai assim mesmo neste tempo
var TG_QV_OK_MS = 2200;    // tempo do "Adicionada a sacola" no botao
var TG_QV_AVISO_MS = 6000; // tempo do aviso com "Ver sacola"
var TG_QV_HIST_MAX = 20;   // cores guardadas para o "Voltar"

function tgQvReduzido() {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
}

// Poe o modal na pagina. Se outro ainda esta saindo (animacao de fechar), o novo entra ANTES dele no DOM: o que sai some por cima e quem
// procura o modal (querySelector) acha o novo primeiro.
function tgQvPor(raiz) {
  var saindo = null;
  try { saindo = document.querySelector('.tg-busca-qv-saindo'); } catch (e) {}
  if (saindo && saindo.parentNode === document.body) { document.body.insertBefore(raiz, saindo); } else { document.body.appendChild(raiz); }
}

// Tira o modal da tela. Tudo que importa (foco, rolagem da pagina, aoFechar) ja aconteceu em tgQvFechar; aqui so a parte visual: o no perde o id
// e os ids internos na hora (outro modal ja pode abrir), nao recebe toque e sai no fim da animacao ou no tempo limite (o primeiro que vier).
function tgQvSair(S, animar) {
  var raiz = S && S.raiz, feito = false, ids, i;
  function tirar() { if (feito) { return; } feito = true; try { if (raiz && raiz.parentNode) { raiz.parentNode.removeChild(raiz); } } catch (e) {} }
  try {
    if (!raiz || !raiz.parentNode) { return; }
    if (!animar || tgQvReduzido()) { tirar(); return; }
    raiz.removeAttribute('id');
    ids = raiz.querySelectorAll('[id]');
    for (i = 0; i < ids.length; i++) { ids[i].removeAttribute('id'); }
    raiz.setAttribute('aria-hidden', 'true');
    raiz.classList.add('tg-busca-qv-saindo');
    S.painel.addEventListener('animationend', function (ev) { if (ev.target === S.painel) { tirar(); } });
    setTimeout(tirar, TG_QV_SAIDA_MS);
  } catch (e) { tirar(); }
}

function tgQvLimpar(S) {
  try { clearTimeout(S.tOk); clearTimeout(S.tAviso); clearTimeout(S.tVira); } catch (e) {}
  try { if (S.peIo) { S.peIo.disconnect(); } if (S.peIoFim) { S.peIoFim.disconnect(); } if (S.peRo) { S.peRo.disconnect(); } } catch (e) {}
  S.lupa = null;
}

// "Voltar" do cabecalho: so aparece depois que a cliente trocou de cor dentro do modal; cada toque volta uma cor, ate a original.
function tgQvAtualizarVoltar(S) {
  try {
    if (!S.bVoltar) { return; }
    if (S.historico && S.historico.length) { S.bVoltar.removeAttribute('hidden'); return; }
    if (document.activeElement === S.bVoltar) { try { S.painel.focus({ preventScroll: true }); } catch (e) {} }
    S.bVoltar.setAttribute('hidden', 'hidden');
  } catch (e) {}
}

function tgQvVoltar(S) {
  var alvo = null;
  if (S.fechado || S.ocupado || !S.historico) { return; }
  while (S.historico.length && (!alvo || alvo === S.item)) { alvo = S.historico.pop(); }
  if (!alvo || alvo === S.item) { tgQvAtualizarVoltar(S); return; }
  tgQvTrocarItem(S, alvo, true);
}

// Troca a peca mostrada (outra cor) sem fechar o modal: guarda a anterior para o "Voltar", vira a pagina e volta ao topo (a foto).
function tgQvTrocarItem(S, alvo, volta) {
  if (!alvo || alvo === S.item || S.ocupado || S.fechado) { return; }
  if (!volta) {
    S.historico.push(S.item);
    if (S.historico.length > TG_QV_HIST_MAX) { S.historico.shift(); }
  }
  S.item = alvo;
  S.confirmado = false;
  clearTimeout(S.tOk);
  tgQvAvisoFechar(S);
  tgQvEmitir(S, 'tg_qv_cor', { position: S.irmaos.indexOf(alvo), reason: volta ? 'voltar' : 'cor' });
  tgQvCarregar(S);
  tgQvPintar(S);
  tgQvAtualizarVoltar(S);
  tgQvVirar(S, volta);
  tgQvTopo(S);
}

// Pagina virando (foto e informacoes giram de leve e entram de lado, ~0,34 s); para tras no "Voltar". Sem animacao com movimento reduzido.
function tgQvVirar(S, volta) {
  var alvos = [S.gal, S.inf], i, n;
  if (tgQvReduzido()) { return; }
  try {
    clearTimeout(S.tVira);
    for (i = 0; i < alvos.length; i++) {
      n = alvos[i];
      if (!n) { continue; }
      n.classList.remove('tg-busca-qv-virando');
      n.classList.remove('tg-busca-qv-virando-volta');
      void n.offsetWidth;
      n.classList.add('tg-busca-qv-virando');
      if (volta) { n.classList.add('tg-busca-qv-virando-volta'); }
    }
    S.tVira = setTimeout(function () {
      for (i = 0; i < alvos.length; i++) { if (alvos[i]) { alvos[i].classList.remove('tg-busca-qv-virando'); alvos[i].classList.remove('tg-busca-qv-virando-volta'); } }
    }, 450);
  } catch (e) {}
}

// Volta a rolagem do modal ao topo (a foto). No celular rola o corpo; no desktop, as colunas da foto e das informacoes.
function tgQvTopo(S) {
  var caixas = [S.rolagem, S.gal, S.inf], suave = !tgQvReduzido(), i, c;
  for (i = 0; i < caixas.length; i++) {
    c = caixas[i];
    if (!c || !c.scrollTop) { continue; }
    try { c.scrollTo({ top: 0, behavior: suave ? 'smooth' : 'auto' }); } catch (e) { try { c.scrollTop = 0; } catch (e2) {} }
  }
}

// Foto ampliada (toque/clique na foto): fundo escuro sobre tudo, foto inteira (contain), passa as fotos com o dedo (celular) ou com as setas e o
// teclado (desktop), contador, x e Esc. O foco vai para o x e volta para a foto que estiver na tela ao fechar.
function tgQvLupaAbrir(S, fotos, k, origem, aoFechar) {
  var lupa = null, trilho, conta = null, bAnt = null, bProx = null, bFechar, n = fotos ? fotos.length : 0, raf = 0, atual = 0;
  try {
    if (S.fechado || !n) { return; }
    if (S.lupa) { tgQvLupaFechar(S); }
    trilho = tgQvNo('div', 'tg-busca-qv-lupa-trilho');
    fotos.forEach(function (u, i) {
      trilho.appendChild(tgQvNo('div', 'tg-busca-qv-lupa-quadro', [el('img', { src: u, alt: 'Foto ' + (i + 1) + ' de ' + n + ': ' + S.item.n, decoding: 'async', loading: Math.abs(i - k) < 2 ? 'eager' : 'lazy' })]));
    });
    bFechar = tgQvNo('button', 'tg-busca-qv-lupa-fechar', ['×'], { type: 'button', 'aria-label': 'Fechar fotos' });
    if (n > 1) {
      conta = tgQvNo('p', 'tg-busca-qv-lupa-conta', null, { 'aria-live': 'polite' });
      bAnt = tgQvNo('button', 'tg-busca-qv-lupa-ant', null, { type: 'button', 'aria-label': 'Foto anterior' });
      bProx = tgQvNo('button', 'tg-busca-qv-lupa-prox', null, { type: 'button', 'aria-label': 'Próxima foto' });
    }
    lupa = tgQvNo('div', 'tg-busca-qv-lupa', [trilho, conta, bAnt, bProx, bFechar], { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Fotos ampliadas: ' + S.item.n });
    function largura() { return trilho.clientWidth || 1; }
    function marcar() {
      atual = Math.min(Math.max(Math.round(trilho.scrollLeft / largura()), 0), n - 1);
      if (conta) { conta.textContent = (atual + 1) + ' / ' + n; }
    }
    function ir(i, suave) {
      i = ((i % n) + n) % n;
      try { trilho.scrollTo({ left: i * largura(), behavior: suave && !tgQvReduzido() ? 'smooth' : 'auto' }); } catch (e) { trilho.scrollLeft = i * largura(); }
      if (!suave) { marcar(); }
    }
    trilho.addEventListener('scroll', function () {
      if (raf) { return; }
      raf = (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(function () { raf = 0; marcar(); });
    }, { passive: true });
    // tocar no escuro (fora da foto) tambem fecha
    trilho.addEventListener('click', function (ev) { if (ev.target && ev.target.tagName !== 'IMG') { tgQvLupaFechar(S); } });
    bFechar.addEventListener('click', function () { tgQvLupaFechar(S); });
    if (bAnt) { bAnt.addEventListener('click', function () { ir(atual - 1, true); }); }
    if (bProx) { bProx.addEventListener('click', function () { ir(atual + 1, true); }); }
    S.lupa = { no: lupa, passo: function (d) { ir(atual + d, true); }, atual: function () { return atual; }, origem: origem, aoFechar: aoFechar };
    S.painel.setAttribute('aria-hidden', 'true');
    S.raiz.appendChild(lupa);
    ir(k, false);
    try { bFechar.focus({ preventScroll: true }); } catch (e) {}
    tgQvEmitir(S, 'tg_qv_foto', { position: k });
  } catch (e) {
    try { if (lupa && lupa.parentNode) { lupa.parentNode.removeChild(lupa); } } catch (e2) {}
    S.lupa = null;
    try { S.painel.removeAttribute('aria-hidden'); } catch (e3) {}
  }
}

function tgQvLupaFechar(S) {
  var L = S.lupa, i = 0, alvo = null;
  if (!L) { return; }
  S.lupa = null;
  try { i = L.atual(); } catch (e) {}
  try { if (L.no.parentNode) { L.no.parentNode.removeChild(L.no); } } catch (e) {}
  try { S.painel.removeAttribute('aria-hidden'); } catch (e) {}
  try { if (typeof L.aoFechar === 'function') { alvo = L.aoFechar(i); } } catch (e) {}
  alvo = alvo || L.origem;
  try { if (alvo && document.contains(alvo)) { alvo.focus({ preventScroll: true }); } else { S.painel.focus({ preventScroll: true }); } } catch (e) {}
}

// Setas com a foto ampliada aberta passam as fotos. Esc (fecha so a foto) e Tab (fica dentro da foto ampliada) estao no teclado do modal.
function tgQvLupaSetas(S, ev) {
  var L = S.lupa;
  if (!L) { return false; }
  if (ev.key === 'ArrowLeft' || ev.keyCode === 37) { L.passo(-1); return true; }
  if (ev.key === 'ArrowRight' || ev.keyCode === 39) { L.passo(1); return true; }
  return false;
}

// Sacola (v15): o modal fica aberto e confirma ali mesmo. O botao vira "Adicionada a sacola" com check por ~2 s e um aviso discreto oferece
// "Ver sacola" (o aviso fica numa regiao role=status que ja existe, para o leitor de tela anunciar).
function tgQvConfirmar(S) {
  S.confirmado = true;
  tgQvAtualizarRodape(S);
  clearTimeout(S.tOk);
  S.tOk = setTimeout(function () {
    if (S.fechado || !S.confirmado) { return; }
    var foco = document.activeElement === S.bAdd;
    S.confirmado = false;
    tgQvAtualizarRodape(S);
    if (foco) { try { S.bAdd.focus({ preventScroll: true }); } catch (e) {} }
  }, TG_QV_OK_MS);
  tgQvAvisoMostrar(S);
}

function tgQvAvisoMostrar(S) {
  var ver;
  try {
    if (!S.aviso) { return; }
    clearTimeout(S.tAviso);
    S.aviso.textContent = '';
    ver = tgQvNo('button', 'tg-busca-qv-aviso-ver', ['Ver sacola'], { type: 'button' });
    ver.addEventListener('click', function () { tgQvVerSacola(S); });
    S.aviso.appendChild(tgQvNo('p', 'tg-busca-qv-aviso-txt', ['Peça adicionada à sacola']));
    S.aviso.appendChild(ver);
    S.aviso.removeAttribute('hidden');
    S.tAviso = setTimeout(function () { tgQvAvisoFechar(S); }, TG_QV_AVISO_MS);
  } catch (e) {}
}

function tgQvAvisoFechar(S) {
  try {
    clearTimeout(S.tAviso);
    if (!S.aviso || S.aviso.hasAttribute('hidden')) { return; }
    if (S.aviso.contains(document.activeElement)) { try { S.bAdd.focus({ preventScroll: true }); } catch (e) {} }
    S.aviso.setAttribute('hidden', 'hidden');
    S.aviso.textContent = '';
  } catch (e) {}
}

// "Ver sacola": fecha o modal e, se a busca (overlay #tg-busca-overlay) estiver aberta, fecha a busca tambem; so entao abre a sacola do tema.
// Causa do "nada acontece" na busca inicial (25/11): la o modal abre dentro do overlay da busca (z-index alto) e a sacola do tema abria ATRAS dele.
function tgQvVerSacola(S) {
  var ov = null, espera = 80;
  tgQvEmitir(S, 'tg_qv_ver_sacola');
  tgQvSacolaPedida = Date.now();
  try { ov = document.querySelector('#tg-busca-overlay.tg-busca-aberto'); } catch (e) {}
  tgQvFechar('sacola');
  if (ov) {
    try { if (typeof tgOvFechar === 'function') { tgOvFechar(); espera = 450; } } catch (e) {}
  }
  setTimeout(tgAbrirSacolaDoTema, espera);
}

function tgQvFechar(motivo) {
  var S = tgQvAtivo;
  if (!S) { return; }
  tgQvAtivo = null;
  S.fechado = true;
  try { document.removeEventListener('keydown', S.teclas, true); } catch (e) {}
  try { tgQvLimpar(S); } catch (e) {}
  // trocar de modal (ou falha) tira na hora; os demais motivos saem animados (deslizando no celular, fade + escala no desktop)
  tgQvSair(S, motivo !== 'trocou' && motivo !== 'erro');
  try { document.body.style.overflow = S.overflowCorpo; document.documentElement.style.overflow = S.overflowHtml; } catch (e) {}
  try { if (S.foco && S.foco.focus && document.contains(S.foco)) { S.foco.focus({ preventScroll: true }); } } catch (e) {}
  try { if (typeof S.opcoes.aoFechar === 'function') { S.opcoes.aoFechar(motivo || 'fechar'); } } catch (e) {}
}

function tgQuickViewAbrir(item, opcoes) {
  var S, raiz, fundo, painel, cab, titulo, bFechar, bVoltar, rolagem, gal, inf, pe, bAdd, aPagina;
  try {
    if (!item || typeof item !== 'object' || !urlProduto(item.s)) { return; }
    opcoes = opcoes && typeof opcoes === 'object' ? opcoes : {};
    if (tgQvAtivo) { tgQvFechar('trocou'); }
    tgQvEstilos();
    S = {
      item: item, opcoes: opcoes, irmaos: tgQvIrmaos(item, opcoes.irmaos), dados: null, erro: null, carregando: true, seq: 0,
      tam: typeof opcoes.tamanhoInicial === 'string' ? opcoes.tamanhoInicial : null, msg: '', msgErro: false, ocupado: false,
      origem: typeof opcoes.origem === 'string' && /^[a-z0-9_-]{1,30}$/.test(opcoes.origem) ? opcoes.origem : 'qv',
      foco: document.activeElement, overflowCorpo: document.body.style.overflow, overflowHtml: document.documentElement.style.overflow,
      botoesTam: [], fechado: false, historico: [], confirmado: false
    };
    tgQvAtivo = S;

    raiz = tgQvNo('div', 'tg-busca-qv-raiz', null, { id: 'tg-busca-qv' });
    fundo = tgQvNo('div', 'tg-busca-qv-fundo');
    painel = tgQvNo('div', 'tg-busca-qv-painel', null, { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tg-busca-qv-titulo' });
    painel.setAttribute('tabindex', '-1');
    // Como o modal da pagina Influenciadoras: rotulo no cabecalho; nome, preco, cores e descricao no corpo; peca, tamanhos e botao no rodape fixo.
    titulo = tgQvNo('h2', 'tg-busca-qv-titulo', [item.n], { id: 'tg-busca-qv-titulo' });
    bFechar = tgQvNo('button', 'tg-busca-qv-fechar', ['×'], { type: 'button', 'aria-label': 'Fechar' });
    // v15: "Voltar" antes do rotulo, escondido ate a cliente trocar de cor dentro do modal
    bVoltar = tgQvNo('button', 'tg-busca-qv-voltar', ['Voltar'], { type: 'button', 'aria-label': 'Voltar para a cor anterior' });
    bVoltar.setAttribute('hidden', 'hidden');
    cab = tgQvNo('div', 'tg-busca-qv-cab', [tgQvNo('div', 'tg-busca-qv-alca', [el('span')]), tgQvNo('div', 'tg-busca-qv-cab-esq', [bVoltar, tgQvNo('p', 'tg-busca-qv-cab-rotulo', ['Detalhes da peça'])]), bFechar]);
    gal = tgQvNo('div', 'tg-busca-qv-gal');
    inf = tgQvNo('div', 'tg-busca-qv-inf');
    rolagem = tgQvNo('div', 'tg-busca-qv-rolagem', [gal, inf]);
    bAdd = tgQvNo('button', 'tg-busca-qv-add', ['Adicionar à sacola'], { type: 'button' });
    aPagina = tgQvNo('a', 'tg-busca-qv-pagina', ['Ver página completa'], { href: urlProduto(item.s) });
    S.pePeca = tgQvNo('div', 'tg-busca-qv-pe-peca');
    S.peTam = tgQvNo('div', 'tg-busca-qv-pe-tam');
    // aviso da sacola ("Peca adicionada" + "Ver sacola"): regiao role=status criada vazia para o leitor de tela anunciar quando encher
    S.aviso = tgQvNo('div', 'tg-busca-qv-aviso', null, { role: 'status', 'aria-live': 'polite' });
    S.aviso.setAttribute('hidden', 'hidden');
    pe = tgQvNo('div', 'tg-busca-qv-pe', [S.aviso, S.pePeca, S.peTam, bAdd]);
    painel.appendChild(cab); painel.appendChild(rolagem); painel.appendChild(pe);
    raiz.appendChild(fundo); raiz.appendChild(painel);
    S.raiz = raiz; S.painel = painel; S.titulo = titulo; S.gal = gal; S.inf = inf; S.bAdd = bAdd; S.aPagina = aPagina; S.bFechar = bFechar; S.bVoltar = bVoltar; S.pe = pe; S.rolagem = rolagem;

    fundo.addEventListener('click', function () { tgQvFechar('fundo'); });
    bFechar.addEventListener('click', function () { tgQvFechar('botao'); });
    bAdd.addEventListener('click', function () { tgQvAdicionar(S); });
    bVoltar.addEventListener('click', function () { tgQvVoltar(S); });
    aPagina.addEventListener('click', function () { tgQvEmitir(S, 'tg_qv_ver_pagina'); });
    S.teclas = function (ev) {
      var f, a;
      if (S.fechado) { return; }
      if (S.lupa && tgQvLupaSetas(S, ev)) { return; }
      if (ev.key === 'Escape' || ev.keyCode === 27) { ev.preventDefault(); ev.stopPropagation(); if (S.lupa) { tgQvLupaFechar(S); return; } tgQvFechar('esc'); return; }
      if (ev.key === 'Tab' || ev.keyCode === 9) {
        f = tgQvFocaveis(S.lupa ? S.lupa.no : S.painel);
        if (!f.length) { ev.preventDefault(); return; }
        a = document.activeElement;
        if (!(S.lupa ? S.lupa.no : S.painel).contains(a)) { ev.preventDefault(); f[0].focus(); return; }
        if (a === S.painel) { ev.preventDefault(); (ev.shiftKey ? f[f.length - 1] : f[0]).focus(); return; }
        if (ev.shiftKey && a === f[0]) { ev.preventDefault(); f[f.length - 1].focus(); } else if (!ev.shiftKey && a === f[f.length - 1]) { ev.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener('keydown', S.teclas, true);
    tgQvArrastar(S, cab);

    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    tgQvPor(raiz);
    try { painel.focus({ preventScroll: true }); } catch (e) {}
    tgQvEmitir(S, 'tg_qv_abrir', { position: S.irmaos.indexOf(item), results_count: S.irmaos.length });
    tgQvPintar(S);
    tgQvCarregar(S);
  } catch (e) {
    try { tgQvFechar('erro'); } catch (e2) {}
    try { if (item && urlProduto(item.s) && typeof window !== 'undefined') { window.location.assign(urlProduto(item.s)); } } catch (e3) {}
  }
}

// Busca as variantes do item atual e repinta. Resposta velha (outra cor ja escolhida) e ignorada.
function tgQvCarregar(S) {
  var meu = ++S.seq, item = S.item;
  S.dados = null; S.erro = null; S.carregando = true;
  tgVariantesDoProduto(item).then(function (d) {
    var i, t, ini;
    if (S.fechado || meu !== S.seq) { return; }
    S.carregando = false;
    if (!d || !d.ok || !d.tamanhos || !d.tamanhos.length) { S.erro = d && d.motivo ? d.motivo : 'erro'; S.dados = null; tgQvPintar(S); return; }
    S.dados = d;
    // tamanho: mantem o escolhido se existe e esta disponivel nesta cor; senao o inicial pedido; senao nenhum
    ini = S.tam; S.tam = null; S.msg = ''; S.msgErro = false;
    if (ini) {
      for (i = 0; i < d.tamanhos.length; i++) {
        t = d.tamanhos[i];
        if (t.rotulo.toUpperCase() === ini.toUpperCase()) {
          if (t.disponivel) { S.tam = t.rotulo; } else { S.msg = 'O tamanho ' + t.rotulo + ' não está disponível nesta cor.'; }
        }
      }
    }
    tgQvPintar(S);
  });
}

function tgQvPreco(S) {
  var d = S.dados, p, de, pr;
  if (d && d.preco) { p = d.preco; de = d.precoDe; } else {
    pr = precoFinal(S.item);
    if (!pr) { return null; }
    p = pr.final; de = pr.de;
  }
  return tgQvNo('p', 'tg-busca-qv-preco', [el('strong', null, [reais(p)]), de ? el('s', null, [reais(de)]) : null]);
}

function tgQvPintarGaleria(S) {
  var fotos = S.dados && S.dados.fotos && S.dados.fotos.length ? S.dados.fotos : (urlImagem(S.item.i) ? [urlImagem(S.item.i)] : []);
  var trilho, palco, quadros = [], minis = [], conta = null, minisBox = null, i, atual = 0, raf = 0;
  S.gal.textContent = '';
  if (!fotos.length) { S.gal.style.display = 'none'; return; }
  S.gal.style.display = '';
  trilho = tgQvNo('div', 'tg-busca-qv-trilho' + (fotos.length === 1 ? ' tg-busca-qv-trilho-uma' : ''), null, { role: 'group', 'aria-label': 'Fotos de ' + S.item.n });
  fotos.forEach(function (u, k) {
    // v15: tocar/clicar na foto abre a foto ampliada (fundo escuro, foto inteira); ao fechar, a galeria fica na foto que estava na tela
    var q = tgQvNo('button', 'tg-busca-qv-quadro', [el('img', { src: u, alt: k === 0 ? S.item.n : '', loading: k < 2 ? 'eager' : 'lazy', decoding: 'async' })], { type: 'button', 'aria-label': 'Ampliar foto ' + (k + 1) + ' de ' + fotos.length });
    q.addEventListener('click', function () {
      tgQvLupaAbrir(S, fotos, k, q, function (i) {
        if (!quadros[i]) { return null; }
        try { trilho.scrollLeft = quadros[i].offsetLeft - quadros[0].offsetLeft; } catch (e) {}
        return quadros[i];
      });
    });
    quadros.push(q); trilho.appendChild(q);
  });
  palco = tgQvNo('div', 'tg-busca-qv-palco', [trilho]);
  S.gal.appendChild(palco);
  if (fotos.length > 1) {
    conta = tgQvNo('span', 'tg-busca-qv-conta', ['1 / ' + fotos.length], { 'aria-hidden': 'true' });
    palco.appendChild(conta);
    minisBox = tgQvNo('div', 'tg-busca-qv-minis');
    fotos.forEach(function (u, k) {
      var b = tgQvNo('button', 'tg-busca-qv-mini', [el('img', { src: u, alt: '', loading: 'lazy', width: '44', height: '56' })], { type: 'button', 'aria-label': 'Foto ' + (k + 1) + ' de ' + fotos.length });
      if (k === 0) { b.setAttribute('aria-current', 'true'); }
      b.addEventListener('click', function () {
        try { trilho.scrollTo({ left: quadros[k].offsetLeft - quadros[0].offsetLeft, behavior: 'smooth' }); } catch (e) { trilho.scrollLeft = quadros[k].offsetLeft - quadros[0].offsetLeft; }
      });
      minis.push(b); minisBox.appendChild(b);
    });
    S.gal.appendChild(minisBox);
    trilho.addEventListener('scroll', function () {
      if (raf) { return; }
      raf = (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(function () {
        var passo = quadros[0].offsetWidth + 6, k;
        raf = 0;
        if (passo <= 0) { return; }
        k = Math.min(Math.max(Math.round(trilho.scrollLeft / passo), 0), fotos.length - 1);
        if (k === atual) { return; }
        atual = k;
        conta.textContent = (k + 1) + ' / ' + fotos.length;
        for (i = 0; i < minis.length; i++) { if (i === k) { minis[i].setAttribute('aria-current', 'true'); } else { minis[i].removeAttribute('aria-current'); } }
      });
    }, { passive: true });
  }
}

function tgQvPintarTamanhos(S) {
  var d = S.dados, caixa, i, t, b, algum = false;
  S.botoesTam = [];
  if (S.carregando) {
    return tgQvNo('div', 'tg-busca-qv-esq', [el('i'), el('i'), el('i'), el('i'), el('i')], { role: 'status', 'aria-label': 'Carregando tamanhos' });
  }
  if (!d) { return null; }
  caixa = tgQvNo('div', 'tg-busca-qv-tamanhos', null, { role: 'group', 'aria-label': 'Tamanho' });
  for (i = 0; i < d.tamanhos.length; i++) {
    t = d.tamanhos[i];
    b = tgQvNo('button', 'tg-busca-qv-tam' + (t.disponivel ? '' : ' tg-busca-qv-tam-esg'), [t.rotulo], { type: 'button', 'aria-pressed': S.tam === t.rotulo ? 'true' : 'false', 'data-tamanho': t.rotulo });
    if (!t.disponivel) { b.setAttribute('aria-disabled', 'true'); b.setAttribute('aria-label', t.rotulo + ', esgotado'); } else { algum = true; }
    (function (tt, idx) {
      b.addEventListener('click', function () {
        if (!tt.disponivel || S.ocupado) { return; }
        if (S.confirmado) { S.confirmado = false; clearTimeout(S.tOk); }
        S.tam = S.tam === tt.rotulo ? null : tt.rotulo;
        S.msg = ''; S.msgErro = false;
        if (S.tam) { tgQvEmitir(S, 'tg_qv_tamanho', { position: idx }); }
        tgQvAtualizarEscolha(S);
      });
    })(t, i);
    S.botoesTam.push(b); caixa.appendChild(b);
  }
  S.algumDisponivel = algum;
  return caixa;
}

// Marca o tamanho escolhido sem repintar a tela (a rolagem e o foco ficam onde estao).
function tgQvAtualizarEscolha(S) {
  var i, t;
  if (S.dados) {
    for (i = 0; i < S.botoesTam.length; i++) {
      t = S.dados.tamanhos[i];
      S.botoesTam[i].setAttribute('aria-pressed', S.tam === t.rotulo ? 'true' : 'false');
    }
  }
  if (S.rotuloTam) { S.rotuloTam.textContent = S.tam ? ': ' + S.tam : ''; }
  tgQvAtualizarRodape(S);
}

function tgQvAtualizarRodape(S) {
  var d = S.dados, pronto = !!(d && S.tam), esgotada = !!(d && !S.algumDisponivel), texto;
  // falha ao ler a pagina: o link da pagina vira o botao principal do rodape; senao fica discreto no fim do corpo
  if (S.erro) { S.bAdd.style.display = 'none'; S.aPagina.setAttribute('class', 'tg-busca-qv-pagina tg-busca-qv-pagina-prim'); if (S.pe && S.aPagina.parentNode !== S.pe) { S.pe.appendChild(S.aPagina); } } else {
    S.bAdd.style.display = '';
    S.aPagina.setAttribute('class', 'tg-busca-qv-pagina');
    if (S.inf && S.aPagina.parentNode !== S.inf) { S.inf.appendChild(S.aPagina); }
  }
  if (S.ocupado) { texto = 'Adicionando…'; } else if (S.confirmado) { texto = 'Adicionada à sacola'; } else if (esgotada) { texto = 'Peça esgotada nesta cor'; } else { texto = 'Adicionar à sacola'; }
  S.bAdd.textContent = texto;
  if (S.confirmado && !S.ocupado) { S.bAdd.classList.add('tg-busca-qv-add-ok'); } else { S.bAdd.classList.remove('tg-busca-qv-add-ok'); }
  if (d && S.algumDisponivel && !S.ocupado) { S.bAdd.removeAttribute('disabled'); S.bAdd.removeAttribute('aria-disabled'); } else { S.bAdd.setAttribute('disabled', 'disabled'); S.bAdd.setAttribute('aria-disabled', 'true'); }
  if (S.msgEl) {
    // sem dica fixa: o botao fica ativo e, se a cliente tocar sem tamanho, a mensagem pede o tamanho (o rodape fica mais baixo)
    S.msgEl.textContent = S.msg || '';
    S.msgEl.setAttribute('class', 'tg-busca-qv-msg' + (S.msgErro ? ' tg-busca-qv-msg-erro' : ''));
  }
  try { S.aPagina.setAttribute('href', urlProduto(S.item.s)); } catch (e) {}
}

// "R$ 350,55 no Pix" e "ou 5x de R$ 73,80 sem juros", lidos da pagina da peca (so aparecem depois que ela chega).
function tgQvLinhaParcelas(S) {
  var d = S.dados, linhas = [];
  if (!d) { return null; }
  if (d.pix) { linhas.push(tgQvNo('p', 'tg-busca-qv-parc', [el('b', null, [reais(d.pix)]), ' no Pix'])); }
  if (d.parcelas) { linhas.push(tgQvNo('p', 'tg-busca-qv-parc', ['ou ' + d.parcelas.n + 'x de ' + reais(d.parcelas.v) + ' sem juros'])); }
  return linhas.length ? tgQvNo('div', 'tg-busca-qv-parcs', linhas) : null;
}

// Destaques (ate 3, sempre visiveis) e Descricao / Detalhes da peca recolhidos, como na pagina Influenciadoras. So texto.
function tgQvPintarDescricao(S) {
  var ds = S.dados && S.dados.descricao, lista, accs, i, x, corpo, dl;
  if (!ds) { return; }
  if (ds.destaques.length) {
    lista = tgQvNo('ul', 'tg-busca-qv-dest');
    for (i = 0; i < ds.destaques.length && i < 3; i++) {
      x = ds.destaques[i];
      lista.appendChild(el('li', null, [x.rotulo ? el('b', null, [x.rotulo + ':']) : null, x.rotulo ? ' ' : null, x.texto]));
    }
    S.inf.appendChild(lista);
  }
  accs = tgQvNo('div', 'tg-busca-qv-accs');
  if (ds.intro.length) {
    corpo = tgQvNo('div', 'tg-busca-qv-acc-corpo');
    for (i = 0; i < ds.intro.length; i++) { corpo.appendChild(tgQvNo('p', 'tg-busca-qv-texto', [ds.intro[i]])); }
    accs.appendChild(tgQvSanfona(S, 'Descrição', corpo, 'desc'));
  }
  if (ds.ficha.length) {
    dl = tgQvNo('dl', 'tg-busca-qv-acc-corpo');
    for (i = 0; i < ds.ficha.length; i++) { dl.appendChild(tgQvNo('div', 'tg-busca-qv-ficha', [el('dt', null, [ds.ficha[i].rotulo || '—']), el('dd', null, [ds.ficha[i].texto])])); }
    accs.appendChild(tgQvSanfona(S, 'Detalhes da peça', dl, 'ficha'));
  }
  if (accs.firstChild) { S.inf.appendChild(accs); }
}

// Bloco recolhivel em gaveta (v15): a altura anima de 0 ao conteudo (grid-template-rows 0fr -> 1fr, classe tg-busca-qv-acc-aberta). Fechado, o
// conteudo fica com visibility:hidden (fora do leitor de tela e do Tab); o botao anuncia o estado por aria-expanded.
function tgQvSanfona(S, titulo, corpo, chave) {
  var id = 'tg-busca-qv-acc-' + chave, aberto = !!(S.abertos && S.abertos[chave]), bt, caixa, gaveta;
  corpo.setAttribute('id', id);
  gaveta = tgQvNo('div', 'tg-busca-qv-acc-gaveta' + (aberto ? ' tg-busca-qv-acc-aberta' : ''), [tgQvNo('div', 'tg-busca-qv-acc-dentro', [corpo])]);
  bt = tgQvNo('button', 'tg-busca-qv-acc-bt', [titulo], { type: 'button', 'aria-expanded': aberto ? 'true' : 'false', 'aria-controls': id });
  bt.addEventListener('click', function () {
    var abrir = bt.getAttribute('aria-expanded') !== 'true';
    bt.setAttribute('aria-expanded', abrir ? 'true' : 'false');
    if (abrir) { gaveta.classList.add('tg-busca-qv-acc-aberta'); } else { gaveta.classList.remove('tg-busca-qv-acc-aberta'); }
    S.abertos = S.abertos || {};
    S.abertos[chave] = abrir;
    if (abrir) { tgQvEmitir(S, 'tg_qv_detalhes', { reason: chave }); }
  });
  caixa = tgQvNo('div', 'tg-busca-qv-acc', [bt, gaveta]);
  return caixa;
}

// Rodape: miniatura, nome e preco da peca atual (a cliente ve o que vai para a sacola em qualquer ponto da rolagem).
function tgQvPintarPePeca(S) {
  var d = S.dados, foto = urlImagem(S.item.i), p = d && d.preco ? d.preco : (precoFinal(S.item) || {}).final, info;
  S.pePeca.textContent = '';
  if (foto) { S.pePeca.appendChild(tgFotoReserva(el('img', { src: urlImagemLeve(S.item.i, 100), alt: '', width: '40', height: '50', decoding: 'async' }), foto)); }
  info = tgQvNo('div', 'tg-busca-qv-pe-inf', [
    tgQvNo('p', 'tg-busca-qv-pe-nome', [S.item.n]),
    p ? tgQvNo('p', 'tg-busca-qv-pe-preco', [reais(p), d && d.parcelas ? el('span', null, [d.parcelas.n + 'x sem juros']) : null]) : null
  ]);
  S.pePeca.appendChild(info);
}

function tgQvPintar(S) {
  var d = S.dados, cores, nomeCor, rot, lista, i, x, b, idx, tams, foco = null, focoCor = null, ativo;
  if (S.fechado) { return; }
  ativo = document.activeElement;
  if (ativo && ativo.getAttribute && S.inf.contains(ativo)) { focoCor = ativo.getAttribute('data-qv-cor'); }
  tgQvPintarGaleria(S);
  S.inf.textContent = '';
  // nome da peca com a bolinha da cor (como na pagina Influenciadoras), preco e parcelamento
  nomeCor = d && d.cor ? d.cor : tgQvRotuloCor(S.item, S.irmaos);
  S.titulo.textContent = '';
  S.titulo.appendChild(el('span', null, [S.item.n]));
  if (nomeCor && typeof tgCorSlug === 'function' && tgCorSlug(nomeCor) !== 'outro') {
    S.titulo.appendChild(el('span', { 'class': 'tg-busca-bolinha tg-busca-qv-bolinha', 'data-cor': tgCorSlug(nomeCor), role: 'img', 'aria-label': 'Cor: ' + nomeCor }));
  }
  S.inf.appendChild(S.titulo);
  rot = tgQvPreco(S);
  if (rot) { S.inf.appendChild(rot); }
  rot = tgQvLinhaParcelas(S);
  if (rot) { S.inf.appendChild(rot); }
  // cores (irmaos) e rotulo da cor atual
  if (S.irmaos.length > 1) {
    S.inf.appendChild(tgQvNo('p', 'tg-busca-qv-rotulo', ['Cor', nomeCor ? el('span', null, [': ' + nomeCor]) : null]));
    cores = tgQvNo('div', 'tg-busca-qv-cores', null, { role: 'group', 'aria-label': 'Cor' });
    for (i = 0; i < S.irmaos.length; i++) {
      x = S.irmaos[i];
      lista = tgQvRotuloCor(x, S.irmaos) || x.n;
      b = tgQvNo('button', 'tg-busca-qv-cor' + (Array.isArray(x.sz) && !x.sz.length ? ' tg-busca-qv-cor-esg' : ''), [urlImagem(x.i) ? tgFotoReserva(el('img', { src: urlImagemLeve(x.i, 320), alt: '', loading: 'lazy', decoding: 'async' }), urlImagem(x.i)) : tgQvNo('span', 'tg-busca-qv-cor-sem'), tgQvNo('span', 'tg-busca-qv-cor-nome', [(lista || x.n) + (Array.isArray(x.sz) && !x.sz.length ? ' (esgotada)' : '')], { 'aria-hidden': 'true' })], {
        type: 'button', 'aria-pressed': x === S.item ? 'true' : 'false', 'aria-label': 'Cor ' + lista, 'data-qv-cor': x.s
      });
      (function (alvo, pos) {
        b.addEventListener('click', function () { tgQvTrocarItem(S, alvo, false); });
        b.addEventListener('mouseenter', function () { tgQuickViewPrefetch(alvo); });
        b.addEventListener('focus', function () { tgQuickViewPrefetch(alvo); });
      })(x, i);
      cores.appendChild(b);
    }
    S.inf.appendChild(cores);
  } else if (nomeCor) {
    S.inf.appendChild(tgQvNo('p', 'tg-busca-qv-rotulo', ['Cor', el('span', null, [': ' + nomeCor])]));
  }
  // destaques e descricao (so quando a pagina da peca trouxe a descricao no padrao da loja)
  tgQvPintarDescricao(S);
  // rodape fixo: a peca (miniatura, nome e preco), os tamanhos e o aviso
  tgQvPintarPePeca(S);
  S.peTam.textContent = '';
  S.rotuloTam = el('span', null, [S.tam ? ': ' + S.tam : '']);
  if (!S.erro) { S.peTam.appendChild(tgQvNo('p', 'tg-busca-qv-rotulo', ['Tamanho', S.rotuloTam])); }
  tams = S.erro ? null : tgQvPintarTamanhos(S);
  if (tams) { S.peTam.appendChild(tams); }
  S.msgEl = tgQvNo('p', 'tg-busca-qv-msg', null, { role: 'status', 'aria-live': 'polite' });
  S.peTam.appendChild(S.msgEl);
  if (S.erro) {
    S.msg = 'Não conseguimos carregar os tamanhos agora. Abra a página da peça para escolher e comprar.'; S.msgErro = true;
  }
  tgQvAtualizarRodape(S);
  if (focoCor) {
    idx = S.inf.querySelectorAll('[data-qv-cor]');
    for (i = 0; i < idx.length; i++) { if (idx[i].getAttribute('data-qv-cor') === focoCor) { foco = idx[i]; break; } }
    if (foco) { try { foco.focus({ preventScroll: true }); } catch (e) {} }
  }
}

// Adicionar a sacola com o tamanho escolhido. Falha mostra aviso e deixa o link da pagina como saida.
function tgQvAdicionar(S) {
  var d = S.dados, t, i, escolhido = null, caixa;
  if (!d || S.ocupado || S.confirmado) { return; }
  if (!S.tam) {
    S.msg = 'Escolha seu tamanho.'; S.msgErro = true;
    tgQvAtualizarRodape(S);
    caixa = S.peTam ? S.peTam.querySelector('.tg-busca-qv-tamanhos') : null;
    if (caixa) { caixa.classList.remove('tg-busca-qv-treme'); void caixa.offsetWidth; caixa.classList.add('tg-busca-qv-treme'); }
    return;
  }
  for (i = 0; i < d.tamanhos.length; i++) { t = d.tamanhos[i]; if (t.rotulo === S.tam && t.disponivel) { escolhido = t; } }
  if (!escolhido) { return; }
  S.ocupado = true; S.msg = ''; S.msgErro = false;
  tgQvAvisoFechar(S);
  tgQvAtualizarRodape(S);
  // v15: o modal fica aberto e confirma ali (antes fechava e abria a sacola do tema, que na busca inicial ficava atras do overlay da busca)
  tgAdicionarSacola(escolhido.variantId, 1, { productId: d.productId, abrirSacola: false, manterQuickView: true }).then(function (r) {
    if (r && r.ok) {
      tgQvEmitir(S, 'tg_qv_add', { reason: 'ok' });
      if (S.fechado) { return; }
      S.ocupado = false; S.msg = ''; S.msgErro = false;
      tgQvConfirmar(S);
      return;
    }
    if (S.fechado) { return; }
    S.ocupado = false;
    tgQvEmitir(S, 'tg_qv_add', { reason: r && r.motivo === 'recusado' ? 'recusado' : 'erro' });
    if (r && r.motivo === 'recusado') {
      escolhido.disponivel = false; S.tam = null;
      S.msg = 'O tamanho acabou de esgotar. Escolha outro.';
      tgQvPintar(S);
    } else {
      if (r && r.motivo === 'timeout') { S.msg = 'A loja demorou para responder. Confira a sacola antes de tentar de novo.'; }
      else if (r && (r.motivo === 'sem-ls' || r.motivo === 'produto' || r.motivo === 'dados')) { S.msg = 'Não deu para adicionar por aqui. Abra a página da peça para comprar.'; }
      else { S.msg = 'Não foi possível adicionar agora. Verifique a conexão e tente de novo.'; }
      tgQvAtualizarRodape(S);
    }
    S.msgErro = true;
    tgQvAtualizarRodape(S);
  });
}

// ---------------------------------------------------------------- quick view do conjunto (peca de cima + peca de baixo)
// v12 (Danilo, 24/11): no padrao do modal das Influenciadoras. Cada peca e um card (foto, nome com a bolinha da cor, preco, parcelas e destaques) com
// "Detalhes da peca", que abre o quick view daquela peca (tamanhos e sacola). Ao fechar o quick view da peca, o conjunto volta. Comprar as duas e
// opcao da cliente: cada peca vai para a sacola pelo proprio quick view. Qualquer falha deixa o link da pagina de cada peca como saida.
function tgQvConjDestaques(d) {
  var ds = d && d.descricao, out = [], i;
  if (!ds || !Array.isArray(ds.destaques)) { return ''; }
  for (i = 0; i < ds.destaques.length && out.length < 2; i++) { if (ds.destaques[i] && ds.destaques[i].rotulo) { out.push(String(ds.destaques[i].rotulo).replace(/[:\s]+$/, '')); } }
  return out.join(' · ');
}

function tgQvConjPintarParte(S, x) {
  var d = x.dados, linhas = [];
  x.extra.textContent = '';
  if (d && d.parcelas) { linhas.push(tgQvNo('p', 'tg-busca-qv-parc', ['ou ' + d.parcelas.n + 'x de ' + reais(d.parcelas.v) + ' sem juros'])); }
  if (d && tgQvConjDestaques(d)) { linhas.push(tgQvNo('p', 'tg-busca-qv-cj-dest', [tgQvConjDestaques(d)])); }
  linhas.forEach(function (n) { x.extra.appendChild(n); });
}

function tgQuickViewConjunto(conj, opcoes) {
  var S, raiz, fundo, painel, cab, titulo, bFechar, rolagem, k, mc, mb;
  try {
    if (!conj || !conj.cima || !conj.baixo || !urlProduto(conj.cima.s) || !urlProduto(conj.baixo.s)) { return; }
    opcoes = opcoes && typeof opcoes === 'object' ? opcoes : {};
    if (tgQvAtivo) { tgQvFechar('trocou'); }
    tgQvEstilos();
    S = {
      conj: conj, opcoes: opcoes, fechado: false,
      origem: typeof opcoes.origem === 'string' && /^[a-z0-9_-]{1,30}$/.test(opcoes.origem) ? opcoes.origem : 'qv',
      foco: document.activeElement, overflowCorpo: document.body.style.overflow, overflowHtml: document.documentElement.style.overflow
    };
    S.partes = [{ item: conj.cima, dados: null }, { item: conj.baixo, dados: null }];
    tgQvAtivo = S;
    mc = typeof tgModeloCor === 'function' ? tgModeloCor(conj.cima.n) : { modelo: conj.cima.n, cor: '' };
    mb = typeof tgModeloCor === 'function' ? tgModeloCor(conj.baixo.n) : { modelo: conj.baixo.n, cor: '' };
    raiz = tgQvNo('div', 'tg-busca-qv-raiz', null, { id: 'tg-busca-qv' });
    fundo = tgQvNo('div', 'tg-busca-qv-fundo');
    painel = tgQvNo('div', 'tg-busca-qv-painel tg-busca-qv-painel-conj', null, { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tg-busca-qv-titulo' });
    painel.setAttribute('tabindex', '-1');
    titulo = tgQvNo('h2', 'tg-busca-qv-titulo', [mc.modelo.replace(/^\S+\s+/, '') + ' + ' + mb.modelo.replace(/^\S+\s+/, '') + (conj.cor ? ' · ' + conj.cor : '')], { id: 'tg-busca-qv-titulo' });
    bFechar = tgQvNo('button', 'tg-busca-qv-fechar', ['×'], { type: 'button', 'aria-label': 'Fechar' });
    cab = tgQvNo('div', 'tg-busca-qv-cab', [tgQvNo('div', 'tg-busca-qv-alca', [el('span')]), tgQvNo('p', 'tg-busca-qv-cab-rotulo', ['Conjunto']), bFechar]);
    rolagem = tgQvNo('div', 'tg-busca-qv-rolagem', [titulo, tgQvNo('p', 'tg-busca-qv-cj-sub', ['As peças são vendidas separadamente. Leve uma ou as duas.'])]);
    for (k = 0; k < S.partes.length; k++) {
      (function (x, pos) {
        var pr = precoFinal(x.item), foto = urlImagem(x.item.i), cor = typeof tgModeloCor === 'function' ? tgModeloCor(x.item.n).cor : '', nome, det, fotoBt;
        x.extra = tgQvNo('div', 'tg-busca-qv-cj-extra');
        nome = tgQvNo('p', 'tg-busca-qv-cj-nome', [el('span', null, [x.item.n]), cor && typeof tgCorSlug === 'function' && tgCorSlug(cor) !== 'outro' ? el('span', { 'class': 'tg-busca-bolinha tg-busca-qv-bolinha', 'data-cor': tgCorSlug(cor), role: 'img', 'aria-label': 'Cor: ' + cor }) : null]);
        det = tgQvNo('button', 'tg-busca-qv-cj-det', ['Detalhes da peça'], { type: 'button', 'aria-label': 'Detalhes da peça: ' + x.item.n });
        fotoBt = tgQvNo('button', 'tg-busca-qv-cj-foto', foto ? [tgFotoReserva(el('img', { src: urlImagemLeve(x.item.i, 320), alt: '', loading: 'eager', decoding: 'async' }), foto)] : null, { type: 'button', 'aria-label': 'Detalhes da peça: ' + x.item.n, tabindex: '-1' });
        function abrir() { tgQvConjDetalhe(S, x.item, pos); }
        det.addEventListener('click', abrir);
        fotoBt.addEventListener('click', abrir);
        rolagem.appendChild(tgQvNo('div', 'tg-busca-qv-cj', [
          fotoBt,
          tgQvNo('div', 'tg-busca-qv-cj-inf', [
            nome,
            pr ? tgQvNo('p', 'tg-busca-qv-preco', [el('strong', null, [reais(pr.final)]), pr.de ? el('s', null, [reais(pr.de)]) : null]) : null,
            x.extra,
            det
          ])
        ]));
      })(S.partes[k], k);
    }
    painel.appendChild(cab); painel.appendChild(rolagem);
    raiz.appendChild(fundo); raiz.appendChild(painel);
    S.raiz = raiz; S.painel = painel; S.bFechar = bFechar;
    fundo.addEventListener('click', function () { tgQvFechar('fundo'); });
    bFechar.addEventListener('click', function () { tgQvFechar('botao'); });
    S.teclas = function (ev) {
      var f, a;
      if (S.fechado) { return; }
      if (S.lupa && tgQvLupaSetas(S, ev)) { return; }
      if (ev.key === 'Escape' || ev.keyCode === 27) { ev.preventDefault(); ev.stopPropagation(); if (S.lupa) { tgQvLupaFechar(S); return; } tgQvFechar('esc'); return; }
      if (ev.key === 'Tab' || ev.keyCode === 9) {
        f = tgQvFocaveis(S.lupa ? S.lupa.no : S.painel);
        if (!f.length) { ev.preventDefault(); return; }
        a = document.activeElement;
        if (!(S.lupa ? S.lupa.no : S.painel).contains(a)) { ev.preventDefault(); f[0].focus(); return; }
        if (a === S.painel) { ev.preventDefault(); (ev.shiftKey ? f[f.length - 1] : f[0]).focus(); return; }
        if (ev.shiftKey && a === f[0]) { ev.preventDefault(); f[f.length - 1].focus(); } else if (!ev.shiftKey && a === f[f.length - 1]) { ev.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener('keydown', S.teclas, true);
    tgQvArrastar(S, cab);
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    tgQvPor(raiz);
    try { painel.focus({ preventScroll: true }); } catch (e) {}
    tgQvEmitir(S, 'tg_qv_abrir', { position: 0, results_count: 2, reason: 'conjunto' });
    S.partes.forEach(function (x) {
      tgQvConjPintarParte(S, x);
      tgVariantesDoProduto(x.item).then(function (d) {
        if (S.fechado) { return; }
        x.dados = d && d.ok ? d : null;
        tgQvConjPintarParte(S, x);
      });
    });
  } catch (e) {
    try { tgQvFechar('erro'); } catch (e2) {}
    try { if (conj && conj.cima && urlProduto(conj.cima.s) && typeof window !== 'undefined') { window.location.assign(urlProduto(conj.cima.s)); } } catch (e3) {}
  }
}

// "Detalhes da peca" dentro do conjunto: abre o quick view da peca (tamanhos e sacola). Fechar volta ao conjunto; adicionar a sacola nao volta.
function tgQvConjDetalhe(S, item, pos) {
  var conj = S.conj, op = S.opcoes;
  tgQvEmitir(S, 'tg_qv_conj_peca', { position: pos + 1 });
  // o quick view da peca troca o do conjunto (tgQuickViewAbrir fecha o ativo com 'trocou'); o aoFechar do conjunto nao deve devolver o foco agora
  S.opcoes = { origem: op.origem };
  tgQuickViewAbrir(item, {
    irmaos: [item], origem: S.origem,
    aoFechar: function (motivo) {
      if (motivo === 'sacola' || motivo === 'trocou') { try { if (typeof op.aoFechar === 'function') { op.aoFechar(motivo); } } catch (e) {} return; }
      setTimeout(function () { try { tgQuickViewConjunto(conj, op); } catch (e) {} }, 0);
    }
  });
}

// Arrastar a alca (celular) para baixo fecha: mais de 1/3 da altura ou velocidade alta.
// v14 (bug do x, Danilo 24/11): a animacao de abertura roda uma vez so (depois o painel fica "assentado"), e o arrastar so comeca se o dedo andar
// mais de 6 px; um toque no x e so um clique (antes o painel refazia a animacao ao soltar o dedo e o clique caia na alca).
function tgQvArrastar(S, cab) {
  var y0 = 0, t0 = 0, delta = 0, ativo = false, movendo = false;
  function larga() { return (window.innerWidth || 0) >= 768; }
  function assentar() { try { S.painel.classList.add('tg-busca-qv-assentado'); } catch (e) {} }
  S.painel.addEventListener('animationend', assentar);
  setTimeout(assentar, 600);
  cab.addEventListener('touchstart', function (ev) {
    if (larga() || !ev.touches || !ev.touches[0]) { return; }
    if (ev.target && ev.target.closest && ev.target.closest('.tg-busca-qv-fechar')) { return; }
    ativo = true; movendo = false; y0 = ev.touches[0].clientY; t0 = Date.now(); delta = 0;
  }, { passive: true });
  cab.addEventListener('touchmove', function (ev) {
    if (!ativo || !ev.touches || !ev.touches[0]) { return; }
    delta = Math.max(0, ev.touches[0].clientY - y0);
    if (!movendo && delta > 6) { movendo = true; assentar(); S.painel.setAttribute('data-arrastando', 'true'); }
    if (movendo) { S.painel.style.transform = 'translateY(' + delta + 'px)'; }
  }, { passive: true });
  function fim() {
    if (!ativo) { return; }
    ativo = false;
    if (!movendo) { return; }
    movendo = false;
    S.painel.removeAttribute('data-arrastando');
    // fecha: o painel desce a partir de onde o dedo soltou (a animacao de saida parte do transform atual); senao volta ao lugar
    if (delta > S.painel.offsetHeight / 3 || delta / Math.max(1, Date.now() - t0) > 0.6) { tgQvFechar('arrastar'); return; }
    S.painel.style.transform = '';
  }
  cab.addEventListener('touchend', fim);
  cab.addEventListener('touchcancel', fim);
}


/* ---- src/injetor/desktop/autocomplete.js ---- */
/*
 * Autocomplete em overlay (redesign 18/11/2026). Origem: initAutocomplete do protótipo, reescrito sem HTML cru.
 * Mesmo comportamento de base: minimo de 2 caracteres, debounce de 90 ms, ate 6 pecas, "Ver todos".
 * Busca curada (wedding, casamento...): os mesmos 6 resultados em blocos com titulo (3 + 3), ver tgAcPintar.
 *
 * O que mudou no redesign: a busca abre em um OVERLAY proprio (#tg-busca-overlay: tela cheia no celular, painel no desktop) com campo no topo,
 * ate 6 sugestoes de termo (trecho digitado em negrito), depois "Pecas" em cards enxutos. Campo vazio mostra os chips "Em alta" e as buscas
 * recentes (localStorage, opcional). O overlay so abre DEPOIS que o catalogo carregou (falha fechada: sem catalogo a pagina fica sem rastro e a
 * busca nativa segue como sempre). Fechar o overlay fecha tambem o modal nativo do tema. Nunca mexe no formulario nativo, nunca cancela nem
 * interrompe eventos do tema (so ouve focus, input e clique).
 * Reserva #tg-busca-conselheira (vazio, display:none) para o bloco futuro da IA.
 *
 * DESKTOP (v13, Danilo 24/11): parte da logica da v12 do celular (abre no clique, Conjuntos do Recom, vitrine de Novidades) com a tela propria do
 * desktop: painel largo (usa as laterais e a altura da tela), duas colunas (buscas recentes e Em alta a esquerda; vitrine ou pecas a direita) e
 * vitrine com 4 pecas por grupo em cards grandes (o card da pagina de resultados, com VER PECA).
 */
var TG_AC_MIN = 2;
var TG_AC_LIMITE = 8; // desktop: 2 linhas de 4 pecas ao digitar
var TG_AC_ESPERA = 90;
var TG_AC_TERMOS_MAX = 6;
var TG_REC_CHAVE = 'tg_busca_recentes';
var TG_REC_MAX = 5;
var TG_AC_PARADAS = { de: 1, da: 1, do: 1, das: 1, dos: 1, em: 1, com: 1, sem: 1, para: 1, um: 1, uma: 1, na: 1, no: 1, e: 1, a: 1, o: 1, ao: 1 };
var tgOv = null; // estado do overlay (null enquanto nao foi montado)
var tgAcDesistiu = false; // o catalogo falhou nesta pagina: a busca nativa fica com a tela (o overlay nao reabre a cada foco)

function tgAcLimpar(caixa) { while (caixa.firstChild) { caixa.removeChild(caixa.firstChild); } }

// Atributos que a saida segura (el) nao aceita, gravados so com valores FIXOS do proprio codigo (name, placeholder, action...).
function tgAttr(no, obj) {
  var k;
  for (k in obj) { if (Object.prototype.hasOwnProperty.call(obj, k)) { no.setAttribute(k, String(obj[k])); } }
  return no;
}

// Reserva para o bloco da IA (dez/jan): contêiner vazio e escondido, sem conteudo e sem efeito.
function tgConselheira() { return el('div', { id: 'tg-busca-conselheira', 'class': 'tg-busca-oculto', 'aria-hidden': 'true' }); }

// ---------------------------------------------------------------- buscas recentes (localStorage; tudo opcional, nunca lanca)
function tgRecLer() {
  var out = [], bruto, lista, i;
  try {
    if (typeof window === 'undefined' || !window.localStorage) { return out; }
    bruto = window.localStorage.getItem(TG_REC_CHAVE);
    lista = bruto ? JSON.parse(bruto) : [];
    if (!Array.isArray(lista)) { return out; }
    for (i = 0; i < lista.length && out.length < TG_REC_MAX; i++) {
      if (typeof lista[i] === 'string' && lista[i].trim() && lista[i].length <= 60) { out.push(lista[i].trim()); }
    }
  } catch (e) {}
  return out;
}
function tgRecSalvar(q) {
  var v = String(q == null ? '' : q).trim(), lista, i, out;
  try {
    if (typeof window === 'undefined' || !window.localStorage || v.length < TG_AC_MIN || v.length > 60) { return; }
    lista = tgRecLer();
    out = [v];
    for (i = 0; i < lista.length && out.length < TG_REC_MAX; i++) { if (lista[i].toLowerCase() !== v.toLowerCase()) { out.push(lista[i]); } }
    window.localStorage.setItem(TG_REC_CHAVE, JSON.stringify(out));
  } catch (e) {}
}
function tgRecLimpar() { try { window.localStorage.removeItem(TG_REC_CHAVE); } catch (e) {} }

// ---------------------------------------------------------------- chips "Em alta" (lista vem do motor: TG_CHIPS_EM_ALTA)
// origem: 'overlay' | 'pagina' | 'zero' (so vai para a medicao, no parametro reason). Devolve [<a class="tg-busca-chip">] (so os chips validos).
function tgChipsNos(origem) {
  var lista = typeof TG_CHIPS_EM_ALTA !== 'undefined' && Array.isArray(TG_CHIPS_EM_ALTA) ? TG_CHIPS_EM_ALTA : [], nos = [], i, c, href, a;
  function ligar(no, pos) { no.addEventListener('click', function () { try { emitir('tg_busca_chip', { position: pos, reason: origem }); } catch (e) {} }); }
  for (i = 0; i < lista.length; i++) {
    c = lista[i];
    if (!c || typeof c.rotulo !== 'string' || !c.rotulo) { continue; }
    href = typeof c.href === 'string' ? c.href : (typeof c.consulta === 'string' && c.consulta ? urlBusca(c.consulta) : null);
    if (!href || !tgHrefOk(href)) { continue; }
    a = el('a', { 'class': 'tg-busca-chip', href: href }, [c.rotulo]);
    ligar(a, nos.length + 1);
    nos.push(a);
  }
  return nos;
}
// Lista de chips (ul > li > a). Null sem chips validos.
function tgChipsLista(origem, extra) {
  var nos = tgChipsNos(origem), itens = [], i;
  for (i = 0; i < nos.length; i++) { itens.push(el('li', null, [nos[i]])); }
  return itens.length ? el('ul', { 'class': 'tg-busca-chips' + (extra ? ' ' + extra : '') }, itens) : null;
}

// ---------------------------------------------------------------- sugestoes de termo (calculadas do proprio catalogo, sem campo novo)
// "vest" -> vestido, vestidos...; "vestido" -> vestido preto, vestido off white... (cores mais comuns entre as pecas). So texto.
// Devolve [{ texto }] (ate TG_AC_TERMOS_MAX), cada texto comecando exatamente pelo que foi digitado (sem acento), para o trecho digitado ir em negrito.
function tgAcCorDoItem(it) {
  var mc, c;
  if (typeof tgModeloCor === 'function') { mc = tgModeloCor(it.n); return mc && mc.cor ? String(mc.cor).toLowerCase() : ''; }
  if (typeof tgCorDoNome === 'function') { c = tgCorDoNome(it.n); return c && c.v ? c.v : ''; }
  return '';
}
function tgAcTermos(consulta, cat) {
  var nq = normalizeText(consulta), toks, ult, ant, base, i, j, k, it, ws, nws, antOk, nw, ent, comp = {}, compLista = [], exato = false, cores = {}, coresLista = [];
  var out = [], vistos = {}, cor, ck, cn, n, curadas;
  if (!nq || !Array.isArray(cat)) { return out; }
  // so o grupo digitado (vestido, calcas...): as buscas mais comuns da lista da Talgui (mistura de comprimento, tecido, modelo), nao so cores
  curadas = typeof tgSugestoesDoGrupo === 'function' ? tgSugestoesDoGrupo(consulta) : null;
  if (curadas) {
    for (i = 0; i < curadas.length && out.length < TG_AC_TERMOS_MAX; i++) { out.push({ texto: tgAcSemRepetir(curadas[i]) }); }
    return out;
  }
  toks = nq.split(' ');
  ult = toks.pop();
  ant = toks;
  base = ant.length ? ant.join(' ') + ' ' : '';
  if (ult.length < 2) { return out; }
  function achar(nome, token) { var q; for (q = 0; q < nome.length; q++) { if (nome[q].indexOf(token) === 0) { return true; } } return false; }
  for (i = 0; i < cat.length; i++) {
    it = cat[i];
    if (!it || typeof it.n !== 'string') { continue; }
    ws = it.n.split(/\s+/);
    nws = [];
    for (j = 0; j < ws.length; j++) { nws.push(normalizeText(ws[j])); }
    antOk = true;
    for (k = 0; k < ant.length; k++) { if (!achar(nws, ant[k])) { antOk = false; break; } }
    if (!antOk) { continue; }
    for (j = 0; j < nws.length; j++) {
      nw = nws[j];
      if (nw.length < 3 || TG_AC_PARADAS[nw] === 1 || nw.indexOf(ult) !== 0) { continue; }
      if (nw === ult) {
        exato = true;
        cor = tgAcCorDoItem(it);
        ck = normalizeText(cor);
        if (ck && ck !== ult) {
          if (!Object.prototype.hasOwnProperty.call(cores, ck)) { cores[ck] = { o: cor, c: 0 }; coresLista.push(ck); }
          cores[ck].c++;
        }
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(comp, nw)) { comp[nw] = { n: nw, o: ws[j].toLowerCase().replace(/[^a-zà-ú0-9]/g, ''), c: 0 }; compLista.push(nw); }
      comp[nw].c++;
    }
  }
  compLista.sort(function (a, b) { return (comp[b].c - comp[a].c) || (a.length - b.length); });
  coresLista.sort(function (a, b) { return cores[b].c - cores[a].c; });
  function juntar(texto) {
    var chave = normalizeText(texto);
    if (!chave || chave === nq || vistos[chave] || out.length >= TG_AC_TERMOS_MAX) { return; }
    vistos[chave] = true;
    out.push({ texto: texto });
  }
  n = exato ? 3 : TG_AC_TERMOS_MAX;
  for (i = 0; i < compLista.length && i < n; i++) { juntar(base + comp[compLista[i]].o); }
  for (i = 0; i < coresLista.length; i++) { juntar(tgAcSemRepetir(base + ult + ' ' + cores[coresLista[i]].o)); }
  return out;
}
// QA 1.3 (25/11): tira a palavra repetida em sequencia ("vestido azul azul claro" -> "vestido azul claro"), comparando sem acento
function tgAcSemRepetir(texto) {
  var ws = String(texto || '').split(/\s+/), out = [], i;
  for (i = 0; i < ws.length; i++) { if (!ws[i]) { continue; } if (out.length && normalizeText(out[out.length - 1]) === normalizeText(ws[i])) { continue; } out.push(ws[i]); }
  return out.join(' ');
}

// Bloco "Sugestoes": cada termo e um link para a busca; o botao ao lado copia o termo para o campo (sem buscar).
function tgAcTermosBloco(termos, consulta, input, pegarCaixa) {
  var lis = [], nq = normalizeText(consulta).length, i, t, a, texto;
  function ligar(a2, tx, pos) {
    a2.addEventListener('click', function () {
      tgRecSalvar(tx);
      try { emitir('tg_busca_termo_click', { position: pos, query_len: consulta.length }); } catch (e) {}
    });
  }
  for (i = 0; i < termos.length; i++) {
    t = termos[i].texto;
    texto = el('span', { 'class': 'tg-busca-termo-texto' }, [el('strong', null, [t.slice(0, nq)]), t.slice(nq)]);
    a = el('a', { 'class': 'tg-busca-termo', href: urlBusca(t) }, [el('span', { 'class': 'tg-busca-ico-lupa', 'aria-hidden': 'true' }), texto]);
    ligar(a, t, i + 1);
    lis.push(el('li', null, [a]));
  }
  return el('div', { 'class': 'tg-busca-termos-bloco' }, [el('div', { 'class': 'tg-busca-secao-titulo' }, ['Sugestões']), el('ul', { 'class': 'tg-busca-termos' }, lis)]);
}

// ---------------------------------------------------------------- pecas
// Selo da peca (um so, a precedencia esta no motor: Melhores Ofertas > Best Seller > Ultimas Pecas). "info" vem de res.selos
// (calculado pelo motor para o resultado daquela busca). false = o motor decidiu que a peca nao tem selo (Best Seller agora e so das mais
// vendidas do resultado, nao de toda peca t = 1); sem informacao nenhuma (null/undefined), cai no selo pelo tier t, como antes.
function tgAcSelo(p, info) {
  if (info === false) { return null; }
  if (!info) { info = p.t === 1 ? { tipo: 'best', texto: TG_SELO_BEST } : (p.t === 4 ? { tipo: 'ultimas', texto: TG_SELO_ULTIMAS } : null); }
  if (!info) { return null; }
  // oferta (v12, Danilo 24/11): so "Melhores Ofertas" (o nome da categoria cortava no celular) e o mesmo desenho do Mais Vendidos
  if (info.tipo === 'oferta') { info = { tipo: 'best', texto: 'Melhores Ofertas' }; }
  // a classe -campeao segue como estava (so o texto virou Best Seller)
  return el('span', { 'class': 'tg-busca-selo tg-busca-selo-' + (info.tipo === 'oferta' ? 'oferta' : (info.tipo === 'best' ? 'campeao' : (info.tipo === 'esgotado' ? 'esgotado' : 'ultimas'))) }, [info.texto]);
}

// Uma peca da lista do overlay (card enxuto: foto, nome, preco, selo, tamanhos). Devolve null se o item nao tem link ou preco validos (nao aparece).
// "extra" (opcional): { curada: true } marca a busca curada na telemetria (rescue_type = 'curada'); { esgotado: true } marca o esgotado nominal
// (rescue_type = 'esgotado'; a peca sem tamanho em estoque ganha a classe tg-busca-item-esgotado); { tamanhos: [...] } destaca a pilula do tamanho pedido.
function tgAcLinha(p, posicao, consulta, corrigiu, info, extra) {
  var href = urlProduto(p.s), preco = blocoPreco(p), selo, a, curada = !!(extra && extra.curada), esgotado = !!(extra && extra.esgotado), soldout = esgotado && !tgDisponivel(p);
  if (!href || !preco) { return null; }
  selo = tgAcSelo(p, info);
  a = el('a', { 'class': soldout ? 'tg-busca-item tg-busca-item-esgotado' : 'tg-busca-item', href: href }, [
    foto(p, 'tg-busca-thumb'),
    el('div', { 'class': 'tg-busca-info' }, [
      el('div', { 'class': 'tg-busca-nome' }, [p.n]),
      el('div', { 'class': 'tg-busca-meta' }, [preco, selo]),
      pilulas(p.sz, 8, extra && extra.tamanhos)
    ])
  ]);
  a.addEventListener('click', function (ev2) {
    var ev = { position: posicao, query_len: consulta.length, had_correction: corrigiu ? 'sim' : 'nao', engine_version: tgCtx.versao };
    if (curada) { ev.rescue_type = 'curada'; }
    if (esgotado) { ev.rescue_type = 'esgotado'; }
    tgRecSalvar(consulta);
    try { emitir('tg_busca_sugestao_click', ev); } catch (e) {}
    // QA 3.2 (25/11): tgAcAbrirQv - a peca abre no modal, sem sair da busca (Ctrl/Cmd/Shift/botao do meio seguem para a pagina da peca)
    try {
      if (soldout || ev2.ctrlKey || ev2.metaKey || ev2.shiftKey || ev2.button > 0 || typeof tgRgAbrirQuickView !== 'function') { return; }
      ev2.preventDefault();
      tgAcAbrirQv(p, extra && extra.tamanhos, a);
    } catch (e) {}
  });
  return el('li', null, [a]);
}
// Abre o modal da peca da lista da digitacao: as outras cores vem do catalogo; o tamanho buscado ("vestido g") ja chega escolhido (QA 2).
function tgAcAbrirQv(p, tamanhos, foco) {
  var tam = null, i, j, up;
  if (Array.isArray(tamanhos) && Array.isArray(p.sz)) {
    for (i = 0; i < p.sz.length && !tam; i++) { up = String(p.sz[i]).toUpperCase(); for (j = 0; j < tamanhos.length; j++) { if (String(tamanhos[j]).toUpperCase() === up) { tam = p.sz[i]; break; } } }
  }
  obterCatalogo().then(function (cat) {
    var mapa = null, g;
    try { mapa = cat ? tgGruposCores(cat) : null; } catch (e) {}
    g = mapa ? tgGrupoDe(mapa, p) : null;
    tgRgAbrirQuickView(p, g && g.irmaos && g.irmaos.length ? g.irmaos : [p], tam, foco);
  })['catch'](function () { tgRgAbrirQuickView(p, [p], tam, foco); });
}

// Aviso da busca por tamanho ("vestido G"): diz o tamanho que esta valendo, ou que nao ha em estoque e o que se mostra no lugar.
function tgAcAviso(t) {
  var texto = t.texto || '';
  if (t.aplicado) {
    return el('div', { 'class': 'tg-busca-banner' }, ['Buscando por: ', el('strong', null, [texto || 'todas as peças']), ' no tamanho ', el('strong', null, [t.rotulo])]);
  }
  return el('div', { 'class': 'tg-busca-banner' }, ['Não temos ', el('strong', null, [texto || 'peças']), ' no tamanho ', el('strong', null, [t.rotulo]), ' em estoque agora. Mostrando as opções de outros tamanhos.']);
}

// Titulo de um bloco da busca curada ("Para as Noivas" + quantas pecas ha). So texto.
function tgBlocoTitulo(titulo, total, tag) {
  return el(tag || 'div', { 'class': 'tg-busca-bloco-titulo' }, [el('span', null, [titulo])]);
}

// Frase da peca esgotada (v14, Danilo 24/11): a esgotada vira so texto; o nome e o da 1a esgotada achada (a mais parecida com o que foi digitado).
function tgEsgFrase(e) {
  var nome = e && e.itens && e.itens[0] && typeof e.itens[0].n === 'string' ? e.itens[0].n : '';
  return el('p', { 'class': 'tg-busca-esg-frase', role: 'status' }, nome ? ['A peça “', el('strong', null, [nome]), '” está esgotada, confira outras opções abaixo:'] : ['Esta peça está esgotada, confira outras opções abaixo:']);
}

// Esgotado nominal (REL-04; v14): a frase da esgotada e, abaixo, as parecidas (mesmo tipo, grade cheia). A esgotada nao vira linha.
// Mesmos cuidados do resto: so texto, link normal para a PDP, "Ver todos" para a busca da pagina com o que foi digitado.
function tgAcPintarEsgotado(caixa, consulta, res) {
  var e = res.esgotado, extra = { esgotado: true }, n = 0, i, li, lis = [], todos, total;
  for (i = 0; i < e.similares.length; i++) {
    li = tgAcLinha(e.similares[i], n + 1, consulta, false, res.selos ? (res.selos.get(e.similares[i]) || false) : false, extra);
    if (li) { n++; lis.push(li); }
  }
  if (!n) {
    caixa.appendChild(el('div', { 'class': 'tg-busca-banner' }, ['Não encontramos resultados para "', el('strong', null, [consulta]), '".']));
    caixa.classList.remove('tg-busca-oculto');
    return;
  }
  caixa.appendChild(tgEsgFrase(e));
  caixa.appendChild(el('div', { 'class': 'tg-busca-bloco' }, [el('ul', { 'class': 'tg-busca-lista' }, lis)]));
  total = n;
  todos = el('a', { 'class': 'tg-busca-todos', href: urlBusca(consulta) }, ['Ver todos os resultados']);
  todos.addEventListener('click', function () {
    tgRecSalvar(consulta);
    try { emitir('tg_busca_ver_todos', { query_len: consulta.length, results_count: total, rescue_type: 'esgotado' }); } catch (err) {}
  });
  caixa.appendChild(todos);
  caixa.classList.remove('tg-busca-oculto');
}

// "res.termos" (opcional, calculado por tgAcDesenhar): sugestoes de termo no topo, antes das pecas.
function tgAcPintar(pegarCaixa, input, consulta, res) {
  var linhas = [], blocos = [], i, b, li, lis, ul, todos, sugerido, botao, caixa = pegarCaixa(), extra, total, termoTodos, porNome, termosBloco;
  if (!caixa) { return; }
  tgAcLimpar(caixa);
  if (res.esgotado) { tgAcPintarEsgotado(caixa, consulta, res); return; }
  extra = { curada: !!res.curada, tamanhos: res.tamanho && res.tamanho.aplicado ? res.tamanho.aceitos : null };
  if (res.curada) {
    // busca curada: um bloco por titulo, na ordem do motor (as pecas ja vem na ordem de cada bloco)
    for (b = 0; b < res.curada.blocos.length; b++) {
      lis = [];
      for (i = 0; i < res.curada.blocos[b].itens.length; i++) {
        li = tgAcLinha(res.curada.blocos[b].itens[i], linhas.length + 1, consulta, false, res.selos ? (res.selos.get(res.curada.blocos[b].itens[i]) || false) : null, extra);
        if (li) { linhas.push(li); lis.push(li); }
      }
      if (lis.length) { blocos.push(el('div', { 'class': 'tg-busca-bloco' }, [tgBlocoTitulo(res.curada.blocos[b].titulo, res.curada.blocos[b].total), el('ul', { 'class': 'tg-busca-lista' }, lis)])); }
    }
  } else {
    for (i = 0; i < res.results.length; i++) {
      li = tgAcLinha(res.results[i], linhas.length + 1, consulta, !!res.suggestedTerm, res.selos ? (res.selos.get(res.results[i]) || false) : null, extra);
      if (li) { linhas.push(li); }
    }
  }
  if (!linhas.length) { tgAcPintarZero(caixa, consulta); return; }
  // busca pelo nome da peca (84% das buscas): as pecas vem antes das sugestoes, que ficam em no maximo 2
  porNome = !!res.suggestedTerm && !res.curada;
  termosBloco = res.termos && res.termos.length && !res.curada ? tgAcTermosBloco(porNome ? res.termos.slice(0, 2) : res.termos, consulta, input, pegarCaixa) : null;
  if (termosBloco && !porNome) { caixa.appendChild(termosBloco); }
  if (res.tamanho) { caixa.appendChild(tgAcAviso(res.tamanho)); }
  // so avisa quando a grafia foi corrigida de verdade, com o nome do modelo (sem a cor): nao prende a busca numa cor so.
  // O "Buscando por: Vestidos" do grupo saiu: repetia o que esta no campo.
  if (res.suggestedTerm && tgAcCorrigiu(consulta, res.suggestedTerm)) {
    sugerido = typeof tgModeloCor === 'function' ? (tgModeloCor(res.suggestedTerm).modelo || res.suggestedTerm) : res.suggestedTerm;
    botao = el('button', { type: 'button', 'class': 'tg-busca-sugerido' }, [sugerido]);
    botao.addEventListener('click', function () {
      try { input.value = sugerido; tgAcDesenhar(pegarCaixa, input, sugerido); } catch (e) {}
    });
    caixa.appendChild(el('div', { 'class': 'tg-busca-banner' }, ['Mostrando resultados para ', botao]));
  }
  if (res.curada) {
    for (i = 0; i < blocos.length; i++) { caixa.appendChild(blocos[i]); }
  } else {
    caixa.appendChild(el('div', { 'class': 'tg-busca-secao-titulo' }, ['Peças']));
    ul = el('ul', { 'class': 'tg-busca-lista' }, linhas);
    caixa.appendChild(ul);
  }
  if (termosBloco && porNome) { caixa.appendChild(termosBloco); }
  // "Ver todos": a busca da pagina nao filtra por tamanho, entao na busca por tamanho o link leva so o texto sem o tamanho ("vestido g" -> /search/?q=vestido).
  // Se so sobrou o tamanho ("tam g"), nao ha busca nativa equivalente: o botao nao aparece (a lista acima ja mostra as pecas do tamanho).
  termoTodos = res.tamanho ? (res.tamanho.texto || '') : consulta;
  total = res.curada ? res.curada.total : res.results.length;
  if (termoTodos) {
    todos = el('a', { 'class': 'tg-busca-todos', href: urlBusca(termoTodos) }, ['Ver todos os resultados']);
    todos.addEventListener('click', function () {
      var ev = { query_len: consulta.length, results_count: total };
      if (res.curada) { ev.rescue_type = 'curada'; }
      tgRecSalvar(consulta);
      try { emitir('tg_busca_ver_todos', ev); } catch (e) {}
    });
    caixa.appendChild(todos);
  }
  tgAcColunas(caixa);
  caixa.classList.remove('tg-busca-oculto');
}

// Nada encontrado no overlay (QA 4.2, 25/11): nunca uma tela vazia. A esquerda, os chips Em alta (com Conjuntos, se a lista do Recom estiver no ar);
// a direita, a mensagem e as Novidades da semana (pecas novas em estoque, nos cards da vitrine).
function tgAcPintarZero(caixa, consulta) {
  var chips = tgChipsLista('overlay'), lado = [], principal;
  tgAcLimpar(caixa);
  if (chips) { lado.push(el('div', { 'class': 'tg-busca-secao-titulo' }, ['Em alta'])); lado.push(chips); }
  principal = el('div', { 'class': 'tg-busca-ov-principal' }, [el('div', { 'class': 'tg-busca-banner' }, ['Não encontramos resultados para "', el('strong', null, [consulta]), '".'])]);
  caixa.appendChild(el('div', { 'class': 'tg-busca-ov-duas tg-busca-ov-zero' + (lado.length ? '' : ' tg-busca-ov-uma') }, [lado.length ? el('div', { 'class': 'tg-busca-ov-lado' }, lado) : null, principal]));
  if (chips) { tgAcChipConjSeHouver(chips); }
  tgAcNovidadesSemana(principal, consulta);
  caixa.classList.remove('tg-busca-oculto');
}
// QA 4.2 (25/11): chip Conjuntos tambem nos atalhos do "nao encontramos" (so com a lista do Recom no ar)
function tgAcChipConjSeHouver(ul) {
  try { if (typeof tgConjuntosBaixar === 'function') { tgConjuntosBaixar().then(function (d) { if (d) { tgTapeteChipConj(ul); } }, function () {}); } } catch (e) {}
}
// "Novidades da semana": as pecas mais novas (categoria Novidades), em estoque, nos cards grandes da vitrine (4 por linha)
var TG_AC_NOV_ZERO = 8;
function tgAcNovidadesSemana(alvo, consulta) {
  try {
    Promise.all([obterCatalogo(), tgTapeteLimite(typeof tgPgNovidades === 'function' ? tgPgNovidades() : [], [])]).then(function (r) {
      var cat = r[0], itens, mapa, cards = [], i, c, s, link;
      if (!cat || !alvo.parentNode || (tgOv && tgOv.campo && tgOv.campo.value.trim() !== consulta)) { return; }
      itens = tgNovidadesItens(cat, r[1], TG_AC_NOV_ZERO);
      if (!itens.length) { return; }
      mapa = tgGruposCores(cat);
      for (i = 0; i < itens.length; i++) { c = tgRgCard(itens[i], undefined, null, { mapa: mapa, posicao: i + 1 }); if (c) { cards.push(c); } }
      link = el('a', { 'class': 'tg-busca-tapete-todos', href: typeof TG_NOVIDADES_CATEGORIA === 'string' ? TG_NOVIDADES_CATEGORIA : '/novidades/' }, ['Ver todas as novidades']);
      link.addEventListener('click', function () { try { emitir('tg_busca_tapete_click', { reason: 'novidades-zero:todos' }); } catch (e) {} });
      s = tgTapeteSecao('Novidades da semana', cards, link, 'novidades');
      if (s) { s.classList.add('tg-busca-zero-nov'); alvo.appendChild(s); }
    }, function () {});
  } catch (e) {}
}
// As pecas das Novidades (na ordem da categoria), em estoque e com 3+ tamanhos; sem a lista das Novidades, as mais vendidas em estoque
function tgNovidadesItens(cat, handles, max) {
  var porS = {}, out = [], i, it;
  for (i = 0; i < cat.length; i++) { if (cat[i] && cat[i].s) { porS[cat[i].s] = cat[i]; } }
  handles = Array.isArray(handles) ? handles : [];
  for (i = 0; i < handles.length && out.length < max; i++) { it = porS[handles[i]]; if (it && tgDisponivel(it) && Array.isArray(it.sz) && it.sz.length >= 3) { out.push(it); } }
  for (i = 0; i < cat.length && out.length < max; i++) { it = cat[i]; if (it && out.indexOf(it) < 0 && it.t === 1 && tgDisponivel(it) && Array.isArray(it.sz) && it.sz.length >= 3) { out.push(it); } }
  return out;
}
// QA 1.4 (25/11): digitando "conjunto(s)", os pares reais do Recom entram no topo da coluna das pecas (2 por linha, como na vitrine), com "Ver todos os conjuntos"
var TG_AC_CONJ_MAX = 4;
function tgAcConjuntosDigitado(pegarCaixa, input, consulta, cat) {
  if (typeof tgEhBuscaConjuntos !== 'function' || !tgEhBuscaConjuntos(consulta) || typeof tgConjuntosLista !== 'function') { return; }
  tgConjuntosLista(cat).then(function (l) {
    var cx = pegarCaixa(), es, ps = [], j, p, s, link, alvo;
    try {
      if (!Array.isArray(l) || !l.length || !cx || input.value.trim() !== consulta || cx.querySelector('[data-secao="conjuntos"]')) { return; }
      es = tgTapeteConjuntosEscolhidos(l, [], TG_AC_CONJ_MAX);
      for (j = 0; j < es.length; j++) { p = tgTapetePar(es[j], j + 1); if (p) { ps.push(p); } }
      if (!ps.length) { return; }
      link = el('a', { 'class': 'tg-busca-tapete-todos', href: urlBusca('conjuntos') }, ['Ver todos os conjuntos']);
      link.addEventListener('click', function () { tgRecSalvar(consulta); try { emitir('tg_busca_tapete_click', { reason: 'conjuntos-digitado:todos' }); } catch (e) {} });
      s = tgTapeteSecao('Conjuntos', ps, link, 'conjuntos');
      if (!s) { return; }
      s.classList.add('tg-busca-conj-digitado');
      alvo = cx.querySelector('.tg-busca-ov-principal') || cx;
      alvo.insertBefore(s, alvo.firstChild || null);
    } catch (e) {}
  }, function () {});
}

// Desktop: as sugestoes de termo vao para a coluna da esquerda; avisos, pecas e "Ver todos" ficam na da direita. Sem sugestoes, uma coluna so.
function tgAcColunas(caixa) {
  var lado = el('div', { 'class': 'tg-busca-ov-lado' }), principal = el('div', { 'class': 'tg-busca-ov-principal' }), nos = [], i;
  for (i = 0; i < caixa.childNodes.length; i++) { nos.push(caixa.childNodes[i]); }
  for (i = 0; i < nos.length; i++) {
    if (nos[i].classList && nos[i].classList.contains('tg-busca-termos-bloco')) { lado.appendChild(nos[i]); } else { principal.appendChild(nos[i]); }
  }
  caixa.appendChild(el('div', { 'class': 'tg-busca-ov-duas' + (lado.firstChild ? '' : ' tg-busca-ov-uma') }, [lado.firstChild ? lado : null, principal]));
}

// Vitrine da busca inicial no desktop (v13, Danilo 24/11): Vestidos, Conjuntos, Blusas e Calcas, 4 pecas por grupo numa linha, em cards grandes (o
// mesmo card da pagina de resultados: foto, cores, nome, tamanhos, preco e VER PECA; so o botao abre o modal). Vestidos, Blusas e Calcas seguem a
// regra do celular (tgVitrineInicial: Novidades, cores neutras, grade cheia) com 4 por grupo; Conjuntos = 2 pares do Recom (4 cards), cada par junto,
// e o VER PECA de qualquer peca do par abre o modal com as duas. Esqueleto com a mesma altura enquanto os dados chegam; Novidades e Recom esperam no
// maximo TG_TAPETE_ESPERA (sem Novidades = mais vendidas neutras; sem Recom = sem a secao Conjuntos).
var TG_TAPETE_ESPERA = 4000;
var TG_VT_POR_GRUPO = 4;
var TG_VT_CONJUNTOS = 2;
var TG_VT_LINKS = { vestidos: 'vestido', blusas: 'blusa', calcas: 'calça' };
function tgTapeteSecao(titulo, itens, link, id) {
  if (!itens.length) { return null; }
  return el('section', { 'class': 'tg-busca-tapete-secao', 'data-secao': id }, [
    el('div', { 'class': 'tg-busca-vt-topo' }, [el('h2', { 'class': 'tg-busca-secao-titulo' }, [titulo]), link || null]),
    el('div', { 'class': 'tg-busca-vt-grade' }, itens)
  ]);
}
function tgTapeteEsqueleto() {
  var secs = [], s, k, j;
  for (s = 0; s < 2; s++) {
    k = [];
    for (j = 0; j < TG_VT_POR_GRUPO; j++) { k.push(el('div', { 'class': 'tg-busca-vt-esq', 'aria-hidden': 'true' }, [el('span', { 'class': 'tg-busca-vt-esq-foto' }), el('i'), el('i'), el('i')])); }
    secs.push(el('div', { 'class': 'tg-busca-tapete-secao' }, [el('div', { 'class': 'tg-busca-esq-titulo' }), el('div', { 'class': 'tg-busca-vt-grade' }, k)]));
  }
  return el('div', { 'class': 'tg-busca-tapete-esq', role: 'status', 'aria-label': 'Carregando peças' }, secs);
}
function tgTapeteLimite(prom, padrao) {
  return new Promise(function (ok) {
    var t = setTimeout(function () { ok(padrao); }, TG_TAPETE_ESPERA);
    Promise.resolve(prom).then(function (v) { clearTimeout(t); ok(v); }, function () { clearTimeout(t); ok(padrao); });
  });
}
// Conjuntos da vitrine: primeiro os pares com alguma peca nas Novidades, depois os demais, na ordem do Recom; cores diferentes quando der.
function tgTapeteConjuntosEscolhidos(conjs, handles, n) {
  var set = {}, nov = [], resto = [], out = [], cores = {}, i, passo, c, lista;
  for (i = 0; i < handles.length; i++) { set[handles[i]] = true; }
  for (i = 0; i < conjs.length; i++) { (set[conjs[i].cima.s] || set[conjs[i].baixo.s] ? nov : resto).push(conjs[i]); }
  lista = nov.concat(resto);
  for (passo = 0; passo < 2 && out.length < n; passo++) {
    for (i = 0; i < lista.length && out.length < n; i++) {
      c = lista[i];
      if (out.indexOf(c) >= 0 || (passo === 0 && cores[normalizeText(c.cor || '')])) { continue; }
      out.push(c); cores[normalizeText(c.cor || '')] = true;
    }
  }
  return out;
}
// O par do conjunto: as duas pecas lado a lado (ocupa 2 colunas da linha), com o nome da cor do conjunto em cima.
function tgTapetePar(c, pos) {
  var a = typeof tgRgCard === 'function' ? tgRgCard(c.cima, undefined, null, { conjunto: c, posicao: pos }) : null;
  var b = typeof tgRgCard === 'function' ? tgRgCard(c.baixo, undefined, null, { conjunto: c, posicao: pos }) : null;
  if (!a || !b) { return null; }
  return el('div', { 'class': 'tg-busca-vt-par', role: 'group', 'aria-label': 'Conjunto ' + (c.cor || '') }, [
    el('p', { 'class': 'tg-busca-vt-par-rotulo' }, ['Conjunto' + (c.cor ? ' ' + c.cor : '')]),
    el('div', { 'class': 'tg-busca-vt-par-cards' }, [a, b])
  ]);
}
// Chip Conjuntos no Em alta, antes do Novidades (so com a lista do Recom no ar).
function tgTapeteChipConj(chipsUl) {
  var a, li;
  if (!chipsUl || !chipsUl.parentNode || chipsUl.querySelector('[data-tg-chip="conjuntos"]')) { return; }
  a = el('a', { 'class': 'tg-busca-chip', href: urlBusca('conjuntos') }, ['Conjuntos']);
  a.setAttribute('data-tg-chip', 'conjuntos');
  a.addEventListener('click', function () { try { emitir('tg_busca_chip', { reason: 'conjuntos' }); } catch (e) {} });
  li = el('li', null, [a]);
  chipsUl.insertBefore(li, chipsUl.lastChild || null);
}
function tgTapetePreencher(holder, cat, chipsUl) {
  var esq, pConj;
  try {
    if (typeof tgVitrineInicial !== 'function' || !holder.parentNode) { return; }
    esq = holder.querySelector('.tg-busca-tapete-esq');
    if (!esq) { esq = tgTapeteEsqueleto(); holder.appendChild(esq); }
    pConj = typeof tgConjuntosLista === 'function' ? tgConjuntosLista(cat) : Promise.resolve([]);
    Promise.all([
      tgTapeteLimite(typeof tgPgNovidades === 'function' ? tgPgNovidades() : [], []),
      tgTapeteLimite(pConj, [])
    ]).then(function (r) {
      var handles = Array.isArray(r[0]) ? r[0] : [], conjs = Array.isArray(r[1]) ? r[1] : [], v, mapa, ordem = ['vestidos', 'conjuntos', 'blusas', 'calcas'], tit = { vestidos: 'Vestidos', conjuntos: 'Conjuntos', blusas: 'Blusas', calcas: 'Calças' }, k, i, itens, card, link, sec, escolhidos, par;
      if (!holder.parentNode) { return; }
      try {
        v = tgVitrineInicial(cat, handles, TG_VT_POR_GRUPO);
        mapa = tgGruposCores(cat);
        if (esq.parentNode) { esq.parentNode.removeChild(esq); }
        for (k = 0; k < ordem.length; k++) {
          itens = [];
          link = null;
          if (ordem[k] === 'conjuntos') {
            escolhidos = tgTapeteConjuntosEscolhidos(conjs, handles, TG_VT_CONJUNTOS);
            for (i = 0; i < escolhidos.length; i++) { par = tgTapetePar(escolhidos[i], i + 1); if (par) { itens.push(par); } }
            if (itens.length) { link = el('a', { 'class': 'tg-busca-tapete-todos', href: urlBusca('conjuntos') }, ['Ver todos os conjuntos']); }
          } else {
            for (i = 0; i < v[ordem[k]].length; i++) {
              card = tgRgCard(v[ordem[k]][i], undefined, null, { mapa: mapa, posicao: i + 1 });
              if (card) { itens.push(card); }
            }
            if (itens.length) { link = el('a', { 'class': 'tg-busca-tapete-todos', href: urlBusca(TG_VT_LINKS[ordem[k]]) + (handles.length ? '&tg_nov=1' : '') }, [handles.length ? 'Ver as novidades' : 'Ver todos']); }
          }
          if (link) { (function (s, no) { no.addEventListener('click', function () { try { emitir('tg_busca_tapete_click', { reason: s + ':todos' }); } catch (e) {} }); })(ordem[k], link); }
          sec = tgTapeteSecao(tit[ordem[k]], itens, link, ordem[k]);
          if (sec) { holder.appendChild(sec); }
        }
        if (conjs.length) { tgTapeteChipConj(chipsUl); }
        // v14: a lista do Recom chegou depois da espera: a secao e o chip entram quando ela chegar, sem mexer no resto
        else {
          Promise.resolve(pConj).then(function (l) {
            var es, ps = [], j, p, s, antes;
            try {
              if (!Array.isArray(l) || !l.length || !holder.parentNode || holder.querySelector('[data-secao="conjuntos"]')) { return; }
              es = tgTapeteConjuntosEscolhidos(l, handles, TG_VT_CONJUNTOS);
              for (j = 0; j < es.length; j++) { p = tgTapetePar(es[j], j + 1); if (p) { ps.push(p); } }
              if (!ps.length) { return; }
              s = tgTapeteSecao('Conjuntos', ps, el('a', { 'class': 'tg-busca-tapete-todos', href: urlBusca('conjuntos') }, ['Ver todos os conjuntos']), 'conjuntos');
              antes = holder.querySelector('[data-secao="blusas"]') || holder.querySelector('[data-secao="calcas"]');
              holder.insertBefore(s, antes || null);
              tgTapeteChipConj(chipsUl);
            } catch (e4) {}
          }, function () {});
        }
        emitir('tg_busca_tapete_view', { reason: handles.length ? 'novidades' : 'reserva', results_count: holder.querySelectorAll('.tg-busca-card').length });
      } catch (e2) { try { if (esq.parentNode) { esq.parentNode.removeChild(esq); } } catch (e3) {} }
    })['catch'](function () { try { if (esq.parentNode) { esq.parentNode.removeChild(esq); } } catch (e) {} });
  } catch (e) {}
}

// Campo vazio (desktop): coluna da esquerda com as buscas recentes e os chips Em alta; a direita, a vitrine.
function tgAcVazio(caixa) {
  var chips = tgChipsLista('overlay'), rec = tgRecLer(), lis = [], i, limpar, lado = [], holder;
  tgAcLimpar(caixa);
  if (rec.length) {
    limpar = el('button', { type: 'button', 'class': 'tg-busca-limpar' }, ['Limpar']);
    limpar.addEventListener('click', function () { tgRecLimpar(); tgAcVazio(caixa); });
    lado.push(el('div', { 'class': 'tg-busca-secao-titulo tg-busca-recentes-topo' }, [el('span', null, ['Buscas recentes']), limpar]));
    for (i = 0; i < rec.length && i < 5; i++) {
      lis.push(el('li', null, [el('a', { 'class': 'tg-busca-termo', href: urlBusca(rec[i]) }, [el('span', { 'class': 'tg-busca-ico-lupa', 'aria-hidden': 'true' }), el('span', { 'class': 'tg-busca-termo-texto' }, [rec[i]])])]));
    }
    lado.push(el('ul', { 'class': 'tg-busca-recentes' }, lis));
  }
  if (chips) {
    lado.push(el('div', { 'class': 'tg-busca-secao-titulo' }, ['Em alta']));
    lado.push(chips);
  }
  if (!chips && !rec.length) { lado.push(el('div', { 'class': 'tg-busca-banner' }, ['Digite o tipo da peça, o nome ou a cor.'])); }
  holder = el('div', { 'class': 'tg-busca-tapete' }, [tgTapeteEsqueleto()]);
  caixa.appendChild(el('div', { 'class': 'tg-busca-ov-duas tg-busca-ov-inicio' }, [el('div', { 'class': 'tg-busca-ov-lado' }, lado), el('div', { 'class': 'tg-busca-ov-principal' }, [holder])]));
  try { if (typeof obterCatalogo === 'function') { obterCatalogo().then(function (cat) { if (cat) { tgTapetePreencher(holder, cat, chips); } })['catch'](function () {}); } } catch (e) {}
  caixa.classList.remove('tg-busca-oculto');
}

// Texto para leitor de tela: quantas pecas apareceram (o resto da lista nao e lido a cada letra).
function tgAcStatus(texto) {
  try { if (tgOv && tgOv.status) { tgOv.status.textContent = texto; } } catch (e) {}
}

// Desenha a resposta para o que esta no campo. Com o overlay aberto, campo curto mostra o estado vazio; fora dele, esconde a caixa.
// O catalogo e baixado so na primeira interacao (L6).
// Houve correcao de grafia de verdade? Cada palavra digitada (3+ letras) precisa aparecer no nome sugerido; se alguma nao aparece, o motor corrigiu.
function tgAcCorrigiu(consulta, sugerido) {
  var q = normalizeText(consulta).split(' '), s = ' ' + normalizeText(sugerido) + ' ', i;
  for (i = 0; i < q.length; i++) { if (q[i].length >= 3 && s.indexOf(q[i]) < 0) { return true; } }
  return false;
}

function tgAcDesenhar(pegarCaixa, input, consulta) {
  var existente, caixa;
  if (consulta.length < TG_AC_MIN) {
    caixa = pegarCaixa();
    if (caixa && tgOv && caixa === tgOv.caixa) { tgAcVazio(caixa); tgAcStatus(''); return; }
    existente = document.getElementById('tg-busca-sugestoes');
    if (existente) { tgAcLimpar(existente); existente.classList.add('tg-busca-oculto'); }
    return;
  }
  // catalogo ainda chegando (o overlay abre no toque): um aviso discreto no lugar das pecas, so se a espera passar de um instante
  var pronto = false;
  setTimeout(function () {
    var cx;
    try { if (!pronto && tgOv && tgOv.aberto && input.value.trim() === consulta) { cx = pegarCaixa(); if (cx && cx === tgOv.caixa) { tgAcLimpar(cx); cx.appendChild(el('div', { 'class': 'tg-busca-banner tg-busca-carregando', role: 'status' }, ['Carregando as peças…'])); cx.classList.remove('tg-busca-oculto'); } } } catch (e) {}
  }, 150);
  obterCatalogo().then(function (cat) {
    pronto = true;
    if (!cat || input.value.trim() !== consulta) { return; }
    function desenhar(res) {
      if (!res.esgotado && !res.curada) { res.termos = tgAcTermos(consulta, cat); }
      tgAcPintar(pegarCaixa, input, consulta, res);
      tgAcStatus(res.esgotado ? 'Peça esgotada. Veja outras opções.' : 'Peças encontradas.');
      tgAcConjuntosDigitado(pegarCaixa, input, consulta, cat);
    }
    // Esgotado nominal: so quando a palavra pedida nao casa com nenhuma peca em estoque (tgPrecisaEsgotados). O catalogo de esgotados e baixado
    // uma vez, sob demanda; se falhar (ou demorar mais que o limite), a busca de sempre aparece, sem nenhum aviso.
    if (tgPrecisaEsgotados(consulta, cat)) {
      return obterEsgotados().then(function (esg) {
        if (input.value.trim() !== consulta) { return; }
        desenhar(runSearch(consulta, cat, TG_AC_LIMITE, esg));
      })['catch'](function () { if (input.value.trim() === consulta) { desenhar(runSearch(consulta, cat, TG_AC_LIMITE)); } });
    }
    desenhar(runSearch(consulta, cat, TG_AC_LIMITE));
  })['catch'](function () {
    // QA 1.2 (25/11): algo falhou ao desenhar o termo novo: a lista do termo anterior sai e fica a mensagem de nada encontrado (nunca a lista velha)
    try { var cx = pegarCaixa(); if (cx && input.value.trim() === consulta) { tgAcLimpar(cx); cx.appendChild(el('div', { 'class': 'tg-busca-banner' }, ['Não encontramos resultados para "', el('strong', null, [consulta]), '".'])); cx.classList.remove('tg-busca-oculto'); } } catch (e) {}
  });
}

// ---------------------------------------------------------------- overlay
function tgOvFocaveis() {
  var todos = tgOv.raiz.querySelectorAll('a[href],button,input'), out = [], i;
  for (i = 0; i < todos.length; i++) { if (todos[i].offsetParent !== null || todos[i] === document.activeElement) { out.push(todos[i]); } }
  return out;
}

// ---------------------------------------------------------------- teclado no overlay (QA 4.3, 25/11)
// Com o foco no campo: seta para baixo/cima anda pelas sugestoes, chips, pecas e "Ver todos" (na ordem da tela: coluna da esquerda, depois a das pecas);
// para no ultimo item e, subindo do primeiro, volta ao campo. Enter abre o item destacado (sugestao = busca; peca = modal, como o clique). Esc tira o
// destaque e, sem destaque, fecha a busca. O foco fica sempre no campo (aria-activedescendant aponta o item); o destaque e so uma classe.
var TG_OV_NAVEGAVEIS = 'a.tg-busca-termo, a.tg-busca-chip, a.tg-busca-item, button.tg-busca-ver, a.tg-busca-todos, a.tg-busca-tapete-todos';
var tgOvSeq = 0;
function tgOvItens() {
  var nos, out = [], i;
  if (!tgOv || !tgOv.caixa) { return out; }
  nos = tgOv.caixa.querySelectorAll(TG_OV_NAVEGAVEIS);
  for (i = 0; i < nos.length; i++) { if (nos[i].offsetParent !== null) { out.push(nos[i]); } }
  return out;
}
function tgOvMarcar(no) {
  var velho;
  if (!tgOv) { return; }
  velho = tgOv.caixa.querySelector('.tg-busca-tecla');
  if (velho && velho !== no) { velho.classList.remove('tg-busca-tecla'); velho.removeAttribute('aria-selected'); }
  if (!no) { tgOv.campo.removeAttribute('aria-activedescendant'); return; }
  if (!no.getAttribute('id')) { tgOvSeq++; no.setAttribute('id', 'tg-busca-op-' + tgOvSeq); }
  no.classList.add('tg-busca-tecla');
  no.setAttribute('aria-selected', 'true');
  tgOv.campo.setAttribute('aria-activedescendant', no.getAttribute('id'));
  try { no.scrollIntoView({ block: 'nearest' }); } catch (e) {}
}
// Devolve true quando a tecla foi usada aqui (quem chama cancela o padrao da tecla, no keydown).
function tgOvTecla(ev) {
  var itens, atual, pos;
  if (!tgOv || ev.altKey || ev.ctrlKey || ev.metaKey || ev.isComposing) { return false; }
  if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp' && ev.key !== 'Enter' && ev.key !== 'Escape') { return false; }
  atual = tgOv.caixa.querySelector('.tg-busca-tecla');
  if (atual && atual.offsetParent === null) { tgOvMarcar(null); atual = null; }
  if (ev.key === 'Escape') { if (!atual) { return false; } tgOvMarcar(null); return true; }
  if (ev.key === 'Enter') {
    if (!atual) { return false; } // sem destaque, o Enter envia a busca do campo (formulario)
    atual.click(); // o mesmo caminho do clique: sugestao/chip vai para a busca; peca abre o modal (tgAcAbrirQv); VER PECA abre o modal
    return true;
  }
  itens = tgOvItens();
  if (!itens.length) { return false; }
  pos = atual ? itens.indexOf(atual) : -1;
  if (ev.key === 'ArrowDown') { pos = pos < 0 ? 0 : Math.min(pos + 1, itens.length - 1); tgOvMarcar(itens[pos]); }
  else if (pos <= 0) { tgOvMarcar(null); }
  else { tgOvMarcar(itens[pos - 1]); }
  return true;
}

function tgOvMontar() {
  var raiz, painel, form, voltar, campo, limpar, enviar, corpo, caixa, status, espera = null;
  injetarEstilos();
  campo = el('input', { type: 'search', 'class': 'tg-busca-ov-campo', 'aria-label': 'Buscar peças' });
  tgAttr(campo, { name: 'q', placeholder: 'Busque pelo nome, tipo ou cor', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search', inputmode: 'search', maxlength: '200' });
  // QA 4.3: o campo controla a lista (o item destacado pelas setas vai em aria-activedescendant)
  tgAttr(campo, { role: 'combobox', 'aria-autocomplete': 'list', 'aria-controls': 'tg-busca-sugestoes', 'aria-expanded': 'true' });
  voltar = el('button', { type: 'button', 'class': 'tg-busca-ov-btn tg-busca-ov-voltar', 'aria-label': 'Fechar a busca' }, [el('span', { 'class': 'tg-busca-ico-voltar', 'aria-hidden': 'true' })]);
  limpar = el('button', { type: 'button', 'class': 'tg-busca-ov-btn tg-busca-ov-limpar tg-busca-oculto', 'aria-label': 'Limpar o campo' }, ['×']);
  enviar = el('button', { type: 'submit', 'class': 'tg-busca-ov-btn tg-busca-ov-enviar', 'aria-label': 'Buscar' }, [el('span', { 'class': 'tg-busca-ico-lupa', 'aria-hidden': 'true' })]);
  form = el('form', { 'class': 'tg-busca-ov-form', role: 'search' }, [voltar, campo, limpar, enviar]);
  tgAttr(form, { action: '/search/', method: 'get' });
  caixa = el('div', { id: 'tg-busca-sugestoes' });
  status = el('div', { 'class': 'tg-busca-sr', role: 'status', 'aria-live': 'polite' });
  corpo = el('div', { 'class': 'tg-busca-ov-corpo' }, [tgConselheira(), caixa, status]);
  painel = el('div', { 'class': 'tg-busca-ov-painel' }, [form, corpo]);
  raiz = el('div', { id: 'tg-busca-overlay', 'class': 'tg-busca-oculto', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Busca' }, [painel]);
  tgOv = { raiz: raiz, campo: campo, caixa: caixa, corpo: corpo, limpar: limpar, status: status, aberto: false, pegarCaixa: function () { return tgOv ? tgOv.caixa : null; } };

  function atualizar(ja) {
    var v = campo.value.trim();
    if (v) { limpar.classList.remove('tg-busca-oculto'); } else { limpar.classList.add('tg-busca-oculto'); }
    clearTimeout(espera);
    if (ja) { tgAcDesenhar(tgOv.pegarCaixa, campo, v); return; }
    espera = setTimeout(function () { try { tgAcDesenhar(tgOv.pegarCaixa, campo, v); } catch (e) {} }, TG_AC_ESPERA);
  }
  tgOv.atualizar = atualizar;
  // o texto tambem vai para o campo nativo do tema (sem disparar eventos): se a busca nova desistir, a nativa ja tem o que foi digitado
  campo.addEventListener('input', function () { try { tgOvMarcar(null); } catch (e) {} try { if (tgOv && tgOv.nativo) { tgOv.nativo.value = campo.value; } } catch (e) {} try { atualizar(false); } catch (e) {} });
  voltar.addEventListener('click', function () { try { tgOvFechar(); } catch (e) {} });
  limpar.addEventListener('click', function () { try { campo.value = ''; atualizar(true); campo.focus(); } catch (e) {} });
  form.addEventListener('submit', function (ev) {
    var v = campo.value.trim();
    if (!v) { try { ev.preventDefault(); } catch (e) {} return; }
    tgRecSalvar(v);
  });
  raiz.addEventListener('click', function (ev) { if (ev.target === raiz) { try { tgOvFechar(); } catch (e) {} } });
  raiz.addEventListener('keydown', function (ev) {
    var f, ini, fim;
    try {
      // QA 4.3 (25/11): setas, Enter e Esc no campo andam pelas sugestoes e pecas (keydown; ver tgOvTecla)
      if (document.activeElement === campo && tgOvTecla(ev)) { ev.preventDefault(); return; }
      if (ev.key === 'Escape') { tgOvFechar(); return; }
      if (ev.key !== 'Tab') { return; }
      f = tgOvFocaveis();
      if (!f.length) { return; }
      ini = f[0]; fim = f[f.length - 1];
      if (ev.shiftKey && document.activeElement === ini) { fim.focus(); ev.preventDefault(); }
      else if (!ev.shiftKey && document.activeElement === fim) { ini.focus(); ev.preventDefault(); }
    } catch (e) {}
  });
  document.body.appendChild(raiz);
  return tgOv;
}

// Abre o overlay (monta na primeira vez). "valor" (opcional): texto que ja estava no campo nativo do tema.
function tgOvAbrir(valor, nativo) {
  var ja;
  if (!tgOv) { tgOvMontar(); }
  if (nativo) { tgOv.nativo = nativo; }
  ja = tgOv.aberto;
  tgOv.aberto = true;
  tgOv.raiz.classList.remove('tg-busca-oculto');
  tgOv.raiz.classList.add('tg-busca-aberto');
  document.documentElement.classList.add('tg-busca-trava');
  if (typeof valor === 'string' && (!ja || tgOv.campo.value !== valor)) { tgOv.campo.value = valor; }
  tgOv.atualizar(true);
  try { tgOv.campo.focus(); } catch (e) {}
}

// Sem catalogo: o overlay sai sem fechar o modal nativo (a busca nativa assume na hora, com o foco no campo dela).
function tgOvDesistir(nativo) {
  var st, estava;
  tgAcDesistiu = true;
  if (!tgOv) { return; }
  estava = tgOv.aberto;
  // sem rastro (falha fechada): o overlay sai do DOM e, se nada mais da busca nova esta na pagina, os estilos tambem
  try { if (nativo && tgOv.campo.value && !nativo.value) { nativo.value = tgOv.campo.value; } } catch (e) {}
  try { if (tgOv.raiz.parentNode) { tgOv.raiz.parentNode.removeChild(tgOv.raiz); } } catch (e) {}
  tgOv = null;
  document.documentElement.classList.remove('tg-busca-trava');
  try { if (!document.querySelector('#tg-busca-resultados, #tg-busca-resgate, #tg-busca-curada')) { st = document.getElementById('tg-busca-estilos'); if (st && st.parentNode) { st.parentNode.removeChild(st); } } } catch (e) {}
  try { if (estava && nativo && nativo.focus) { nativo.focus(); } } catch (e) {}
}

function tgOvFechar() {
  var nav, fechar;
  if (!tgOv || !tgOv.aberto) { return; }
  tgOv.aberto = false;
  tgOv.raiz.classList.add('tg-busca-oculto');
  tgOv.raiz.classList.remove('tg-busca-aberto');
  document.documentElement.classList.remove('tg-busca-trava');
  try { tgOv.campo.blur(); } catch (e) {}
  // o modal nativo do tema ficou aberto por baixo: fecha com o proprio botao dele (clique normal, nada e cancelado)
  try {
    nav = document.getElementById('nav-search');
    fechar = nav ? nav.querySelector('.js-modal-close') : null;
    if (fechar && window.getComputedStyle(nav).display !== 'none') { fechar.click(); }
  } catch (e) {}
}

// A busca nova desistiu depois de a lupa ter sido clicada: a lupa passa a abrir a busca nativa, e ela abre agora (se ainda nao estiver aberta).
var tgLupaNativa = false;
function tgAbrirNativa() {
  var nav, b;
  try {
    tgLupaNativa = true;
    nav = document.getElementById('nav-search');
    if (nav && nav.classList.contains('modal-show')) { return; }
    b = document.querySelector('.js-search-button');
    if (b) { b.click(); }
  } catch (e) {}
}

function ligarAutocomplete() {
  var inputs = document.querySelectorAll('.js-search-input'), tocou = false, botoes, i;
  if (!inputs || !inputs.length) { return; }
  function primeira() { if (!tocou) { tocou = true; obterCatalogo(); } }
  // v12 (Danilo, 24/11): o overlay abre NO TOQUE, sem esperar o catalogo (antes, no 4G, a busca nativa ficava segundos na tela). O que depende do
  // catalogo (vitrine, pecas) chega depois, com esqueleto. Sem catalogo (falha ou tempo esgotado), o overlay sai e a busca nativa assume, com o foco no campo dela.
  function abrir(nativo) {
    if (tgAcDesistiu) { return; }
    tgPend(true);
    try { tgOvAbrir(nativo.value, nativo); } catch (e) {}
    obterCatalogo().then(function (cat) {
      tgPend(false);
      if (!cat) { tgOvDesistir(nativo); tgAbrirNativa(); }
    })['catch'](function () { tgPend(false); tgOvDesistir(nativo); tgAbrirNativa(); });
  }
  function ligar(nativo) {
    nativo.addEventListener('focus', function () {
      try {
        primeira();
        if (tgOv && tgOv.aberto) { tgOv.campo.focus(); return; } // o tema devolveu o foco ao campo nativo: o foco volta para o overlay
        abrir(nativo);
      } catch (e) {}
    });
    nativo.addEventListener('input', function () {
      try {
        primeira();
        if (tgOv && tgOv.aberto) { tgOv.campo.value = nativo.value; tgOv.atualizar(false); return; }
        abrir(nativo);
      } catch (e) {}
    });
  }
  for (i = 0; i < inputs.length; i++) { ligar(inputs[i]); }
  // a cliente tocou na lupa antes de a busca nova chegar: o modal nativo ja esta aberto, entao a nossa abre por cima dele agora
  try {
    (function () {
      var nav = document.getElementById('nav-search'), campo = nav ? nav.querySelector('.js-search-input') : null;
      var cs = campo ? window.getComputedStyle(nav) : null, r = campo ? nav.getBoundingClientRect() : null;
      if (campo && nav.classList.contains('modal-show') && cs.display !== 'none' && cs.visibility !== 'hidden' && r.height > 0 && r.bottom > 0 && r.top < (window.innerHeight || 0)) { primeira(); abrir(campo); }
    })();
  } catch (e) {}
  // QA 6.1 (25/11): com a busca nova ligada, a lupa do topo abre SO o nosso overlay: o clique nao chega ao tema (o #nav-search e as classes de
  // bloqueio do body nao entram por tras da nossa busca). O tema abre a nativa no touchend e no click da .js-search-button: os dois sao interceptados
  // (o primeiro abre a nossa; o que vem logo depois so e engolido). Se a busca nova desistir (catalogo fora), a lupa volta a abrir a nativa (tgLupaNativa).
  var tgLupaUltimo = 0;
  function tgLupaToque(ev) {
    var b, campo;
    try {
      b = ev.target && ev.target.closest ? ev.target.closest('.js-search-button') : null;
      if (!b || tgAcDesistiu || tgLupaNativa) { return; }
      campo = document.querySelector('#nav-search .js-search-input') || inputs[0];
      if (!campo) { return; }
      ev.preventDefault(); ev.stopPropagation(); if (ev.stopImmediatePropagation) { ev.stopImmediatePropagation(); }
      if (Date.now() - tgLupaUltimo < 700) { return; }
      tgLupaUltimo = Date.now();
      primeira();
      if (tgOv && tgOv.aberto) { tgOv.campo.focus(); return; }
      abrir(campo);
    } catch (e) {}
  }
  document.addEventListener('touchend', tgLupaToque, true);
  document.addEventListener('click', tgLupaToque, true);
  botoes = document.querySelectorAll('.js-search-button');
  for (i = 0; i < botoes.length; i++) {
    // pointerdown vem antes do click: o pedido do catalogo (L21) sai um pouco mais cedo, sem passar a pedir nada sem interacao (L6)
    botoes[i].addEventListener('pointerdown', function () { try { if (tgAcDesistiu) { return; } primeira(); injetarEstilos(); tgPend(true); setTimeout(function () { tgPend(false); }, 5000); } catch (e) {} }, { passive: true });
    botoes[i].addEventListener('click', function () { try { primeira(); } catch (e) {} });
  }
}

/* ---- src/injetor/desktop/resgate.js ---- */
/*
 * Pagina /search/?q=... (redesign 18/11/2026). Origem: initSearchPageRescue do protótipo, reescrito sem HTML cru
 * (o ponto 10 da pesquisa, o termo da URL no titulo, era XSS refletido por link). O termo da URL entra so como texto.
 *
 * Tres telas, todas com o contêiner reservado #tg-busca-conselheira (vazio, escondido) para o bloco da IA:
 *   1. RESULTADOS (tgPgMontar): barra no topo (contagem, Ordenar, Tamanho, alternar grade 1/2 colunas, chips Em alta) e grade de cards.
 *      A lista nativa so some DEPOIS que a nossa foi montada (falha em qualquer ponto = a nativa continua na tela). Interruptor: features.resultados === false
 *      (no contexto do carregador) volta ao comportamento antigo (so resgate quando nao ha resultado nativo).
 *   2. SEM RESULTADO (tgRgMontar): editar a busca, termos proximos, chips Em alta, pecas populares.
 *   3. ESGOTADO NOMINAL e BUSCA CURADA: como antes, com os cards novos.
 * Card (tgRgCard): foto, selo unico, bolinhas de cor dos irmaos (abrem o quick view), nome, preco, tamanhos em estoque clicaveis e botao
 * "Adicionar" (so com tamanho escolhido). Os pacotes M (tgAgruparCores, tgOrdenar, tgFiltrar, TG_CHIPS_EM_ALTA) e Q (tgQuickViewAbrir,
 * tgQuickViewPrefetch, tgVariantesDoProduto, tgAdicionarSacola) sao chamados de forma defensiva (typeof ... === 'function').
 *
 * DESKTOP (v13, Danilo 24/11): mesma logica da v12 do celular (card VER PECA, Novidades exclusivo, Conjuntos, microchips, barra grudada, titulos)
 * com a barra propria do desktop: filtros aplicados a esquerda; grade 2/3/4, Filtrar (Preco, Tamanhos, Cores) e Ordenar (Mais Vendidos,
 * Lancamentos, Melhores Ofertas, chips circulares com icone) a direita. Filtrar e Ordenar abrem ao passar o mouse (e no clique), num painel
 * com ~70% da largura e da altura, deixando a vitrine a vista.
 */
var TG_RG_LIMITE = 4;
var TG_RG_ESG_LIMITE = 12; // esgotado nominal (v14): a esgotada vira frase; ate 12 parecidas do mesmo tipo
var TG_PG_LIMITE = 1000;  // a pagina de resultados recebe a lista inteira; os cards entram em lotes
var TG_PG_LOTE = 24;
var TG_PG_ESCONDE_NATIVO = true;
var TG_PG_BEST_MAX = 8;   // Best Sellers por categoria: quantas pecas em cada "Mais Vendidos em ..."
var TG_PG_BOLINHAS_MAX = 6;
var TG_PG_ORDENS = [['relevancia', 'Relevância'], ['melhores-ofertas', 'Melhores Ofertas'], ['lancamentos', 'Lançamentos'], ['best-sellers', 'Mais Vendidos']];
// Ordenar no desktop (Danilo, 24/11): so estas tres, em chips circulares com icone (clicar de novo na escolhida volta a ordem da busca)
var TG_PG_ORDENS_DESK = [['best-sellers', 'Mais Vendidos', 'best'], ['lancamentos', 'Lançamentos', 'novo'], ['melhores-ofertas', 'Melhores Ofertas', 'oferta']];
var TG_PG_COLUNAS = [2, 3, 4];
var TG_PG_FECHA_MS = 260; // o painel de Filtrar/Ordenar espera um instante antes de fechar quando o mouse sai (atravessar o vao nao fecha)
var TG_PG_TAM_ORDEM = ['XPP', 'PP', 'P', 'M', 'G', 'GG', 'XG', 'XGG', 'U'];
var tgCorConhecidas = null;

// Troca o texto de um no (sem textContent, que o DOM falso dos testes nao aceita gravar).
function tgTexto(no, texto) {
  while (no.firstChild) { no.removeChild(no.firstChild); }
  no.appendChild(document.createTextNode(String(texto)));
}

// ---------------------------------------------------------------- cores e agrupamento (pacote M)
// Slug da cor para o atributo data-cor (a cor da bolinha vem do CSS, sem style). Nome fora da tabela de tons vira "outro".
function tgCorSlug(cor) {
  var s = String(cor == null ? '' : cor), i, j;
  s = (typeof normalizeText === 'function' ? normalizeText(s) : s.toLowerCase()).replace(/ /g, '-');
  if (!/^[a-z0-9-]{1,30}$/.test(s)) { return 'outro'; }
  if (typeof TG_COR_TONS !== 'undefined') {
    if (!tgCorConhecidas) {
      tgCorConhecidas = {};
      for (i = 0; i < TG_COR_TONS.length; i++) { for (j = 0; j < TG_COR_TONS[i][0].length; j++) { tgCorConhecidas[TG_COR_TONS[i][0][j]] = 1; } }
    }
    if (tgCorConhecidas[s] !== 1) { return 'outro'; }
  }
  return s;
}

// Mapa id -> { modelo, cor, irmaos } do motor (agrupa so pelo modelo: 75 modelos aparecem em mais de uma categoria). null se o motor nao tem a funcao.
function tgGruposCores(lista) {
  try { if (typeof tgAgruparCores === 'function') { return tgAgruparCores(lista, { ignorarCategoria: true }) || null; } } catch (e) {}
  return null;
}
function tgGrupoDe(mapa, item) {
  if (!mapa || !item || item.id == null) { return null; }
  try { return (typeof mapa.get === 'function' ? mapa.get(item.id) : mapa[item.id]) || null; } catch (e) { return null; }
}

// ---------------------------------------------------------------- sacola e quick view (pacote Q)
// Adiciona 1 unidade do tamanho escolhido. Sempre devolve uma promessa { ok } (nunca rejeita). Sem o pacote Q, ok = false e o card cai no link da peca.
function tgRgAdicionar(item, rotulo) {
  var alvo = String(rotulo).trim().toUpperCase();
  try {
    if (typeof tgVariantesDoProduto !== 'function' || typeof tgAdicionarSacola !== 'function') { return Promise.resolve({ ok: false }); }
    return Promise.resolve(tgVariantesDoProduto(item)).then(function (v) {
      var i, t;
      if (!v || !v.ok || !Array.isArray(v.tamanhos)) { return { ok: false }; }
      for (i = 0; i < v.tamanhos.length; i++) {
        t = v.tamanhos[i];
        if (t && String(t.rotulo).trim().toUpperCase() === alvo) {
          if (!t.disponivel || !t.variantId) { return { ok: false, semTamanho: true }; }
          return Promise.resolve(tgAdicionarSacola(t.variantId, 1, { abrirSacola: false })).then(function (r) { return { ok: !!(r && r.ok) }; });
        }
      }
      return { ok: false, semTamanho: true };
    })['catch'](function () { return { ok: false }; });
  } catch (e) { return Promise.resolve({ ok: false }); }
}

function tgRgPrefetch(item) { try { if (typeof tgQuickViewPrefetch === 'function') { tgQuickViewPrefetch(item); } } catch (e) {} }

// Abre o quick view da cor clicada; sem o pacote Q (ou se ele falhar) leva para a pagina da peca.
function tgRgAbrirQuickView(item, irmaos, tamanho, foco) {
  var href;
  try {
    if (typeof tgQuickViewAbrir === 'function') {
      tgQuickViewAbrir(item, { irmaos: irmaos, tamanhoInicial: tamanho || null, aoFechar: function () { try { if (foco && foco.focus) { foco.focus(); } } catch (e) {} }, origem: 'busca' });
      return;
    }
  } catch (e) {}
  href = urlProduto(item.s);
  if (href) { try { window.location.assign(href); } catch (e2) {} }
}

// ---------------------------------------------------------------- card
// Bolinhas de cor dos irmaos do modelo (v12, Danilo 24/11): so informacao visual, sem clique (a escolha de cor e tamanho fica no modal).
// Menos de 2 cores, ou sem o agrupamento do motor = sem bolinhas.
function tgRgCores(p, op) {
  var g = tgGrupoDe(op && op.mapa, p), lista = [], bolas = [], nomes = [], i, ir, gi, cor, atual;
  if (!g || !Array.isArray(g.irmaos)) { return null; }
  atual = typeof normalizeText === 'function' ? normalizeText(g.cor || '') : '';
  for (i = 0; i < g.irmaos.length; i++) {
    ir = g.irmaos[i];
    gi = tgGrupoDe(op.mapa, ir);
    cor = gi && typeof gi.cor === 'string' ? gi.cor : '';
    if (ir && urlProduto(ir.s) && cor) { lista.push({ item: ir, cor: cor }); }
  }
  if (lista.length < 2) { return null; }
  for (i = 0; i < lista.length && i < TG_PG_BOLINHAS_MAX; i++) {
    bolas.push(el('span', { 'class': 'tg-busca-bolinha' + (lista[i].item === p || (atual && normalizeText(lista[i].cor) === atual) ? ' tg-busca-bolinha-atual' : '') + (tgDisponivel(lista[i].item) ? '' : ' tg-busca-bolinha-esgotada'), 'data-cor': tgCorSlug(lista[i].cor), 'aria-hidden': 'true' }));
    nomes.push(lista[i].cor);
  }
  if (lista.length > TG_PG_BOLINHAS_MAX) { bolas.push(el('span', { 'class': 'tg-busca-bolinha-mais', 'aria-hidden': 'true' }, ['+' + (lista.length - TG_PG_BOLINHAS_MAX)])); }
  return el('div', { 'class': 'tg-busca-cores', role: 'img', 'aria-label': 'Cores: ' + nomes.join(', ') + (lista.length > TG_PG_BOLINHAS_MAX ? ' e mais ' + (lista.length - TG_PG_BOLINHAS_MAX) : '') }, bolas);
}

// Peca de conjunto: so a cor do par (uma bolinha e o nome da cor).
function tgRgCorDoPar(p) {
  var mc = typeof tgModeloCor === 'function' ? tgModeloCor(p.n) : null;
  if (!mc || !mc.cor) { return null; }
  return el('div', { 'class': 'tg-busca-cores' }, [el('span', { 'class': 'tg-busca-bolinha tg-busca-bolinha-atual', 'data-cor': tgCorSlug(mc.cor), 'aria-hidden': 'true' }), el('span', { 'class': 'tg-busca-cor-nome' }, [mc.cor])]);
}

// Tamanhos em estoque (so informacao, sem clique) e o botao VER PECA, o unico que abre o modal (v12, Danilo 24/11).
// Na busca por tamanho ("vestido G") o tamanho pedido vem marcado e ja chega escolhido no modal.
function tgRgVer(p, op) {
  var tams = [], i, v, ver, pedido = null, destaque = {}, k, irmaos;
  if (Array.isArray(op && op.destaque)) { for (k = 0; k < op.destaque.length; k++) { if (typeof op.destaque[k] === 'string') { destaque[op.destaque[k].toUpperCase()] = true; } } }
  if (tgDisponivel(p) && Array.isArray(p.sz)) {
    for (i = 0; i < p.sz.length && i < 12; i++) {
      v = p.sz[i];
      if (typeof v !== 'string' || !v) { continue; }
      if (destaque[v.toUpperCase()] && !pedido) { pedido = v; }
      tams.push(el('span', { 'class': 'tg-busca-tam' + (destaque[v.toUpperCase()] ? ' tg-busca-tam-pedido' : '') }, [v]));
    }
  }
  irmaos = (tgGrupoDe(op && op.mapa, p) || {}).irmaos || [p];
  ver = el('button', { type: 'button', 'class': 'tg-busca-add tg-busca-ver', 'aria-label': 'Ver peça: ' + p.n }, ['Ver peça']);
  ver.addEventListener('click', function () {
    // peca de conjunto (vitrine do desktop): o modal abre com as duas pecas do par
    if (op && op.conjunto && typeof tgQuickViewConjunto === 'function') {
      try { tgQuickViewConjunto(op.conjunto, { aoFechar: function () { try { ver.focus(); } catch (e3) {} }, origem: 'conjuntos' }); emitir('tg_busca_tapete_click', { position: op.posicao || 0, reason: 'conjuntos' }); } catch (e) {}
      return;
    }
    try { tgRgAbrirQuickView(p, irmaos, pedido, ver); } catch (e) {}
    try { emitir('tg_busca_ver_peca', { position: (op && op.posicao) || 0 }); } catch (e2) {}
  });
  ver.addEventListener('pointerdown', function () { tgRgPrefetch(p); });
  return { tams: tams.length ? el('div', { 'class': 'tg-busca-tams', role: 'img', 'aria-label': 'Tamanhos em estoque: ' + p.sz.join(', ') }, tams) : el('div', { 'class': 'tg-busca-tams tg-busca-tams-vazio', 'aria-hidden': 'true' }), ver: ver };
}

// Card da peca. "info" (opcional): o selo do motor (false = sem selo; undefined = nao mostra selo nenhum). "tamanhos" (opcional): tamanho pedido na busca.
// "op" (opcional): { mapa (tgAgruparCores), posicao, esgotada: true (card simples, sem tamanhos nem botao) }.
// Estrutura fixa (foto, cores, nome em 2 linhas, tamanhos, preco, VER PECA): cards de nome curto e longo ficam alinhados na mesma linha da grade.
function tgRgCard(p, info, tamanhos, op) {
  var href = urlProduto(p.s), preco = blocoPreco(p), selo, imagem, esgotada, card, filhos, cores, ver, i, pf, pp;
  if (!href || !preco) { return null; }
  op = op || {};
  esgotada = !!op.esgotada || !tgDisponivel(p);
  selo = info === undefined ? null : tgAcSelo(p, info);
  if (!selo && info !== undefined && esgotada) { selo = tgAcSelo(p, { tipo: 'esgotado', texto: typeof TG_SELO_ESGOTADO !== 'undefined' ? TG_SELO_ESGOTADO : 'Tamanho esgotado' }); }
  imagem = foto(p, 'tg-busca-thumb') || el('span', { 'class': 'tg-busca-thumb' });
  card = el('div', { 'class': esgotada && (op.esgotada || info !== undefined) ? 'tg-busca-card tg-busca-card-esgotado' : 'tg-busca-card' });
  pf = el('a', { 'class': 'tg-busca-card-link', href: href, 'aria-hidden': 'true' }, [imagem]);
  pf.setAttribute('tabindex', '-1');
  pp = el('a', { 'class': 'tg-busca-card-link tg-busca-card-preco', href: href, 'aria-hidden': 'true' }, [preco]);
  pp.setAttribute('tabindex', '-1');
  filhos = [
    el('div', { 'class': 'tg-busca-card-midia' }, [pf, selo]),
    el('a', { 'class': 'tg-busca-card-link tg-busca-card-texto', href: href }, [el('div', { 'class': 'tg-busca-nome' }, [p.n])])
  ];
  if (!op.esgotada) {
    cores = op.conjunto ? tgRgCorDoPar(p) : tgRgCores(p, op);
    // sem outras cores: o espaco das bolinhas fica reservado (o grid nao muda de altura)
    if (!cores) { cores = el('div', { 'class': 'tg-busca-cores tg-busca-cores-vazio', 'aria-hidden': 'true' }); }
    filhos.splice(1, 0, cores);
    ver = tgRgVer(p, { posicao: op.posicao, destaque: tamanhos, mapa: op.mapa, conjunto: op.conjunto });
    filhos.push(ver.tams);
    filhos.push(pp);
    filhos.push(ver.ver);
  } else { filhos.push(pp); }
  for (i = 0; i < filhos.length; i++) { if (filhos[i]) { card.appendChild(filhos[i]); } }
  card.addEventListener('pointerdown', function () { tgRgPrefetch(p); });
  return card;
}

// ---------------------------------------------------------------- busca curada (blocos), esgotado nominal e sem resultado
// v14 (Danilo, 24/11): toda tela da busca usa o nosso titulo e a nossa tipografia; somem o "Resultados da pesquisa" / "Não encontramos nada para",
// o "Exibindo resultados para:", o "Escreva de outro jeito" e o "Mostrar mais produtos" da Nuvem. lista: true tambem esconde a lista nativa.
function tgRgEsconderNativos(lista) {
  var sels = ['.js-load-more', '#js-infinite-scroll-spinner', '[data-store="page-title"]'], i, n;
  if (lista) { sels.push('.js-product-table'); }
  try {
    for (i = 0; i < sels.length; i++) { n = document.querySelector(sels[i]); if (n) { n.classList.add('tg-busca-nativo-oculto'); } }
    n = document.querySelector('.category-body h2');
    if (n && /exibindo resultados/i.test(n.textContent || '')) { n.classList.add('tg-busca-nativo-oculto'); }
    n = document.querySelectorAll('.category-body .my-4');
    for (i = 0; i < n.length; i++) { if (/escreva de outro jeito/i.test(n[i].textContent || '')) { n[i].classList.add('tg-busca-nativo-oculto'); } }
  } catch (e) {}
}
function tgRgDestino() { return document.querySelector('.category-body') || document.querySelector('main') || document.body; }

// Pagina /search de uma busca curada (wedding, casamento...): os blocos completos, cada um com titulo, no topo da area de resultados.
// Nao tira nada da pagina nativa (a lista nativa so some se TG_CURADA_ESCONDE_NATIVO for true). Devolve true se montou.
function tgCuMontar(res) {
  var secoes = [], filhos = [tgConselheira()], b, i, c, cards, item, total = 0, destaque, destino, caixa, nativo, mapa;
  destaque = res.tamanho && res.tamanho.aplicado ? res.tamanho.aceitos : null;
  mapa = tgGruposCores(res.results);
  for (b = 0; b < res.curada.blocos.length; b++) {
    cards = [];
    for (i = 0; i < res.curada.blocos[b].itens.length; i++) {
      item = res.curada.blocos[b].itens[i];
      c = tgRgCard(item, res.selos ? (res.selos.get(item) || false) : false, destaque, { mapa: mapa, posicao: total + cards.length + 1 });
      if (c) { cards.push(c); }
    }
    if (cards.length) {
      total += cards.length;
      secoes.push(el('section', { 'class': 'tg-busca-bloco', 'data-bloco': res.curada.blocos[b].id }, [
        tgBlocoTitulo(res.curada.blocos[b].titulo, cards.length, 'h2'),
        el('div', { 'class': 'tg-busca-grade' }, cards)
      ]));
    }
  }
  if (!secoes.length) { return false; }
  if (res.tamanho) { filhos.push(tgAcAviso(res.tamanho)); }
  caixa = el('div', { id: 'tg-busca-curada', 'class': 'tg-busca-curada container' }, filhos.concat(secoes));
  destino = tgRgDestino();
  if (!destino) { return false; }
  injetarEstilos();
  destino.insertBefore(caixa, destino.firstChild || null);
  if (TG_CURADA_ESCONDE_NATIVO) {
    nativo = document.querySelector('.js-product-table');
    if (nativo) { nativo.classList.add('tg-busca-nativo-oculto'); }
  }
  tgRgEsconderNativos(false);
  emitir('tg_busca_resgate_view', { rescue_type: 'curada', results_count: total });
  return true;
}

// Esgotado nominal na pagina /search (REL-04; v14, Danilo 24/11): a esgotada NAO vira card (nao ocupa o lugar de peca disponivel); vira so a frase
// "A peça “X” está esgotada, confira outras opções abaixo:" e as parecidas sobem para a primeira dobra (ate TG_ESG_SIMILARES, do mesmo tipo, grade
// cheia; regra no motor). No fim, "Mais opções de Vestidos" leva para a categoria do tipo. Devolve true se montou.
function tgRgMontarEsgotado(q, res) {
  var e = res.esgotado, cards = [], i, c, destino, caixa, mapa = tgGruposCores(e.similares), cat, mais = null;
  for (i = 0; i < e.similares.length; i++) {
    c = tgRgCard(e.similares[i], res.selos ? (res.selos.get(e.similares[i]) || false) : false, null, { mapa: mapa, posicao: cards.length + 1 });
    if (c) { cards.push(c); }
  }
  if (!cards.length) { return false; }
  cat = typeof tgCategoriaDoTipo === 'function' ? tgCategoriaDoTipo(e.tipo) : null;
  if (cat) { mais = el('a', { 'class': 'tg-busca-mais tg-busca-mais-link', href: cat.url }, ['Mais opções de ' + cat.rotulo]); }
  caixa = el('div', { id: 'tg-busca-resgate', 'class': 'tg-busca-zero tg-busca-esg container' }, [
    tgConselheira(),
    tgEsgFrase(e),
    el('div', { 'class': 'tg-busca-grade' }, cards),
    mais
  ]);
  destino = tgRgDestino();
  if (!destino) { return false; }
  injetarEstilos();
  destino.insertBefore(caixa, destino.firstChild || null);
  tgRgEsconderNativos(!!TG_PG_ESCONDE_NATIVO);
  emitir('tg_busca_resgate_view', { rescue_type: 'esgotado', results_count: cards.length });
  return true;
}

// Formulario para editar a busca (GET normal para a busca da loja; o termo da URL entra so como valor do campo).
function tgRgForm(q) {
  var campo = el('input', { type: 'search', 'class': 'tg-busca-zero-campo', 'aria-label': 'Buscar peças' }), form;
  tgAttr(campo, { name: 'q', value: q, placeholder: 'Buscar outra peça', autocomplete: 'off', maxlength: '200' });
  form = el('form', { 'class': 'tg-busca-zero-form', role: 'search' }, [campo, el('button', { type: 'submit', 'class': 'tg-busca-zero-ok' }, ['Buscar'])]);
  tgAttr(form, { action: '/search/', method: 'get' });
  campo.addEventListener('focus', function () { try { if (typeof tgOvAbrir === 'function') { campo.blur(); tgOvAbrir(campo.value); } } catch (e) {} });
  return form;
}

// Termos proximos: palavras do catalogo que comecam como o inicio do que foi digitado ("vestdo" -> vestido).
function tgRgTermosProximos(q, cat) {
  var base = typeof normalizeText === 'function' ? normalizeText(q).split(' ')[0] : '', termos, nos = [], i;
  if (!base || base.length < 3) { return null; }
  termos = tgAcTermos(base.slice(0, Math.min(4, base.length)), cat);
  for (i = 0; i < termos.length && nos.length < 5; i++) {
    nos.push(el('li', null, [el('a', { 'class': 'tg-busca-chip', href: urlBusca(termos[i].texto) }, [termos[i].texto])]));
  }
  return nos.length ? el('div', { 'class': 'tg-busca-termos-proximos' }, [el('div', { 'class': 'tg-busca-secao-titulo' }, ['Termos próximos']), el('ul', { 'class': 'tg-busca-chips' }, nos)]) : null;
}

function tgRgMontar(q, cat, esg) {
  var res, cards = [], i, c, desc, tipo, destino, caixa, filhos, chips, proximos, mapa, descTopo = null, descGrade = null;
  if (esg) {
    res = runSearch(q, cat, TG_RG_ESG_LIMITE, esg);
    if (res.esgotado && tgRgMontarEsgotado(q, res)) { return; }
  }
  res = runSearch(q, cat, TG_RG_LIMITE);
  // nada casou (termo sem sentido): as pecas populares sao as primeiras do catalogo (a ordem dele e a de vendas), em estoque
  if (!res.results.length) { res = runSearch('', cat, TG_RG_LIMITE); res.suggestedTerm = null; res.tamanho = null; }
  mapa = tgGruposCores(res.results);
  for (i = 0; i < res.results.length; i++) {
    c = tgRgCard(res.results[i], undefined, null, { mapa: mapa, posicao: cards.length + 1 });
    if (c) { cards.push(c); }
  }
  if (res.suggestedTerm) {
    tipo = 'voce_quis_dizer';
    descTopo = el('div', { 'class': 'tg-busca-zero-desc' }, ['Você quis dizer: ', el('a', { href: urlBusca(res.suggestedTerm) }, [res.suggestedTerm]), '?']);
  } else {
    tipo = 'campeoes';
    descGrade = el('div', { 'class': 'tg-busca-zero-desc' }, [res.tamanho && res.tamanho.aplicado ? 'Confira as peças no tamanho ' + res.tamanho.rotulo + ' disponíveis para envio imediato:' : 'Confira os Mais Vendidos disponíveis para envio imediato:']);
  }
  proximos = tgRgTermosProximos(q, cat);
  chips = tgChipsLista('zero');
  filhos = [tgConselheira(), el('h1', { 'class': 'tg-busca-voce tg-busca-zero-titulo' }, ['Não encontramos “' + q + '”']), descTopo, tgRgForm(q), proximos];
  if (chips) { filhos.push(el('div', { 'class': 'tg-busca-secao-titulo' }, ['Em alta'])); filhos.push(chips); }
  filhos.push(descGrade);
  var gradeZero = el('div', { 'class': 'tg-busca-grade' }, cards);
  filhos.push(gradeZero);
  caixa = el('div', { id: 'tg-busca-resgate', 'class': 'tg-busca-zero container' }, filhos);
  // QA 4.2 (25/11): chip Conjuntos no Em alta (so com a lista do Recom no ar) e, sem o "voce quis dizer", a vitrine de resgate vira "Novidades da
  // semana" (8 pecas em estoque, 2 linhas de 4) assim que a lista das Novidades chegar
  if (chips && typeof tgAcChipConjSeHouver === 'function') { tgAcChipConjSeHouver(chips); }
  if (!res.suggestedTerm && !(res.tamanho && res.tamanho.aplicado) && typeof tgPgNovidades === 'function' && typeof tgNovidadesItens === 'function') {
    tgPgNovidades().then(function (h) {
      var its = tgNovidadesItens(cat, h, 8), mp, j, cc, novos = [];
      try {
        if (!its.length || !gradeZero.parentNode) { return; }
        mp = tgGruposCores(cat);
        for (j = 0; j < its.length; j++) { cc = tgRgCard(its[j], undefined, null, { mapa: mp, posicao: j + 1 }); if (cc) { novos.push(cc); } }
        if (!novos.length) { return; }
        while (gradeZero.firstChild) { gradeZero.removeChild(gradeZero.firstChild); }
        novos.forEach(function (n) { gradeZero.appendChild(n); });
        if (descGrade) { tgTexto(descGrade, 'Novidades da semana, disponíveis para envio imediato:'); }
      } catch (e) {}
    }, function () {});
  }
  destino = tgRgDestino();
  if (!destino) { return; }
  injetarEstilos();
  destino.insertBefore(caixa, destino.firstChild || null);
  tgRgEsconderNativos(false);
  emitir('tg_busca_resgate_view', { rescue_type: tipo, results_count: cards.length });
}

// ---------------------------------------------------------------- pagina de resultados
// Categoria Novidades (v12, 24/11): as 100 pecas mais novas da categoria inteira numa so leitura (results_only + limit; o ?mpage nao pagina nesta
// loja e trazia so 16). So leitura, mesma origem. Os handles ficam na sessao por 30 min (uma leitura por visita). Falha ou demora (8 s) = lista vazia:
// Novidades e Lancamentos simplesmente nao mudam nada.
var TG_NOV_LIMITE = 100;
var TG_NOV_CHAVE = 'tg_busca_nov';
var TG_NOV_VALIDADE = 30 * 60 * 1000;
var tgPgNovidadesCache = null;
function tgPgHandlesDoHtml(txt) {
  var saida = [], vistos = {}, doc, links, i, m;
  try {
    doc = new DOMParser().parseFromString(txt, 'text/html');
    links = doc.querySelectorAll('a[href*="/produtos/"]');
    for (i = 0; i < links.length; i++) {
      m = /\/produtos\/([a-z0-9][a-z0-9-]*)\/?/.exec(links[i].getAttribute('href') || '');
      if (m && urlProduto(m[1]) && !vistos[m[1]]) { vistos[m[1]] = true; saida.push(m[1]); }
    }
  } catch (e) {}
  return saida;
}
function tgPgNovidades() {
  var base = typeof TG_NOVIDADES_CATEGORIA === 'string' ? TG_NOVIDADES_CATEGORIA : '/novidades/', guardado, agora = Date.now(), h;
  if (tgPgNovidadesCache) { return tgPgNovidadesCache; }
  try {
    guardado = JSON.parse(window.sessionStorage.getItem(TG_NOV_CHAVE) || 'null');
    if (guardado && Array.isArray(guardado.h) && typeof guardado.t === 'number' && agora >= guardado.t && agora - guardado.t < TG_NOV_VALIDADE) {
      h = guardado.h.filter(function (x) { return typeof x === 'string' && !!urlProduto(x); }).slice(0, TG_NOV_LIMITE);
      if (h.length) { tgPgNovidadesCache = Promise.resolve(h); return tgPgNovidadesCache; }
    }
  } catch (e) {}
  tgPgNovidadesCache = new Promise(function (ok) {
    var feito = false, t = setTimeout(function () { fim([]); }, 8000);
    function fim(lista) {
      if (feito) { return; }
      feito = true; clearTimeout(t);
      if (!lista.length) { tgPgNovidadesCache = null; } else { try { window.sessionStorage.setItem(TG_NOV_CHAVE, JSON.stringify({ t: Date.now(), h: lista })); } catch (e) {} }
      ok(lista);
    }
    try {
      fetch(base + '?results_only=true&limit=' + TG_NOV_LIMITE, { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.text() : ''; }).then(function (txt) { fim(txt ? tgPgHandlesDoHtml(txt).slice(0, TG_NOV_LIMITE) : []); }, function () { fim([]); });
    } catch (e) { fim([]); }
  });
  return tgPgNovidadesCache;
}

// Conjuntos do Recom (v12, 24/11): GET /api/conjuntos (o par e a cor sao do Recom; o CDN dele guarda 1 dia). So ids e cor sao aproveitados; o resto
// (nome, foto, preco, tamanhos) vem do catalogo da busca, conferido na hora (tgConjuntosDoRecom). Guardado na sessao por 1 h. Falha = sem conjuntos:
// o chip e a faixa de Conjuntos simplesmente nao aparecem.
var TG_CONJUNTOS_URL = 'https://app-partners-recomendados.vercel.app/api/conjuntos';
var TG_CONJ_CHAVE = 'tg_busca_conj';
var TG_CONJ_VALIDADE = 60 * 60 * 1000;
var tgConjCache = null;
function tgConjValidar(d) {
  var out = [], i, c, cor;
  if (!d || typeof d !== 'object' || !Array.isArray(d.conjuntos)) { return null; }
  for (i = 0; i < d.conjuntos.length && out.length < 400; i++) {
    c = d.conjuntos[i];
    if (!c || !c.top || !c.bottom) { continue; }
    if (!/^\d{1,15}$/.test(String(c.top.id)) || !/^\d{1,15}$/.test(String(c.bottom.id))) { continue; }
    cor = typeof c.color === 'string' && c.color.length <= 40 ? c.color : '';
    out.push({ color: cor, top: { id: String(c.top.id) }, bottom: { id: String(c.bottom.id) } });
  }
  return out.length ? { conjuntos: out } : null;
}
function tgConjuntosBaixar() {
  var guardado, agora = Date.now(), v;
  if (tgConjCache) { return tgConjCache; }
  try {
    guardado = JSON.parse(window.sessionStorage.getItem(TG_CONJ_CHAVE) || 'null');
    if (guardado && typeof guardado.t === 'number' && agora >= guardado.t && agora - guardado.t < TG_CONJ_VALIDADE) {
      v = tgConjValidar(guardado.d);
      if (v) { tgConjCache = Promise.resolve(v); return tgConjCache; }
    }
  } catch (e) {}
  tgConjCache = new Promise(function (ok) {
    var feito = false, t = setTimeout(function () { fim(null); }, 5000);
    function fim(d) {
      if (feito) { return; }
      feito = true; clearTimeout(t);
      if (!d) { tgConjCache = null; } else { try { window.sessionStorage.setItem(TG_CONJ_CHAVE, JSON.stringify({ t: Date.now(), d: d })); } catch (e) {} }
      ok(d);
    }
    try {
      fetch(TG_CONJUNTOS_URL, { credentials: 'omit', mode: 'cors' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) { fim(tgConjValidar(j)); }, function () { fim(null); });
    } catch (e) { fim(null); }
  });
  return tgConjCache;
}
// Conjuntos prontos para a tela (lista vazia se o Recom nao respondeu ou nada passou na conferencia de estoque).
function tgConjuntosLista(cat) {
  return tgConjuntosBaixar().then(function (d) {
    try { return d && typeof tgConjuntosDoRecom === 'function' ? tgConjuntosDoRecom(cat, d) : []; } catch (e) { return []; }
  })['catch'](function () { return []; });
}
function tgEhBuscaConjuntos(q) {
  var n = typeof normalizeText === 'function' ? normalizeText(q || '') : String(q || '').toLowerCase().trim();
  return n === 'conjunto' || n === 'conjuntos';
}

// ---------------------------------------------------------------- card horizontal (v12, padrao do modal das Influenciadoras)
// Foto a esquerda; nome, bolinhas de cor, preco, tamanhos em estoque e "Detalhes da peca" a direita. Usado na tela inicial e na pagina de Conjuntos.
// op: { mapa (tgGruposCores), conjunto (o par: tocar em qualquer parte abre o modal do conjunto), posicao, secao, aoAbrir }.
function tgHCard(p, op) {
  var href = urlProduto(p.s), pr = precoFinal(p), mc, abrir, f, nome, det, cores = null, tams = [], i, card, corUnica, g, bolas = [], lista = [], gi, ir;
  if (!href || !pr) { return null; }
  op = op || {};
  mc = typeof tgModeloCor === 'function' ? tgModeloCor(p.n) : { modelo: p.n, cor: '' };
  abrir = function (no, alvo) {
    try {
      if (typeof op.aoAbrir === 'function') { op.aoAbrir(no, alvo || p); }
      else if (op.conjunto && typeof tgQuickViewConjunto === 'function') { tgQuickViewConjunto(op.conjunto, { aoFechar: function () { try { if (no && no.focus) { no.focus(); } } catch (e) {} }, origem: op.secao || 'conjuntos' }); }
      else { tgRgAbrirQuickView(alvo || p, op.irmaos || (tgGrupoDe(op.mapa, p) || {}).irmaos || [p], null, no); }
      emitir('tg_busca_tapete_click', { position: op.posicao || 0, reason: op.secao || '' });
    } catch (e) {}
  };
  // so o botao "Detalhes da peca" abre o modal (Danilo, 24/11); foto, nome e bolinhas sao so informacao
  f = el('div', { 'class': 'tg-busca-hc-foto', 'aria-hidden': 'true' }, [foto(p, 'tg-busca-thumb') || el('span', { 'class': 'tg-busca-thumb' })]);
  nome = el('p', { 'class': 'tg-busca-hc-nome' }, [p.n]);
  det = el('button', { type: 'button', 'class': 'tg-busca-hc-det', 'aria-label': 'Ver peça: ' + p.n }, ['Ver peça']); // desktop: o mesmo nome do botao do card (Danilo, 24/11)
  [det].forEach(function (b) {
    b.addEventListener('click', function () { abrir(b); });
    b.addEventListener('pointerdown', function () { tgRgPrefetch(p); if (op.conjunto) { tgRgPrefetch(op.conjunto.cima); tgRgPrefetch(op.conjunto.baixo); } });
  });
  // cores: peca do conjunto mostra so a cor do par; peca avulsa mostra as cores do modelo (cada bolinha abre aquela cor)
  g = op.conjunto ? null : tgGrupoDe(op.mapa, p);
  if (g && Array.isArray(g.irmaos)) {
    for (i = 0; i < g.irmaos.length; i++) {
      ir = g.irmaos[i]; gi = tgGrupoDe(op.mapa, ir);
      if (ir && urlProduto(ir.s) && gi && gi.cor && tgDisponivel(ir)) { lista.push({ item: ir, cor: gi.cor }); }
    }
  }
  if (lista.length >= 2) {
    for (i = 0; i < lista.length && i < TG_PG_BOLINHAS_MAX; i++) {
      bolas.push(el('span', { 'class': 'tg-busca-bolinha' + (lista[i].item === p ? ' tg-busca-bolinha-atual' : ''), 'data-cor': tgCorSlug(lista[i].cor), 'aria-hidden': 'true' }));
    }
    if (lista.length > TG_PG_BOLINHAS_MAX) { bolas.push(el('span', { 'class': 'tg-busca-bolinha-mais', 'aria-label': 'Mais ' + (lista.length - TG_PG_BOLINHAS_MAX) + ' cores' }, ['+' + (lista.length - TG_PG_BOLINHAS_MAX)])); }
    cores = el('div', { 'class': 'tg-busca-cores tg-busca-hc-cores', role: 'img', 'aria-label': 'Cores: ' + lista.map(function (x) { return x.cor; }).join(', ') }, bolas);
  } else if (mc.cor) {
    corUnica = el('div', { 'class': 'tg-busca-cores tg-busca-hc-cores' }, [el('span', { 'class': 'tg-busca-bolinha tg-busca-bolinha-atual', 'data-cor': tgCorSlug(mc.cor), 'aria-hidden': 'true' }), el('span', { 'class': 'tg-busca-hc-cor' }, [mc.cor])]);
    cores = corUnica;
  }
  if (Array.isArray(p.sz)) { for (i = 0; i < p.sz.length && i < 10; i++) { if (typeof p.sz[i] === 'string' && p.sz[i]) { tams.push(el('span', { 'class': 'tg-busca-hc-tam' }, [p.sz[i]])); } } }
  card = el('div', { 'class': 'tg-busca-hc' + (op.conjunto ? ' tg-busca-hc-conj' : '') }, [
    f,
    el('div', { 'class': 'tg-busca-hc-inf' }, [
      nome,
      el('div', { 'class': 'tg-busca-preco tg-busca-hc-preco' }, [el('strong', null, [reais(pr.final)]), pr.de ? el('s', { 'class': 'tg-busca-de' }, [reais(pr.de)]) : null, typeof linhaPix === 'function' ? linhaPix(pr.final) : null]), // QA 3.4 (25/11)
      cores,
      tams.length ? el('div', { 'class': 'tg-busca-hc-tams', role: 'img', 'aria-label': 'Tamanhos em estoque: ' + p.sz.join(', ') }, tams) : null,
      det
    ])
  ]);
  return card;
}
// Um conjunto = as duas pecas em cards separados (Danilo, 24/11): tocar em qualquer uma abre o modal com as duas.
function tgHConjunto(c, pos, secao) {
  var a = tgHCard(c.cima, { conjunto: c, posicao: pos, secao: secao }), b = tgHCard(c.baixo, { conjunto: c, posicao: pos, secao: secao });
  if (!a || !b) { return null; }
  return el('div', { 'class': 'tg-busca-hc-par', role: 'group', 'aria-label': 'Conjunto ' + (c.cor || '') }, [a, b]);
}

// ---------------------------------------------------------------- pagina de Conjuntos (/search/?q=conjuntos)
// Os pares do Recom em cards separados, com filtro de Tamanho (as duas pecas tem o tamanho) e de Cor (a cor do par). Devolve true se montou.
var TG_CJ_LOTE = 8;
function tgCjMontar(lista) {
  var destino = tgRgDestino(), raiz, grade, mais, barra, ativos = null, tam = null, cor = null, filtro = null, menus = [], est = { tamanhos: [], cores: [], mostrados: 0, atual: lista }, voce, vazio, i, n2, opCores = [];
  if (!destino || !lista.length) { return false; }
  // v14 (Danilo, 24/11): cores alternadas na grade (nao todos os amarelos, depois todos os azuis...)
  if (typeof tgConjuntosIntercalados === 'function') { lista = tgConjuntosIntercalados(lista); est.atual = lista; }
  grade = el('div', { 'class': 'tg-busca-hc-lista' });
  mais = el('button', { type: 'button', 'class': 'tg-busca-mais tg-busca-oculto' }, ['Ver mais']);
  vazio = el('div', { 'class': 'tg-busca-vazio tg-busca-oculto', role: 'status' });
  voce = el('h1', { 'class': 'tg-busca-voce' }, ['Você está buscando por: ', el('strong', null, ['Conjuntos'])]);
  function corDo(c) { var f = typeof tgFamiliaCor === 'function' ? tgFamiliaCor(c.cima) : null; return f ? f : null; }
  (function () {
    var vistos = {}, j, f;
    for (j = 0; j < lista.length; j++) { f = corDo(lista[j]); if (f && !vistos[f.chave]) { vistos[f.chave] = true; opCores.push({ valor: f.chave, rotulo: f.rotulo }); } }
  })();
  function filtrar(tams, cores) {
    tams = tams || est.tamanhos; cores = cores || est.cores;
    return lista.filter(function (c) {
      var f;
      if (tams.length && typeof tgFiltrar === 'function' && !(tgFiltrar([c.cima], { tamanho: tams }).length && tgFiltrar([c.baixo], { tamanho: tams }).length)) { return false; }
      if (cores.length) { f = corDo(c); if (!f || cores.indexOf(f.chave) < 0) { return false; } }
      return true;
    });
  }
  // QA 5.3 (25/11): os filtros conversam. Tamanho sem conjunto nas cores escolhidas fica apagado; so aparecem as cores com conjunto nos tamanhos escolhidos.
  function opcoesTamanhoCj() {
    return tgPgOpcoesTamanho().map(function (o) { return { valor: o.valor, rotulo: o.rotulo, desligado: !filtrar([o.valor], est.cores).length }; });
  }
  function opcoesCorCj() {
    var vivos = filtrar(est.tamanhos, []);
    if (opCores.length < 2) { return []; }
    return opCores.filter(function (o) { return est.cores.indexOf(o.valor) >= 0 || vivos.some(function (c) { var f = corDo(c); return f && f.chave === o.valor; }); });
  }
  function lote() {
    var fim = Math.min(est.atual.length, est.mostrados + TG_CJ_LOTE), p, no;
    for (p = est.mostrados; p < fim; p++) { no = tgHConjunto(est.atual[p], p + 1, 'conjuntos'); if (no) { grade.appendChild(no); } }
    est.mostrados = fim;
    if (fim < est.atual.length) { mais.classList.remove('tg-busca-oculto'); } else { mais.classList.add('tg-busca-oculto'); }
  }
  function desenhar() {
    var limpar;
    while (grade.firstChild) { grade.removeChild(grade.firstChild); }
    est.atual = filtrar(); est.mostrados = 0;
    lote();
    while (vazio.firstChild) { vazio.removeChild(vazio.firstChild); }
    if (!est.atual.length) {
      limpar = el('button', { type: 'button', 'class': 'tg-busca-chip tg-busca-chip-ativo' }, ['Limpar filtros']);
      limpar.addEventListener('click', function () { est.tamanhos = []; est.cores = []; desenhar(); });
      vazio.appendChild(el('p', null, ['Nenhum conjunto com essa combinação de filtros.']));
      vazio.appendChild(limpar);
      vazio.classList.remove('tg-busca-oculto');
    } else { vazio.classList.add('tg-busca-oculto'); }
    if (filtro) { filtro.pintar(); }
    pintarAtivos();
  }
  // filtros aplicados: microchips na barra grudada + Limpar busca (mesmo padrao da pagina de resultados)
  function pintarAtivos() {
    var itens = [], lim;
    if (!ativos) { return; }
    while (ativos.firstChild) { ativos.removeChild(ativos.firstChild); }
    function micro(texto, tirar) {
      var b = el('button', { type: 'button', 'class': 'tg-busca-micro', 'aria-label': 'Tirar o filtro ' + texto }, [texto, el('span', { 'class': 'tg-busca-micro-x', 'aria-hidden': 'true' }, ['×'])]);
      b.addEventListener('click', function () { try { tirar(); desenhar(); } catch (e) {} });
      itens.push(b);
    }
    est.tamanhos.forEach(function (v) { micro('Tamanho ' + v, function () { alternar(est.tamanhos, v); }); });
    est.cores.forEach(function (v) { var r = v, k; for (k = 0; k < opCores.length; k++) { if (opCores[k].valor === v) { r = opCores[k].rotulo; } } micro(r, function () { alternar(est.cores, v); }); });
    if (!itens.length) { ativos.classList.add('tg-busca-oculto'); return; }
    lim = el('button', { type: 'button', 'class': 'tg-busca-limpar-busca' }, ['Limpar filtros']); // QA 5.2 (25/11)
    lim.addEventListener('click', function () { try { est.tamanhos = []; est.cores = []; desenhar(); } catch (e) {} });
    ativos.appendChild(el('div', { 'class': 'tg-busca-ativos-lista' }, itens));
    ativos.appendChild(lim);
    ativos.classList.remove('tg-busca-oculto');
  }
  function alternar(l, v) { var p = l.indexOf(v); if (p >= 0) { l.splice(p, 1); } else { l.push(v); } }
  mais.addEventListener('click', function () { try { lote(); } catch (e) {} });
  // desktop (v13): o mesmo Filtrar da pagina de resultados, com Tamanhos e Cores (o tamanho vale para as duas pecas do par)
  filtro = tgPgPainelFiltrar({
    tamanhos: opcoesTamanhoCj,
    tamanhosAtivos: function () { return est.tamanhos; },
    cores: opcoesCorCj,
    coresAtivas: function () { return est.cores; },
    faixa: function () { return null; },
    preco: function () { return null; },
    aoTamanho: function (v) { alternar(est.tamanhos, v); desenhar(); try { emitir('tg_busca_filtro_tamanho', { reason: est.tamanhos.join(','), page_type: 'conjuntos' }); } catch (e) {} },
    aoCor: function (v) { alternar(est.cores, v); desenhar(); try { emitir('tg_busca_filtro_cor', { reason: est.cores.join(','), page_type: 'conjuntos' }); } catch (e) {} },
    aoPreco: function () {},
    limpar: function () { est.tamanhos = []; est.cores = []; desenhar(); },
    contagem: function () { return est.tamanhos.length + est.cores.length; }
  });
  menus.push(filtro);
  ativos = el('div', { 'class': 'tg-busca-ativos tg-busca-oculto', role: 'group', 'aria-label': 'Filtros aplicados' });
  barra = el('div', { 'class': 'tg-busca-barra' }, [el('div', { 'class': 'tg-busca-barra-linha' }, [ativos, el('span', { 'class': 'tg-busca-barra-espaco' }), filtro.no]), filtro.painel]);
  filtro.ligar(barra, menus);
  document.addEventListener('click', function (ev) { var j; try { if (ev.target && ev.target.isConnected === false) { return; } for (j = 0; j < menus.length; j++) { if (!menus[j].contem(ev.target)) { menus[j].fechar(); } } } catch (e) {} });
  document.addEventListener('keydown', function (ev) { var j; try { if (ev.key === 'Escape') { for (j = 0; j < menus.length; j++) { menus[j].fechar(); } } } catch (e) {} });
  raiz = el('section', { id: 'tg-busca-resultados', 'class': 'tg-busca-pagina tg-busca-pagina-conj', 'aria-label': 'Conjuntos' }, [tgConselheira(), voce, el('p', { 'class': 'tg-busca-cj-sub' }, ['Compre o Look. Descubra os conjuntos da Talgui e adicione sua peça favorita na sacola']), barra, grade, vazio, mais]);
  injetarEstilos();
  desenhar();
  destino.insertBefore(raiz, destino.firstChild || null);
  tgPgTopoBarra(raiz);
  tgRgEsconderNativos(true);
  emitir('tg_busca_pagina_view', { results_count: lista.length, page_type: 'conjuntos' });
  return true;
}

function tgPgOrdenar(lista, modo, handles) {
  try { if (typeof tgOrdenar === 'function') { return tgOrdenar(lista, modo, handles) || lista; } } catch (e) {}
  return lista;
}
// Filtros combinados (tamanhos e cores valem em conjunto). tamanhos: ids dos grupos ("M"); cores: chaves de tgFamiliaCor.
function tgPgFiltrar(lista, tamanhos, cores) {
  var out = [], i, j, k, it, achou;
  if ((!tamanhos || !tamanhos.length) && (!cores || !cores.length)) { return lista; }
  try { if (typeof tgFiltrar === 'function') { return tgFiltrar(lista, { tamanho: tamanhos || [], cor: cores || [] }) || lista; } } catch (e) {}
  for (i = 0; i < lista.length; i++) {
    it = lista[i]; achou = !(tamanhos && tamanhos.length);
    for (j = 0; !achou && it && Array.isArray(it.sz) && j < it.sz.length; j++) { for (k = 0; k < tamanhos.length; k++) { if (String(it.sz[j]).toUpperCase() === String(tamanhos[k]).toUpperCase()) { achou = true; } } }
    if (achou) { out.push(it); }
  }
  return out;
}

// Tamanhos que existem nos resultados, na ordem natural (PP, P, M, G, GG..., depois os numeros), com quantas pecas tem cada um.
function tgPgTamanhos(lista) {
  var cont = {}, nomes = [], i, j, v, k;
  for (i = 0; i < lista.length; i++) {
    if (!lista[i] || !Array.isArray(lista[i].sz)) { continue; }
    for (j = 0; j < lista[i].sz.length; j++) {
      v = lista[i].sz[j];
      if (typeof v !== 'string' || !v) { continue; }
      k = v.toUpperCase();
      if (!Object.prototype.hasOwnProperty.call(cont, k)) { cont[k] = { rotulo: v, qtd: 0 }; nomes.push(k); }
      cont[k].qtd++;
    }
  }
  function peso(n) {
    var p = TG_PG_TAM_ORDEM.indexOf(n);
    if (p >= 0) { return p; }
    return /^\d+$/.test(n) ? 100 + parseInt(n, 10) : 1000;
  }
  nomes.sort(function (a, b) { return (peso(a) - peso(b)) || (a < b ? -1 : 1); });
  return nomes.map(function (n) { return cont[n]; });
}

// Opcoes do filtro de tamanho: sempre os 6 grupos (XPP / 34 ... GG / 44), sem quantidade.
function tgPgOpcoesTamanho() {
  var g = typeof TG_TAMANHO_GRUPOS !== 'undefined' && Array.isArray(TG_TAMANHO_GRUPOS) ? TG_TAMANHO_GRUPOS : [], o = [], i;
  for (i = 0; i < g.length; i++) { o.push({ valor: g[i].id, rotulo: g[i].rotulo }); }
  return o;
}
// Opcoes do filtro de cor: as familias de cor das pecas da lista, da mais comum para a menos comum (sem quantidade).
function tgPgOpcoesCor(lista) {
  var cont = {}, nomes = [], i, f, o = [];
  if (typeof tgFamiliaCor !== 'function') { return o; }
  for (i = 0; i < lista.length; i++) {
    f = tgFamiliaCor(lista[i]);
    if (!f || !f.chave) { continue; }
    if (!Object.prototype.hasOwnProperty.call(cont, f.chave)) { cont[f.chave] = { rotulo: f.rotulo, n: 0 }; nomes.push(f.chave); }
    cont[f.chave].n++;
  }
  nomes.sort(function (a, b) { return (cont[b].n - cont[a].n) || (a < b ? -1 : 1); });
  for (i = 0; i < nomes.length; i++) { o.push({ valor: nomes[i], rotulo: cont[nomes[i]].rotulo }); }
  return o;
}

// Menu suspenso: botao + lista. multi = varias opcoes marcadas (a lista fica aberta; aoEscolher(valor) alterna); sem multi, uma so (fecha ao escolher).
// opcoes: [{ valor, rotulo }]. atual: valor (ou lista de valores no multi). pintar(opcoesNovas, atual) redesenha.
function tgPgMenu(rotuloBotao, opcoes, atual, aoEscolher, direita, multi) {
  var wrap, botao, lista, vigente = atual, opts = opcoes;
  botao = el('button', { type: 'button', 'class': 'tg-busca-barra-btn', 'aria-haspopup': 'true', 'aria-expanded': 'false' }, [rotuloBotao]);
  lista = el('div', { 'class': 'tg-busca-menu tg-busca-oculto', role: 'menu' });
  wrap = el('div', { 'class': 'tg-busca-menu-wrap' + (direita ? ' tg-busca-menu-dir' : '') }, [botao, lista]);
  function fechar() { lista.classList.add('tg-busca-oculto'); botao.setAttribute('aria-expanded', 'false'); }
  botao.addEventListener('click', function () {
    try {
      if (botao.getAttribute('aria-expanded') !== 'true') { lista.classList.remove('tg-busca-oculto'); botao.setAttribute('aria-expanded', 'true'); } else { fechar(); }
    } catch (e) {}
  });
  function marcado(v) { return multi ? (Array.isArray(vigente) && vigente.indexOf(v) >= 0) : v === vigente; }
  function pintar(novasOpcoes, novoAtual) {
    var j;
    if (novasOpcoes) { opts = novasOpcoes; }
    if (novoAtual !== undefined) { vigente = novoAtual; }
    while (lista.firstChild) { lista.removeChild(lista.firstChild); }
    for (j = 0; j < opts.length; j++) {
      (function (o) {
        var b = el('button', { type: 'button', role: multi ? 'menuitemcheckbox' : 'menuitemradio', 'aria-checked': marcado(o.valor) ? 'true' : 'false' }, [el('span', null, [o.rotulo])]);
        b.addEventListener('click', function () {
          try { if (!multi) { fechar(); } aoEscolher(o.valor); } catch (e) {}
        });
        lista.appendChild(b);
      })(opts[j]);
    }
  }
  pintar();
  return { no: wrap, botao: botao, fechar: fechar, pintar: pintar };
}

// QA 5.1 (25/11): ids das pecas que casam de verdade com a busca (as res.fortes primeiras da lista do motor). null sem a informacao do motor.
function tgPgFortes(r) {
  var m = {}, j, n;
  if (!r || typeof r.fortes !== 'number' || r.fortes <= 0 || !Array.isArray(r.results)) { return null; }
  n = Math.min(r.fortes, r.results.length);
  for (j = 0; j < n; j++) { if (r.results[j] && r.results[j].id != null) { m[r.results[j].id] = true; } }
  return m;
}

// Monta a pagina de resultados. Devolve true se montou (so entao a lista nativa so some).
// Filtros que valem juntos: chip de categoria/ocasiao (troca a lista-base pela busca do chip), Novidades, tamanhos (varios) e cores (varias).
function tgPgMontar(q, cat, res) {
  var conjOk = false, verNov, ativos = null, filtro = null, ordP = null, itens = [], i, destino, raiz, nativo, mapa, selos = res.selos, destaque, est, grade, mais, barra, menus = [], ordem = null, tam = null, cor = null, togg, tg1, tg2, chipsLinha, filhos, aviso = null, vazio, bases = {}, voce, grupoQ = typeof tgGrupoDaBusca === 'function' ? tgGrupoDaBusca(q) : '';
  for (i = 0; i < res.results.length; i++) { if (urlProduto(res.results[i].s) && precoFinal(res.results[i])) { itens.push(res.results[i]); } }
  if (!itens.length) { return false; }
  destino = tgRgDestino();
  if (!destino) { return false; }
  destaque = res.tamanho && res.tamanho.aplicado ? res.tamanho.aceitos : null;
  mapa = tgGruposCores(itens);
  est = { ordem: 'relevancia', tamanhos: [], cores: [], base: '', grupo: '', chip: '', novidades: false, handles: null, um: false, mostrados: 0, atual: itens, preco: null, colunas: 4 };
  grade = el('div', { 'class': 'tg-busca-grade' });
  mais = el('button', { type: 'button', 'class': 'tg-busca-mais tg-busca-oculto' }, ['Ver mais']);
  verNov = el('a', { 'class': 'tg-busca-mais tg-busca-ver-nov tg-busca-oculto', href: typeof TG_NOVIDADES_CATEGORIA === 'string' ? TG_NOVIDADES_CATEGORIA : '/novidades/' }, ['Ver Novidades']);
  voce = el('h1', { 'class': 'tg-busca-voce' });
  var tamDaBusca = false;
  var contador = el('p', { 'class': 'tg-busca-contador', role: 'status', 'aria-live': 'polite' }); // QA 5.1 (25/11)
  vazio = el('div', { 'class': 'tg-busca-vazio tg-busca-oculto', role: 'status' });
  // QA 5.1: acertos de verdade da busca (res.fortes do motor: as primeiras pecas da lista casam com tudo o que foi digitado; as demais sao parecidas)
  var fortes = tgPgFortes(res);

  // QA 2 (25/11): o tamanho marcado nos cards (e que ja chega escolhido no modal) e o do filtro Tamanho; sem filtro, o da busca (se o filtro nao pegou)
  function destaqueAtual() {
    var g = typeof TG_TAMANHO_GRUPOS !== 'undefined' && Array.isArray(TG_TAMANHO_GRUPOS) ? TG_TAMANHO_GRUPOS : [], out = [], j;
    if (!est.tamanhos.length) { return destaque; }
    for (j = 0; j < g.length; j++) { if (est.tamanhos.indexOf(g[j].id) >= 0) { out = out.concat(g[j].v); } }
    return out.length ? out : est.tamanhos.slice();
  }
  // "379 peças encontradas": na busca da URL, so os acertos de verdade que passam nos filtros; em chip, grupo ou Novidades, a lista inteira
  function pintarContador() {
    var n = est.atual.length, j, k;
    if (fortes && !est.base && !est.grupo && !est.chip && !est.novidades) {
      for (j = 0, k = 0; j < est.atual.length; j++) { if (est.atual[j] && fortes[est.atual[j].id] === true) { k++; } }
      if (k) { n = k; }
    }
    tgTexto(contador, n ? (n === 1 ? '1 peça encontrada' : n + ' peças encontradas') : '');
  }

  // lista-base: a da busca da URL, ou a do chip de categoria/ocasiao escolhido
  function gAtivo() { return est.grupo || grupoQ; }
  function baseItens() {
    var r, lista, j, chave, bruta, g = gAtivo();
    if (est.chip && g && typeof tgItensDoChip === 'function') { chave = 'c:' + g + ':' + est.chip; bruta = function () { return tgItensDoChip(cat, g, est.chip); }; }
    else if (est.grupo && typeof tgItensDoGrupo === 'function') { chave = 'g:' + est.grupo; bruta = function () { return tgItensDoGrupo(cat, est.grupo); }; }
    if (chave) {
      if (bases[chave]) { return bases[chave]; }
      lista = [];
      try { r = bruta(); for (j = 0; j < r.length; j++) { if (urlProduto(r[j].s) && precoFinal(r[j])) { lista.push(r[j]); } } } catch (e) {}
      bases[chave] = lista;
      return lista;
    }
    if (!est.base) { return itens; }
    if (bases[est.base]) { return bases[est.base]; }
    lista = [];
    try {
      if (est.base === 'regra:wedding' || est.base === 'regra:madrinhas') {
        r = { results: typeof tgSelecaoVestidos === 'function' ? tgSelecaoVestidos(cat, est.base === 'regra:wedding' ? 'wedding' : 'madrinhas') : [] };
      } else { r = runSearch(est.base, cat, TG_PG_LIMITE); }
      for (j = 0; j < r.results.length; j++) { if (urlProduto(r.results[j].s) && precoFinal(r.results[j])) { lista.push(r.results[j]); } }
    } catch (e) {}
    bases[est.base] = lista;
    return lista;
  }
  function soNovidades(lista) {
    var set = {}, j, out = [];
    if (!est.novidades || !est.handles || !est.handles.length) { return lista; }
    for (j = 0; j < est.handles.length; j++) { set[est.handles[j]] = true; }
    for (j = 0; j < lista.length; j++) { if (set[lista[j].s]) { out.push(lista[j]); } }
    return out;
  }
  // cores oferecidas: so as que existem no que a cliente ja filtrou (tamanho, preco, categoria, novidades); as ja marcadas ficam sempre
  function opcoesCor() {
    var todas = tgPgOpcoesCor(baseItens()), vivas = tgPgOpcoesCor(tgPgPorPreco(tgPgFiltrar(soNovidades(baseItens()), est.tamanhos, []), est.preco)), out = [], j, k, achou;
    for (j = 0; j < todas.length; j++) {
      achou = est.cores.indexOf(todas[j].valor) >= 0;
      for (k = 0; !achou && k < vivas.length; k++) { if (vivas[k].valor === todas[j].valor) { achou = true; } }
      if (achou) { out.push(todas[j]); }
    }
    return out;
  }
  // QA 5.3 (25/11): os 6 tamanhos, apagados (sem clique) quando nenhuma peca da combinacao atual (chip, Novidades, cores, preco) tem aquele tamanho
  function opcoesTamanho() {
    var base = tgPgPorPreco(tgPgFiltrar(soNovidades(baseItens()), [], est.cores), est.preco);
    return tgPgOpcoesTamanho().map(function (o) { return { valor: o.valor, rotulo: o.rotulo, desligado: est.tamanhos.indexOf(o.valor) < 0 && !tgPgFiltrar(base, [o.valor], []).length }; });
  }
  // Novidades (filtro exclusivo, so combina com Tamanho e Cor): na ordem da categoria Novidades
  function lista() { return tgPgOrdenar(tgPgPorPreco(tgPgFiltrar(soNovidades(baseItens()), est.tamanhos, est.cores), est.preco), est.novidades ? 'lancamentos' : est.ordem, est.handles); }
  // faixa de preco possivel para o que a cliente ja escolheu (sem contar o proprio preco)
  function faixa() { return tgPgFaixaPreco(tgPgFiltrar(soNovidades(baseItens()), est.tamanhos, est.cores)); }
  // Novidades sem grupo (Danilo, 24/11): 2 Vestidos, 2 Blusas e 2 Calcas, uma secao por grupo, e o botao Ver Novidades
  function secoesNov(l) {
    var out = [], gs = ['vestidos', 'blusas', 'calcas'], j, its;
    if (typeof tgGrupoDoItem !== 'function' || typeof TG_GRUPOS === 'undefined') { return null; }
    for (j = 0; j < gs.length; j++) {
      its = l.filter(function (it) { return tgGrupoDoItem(it) === gs[j]; }).slice(0, 2);
      if (its.length) { out.push({ titulo: TG_GRUPOS[gs[j]].rotulo, itens: its }); }
    }
    return out.length ? out : null;
  }
  function lote() {
    var fim = Math.min(est.atual.length, est.mostrados + TG_PG_LOTE), c, p;
    for (p = est.mostrados; p < fim; p++) {
      c = tgRgCard(est.atual[p], selos ? (selos.get(est.atual[p]) || false) : false, destaqueAtual(), { mapa: mapa, posicao: p + 1 });
      if (c) { grade.appendChild(c); }
    }
    est.mostrados = fim;
    // so aparece se ainda ha pecas para mostrar (e diz quantas); sem mais pecas o botao nao existe
    if (fim < est.atual.length) { tgTexto(mais, 'Ver mais'); mais.classList.remove('tg-busca-oculto'); } else { mais.classList.add('tg-busca-oculto'); }
  }
  // "Mais Vendidos em Vestidos / Blusas / Calças": no Best Sellers sem grupo definido a lista vira uma secao por categoria (as mais vendidas de cada)
  function secoesBest(lista) {
    var out = [], gs = ['vestidos', 'blusas', 'calcas'], j, its, resto;
    if (typeof tgGrupoDoItem !== 'function' || typeof TG_GRUPOS === 'undefined') { return null; }
    for (j = 0; j < gs.length; j++) {
      its = lista.filter(function (it) { return tgGrupoDoItem(it) === gs[j]; }).slice(0, TG_PG_BEST_MAX);
      if (its.length) { out.push({ titulo: 'Mais Vendidos em ' + TG_GRUPOS[gs[j]].rotulo, itens: its }); }
    }
    resto = lista.filter(function (it) { return !tgGrupoDoItem(it); }).slice(0, TG_PG_BEST_MAX);
    if (resto.length && out.length) { out.push({ titulo: 'Mais Vendidos em Outras Peças', itens: resto }); }
    return out.length ? out : null;
  }
  function tituloCaso(t) {
    return String(t || '').trim().slice(0, 60).split(/\s+/).map(function (w, i) { w = w.toLowerCase(); return i && /^(de|da|do|das|dos|e|em|com|para|no|na)$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
  }
  // "Você está buscando por: Vestidos" (ou o que foi digitado, ou grupo + chip)
  function pintarTitulo() {
    var g = gAtivo(), rot, c, j, ocas, pre;
    if (est.chip && g) { c = tgChipDoGrupo(g, est.chip); rot = TG_GRUPOS[g].rotulo + (c ? ' · ' + c.rotulo : ''); }
    else if (est.grupo) { rot = TG_GRUPOS[est.grupo].rotulo; }
    else if (est.base) {
      rot = tituloCaso(q);
      ocas = typeof TG_CHIPS_OCASIAO !== 'undefined' && Array.isArray(TG_CHIPS_OCASIAO) ? TG_CHIPS_OCASIAO : [];
      for (j = 0; j < ocas.length; j++) { if (ocas[j] && ocas[j].consulta === est.base) { rot = ocas[j].rotulo; } }
    } else if (grupoQ && normalizeText(q).split(' ').length === 1) { rot = TG_GRUPOS[grupoQ].rotulo; } else { rot = tituloCaso(q); }
    // titulo da ordenacao (Danilo, 24/11): "Lançamentos em Vestidos", "Melhores Ofertas em Vestidos"; Novidades: "Novidades em Vestidos"
    pre = 'Você está buscando por: ';
    if (est.novidades) { pre = 'Novidades em '; }
    else if (est.ordem !== 'relevancia') { for (j = 0; j < TG_PG_ORDENS.length; j++) { if (TG_PG_ORDENS[j][0] === est.ordem) { pre = TG_PG_ORDENS[j][1] + ' em '; } } }
    while (voce.firstChild) { voce.removeChild(voce.firstChild); }
    voce.appendChild(document.createTextNode(pre));
    voce.appendChild(el('strong', null, [rot]));
    pintarContador();
  }
  function rotuloContado(base, n) { return n ? base + ' (' + n + ')' : base; }
  function desenhar() {
    var opCor;
    while (grade.firstChild) { grade.removeChild(grade.firstChild); }
    est.atual = lista();
    est.mostrados = 0;
    est.secoes = est.novidades && !gAtivo() ? secoesNov(est.atual) : (est.ordem === 'best-sellers' && !gAtivo() ? secoesBest(est.atual) : null);
    if (est.secoes) {
      // uma secao por categoria, sem paginacao (cada uma ja traz as mais vendidas)
      est.secoes.forEach(function (sec) {
        var p2, c2;
        grade.appendChild(el('h2', { 'class': 'tg-busca-grade-titulo' }, [sec.titulo]));
        for (p2 = 0; p2 < sec.itens.length; p2++) {
          c2 = tgRgCard(sec.itens[p2], selos ? (selos.get(sec.itens[p2]) || false) : false, destaqueAtual(), { mapa: mapa, posicao: p2 + 1 });
          if (c2) { grade.appendChild(c2); }
        }
      });
      est.mostrados = est.atual.length;
      mais.classList.add('tg-busca-oculto');
    } else {
      lote();
    }
    pintarTitulo();
    // o aviso "Buscando por: ... no tamanho G" sai junto com o filtro do tamanho da busca
    if (tamDaBusca && aviso) { if (est.tamanhos.length) { aviso.classList.remove('tg-busca-oculto'); } else { aviso.classList.add('tg-busca-oculto'); } }
    if (est.novidades && est.atual.length) { verNov.classList.remove('tg-busca-oculto'); } else { verNov.classList.add('tg-busca-oculto'); }
    // sem peca na combinacao: mensagem com saida
    while (vazio.firstChild) { vazio.removeChild(vazio.firstChild); }
    if (!est.atual.length) {
      limpar = el('button', { type: 'button', 'class': 'tg-busca-chip tg-busca-chip-ativo' }, ['Limpar filtros']);
      limpar.addEventListener('click', function () { try { limparTudo(); } catch (e) {} });
      vazio.appendChild(el('p', null, ['Nenhuma peça com essa combinação de filtros.']));
      vazio.appendChild(limpar);
      vazio.classList.remove('tg-busca-oculto');
    } else { vazio.classList.add('tg-busca-oculto'); }
    chips();
    pintarAtivos();
    if (ordem) { ordem.pintar(null, est.ordem); }
    if (tam) { tgTexto(tam.botao, rotuloContado('Tamanho', est.tamanhos.length)); tam.pintar(null, est.tamanhos); }
    if (cor) {
      est.cores = est.cores.filter(function (c) { return tgPgOpcoesCor(baseItens()).some(function (o) { return o.valor === c; }); });
      opCor = opcoesCor();
      tgTexto(cor.botao, rotuloContado('Cor', est.cores.length)); cor.pintar(opCor, est.cores);
    }
    if (filtro) { filtro.pintar(); }
    if (ordP) { ordP.pintar(); }
    urlGravar();
  }
  // ---- link compartilhavel: a combinacao de filtros vai na URL (tg_cat, tg_tam, tg_cor, tg_ord, tg_nov) e quem abrir o link ve a mesma busca
  function tgPgConsultasValidas() {
    var out = [], l = [], j, k;
    if (typeof TG_CHIPS_EM_ALTA !== 'undefined' && Array.isArray(TG_CHIPS_EM_ALTA)) { l = l.concat(TG_CHIPS_EM_ALTA); }
    if (typeof TG_CHIPS_OCASIAO !== 'undefined' && Array.isArray(TG_CHIPS_OCASIAO)) { l = l.concat(TG_CHIPS_OCASIAO); }
    for (j = 0; j < l.length; j++) { if (l[j] && typeof l[j].consulta === 'string') { out.push(l[j].consulta); } }
    return out;
  }
  function urlGravar() {
    var sp, qs, ks = ['tg_cat', 'tg_tam', 'tg_cor', 'tg_ord', 'tg_nov', 'tg_gr', 'tg_ch', 'tg_preco'], vs, j;
    try {
      sp = new URLSearchParams(window.location.search);
      vs = [est.base || '', est.tamanhos.join(','), est.cores.join(','), est.ordem !== 'relevancia' ? est.ordem : '', est.novidades ? '1' : '', est.grupo || '', est.chip || '', est.preco ? est.preco.min + '-' + est.preco.max : ''];
      for (j = 0; j < ks.length; j++) { if (vs[j]) { sp.set(ks[j], vs[j]); } else { sp['delete'](ks[j]); } }
      qs = sp.toString().replace(/%2C/gi, ',');
      window.history.replaceState(window.history.state, '', window.location.pathname + (qs ? '?' + qs : '') + (window.location.hash || ''));
    } catch (e) {}
  }
  function urlLer() {
    var sp, v, partes, j, k, ids, validas, precisaNov = false;
    try {
      sp = new URLSearchParams(window.location.search);
      v = sp.get('tg_ord');
      if (v) { for (j = 0; j < TG_PG_ORDENS.length; j++) { if (TG_PG_ORDENS[j][0] === v) { est.ordem = v; } } }
      v = sp.get('tg_cat');
      if (v && tgPgConsultasValidas().indexOf(v) >= 0) { est.base = v; }
      v = sp.get('tg_gr');
      if (v && typeof TG_GRUPOS !== 'undefined' && Object.prototype.hasOwnProperty.call(TG_GRUPOS, v) && v !== grupoQ) { est.grupo = v; est.base = ''; }
      v = sp.get('tg_ch');
      if (v && gAtivo() && typeof tgChipDoGrupo === 'function' && tgChipDoGrupo(gAtivo(), v) && !tgChipDoGrupo(gAtivo(), v).novidades) { est.chip = v; est.base = ''; }
      v = sp.get('tg_tam');
      if (v) {
        ids = tgPgOpcoesTamanho().map(function (o) { return o.valor; });
        partes = v.split(',');
        for (j = 0; j < partes.length && j < 7; j++) { if (ids.indexOf(partes[j]) >= 0 && est.tamanhos.indexOf(partes[j]) < 0) { est.tamanhos.push(partes[j]); } }
      }
      v = sp.get('tg_cor');
      if (v) {
        partes = v.split(',');
        for (j = 0; j < partes.length && j < 8; j++) { if (/^[a-z0-9 \-]{1,40}$/.test(partes[j]) && est.cores.indexOf(partes[j]) < 0) { est.cores.push(partes[j]); } }
      }
      // Novidades pelo link: so liga quando a lista das Novidades chegar (antes disso a tela mostraria pecas que nao sao novidades)
      v = sp.get('tg_preco');
      if (v && /^\d{1,6}-\d{1,6}$/.test(v)) { partes = v.split('-').map(Number); if (partes[0] <= partes[1]) { est.preco = { min: partes[0], max: partes[1] }; } }
      if (sp.get('tg_nov') === '1') { est.novPend = true; est.chip = ''; est.base = ''; est.ordem = 'relevancia'; }
      // cor que nao existe nessa busca some do link (nada de chip fantasma nem lista vazia por link editado)
      if (est.cores.length && typeof tgPgOpcoesCor === 'function') { validas = tgPgOpcoesCor(baseItens()).map(function (o) { return o.valor; }); est.cores = est.cores.filter(function (c) { return validas.indexOf(c) >= 0; }); }
      if (est.ordem === 'lancamentos' || est.novPend) { precisaNov = true; }
    } catch (e) {}
    return precisaNov;
  }
  var limpar;
  function limparTudo() { est.tamanhos = []; est.cores = []; est.preco = null; est.base = ''; est.grupo = ''; est.chip = ''; est.novidades = false; est.ordem = 'relevancia'; desenhar(); }
  function escolherPreco(min, max) {
    var fx = faixa();
    est.preco = !fx || (min <= fx.min && max >= fx.max) ? null : { min: min, max: max };
    desenhar();
    try { emitir('tg_busca_filtro_preco', { reason: est.preco ? est.preco.min + '-' + est.preco.max : 'limpar', results_count: est.atual.length }); } catch (e) {}
  }
  mais.addEventListener('click', function () { try { lote(); } catch (e) {} });

  function alternar(lista, v) { var p = lista.indexOf(v); if (p >= 0) { lista.splice(p, 1); } else { lista.push(v); } }
  function escolherOrdem(v) {
    function aplicar() { est.ordem = v; if (v !== 'relevancia') { est.novidades = false; } if (ordem) { ordem.pintar(null, v); } desenhar(); try { emitir('tg_busca_ordenar', { reason: v, results_count: est.atual.length }); } catch (e) {} }
    if (v === 'lancamentos' && !(est.handles && est.handles.length)) { tgPgNovidades().then(function (h) { est.handles = h; aplicar(); }); return; }
    aplicar();
  }
  function escolherTamanho(v) {
    alternar(est.tamanhos, v);
    desenhar();
    try { emitir('tg_busca_filtro_tamanho', { reason: est.tamanhos.join(','), results_count: est.atual.length }); } catch (e) {}
  }
  function escolherCor(v) {
    alternar(est.cores, v);
    desenhar();
    try { emitir('tg_busca_filtro_cor', { reason: est.cores.join(','), results_count: est.atual.length }); } catch (e) {}
  }
  function escolherBase(consulta) {
    est.base = est.base === consulta ? '' : consulta;
    est.novidades = false;
    desenhar();
    try { emitir('tg_busca_chip', { reason: est.base || 'limpar', results_count: est.atual.length }); } catch (e) {}
  }
  function entrarGrupo(id) {
    est.grupo = id; est.chip = ''; est.base = ''; est.novidades = false;
    desenhar();
    try { emitir('tg_busca_chip', { reason: id, results_count: est.atual.length }); } catch (e) {}
  }
  function voltarTodas() {
    est.grupo = ''; est.chip = ''; est.base = ''; est.novidades = false;
    desenhar();
    try { emitir('tg_busca_chip', { reason: 'limpar', results_count: est.atual.length }); } catch (e) {}
  }
  function escolherChipGrupo(id) {
    est.chip = est.chip === id ? '' : id;
    est.novidades = false;
    desenhar();
    try { emitir('tg_busca_chip', { reason: (gAtivo() || '') + ':' + (est.chip || 'limpar'), results_count: est.atual.length }); } catch (e) {}
  }
  function escolherNovidades(botao) {
    function aplicar() { est.novidades = !est.novidades; if (est.novidades) { est.chip = ''; est.base = ''; est.ordem = 'relevancia'; } desenhar(); try { emitir('tg_busca_chip', { reason: est.novidades ? 'novidades' : 'limpar', results_count: est.atual.length }); } catch (e) {} }
    if (!(est.handles && est.handles.length)) { botao.setAttribute('aria-busy', 'true'); tgPgNovidades().then(function (h) { est.handles = h; botao.removeAttribute('aria-busy'); if (h.length) { aplicar(); } }); return; }
    if (est.handles.length) { aplicar(); }
  }

  // Filtros aplicados (Danilo, 24/11): microchips discretos na barra que gruda no topo, cada um com x para tirar, e "Limpar busca".
  // So aparece com algum filtro; acompanha a rolagem junto com a barra.
  function pintarAtivos() {
    var itens = [], opC, g = gAtivo(), c, lim, rot, j, todos;
    if (!ativos) { return; }
    while (ativos.firstChild) { ativos.removeChild(ativos.firstChild); }
    function micro(texto, tirar) {
      var b = el('button', { type: 'button', 'class': 'tg-busca-micro', 'aria-label': 'Tirar o filtro ' + texto }, [texto, el('span', { 'class': 'tg-busca-micro-x', 'aria-hidden': 'true' }, ['×'])]);
      b.addEventListener('click', function () { try { tirar(); } catch (e) {} });
      itens.push(b);
    }
    if (est.grupo && !grupoQ && TG_GRUPOS[est.grupo]) { micro(TG_GRUPOS[est.grupo].rotulo, function () { voltarTodas(); }); }
    if (est.chip && g && typeof tgChipDoGrupo === 'function') { c = tgChipDoGrupo(g, est.chip); if (c) { micro(c.rotulo, function () { escolherChipGrupo(est.chip); }); } }
    if (est.base) {
      rot = est.base;
      todos = [].concat(typeof TG_CHIPS_EM_ALTA !== 'undefined' ? TG_CHIPS_EM_ALTA : [], typeof TG_CHIPS_OCASIAO !== 'undefined' ? TG_CHIPS_OCASIAO : []);
      for (j = 0; j < todos.length; j++) { if (todos[j] && todos[j].consulta === est.base) { rot = todos[j].rotulo; } }
      micro(rot, function () { escolherBase(est.base); });
    }
    if (est.novidades) { micro('Novidades', function () { est.novidades = false; desenhar(); }); }
    est.tamanhos.forEach(function (t) { micro('Tamanho ' + t, function () { escolherTamanho(t); }); });
    opC = est.cores.length ? tgPgOpcoesCor(baseItens()) : [];
    est.cores.forEach(function (v) {
      var r = v, k;
      for (k = 0; k < opC.length; k++) { if (opC[k].valor === v) { r = opC[k].rotulo; } }
      micro(r, function () { escolherCor(v); });
    });
    if (est.preco) { micro(tgPgReal(est.preco.min) + ' a ' + tgPgReal(est.preco.max), function () { est.preco = null; desenhar(); }); }
    if (!itens.length) { ativos.classList.add('tg-busca-oculto'); return; }
    lim = el('button', { type: 'button', 'class': 'tg-busca-limpar-busca' }, ['Limpar filtros']); // QA 5.2 (25/11)
    lim.addEventListener('click', function () { try { limparTudo(); emitir('tg_busca_chip', { reason: 'limpar' }); } catch (e) {} });
    ativos.appendChild(el('div', { 'class': 'tg-busca-ativos-lista' }, itens));
    ativos.appendChild(lim);
    ativos.classList.remove('tg-busca-oculto');
  }
  // linha de chips: filtros ativos (tirar ao clicar) + categorias, ocasioes e Novidades (botoes que combinam com tamanho e cor)
  chipsLinha = el('div', { 'class': 'tg-busca-chips tg-busca-chips-linha' });
  function chipBotao(rotulo, ativo, aoClicar, ariaTirar) {
    var b = el('button', { type: 'button', 'class': 'tg-busca-chip' + (ativo ? ' tg-busca-chip-ativo' : ''), 'aria-pressed': ativo ? 'true' : 'false' }, [rotulo]);
    if (ariaTirar) { b.setAttribute('aria-label', ariaTirar); }
    b.addEventListener('click', function () { try { aoClicar(b); } catch (e) {} });
    return b;
  }
  function rotuloTam(id) { var o = tgPgOpcoesTamanho(), j; for (j = 0; j < o.length; j++) { if (o[j].valor === id) { return o[j].rotulo; } } return id; }
  function chips() {
    var cats = typeof TG_CHIPS_EM_ALTA !== 'undefined' && Array.isArray(TG_CHIPS_EM_ALTA) ? TG_CHIPS_EM_ALTA : [], ocas = typeof TG_CHIPS_OCASIAO !== 'undefined' && Array.isArray(TG_CHIPS_OCASIAO) ? TG_CHIPS_OCASIAO : [], j, c, ordemChips = [], nov = null, opCor, gcs;
    while (chipsLinha.firstChild) { chipsLinha.removeChild(chipsLinha.firstChild); }
    // os filtros aplicados (Tamanho, Cor, Novidades...) ficam na linha de microchips da barra grudada (pintarAtivos), nao aqui
    opCor = typeof tgPgOpcoesCor === 'function' ? tgPgOpcoesCor(baseItens()) : [];  // rotulos: lista completa
    // dentro de um grupo (Vestidos, Blusas, Calças), pela busca ou por chip: os chips passam a ser os do grupo
    gcs = null;
    try { if (gAtivo() && typeof tgChipsDoGrupo === 'function') { gcs = tgChipsDoGrupo(cat, gAtivo()); } } catch (e) { gcs = null; }
    if (gcs) {
      if (est.grupo && !grupoQ) { chipsLinha.appendChild(chipBotao('‹ Todas', false, function () { voltarTodas(); }, 'Voltar para todas as peças')); }
      gcs.forEach(function (gc) {
        if (gc.novidades) { chipsLinha.appendChild(chipBotao(gc.rotulo, est.novidades, function (b) { escolherNovidades(b); })); }
        else { chipsLinha.appendChild(chipBotao(gc.rotulo, est.chip === gc.id, function () { escolherChipGrupo(gc.id); })); }
      });
      // v14: Conjuntos (blusa + calca/saia da mesma cor) tambem aparece dentro de Blusas e de Calças
      if (conjOk && (gAtivo() === 'blusas' || gAtivo() === 'calcas')) { chipsLinha.appendChild(el('a', { 'class': 'tg-busca-chip', href: urlBusca('conjuntos') }, ['Conjuntos'])); }
      if (!chipsLinha.firstChild) { chipsLinha.classList.add('tg-busca-oculto'); } else { chipsLinha.classList.remove('tg-busca-oculto'); }
      return;
    }
    for (j = 0; j < cats.length; j++) {
      c = cats[j];
      if (!c || typeof c.rotulo !== 'string' || !c.rotulo) { continue; }
      if (c.novidades || c.href === '/novidades/') { nov = c; continue; }
      if (typeof c.consulta === 'string' && c.consulta) { ordemChips.push(c); }
    }
    ordemChips = ordemChips.concat(ocas.filter(function (o) { return o && typeof o.rotulo === 'string' && typeof o.consulta === 'string' && o.consulta; }));
    ordemChips.forEach(function (o) {
      var gid = typeof tgGrupoDaBusca === 'function' ? tgGrupoDaBusca(o.consulta) : '';
      chipsLinha.appendChild(chipBotao(o.rotulo, est.base === o.consulta, function () { if (gid) { entrarGrupo(gid); } else { escolherBase(o.consulta); } }));
    });
    if (conjOk) { chipsLinha.appendChild(el('a', { 'class': 'tg-busca-chip', href: urlBusca('conjuntos') }, ['Conjuntos'])); }
    if (nov) { chipsLinha.appendChild(chipBotao(nov.rotulo, est.novidades, function (b) { escolherNovidades(b); })); }
    if (!chipsLinha.firstChild) { chipsLinha.classList.add('tg-busca-oculto'); } else { chipsLinha.classList.remove('tg-busca-oculto'); }
  }

  // a barra do desktop (v13): [filtros aplicados] ........ [grade 2/3/4] [Filtrar] [Ordenar]
  if (typeof tgFiltrar === 'function') {
    filtro = tgPgPainelFiltrar({
      tamanhos: opcoesTamanho,
      tamanhosAtivos: function () { return est.tamanhos; },
      cores: function () { return opcoesCor(); },
      coresAtivas: function () { return est.cores; },
      faixa: faixa,
      preco: function () { return est.preco; },
      aoTamanho: escolherTamanho,
      aoCor: escolherCor,
      aoPreco: escolherPreco,
      limpar: function () { est.tamanhos = []; est.cores = []; est.preco = null; desenhar(); },
      contagem: function () { return est.tamanhos.length + est.cores.length + (est.preco ? 1 : 0); }
    });
    menus.push(filtro);
  }
  if (typeof tgOrdenar === 'function') {
    ordP = tgPgPainelOrdenar(function () { return est.novidades ? '' : est.ordem; }, function (v) { escolherOrdem(est.ordem === v ? 'relevancia' : v); });
    menus.push(ordP);
  }
  togg = tgPgGradeColunas(function () { return est.colunas; }, function (n) {
    var j;
    est.colunas = n;
    for (j = 0; j < TG_PG_COLUNAS.length; j++) { grade.classList.remove('tg-busca-grade-c' + TG_PG_COLUNAS[j]); }
    grade.classList.add('tg-busca-grade-c' + n);
    try { emitir('tg_busca_grade', { reason: String(n) }); } catch (e) {}
  });
  grade.classList.add('tg-busca-grade-c' + est.colunas);
  ativos = el('div', { 'class': 'tg-busca-ativos tg-busca-oculto', role: 'group', 'aria-label': 'Filtros aplicados' });
  barra = el('div', { 'class': 'tg-busca-barra' }, [el('div', { 'class': 'tg-busca-barra-linha' }, [ativos, el('span', { 'class': 'tg-busca-barra-espaco' }), togg.no, filtro ? filtro.no : null, ordP ? ordP.no : null]), filtro ? filtro.painel : null, ordP ? ordP.painel : null]);
  if (filtro) { filtro.ligar(barra, menus); }
  if (ordP) { ordP.ligar(barra, menus); }

  // fecha os menus ao clicar fora ou com Esc (um unico ouvinte por pagina). Clique num botao que o painel redesenhou (ja fora da pagina) nao conta como fora.
  document.addEventListener('click', function (ev) {
    var j, dentro;
    try {
      if (ev.target && ev.target.isConnected === false) { return; }
      for (j = 0; j < menus.length; j++) { dentro = menus[j].contem ? menus[j].contem(ev.target) : menus[j].no.contains(ev.target); if (!dentro) { menus[j].fechar(); } }
    } catch (e) {}
  });
  document.addEventListener('keydown', function (ev) {
    var j;
    try { if (ev.key === 'Escape') { for (j = 0; j < menus.length; j++) { menus[j].fechar(); } } } catch (e) {}
  });

  // QA 2 (25/11): o tamanho da busca ("vestido preto g") vira o filtro Tamanho (microchip + marcado no Filtrar); a lista-base passa a ser a busca sem o
  // tamanho, para o x do filtro (ou Limpar filtros) abrir as outras pecas. Os cards seguem marcando o tamanho, e o modal abre com ele escolhido.
  try {
    if (res.tamanho && res.tamanho.aplicado && res.tamanho.texto && typeof tgPgOpcoesTamanho === 'function') {
      (function () {
        var pedidos = (res.tamanho.pedido || []).map(function (t) { return String(t).toUpperCase(); }), ids = [], semTam, rSem, j, k, g = typeof TG_TAMANHO_GRUPOS !== 'undefined' ? TG_TAMANHO_GRUPOS : [];
        for (j = 0; j < g.length; j++) { for (k = 0; k < g[j].v.length; k++) { if (pedidos.indexOf(String(g[j].v[k]).toUpperCase()) >= 0 && ids.indexOf(g[j].id) < 0) { ids.push(g[j].id); } } }
        if (!ids.length) { return; }
        rSem = runSearch(res.tamanho.texto, cat, TG_PG_LIMITE);
        semTam = rSem.results.filter(function (it) { return urlProduto(it.s) && precoFinal(it); });
        if (!semTam.length) { return; }
        itens = semTam; mapa = tgGruposCores(itens); est.atual = itens; est.tamanhos = ids; destaque = null; fortes = tgPgFortes(rSem); tamDaBusca = true;
        if (rSem.selos) { selos = rSem.selos; }
      })();
    }
  } catch (e) {}
  if (res.tamanho) { aviso = tgAcAviso(res.tamanho); }
  else if (!grupoQ && !tgPgCasaNome(q, itens.slice(0, 6))) { aviso = el('div', { 'class': 'tg-busca-aviso-nome', role: 'status' }, ['Não encontramos “' + String(q).trim().slice(0, 60) + '”. Veja peças com nome parecido:']); }
  var precisaNov = urlLer();
  // chips acima da barra (Danilo, 24/11): ficam a vista, com respiro, e a barra (Ordenar, Tamanho, Cor, grade) gruda no topo ao rolar
  filhos = [tgConselheira(), voce, contador, aviso, chipsLinha, barra, grade, vazio, mais, verNov];
  raiz = el('section', { id: 'tg-busca-resultados', 'class': 'tg-busca-pagina', 'aria-label': 'Resultados da busca' }, filhos);
  injetarEstilos();
  desenhar();
  destino.insertBefore(raiz, destino.firstChild || null);
  tgPgTopoBarra(raiz);
  // chip Conjuntos (so com a lista do Recom no ar e com pelo menos um par em estoque)
  try { tgConjuntosLista(cat).then(function (l) { if (l.length && (!gAtivo() || gAtivo() === 'blusas' || gAtivo() === 'calcas')) { conjOk = true; chips(); } }); } catch (e) {}
  if (precisaNov) {
    tgPgNovidades().then(function (h) { est.handles = h; if (est.novPend && h.length) { est.novidades = true; } est.novPend = false; desenhar(); });
  }
  if (TG_PG_ESCONDE_NATIVO) {
    nativo = document.querySelector('.js-product-table');
    if (nativo) { nativo.classList.add('tg-busca-nativo-oculto'); }
  }
  // a nossa tela tem o proprio titulo e a propria paginacao: somem os titulos nativos e o "Mostrar mais produtos" da Nuvem
  tgRgEsconderNativos(false);
  emitir('tg_busca_pagina_view', { results_count: itens.length, page_type: 'search' });
  return true;
}

// ---------------------------------------------------------------- desktop (v13): preco, paineis de Filtrar e Ordenar, grade 2/3/4
// Preco redondo para a regua e o microchip (R$ 180).
function tgPgReal(v) { return 'R$ ' + Math.round(Number(v) || 0); }
// Pecas dentro da faixa de preco (o preco final, com desconto). Sem faixa = a lista inteira.
function tgPgPorPreco(lista, faixa) {
  if (!faixa) { return lista; }
  return lista.filter(function (it) { var p = precoFinal(it); return !!p && p.final >= faixa.min && p.final <= faixa.max; });
}
// Menor e maior preco da lista, arredondados para fora em dezenas (R$ 189,90 -> 180 ... 460). null sem pecas.
function tgPgFaixaPreco(lista) {
  var min = Infinity, max = 0, i, p;
  for (i = 0; i < lista.length; i++) { p = precoFinal(lista[i]); if (p && p.final > 0) { if (p.final < min) { min = p.final; } if (p.final > max) { max = p.final; } } }
  if (!isFinite(min) || !max) { return null; }
  return { min: Math.floor(min / 10) * 10, max: Math.ceil(max / 10) * 10 };
}

// Painel suspenso do desktop: botao (com seta que gira) + painel largo sob a barra. Abre ao passar o mouse e no clique; fecha ao sair (com um
// instante de folga), com Esc, ao clicar fora ou ao abrir o outro painel. Devolve { no, botao, painel, fechar, ligar(barra, menus) }.
function tgPgPainel(rotulo, classe, montar) {
  var botao = el('button', { type: 'button', 'class': 'tg-busca-barra-btn tg-busca-dk-btn', 'aria-haspopup': 'true', 'aria-expanded': 'false' }, [el('span', { 'class': 'tg-busca-dk-btn-rot' }, [rotulo]), el('span', { 'class': 'tg-busca-dk-seta', 'aria-hidden': 'true' })]);
  var painel = el('div', { 'class': 'tg-busca-dk-painel ' + classe + ' tg-busca-oculto', role: 'dialog', 'aria-label': rotulo });
  var wrap = el('div', { 'class': 'tg-busca-menu-wrap tg-busca-dk-wrap' }, [botao]);
  var p = { no: wrap, botao: botao, painel: painel, timer: null, outros: [] };
  function abrir() {
    var j;
    clearTimeout(p.timer);
    for (j = 0; j < p.outros.length; j++) { if (p.outros[j] !== p && p.outros[j].fechar) { p.outros[j].fechar(); } }
    if (botao.getAttribute('aria-expanded') === 'true') { return; }
    try { montar(painel); } catch (e) {}
    painel.classList.remove('tg-busca-oculto');
    botao.setAttribute('aria-expanded', 'true');
    p.abertoEm = Date.now();
  }
  function fechar() { clearTimeout(p.timer); painel.classList.add('tg-busca-oculto'); botao.setAttribute('aria-expanded', 'false'); }
  function sair() { clearTimeout(p.timer); p.timer = setTimeout(function () { try { fechar(); } catch (e) {} }, TG_PG_FECHA_MS); }
  p.fechar = fechar;
  p.abrir = abrir;
  p.aberto = function () { return botao.getAttribute('aria-expanded') === 'true'; };
  p.repintar = function () { if (p.aberto()) { try { montar(painel); } catch (e) {} } };
  // o mouse que chega no botao ja abriu o painel: o clique logo em seguida nao fecha (so um segundo clique, depois de um instante)
  botao.addEventListener('click', function () { try { if (p.aberto() && Date.now() - (p.abertoEm || 0) > 500) { fechar(); } else { abrir(); } } catch (e) {} });
  // mouse (nao toque): passar por cima abre; sair do botao e do painel fecha
  [wrap, painel].forEach(function (n) {
    n.addEventListener('pointerenter', function (ev) { try { if (ev.pointerType === 'mouse') { if (n === wrap) { abrir(); } else { clearTimeout(p.timer); } } } catch (e) {} });
    n.addEventListener('pointerleave', function (ev) { try { if (ev.pointerType === 'mouse') { sair(); } } catch (e) {} });
  });
  p.ligar = function (barra, menus) { p.outros = menus; p.barra = barra; };
  // o painel faz parte do "dentro" para o clique fora
  p.contem = function (alvo) { return wrap.contains(alvo) || painel.contains(alvo); };
  return p;
}

// Filtrar: Preco (regua com minimo e maximo), Tamanhos (circulos) e Cores (pilulas com bolinha), mais "Limpar tudo". Cada escolha vale na hora.
function tgPgPainelFiltrar(o) {
  var p = tgPgPainel('Filtrar', 'tg-busca-dk-filtrar', function (painel) {
    var cols = [], fx = o.faixa(), atual = o.preco(), tams = [], cores = [], lim, k;
    while (painel.firstChild) { painel.removeChild(painel.firstChild); }
    if (fx && fx.max > fx.min) { cols.push(el('div', { 'class': 'tg-busca-dk-col tg-busca-dk-col-preco' }, [el('p', { 'class': 'tg-busca-dk-tit' }, ['Preço']), tgPgRegua(fx, atual, o.aoPreco)])); }
    o.tamanhos().forEach(function (op) {
      var partes = String(op.rotulo).split(' / '), ativo = o.tamanhosAtivos().indexOf(op.valor) >= 0, sem = !!op.desligado && !ativo;
      // QA 5.3 (25/11): tamanho sem peca na combinacao atual fica apagado e nao responde ao clique
      var b = el('button', { type: 'button', 'class': 'tg-busca-dk-tam' + (sem ? ' tg-busca-dk-tam-sem' : ''), 'aria-pressed': ativo ? 'true' : 'false', 'aria-disabled': sem ? 'true' : null, 'aria-label': 'Tamanho ' + op.rotulo + (sem ? ' (sem peças com os filtros escolhidos)' : '') }, [el('span', null, [partes[0]]), partes[1] ? el('small', null, [partes[1]]) : null]);
      b.addEventListener('click', function () { try { if (sem) { return; } o.aoTamanho(op.valor); } catch (e) {} });
      tams.push(b);
    });
    if (tams.length) { cols.push(el('div', { 'class': 'tg-busca-dk-col' }, [el('p', { 'class': 'tg-busca-dk-tit' }, ['Tamanhos']), el('div', { 'class': 'tg-busca-dk-tams' }, tams)])); }
    o.cores().forEach(function (op) {
      var ativo = o.coresAtivas().indexOf(op.valor) >= 0;
      var b = el('button', { type: 'button', 'class': 'tg-busca-dk-cor', 'aria-pressed': ativo ? 'true' : 'false' }, [el('span', { 'class': 'tg-busca-bolinha', 'data-cor': tgCorSlug(op.valor === 'branco' ? 'off-white' : op.valor), 'aria-hidden': 'true' }), el('span', null, [op.rotulo])]);
      b.addEventListener('click', function () { try { o.aoCor(op.valor); } catch (e) {} });
      cores.push(b);
    });
    if (cores.length) { cols.push(el('div', { 'class': 'tg-busca-dk-col tg-busca-dk-col-cores' }, [el('p', { 'class': 'tg-busca-dk-tit' }, ['Cores']), el('div', { 'class': 'tg-busca-dk-cores' }, cores)])); }
    painel.appendChild(el('div', { 'class': 'tg-busca-dk-cols' }, cols));
    k = o.contagem();
    lim = el('button', { type: 'button', 'class': 'tg-busca-dk-limpar' }, ['Limpar filtros']);
    if (!k) { lim.setAttribute('aria-disabled', 'true'); }
    lim.addEventListener('click', function () { try { if (o.contagem()) { o.limpar(); } } catch (e) {} });
    painel.appendChild(el('div', { 'class': 'tg-busca-dk-pe' }, [lim]));
  });
  p.pintar = function () { var k = o.contagem(); tgTexto(p.botao.firstChild, k ? 'Filtrar (' + k + ')' : 'Filtrar'); p.repintar(); };
  return p;
}

// Regua de preco: dois controles deslizantes na mesma trilha (minimo e maximo), com os valores escritos em cima. Vale ao soltar.
function tgPgRegua(fx, atual, aoMudar) {
  var passo = 10, a, b, rotA, rotB, trilho, faixaNo, ini = atual ? Math.max(fx.min, atual.min) : fx.min, fim = atual ? Math.min(fx.max, atual.max) : fx.max;
  a = el('input', { type: 'range', 'class': 'tg-busca-dk-range', 'aria-label': 'Preço mínimo' });
  b = el('input', { type: 'range', 'class': 'tg-busca-dk-range', 'aria-label': 'Preço máximo' });
  tgAttr(a, { min: fx.min, max: fx.max, step: passo, value: ini });
  tgAttr(b, { min: fx.min, max: fx.max, step: passo, value: fim });
  a.value = String(ini); b.value = String(fim);
  rotA = el('span', null, [tgPgReal(ini)]);
  rotB = el('span', null, [tgPgReal(fim)]);
  faixaNo = el('span', { 'class': 'tg-busca-dk-faixa' });
  trilho = el('div', { 'class': 'tg-busca-dk-trilho' }, [faixaNo, a, b]);
  function pintar() {
    var va = Number(a.value), vb = Number(b.value), tot = fx.max - fx.min || 1;
    if (va > vb) { if (document.activeElement === a) { a.value = String(vb); va = vb; } else { b.value = String(va); vb = va; } }
    tgTexto(rotA, tgPgReal(va)); tgTexto(rotB, tgPgReal(vb));
    faixaNo.style.left = ((va - fx.min) / tot * 100) + '%';
    faixaNo.style.right = ((fx.max - vb) / tot * 100) + '%';
  }
  [a, b].forEach(function (n) {
    n.addEventListener('input', function () { try { pintar(); } catch (e) {} });
    n.addEventListener('change', function () { try { pintar(); aoMudar(Number(a.value), Number(b.value)); } catch (e) {} });
  });
  pintar();
  return el('div', { 'class': 'tg-busca-dk-regua' }, [el('div', { 'class': 'tg-busca-dk-valores' }, [rotA, rotB]), trilho]);
}

// Ordenar: chips circulares com icone (desenhado em CSS). aoEscolher(valor); a ativa fica marcada.
function tgPgPainelOrdenar(atual, aoEscolher) {
  var p = tgPgPainel('Ordenar', 'tg-busca-dk-ordenar', function (painel) {
    var bs = [];
    while (painel.firstChild) { painel.removeChild(painel.firstChild); }
    TG_PG_ORDENS_DESK.forEach(function (o) {
      var ativo = atual() === o[0];
      var b = el('button', { type: 'button', 'class': 'tg-busca-dk-ord', 'aria-pressed': ativo ? 'true' : 'false' }, [el('span', { 'class': 'tg-busca-dk-ico tg-busca-dk-ico-' + o[2], 'aria-hidden': 'true' }, [el('i')]), el('span', { 'class': 'tg-busca-dk-ord-rot' }, [o[1]])]);
      b.addEventListener('click', function () { try { aoEscolher(o[0]); p.fechar(); } catch (e) {} });
      bs.push(b);
    });
    painel.appendChild(el('div', { 'class': 'tg-busca-dk-ords' }, bs));
  });
  p.pintar = function () {
    var v = atual(), rot = 'Ordenar', j;
    for (j = 0; j < TG_PG_ORDENS_DESK.length; j++) { if (TG_PG_ORDENS_DESK[j][0] === v) { rot = TG_PG_ORDENS_DESK[j][1]; } }
    tgTexto(p.botao.firstChild, rot);
    p.repintar();
  };
  return p;
}

// Seletor de grade 2/3/4 (icones de quadradinhos, como na Farm). Devolve { no }.
function tgPgGradeColunas(atual, aoEscolher) {
  var bs = [];
  function pintar() { var j; for (j = 0; j < bs.length; j++) { bs[j].setAttribute('aria-pressed', TG_PG_COLUNAS[j] === atual() ? 'true' : 'false'); } }
  TG_PG_COLUNAS.forEach(function (n) {
    var q = [], j, b;
    for (j = 0; j < n * n; j++) { q.push(el('i')); }
    b = el('button', { type: 'button', 'class': 'tg-busca-dk-grade tg-busca-dk-grade-' + n, 'aria-pressed': 'false', 'aria-label': n + ' peças por linha' }, [el('span', { 'class': 'tg-busca-dk-grade-ico', 'aria-hidden': 'true' }, q)]);
    b.addEventListener('click', function () { try { aoEscolher(n); pintar(); } catch (e) {} });
    bs.push(b);
  });
  pintar();
  return { no: el('div', { 'class': 'tg-busca-dk-grades', role: 'group', 'aria-label': 'Peças por linha' }, bs) };
}

// Alguma palavra digitada (3+ letras) aparece no texto das primeiras pecas? Se nenhuma aparece, a lista e "parecida", nao o que foi pedido.
function tgPgCasaNome(q, itens) {
  var ws = normalizeText(q).split(' ').filter(function (w) { return w.length >= 3; }), i, j, k, txt, v;
  if (!ws.length || !itens.length) { return true; }
  for (i = 0; i < itens.length; i++) {
    txt = '';
    for (k in itens[i]) { if (Object.prototype.hasOwnProperty.call(itens[i], k)) { v = itens[i][k]; if (typeof v === 'string') { txt += ' ' + v; } else if (Array.isArray(v)) { txt += ' ' + v.join(' '); } } }
    txt = ' ' + normalizeText(txt) + ' ';
    for (j = 0; j < ws.length; j++) { if (txt.indexOf(ws[j]) >= 0) { return true; } }
  }
  return false;
}

// Barra grudada no topo (v12, 24/11). Dois problemas do tema: (1) a .category-body tem overflow:hidden, que desliga o sticky de quem esta dentro;
// os pais da nossa pagina passam a overflow visivel (com corte so na horizontal, sem criar rolagem); (2) o cabecalho do tema encolhe ao rolar
// (84 -> 47 px no celular): o topo da barra acompanha a borda de baixo do cabecalho a cada quadro de rolagem. Sem cabecalho fixo, fica em 0.
function tgPgTopoBarra(raiz) {
  var hs, pedido = 0, ultimo = -1, barra = null;
  try {
    (function soltar() {
      var n = raiz.parentElement, cs;
      while (n && n !== document.body && n !== document.documentElement) {
        cs = window.getComputedStyle(n);
        if (/(hidden|clip)/.test(cs.overflowX + ' ' + cs.overflowY) && !/(auto|scroll)/.test(cs.overflowX + ' ' + cs.overflowY)) { n.classList.add('tg-busca-pai-solto'); }
        n = n.parentElement;
      }
    })();
  } catch (e) {}
  function medir() {
    var i, cs, r, h = 0;
    pedido = 0;
    try {
      if (!hs) { hs = document.querySelectorAll('.js-head-main, header, .head-main'); }
      for (i = 0; i < hs.length; i++) {
        cs = window.getComputedStyle(hs[i]);
        if (cs.position !== 'fixed' && cs.position !== 'sticky') { continue; }
        r = hs[i].getBoundingClientRect();
        if (r.height > 0 && r.height < 200 && r.bottom > 0 && r.top <= 1) { h = Math.max(h, Math.round(r.bottom)); }
      }
      if (h !== ultimo && (h > 0 || ultimo > 0)) { ultimo = h; raiz.style.setProperty('--tgb-barra-topo', h + 'px'); if (!barra) { barra = raiz.querySelector('.tg-busca-barra'); } if (barra) { barra.style.top = h + 'px'; } }
    } catch (e) {}
  }
  function pedir() { if (!pedido) { pedido = (window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); })(medir); } }
  medir();
  try { window.addEventListener('scroll', pedir, { passive: true }); window.addEventListener('resize', pedir); } catch (e) {}
}

// Esgotado nominal pela pagina de resultados: true se montou a tela de esgotada + parecidas.
function tgRgEsgotadoPagina(q, cat, esg) {
  var res = runSearch(q, cat, TG_RG_ESG_LIMITE, esg);
  return !!(res.esgotado && tgRgMontarEsgotado(q, res));
}

function ligarResgate() {
  var q, curada, resultados;
  if (!/^\/search/.test(window.location.pathname)) { return; }
  q = String(new URLSearchParams(window.location.search).get('q') || '').trim().slice(0, 200);
  if (!q) { tgPend(false); return; }
  // busca curada: os blocos aparecem mesmo com a lista nativa na tela (so ai o catalogo e baixado com resultados nativos)
  curada = tgEhBuscaCurada(q);
  // resultados novos: valem com a lista nativa na tela (a nossa a substitui); features.resultados === false volta ao comportamento antigo
  resultados = !curada && !(tgCtx && tgCtx.features && tgCtx.features.resultados === false);
  if (!curada && !resultados && document.querySelector('.js-product-table')) { tgPend(false); return; }
  function jaMontado() { return !!(document.getElementById('tg-busca-resgate') || document.getElementById('tg-busca-resultados')); }
  // esconde a lista nativa ja na largada (sem piscar a nativa antes da nossa); se a nossa nao subir, a nativa volta (fail-safe)
  function devolverNativa() {
    var n;
    try { if (!jaMontado() && !document.getElementById('tg-busca-curada')) { n = document.querySelector('.js-product-table'); if (n) { n.classList.remove('tg-busca-nativo-oculto'); } } } catch (e) {}
  }
  if (resultados) {
    try { if (document.querySelector('.js-product-table')) { document.querySelector('.js-product-table').classList.add('tg-busca-nativo-oculto'); setTimeout(function () { devolverNativa(); tgPend(false); }, 7000); } } catch (e) {}
  }
  function seguir(cat, esg) {
    var res;
    if (jaMontado()) { return; }
    // Conjuntos (v12): a pagina de pares do Recom; sem a lista do Recom, segue a busca de sempre
    if (resultados && tgEhBuscaConjuntos(q)) {
      return tgConjuntosLista(cat).then(function (l) { if (jaMontado()) { return; } if (l.length && tgCjMontar(l)) { return; } seguirBusca(cat, esg); });
    }
    return seguirBusca(cat, esg);
  }
  function seguirBusca(cat, esg) {
    var res;
    if (jaMontado()) { return; }
    if (resultados) {
      if (esg && tgRgEsgotadoPagina(q, cat, esg)) { return; }
      res = runSearch(q, cat, TG_PG_LIMITE);
      if (res.results.length && tgPgMontar(q, cat, res)) { return; }
      if (document.querySelector('.js-product-table')) { return; } // nada nosso para mostrar e a nativa tem resultado: fica a nativa
      tgRgMontar(q, cat, null);
      return;
    }
    if (document.querySelector('.js-product-table')) { return; }
    tgRgMontar(q, cat, esg);
  }
  obterCatalogo().then(function (cat) {
    var res;
    if (!cat) { return; }
    if (curada) {
      if (document.getElementById('tg-busca-curada')) { return; }
      res = runSearch(q, cat, TG_CURADA_PAGINA_LIMITE);
      if (res.curada && tgCuMontar(res)) { return; }
    }
    if (jaMontado() || (!resultados && document.querySelector('.js-product-table'))) { return; }
    // esgotado nominal: baixa o catalogo de esgotados so se a palavra pedida nao casa com nenhuma peca em estoque; falha = resultado de sempre
    if (tgPrecisaEsgotados(q, cat)) {
      return obterEsgotados().then(function (esg) { return seguir(cat, esg); });
    }
    return seguir(cat, null);
  })['catch'](function () {}).then(function () { if (resultados) { devolverNativa(); } tgPend(false); });
}


return { ligarAutocomplete: ligarAutocomplete, ligarResgate: ligarResgate };
}

/* ---- src/injetor/inicio.js ---- */
/*
 * Entrada do injetor. So roda com window.TG_BUSCA_CTX valido, criado pelo carregador do tema (src/tema/tg-busca.js.tpl):
 * { v, versao, modo, catalogo, features }. Nunca le o catalogo de uma global da pagina e nao le a flag (quem decide e o carregador, DP1).
 * features (todas opcionais, ligadas por padrao): autocomplete, resgate e resultados. resultados:false mantem a lista nativa da pagina /search/ (so a tela de resgate).
 * Tudo em try/catch: nenhuma excecao sai daqui.
 */
var tgCtx = null;
var tgCatPromessa = null;
var tgIniciado = false;
var TG_CAT_PREFIXO = /^https:\/\/cdn\.jsdelivr\.net\/gh\/danilo-t4lgu1\/talgui-search-cdn@[A-Za-z0-9._\/-]+$/;

// Depuracao: o UNICO uso de console do injetor, so com tg_debug=1 na URL ou tg_busca_debug=1 no localStorage.
function dbg() {
  try {
    if (/[?&]tg_debug=1(&|$)/.test(window.location.search) || window.localStorage.getItem('tg_busca_debug') === '1') {
      console.info.apply(console, ['[tg-busca]'].concat([].slice.call(arguments)));
    }
  } catch (e) {}
}

function ctxValido(c) {
  var f;
  if (!c || typeof c !== 'object') { return false; }
  f = c.features;
  return typeof c.v === 'number' && c.v >= 1 &&
    typeof c.versao === 'string' && /^[0-9a-f]{7}$/.test(c.versao) &&
    (c.modo === 'preview' || c.modo === 'on') &&
    typeof c.catalogo === 'string' && TG_CAT_PREFIXO.test(c.catalogo) &&
    (f == null || (typeof f === 'object' && !Array.isArray(f))) &&
    (c.grupo == null || c.grupo === 'novo');
}

// Catalogo: uma tentativa por pagina, so quando alguem precisa. Falha fechada: devolve null e avisa a medicao uma vez.
function obterCatalogo() {
  if (!tgCatPromessa) {
    tgCatPromessa = carregarCatalogo(tgCtx.catalogo).then(function (r) {
      if (r.itens) { return r.itens; }
      dbg('catalogo indisponivel', r.motivo);
      emitir('tg_busca_off', { reason: r.motivo, engine_mode: tgCtx.modo, engine_version: tgCtx.versao });
      return null;
    })['catch'](function () { return null; });
  }
  return tgCatPromessa;
}

// Catalogo de esgotados (REL-04): uma tentativa por pagina, so quando a busca pede (tgPrecisaEsgotados) e so depois do catalogo normal. Falha fechada e
// em silencio: sem endereco, rede fora, tempo esgotado, 404, JSON ou formato invalido = null, a busca segue como sempre e NAO emite tg_busca_off
// (o motor continua ligado; so a camada de esgotado fica de fora). Nao guarda nada em global nem no armazenamento da sessao.
var tgEsgPromessa = null;
function obterEsgotados() {
  var url;
  if (!tgEsgPromessa) {
    url = tgCtx ? urlEsgotados(tgCtx.catalogo) : null;
    tgEsgPromessa = url ? carregarCatalogo(url, TG_CAT_TIMEOUT_MS, validarEsgotados).then(function (r) {
      if (r.itens) { return r.itens; }
      dbg('esgotados indisponiveis', r.motivo);
      return null;
    })['catch'](function () { return null; }) : Promise.resolve(null);
  }
  return tgEsgPromessa;
}

function iniciarBusca() {
  var c, f, largura, a, r, frente;
  try {
    if (tgIniciado) { return; }
    c = window.TG_BUSCA_CTX;
    if (!ctxValido(c)) { return; }
    f = c.features || {};
    tgCtx = { versao: c.versao, modo: c.modo, catalogo: c.catalogo, features: f, grupo: c.grupo === 'novo' ? 'novo' : null };
    largura = window.innerWidth || 0;
    if (f.desktop === false && largura >= 768) { return; }
    tgIniciado = true;
    // Tela por aparelho (decidida uma vez): desktop (>= 768 px) usa a frente do desktop (v13); celular usa a do celular.
    // Motor e catalogo sao os mesmos para os dois.
    frente = largura >= 768 ? tgFrenteDesktop() : tgFrenteCelular();
    // v13: as duas telas seguram a lista nativa da /search ate a nossa montar (o resgate de cada uma solta a pendencia)
    if (!/^\/search/.test(window.location.pathname)) { tgPend(false); }
    a = f.autocomplete !== false;
    r = f.resgate !== false;
    emitir('tg_busca_ativa', { engine_version: tgCtx.versao, engine_mode: tgCtx.modo, page_type: /^\/search/.test(window.location.pathname) ? 'search' : 'outra' });
    clarityFila(['set', 'tg_busca', tgCtx.modo]);
    if (!a && !r) { return; }
    if (a) { try { frente.ligarAutocomplete(); } catch (e) { dbg('autocomplete', e); } }
    if (r) { try { frente.ligarResgate(); } catch (e) { dbg('resgate', e); } }
    // QA 5.4 (25/11): a tela (celular ou desktop) e escolhida uma vez. Se a largura cruzar 768 px na pagina de resultados (girar um tablet,
    // redimensionar a janela), a pagina recarrega e monta a tela certa; os filtros estao na URL (tg_tam, tg_cor...), entao continuam aplicados.
    try {
      if (/^\/search/.test(window.location.pathname) && window.matchMedia) {
        (function () {
          var mq = window.matchMedia('(min-width: 768px)'), eraDesk = largura >= 768, t = 0;
          function mudou() { clearTimeout(t); t = setTimeout(function () { try { if (mq.matches !== eraDesk) { window.location.reload(); } } catch (e) {} }, 400); }
          if (mq.addEventListener) { mq.addEventListener('change', mudou); } else if (mq.addListener) { mq.addListener(mudou); }
        })();
      }
    } catch (e) {}
  } catch (e) {}
}

try {
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', iniciarBusca); }
  else { iniciarBusca(); }
} catch (e) {}

})();
