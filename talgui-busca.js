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
var TG_SELO_BEST = 'Best Seller';
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
    if (Object.prototype.hasOwnProperty.call(TG_CATEGORIA_SINONIMOS, k) && k.length >= 6 && levenshtein(qt, k, 1) <= 1) return { cat: TG_CATEGORIA_SINONIMOS[k], exato: false };
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

    for (let t = 0; t < qTokens.length; t++) {
      const qt = qTokens[t];
      const naCor = !!(qCor && t >= qCor.ini && t < qCor.fim);
      const ql = qt.length;
      let matched = false;
      let maxPts = 0;

      for (let n = 0; n < nTokens.length; n++) {
        const nt = nTokens[n];
        if (nt === qt) {
          maxPts = Math.max(maxPts, 12);
          matched = true;
          break;
        } else if (nt.startsWith(qt) || (ql >= 4 && qt.startsWith(nt))) {
          maxPts = Math.max(maxPts, 8);
          matched = true;
        } else {
          const maxD = ql <= 4 ? 1 : 2;
          const d = levenshtein(qt, nt, maxD);
          if (d === 1) { maxPts = Math.max(maxPts, 7); matched = true; }
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
        cr: qCor ? tgRankCor(iCor, qCor) : 0
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
var TG_ESG_SIMILARES = 3;      // similares mostrados no máximo (o Best Seller do tipo entra primeiro, se houver)
var TG_ESG_MIN_TAMANHOS = 3;   // grade cheia = pelo menos 3 tamanhos em estoque
var TG_ESG_FREQ_MAX = 30;      // palavra presente em mais peças esgotadas que isso é genérica demais para pedir esgotado
var TG_ESG_PALAVRA_MIN = 4;    // palavra da busca com menos letras que isso nunca pede esgotado
var TG_SELO_ESGOTADO = 'Grade esgotada';
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

// Peças parecidas em estoque com grade cheia para uma esgotada: mesmo tipo, depois palavras do nome em comum, mesma categoria real e faixa de preço.
// O Best Seller do tipo (a 1ª do catálogo, que é a mais vendida, com t = 1) vem primeiro.
function tgSimilaresEsgotada(esg, catalogo, prep) {
  var tipo = esg.tipo, cand = [], melhor = null, ref, cEsg, pEsg, i, it, nm, comum, k, sc, out, usados;
  if (!tipo) return { itens: [], melhor: null };
  ref = esg.tokens.filter(function (t, n) { return n > 0 && TG_ESG_PALAVRAS_VAZIAS.indexOf(t) < 0; });
  cEsg = normalizeText(esg.item.c);
  if (TG_ESG_CATEGORIAS_IGNORADAS.indexOf(cEsg) >= 0) cEsg = '';
  pEsg = esg.item.p;
  for (i = 0; i < catalogo.length; i++) {
    it = catalogo[i];
    if (!it || typeof it !== 'object' || !tgDisponivel(it) || it.sz.length < TG_ESG_MIN_TAMANHOS || tgTipoPeca(it.n) !== tipo) continue;
    nm = normalizeText(it.n).split(' ');
    comum = 0;
    for (k = 0; k < ref.length; k++) { if (nm.indexOf(ref[k]) >= 0) comum++; }
    sc = comum * 3 + (cEsg && normalizeText(it.c) === cEsg ? 2 : 0) + (typeof pEsg === 'number' && pEsg > 0 && Math.abs(it.p - pEsg) / pEsg <= 0.25 ? 1 : 0);
    cand.push({ item: it, sc: sc, pos: i });
    if (!melhor && it.t === 1) melhor = it;
  }
  cand.sort(function (a, b) { return (b.sc - a.sc) || (a.pos - b.pos); });
  out = melhor ? [melhor] : [];
  usados = melhor ? 1 : 0;
  for (i = 0; i < cand.length && usados < TG_ESG_SIMILARES; i++) {
    if (cand[i].item === melhor) continue;
    out.push(cand[i].item);
    usados++;
  }
  return { itens: out, melhor: melhor };
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
  nSim = Math.max(0, Math.min(sim.itens.length, TG_ESG_SIMILARES, limite - nEsg));
  sim = { itens: sim.itens.slice(0, nSim), melhor: sim.itens.slice(0, nSim).indexOf(sim.melhor) >= 0 ? sim.melhor : null };
  selos = new Map();
  for (k = 0; k < itens.length; k++) selos.set(itens[k], { tipo: 'esgotado', texto: TG_SELO_ESGOTADO });
  for (k = 0; k < sim.itens.length; k++) {
    if (sim.itens[k] === sim.melhor) selos.set(sim.itens[k], { tipo: 'best', texto: TG_SELO_BEST });
    else if (prep.ofertas.get(sim.itens[k])) selos.set(sim.itens[k], prep.ofertas.get(sim.itens[k]));
  }
  res = {
    results: itens.concat(sim.itens), suggestedTerm: null, selos: selos, tamanho: null,
    esgotado: { itens: itens, similares: sim.itens, melhor: sim.melhor, tipo: rank[0].e.tipo, nominais: Object.keys(semEstoque) }
  };
  return res;
}

// 2. Ranqueamento e Busca em Memória
// "esgotados" (opcional): lista do catálogo de esgotados já validada. Só o injetor a passa, e só depois de tgPrecisaEsgotados.
function tgBuscaBase(query, catalog, limit, esgotados) {
  limit = limit || 6;
  let normQ = normalizeText(query);
  const prep = tgPreparar(catalog);
  if (!normQ || normQ.length < 2) {
    const inicio = catalog.slice(0, limit);
    return { query: query, results: inicio, suggestedTerm: null, selos: tgSelosDaBusca(inicio, prep, prep.ofertas), tamanho: null };
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
        curada: { id: cur.id, blocos: cur.blocos, total: cur.total }
      };
    }
  }

  // Esgotado nominal: só com o catálogo de esgotados já validado, sem tamanho na busca e quando a palavra pedida não casa com nenhuma peça em estoque.
  if (esgotados && esgotados.length && !tam && qTokens.length) {
    const esg = tgBuscaEsgotado(qTokens, catalog, prep, esgotados, limit);
    if (esg) { esg.query = query; return esg; }
  }

  let scored;
  if (tam && !qTokens.length) {
    // só tamanho ("tam g"): todas as peças, na ordem do catálogo (ranking de vendas)
    scored = catalog.map(function (item) { return { item: item, score: 1, d: tgDisponivel(item) ? 1 : 0, tp: 1, cr: 0 }; });
  } else {
    scored = tgPontuar(qTokens, normQ, catalog, prep);
  }

  // Ordem: em estoque antes de esgotada; (com cor na busca) tipo completo, depois o tom (pedido, prioridade do grupo, outras); por fim a pontuação.
  // O sort é estável: no empate vale a ordem do catálogo, como na Fase 1.
  scored.sort((a, b) => (b.d - a.d) || (b.tp - a.tp) || (a.cr - b.cr) || (b.score - a.score));

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

  // "Buscando por": o nome da 1ª peça, como na Fase 1. Na busca por tamanho com filtro aplicado quem fala é o aviso do tamanho (tamanho.texto + rotulo).
  let suggested = null, buscandoPor = null;
  if (topResults.length > 0 && !(tamanho && tamanho.aplicado) && normalizeText(topResults[0].n) !== normQ) {
    // so sugere a peca se a cliente digitou o comeco do nome proprio (ou grafia parecida); so o grupo vira "Vestidos" (19/11)
    if (tgCitouNomeProprio(qTokens, topResults[0])) { suggested = topResults[0].n; }
    else if (qTokens.length === 1 && (qTokens[0] === normalizeText(topResults[0].n).split(' ')[0] || qTokens[0] === normalizeText(topResults[0].n).split(' ')[0] + 's')) { buscandoPor = tgPluralGrupo(topResults[0].n.split(' ')[0]); }
  }

  return {
    query: query,
    results: topResults,
    suggestedTerm: suggested,
    buscandoPor: buscandoPor,
    selos: tgSelosDaBusca(topResults, prep, ofertas),
    tamanho: tamanho
  };
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
  if (!normQ || normQ.length < 2 || base.esgotado || base.curada) return base;
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
    if (r.esgotado || r.curada) continue;
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
  return { query: base.query, results: final, suggestedTerm: null, buscandoPor: null, selos: selos, tamanho: base.tamanho };
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
// Chips de ocasiao (ao lado dos de categoria, so na pagina de resultados). A busca casa pelo nome da peca; a marcacao por tags (Wedding etc.) ainda nao existe.
var TG_CHIPS_OCASIAO = [
  { rotulo: 'Casual', consulta: 'casual' },
  { rotulo: 'Eventos', consulta: 'festa' },
  { rotulo: 'Office', consulta: 'office' },
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

// Grupos da pagina de resultados (Danilo, 24/11): ao entrar em Vestidos, Blusas ou Calcas os chips mudam para os do grupo.
// Cada chip casa a peca por TAG (g do catalogo: ex. "midi", "manga-curta", "pantalona", quando o catalogo passar a trazer) ou, enquanto nao ha tag,
// por palavra no nome. Chip sem nenhuma peca no grupo nao aparece (so Novidades fica sempre). Wedding usa a regra dos vestidos Off-White.
var TG_GRUPOS = {
  vestidos: { rotulo: 'Vestidos', tipos: ['vestido', 'vestidos'], chips: [
    { id: 'curtos', rotulo: 'Curtos', tags: ['curto', 'curtos', 'mini'], nomes: ['curto', 'mini'] },
    { id: 'midi', rotulo: 'Midi', tags: ['midi'], nomes: ['midi'] },
    { id: 'longos', rotulo: 'Longos', tags: ['longo', 'longos', 'maxi'], nomes: ['longo', 'maxi'] },
    { id: 'wedding', rotulo: 'Wedding', regra: 'wedding' },
    { id: 'office', rotulo: 'Office', tags: ['office', 'chip:office'], nomes: ['office'] },
    { id: 'eventos', rotulo: 'Eventos', tags: ['eventos', 'evento', 'festa', 'chip:eventos'], nomes: ['festa'] },
    { id: 'novidades', rotulo: 'Novidades', novidades: true }
  ] },
  blusas: { rotulo: 'Blusas', tipos: ['blusa', 'blusas'], chips: [
    { id: 'novidades', rotulo: 'Novidades', novidades: true },
    { id: 'eventos', rotulo: 'Eventos', tags: ['eventos', 'evento', 'festa', 'chip:eventos'], nomes: ['festa'] },
    { id: 'office', rotulo: 'Office', tags: ['office', 'chip:office'], nomes: ['office'] },
    { id: 'manga-curta', rotulo: 'Manga Curta', tags: ['manga-curta', 'manga curta'], nomes: ['manga curta'] },
    { id: 'manga-longa', rotulo: 'Manga Longa', tags: ['manga-longa', 'manga longa'], nomes: ['manga longa'] }
  ] },
  calcas: { rotulo: 'Calças', tipos: ['calca', 'calcas'], chips: [
    { id: 'justa', rotulo: 'Justa', tags: ['justa', 'skinny'], nomes: ['justa', 'skinny'] },
    { id: 'reta', rotulo: 'Reta', tags: ['reta'], nomes: ['reta'] },
    { id: 'pantalona', rotulo: 'Pantalona', tags: ['pantalona'], nomes: ['pantalona'] }
  ] }
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

function foto(item, classe) {
  var src = urlImagem(item && item.i);
  return src ? el('img', { 'class': classe, src: src, alt: item.n, loading: 'lazy', decoding: 'async' }) : null;
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
    pr.de ? el('s', { 'class': 'tg-busca-de' }, [reais(pr.de)]) : null
  ]);
}


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
var TG_TOKENS = [
  // tipografia
  ['--tgb-fonte', 'var(--body-font,"Poppins"),"Poppins",Arial,sans-serif'],
  ['--tgb-fonte-titulo', 'var(--heading-font,"Graphik"),var(--tgb-fonte)'],
  // cores
  ['--tgb-cor-texto', 'var(--main-foreground,#111111)'],
  ['--tgb-cor-texto-suave', '#6f6a64'],
  ['--tgb-cor-fundo', 'var(--main-background,#ffffff)'],
  ['--tgb-cor-fundo-suave', '#f5f2ed'],
  ['--tgb-cor-borda', '#e4dfd8'],
  ['--tgb-cor-destaque', 'var(--accent-color,#000000)'],
  ['--tgb-cor-destaque-texto', '#ffffff'],
  ['--tgb-cor-promo', 'var(--tgb-cor-texto)'],
  ['--tgb-cor-selo-texto', '#111111'],
  ['--tgb-cor-selo-oferta', '#ffffff'],
  ['--tgb-cor-selo-best', '#ffffff'],
  ['--tgb-cor-selo-ultimas', '#ffffff'],
  ['--tgb-cor-selo-esgotado', '#ffffff'],
  ['--tgb-cor-sucesso', 'var(--success,#2e8b63)'],
  ['--tgb-cor-erro', 'var(--danger,#c0392b)'],
  // pagina e grade
  ['--tgb-pad-pagina', '0px'],
  ['--tgb-pad-card', '8px'],
  ['--tgb-gap-grade', '7px'],
  ['--tgb-gap-linha', '13px'],
  ['--tgb-colunas-mobile', '2'],
  ['--tgb-colunas-desktop', '4'],
  ['--tgb-raio-card', '5px'],
  ['--tgb-sombra-card', '0 4px 14px rgba(0,0,0,.12)'],
  ['--tgb-foto-proporcao', '2 / 3'],
  ['--tgb-foto-ajuste', 'cover'],
  ['--tgb-foto-fundo', '#f1eee9'],
  // nome, preco e selo
  ['--tgb-nome-tam', '12px'],
  ['--tgb-nome-peso', '500'],
  ['--tgb-nome-linhas', '1'],
  ['--tgb-nome-transformacao', 'none'],
  ['--tgb-preco-tam', '12.5px'],
  ['--tgb-preco-peso', '400'],
  ['--tgb-preco-de-tam', '11.5px'],
  ['--tgb-selo-tam', '9px'],
  ['--tgb-selo-raio', '0px'],
  ['--tgb-selo-espaco', '0px'],
  // bolinhas de cor, tamanhos, botao e chips
  ['--tgb-bolinha-tam', '18px'],
  ['--tgb-bolinha-gap', '6px'],
  ['--tgb-tamanho-btn', '22px'],
  ['--tgb-tamanho-fonte', '10.5px'],
  ['--tgb-tamanho-gap', '5px'],
  ['--tgb-tamanho-raio', '0'],
  ['--tgb-botao-altura', '28px'],
  ['--tgb-botao-raio', '2px'],
  ['--tgb-botao-fonte', '12.5px'],
  ['--tgb-botao-peso', '600'],
  ['--tgb-botao-transformacao', 'uppercase'],
  ['--tgb-botao-espaco', '0.15em'],
  ['--tgb-chip-tam', '11px'],
  ['--tgb-chip-altura', '28px'],
  ['--tgb-chip-raio', '936px'],
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
  '.tg-busca-oculto,#tg-busca-overlay.tg-busca-oculto{display:none}',
  '.tg-busca-sr{position:absolute!important;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
  'html.tg-busca-trava,html.tg-busca-trava body{overflow:hidden!important}',
  '.tg-busca-nativo-oculto{display:none!important}',
  // enquanto a busca nova nao assumiu (classe no <html>, posta pelo topo do tema ou pela lupa), a lista e as sugestoes da nativa ficam escondidas
  'html.tg-busca-pendente.tg-busca-pg .js-product-table,html.tg-busca-pendente.tg-busca-pg .js-load-more,html.tg-busca-pendente.tg-busca-pg #js-infinite-scroll-spinner,html.tg-busca-pendente #nav-search [class*="search-suggest"],html.tg-busca-pendente #nav-search .search-initial-products{display:none!important}',
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
  '.tg-busca-ov-btn{display:flex;align-items:center;justify-content:center;flex:0 0 42px;width:42px;height:42px;margin:0;padding:0;border:0;border-radius:50%;background:transparent;color:inherit;font-size:26px;line-height:1;cursor:pointer}',
  '.tg-busca-ov-btn:hover{background:var(--tgb-cor-fundo-suave)}',
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
  '.tg-busca-pilula{padding:2px 6px;border:1px solid var(--tgb-cor-borda);border-radius:var(--tgb-tamanho-raio);color:var(--tgb-cor-texto-suave);font-size:10px;font-weight:500;line-height:1.3}',
  '.tg-busca-pilula-pedida{border-color:var(--tgb-cor-destaque);background:var(--tgb-cor-destaque);color:var(--tgb-cor-destaque-texto);font-weight:700}',
  '.tg-busca-item-esgotado .tg-busca-thumb{filter:grayscale(1);opacity:.55}',
  '.tg-busca-bloco-titulo{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:20px 0 8px;font-family:var(--tgb-fonte-titulo);font-size:var(--tgb-ov-titulo-tam);font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--tgb-cor-texto-suave)}',
  '.tg-busca-bloco-qtd{font-weight:500;letter-spacing:.04em}',
  '.tg-busca-todos{display:flex;align-items:center;justify-content:center;width:100%;height:var(--tgb-botao-altura);margin:22px 0 0;border:1px solid var(--tgb-cor-destaque);border-radius:var(--tgb-botao-raio);background:var(--tgb-cor-destaque);color:var(--tgb-cor-destaque-texto);font-size:var(--tgb-botao-fonte);font-weight:var(--tgb-botao-peso);letter-spacing:var(--tgb-botao-espaco);text-transform:var(--tgb-botao-transformacao);text-decoration:none}'
];

var TG_CSS_CARD = [
  '.tg-busca-thumb{display:block;width:100%;height:auto;aspect-ratio:var(--tgb-foto-proporcao);object-fit:var(--tgb-foto-ajuste);background:var(--tgb-foto-fundo);border-radius:var(--tgb-raio-card)}',
  '.tg-busca-nome{display:-webkit-box;word-break:break-word;-webkit-box-orient:vertical;-webkit-line-clamp:var(--tgb-nome-linhas);overflow:hidden;margin:0 0 4px;font-size:var(--tgb-nome-tam);font-weight:var(--tgb-nome-peso);line-height:1.3;text-transform:var(--tgb-nome-transformacao)}',
  '.tg-busca-preco{display:inline-flex;align-items:baseline;flex-wrap:wrap;gap:2px 6px;font-size:var(--tgb-preco-tam)}',
  '.tg-busca-preco strong{font-weight:var(--tgb-preco-peso)}',
  '.tg-busca-preco strong:not(:last-child){color:var(--tgb-cor-promo)}',
  '.tg-busca-de{font-size:var(--tgb-preco-de-tam);font-weight:400;color:var(--tgb-cor-texto-suave);text-decoration:line-through}',
  '.tg-busca-selo{display:inline-block;padding:5px 8px;box-shadow:0 1px 2px rgba(0,0,0,.12);border-radius:var(--tgb-selo-raio);color:var(--tgb-cor-selo-texto);font-size:var(--tgb-selo-tam);font-weight:600;line-height:1;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap}',
  '.tg-busca-selo-campeao{background:var(--tgb-cor-selo-best)}',
  '.tg-busca-selo-ultimas{background:var(--tgb-cor-selo-ultimas)}',
  '.tg-busca-selo-oferta{background:var(--tgb-cor-selo-oferta)}',
  '.tg-busca-selo-esgotado{background:var(--tgb-cor-selo-esgotado)}',
  '.tg-busca-grade{display:grid;grid-template-columns:repeat(var(--tgb-colunas-mobile),minmax(0,1fr));gap:var(--tgb-gap-linha) var(--tgb-gap-grade);margin:0;padding:0;text-align:left}',
  '.tg-busca-grade.tg-busca-grade-um{grid-template-columns:minmax(0,1fr)}',
  '.tg-busca-card{position:relative;display:flex;flex-direction:column;min-width:0;padding:var(--tgb-pad-card);border-radius:var(--tgb-raio-card);box-shadow:var(--tgb-sombra-card);background:var(--tgb-cor-fundo);color:inherit}',
  '.tg-busca-card-midia{position:relative;display:block}',
  '.tg-busca-card-midia .tg-busca-selo{position:absolute;left:var(--tgb-selo-espaco);bottom:var(--tgb-selo-espaco);pointer-events:none}',
  '.tg-busca-card-link{display:block;color:inherit;text-decoration:none}',
  '.tg-busca-card-texto{margin-top:10px}',
  '.tg-busca-card-esgotado .tg-busca-thumb{filter:grayscale(1);opacity:.55}',
  '.tg-busca-cores-vazio{visibility:hidden}',
  '.tg-busca-cores{display:flex;align-items:center;flex-wrap:wrap;gap:var(--tgb-bolinha-gap);min-height:var(--tgb-bolinha-tam);margin:10px 0 0}',
  '.tg-busca-bolinha{position:relative;flex:0 0 auto;width:var(--tgb-bolinha-tam);height:var(--tgb-bolinha-tam);margin:0;padding:0;border:1px solid rgba(0,0,0,.2);border-radius:50%;background:#cfcac3;cursor:pointer}',
  '.tg-busca-bolinha::after{content:"";position:absolute;top:-7px;right:-4px;bottom:-7px;left:-4px}',
  '.tg-busca-bolinha[data-cor="outro"]{background:conic-gradient(#d9a7b0,#e9d28a,#9ec8a6,#9cb7e0,#d9a7b0)}',
  '.tg-busca-bolinha-atual{box-shadow:0 0 0 2px var(--tgb-cor-fundo),0 0 0 3px var(--tgb-cor-texto)}',
  '.tg-busca-bolinha-esgotada::before{content:"";position:absolute;top:0;right:0;bottom:0;left:0;border-radius:50%;background:linear-gradient(135deg,transparent 45%,rgba(0,0,0,.6) 46%,rgba(0,0,0,.6) 54%,transparent 55%)}',
  '.tg-busca-bolinha-mais{width:auto;height:auto;border:0;border-radius:0;background:none;color:var(--tgb-cor-texto-suave);font-size:11px}',
  '.tg-busca-bolinha-mais::after{display:none}',
  // tamanhos no padrao da pagina de categoria: abaixo do nome, alinhados a esquerda, quadradinhos de 22px com borda fina, preco depois
  '.tg-busca-tams{display:flex;flex-wrap:wrap;justify-content:flex-start;gap:var(--tgb-tamanho-gap);margin:7px 0 0}',
  '.tg-busca-tam{position:relative;flex:0 0 auto;min-width:var(--tgb-tamanho-btn);height:var(--tgb-tamanho-btn);margin:0;padding:0 3px;display:flex;align-items:center;justify-content:center;border:1px solid #555;border-radius:var(--tgb-tamanho-raio);background:var(--tgb-cor-fundo);color:var(--tgb-cor-texto);font-size:var(--tgb-tamanho-fonte);font-weight:400;text-transform:uppercase;line-height:1;cursor:pointer}',
  '.tg-busca-tam::after{content:"";position:absolute;top:-4px;right:-3px;bottom:-4px;left:-3px}',
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
  '.tg-busca-add[aria-disabled="true"]{border-color:var(--tgb-cor-borda);background:var(--tgb-cor-fundo);color:var(--tgb-cor-texto-suave)}',
  '.tg-busca-add.tg-busca-add-ok{border-color:var(--tgb-cor-sucesso);background:var(--tgb-cor-sucesso);color:#fff}',
  '.tg-busca-msg{margin:6px 0 0;font-size:11.5px;color:var(--tgb-cor-erro)}',
  '.tg-busca-msg:empty{display:none}',
  '.tg-busca-chips{display:flex;flex-wrap:wrap;gap:var(--tgb-chip-gap);margin:0;padding:0;list-style:none}',
  '.tg-busca-chip{display:inline-flex;align-items:center;flex:0 0 auto;min-height:var(--tgb-chip-altura);margin:0;padding:0 16px;border:1px solid var(--tgb-cor-borda);border-radius:var(--tgb-chip-raio);background:var(--tgb-cor-fundo);color:var(--tgb-cor-texto);font-size:var(--tgb-chip-tam);text-decoration:none;white-space:nowrap;cursor:pointer}',
  '.tg-busca-chip:hover{border-color:var(--tgb-cor-texto)}',
  '.tg-busca-chip-ativo{border-color:var(--tgb-cor-destaque);background:var(--tgb-cor-destaque);color:var(--tgb-cor-destaque-texto)}'
];

var TG_CSS_PAGINA = [
  '#tg-busca-resultados{max-width:1400px;margin:0 auto;padding:0 var(--tgb-pad-pagina) 36px}',
  '.tg-busca-pg-titulo{margin:18px 0 4px;font-family:var(--tgb-fonte-titulo);font-size:20px;font-weight:600;line-height:1.25}',
  '.tg-busca-voce{margin:16px 0 4px;padding:0 12px;text-align:center;font-family:var(--tgb-fonte-titulo);font-size:11.5px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:var(--tgb-cor-texto-suave);line-height:1.5}',
  '.tg-busca-voce strong{font-weight:700;color:var(--tgb-cor-texto)}',
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
  '.tg-busca-togg button{display:flex;align-items:center;justify-content:center;gap:2px;width:34px;height:34px;margin:0;padding:0;border:0;border-radius:4px;background:none;color:var(--tgb-cor-texto);opacity:.38;cursor:pointer}',
  '.tg-busca-togg button[aria-pressed="true"]{opacity:1;background:var(--tgb-cor-fundo-suave)}',
  '.tg-busca-togg-q{display:block;width:6px;height:14px;border-radius:1px;background:currentColor}',
  '.tg-busca-togg-1 .tg-busca-togg-q{width:14px}',
  '.tg-busca-chips-linha{flex-wrap:nowrap;overflow-x:auto;margin:0 0 18px;padding:2px 0 4px;-webkit-overflow-scrolling:touch;scrollbar-width:none}',
  '.tg-busca-chips-linha::-webkit-scrollbar{display:none}',
  '.tg-busca-mais{display:block;min-width:230px;height:var(--tgb-botao-altura);margin:30px auto 0;padding:0 24px;border:1px solid var(--tgb-cor-texto);border-radius:var(--tgb-botao-raio);background:var(--tgb-cor-fundo);color:var(--tgb-cor-texto);font-size:var(--tgb-botao-fonte);font-weight:var(--tgb-botao-peso);letter-spacing:var(--tgb-botao-espaco);text-transform:var(--tgb-botao-transformacao);cursor:pointer}',
  // pagina de busca curada (blocos) e estado sem resultado
  '.tg-busca-curada{max-width:1400px;margin:20px auto;padding:0 var(--tgb-pad-pagina)}',
  '.tg-busca-curada .tg-busca-bloco-titulo{margin:0 0 14px;padding:0 0 10px;border-bottom:2px solid var(--tgb-cor-texto);font-size:16px;letter-spacing:.06em;color:var(--tgb-cor-texto)}',
  '.tg-busca-curada .tg-busca-bloco{margin-bottom:30px}',
  '.tg-busca-zero{max-width:1100px;margin:28px auto;padding:0 var(--tgb-pad-pagina);text-align:center}',
  '.tg-busca-zero-titulo{margin:0 0 8px;font-family:var(--tgb-fonte-titulo);font-size:20px;font-weight:600;line-height:1.25}',
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
  '@media (prefers-reduced-motion:reduce){#tg-busca-overlay.tg-busca-aberto,.tg-busca-card-pede .tg-busca-tams{animation:none}}',
  // celular (95% do publico): campo com 16px (o iPhone nao da zoom), toque sem atraso, area segura, sem rolagem lateral
  '@media (max-width:1023px){' +
    '.tg-busca-ov-campo{font-size:16px}' +
    '#tg-busca-overlay a,#tg-busca-overlay button,#tg-busca-resultados a,#tg-busca-resultados button{touch-action:manipulation;-webkit-tap-highlight-color:transparent}' +
    '.tg-busca-ov-form{padding-top:env(safe-area-inset-top,0px);height:calc(var(--tgb-ov-campo-altura) + env(safe-area-inset-top,0px))}' +
    '.tg-busca-ov-corpo{overflow-x:hidden;padding:0 12px calc(28px + env(safe-area-inset-bottom,0px))}' +
    '.tg-busca-secao-titulo{margin:18px 0 8px}' +
    '.tg-busca-chip{min-height:36px;padding:0 14px;font-size:12px}' +
    '.tg-busca-chips{gap:6px}' +
    '.tg-busca-chips-linha{gap:6px;margin:0 -2px 14px;padding:2px 2px 6px}' +
    '.tg-busca-termo{min-height:50px}' +
    '.tg-busca-barra-btn{height:44px;padding:0 6px;font-size:12px}' +
    '.tg-busca-mais{width:100%;min-width:0;height:44px}' +
    '.tg-busca-tp .tg-busca-nome{font-size:12px}' +
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
    ':root{--tgb-qv-chip-tam:42px;--tgb-qv-foto-larg:180px;--tgb-qv-largura-desk:680px;--tgb-qv-pad:8px;--tgb-qv-preco-tam:14.5px;--tgb-qv-raio:4px;--tgb-qv-raio-desk:13px;--tgb-qv-scrim:rgba(0,0,0,.65);--tgb-qv-tamanho-btn:40px}'
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
    vs.push({ id: id, o0: tgQvTexto(v.option0), o1: tgQvTexto(v.option1), ok: v.available === true, p: tgQvNumPositivo(v.price_number), c: tgQvNumPositivo(v.compare_at_price_number) });
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
  return { ok: true, productId: produtoId, cor: cor, preco: precoV ? precoV.p : null, precoDe: de, fotos: fotos, tamanhos: tamanhos, url: item ? urlProduto(item.s) : null };
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
function tgAdicionarSacola(variantId, qtd, opcoes) {
  return new Promise(function (resolve) {
    var vid = tgQvIdOk(variantId), n = tgQvQtdOk(qtd === undefined ? 1 : qtd), pid = null, w, ls, acao = '/comprar/', ex, form, fim = false, timer = 0;
    function sair(r) {
      if (fim) { return; }
      fim = true;
      clearTimeout(timer);
      if (r.ok) {
        try { tgQvFechar('sacola'); } catch (e) {}
        try { if (opcoes && typeof opcoes.antesDeAbrir === 'function') { opcoes.antesDeAbrir(); } } catch (e) {}
        if (!opcoes || opcoes.abrirSacola !== false) { setTimeout(tgAbrirSacolaDoTema, 80); }
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
  var pad = V('qv-pad', '16px'), btnAlt = V('botao-altura', '48px'), btnRaio = V('botao-raio', '0px');
  var tam = V('qv-tamanho-btn', '38px'), chip = V('qv-chip-tam', '34px');
  return [
    P + 'raiz{position:fixed;top:0;right:0;bottom:0;left:0;z-index:' + TG_QV_Z + ';display:flex;align-items:flex-end;justify-content:center;font-family:' + fonte + ';color:' + texto + ';font-size:14px;line-height:1.4;-webkit-text-size-adjust:100%;text-align:left}',
    R + '*{box-sizing:border-box}',
    P + 'fundo{position:absolute;top:0;right:0;bottom:0;left:0;background:' + V('qv-scrim', 'rgba(0,0,0,.4)') + ';animation:tg-busca-qv-fade .2s ease}',
    P + 'painel{position:relative;display:flex;flex-direction:column;width:100%;max-height:' + V('qv-altura-max', '92vh') + ';background:' + fundo + ';border-radius:' + V('qv-raio', '14px') + ' ' + V('qv-raio', '14px') + ' 0 0;overflow:hidden;animation:tg-busca-qv-sobe .28s ease}',
    P + 'painel[data-arrastando="true"]{animation:none}',
    P + 'cab{flex:none;display:grid;grid-template-columns:1fr auto;align-items:center;gap:0 8px;padding:10px ' + pad + ' 8px;border-bottom:1px solid ' + linha + '}',
    P + 'alca{grid-column:1/-1;display:flex;align-items:center;justify-content:center;height:16px;margin:-6px calc(-1*' + pad + ') 0;touch-action:none}',
    P + 'alca span{display:block;width:40px;height:4px;border-radius:4px;background:#d4d4d4}',
    R + 'h2' + P + 'titulo{margin:0;padding:0;min-width:0;font-family:inherit;font-size:14px;font-weight:500;line-height:1.3;letter-spacing:normal;text-transform:uppercase;color:' + texto + ';display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
    R + 'button' + P + 'fechar{display:flex;align-items:center;justify-content:center;width:44px;height:44px;margin:0;padding:0;border:0;border-radius:50%;background:#f2f2f2;color:' + texto + ';font:inherit;font-size:20px;line-height:1;cursor:pointer;-webkit-appearance:none;appearance:none}',
    R + 'button:focus-visible,' + R + 'a:focus-visible{outline:2px solid #000;outline-offset:2px}',
    P + 'rolagem{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:0 ' + pad + ' 8px}',
    P + 'gal{margin:12px calc(-1*' + pad + ') 0;min-width:0}',
    P + 'palco{position:relative;min-width:0}',
    P + 'trilho{position:relative;display:flex;gap:6px;min-width:0;overflow-x:auto;overscroll-behavior-x:contain;scroll-snap-type:x mandatory;scroll-padding-left:' + pad + ';padding:0 ' + pad + ';scrollbar-width:none}',
    P + 'trilho::-webkit-scrollbar{display:none}',
    P + 'quadro{flex:0 0 ' + V('qv-foto-larg', '150px') + ';min-width:0;aspect-ratio:' + V('qv-foto-proporcao', '2 / 3') + ';overflow:hidden;scroll-snap-align:start;background:#f2f2f2}',
    R + P + 'quadro img{display:block;width:100%;max-width:none;height:100%;object-fit:cover}',
    P + 'conta,' + P + 'minis{display:none}',
    P + 'inf{display:grid;grid-template-columns:minmax(0,1fr);align-content:start;min-width:0;padding:14px 0 6px}',
    P + 'inf>*{min-width:0}',
    P + 'preco{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;margin:0;font-size:' + V('qv-preco-tam', '16px') + ';font-weight:' + V('qv-preco-peso', '600') + ';line-height:1.3}',
    P + 'preco s{font-size:13px;font-weight:400;color:' + suave + '}',
    P + 'rotulo{margin:16px 0 8px;font-size:12px;font-weight:500;line-height:1.3;text-transform:uppercase;letter-spacing:.02em}',
    P + 'rotulo span{font-weight:400;text-transform:none;letter-spacing:0;color:' + suave + '}',
    P + 'cores,' + P + 'tamanhos{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}',
    P + 'cores{gap:8px}',
    R + 'button' + P + 'cor{position:relative;display:block;width:' + chip + ';height:' + chip + ';margin:0;padding:2px;border:1px solid transparent;border-radius:50%;background:none;cursor:pointer;-webkit-appearance:none;appearance:none}',
    R + 'button' + P + 'cor[aria-pressed="true"]{border-color:' + dest + '}',
    R + P + 'cor img,' + R + P + 'cor-sem{display:block;width:100%;height:100%;border-radius:50%;object-fit:cover;background:#e9e9e9;box-shadow:inset 0 0 0 1px rgba(0,0,0,.15)}',
    R + 'button' + P + 'cor-esg img{opacity:.4}',
    R + 'button' + P + 'tam{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;min-width:' + tam + ';height:' + tam + ';margin:0;padding:0 8px;border:1px solid ' + borda + ';border-radius:0;background:' + fundo + ';color:' + texto + ';font-family:inherit;font-size:12.5px;font-weight:400;line-height:1;letter-spacing:normal;text-transform:none;font-variant-numeric:tabular-nums;cursor:pointer;-webkit-appearance:none;appearance:none}',
    R + 'button' + P + 'tam[aria-pressed="true"]{background:' + dest + ';border-color:' + dest + ';color:#fff}',
    R + 'button' + P + 'tam-esg{color:#a6a6a6;border-color:#e1e1e1;background:' + fundo + ' linear-gradient(to top right,transparent calc(50% - .5px),#c4c4c4 50%,transparent calc(50% + .5px));cursor:not-allowed}',
    P + 'esq{display:flex;gap:6px}',
    P + 'esq i{display:block;width:' + tam + ';height:' + tam + ';background:#eee;animation:tg-busca-qv-pulsa 1.2s ease-in-out infinite}',
    P + 'msg{min-height:18px;margin:10px 0 0;font-size:12px;line-height:1.4;color:' + suave + '}',
    P + 'msg-erro{color:' + erro + '}',
    P + 'pe{flex:none;display:grid;gap:4px;padding:12px ' + pad + ' calc(12px + env(safe-area-inset-bottom,0px));border-top:1px solid ' + linha + ';background:' + fundo + '}',
    R + 'button' + P + 'add{display:flex;align-items:center;justify-content:center;width:100%;min-height:' + btnAlt + ';margin:0;padding:0 16px;border:1px solid ' + dest + ';border-radius:' + btnRaio + ';background:' + dest + ';color:#fff;font-family:inherit;font-size:14px;font-weight:500;line-height:1.2;letter-spacing:normal;text-transform:none;cursor:pointer;-webkit-appearance:none;appearance:none}',
    R + 'button' + P + 'add:disabled{background:#e6e6e6;border-color:#e6e6e6;color:#8a8a8a;cursor:not-allowed}',
    R + 'a' + P + 'pagina{display:flex;align-items:center;justify-content:center;min-height:36px;padding:6px 0;color:' + texto + ';font-size:13px;line-height:1.3;text-decoration:underline;text-underline-offset:3px}',
    R + 'a' + P + 'pagina-prim{min-height:' + btnAlt + ';border:1px solid ' + dest + ';border-radius:' + btnRaio + ';background:' + dest + ';color:#fff;font-weight:500;text-decoration:none}',
    P + 'peca{display:grid;grid-template-columns:' + V('qv-peca-foto', '84px') + ' minmax(0,1fr);gap:0 12px;padding:14px 0;border-bottom:1px solid ' + linha + '}',
    P + 'peca:last-child{border-bottom:0}',
    P + 'peca-foto{display:block;align-self:start;aspect-ratio:2 / 3;overflow:hidden;background:#f2f2f2}',
    R + P + 'peca-foto img{display:block;width:100%;max-width:none;height:100%;object-fit:cover}',
    P + 'peca-inf{min-width:0}',
    R + 'a' + P + 'peca-nome{display:block;margin:0 0 4px;color:' + texto + ';font-size:13px;font-weight:500;line-height:1.35;text-decoration:none}',
    P + 'peca-inf ' + P + 'rotulo{margin:10px 0 6px}',
    P + 'total{margin:0;font-size:13px;color:' + suave + ';text-align:center}',
    '@keyframes tg-busca-qv-sobe{from{transform:translateY(24px);opacity:.6}}',
    '@keyframes tg-busca-qv-fade{from{opacity:0}}',
    '@keyframes tg-busca-qv-pulsa{50%{opacity:.5}}',
    '@media (prefers-reduced-motion:reduce){' + P + 'painel,' + P + 'fundo,' + P + 'esq i{animation:none}}',
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
    R + 'button' + P + 'mini{flex:none;width:44px;height:56px;margin:0;padding:0;border:1px solid transparent;border-radius:0;background:none;cursor:pointer;-webkit-appearance:none;appearance:none}',
    R + 'button' + P + 'mini[aria-current="true"]{border-color:' + texto + '}',
    R + P + 'mini img{display:block;width:100%;max-width:none;height:100%;object-fit:cover}',
    P + 'inf{grid-area:inf;overflow-y:auto;overscroll-behavior:contain;padding:14px ' + pad + ' 6px}',
    P + 'pe{grid-area:pe}',
    P + 'painel-conj{display:flex;flex-direction:column;width:min(' + V('qv-conj-largura-desk', '560px') + ',94vw)}',
    P + 'painel-conj ' + P + 'rolagem{display:block;flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:0 ' + pad + ' 8px}',
    '}'
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
    if (lista[i].offsetParent === null && !(lista[i].getClientRects && lista[i].getClientRects().length)) { continue; }
    out.push(lista[i]);
  }
  return out;
}

function tgQvFechar(motivo) {
  var S = tgQvAtivo;
  if (!S) { return; }
  tgQvAtivo = null;
  try { document.removeEventListener('keydown', S.teclas, true); } catch (e) {}
  try { if (S.raiz && S.raiz.parentNode) { S.raiz.parentNode.removeChild(S.raiz); } } catch (e) {}
  try { document.body.style.overflow = S.overflowCorpo; document.documentElement.style.overflow = S.overflowHtml; } catch (e) {}
  S.fechado = true;
  try { if (S.foco && S.foco.focus && document.contains(S.foco)) { S.foco.focus({ preventScroll: true }); } } catch (e) {}
  try { if (typeof S.opcoes.aoFechar === 'function') { S.opcoes.aoFechar(motivo || 'fechar'); } } catch (e) {}
}

function tgQuickViewAbrir(item, opcoes) {
  var S, raiz, fundo, painel, cab, titulo, bFechar, rolagem, gal, inf, pe, bAdd, aPagina;
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
      botoesTam: [], fechado: false
    };
    tgQvAtivo = S;

    raiz = tgQvNo('div', 'tg-busca-qv-raiz', null, { id: 'tg-busca-qv' });
    fundo = tgQvNo('div', 'tg-busca-qv-fundo');
    painel = tgQvNo('div', 'tg-busca-qv-painel', null, { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tg-busca-qv-titulo' });
    titulo = tgQvNo('h2', 'tg-busca-qv-titulo', [item.n], { id: 'tg-busca-qv-titulo' });
    bFechar = tgQvNo('button', 'tg-busca-qv-fechar', ['×'], { type: 'button', 'aria-label': 'Fechar' });
    cab = tgQvNo('div', 'tg-busca-qv-cab', [tgQvNo('div', 'tg-busca-qv-alca', [el('span')]), titulo, bFechar]);
    gal = tgQvNo('div', 'tg-busca-qv-gal');
    inf = tgQvNo('div', 'tg-busca-qv-inf');
    rolagem = tgQvNo('div', 'tg-busca-qv-rolagem', [gal, inf]);
    bAdd = tgQvNo('button', 'tg-busca-qv-add', ['Adicionar à sacola'], { type: 'button' });
    aPagina = tgQvNo('a', 'tg-busca-qv-pagina', ['Ver página completa'], { href: urlProduto(item.s) });
    pe = tgQvNo('div', 'tg-busca-qv-pe', [bAdd, aPagina]);
    painel.appendChild(cab); painel.appendChild(rolagem); painel.appendChild(pe);
    raiz.appendChild(fundo); raiz.appendChild(painel);
    S.raiz = raiz; S.painel = painel; S.titulo = titulo; S.gal = gal; S.inf = inf; S.bAdd = bAdd; S.aPagina = aPagina; S.bFechar = bFechar;

    fundo.addEventListener('click', function () { tgQvFechar('fundo'); });
    bFechar.addEventListener('click', function () { tgQvFechar('botao'); });
    bAdd.addEventListener('click', function () { tgQvAdicionar(S); });
    aPagina.addEventListener('click', function () { tgQvEmitir(S, 'tg_qv_ver_pagina'); });
    S.teclas = function (ev) {
      var f, a;
      if (S.fechado) { return; }
      if (ev.key === 'Escape' || ev.keyCode === 27) { ev.preventDefault(); ev.stopPropagation(); tgQvFechar('esc'); return; }
      if (ev.key === 'Tab' || ev.keyCode === 9) {
        f = tgQvFocaveis(S.painel);
        if (!f.length) { ev.preventDefault(); return; }
        a = document.activeElement;
        if (!S.painel.contains(a)) { ev.preventDefault(); f[0].focus(); return; }
        if (ev.shiftKey && a === f[0]) { ev.preventDefault(); f[f.length - 1].focus(); } else if (!ev.shiftKey && a === f[f.length - 1]) { ev.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener('keydown', S.teclas, true);
    tgQvArrastar(S, cab);

    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    document.body.appendChild(raiz);
    try { bFechar.focus({ preventScroll: true }); } catch (e) {}
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
  trilho = tgQvNo('div', 'tg-busca-qv-trilho', null, { role: 'group', 'aria-label': 'Fotos de ' + S.item.n });
  fotos.forEach(function (u, k) {
    var q = tgQvNo('div', 'tg-busca-qv-quadro', [el('img', { src: u, alt: k === 0 ? S.item.n : '', loading: k < 2 ? 'eager' : 'lazy', decoding: 'async' })]);
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
        var passo = quadros[0].offsetWidth + 0, k;
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
  if (S.erro) { S.bAdd.style.display = 'none'; S.aPagina.setAttribute('class', 'tg-busca-qv-pagina tg-busca-qv-pagina-prim'); } else {
    S.bAdd.style.display = '';
    S.aPagina.setAttribute('class', 'tg-busca-qv-pagina');
  }
  if (S.ocupado) { texto = 'Adicionando…'; } else if (esgotada) { texto = 'Peça esgotada nesta cor'; } else { texto = 'Adicionar à sacola'; }
  S.bAdd.textContent = texto;
  if (pronto && !S.ocupado) { S.bAdd.removeAttribute('disabled'); S.bAdd.removeAttribute('aria-disabled'); } else { S.bAdd.setAttribute('disabled', 'disabled'); S.bAdd.setAttribute('aria-disabled', 'true'); }
  if (S.msgEl) {
    S.msgEl.textContent = S.msg || (d && !S.tam && S.algumDisponivel ? 'Escolha um tamanho para adicionar à sacola.' : '');
    S.msgEl.setAttribute('class', 'tg-busca-qv-msg' + (S.msgErro ? ' tg-busca-qv-msg-erro' : ''));
  }
  try { S.aPagina.setAttribute('href', urlProduto(S.item.s)); } catch (e) {}
}

function tgQvPintar(S) {
  var d = S.dados, cores, nomeCor, rot, lista, i, x, b, idx, tams, foco = null, focoCor = null, ativo;
  if (S.fechado) { return; }
  ativo = document.activeElement;
  if (ativo && ativo.getAttribute && S.inf.contains(ativo)) { focoCor = ativo.getAttribute('data-qv-cor'); }
  S.titulo.textContent = S.item.n;
  tgQvPintarGaleria(S);
  S.inf.textContent = '';
  rot = tgQvPreco(S);
  if (rot) { S.inf.appendChild(rot); }
  // cores (irmaos) e rotulo da cor atual
  nomeCor = d && d.cor ? d.cor : tgQvRotuloCor(S.item, S.irmaos);
  if (S.irmaos.length > 1) {
    S.inf.appendChild(tgQvNo('p', 'tg-busca-qv-rotulo', ['Cor', nomeCor ? el('span', null, [': ' + nomeCor]) : null]));
    cores = tgQvNo('div', 'tg-busca-qv-cores', null, { role: 'group', 'aria-label': 'Cor' });
    for (i = 0; i < S.irmaos.length; i++) {
      x = S.irmaos[i];
      lista = tgQvRotuloCor(x, S.irmaos) || x.n;
      b = tgQvNo('button', 'tg-busca-qv-cor' + (Array.isArray(x.sz) && !x.sz.length ? ' tg-busca-qv-cor-esg' : ''), [urlImagem(x.i) ? el('img', { src: urlImagem(x.i), alt: '', loading: 'lazy', decoding: 'async' }) : tgQvNo('span', 'tg-busca-qv-cor-sem')], {
        type: 'button', 'aria-pressed': x === S.item ? 'true' : 'false', 'aria-label': 'Cor ' + lista, 'data-qv-cor': x.s
      });
      (function (alvo, pos) {
        b.addEventListener('click', function () {
          if (alvo === S.item || S.ocupado) { return; }
          S.item = alvo;
          tgQvEmitir(S, 'tg_qv_cor', { position: pos });
          tgQvCarregar(S);
          tgQvPintar(S);
        });
        b.addEventListener('mouseenter', function () { tgQuickViewPrefetch(alvo); });
        b.addEventListener('focus', function () { tgQuickViewPrefetch(alvo); });
      })(x, i);
      cores.appendChild(b);
    }
    S.inf.appendChild(cores);
  } else if (nomeCor) {
    S.inf.appendChild(tgQvNo('p', 'tg-busca-qv-rotulo', ['Cor', el('span', null, [': ' + nomeCor])]));
  }
  // tamanhos
  S.rotuloTam = el('span', null, [S.tam ? ': ' + S.tam : '']);
  if (!S.erro) { S.inf.appendChild(tgQvNo('p', 'tg-busca-qv-rotulo', ['Tamanho', S.rotuloTam])); }
  tams = S.erro ? null : tgQvPintarTamanhos(S);
  if (tams) { S.inf.appendChild(tams); }
  S.msgEl = tgQvNo('p', 'tg-busca-qv-msg', null, { role: 'status', 'aria-live': 'polite' });
  S.inf.appendChild(S.msgEl);
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
  var d = S.dados, t, i, escolhido = null;
  if (!d || !S.tam || S.ocupado) { return; }
  for (i = 0; i < d.tamanhos.length; i++) { t = d.tamanhos[i]; if (t.rotulo === S.tam && t.disponivel) { escolhido = t; } }
  if (!escolhido) { return; }
  S.ocupado = true; S.msg = ''; S.msgErro = false;
  tgQvAtualizarRodape(S);
  tgAdicionarSacola(escolhido.variantId, 1, { productId: d.productId }).then(function (r) {
    if (r && r.ok) { tgQvEmitir(S, 'tg_qv_add', { reason: 'ok' }); return; }
    if (S.fechado) { return; }
    S.ocupado = false;
    tgQvEmitir(S, 'tg_qv_add', { reason: r && r.motivo === 'recusado' ? 'recusado' : 'erro' });
    if (r && r.motivo === 'recusado') {
      escolhido.disponivel = false; S.tam = null;
      S.msg = 'O tamanho acabou de esgotar. Escolha outro.';
      tgQvPintar(S);
    } else {
      S.msg = 'Não foi possível adicionar agora. Tente de novo ou abra a página da peça.';
      tgQvAtualizarRodape(S);
    }
    S.msgErro = true;
    tgQvAtualizarRodape(S);
  });
}

// ---------------------------------------------------------------- quick view do conjunto (blusa + calca / short)
// Mostra as duas pecas do conjunto, cada uma com seus tamanhos em estoque, e adiciona as duas de uma vez (so com um tamanho em cada).
// Mesmo painel, mesmos estilos e mesma sacola do quick view de uma peca; qualquer falha deixa o link da pagina de cada peca como saida.
function tgQvConjMsg(S) {
  var ok = S.partes.every(function (x) { return x.dados && x.tam; }), carregando = S.partes.some(function (x) { return x.carregando; }), esgotada = S.partes.some(function (x) { return x.dados && !x.algum; }), texto;
  if (S.ocupado) { texto = 'Adicionando…'; } else if (esgotada) { texto = 'Conjunto indisponível'; } else { texto = 'Adicionar conjunto à sacola'; }
  S.bAdd.textContent = texto;
  if (ok && !S.ocupado && !esgotada) { S.bAdd.removeAttribute('disabled'); S.bAdd.removeAttribute('aria-disabled'); } else { S.bAdd.setAttribute('disabled', 'disabled'); S.bAdd.setAttribute('aria-disabled', 'true'); }
  S.msgEl.textContent = S.msg || (!carregando && !ok && !esgotada ? 'Escolha o tamanho de cada peça.' : '');
  S.msgEl.setAttribute('class', 'tg-busca-qv-msg' + (S.msgErro ? ' tg-busca-qv-msg-erro' : ''));
}

function tgQvConjPintarParte(S, x) {
  var d = x.dados, caixa, i, t, b, pr, preco, foto = urlImagem(x.item.i), cab, inf;
  x.botoes = []; x.algum = false;
  x.areaTam.textContent = '';
  if (x.carregando) { x.areaTam.appendChild(tgQvNo('div', 'tg-busca-qv-esq', [el('i'), el('i'), el('i'), el('i')], { role: 'status', 'aria-label': 'Carregando tamanhos' })); return; }
  if (!d) { x.areaTam.appendChild(el('p', { 'class': 'tg-busca-qv-msg tg-busca-qv-msg-erro' }, ['Não conseguimos carregar os tamanhos. Abra a página da peça.'])); return; }
  caixa = tgQvNo('div', 'tg-busca-qv-tamanhos', null, { role: 'group', 'aria-label': 'Tamanho de ' + x.item.n });
  for (i = 0; i < d.tamanhos.length; i++) {
    t = d.tamanhos[i];
    b = tgQvNo('button', 'tg-busca-qv-tam' + (t.disponivel ? '' : ' tg-busca-qv-tam-esg'), [t.rotulo], { type: 'button', 'aria-pressed': x.tam === t.rotulo ? 'true' : 'false', 'data-tamanho': t.rotulo });
    if (!t.disponivel) { b.setAttribute('aria-disabled', 'true'); b.setAttribute('aria-label', t.rotulo + ', esgotado'); } else { x.algum = true; }
    (function (tt) {
      b.addEventListener('click', function () {
        var j;
        if (!tt.disponivel || S.ocupado) { return; }
        x.tam = x.tam === tt.rotulo ? null : tt.rotulo;
        S.msg = ''; S.msgErro = false;
        for (j = 0; j < x.botoes.length; j++) { x.botoes[j].setAttribute('aria-pressed', x.botoes[j].getAttribute('data-tamanho') === x.tam ? 'true' : 'false'); }
        x.rotuloTam.textContent = x.tam ? ': ' + x.tam : '';
        tgQvConjMsg(S);
      });
    })(t);
    x.botoes.push(b); caixa.appendChild(b);
  }
  x.areaTam.appendChild(caixa);
}

function tgQuickViewConjunto(conj, opcoes) {
  var S, raiz, fundo, painel, cab, titulo, bFechar, rolagem, pe, bAdd, msgEl, nomes, partes, k, mc, mb, final, pa, pb, ps = [];
  try {
    if (!conj || !conj.cima || !conj.baixo || !urlProduto(conj.cima.s) || !urlProduto(conj.baixo.s)) { return; }
    opcoes = opcoes && typeof opcoes === 'object' ? opcoes : {};
    if (tgQvAtivo) { tgQvFechar('trocou'); }
    tgQvEstilos();
    S = {
      conj: conj, opcoes: opcoes, ocupado: false, msg: '', msgErro: false, fechado: false,
      origem: typeof opcoes.origem === 'string' && /^[a-z0-9_-]{1,30}$/.test(opcoes.origem) ? opcoes.origem : 'qv',
      foco: document.activeElement, overflowCorpo: document.body.style.overflow, overflowHtml: document.documentElement.style.overflow, seq: 0
    };
    S.partes = [{ item: conj.cima, dados: null, carregando: true, tam: null, botoes: [], algum: false }, { item: conj.baixo, dados: null, carregando: true, tam: null, botoes: [], algum: false }];
    tgQvAtivo = S;
    mc = typeof tgModeloCor === 'function' ? tgModeloCor(conj.cima.n) : { modelo: conj.cima.n, cor: '' };
    mb = typeof tgModeloCor === 'function' ? tgModeloCor(conj.baixo.n) : { modelo: conj.baixo.n, cor: '' };
    raiz = tgQvNo('div', 'tg-busca-qv-raiz', null, { id: 'tg-busca-qv' });
    fundo = tgQvNo('div', 'tg-busca-qv-fundo');
    painel = tgQvNo('div', 'tg-busca-qv-painel tg-busca-qv-painel-conj', null, { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tg-busca-qv-titulo' });
    titulo = tgQvNo('h2', 'tg-busca-qv-titulo', [mc.modelo.replace(/^\S+\s+/, '') + ' + ' + mb.modelo.replace(/^\S+\s+/, '') + (conj.cor ? ' · ' + conj.cor : '')], { id: 'tg-busca-qv-titulo' });
    bFechar = tgQvNo('button', 'tg-busca-qv-fechar', ['×'], { type: 'button', 'aria-label': 'Fechar' });
    cab = tgQvNo('div', 'tg-busca-qv-cab', [tgQvNo('div', 'tg-busca-qv-alca', [el('span')]), titulo, bFechar]);
    rolagem = tgQvNo('div', 'tg-busca-qv-rolagem');
    for (k = 0; k < S.partes.length; k++) {
      (function (x) {
        var pr = precoFinal(x.item), foto = urlImagem(x.item.i), href = urlProduto(x.item.s), inf;
        x.areaTam = tgQvNo('div', 'tg-busca-qv-area');
        x.rotuloTam = el('span', null, ['']);
        inf = tgQvNo('div', 'tg-busca-qv-peca-inf', [
          tgQvNo('a', 'tg-busca-qv-peca-nome', [x.item.n], { href: href }),
          pr ? tgQvNo('p', 'tg-busca-qv-preco', [el('strong', null, [reais(pr.final)]), pr.de ? el('s', null, [reais(pr.de)]) : null]) : null,
          tgQvNo('p', 'tg-busca-qv-rotulo', ['Tamanho', x.rotuloTam]),
          x.areaTam
        ]);
        rolagem.appendChild(tgQvNo('div', 'tg-busca-qv-peca', [
          tgQvNo('a', 'tg-busca-qv-peca-foto', foto ? [el('img', { src: foto, alt: x.item.n, loading: 'eager', decoding: 'async' })] : null, { href: href, 'aria-label': x.item.n, tabindex: '-1' }),
          inf
        ]));
      })(S.partes[k]);
    }
    msgEl = tgQvNo('p', 'tg-busca-qv-msg', null, { role: 'status', 'aria-live': 'polite' });
    rolagem.appendChild(msgEl);
    bAdd = tgQvNo('button', 'tg-busca-qv-add', ['Adicionar conjunto à sacola'], { type: 'button' });
    pa = precoFinal(conj.cima); pb = precoFinal(conj.baixo);
    final = pa && pb ? pa.final + pb.final : 0;
    pe = tgQvNo('div', 'tg-busca-qv-pe', [final ? tgQvNo('p', 'tg-busca-qv-total', ['Conjunto: ' + reais(final)]) : null, bAdd]);
    painel.appendChild(cab); painel.appendChild(rolagem); painel.appendChild(pe);
    raiz.appendChild(fundo); raiz.appendChild(painel);
    S.raiz = raiz; S.painel = painel; S.bAdd = bAdd; S.msgEl = msgEl; S.bFechar = bFechar;
    fundo.addEventListener('click', function () { tgQvFechar('fundo'); });
    bFechar.addEventListener('click', function () { tgQvFechar('botao'); });
    bAdd.addEventListener('click', function () { tgQvConjAdicionar(S); });
    S.teclas = function (ev) {
      var f, a;
      if (S.fechado) { return; }
      if (ev.key === 'Escape' || ev.keyCode === 27) { ev.preventDefault(); ev.stopPropagation(); tgQvFechar('esc'); return; }
      if (ev.key === 'Tab' || ev.keyCode === 9) {
        f = tgQvFocaveis(S.painel);
        if (!f.length) { ev.preventDefault(); return; }
        a = document.activeElement;
        if (!S.painel.contains(a)) { ev.preventDefault(); f[0].focus(); return; }
        if (ev.shiftKey && a === f[0]) { ev.preventDefault(); f[f.length - 1].focus(); } else if (!ev.shiftKey && a === f[f.length - 1]) { ev.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener('keydown', S.teclas, true);
    tgQvArrastar(S, cab);
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    document.body.appendChild(raiz);
    try { bFechar.focus({ preventScroll: true }); } catch (e) {}
    tgQvEmitir(S, 'tg_qv_abrir', { position: 0, results_count: 2 });
    S.partes.forEach(function (x) {
      tgQvConjPintarParte(S, x);
      tgVariantesDoProduto(x.item).then(function (d) {
        if (S.fechado) { return; }
        x.carregando = false;
        x.dados = d && d.ok && d.tamanhos && d.tamanhos.length ? d : null;
        tgQvConjPintarParte(S, x);
        tgQvConjMsg(S);
      });
    });
    tgQvConjMsg(S);
  } catch (e) {
    try { tgQvFechar('erro'); } catch (e2) {}
    try { if (conj && conj.cima && urlProduto(conj.cima.s) && typeof window !== 'undefined') { window.location.assign(urlProduto(conj.cima.s)); } } catch (e3) {}
  }
}

// Adiciona as duas pecas, uma depois da outra (a sacola so abre no fim). Se a segunda falhar, avisa que a primeira ja entrou.
function tgQvConjAdicionar(S) {
  var a = S.partes[0], b = S.partes[1], va = null, vb = null, i, t;
  if (S.ocupado || !a.dados || !b.dados || !a.tam || !b.tam) { return; }
  for (i = 0; i < a.dados.tamanhos.length; i++) { t = a.dados.tamanhos[i]; if (t.rotulo === a.tam && t.disponivel) { va = t; } }
  for (i = 0; i < b.dados.tamanhos.length; i++) { t = b.dados.tamanhos[i]; if (t.rotulo === b.tam && t.disponivel) { vb = t; } }
  if (!va || !vb) { return; }
  S.ocupado = true; S.msg = ''; S.msgErro = false;
  tgQvConjMsg(S);
  tgQvAtivo = null; // o quick view nao pode fechar sozinho entre uma peca e outra
  function voltar() { if (!S.fechado) { tgQvAtivo = S; } }
  function falhar(texto) { voltar(); S.ocupado = false; S.msg = texto; S.msgErro = true; tgQvConjMsg(S); }
  tgAdicionarSacola(va.variantId, 1, { productId: a.dados.productId, abrirSacola: false }).then(function (r1) {
    if (!r1 || !r1.ok) { falhar(r1 && r1.motivo === 'recusado' ? 'O tamanho ' + a.tam + ' de ' + a.item.n + ' acabou de esgotar. Escolha outro.' : 'Não foi possível adicionar agora. Tente de novo ou abra a página de cada peça.'); return; }
    return tgAdicionarSacola(vb.variantId, 1, { productId: b.dados.productId }).then(function (r2) {
      voltar();
      if (r2 && r2.ok) { tgQvEmitir(S, 'tg_qv_add', { reason: 'conjunto' }); if (!S.fechado) { tgQvFechar('sacola'); } return; }
      falhar('Só a primeira peça entrou na sacola (' + a.item.n + '). A segunda não foi adicionada: tente de novo ou abra a página dela.');
    });
  });
}

// Arrastar a alca (celular) para baixo fecha: mais de 1/3 da altura ou velocidade alta.
function tgQvArrastar(S, cab) {
  var y0 = 0, t0 = 0, delta = 0, ativo = false;
  function larga() { return (window.innerWidth || 0) >= 768; }
  cab.addEventListener('touchstart', function (ev) {
    if (larga() || !ev.touches || !ev.touches[0]) { return; }
    ativo = true; y0 = ev.touches[0].clientY; t0 = Date.now(); delta = 0;
    S.painel.setAttribute('data-arrastando', 'true');
  }, { passive: true });
  cab.addEventListener('touchmove', function (ev) {
    if (!ativo || !ev.touches || !ev.touches[0]) { return; }
    delta = Math.max(0, ev.touches[0].clientY - y0);
    S.painel.style.transform = 'translateY(' + delta + 'px)';
  }, { passive: true });
  function fim() {
    if (!ativo) { return; }
    ativo = false;
    S.painel.removeAttribute('data-arrastando');
    S.painel.style.transform = '';
    if (delta > S.painel.offsetHeight / 3 || delta / Math.max(1, Date.now() - t0) > 0.6) { tgQvFechar('arrastar'); }
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
    for (i = 0; i < curadas.length && out.length < TG_AC_TERMOS_MAX; i++) { out.push({ texto: curadas[i] }); }
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
  for (i = 0; i < coresLista.length; i++) { juntar(base + ult + ' ' + cores[coresLista[i]].o); }
  return out;
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
      pilulas(p.sz, 5, extra && extra.tamanhos)
    ])
  ]);
  a.addEventListener('click', function () {
    var ev = { position: posicao, query_len: consulta.length, had_correction: corrigiu ? 'sim' : 'nao', engine_version: tgCtx.versao };
    if (curada) { ev.rescue_type = 'curada'; }
    if (esgotado) { ev.rescue_type = 'esgotado'; }
    tgRecSalvar(consulta);
    try { emitir('tg_busca_sugestao_click', ev); } catch (e) {}
  });
  return el('li', null, [a]);
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
  return el(tag || 'div', { 'class': 'tg-busca-bloco-titulo' }, [el('span', null, [titulo]), el('span', { 'class': 'tg-busca-bloco-qtd' }, [total + (total === 1 ? ' peça' : ' peças')])]);
}

// Esgotado nominal (REL-04): a(s) peca(s) esgotada(s) marcada(s) "Grade esgotada" e, abaixo, as parecidas com grade cheia (o Best Seller do tipo primeiro).
// Mesmos cuidados do resto: so texto, link normal para a PDP, "Ver todos" para a busca da pagina com o que foi digitado.
function tgAcPintarEsgotado(caixa, consulta, res) {
  var e = res.esgotado, extra = { esgotado: true }, grupos = [[e.itens.length === 1 ? 'Peça esgotada' : 'Peças esgotadas', e.itens], ['Opções parecidas com grade completa', e.similares]];
  var blocos = [], n = 0, g, i, li, lis, todos, total;
  for (g = 0; g < grupos.length; g++) {
    lis = [];
    for (i = 0; i < grupos[g][1].length; i++) {
      li = tgAcLinha(grupos[g][1][i], n + 1, consulta, false, res.selos ? (res.selos.get(grupos[g][1][i]) || false) : false, extra);
      if (li) { n++; lis.push(li); }
    }
    if (lis.length) { blocos.push(el('div', { 'class': 'tg-busca-bloco' }, [tgBlocoTitulo(grupos[g][0], lis.length), el('ul', { 'class': 'tg-busca-lista' }, lis)])); }
  }
  if (!n) {
    caixa.appendChild(el('div', { 'class': 'tg-busca-banner' }, ['Não encontramos resultados para "', el('strong', null, [consulta]), '".']));
    caixa.classList.remove('tg-busca-oculto');
    return;
  }
  caixa.appendChild(el('div', { 'class': 'tg-busca-banner' }, ['Grade esgotada para ', el('strong', null, [consulta]), '. Veja opções parecidas com grade completa.']));
  for (i = 0; i < blocos.length; i++) { caixa.appendChild(blocos[i]); }
  total = n;
  todos = el('a', { 'class': 'tg-busca-todos', href: urlBusca(consulta) }, ['Ver todos os resultados (' + total + ')']);
  todos.addEventListener('click', function () {
    tgRecSalvar(consulta);
    try { emitir('tg_busca_ver_todos', { query_len: consulta.length, results_count: total, rescue_type: 'esgotado' }); } catch (err) {}
  });
  caixa.appendChild(todos);
  caixa.classList.remove('tg-busca-oculto');
}

// "res.termos" (opcional, calculado por tgAcDesenhar): sugestoes de termo no topo, antes das pecas.
function tgAcPintar(pegarCaixa, input, consulta, res) {
  var linhas = [], blocos = [], i, b, li, lis, ul, todos, sugerido, botao, caixa = pegarCaixa(), extra, total, termoTodos;
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
    // saida util tambem no overlay: chips Em alta (a pagina de resultados cuida do resto)
    li = tgChipsLista('overlay');
    if (li) { caixa.appendChild(el('div', { 'class': 'tg-busca-secao-titulo' }, ['Em alta'])); caixa.appendChild(li); }
    caixa.classList.remove('tg-busca-oculto');
    return;
  }
  if (res.termos && res.termos.length && !res.curada) { caixa.appendChild(tgAcTermosBloco(res.termos, consulta, input, pegarCaixa)); }
  if (res.tamanho) { caixa.appendChild(tgAcAviso(res.tamanho)); }
  if (res.suggestedTerm) {
    sugerido = res.suggestedTerm;
    botao = el('button', { type: 'button', 'class': 'tg-busca-sugerido' }, [sugerido]);
    botao.addEventListener('click', function () {
      try { input.value = sugerido; tgAcDesenhar(pegarCaixa, input, sugerido); } catch (e) {}
    });
    caixa.appendChild(el('div', { 'class': 'tg-busca-banner' }, ['Buscando por: ', botao]));
  } else if (res.buscandoPor && typeof res.buscandoPor === 'string') {
    // so o grupo digitado: o "Buscando por" fica no grupo (Vestidos), sem sugerir uma peca em particular
    caixa.appendChild(el('div', { 'class': 'tg-busca-banner' }, ['Buscando por: ', el('strong', null, [res.buscandoPor])]));
  }
  if (res.curada) {
    for (i = 0; i < blocos.length; i++) { caixa.appendChild(blocos[i]); }
  } else {
    caixa.appendChild(el('div', { 'class': 'tg-busca-secao-titulo' }, ['Peças']));
    ul = el('ul', { 'class': 'tg-busca-lista' }, linhas);
    caixa.appendChild(ul);
  }
  // "Ver todos": a busca da pagina nao filtra por tamanho, entao na busca por tamanho o link leva so o texto sem o tamanho ("vestido g" -> /search/?q=vestido).
  // Se so sobrou o tamanho ("tam g"), nao ha busca nativa equivalente: o botao nao aparece (a lista acima ja mostra as pecas do tamanho).
  termoTodos = res.tamanho ? (res.tamanho.texto || '') : consulta;
  total = res.curada ? res.curada.total : res.results.length;
  if (termoTodos) {
    todos = el('a', { 'class': 'tg-busca-todos', href: urlBusca(termoTodos) }, ['Ver todos os resultados (' + total + ')']);
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

// Tapete de boas-vindas (Danilo, 24/11): com o campo vazio, 2 Vestidos, 2 Conjuntos, 2 Blusas, 2 Calças e 2 Novidades (o motor escolhe e confere o
// estoque a cada abertura). Todos usam o MESMO card (foto 3/4, cor, nome, preço) e abrem o quick view (conjunto abre o quick view das duas peças).
function tgTapeteAbrir(ev, abrir, no) {
  try { abrir(no); } catch (e) {}
}
function tgTapeteCard(p, irmaosDe, pos, secao) {
  var href = urlProduto(p.s), preco = blocoPreco(p), mc, abrir, f, n, g;
  if (!href || !preco) { return null; }
  mc = tgModeloCor(p.n);
  abrir = function (no) { tgRgAbrirQuickView(p, irmaosDe(p), null, no); try { emitir('tg_busca_tapete_click', { position: pos, reason: secao }); } catch (e) {} };
  f = el('button', { type: 'button', 'class': 'tg-busca-tp-foto', 'aria-label': p.n + ': ver tamanhos' }, [foto(p, 'tg-busca-thumb') || el('span', { 'class': 'tg-busca-thumb' })]);
  n = el('button', { type: 'button', 'class': 'tg-busca-conj-nome' }, [mc.modelo]);
  f.addEventListener('click', function (ev) { tgTapeteAbrir(ev, abrir, f); });
  n.addEventListener('click', function (ev) { tgTapeteAbrir(ev, abrir, n); });
  f.addEventListener('pointerdown', function () { tgRgPrefetch(p); });
  g = el('div', { 'class': 'tg-busca-cores' }, [el('span', { 'class': 'tg-busca-bolinha tg-busca-bolinha-atual', 'data-cor': tgCorSlug(mc.cor), title: mc.cor }), el('span', { 'class': 'tg-busca-conj-cor' }, [mc.cor])]);
  return el('div', { 'class': 'tg-busca-card tg-busca-tp' }, [f, g, el('div', { 'class': 'tg-busca-nome' }, [n]), el('div', { 'class': 'tg-busca-card-preco' }, [preco])]);
}
function tgTapeteConjunto(c, pos) {
  var a = urlProduto(c.cima.s), b = urlProduto(c.baixo.s), pa = precoFinal(c.cima), pb = precoFinal(c.baixo), final, de, mc, mb, nome, preco, abrir, f;
  if (!a || !b || !pa || !pb) { return null; }
  final = pa.final + pb.final;
  de = (pa.de || pb.de) ? (pa.de || pa.final) + (pb.de || pb.final) : 0;
  mc = tgModeloCor(c.cima.n); mb = tgModeloCor(c.baixo.n);
  abrir = function (no) {
    try { if (typeof tgQuickViewConjunto === 'function') { tgQuickViewConjunto(c, { aoFechar: function () { try { if (no && no.focus) { no.focus(); } } catch (e) {} }, origem: 'tapete' }); try { emitir('tg_busca_tapete_click', { position: pos, reason: 'conjuntos' }); } catch (e) {} return; } } catch (e2) {}
    try { window.location.assign(a); } catch (e3) {}
  };
  f = el('button', { type: 'button', 'class': 'tg-busca-tp-foto tg-busca-tp-foto-dupla', 'aria-label': mc.modelo + ' + ' + mb.modelo + ': ver tamanhos' }, [
    foto(c.cima, 'tg-busca-thumb') || el('span', { 'class': 'tg-busca-thumb' }),
    foto(c.baixo, 'tg-busca-thumb') || el('span', { 'class': 'tg-busca-thumb' }),
    el('span', { 'class': 'tg-busca-conj-mais', 'aria-hidden': 'true' }, ['+'])
  ]);
  nome = el('button', { type: 'button', 'class': 'tg-busca-conj-nome' }, [mc.modelo.replace(/^\S+\s+/, '') + ' + ' + mb.modelo.replace(/^\S+\s+/, '')]);
  f.addEventListener('click', function (ev) { tgTapeteAbrir(ev, abrir, f); });
  nome.addEventListener('click', function (ev) { tgTapeteAbrir(ev, abrir, nome); });
  f.addEventListener('pointerdown', function () { tgRgPrefetch(c.cima); tgRgPrefetch(c.baixo); });
  preco = el('span', { 'class': 'tg-busca-preco' }, [el('strong', null, [reais(final)]), de ? el('s', { 'class': 'tg-busca-de' }, [reais(de)]) : null]);
  return el('div', { 'class': 'tg-busca-card tg-busca-tp tg-busca-conj' }, [
    f,
    el('div', { 'class': 'tg-busca-cores' }, [el('span', { 'class': 'tg-busca-bolinha tg-busca-bolinha-atual', 'data-cor': tgCorSlug(c.cor), title: c.cor }), el('span', { 'class': 'tg-busca-conj-cor' }, [c.cor])]),
    el('div', { 'class': 'tg-busca-nome' }, [nome]),
    el('div', { 'class': 'tg-busca-card-preco' }, [preco])
  ]);
}

function tgTapeteSecao(titulo, cards) {
  if (!cards.length) { return null; }
  return el('div', { 'class': 'tg-busca-tapete-secao' }, [el('div', { 'class': 'tg-busca-secao-titulo' }, [titulo]), el('div', { 'class': 'tg-busca-grade tg-busca-tapete-grade' }, cards)]);
}

function tgTapetePreencher(holder, cat) {
  var t, mapa, i, nos = {}, novas, ordem = [], usados = [], tit = { vestidos: 'Vestidos', conjuntos: 'Conjuntos', blusas: 'Blusas', calcas: 'Calças' }, k, cards, sec, espera;
  try {
    if (typeof tgTapete !== 'function' || !holder.parentNode) { return; }
    t = tgTapete(cat);
    mapa = tgGruposCores(cat);
    function irmaosDe(p) { var g = tgGrupoDe(mapa, p); return g && Array.isArray(g.irmaos) ? g.irmaos : [p]; }
    ordem = ['vestidos', 'conjuntos', 'blusas', 'calcas'];
    for (k = 0; k < ordem.length; k++) {
      cards = [];
      if (ordem[k] === 'conjuntos') {
        for (i = 0; i < t.conjuntos.length; i++) { sec = tgTapeteConjunto(t.conjuntos[i], i + 1); if (sec) { cards.push(sec); } }
      } else {
        for (i = 0; i < t[ordem[k]].length; i++) { sec = tgTapeteCard(t[ordem[k]][i], irmaosDe, i + 1, ordem[k]); if (sec) { cards.push(sec); usados.push(t[ordem[k]][i]); } }
      }
      sec = tgTapeteSecao(tit[ordem[k]], cards);
      if (sec) { holder.appendChild(sec); }
    }
    // Novidades (categoria Novidades da Semana): chegam depois, no fim; se a rede falhar, a faixa simplesmente nao aparece
    if (typeof tgPgNovidades === 'function' && typeof tgTapeteNovidades === 'function') {
      espera = el('div', { 'class': 'tg-busca-tapete-secao tg-busca-oculto' });
      holder.appendChild(espera);
      tgPgNovidades().then(function (handles) {
        var lista = tgTapeteNovidades(cat, handles, usados), cs = [], j, c, s2;
        if (!holder.parentNode) { return; }
        for (j = 0; j < lista.length; j++) { c = tgTapeteCard(lista[j], irmaosDe, j + 1, 'novidades'); if (c) { cs.push(c); } }
        s2 = tgTapeteSecao('Novidades', cs);
        if (s2) { holder.replaceChild(s2, espera); }
      })['catch'](function () {});
    }
  } catch (e) {}
}

// Campo vazio: chips "Em alta" e buscas recentes (ou uma dica, se nao houver nada para mostrar).
function tgAcVazio(caixa) {
  var chips = tgChipsLista('overlay'), rec = tgRecLer(), lis = [], i, limpar, topo, holder;
  tgAcLimpar(caixa);
  if (chips) {
    caixa.appendChild(el('div', { 'class': 'tg-busca-secao-titulo' }, ['Em alta']));
    caixa.appendChild(chips);
  }
  holder = el('div', { 'class': 'tg-busca-tapete' });
  caixa.appendChild(holder);
  try { if (typeof obterCatalogo === 'function') { obterCatalogo().then(function (cat) { if (cat) { tgTapetePreencher(holder, cat); } })['catch'](function () {}); } } catch (e) {}
  if (rec.length) {
    limpar = el('button', { type: 'button', 'class': 'tg-busca-limpar' }, ['Limpar']);
    limpar.addEventListener('click', function () { tgRecLimpar(); tgAcVazio(caixa); });
    topo = el('div', { 'class': 'tg-busca-secao-titulo tg-busca-recentes-topo' }, ['Buscas recentes']);
    caixa.appendChild(topo);
    for (i = 0; i < rec.length; i++) {
      lis.push(el('li', null, [el('a', { 'class': 'tg-busca-termo', href: urlBusca(rec[i]) }, [el('span', { 'class': 'tg-busca-ico-lupa', 'aria-hidden': 'true' }), el('span', { 'class': 'tg-busca-termo-texto' }, [rec[i]])])]));
    }
    caixa.appendChild(el('ul', { 'class': 'tg-busca-recentes' }, lis));
    caixa.appendChild(limpar);
  }
  if (!chips && !rec.length) { caixa.appendChild(el('div', { 'class': 'tg-busca-banner' }, ['Digite o tipo da peça, o nome ou a cor.'])); }
  caixa.classList.remove('tg-busca-oculto');
}

// Texto para leitor de tela: quantas pecas apareceram (o resto da lista nao e lido a cada letra).
function tgAcStatus(texto) {
  try { if (tgOv && tgOv.status) { tgOv.status.textContent = texto; } } catch (e) {}
}

// Desenha a resposta para o que esta no campo. Com o overlay aberto, campo curto mostra o estado vazio; fora dele, esconde a caixa.
// O catalogo e baixado so na primeira interacao (L6).
function tgAcDesenhar(pegarCaixa, input, consulta) {
  var existente, caixa;
  if (consulta.length < TG_AC_MIN) {
    caixa = pegarCaixa();
    if (caixa && tgOv && caixa === tgOv.caixa) { tgAcVazio(caixa); tgAcStatus(''); return; }
    existente = document.getElementById('tg-busca-sugestoes');
    if (existente) { tgAcLimpar(existente); existente.classList.add('tg-busca-oculto'); }
    return;
  }
  obterCatalogo().then(function (cat) {
    if (!cat || input.value.trim() !== consulta) { return; }
    function desenhar(res) {
      if (!res.esgotado && !res.curada) { res.termos = tgAcTermos(consulta, cat); }
      tgAcPintar(pegarCaixa, input, consulta, res);
      tgAcStatus(res.esgotado ? 'Grade esgotada. Veja opções parecidas.' : (res.results.length + (res.results.length === 1 ? ' peça encontrada' : ' peças encontradas')));
    }
    // Esgotado nominal: so quando a palavra pedida nao casa com nenhuma peca em estoque (tgPrecisaEsgotados). O catalogo de esgotados e baixado
    // uma vez, sob demanda; se falhar (ou demorar mais que o limite), a busca de sempre aparece, sem nenhum aviso.
    if (tgPrecisaEsgotados(consulta, cat)) {
      return obterEsgotados().then(function (esg) {
        if (input.value.trim() !== consulta) { return; }
        desenhar(runSearch(consulta, cat, TG_AC_LIMITE, esg));
      });
    }
    desenhar(runSearch(consulta, cat, TG_AC_LIMITE));
  })['catch'](function () {});
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
  tgAttr(campo, { name: 'q', placeholder: 'O que você procura?', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search', inputmode: 'search', maxlength: '200' });
  voltar = el('button', { type: 'button', 'class': 'tg-busca-ov-btn tg-busca-ov-voltar', 'aria-label': 'Fechar a busca' }, ['‹']);
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
  campo.addEventListener('input', function () { try { atualizar(false); } catch (e) {} });
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
function tgOvAbrir(valor) {
  var ja;
  if (!tgOv) { tgOvMontar(); }
  ja = tgOv.aberto;
  tgOv.aberto = true;
  tgOv.raiz.classList.remove('tg-busca-oculto');
  tgOv.raiz.classList.add('tg-busca-aberto');
  document.documentElement.classList.add('tg-busca-trava');
  if (typeof valor === 'string' && (!ja || tgOv.campo.value !== valor)) { tgOv.campo.value = valor; }
  tgOv.atualizar(true);
  try { tgOv.campo.focus(); } catch (e) {}
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

function ligarAutocomplete() {
  var inputs = document.querySelectorAll('.js-search-input'), tocou = false, botoes, i;
  if (!inputs || !inputs.length) { return; }
  function primeira() { if (!tocou) { tocou = true; obterCatalogo(); } }
  // Abre o overlay depois que o catalogo carregou (sem catalogo nao ha overlay nem rastro). O texto vem do campo nativo na hora de abrir.
  function abrir(nativo) {
    tgPend(true);
    obterCatalogo().then(function (cat) {
      if (!cat) { tgPend(false); return; }
      tgOvAbrir(nativo.value);
      tgPend(false);
    })['catch'](function () { tgPend(false); });
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
  botoes = document.querySelectorAll('.js-search-button');
  for (i = 0; i < botoes.length; i++) {
    // pointerdown vem antes do click: o pedido do catalogo (L21) sai um pouco mais cedo, sem passar a pedir nada sem interacao (L6)
    botoes[i].addEventListener('pointerdown', function () { try { primeira(); injetarEstilos(); tgPend(true); setTimeout(function () { tgPend(false); }, 5000); } catch (e) {} }, { passive: true });
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
var TG_RG_ESG_LIMITE = 6; // esgotado nominal: ate 3 esgotadas + 3 parecidas
var TG_PG_LIMITE = 1000;  // a pagina de resultados recebe a lista inteira; os cards entram em lotes
var TG_PG_LOTE = 24;
var TG_PG_ESCONDE_NATIVO = true;
var TG_PG_BEST_MAX = 8;   // Best Sellers por categoria: quantas pecas em cada "Mais Vendidos em ..."
var TG_PG_BOLINHAS_MAX = 6;
var TG_PG_ORDENS = [['relevancia', 'Relevância'], ['melhores-ofertas', 'Melhores Ofertas'], ['lancamentos', 'Lançamentos'], ['best-sellers', 'Best Sellers']];
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
          return Promise.resolve(tgAdicionarSacola(t.variantId, 1)).then(function (r) { return { ok: !!(r && r.ok) }; });
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
// Bolinhas de cor dos irmaos do modelo. Menos de 2 cores, ou sem o agrupamento do motor = sem bolinhas.
function tgRgCores(p, op, estado) {
  var g = tgGrupoDe(op && op.mapa, p), lista = [], bolas = [], i, ir, gi, cor, atual, b, mais;
  if (!g || !Array.isArray(g.irmaos)) { return null; }
  atual = typeof normalizeText === 'function' ? normalizeText(g.cor || '') : '';
  for (i = 0; i < g.irmaos.length; i++) {
    ir = g.irmaos[i];
    gi = tgGrupoDe(op.mapa, ir);
    cor = gi && typeof gi.cor === 'string' ? gi.cor : '';
    if (ir && urlProduto(ir.s) && cor) { lista.push({ item: ir, cor: cor }); }
  }
  if (lista.length < 2) { return null; }
  function ligar(botao, item) {
    botao.addEventListener('click', function () { tgRgAbrirQuickView(item, g.irmaos, estado.escolhido, botao); try { emitir('tg_busca_cor_click', { position: op.posicao || 0 }); } catch (e) {} });
    botao.addEventListener('pointerdown', function () { tgRgPrefetch(item); });
    botao.addEventListener('focus', function () { tgRgPrefetch(item); });
  }
  for (i = 0; i < lista.length && i < TG_PG_BOLINHAS_MAX; i++) {
    b = el('button', { type: 'button', 'class': 'tg-busca-bolinha' + (lista[i].item === p || (atual && normalizeText(lista[i].cor) === atual) ? ' tg-busca-bolinha-atual' : '') + (tgDisponivel(lista[i].item) ? '' : ' tg-busca-bolinha-esgotada'), 'data-cor': tgCorSlug(lista[i].cor), 'aria-label': 'Cor ' + lista[i].cor + ': ver tamanhos' + (tgDisponivel(lista[i].item) ? '' : ' (esgotada)') });
    ligar(b, lista[i].item);
    bolas.push(b);
  }
  if (lista.length > TG_PG_BOLINHAS_MAX) {
    mais = el('button', { type: 'button', 'class': 'tg-busca-bolinha tg-busca-bolinha-mais', 'aria-label': 'Ver as ' + lista.length + ' cores' }, ['+' + (lista.length - TG_PG_BOLINHAS_MAX)]);
    ligar(mais, p);
    bolas.push(mais);
  }
  return el('div', { 'class': 'tg-busca-cores', role: 'group', 'aria-label': 'Cores' }, bolas);
}

// Tamanhos em estoque (clicaveis) + botao Adicionar. Devolve [nos] (vazio se a peca nao tem tamanho em estoque).
function tgRgCompra(p, card, estado, op) {
  var tams = [], botoes = [], i, v, add, msg, ocupado = false, href = urlProduto(p.s), destaque = {}, k;
  if (!tgDisponivel(p)) { return []; }
  if (Array.isArray(op && op.destaque)) { for (k = 0; k < op.destaque.length; k++) { if (typeof op.destaque[k] === 'string') { destaque[op.destaque[k].toUpperCase()] = true; } } }
  msg = el('div', { 'class': 'tg-busca-msg', role: 'status', 'aria-live': 'polite' });
  add = el('button', { type: 'button', 'class': 'tg-busca-add', 'aria-disabled': 'true' }, ['Adicionar']);
  function pintarAdd() { add.setAttribute('aria-disabled', estado.escolhido ? 'false' : 'true'); }
  function escolher(rotulo) {
    var j;
    estado.escolhido = estado.escolhido === rotulo ? null : rotulo;
    for (j = 0; j < botoes.length; j++) { botoes[j].setAttribute('aria-pressed', botoes[j].getAttribute('data-tam') === estado.escolhido ? 'true' : 'false'); }
    card.classList.remove('tg-busca-card-pede');
    tgTexto(msg, '');
    pintarAdd();
    if (estado.escolhido) { tgRgPrefetch(p); }
  }
  function ligarTam(b, rotulo) {
    b.addEventListener('click', function () { try { escolher(rotulo); } catch (e) {} });
  }
  for (i = 0; i < p.sz.length && i < 12; i++) {
    v = p.sz[i];
    if (typeof v !== 'string' || !v) { continue; }
    k = el('button', { type: 'button', 'class': 'tg-busca-tam', 'data-tam': v, 'aria-pressed': 'false', 'aria-label': 'Tamanho ' + v }, [v]);
    ligarTam(k, v);
    botoes.push(k);
    tams.push(k);
  }
  if (!tams.length) { return []; }
  // busca por tamanho ("vestido G"): o tamanho pedido ja vem escolhido no card
  for (i = 0; i < botoes.length; i++) { if (destaque[botoes[i].getAttribute('data-tam').toUpperCase()]) { escolher(botoes[i].getAttribute('data-tam')); break; } }
  function falhou(texto) {
    ocupado = false;
    tgTexto(add, 'Adicionar');
    tgTexto(msg, texto);
    if (href) { setTimeout(function () { try { window.location.assign(href); } catch (e) {} }, 1100); }
  }
  add.addEventListener('click', function () {
    if (ocupado) { return; }
    if (!estado.escolhido) {
      card.classList.add('tg-busca-card-pede');
      tgTexto(msg, 'Escolha um tamanho');
      setTimeout(function () { try { card.classList.remove('tg-busca-card-pede'); } catch (e) {} }, 700);
      return;
    }
    ocupado = true;
    tgTexto(add, 'Adicionando…');
    tgRgAdicionar(p, estado.escolhido).then(function (r) {
      if (r && r.ok) {
        ocupado = false;
        add.classList.add('tg-busca-add-ok');
        tgTexto(add, 'Adicionado');
        try { emitir('tg_busca_add_card', { position: op.posicao || 0 }); } catch (e) {}
        setTimeout(function () { try { add.classList.remove('tg-busca-add-ok'); tgTexto(add, 'Adicionar'); } catch (e2) {} }, 2200);
        return;
      }
      falhou(r && r.semTamanho ? 'Esse tamanho acabou. Abrindo a peça…' : 'Não deu para adicionar aqui. Abrindo a peça…');
    })['catch'](function () { falhou('Não deu para adicionar aqui. Abrindo a peça…'); });
  });
  return [el('div', { 'class': 'tg-busca-tams', role: 'group', 'aria-label': 'Tamanhos em estoque' }, tams), add, msg];
}

// Card da peca. "info" (opcional): o selo do motor (false = sem selo; undefined = nao mostra selo nenhum). "tamanhos" (opcional): tamanho pedido na busca.
// "op" (opcional): { mapa (tgAgruparCores), posicao, esgotada: true (card simples, sem tamanhos nem botao) }.
function tgRgCard(p, info, tamanhos, op) {
  var href = urlProduto(p.s), preco = blocoPreco(p), selo, imagem, esgotada, card, estado, filhos, cores, compra, i, pf, pp;
  if (!href || !preco) { return null; }
  op = op || {};
  esgotada = !!op.esgotada || !tgDisponivel(p);
  selo = info === undefined ? null : tgAcSelo(p, info);
  if (!selo && info !== undefined && esgotada) { selo = tgAcSelo(p, { tipo: 'esgotado', texto: typeof TG_SELO_ESGOTADO !== 'undefined' ? TG_SELO_ESGOTADO : 'Grade esgotada' }); }
  imagem = foto(p, 'tg-busca-thumb') || el('span', { 'class': 'tg-busca-thumb' });
  card = el('div', { 'class': esgotada && (op.esgotada || info !== undefined) ? 'tg-busca-card tg-busca-card-esgotado' : 'tg-busca-card' });
  estado = { escolhido: null };
  pf = el('a', { 'class': 'tg-busca-card-link', href: href, 'aria-hidden': 'true' }, [imagem]);
  pf.setAttribute('tabindex', '-1');
  pp = el('a', { 'class': 'tg-busca-card-link tg-busca-card-preco', href: href, 'aria-hidden': 'true' }, [preco]);
  pp.setAttribute('tabindex', '-1');
  filhos = [
    el('div', { 'class': 'tg-busca-card-midia' }, [pf, selo]),
    el('a', { 'class': 'tg-busca-card-link tg-busca-card-texto', href: href }, [el('div', { 'class': 'tg-busca-nome' }, [p.n])])
  ];
  if (!op.esgotada) {
    cores = tgRgCores(p, op, estado);
    // sem outras cores: o espaco das bolinhas fica reservado (o grid nao muda de altura e a peca ja tem onde receber uma cor nova)
    if (!cores) { cores = el('div', { 'class': 'tg-busca-cores tg-busca-cores-vazio', 'aria-hidden': 'true' }); }
    filhos.splice(1, 0, cores);
  }
  if (!op.esgotada) {
    compra = tgRgCompra(p, card, estado, { posicao: op.posicao, destaque: tamanhos });
    // ordem da categoria: nome, tamanhos, preco; depois o botao e a mensagem
    if (compra.length) { filhos.push(compra[0]); filhos.push(pp); } else { filhos.push(pp); }
    for (i = 1; i < compra.length; i++) { filhos.push(compra[i]); }
  } else { filhos.push(pp); }
  for (i = 0; i < filhos.length; i++) { if (filhos[i]) { card.appendChild(filhos[i]); } }
  card.addEventListener('pointerdown', function () { tgRgPrefetch(p); });
  return card;
}

// ---------------------------------------------------------------- busca curada (blocos), esgotado nominal e sem resultado
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
  emitir('tg_busca_resgate_view', { rescue_type: 'curada', results_count: total });
  return true;
}

// Esgotado nominal na pagina /search (REL-04): a(s) peca(s) com a tarja "Grade esgotada" e, em outra secao, as parecidas com
// grade cheia (o Best Seller do tipo primeiro). So texto; o link dos cards e o da PDP de sempre. Devolve true se montou.
function tgRgMontarEsgotado(q, res) {
  var e = res.esgotado, secoes = [], total = 0, grupos = [[e.itens.length === 1 ? 'Peça esgotada' : 'Peças esgotadas', e.itens], ['Opções parecidas com grade completa', e.similares]];
  var g, i, c, cards, destino, caixa, nativo, mapa = tgGruposCores(e.similares);
  for (g = 0; g < grupos.length; g++) {
    cards = [];
    for (i = 0; i < grupos[g][1].length; i++) {
      c = tgRgCard(grupos[g][1][i], res.selos ? (res.selos.get(grupos[g][1][i]) || false) : false, null, { esgotada: g === 0, mapa: mapa, posicao: total + cards.length + 1 });
      if (c) { cards.push(c); }
    }
    if (cards.length) {
      total += cards.length;
      secoes.push(el('section', { 'class': 'tg-busca-bloco', 'data-bloco': g === 0 ? 'esgotada' : 'similares' }, [tgBlocoTitulo(grupos[g][0], cards.length, 'h2'), el('div', { 'class': 'tg-busca-grade' }, cards)]));
    }
  }
  if (!total) { return false; }
  caixa = el('div', { id: 'tg-busca-resgate', 'class': 'tg-busca-zero container' }, [
    tgConselheira(),
    el('div', { 'class': 'tg-busca-zero-titulo' }, ['Grade esgotada para "' + q + '"']),
    el('div', { 'class': 'tg-busca-zero-desc' }, ['Veja a peça e, abaixo, opções parecidas com grade completa para envio imediato:'])
  ].concat(secoes));
  destino = tgRgDestino();
  if (!destino) { return false; }
  injetarEstilos();
  destino.insertBefore(caixa, destino.firstChild || null);
  if (TG_PG_ESCONDE_NATIVO) {
    nativo = document.querySelector('.js-product-table');
    if (nativo) { nativo.classList.add('tg-busca-nativo-oculto'); }
  }
  emitir('tg_busca_resgate_view', { rescue_type: 'esgotado', results_count: total });
  return true;
}

// Formulario para editar a busca (GET normal para a busca da loja; o termo da URL entra so como valor do campo).
function tgRgForm(q) {
  var campo = el('input', { type: 'search', 'class': 'tg-busca-zero-campo', 'aria-label': 'Buscar peças' }), form;
  tgAttr(campo, { name: 'q', value: q, placeholder: 'Buscar outra peça', autocomplete: 'off', maxlength: '200' });
  form = el('form', { 'class': 'tg-busca-zero-form', role: 'search' }, [campo, el('button', { type: 'submit', 'class': 'tg-busca-zero-ok' }, ['Buscar'])]);
  tgAttr(form, { action: '/search/', method: 'get' });
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
    descGrade = el('div', { 'class': 'tg-busca-zero-desc' }, [res.tamanho && res.tamanho.aplicado ? 'Confira as peças no tamanho ' + res.tamanho.rotulo + ' disponíveis para envio imediato:' : 'Confira os Best Sellers disponíveis para envio imediato:']);
  }
  proximos = tgRgTermosProximos(q, cat);
  chips = tgChipsLista('zero');
  filhos = [tgConselheira(), el('div', { 'class': 'tg-busca-zero-titulo' }, ['Não encontramos peças com o termo exato "' + q + '"']), descTopo, tgRgForm(q), proximos];
  if (chips) { filhos.push(el('div', { 'class': 'tg-busca-secao-titulo' }, ['Em alta'])); filhos.push(chips); }
  filhos.push(descGrade);
  filhos.push(el('div', { 'class': 'tg-busca-grade' }, cards));
  caixa = el('div', { id: 'tg-busca-resgate', 'class': 'tg-busca-zero container' }, filhos);
  destino = tgRgDestino();
  if (!destino) { return; }
  injetarEstilos();
  destino.insertBefore(caixa, destino.firstChild || null);
  emitir('tg_busca_resgate_view', { rescue_type: tipo, results_count: cards.length });
}

// ---------------------------------------------------------------- pagina de resultados
// Categoria Novidades da Semana (ordem das pecas na loja): baixa a pagina da categoria (so leitura, mesma origem) e guarda os handles na ordem em que aparecem.
// Falha ou demora (6 s) = lista vazia: o filtro/ordem Lancamentos simplesmente nao muda nada.
var tgPgNovidadesCache = null;
function tgPgNovidades() {
  var url = typeof TG_NOVIDADES_URL === 'string' ? TG_NOVIDADES_URL : '/novidades/novidades-da-semana/';
  if (tgPgNovidadesCache) { return tgPgNovidadesCache; }
  function baixar(n) {
    return new Promise(function (ok) {
      var t = setTimeout(function () { ok(null); }, 6000);
      try {
        fetch(url + (n > 1 ? '?mpage=' + n : ''), { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.text() : null; }).then(function (txt) { clearTimeout(t); ok(txt); }, function () { clearTimeout(t); ok(null); });
      } catch (e) { clearTimeout(t); ok(null); }
    });
  }
  function handles(txt, saida, vistos) {
    var doc, links, i, m, novos = 0;
    try {
      doc = new DOMParser().parseFromString(txt, 'text/html');
      links = doc.querySelectorAll('.js-product-table a[href*="/produtos/"], .category-body a[href*="/produtos/"]');
      if (!links.length) { links = doc.querySelectorAll('a[href*="/produtos/"]'); }
      for (i = 0; i < links.length; i++) {
        m = /\/produtos\/([a-z0-9][a-z0-9-]*)\/?/.exec(links[i].getAttribute('href') || '');
        if (m && urlProduto(m[1]) && !vistos[m[1]]) { vistos[m[1]] = true; saida.push(m[1]); novos++; }
      }
    } catch (e) {}
    return novos;
  }
  tgPgNovidadesCache = new Promise(function (ok) {
    var saida = [], vistos = {};
    function passo(n) {
      baixar(n).then(function (txt) {
        if (!txt || n > 6 || !handles(txt, saida, vistos)) { if (!saida.length) { tgPgNovidadesCache = null; } ok(saida); return; }
        passo(n + 1);
      });
    }
    passo(1);
  });
  return tgPgNovidadesCache;
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

// Monta a pagina de resultados. Devolve true se montou (so entao a lista nativa so some).
// Filtros que valem juntos: chip de categoria/ocasiao (troca a lista-base pela busca do chip), Novidades, tamanhos (varios) e cores (varias).
function tgPgMontar(q, cat, res) {
  var itens = [], i, destino, raiz, nativo, mapa, selos = res.selos, destaque, est, grade, mais, barra, menus = [], ordem = null, tam = null, cor = null, togg, tg1, tg2, chipsLinha, filhos, aviso = null, vazio, bases = {}, voce, grupoQ = typeof tgGrupoDaBusca === 'function' ? tgGrupoDaBusca(q) : '';
  for (i = 0; i < res.results.length; i++) { if (urlProduto(res.results[i].s) && precoFinal(res.results[i])) { itens.push(res.results[i]); } }
  if (!itens.length) { return false; }
  destino = tgRgDestino();
  if (!destino) { return false; }
  destaque = res.tamanho && res.tamanho.aplicado ? res.tamanho.aceitos : null;
  mapa = tgGruposCores(itens);
  est = { ordem: 'relevancia', tamanhos: [], cores: [], base: '', grupo: '', chip: '', novidades: false, handles: null, um: false, mostrados: 0, atual: itens };
  grade = el('div', { 'class': 'tg-busca-grade' });
  mais = el('button', { type: 'button', 'class': 'tg-busca-mais tg-busca-oculto' }, ['Ver mais peças']);
  voce = el('h1', { 'class': 'tg-busca-voce' });
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
  function lista() { return tgPgOrdenar(tgPgFiltrar(soNovidades(baseItens()), est.tamanhos, est.cores), est.ordem, est.handles); }
  function lote() {
    var fim = Math.min(est.atual.length, est.mostrados + TG_PG_LOTE), c, p;
    for (p = est.mostrados; p < fim; p++) {
      c = tgRgCard(est.atual[p], selos ? (selos.get(est.atual[p]) || false) : false, destaque, { mapa: mapa, posicao: p + 1 });
      if (c) { grade.appendChild(c); }
    }
    est.mostrados = fim;
    // so aparece se ainda ha pecas para mostrar (e diz quantas); sem mais pecas o botao nao existe
    if (fim < est.atual.length) { tgTexto(mais, 'Ver mais ' + (est.atual.length - fim) + (est.atual.length - fim === 1 ? ' peça' : ' peças')); mais.classList.remove('tg-busca-oculto'); } else { mais.classList.add('tg-busca-oculto'); }
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
    return String(t || '').trim().slice(0, 60).split(/\s+/).map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); }).join(' ');
  }
  // "Você está buscando por: Vestidos" (ou o que foi digitado, ou grupo + chip)
  function pintarTitulo() {
    var g = gAtivo(), rot, c, j, ocas;
    if (est.chip && g) { c = tgChipDoGrupo(g, est.chip); rot = TG_GRUPOS[g].rotulo + (c ? ' · ' + c.rotulo : ''); }
    else if (est.grupo) { rot = TG_GRUPOS[est.grupo].rotulo; }
    else if (est.base) {
      rot = tituloCaso(q);
      ocas = typeof TG_CHIPS_OCASIAO !== 'undefined' && Array.isArray(TG_CHIPS_OCASIAO) ? TG_CHIPS_OCASIAO : [];
      for (j = 0; j < ocas.length; j++) { if (ocas[j] && ocas[j].consulta === est.base) { rot = ocas[j].rotulo; } }
    } else { rot = tituloCaso(q); }
    if (est.novidades) { rot += ' · Novidades'; }
    while (voce.firstChild) { voce.removeChild(voce.firstChild); }
    voce.appendChild(document.createTextNode('Você está buscando por: '));
    voce.appendChild(el('strong', null, [rot]));
  }
  function rotuloContado(base, n) { return n ? base + ' (' + n + ')' : base; }
  function desenhar() {
    var opCor;
    while (grade.firstChild) { grade.removeChild(grade.firstChild); }
    est.atual = lista();
    est.mostrados = 0;
    est.secoes = est.ordem === 'best-sellers' && !gAtivo() ? secoesBest(est.atual) : null;
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
      if (est.ordem === 'best-sellers' && gAtivo() && est.atual.length) { grade.appendChild(el('h2', { 'class': 'tg-busca-grade-titulo' }, ['Mais Vendidos em ' + TG_GRUPOS[gAtivo()].rotulo])); }
      lote();
    }
    pintarTitulo();
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
    if (ordem) { ordem.pintar(null, est.ordem); }
    if (tam) { tgTexto(tam.botao, rotuloContado('Tamanho', est.tamanhos.length)); tam.pintar(null, est.tamanhos); }
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
      if (sp.get('tg_nov') === '1') { est.novidades = true; }
      // cor que nao existe nessa busca some do link (nada de chip fantasma nem lista vazia por link editado)
      if (est.cores.length && typeof tgPgOpcoesCor === 'function') { validas = tgPgOpcoesCor(baseItens()).map(function (o) { return o.valor; }); est.cores = est.cores.filter(function (c) { return validas.indexOf(c) >= 0; }); }
      if (est.ordem === 'lancamentos' || est.novidades) { precisaNov = true; }
    } catch (e) {}
    return precisaNov;
  }
  var limpar;
  function limparTudo() { est.tamanhos = []; est.cores = []; est.base = ''; est.grupo = ''; est.chip = ''; est.novidades = false; est.ordem = 'relevancia'; desenhar(); }
  mais.addEventListener('click', function () { try { lote(); } catch (e) {} });

  function alternar(lista, v) { var p = lista.indexOf(v); if (p >= 0) { lista.splice(p, 1); } else { lista.push(v); } }
  function escolherOrdem(v) {
    function aplicar() { est.ordem = v; if (ordem) { ordem.pintar(null, v); } desenhar(); try { emitir('tg_busca_ordenar', { reason: v, results_count: est.atual.length }); } catch (e) {} }
    if (v === 'lancamentos' && !est.handles) { tgPgNovidades().then(function (h) { est.handles = h; aplicar(); }); return; }
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
    desenhar();
    try { emitir('tg_busca_chip', { reason: (gAtivo() || '') + ':' + (est.chip || 'limpar'), results_count: est.atual.length }); } catch (e) {}
  }
  function escolherNovidades(botao) {
    function aplicar() { est.novidades = !est.novidades; desenhar(); try { emitir('tg_busca_chip', { reason: est.novidades ? 'novidades' : 'limpar', results_count: est.atual.length }); } catch (e) {} }
    if (!est.handles) { botao.setAttribute('aria-busy', 'true'); tgPgNovidades().then(function (h) { est.handles = h; botao.removeAttribute('aria-busy'); if (h.length) { aplicar(); } }); return; }
    if (est.handles.length) { aplicar(); }
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
    est.tamanhos.forEach(function (t) { chipsLinha.appendChild(chipBotao('Tamanho ' + rotuloTam(t) + ' ×', true, function () { escolherTamanho(t); }, 'Tirar o filtro de tamanho ' + rotuloTam(t))); });
    opCor = typeof tgPgOpcoesCor === 'function' ? tgPgOpcoesCor(baseItens()) : [];  // rotulos: lista completa
    est.cores.forEach(function (v) {
      var rot = v, k;
      for (k = 0; k < opCor.length; k++) { if (opCor[k].valor === v) { rot = opCor[k].rotulo; } }
      chipsLinha.appendChild(chipBotao('Cor ' + rot + ' ×', true, function () { escolherCor(v); }, 'Tirar o filtro de cor ' + rot));
    });
    // dentro de um grupo (Vestidos, Blusas, Calças), pela busca ou por chip: os chips passam a ser os do grupo
    gcs = null;
    try { if (gAtivo() && typeof tgChipsDoGrupo === 'function') { gcs = tgChipsDoGrupo(cat, gAtivo()); } } catch (e) { gcs = null; }
    if (gcs) {
      if (est.grupo && !grupoQ) { chipsLinha.appendChild(chipBotao('‹ Todas', false, function () { voltarTodas(); }, 'Voltar para todas as peças')); }
      gcs.forEach(function (gc) {
        if (gc.novidades) { chipsLinha.appendChild(chipBotao(gc.rotulo, est.novidades, function (b) { escolherNovidades(b); })); }
        else { chipsLinha.appendChild(chipBotao(gc.rotulo, est.chip === gc.id, function () { escolherChipGrupo(gc.id); })); }
      });
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
    if (tgPgOpcoesCor(itens).length) { cor = tgPgMenu('Cor', tgPgOpcoesCor(itens), [], escolherCor, true, true); menus.push(cor); }
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
  barra = el('div', { 'class': 'tg-busca-barra' }, [el('div', { 'class': 'tg-busca-barra-linha' }, [ordem ? ordem.no : null, el('span', { 'class': 'tg-busca-barra-espaco' }), tam ? tam.no : null, cor ? cor.no : null, togg])]);

  // fecha os menus ao clicar fora ou com Esc (um unico ouvinte por pagina)
  document.addEventListener('click', function (ev) {
    var j;
    try { for (j = 0; j < menus.length; j++) { if (!menus[j].no.contains(ev.target)) { menus[j].fechar(); } } } catch (e) {}
  });
  document.addEventListener('keydown', function (ev) {
    var j;
    try { if (ev.key === 'Escape') { for (j = 0; j < menus.length; j++) { menus[j].fechar(); } } } catch (e) {}
  });

  if (res.tamanho) { aviso = tgAcAviso(res.tamanho); }
  var precisaNov = urlLer();
  filhos = [tgConselheira(), voce, aviso, barra, chipsLinha, grade, vazio, mais];
  raiz = el('section', { id: 'tg-busca-resultados', 'class': 'tg-busca-pagina', 'aria-label': 'Resultados da busca' }, filhos);
  injetarEstilos();
  desenhar();
  destino.insertBefore(raiz, destino.firstChild || null);
  if (precisaNov) {
    tgPgNovidades().then(function (h) { est.handles = h; if (!h.length) { est.novidades = false; } desenhar(); });
  }
  if (TG_PG_ESCONDE_NATIVO) {
    nativo = document.querySelector('.js-product-table');
    if (nativo) { nativo.classList.add('tg-busca-nativo-oculto'); }
  }
  // a nossa tela tem o proprio titulo e a propria paginacao: somem os titulos nativos e o "Mostrar mais produtos" da Nuvem
  try {
    ['.js-load-more', '#js-infinite-scroll-spinner', '[data-store="page-title"]'].forEach(function (sel) { var n2 = document.querySelector(sel); if (n2) { n2.classList.add('tg-busca-nativo-oculto'); } });
    nativo = document.querySelector('.category-body h2');
    if (nativo && /exibindo resultados/i.test(nativo.textContent || '')) { nativo.classList.add('tg-busca-nativo-oculto'); }
  } catch (e) {}
  emitir('tg_busca_pagina_view', { results_count: itens.length, page_type: 'search' });
  return true;
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
      return obterEsgotados().then(function (esg) { seguir(cat, esg); });
    }
    seguir(cat, null);
  })['catch'](function () {}).then(function () { if (resultados) { devolverNativa(); } tgPend(false); });
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
  var c, f, largura, a, r;
  try {
    if (tgIniciado) { return; }
    c = window.TG_BUSCA_CTX;
    if (!ctxValido(c)) { return; }
    f = c.features || {};
    tgCtx = { versao: c.versao, modo: c.modo, catalogo: c.catalogo, features: f, grupo: c.grupo === 'novo' ? 'novo' : null };
    largura = window.innerWidth || 0;
    if (f.desktop === false && largura >= 768) { return; }
    tgIniciado = true;
    if (!/^\/search/.test(window.location.pathname)) { tgPend(false); }
    a = f.autocomplete !== false;
    r = f.resgate !== false;
    emitir('tg_busca_ativa', { engine_version: tgCtx.versao, engine_mode: tgCtx.modo, page_type: /^\/search/.test(window.location.pathname) ? 'search' : 'outra' });
    clarityFila(['set', 'tg_busca', tgCtx.modo]);
    if (!a && !r) { return; }
    if (a) { try { ligarAutocomplete(); } catch (e) { dbg('autocomplete', e); } }
    if (r) { try { ligarResgate(); } catch (e) { dbg('resgate', e); } }
  } catch (e) {}
}

try {
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', iniciarBusca); }
  else { iniciarBusca(); }
} catch (e) {}

})();
