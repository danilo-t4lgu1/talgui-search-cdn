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

// Prepara (uma vez por catálogo carregado) as ofertas, as cores e a posição (ranking de vendas) dos produtos. Não muda o catálogo.
var tgPreparoCache = typeof WeakMap === 'function' ? new WeakMap() : null;

function tgPreparar(catalogo) {
  var prep, i, it, cores, pos;
  if (tgPreparoCache && catalogo && typeof catalogo === 'object') {
    prep = tgPreparoCache.get(catalogo);
    if (prep) return prep;
  }
  cores = new Map();
  pos = new Map();
  for (i = 0; i < catalogo.length; i++) {
    it = catalogo[i];
    if (!it || typeof it !== 'object') continue;
    cores.set(it, tgCorDoNome(it.n));
    pos.set(it, i);
  }
  prep = { ofertas: tgCalcOfertas(catalogo, null, TG_OFERTAS_MIN_TAMANHOS), cores: cores, pos: pos, nicho: {} };
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

// 2. Ranqueamento e Busca em Memória
function runSearch(query, catalog, limit) {
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
  let suggested = null;
  if (topResults.length > 0 && !(tamanho && tamanho.aplicado) && normalizeText(topResults[0].n) !== normQ) {
    suggested = topResults[0].n;
  }

  return {
    query: query,
    results: topResults,
    suggestedTerm: suggested,
    selos: tgSelosDaBusca(topResults, prep, ofertas),
    tamanho: tamanho
  };
}


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
var TG_PARAMS = ['engine_version', 'engine_mode', 'page_type', 'position', 'query_len', 'had_correction', 'results_count', 'rescue_type', 'reason'];
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

// Nunca lanca. Devolve { itens } ou { motivo }: cat_rede, cat_timeout, cat_http, cat_json, cat_formato, cat_poucos.
function carregarCatalogo(url, timeoutMs) {
  var ctl, tm, esgotou = false;
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
        itens = validarCatalogo(dados, txt.length);
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
 * Estilos do injetor. Origem: CSS do protótipo (linhas 263 a 415), com todas as classes sob o prefixo .tg-busca-
 * e os ids sob #tg-busca-, para nao colidir com o tema nem com os apps. Entra por <style> com textContent, uma vez.
 */
var TG_CSS = [
  '.tg-busca-oculto{display:none}',
  '#tg-busca-sugestoes{margin-top:12px;background:#fff;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.12);max-height:65vh;overflow-y:auto;-webkit-overflow-scrolling:touch;border:1px solid #ebebeb}',
  '.tg-busca-banner{padding:10px 14px;background:#f8f9fa;border-bottom:1px solid #ebebeb;font-size:13px;color:#555}',
  '.tg-busca-banner strong,.tg-busca-sugerido{color:#000;font-weight:700}',
  '.tg-busca-sugerido{cursor:pointer;text-decoration:underline;background:none;border:0;padding:0;font:inherit;font-weight:700}',
  '.tg-busca-lista{list-style:none;padding:0;margin:0}',
  '.tg-busca-item{display:flex;align-items:center;padding:12px 14px;border-bottom:1px solid #f4f4f4;text-decoration:none;color:inherit;transition:background .15s ease}',
  '.tg-busca-item:hover,.tg-busca-item:active{background:#fafafa}',
  '.tg-busca-thumb{width:52px;height:68px;object-fit:cover;border-radius:4px;margin-right:12px;background:#f0f0f0;flex-shrink:0}',
  '.tg-busca-info{flex:1;min-width:0}',
  '.tg-busca-nome{font-size:13px;font-weight:600;color:#222;margin:0 0 4px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.tg-busca-meta{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;margin-bottom:4px}',
  '.tg-busca-preco{display:inline-flex;align-items:baseline;gap:6px;font-size:14px;color:#111}',
  '.tg-busca-preco strong{font-weight:700}',
  '.tg-busca-de{font-size:11px;color:#8a8a8a;text-decoration:line-through;font-weight:400}',
  '.tg-busca-selo{font-size:10px;font-weight:600;line-height:1.3;padding:2px 6px;border-radius:4px}',
  '.tg-busca-selo-campeao{background:#ecfdf5;color:#065f46}',
  '.tg-busca-selo-ultimas{background:#fffbeb;color:#92400e}',
  '.tg-busca-selo-oferta{background:#fef2f2;color:#991b1b}',
  '.tg-busca-pilulas{display:flex;gap:4px;flex-wrap:wrap}',
  '.tg-busca-pilula{font-size:10px;padding:1px 5px;background:#f1f3f5;color:#495057;border-radius:3px;font-weight:500}',
  '.tg-busca-pilula-pedida{background:#222;color:#fff;font-weight:700}',
  '.tg-busca-bloco-titulo{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:0;padding:10px 14px;background:#f8f9fa;border-bottom:1px solid #ebebeb;font-size:13px;font-weight:700;color:#000}',
  '.tg-busca-bloco-qtd{font-size:11px;font-weight:500;color:#8a8a8a}',
  '.tg-busca-curada{margin:20px auto;padding:0 12px;max-width:1200px}',
  '.tg-busca-curada .tg-busca-bloco-titulo{font-size:18px;padding:12px 0;background:none;border-bottom:2px solid #000;margin-bottom:12px}',
  '.tg-busca-curada .tg-busca-bloco{margin-bottom:28px}',
  '.tg-busca-nativo-oculto{display:none!important}',
  '.tg-busca-todos{display:block;width:100%;padding:12px;text-align:center;background:#000;color:#fff;font-weight:600;font-size:13px;text-decoration:none;border-radius:0 0 8px 8px}',
  '.tg-busca-zero{margin:30px auto;padding:24px 16px;max-width:800px;background:#fff;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.06);text-align:center}',
  '.tg-busca-zero-titulo{font-size:18px;font-weight:700;margin-bottom:8px}',
  '.tg-busca-zero-desc{color:#666;font-size:14px;margin-bottom:20px}',
  '.tg-busca-zero-desc a{font-weight:700;color:#000;text-decoration:underline}',
  '.tg-busca-grade{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;text-align:left}',
  '.tg-busca-card{display:flex;flex-direction:column;align-items:flex-start;padding:10px;border:1px solid #eee;border-radius:8px;text-decoration:none;color:inherit}',
  '.tg-busca-card .tg-busca-thumb{width:100%;height:210px;margin:0 0 8px 0;border-radius:6px}',
  '.tg-busca-card .tg-busca-nome{width:100%}',
  '.tg-busca-card .tg-busca-preco{margin-bottom:4px}',
  '@media (min-width:768px){.tg-busca-grade{grid-template-columns:repeat(4,1fr)}}'
].join('\n');

function injetarEstilos() {
  if (document.getElementById('tg-busca-estilos')) { return; }
  var st = el('style', { id: 'tg-busca-estilos' }, [TG_CSS]);
  document.head.appendChild(st);
}

/* ---- src/injetor/autocomplete.js ---- */
/*
 * Autocomplete no modal de busca. Origem: initAutocomplete do protótipo (linhas 416 a 520), reescrito sem HTML cru.
 * Mesmo comportamento: minimo de 2 caracteres, debounce de 90 ms, ate 6 resultados, ate 5 pilulas, "Ver todos".
 * Busca curada (wedding, casamento...): os mesmos 6 resultados em blocos com titulo (3 + 3), ver tgAcPintar.
 * Mudancas de seguranca e de convivencia: catalogo so na primeira interacao (L6), caixa propria depois do
 * contêiner nativo (L13, metade), nunca mexe no formulario nativo, nunca cancela nem interrompe eventos do tema.
 */
var TG_AC_MIN = 2;
var TG_AC_LIMITE = 6;
var TG_AC_ESPERA = 90;

function tgAcLimpar(caixa) { while (caixa.firstChild) { caixa.removeChild(caixa.firstChild); } }

// Selo da peca (um so, a precedencia esta no motor: Melhores Ofertas > Best Seller > Ultimas Pecas). "info" vem de res.selos
// (calculado pelo motor para o resultado daquela busca). false = o motor decidiu que a peca nao tem selo (Best Seller agora e so das mais
// vendidas do resultado, nao de toda peca t = 1); sem informacao nenhuma (null/undefined), cai no selo pelo tier t, como antes.
function tgAcSelo(p, info) {
  if (info === false) { return null; }
  if (!info) { info = p.t === 1 ? { tipo: 'best', texto: TG_SELO_BEST } : (p.t === 4 ? { tipo: 'ultimas', texto: TG_SELO_ULTIMAS } : null); }
  if (!info) { return null; }
  // a classe -campeao segue como estava (so o texto virou Best Seller)
  return el('span', { 'class': 'tg-busca-selo tg-busca-selo-' + (info.tipo === 'oferta' ? 'oferta' : (info.tipo === 'best' ? 'campeao' : 'ultimas')) }, [info.texto]);
}

// Uma linha da lista. Devolve null se o item nao tem link ou preco validos (nao aparece).
// "extra" (opcional): { curada: true } marca a busca curada na telemetria (rescue_type = 'curada'); { tamanhos: [...] } destaca a pilula do tamanho pedido.
function tgAcLinha(p, posicao, consulta, corrigiu, info, extra) {
  var href = urlProduto(p.s), preco = blocoPreco(p), selo, a, curada = !!(extra && extra.curada);
  if (!href || !preco) { return null; }
  selo = tgAcSelo(p, info);
  a = el('a', { 'class': 'tg-busca-item', href: href }, [
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

function tgAcPintar(pegarCaixa, input, consulta, res) {
  var linhas = [], blocos = [], i, b, li, lis, ul, todos, sugerido, botao, caixa = pegarCaixa(), extra, total, termoTodos;
  if (!caixa) { return; }
  tgAcLimpar(caixa);
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
    caixa.classList.remove('tg-busca-oculto');
    return;
  }
  if (res.tamanho) { caixa.appendChild(tgAcAviso(res.tamanho)); }
  if (res.suggestedTerm) {
    sugerido = res.suggestedTerm;
    botao = el('button', { type: 'button', 'class': 'tg-busca-sugerido' }, [sugerido]);
    botao.addEventListener('click', function () {
      try { input.value = sugerido; tgAcDesenhar(pegarCaixa, input, sugerido); } catch (e) {}
    });
    caixa.appendChild(el('div', { 'class': 'tg-busca-banner' }, ['Buscando por: ', botao]));
  }
  if (res.curada) {
    for (i = 0; i < blocos.length; i++) { caixa.appendChild(blocos[i]); }
  } else {
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
      try { emitir('tg_busca_ver_todos', ev); } catch (e) {}
    });
    caixa.appendChild(todos);
  }
  caixa.classList.remove('tg-busca-oculto');
}

// A caixa e os estilos so nascem quando ha algo para mostrar (catalogo carregado): se o catalogo falha, a pagina fica sem rastro (PRV-03).
function tgAcDesenhar(pegarCaixa, input, consulta) {
  var existente;
  if (consulta.length < TG_AC_MIN) {
    existente = document.getElementById('tg-busca-sugestoes');
    if (existente) { tgAcLimpar(existente); existente.classList.add('tg-busca-oculto'); }
    return;
  }
  obterCatalogo().then(function (cat) {
    if (!cat || input.value.trim() !== consulta) { return; }
    tgAcPintar(pegarCaixa, input, consulta, runSearch(consulta, cat, TG_AC_LIMITE));
  })['catch'](function () {});
}

function ligarAutocomplete() {
  var form = document.querySelector('.js-search-form');
  var input = (form && form.querySelector('.js-search-input')) || document.querySelector('.js-search-input');
  var nativo, espera = null, tocou = false, botoes, i;
  if (!input) { return; }
  nativo = document.querySelector('.js-search-form-suggestions');
  function pegarCaixa() {
    var caixa = document.getElementById('tg-busca-sugestoes'), ref, pai;
    if (caixa) { return caixa; }
    ref = nativo || form || input;
    pai = ref.parentNode;
    if (!pai) { return null; }
    injetarEstilos();
    caixa = el('div', { id: 'tg-busca-sugestoes', 'class': 'tg-busca-oculto' });
    pai.insertBefore(caixa, ref.nextSibling || null);
    return caixa;
  }
  function primeira() { if (!tocou) { tocou = true; obterCatalogo(); } }
  input.addEventListener('focus', function () {
    try { primeira(); var v = input.value.trim(); if (v.length >= TG_AC_MIN) { tgAcDesenhar(pegarCaixa, input, v); } } catch (e) {}
  });
  input.addEventListener('input', function () {
    try {
      var v = input.value.trim();
      primeira();
      clearTimeout(espera);
      espera = setTimeout(function () { try { tgAcDesenhar(pegarCaixa, input, v); } catch (e) {} }, TG_AC_ESPERA);
    } catch (e) {}
  });
  botoes = document.querySelectorAll('.js-search-button');
  for (i = 0; i < botoes.length; i++) {
    // pointerdown vem antes do click: o pedido do catalogo (L21) sai um pouco mais cedo, sem passar a pedir nada sem interacao (L6)
    botoes[i].addEventListener('pointerdown', function () { try { primeira(); } catch (e) {} }, { passive: true });
    botoes[i].addEventListener('click', function () { try { primeira(); } catch (e) {} });
  }
}

/* ---- src/injetor/resgate.js ---- */
/*
 * Resgate da pagina /search/?q=... sem resultado. Origem: initSearchPageRescue do protótipo (linhas 523 a 586),
 * reescrito sem HTML cru (o ponto 10 da pesquisa, o termo da URL no titulo, era XSS refletido por link).
 * O termo da URL entra so como texto. Nesta fase nao esconde nada da pagina nativa (L19 e L12 ficam para a Fase 3) e nao tem linha de Pix (DP5).
 */
var TG_RG_LIMITE = 4;

// "info" (opcional): o selo do motor para a peca (so a pagina curada passa; o resgate segue sem selo). "tamanhos" (opcional): destaca a pilula pedida.
function tgRgCard(p, info, tamanhos) {
  var href = urlProduto(p.s), preco = blocoPreco(p);
  if (!href || !preco) { return null; }
  return el('a', { 'class': 'tg-busca-card', href: href }, [
    foto(p, 'tg-busca-thumb'),
    el('div', { 'class': 'tg-busca-nome' }, [p.n]),
    preco,
    info === undefined ? null : tgAcSelo(p, info),
    pilulas(p.sz, 4, tamanhos)
  ]);
}

// Pagina /search de uma busca curada (wedding, casamento...): os blocos completos, cada um com titulo, no topo da area de resultados.
// Nao tira nada da pagina nativa (a lista nativa so some se TG_CURADA_ESCONDE_NATIVO for true). Devolve true se montou.
function tgCuMontar(res) {
  var secoes = [], filhos = [], b, i, c, cards, item, total = 0, destaque, destino, caixa, nativo;
  destaque = res.tamanho && res.tamanho.aplicado ? res.tamanho.aceitos : null;
  for (b = 0; b < res.curada.blocos.length; b++) {
    cards = [];
    for (i = 0; i < res.curada.blocos[b].itens.length; i++) {
      item = res.curada.blocos[b].itens[i];
      c = tgRgCard(item, res.selos ? (res.selos.get(item) || false) : false, destaque);
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
  destino = document.querySelector('.category-body') || document.querySelector('main') || document.body;
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

function tgRgMontar(q, cat) {
  var res = runSearch(q, cat, TG_RG_LIMITE), cards = [], i, c, desc, tipo, destino, caixa;
  for (i = 0; i < res.results.length; i++) {
    c = tgRgCard(res.results[i]);
    if (c) { cards.push(c); }
  }
  if (res.suggestedTerm) {
    tipo = 'voce_quis_dizer';
    desc = el('div', { 'class': 'tg-busca-zero-desc' }, ['Você quis dizer: ', el('a', { href: urlBusca(res.suggestedTerm) }, [res.suggestedTerm]), '?']);
  } else {
    tipo = 'campeoes';
    desc = el('div', { 'class': 'tg-busca-zero-desc' }, [res.tamanho && res.tamanho.aplicado ? 'Confira as peças no tamanho ' + res.tamanho.rotulo + ' disponíveis para envio imediato:' : 'Confira os Best Sellers disponíveis para envio imediato:']);
  }
  caixa = el('div', { id: 'tg-busca-resgate', 'class': 'tg-busca-zero container' }, [
    el('div', { 'class': 'tg-busca-zero-titulo' }, ['Não encontramos peças com o termo exato "' + q + '"']),
    desc,
    el('div', { 'class': 'tg-busca-grade' }, cards)
  ]);
  destino = document.querySelector('.category-body') || document.querySelector('main') || document.body;
  if (!destino) { return; }
  injetarEstilos();
  destino.insertBefore(caixa, destino.firstChild || null);
  emitir('tg_busca_resgate_view', { rescue_type: tipo, results_count: cards.length });
}

function ligarResgate() {
  var q, curada;
  if (!/^\/search/.test(window.location.pathname)) { return; }
  q = String(new URLSearchParams(window.location.search).get('q') || '').trim().slice(0, 200);
  if (!q) { return; }
  // busca curada: os blocos aparecem mesmo com a lista nativa na tela (so ai o catalogo e baixado com resultados nativos)
  curada = tgEhBuscaCurada(q);
  if (!curada && document.querySelector('.js-product-table')) { return; }
  obterCatalogo().then(function (cat) {
    var res;
    if (!cat) { return; }
    if (curada) {
      if (document.getElementById('tg-busca-curada')) { return; }
      res = runSearch(q, cat, TG_CURADA_PAGINA_LIMITE);
      if (res.curada && tgCuMontar(res)) { return; }
    }
    if (document.querySelector('.js-product-table') || document.getElementById('tg-busca-resgate')) { return; }
    tgRgMontar(q, cat);
  })['catch'](function () {});
}

/* ---- src/injetor/inicio.js ---- */
/*
 * Entrada do injetor. So roda com window.TG_BUSCA_CTX valido, criado pelo carregador do tema (src/tema/tg-busca.js.tpl):
 * { v, versao, modo, catalogo, features }. Nunca le o catalogo de uma global da pagina e nao le a flag (quem decide e o carregador, DP1).
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
    (f == null || (typeof f === 'object' && !Array.isArray(f)));
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

function iniciarBusca() {
  var c, f, largura, a, r;
  try {
    if (tgIniciado) { return; }
    c = window.TG_BUSCA_CTX;
    if (!ctxValido(c)) { return; }
    f = c.features || {};
    tgCtx = { versao: c.versao, modo: c.modo, catalogo: c.catalogo, features: f };
    largura = window.innerWidth || 0;
    if (f.desktop === false && largura >= 768) { return; }
    tgIniciado = true;
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
