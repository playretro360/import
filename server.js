// Vendry Sync Server v4.1 — Puppeteer + BD, zero setCookie
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
    res.end(JSON.stringify({ ok: true, service: 'vendry-sync', version: '4.1.0' }));
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
    console.log('[sync] v4.1 conectando...');
    browser = await puppeteer.connect({ browserWSEndpoint: BD_WSS, defaultViewport: null });
    page = await browser.newPage();

    // Passa cookies via header HTTP — BD não permite setCookie
    await page.setExtraHTTPHeaders({
      'cookie': cookieStr,
      'sc-fe-session': feSession,
      'sc-fe-ver': '21.141883',
      'locale': 'pt-br',
      'caller-source': 'local_pc',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
    });

    // Intercepta respostas de produto enquanto navega
    const intercepted = [];
    let resolveIntercept;
    const interceptPromise = new Promise(r => { resolveIntercept = r; });
    let interceptTimeout;

    await page.setRequestInterception(true);
    page.on('request', r => r.continue());
    page.on('response', async resp => {
      const url = resp.url();
      if (
        url.includes('/api/v3/opt/mpsku/list') ||
        url.includes('/api/v4/product/get_item_list') ||
        url.includes('/api/v3/product/list')
      ) {
        try {
          const data = await resp.json().catch(() => null);
          if (!data) return;
          const items = extractItems(data);
          console.log('[sync] intercept ' + url.split('?')[0].split('/').slice(-3).join('/') + ' items=' + items.length);
          if (items.length > 0) {
            clearTimeout(interceptTimeout);
            resolveIntercept({ url, data, items });
          }
        } catch (e) {}
      }
    });

    interceptTimeout = setTimeout(() => resolveIntercept(null), 22000);

    console.log('[sync] navegando...');
    await page.goto('https://seller.shopee.com.br/portal/product/list/all', {
      waitUntil: 'domcontentloaded', timeout: 25000
    }).catch(e => console.log('[sync] goto:', e.message));

    const first = await interceptPromise;
    let allProducts = [];
    let strategy = 'none';

    if (first && first.items.length > 0) {
      strategy = 'intercept:' + first.url.split('?')[0].split('/').slice(-2).join('/');
      allProducts = first.items.map(mapProduct).filter(Boolean);
      console.log('[sync] intercept OK: ' + allProducts.length + ' produtos');

      const total = extractTotal(first.data);
      if (total > allProducts.length) {
        const extra = await paginate(page, spcCds, feSession, cookieStr, allProducts.length, total, first.url);
        allProducts.push(...extra);
      }
    } else {
      // Fallback: evaluate fetch explícito
      console.log('[sync] intercept falhou — fallback evaluate...');
      const fb = await fallbackFetch(page, spcCds, feSession, cookieStr);
      if (fb.length > 0) {
        strategy = 'fallback-evaluate';
        allProducts = fb;
      } else {
        throw new Error('Nenhum produto encontrado. Cookies podem estar expirados.');
      }
    }

    console.log('[sync] DONE: ' + allProducts.length + ' | strategy=' + strategy);
    return { products: allProducts, strategy };
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

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
  return (data.data.page_info && data.data.page_info.total) || data.data.total || 0;
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

async function paginate(page, spcCds, feSession, cookieStr, startOffset, total, firstUrl) {
  const all = [];
  let cursor = '';
  let offset = startOffset;
  const isV3 = firstUrl && firstUrl.includes('v3');
  const maxPages = Math.ceil(total / 12) + 2;
  let attempts = 0;

  while (offset < total && attempts < maxPages) {
    attempts++;
    try {
      let url;
      if (isV3) {
        url = 'https://seller.shopee.com.br/api/v3/opt/mpsku/list/v2/search_product_list?SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&page_size=12&list_type=live_all&request_attribute=&operation_sort_by=recommend_v2&need_ads=false' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      } else {
        url = 'https://seller.shopee.com.br/api/v4/product/get_item_list?SPC_CDS=' + spcCds + '&SPC_CDS_VER=2';
      }

      const raw = await page.evaluate(async (url, fs, ck, isV3, off) => {
        try {
          const opts = {
            method: isV3 ? 'GET' : 'POST',
            credentials: 'include',
            headers: { 'accept': 'application/json,*/*', 'cookie': ck, 'sc-fe-session': fs, 'referer': 'https://seller.shopee.com.br/portal/product/list/all', 'content-type': 'application/json;charset=UTF-8' }
          };
          if (!isV3) opts.body = JSON.stringify({ offset: off, page_size: 48, filter_status: 'NORMAL', filter_brand_ids: [], filter_condition: 'ALL', sort_by: 'POPULAR', reverse: false });
          const r = await fetch(url, opts);
          return JSON.stringify(await r.json());
        } catch (e) { return JSON.stringify({ _err: e.message }); }
      }, url, feSession, cookieStr, isV3, offset);

      const data = JSON.parse(raw);
      if (data._err || (data.code !== undefined && data.code !== 0)) break;
      const items = extractItems(data);
      if (!items.length) break;
      all.push(...items.map(mapProduct).filter(Boolean));
      cursor = (data.data && data.data.page_info && data.data.page_info.cursor) || '';
      offset += items.length;
      console.log('[sync] paginate +' + items.length + ' (acum=' + (startOffset + all.length) + '/' + total + ')');
      if (!cursor && isV3) break;
      await new Promise(r => setTimeout(r, 400));
    } catch (e) { console.log('[sync] paginate err:', e.message); break; }
  }
  return all;
}

async function fallbackFetch(page, spcCds, feSession, cookieStr) {
  const endpoints = [
    { url: 'https://seller.shopee.com.br/api/v3/opt/mpsku/list/v2/search_product_list?SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&page_size=12&list_type=live_all&request_attribute=&operation_sort_by=recommend_v2&need_ads=false', method: 'GET' },
    { url: 'https://seller.shopee.com.br/api/v4/product/get_item_list?SPC_CDS=' + spcCds + '&SPC_CDS_VER=2', method: 'POST', body: JSON.stringify({ offset: 0, page_size: 48, filter_status: 'NORMAL', filter_brand_ids: [], filter_condition: 'ALL', sort_by: 'POPULAR', reverse: false }) },
  ];
  for (const ep of endpoints) {
    try {
      const raw = await page.evaluate(async (ep, ck, fs) => {
        try {
          const opts = { method: ep.method, credentials: 'include', headers: { 'accept': 'application/json,*/*', 'cookie': ck, 'sc-fe-session': fs, 'referer': 'https://seller.shopee.com.br/portal/product/list/all', 'content-type': 'application/json;charset=UTF-8' } };
          if (ep.body) opts.body = ep.body;
          const r = await fetch(ep.url, opts);
          return JSON.stringify(await r.json());
        } catch (e) { return JSON.stringify({ _err: e.message }); }
      }, ep, cookieStr, feSession);
      const data = JSON.parse(raw);
      if (data._err) { console.log('[sync] fallback err:', data._err); continue; }
      const items = extractItems(data);
      if (items.length > 0) {
        console.log('[sync] fallback OK: ' + items.length + ' via ' + ep.url.split('/').pop().split('?')[0]);
        return items.map(mapProduct).filter(Boolean);
      }
    } catch (e) { console.log('[sync] fallback ex:', e.message); }
  }
  return [];
}

server.listen(PORT, () => {
  console.log('Vendry Sync v4.1 porta ' + PORT);
  console.log('BD_WSS: ' + BD_WSS.replace(/:([^:@]+)@/, ':***@'));
});
