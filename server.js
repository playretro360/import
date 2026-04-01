// Vendry Sync Server v5.0 — Direct API via evaluate, sem navegação
// Abre página em branco, chama API direto com cookie no header fetch
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
    res.end(JSON.stringify({ ok: true, service: 'vendry-sync', version: '5.0.0' }));
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
        const result = await syncDirect(cookies, spc_cds, fe_session || '');
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

// Endpoints para tentar em ordem
function getEndpoints(spcCds) {
  return [
    {
      name: 'v3-search_product_list',
      method: 'GET',
      url: (cursor) => 'https://seller.shopee.com.br/api/v3/opt/mpsku/list/v2/search_product_list?SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&page_size=12&list_type=live_all&request_attribute=&operation_sort_by=recommend_v2&need_ads=false' + (cursor ? '&cursor=' + cursor : ''),
      extract: (d) => ({
        items: (d.data && d.data.products) || [],
        total: (d.data && d.data.page_info && d.data.page_info.total) || 0,
        cursor: (d.data && d.data.page_info && d.data.page_info.cursor) || '',
        ok: d.code === 0
      })
    },
    {
      name: 'v4-get_item_list',
      method: 'POST',
      url: () => 'https://seller.shopee.com.br/api/v4/product/get_item_list?SPC_CDS=' + spcCds + '&SPC_CDS_VER=2',
      body: (offset) => JSON.stringify({ offset: offset || 0, page_size: 48, filter_status: 'NORMAL', filter_brand_ids: [], filter_condition: 'ALL', sort_by: 'POPULAR', reverse: false }),
      extract: (d) => ({
        items: (d.data && d.data.item_list) || (d.data && d.data.items) || [],
        total: (d.data && d.data.total) || 0,
        cursor: '',
        ok: !d.error && (d.code === 0 || d.code === undefined)
      })
    },
    {
      name: 'v3-product-list',
      method: 'GET',
      url: () => 'https://seller.shopee.com.br/api/v3/product/list_all?SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&page_size=100&page=1',
      extract: (d) => ({
        items: (d.data && (d.data.list || d.data.items || d.data.products)) || [],
        total: (d.data && d.data.total) || 0,
        cursor: '',
        ok: d.code === 0
      })
    }
  ];
}

async function syncDirect(cookieStr, spcCds, feSession) {
  let browser = null;
  let page = null;
  try {
    console.log('[sync] v5.0 conectando BD...');
    browser = await puppeteer.connect({ browserWSEndpoint: BD_WSS, defaultViewport: null });
    page = await browser.newPage();

    // Navega para about:blank — contexto limpo, sem conflito de cookies do BD
    await page.goto('about:blank');

    const endpoints = getEndpoints(spcCds);
    const csrf = (cookieStr.match(/csrftoken=([^;]+)/) || [])[1] || '';

    for (const ep of endpoints) {
      console.log('[sync] tentando ' + ep.name + '...');
      try {
        const items = await fetchAllPages(page, ep, cookieStr, feSession, csrf);
        if (items.length > 0) {
          const products = items.map(mapProduct).filter(Boolean);
          console.log('[sync] OK! ' + products.length + ' produtos via ' + ep.name);
          return { products, strategy: ep.name };
        }
        console.log('[sync] ' + ep.name + ' retornou 0 items, tentando proximo...');
      } catch (e) {
        console.log('[sync] ' + ep.name + ' erro: ' + e.message);
      }
    }

    throw new Error('Todos os endpoints falharam. Verifique os cookies da loja.');
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

async function fetchAllPages(page, ep, cookieStr, feSession, csrf) {
  const all = [];
  let cursor = '';
  let offset = 0;
  let page_num = 0;
  const MAX_PAGES = 50;

  while (page_num < MAX_PAGES) {
    page_num++;
    const url = ep.url(cursor || offset);
    const body = ep.body ? ep.body(offset) : null;

    const raw = await page.evaluate(async (url, method, body, ck, fs, xcsrf) => {
      try {
        const opts = {
          method,
          headers: {
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'pt-BR,pt;q=0.9',
            'content-type': 'application/json;charset=UTF-8',
            'cookie': ck,
            'origin': 'https://seller.shopee.com.br',
            'referer': 'https://seller.shopee.com.br/portal/product/list/all',
            'sc-fe-session': fs,
            'sc-fe-ver': '21.141883',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
            'locale': 'pt-br',
            'caller-source': 'local_pc',
            'x-csrftoken': xcsrf,
          }
        };
        if (body) opts.body = body;
        const r = await fetch(url, opts);
        const text = await r.text();
        return JSON.stringify({ status: r.status, body: text });
      } catch (e) {
        return JSON.stringify({ _err: e.message });
      }
    }, url, ep.method, body, cookieStr, feSession, csrf);

    const wrapper = JSON.parse(raw);
    if (wrapper._err) throw new Error(wrapper._err);
    if (wrapper.status >= 400) throw new Error('HTTP ' + wrapper.status);

    let data;
    try { data = JSON.parse(wrapper.body); } catch (e) { throw new Error('JSON parse fail: ' + wrapper.body.slice(0, 100)); }

    console.log('[sync] [' + ep.name + '] pg' + page_num + ' status=' + wrapper.status + ' code=' + data.code + ' body=' + wrapper.body.slice(0, 150));

    const ext = ep.extract(data);
    if (!ext.ok && ext.items.length === 0) {
      throw new Error('code=' + data.code + ' msg=' + (data.message || data.errcode || ''));
    }

    all.push(...ext.items);

    const hasMore = ext.items.length > 0 && (
      (ext.cursor && ext.cursor !== cursor) ||
      (ep.name.includes('v4') && ext.items.length >= 48 && (ext.total === 0 || all.length < ext.total))
    );

    if (!hasMore) break;
    cursor = ext.cursor || cursor;
    offset += ext.items.length;
    await new Promise(r => setTimeout(r, 350));
  }

  return all;
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

server.listen(PORT, () => {
  console.log('Vendry Sync v5.0 porta ' + PORT);
  console.log('BD_WSS: ' + BD_WSS.replace(/:([^:@]+)@/, ':***@'));
});
