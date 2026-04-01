// Vendry Sync Server v4.0 — PUPPETEER REAL via Bright Data
// Navega de verdade no seller center e intercepta as respostas
const http = require('http');
const puppeteer = require('puppeteer-core');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.SYNC_SECRET || 'vendry-sync-2025';
const BD_WSS = process.env.BD_WSS || 'wss://brd-customer-hl_22f8cdf5-zone-scraping_browser1:tv264i12x4he@brd.superproxy.io:9222';

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, service: 'vendry-sync', version: '4.0.0' }));
    return;
  }

  const auth = req.headers['authorization'] || '';
  if (auth !== 'Bearer ' + SECRET) {
    res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
  }

  if (req.method === 'POST' && req.url === '/sync') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { cookies, spc_cds, fe_session } = JSON.parse(body);
        if (!cookies || !spc_cds) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'cookies e spc_cds obrigatorios' })); return;
        }
        const result = await syncWithPuppeteer(cookies, spc_cds, fe_session || '');
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, products: result.products, total: result.products.length, strategy: result.strategy }));
      } catch (err) {
        console.error('[sync] erro:', err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
});

async function syncWithPuppeteer(cookieStr, spcCds, feSession) {
  let browser = null;
  let page = null;

  try {
    console.log('[sync] v4.0 conectando puppeteer ao BD...');
    browser = await puppeteer.connect({ browserWSEndpoint: BD_WSS, defaultViewport: null });
    page = await browser.newPage();

    // ── 1. Injeta cookies ─────────────────────────────────────
    const cookieArr = cookieStr.split(';').map(p => {
      const eq = p.indexOf('=');
      if (eq < 0) return null;
      const name = p.slice(0, eq).trim();
      const value = p.slice(eq + 1).trim();
      if (!name) return null;
      return { name, value, domain: '.shopee.com.br', path: '/', httpOnly: false, secure: true, sameSite: 'None' };
    }).filter(Boolean);

    // BD Scraping Browser proíbe sobrescrever alguns cookies próprios
    const blockedCookies = ['SPC_F','REC_T_ID','SPC_CLIENTID','SC_DFP','_QPWSDCXHZQA','REC7iLP4Q','ca_gen_id'];
    const safeCookies = cookieArr.filter(c => !blockedCookies.includes(c.name));
    if (safeCookies.length > 0) await page.setCookie(...safeCookies);
    console.log('[sync] ' + cookieArr.length + ' cookies injetados');

    // ── 2. Intercepta respostas da API de produtos ────────────
    const intercepted = [];
    let resolveIntercept = null;
    let interceptTimeout = null;
    const interceptPromise = new Promise(resolve => { resolveIntercept = resolve; });

    await page.setRequestInterception(true);
    page.on('request', req => {
      // Passa todas as requests sem bloquear
      req.continue();
    });

    page.on('response', async resp => {
      const url = resp.url();
      // Captura qualquer endpoint de produto/item
      const isProductApi = (
        url.includes('/api/v3/opt/mpsku/list') ||
        url.includes('/api/v4/product/get_item_list') ||
        url.includes('/api/v3/product/list') ||
        url.includes('/api/v2/product/list') ||
        (url.includes('item') && url.includes('SPC_CDS') && url.includes('shopee'))
      );
      if (isProductApi) {
        try {
          const data = await resp.json().catch(() => null);
          if (data) {
            console.log('[sync] interceptado: ' + url.split('?')[0].split('/').slice(-3).join('/'));
            intercepted.push({ url, data });
            // Se tiver produtos, resolve
            const items = extractItems(data);
            if (items.length > 0) {
              clearTimeout(interceptTimeout);
              resolveIntercept({ url, data, items });
            }
          }
        } catch (e) {}
      }
    });

    // ── 3. Navega para o seller center ────────────────────────
    console.log('[sync] navegando para seller center...');
    await page.setExtraHTTPHeaders({
      'sc-fe-session': feSession,
      'sc-fe-ver': '21.141883',
      'locale': 'pt-br',
      'caller-source': 'local_pc',
    });

    // Navega — a própria página vai fazer as chamadas de API
    interceptTimeout = setTimeout(() => resolveIntercept(null), 20000);

    await page.goto('https://seller.shopee.com.br/portal/product/list/all', {
      waitUntil: 'domcontentloaded',
      timeout: 25000
    }).catch(e => console.log('[sync] goto warn:', e.message));

    // Aguarda interceptação ou timeout de 20s
    const firstResult = await interceptPromise;

    let allProducts = [];
    let strategy = 'unknown';

    if (firstResult && firstResult.items.length > 0) {
      // Estratégia de interceptação funcionou!
      strategy = 'intercept:' + firstResult.url.split('?')[0].split('/').slice(-3).join('/');
      const firstItems = firstResult.items;
      const firstData = firstResult.data;
      allProducts.push(...firstItems.map(item => mapProduct(item)));
      console.log('[sync] intercept OK: ' + allProducts.length + ' produtos na 1a página');

      // Tenta paginar via evaluate
      const total = extractTotal(firstData);
      if (total > allProducts.length) {
        console.log('[sync] paginando... total=' + total);
        const extra = await paginateViaEvaluate(page, spcCds, feSession, allProducts.length, total);
        allProducts.push(...extra);
      }

    } else {
      // Fallback: tenta direto via page.evaluate com fetch explícito
      console.log('[sync] intercept falhou — tentando evaluate fetch direto...');
      const result = await tryEvaluateFetch(page, spcCds, feSession, cookieStr);
      if (result.length > 0) {
        strategy = 'evaluate-fetch';
        allProducts = result;
      } else {
        throw new Error('Nenhuma estratégia retornou produtos. Verifique os cookies.');
      }
    }

    console.log('[sync] DONE: ' + allProducts.length + ' produtos | strategy=' + strategy);
    return { products: allProducts, strategy };

  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

// ── Extrai items de qualquer formato de resposta Shopee ───────
function extractItems(data) {
  if (!data) return [];
  return (data.data && data.data.products) ||
    (data.data && data.data.item_list) ||
    (data.data && data.data.items) ||
    (data.data && data.data.list) ||
    data.items || data.list || [];
}

function extractTotal(data) {
  if (!data || !data.data) return 0;
  return (data.data.page_info && data.data.page_info.total) ||
    data.data.total || 0;
}

function mapProduct(item) {
  if (!item) return null;
  const imgs = item.images || item.image || [];
  const imgArr = Array.isArray(imgs) ? imgs : [imgs];
  const img = (imgArr[0] && imgArr[0].image_url) ||
    (imgArr[0] && imgArr[0].image_url_list && imgArr[0].image_url_list[0]) ||
    (typeof imgArr[0] === 'string' ? 'https://down-br.img.susercontent.com/file/' + imgArr[0] : '');
  return {
    id: item.item_id || item.id,
    name: item.name || item.item_name || '',
    price: (item.price || item.min_price || (item.price_info && item.price_info[0] && item.price_info[0].current_price) || 0) / 100000,
    stock: item.stock || item.total_available_stock || 0,
    image: img,
    status: item.item_status || item.status || 'NORMAL',
    sales: item.sold || 0
  };
}

// ── Paginação adicional via evaluate ─────────────────────────
async function paginateViaEvaluate(page, spcCds, feSession, startOffset, total) {
  const all = [];
  let cursor = '';
  let offset = startOffset;
  let attempts = 0;
  const maxPages = Math.ceil(total / 12) + 1;

  while (offset < total && attempts < maxPages) {
    attempts++;
    const params = 'SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&page_size=12&list_type=live_all&request_attribute=&operation_sort_by=recommend_v2&need_ads=false' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    try {
      const raw = await page.evaluate(async (url, fs) => {
        try {
          const r = await fetch(url, { method: 'GET', credentials: 'include', headers: { 'sc-fe-session': fs, 'referer': 'https://seller.shopee.com.br/portal/product/list/all' } });
          return JSON.stringify(await r.json());
        } catch (e) { return JSON.stringify({ _err: e.message }); }
      }, 'https://seller.shopee.com.br/api/v3/opt/mpsku/list/v2/search_product_list?' + params, feSession);

      const data = JSON.parse(raw);
      if (data._err || data.code !== 0) break;
      const items = (data.data && data.data.products) || [];
      if (items.length === 0) break;
      all.push(...items.map(mapProduct));
      cursor = (data.data && data.data.page_info && data.data.page_info.cursor) || '';
      offset += items.length;
      console.log('[sync] paginate: +' + items.length + ' (acum=' + (startOffset + all.length) + '/' + total + ')');
      if (!cursor) break;
      await new Promise(r => setTimeout(r, 350));
    } catch (e) { break; }
  }
  return all;
}

// ── Fallback: evaluate fetch explícito com cookie no header ──
async function tryEvaluateFetch(page, spcCds, feSession, cookieStr) {
  const endpoints = [
    { url: 'https://seller.shopee.com.br/api/v3/opt/mpsku/list/v2/search_product_list?SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&page_size=12&list_type=live_all&request_attribute=&operation_sort_by=recommend_v2&need_ads=false', method: 'GET' },
    { url: 'https://seller.shopee.com.br/api/v4/product/get_item_list?SPC_CDS=' + spcCds + '&SPC_CDS_VER=2', method: 'POST', body: JSON.stringify({ offset: 0, page_size: 50, filter_status: 'NORMAL', filter_brand_ids: [], filter_condition: 'ALL', sort_by: 'POPULAR', reverse: false }) },
  ];

  for (const ep of endpoints) {
    try {
      const raw = await page.evaluate(async (ep, ck, fs) => {
        try {
          const opts = { method: ep.method, credentials: 'include', headers: { 'accept': 'application/json,*/*', 'cookie': ck, 'referer': 'https://seller.shopee.com.br/portal/product/list/all', 'sc-fe-session': fs, 'content-type': 'application/json;charset=UTF-8' } };
          if (ep.body) opts.body = ep.body;
          const r = await fetch(ep.url, opts);
          return JSON.stringify(await r.json());
        } catch (e) { return JSON.stringify({ _err: e.message }); }
      }, ep, cookieStr, feSession);

      const data = JSON.parse(raw);
      if (data._err) { console.log('[sync] fallback ' + ep.url.split('?')[0].split('/').pop() + ' err: ' + data._err); continue; }
      const items = extractItems(data);
      if (items.length > 0) {
        console.log('[sync] fallback OK: ' + items.length + ' items via ' + ep.url.split('/').pop().split('?')[0]);
        return items.map(mapProduct).filter(Boolean);
      }
    } catch (e) { console.log('[sync] fallback ex:', e.message); }
  }
  return [];
}

server.listen(PORT, () => {
  console.log('Vendry Sync v4.0 PUPPETEER porta ' + PORT);
  console.log('BD_WSS: ' + BD_WSS.replace(/:([^:@]+)@/, ':***@'));
});
