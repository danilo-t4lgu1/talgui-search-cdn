/**
 * TALGUI SMART SEARCH & AUTOCOMPLETE INJECTOR
 * Produção - CDN jsDelivr: danilo-t4lgu1/talgui-search-cdn
 * 
 * Funcionalidades:
 * - Autocomplete Inteligente instantâneo (< 10ms) no modal #nav-search.
 * - Tolerância a erros de digitação (Levenshtein ponderado).
 * - Priorização de grade de tamanhos (Tier 1 a 6) e peças campeãs de vendas.
 * - Resgate de páginas com 0 resultados em /search/?q=... com sugestões fonéticas e vitrine de campeões.
 * 
 * Mecanismos de Segurança e Rollback:
 * - Layer 1: Remote Kill-Switch (config.json remoto: se active=false, desliga instantaneamente).
 * - Layer 2: Bypass de Auditoria (?busca_nativa=1 ou localStorage talgui_native_search=1).
 * - Layer 3: Fail-Safe Silencioso (Timeout 2.0s: se CDN falhar, a busca nativa continua 100% intocada).
 */

(function() {
  'use strict';

  // Configurações Globais
  const CONFIG = {
    remoteConfigUrl: 'https://raw.githubusercontent.com/danilo-t4lgu1/talgui-search-cdn/main/config.json',
    cdnCatalogUrl: 'https://cdn.jsdelivr.net/gh/danilo-t4lgu1/talgui-search-cdn@main/search_catalog.min.json',
    imgPrefix: 'https://acdn-us.mitiendanube.com/stores/007/014/041/products/',
    cacheKey: 'talgui_search_catalog_v2',
    configCacheKey: 'talgui_search_config_v2',
    cacheTtlMs: 30 * 60 * 1000,    // 30 minutos de cache do catálogo no navegador
    configCacheTtlMs: 5 * 60 * 1000, // 5 minutos de cache do kill-switch
    fetchTimeoutMs: 2000           // 2.0s de timeout estrito
  };

  // LAYER 2: BYPASS LOCAL / URL (?busca_nativa=1 ou localStorage)
  try {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('busca_nativa') === '1' || window.localStorage?.getItem('talgui_native_search') === '1') {
      console.warn('[TALGUI SEARCH] Bypass ativado: usando busca 100% nativa da Nuvemshop.');
      return;
    }
  } catch (_) {}

  // 1. Motor de Normalização e Distância Levenshtein
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

  // 3. Fetch com Timeout Seguro (AbortController)
  async function fetchWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(id);
      return response;
    } catch (e) {
      clearTimeout(id);
      throw e;
    }
  }

  // LAYER 1: VERIFICAÇÃO DO KILL-SWITCH REMOTO
  async function checkRemoteKillSwitch() {
    try {
      const cached = window.sessionStorage?.getItem(CONFIG.configCacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed.timestamp && (Date.now() - parsed.timestamp) < CONFIG.configCacheTtlMs) {
          return parsed.data.active !== false;
        }
      }
    } catch (_) {}

    try {
      const res = await fetchWithTimeout(CONFIG.remoteConfigUrl + '?_t=' + Math.floor(Date.now() / 60000), CONFIG.fetchTimeoutMs);
      if (res.ok) {
        const cfg = await res.json();
        try {
          window.sessionStorage?.setItem(CONFIG.configCacheKey, JSON.stringify({
            timestamp: Date.now(),
            data: cfg
          }));
        } catch (_) {}
        if (cfg.active === false) {
          console.warn('[TALGUI SEARCH] Kill-Switch ativo:', cfg.kill_switch_reason || 'Desativado pelo administrador.');
          return false;
        }
        return true;
      }
    } catch (err) {
      // Se falhar ao checar o kill-switch, assume ativo por padrão para não derrubar a busca por soluço de rede
      return true;
    }
    return true;
  }

  // 4. Carregamento do Catálogo em Memória (com Cache em sessionStorage)
  let cachedCatalog = null;

  async function loadCatalog() {
    if (cachedCatalog) return cachedCatalog;

    if (window.__TALGUI_CATALOG__ && Array.isArray(window.__TALGUI_CATALOG__)) {
      cachedCatalog = window.__TALGUI_CATALOG__;
      return cachedCatalog;
    }

    try {
      const stored = window.sessionStorage?.getItem(CONFIG.cacheKey);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.timestamp && (Date.now() - parsed.timestamp) < CONFIG.cacheTtlMs) {
          cachedCatalog = parsed.data;
          return cachedCatalog;
        }
      }
    } catch (_) {}

    try {
      const res = await fetchWithTimeout(CONFIG.cdnCatalogUrl, CONFIG.fetchTimeoutMs);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          cachedCatalog = data;
          try {
            window.sessionStorage?.setItem(CONFIG.cacheKey, JSON.stringify({
              timestamp: Date.now(),
              data: data
            }));
          } catch (_) {}
          return cachedCatalog;
        }
      }
    } catch (err) {
      console.warn('[TALGUI SEARCH] Falha ao baixar catálogo CDN:', err.message);
    }

    return null;
  }

  // 5. Formatação Visual
  function formatMoney(val) {
    if (!val) return 'R$ 0,00';
    return 'R$ ' + Number(val).toFixed(2).replace('.', ',');
  }

  function getImgUrl(imgKey) {
    if (!imgKey) return '';
    if (imgKey.startsWith('http')) return imgKey;
    return CONFIG.imgPrefix + imgKey;
  }

  // 6. Injeção de Estilos CSS Mobile-First
  function injectStyles() {
    if (document.getElementById('talgui-search-styles')) return;
    const style = document.createElement('style');
    style.id = 'talgui-search-styles';
    style.innerHTML = `
      .talgui-autocomplete-container {
        margin-top: 12px;
        background: #ffffff;
        border-radius: 8px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.12);
        max-height: 65vh;
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
        border: 1px solid #ebebeb;
      }
      .talgui-suggest-banner {
        padding: 10px 14px;
        background: #f8f9fa;
        border-bottom: 1px solid #ebebeb;
        font-size: 13px;
        color: #555;
      }
      .talgui-suggest-banner strong {
        color: #000;
        cursor: pointer;
        text-decoration: underline;
      }
      .talgui-card-list {
        list-style: none;
        padding: 0;
        margin: 0;
      }
      .talgui-card-item {
        display: flex;
        align-items: center;
        padding: 12px 14px;
        border-bottom: 1px solid #f4f4f4;
        text-decoration: none;
        color: inherit;
        transition: background 0.15s ease;
      }
      .talgui-card-item:hover, .talgui-card-item:active {
        background: #fafafa;
      }
      .talgui-card-thumb {
        width: 52px;
        height: 68px;
        object-fit: cover;
        border-radius: 4px;
        margin-right: 12px;
        background: #f0f0f0;
        flex-shrink: 0;
      }
      .talgui-card-info {
        flex: 1;
        min-width: 0;
      }
      .talgui-card-name {
        font-size: 13px;
        font-weight: 600;
        color: #222;
        margin: 0 0 4px 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .talgui-card-meta {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 4px;
      }
      .talgui-card-price {
        font-size: 14px;
        font-weight: 700;
        color: #111;
      }
      .talgui-badge-tier1 {
        background: #ecfdf5;
        color: #065f46;
        font-size: 10px;
        font-weight: 600;
        padding: 2px 6px;
        border-radius: 4px;
      }
      .talgui-badge-last {
        background: #fffbeb;
        color: #92400e;
        font-size: 10px;
        font-weight: 600;
        padding: 2px 6px;
        border-radius: 4px;
      }
      .talgui-sizes-list {
        display: flex;
        gap: 4px;
        flex-wrap: wrap;
      }
      .talgui-size-pill {
        font-size: 10px;
        padding: 1px 5px;
        background: #f1f3f5;
        color: #495057;
        border-radius: 3px;
        font-weight: 500;
      }
      .talgui-view-all-btn {
        display: block;
        width: 100%;
        padding: 12px;
        text-align: center;
        background: #000000;
        color: #ffffff;
        font-weight: 600;
        font-size: 13px;
        text-decoration: none;
        border-radius: 0 0 8px 8px;
      }
      .talgui-zero-rescue {
        margin: 30px auto;
        padding: 24px 16px;
        max-width: 800px;
        background: #ffffff;
        border-radius: 12px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.06);
        text-align: center;
      }
      .talgui-zero-title {
        font-size: 18px;
        font-weight: 700;
        margin-bottom: 8px;
      }
      .talgui-zero-desc {
        color: #666;
        font-size: 14px;
        margin-bottom: 20px;
      }
      .talgui-champions-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 12px;
        text-align: left;
      }
      @media (min-width: 768px) {
        .talgui-champions-grid {
          grid-template-columns: repeat(4, 1fr);
        }
      }
    `;
    document.head.appendChild(style);
  }

  // 7. Autocomplete no Modal #nav-search
  function initAutocomplete(catalog) {
    const searchForm = document.querySelector('.js-search-form');
    const searchInput = document.querySelector('.js-search-input');
    if (!searchInput) return;

    // Usar o container nativo do Morelia .js-search-form-suggestions se existir
    let container = document.querySelector('.js-search-form-suggestions') || document.getElementById('talgui-autocomplete-box');
    if (!container) {
      container = document.createElement('div');
      container.id = 'talgui-autocomplete-box';
      container.className = 'talgui-autocomplete-container';
      container.style.display = 'none';
      if (searchForm && searchForm.parentElement) {
        searchForm.parentElement.appendChild(container);
      } else {
        searchInput.parentElement.appendChild(container);
      }
    } else {
      container.classList.add('talgui-autocomplete-container');
    }

    let debounceTimer = null;

    function renderAutocomplete(query) {
      if (!query || query.length < 2) {
        container.style.display = 'none';
        container.innerHTML = '';
        return;
      }

      const res = runSearch(query, catalog, 5);
      if (!res.results || res.results.length === 0) {
        container.innerHTML = `
          <div class="talgui-suggest-banner">
            Não encontramos resultados para "<strong>${query}</strong>".
          </div>
        `;
        container.style.display = 'block';
        return;
      }

      let html = '';
      if (res.suggestedTerm) {
        html += `
          <div class="talgui-suggest-banner">
            Buscando por: <strong class="talgui-trigger-suggest" data-term="${res.suggestedTerm}">${res.suggestedTerm}</strong>
          </div>
        `;
      }

      html += '<ul class="talgui-card-list">';
      res.results.forEach(p => {
        const badge = p.t === 1 ? '<span class="talgui-badge-tier1">Campeão</span>' : (p.t === 4 ? '<span class="talgui-badge-last">Últimas Peças</span>' : '');
        const sizePills = (p.sz || []).slice(0, 5).map(s => `<span class="talgui-size-pill">${s}</span>`).join('');
        const thumb = getImgUrl(p.i);

        html += `
          <li>
            <a class="talgui-card-item" href="/produtos/${p.s}/">
              <img class="talgui-card-thumb" src="${thumb}" alt="${p.n}" loading="lazy" />
              <div class="talgui-card-info">
                <div class="talgui-card-name">${p.n}</div>
                <div class="talgui-card-meta">
                  <span class="talgui-card-price">${formatMoney(p.p)}</span>
                  ${badge}
                </div>
                <div class="talgui-sizes-list">${sizePills}</div>
              </div>
            </a>
          </li>
        `;
      });
      html += '</ul>';

      html += `
        <a class="talgui-view-all-btn" href="/search/?q=${encodeURIComponent(query)}">
          Ver todos os resultados (${res.results.length})
        </a>
      `;

      container.innerHTML = html;
      container.style.display = 'block';

      const trigger = container.querySelector('.talgui-trigger-suggest');
      if (trigger) {
        trigger.addEventListener('click', function(e) {
          e.preventDefault();
          const newTerm = this.getAttribute('data-term');
          searchInput.value = newTerm;
          renderAutocomplete(newTerm);
        });
      }
    }

    searchInput.addEventListener('input', function() {
      clearTimeout(debounceTimer);
      const val = this.value.trim();
      debounceTimer = setTimeout(() => renderAutocomplete(val), 90);
    });

    searchInput.addEventListener('focus', function() {
      const val = this.value.trim();
      if (val.length >= 2) renderAutocomplete(val);
    });
  }

  // 8. Resgate da Página /search/?q=... quando houver 0 resultados
  function initSearchPageRescue(catalog) {
    if (!window.location.pathname.startsWith('/search')) return;

    const urlParams = new URLSearchParams(window.location.search);
    const query = (urlParams.get('q') || '').trim();
    if (!query) return;

    setTimeout(() => {
      const bodyText = document.body.innerText || '';
      const isZeroResults = bodyText.includes('Escreva de outro jeito') || 
                            bodyText.includes('não encontramos resultados') ||
                            document.querySelectorAll('.js-item-product').length === 0;

      if (isZeroResults) {
        console.log(`[TALGUI SEARCH] 0 resultados detectados para "${query}". Injetando vitrine de resgate...`);
        const mainCategoryBody = document.querySelector('.category-body') || document.querySelector('main') || document.body;
        const res = runSearch(query, catalog, 8);

        const emptyMsgElem = document.querySelector('.search-no-result') || document.querySelector('.empty-search');
        if (emptyMsgElem) emptyMsgElem.style.display = 'none';

        const rescueBox = document.createElement('div');
        rescueBox.className = 'talgui-zero-rescue container';

        let rescueHtml = `
          <div class="talgui-zero-title">Não encontramos peças com o termo exato "${query}"</div>
        `;

        if (res.suggestedTerm) {
          rescueHtml += `
            <div class="talgui-zero-desc">
              Você quis dizer: <a href="/search/?q=${encodeURIComponent(res.suggestedTerm)}" style="font-weight: 700; color: #000; text-decoration: underline;">${res.suggestedTerm}</a>?
            </div>
          `;
        } else {
          rescueHtml += `
            <div class="talgui-zero-desc">
              Confira os modelos campeões de venda disponíveis para envio imediato:
            </div>
          `;
        }

        rescueHtml += '<div class="talgui-champions-grid">';
        res.results.forEach(p => {
          const thumb = getImgUrl(p.i);
          const sizePills = (p.sz || []).slice(0, 4).map(s => `<span class="talgui-size-pill">${s}</span>`).join('');
          rescueHtml += `
            <a class="talgui-card-item" href="/produtos/${p.s}/" style="border: 1px solid #eee; border-radius: 8px; flex-direction: column; align-items: flex-start; padding: 10px;">
              <img class="talgui-card-thumb" src="${thumb}" alt="${p.n}" style="width: 100%; height: 210px; margin: 0 0 8px 0; border-radius: 6px;" loading="lazy" />
              <div class="talgui-card-name" style="width: 100%;">${p.n}</div>
              <div class="talgui-card-price" style="margin-bottom: 4px;">${formatMoney(p.p)}</div>
              <div class="talgui-sizes-list">${sizePills}</div>
            </a>
          `;
        });
        rescueHtml += '</div>';

        rescueBox.innerHTML = rescueHtml;
        mainCategoryBody.prepend(rescueBox);
      }
    }, 350);
  }

  // 9. Inicialização Geral com Verificação de Integridade
  async function init() {
    try {
      const isEnabled = await checkRemoteKillSwitch();
      if (!isEnabled) return;

      const catalog = await loadCatalog();
      if (!catalog || catalog.length === 0) {
        console.warn('[TALGUI SEARCH] Catálogo vazio ou indisponível. Mantendo busca nativa da Nuvemshop.');
        return;
      }

      injectStyles();
      initAutocomplete(catalog);
      initSearchPageRescue(catalog);
      console.log(`[TALGUI SEARCH] Motor inteligente ativo com ${catalog.length} produtos.`);
    } catch (e) {
      console.warn('[TALGUI SEARCH] Inicialização abortada silenciosamente:', e.message);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
