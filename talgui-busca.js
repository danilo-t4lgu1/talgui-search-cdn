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
 * AVISO: melhorar a relevância é Fase 3. Aqui só paridade; o teste tests/unidade/motor-paridade.test.cjs trava isso.
 * Os marcadores node:inicio / node:fim delimitam a exportação para o Node; o build (plano 02-04) remove esse bloco do arquivo do navegador.
 */
function normalizeText(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
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

// 2. Ranqueamento e Busca em Memória
function runSearch(query, catalog, limit) {
  limit = limit || 6;
  const normQ = normalizeText(query);
  if (!normQ || normQ.length < 2) {
    return { query: query, results: catalog.slice(0, limit), suggestedTerm: null };
  }

  const qTokens = normQ.split(' ').filter(Boolean);
  const scored = [];

  for (let i = 0; i < catalog.length; i++) {
    const item = catalog[i];
    const normN = normalizeText(item.n);
    const nTokens = normN.split(' ');
    const normC = normalizeText(item.c);

    let tokenScore = 0;
    let matchedCount = 0;

    for (let t = 0; t < qTokens.length; t++) {
      const qt = qTokens[t];
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
      scored.push({ item: item, score: score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const topResults = scored.slice(0, limit).map(s => s.item);

  let suggested = null;
  if (topResults.length > 0 && normalizeText(topResults[0].n) !== normQ) {
    suggested = topResults[0].n;
  }

  return {
    query: query,
    results: topResults,
    suggestedTerm: suggested
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

// Pilulas de tamanho: so texto, ate "max".
function pilulas(sz, max) {
  var out = [], i;
  if (!Array.isArray(sz)) { return null; }
  for (i = 0; i < sz.length && out.length < max; i++) {
    if (typeof sz[i] === 'string' && sz[i]) { out.push(el('span', { 'class': 'tg-busca-pilula' }, [sz[i]])); }
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
 * Sem copia no armazenamento da sessao, sem global da pagina. Campos do catalogo: id, n, s, c, p, pp, i, t, b, sz.
 */
var TG_CAT_MAX_BYTES = 2 * 1024 * 1024;
var TG_CAT_MIN = 50;
// Tempo limite do catalogo (L21): 4 s. Em 3G o arquivo (65 KB comprimido) leva cerca de 2,5 s mesmo sozinho e, com a pagina da loja
// ocupando a linha principal (CPU lenta), o limite antigo de 2 s vencia com o catalogo ja baixado. A nativa segue usavel durante a espera.
var TG_CAT_TIMEOUT_MS = 4000;

function tgHandleOk(s) { return typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,200}$/.test(s); }
function tgNumOk(v) { return typeof v === 'number' && isFinite(v); }

// Devolve uma lista limpa (itens invalidos descartados) ou null. "bytes" e o tamanho do corpo, quando se sabe.
function validarCatalogo(dados, bytes) {
  var out = [], i, x, o, j, sz;
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
  '.tg-busca-meta{display:flex;align-items:center;gap:8px;margin-bottom:4px}',
  '.tg-busca-preco{display:inline-flex;align-items:baseline;gap:6px;font-size:14px;color:#111}',
  '.tg-busca-preco strong{font-weight:700}',
  '.tg-busca-de{font-size:11px;color:#8a8a8a;text-decoration:line-through;font-weight:400}',
  '.tg-busca-selo{font-size:10px;font-weight:600;padding:2px 6px;border-radius:4px}',
  '.tg-busca-selo-campeao{background:#ecfdf5;color:#065f46}',
  '.tg-busca-selo-ultimas{background:#fffbeb;color:#92400e}',
  '.tg-busca-pilulas{display:flex;gap:4px;flex-wrap:wrap}',
  '.tg-busca-pilula{font-size:10px;padding:1px 5px;background:#f1f3f5;color:#495057;border-radius:3px;font-weight:500}',
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
 * Mudancas de seguranca e de convivencia: catalogo so na primeira interacao (L6), caixa propria depois do
 * contêiner nativo (L13, metade), nunca mexe no formulario nativo, nunca cancela nem interrompe eventos do tema.
 */
var TG_AC_MIN = 2;
var TG_AC_LIMITE = 6;
var TG_AC_ESPERA = 90;

function tgAcLimpar(caixa) { while (caixa.firstChild) { caixa.removeChild(caixa.firstChild); } }

// Uma linha da lista. Devolve null se o item nao tem link ou preco validos (nao aparece).
function tgAcLinha(p, posicao, consulta, corrigiu) {
  var href = urlProduto(p.s), preco = blocoPreco(p), selo = null, a;
  if (!href || !preco) { return null; }
  if (p.t === 1) { selo = el('span', { 'class': 'tg-busca-selo tg-busca-selo-campeao' }, ['Campeão']); }
  else if (p.t === 4) { selo = el('span', { 'class': 'tg-busca-selo tg-busca-selo-ultimas' }, ['Últimas Peças']); }
  a = el('a', { 'class': 'tg-busca-item', href: href }, [
    foto(p, 'tg-busca-thumb'),
    el('div', { 'class': 'tg-busca-info' }, [
      el('div', { 'class': 'tg-busca-nome' }, [p.n]),
      el('div', { 'class': 'tg-busca-meta' }, [preco, selo]),
      pilulas(p.sz, 5)
    ])
  ]);
  a.addEventListener('click', function () {
    try { emitir('tg_busca_sugestao_click', { position: posicao, query_len: consulta.length, had_correction: corrigiu ? 'sim' : 'nao', engine_version: tgCtx.versao }); } catch (e) {}
  });
  return el('li', null, [a]);
}

function tgAcPintar(pegarCaixa, input, consulta, res) {
  var linhas = [], i, li, ul, todos, sugerido, botao, caixa = pegarCaixa();
  if (!caixa) { return; }
  tgAcLimpar(caixa);
  for (i = 0; i < res.results.length; i++) {
    li = tgAcLinha(res.results[i], linhas.length + 1, consulta, !!res.suggestedTerm);
    if (li) { linhas.push(li); }
  }
  if (!linhas.length) {
    caixa.appendChild(el('div', { 'class': 'tg-busca-banner' }, ['Não encontramos resultados para "', el('strong', null, [consulta]), '".']));
    caixa.classList.remove('tg-busca-oculto');
    return;
  }
  if (res.suggestedTerm) {
    sugerido = res.suggestedTerm;
    botao = el('button', { type: 'button', 'class': 'tg-busca-sugerido' }, [sugerido]);
    botao.addEventListener('click', function () {
      try { input.value = sugerido; tgAcDesenhar(pegarCaixa, input, sugerido); } catch (e) {}
    });
    caixa.appendChild(el('div', { 'class': 'tg-busca-banner' }, ['Buscando por: ', botao]));
  }
  ul = el('ul', { 'class': 'tg-busca-lista' }, linhas);
  caixa.appendChild(ul);
  todos = el('a', { 'class': 'tg-busca-todos', href: urlBusca(consulta) }, ['Ver todos os resultados (' + res.results.length + ')']);
  todos.addEventListener('click', function () {
    try { emitir('tg_busca_ver_todos', { query_len: consulta.length, results_count: res.results.length }); } catch (e) {}
  });
  caixa.appendChild(todos);
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

function tgRgCard(p) {
  var href = urlProduto(p.s), preco = blocoPreco(p);
  if (!href || !preco) { return null; }
  return el('a', { 'class': 'tg-busca-card', href: href }, [
    foto(p, 'tg-busca-thumb'),
    el('div', { 'class': 'tg-busca-nome' }, [p.n]),
    preco,
    pilulas(p.sz, 4)
  ]);
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
    desc = el('div', { 'class': 'tg-busca-zero-desc' }, ['Confira os modelos campeões de venda disponíveis para envio imediato:']);
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
  var q;
  if (!/^\/search/.test(window.location.pathname)) { return; }
  q = String(new URLSearchParams(window.location.search).get('q') || '').trim().slice(0, 200);
  if (!q || document.querySelector('.js-product-table')) { return; }
  obterCatalogo().then(function (cat) {
    if (!cat || document.querySelector('.js-product-table') || document.getElementById('tg-busca-resgate')) { return; }
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
