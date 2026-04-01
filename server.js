// Vendry Sync Server v7.0 — MAXIMUM ELASTIC
// Features: multi-endpoint + circuit breaker + field auto-detection
//           + cookie expiry detection + cache fallback + health diagnostics
const http = require('http');
const https = require('https');
const tls = require('tls');
const url_mod = require('url');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.SYNC_SECRET || 'vendry-sync-2025';
const BD_WSS = process.env.BD_WSS || 'wss://brd-customer-hl_22f8cdf5-zone-scraping_browser1:tv264i12x4he@brd.superproxy.io:9222';

// ── PROXY CONFIG ─────────────────────────────────────────────
function getProxy() {
  const m = BD_WSS.match(/wss?:\/\/([^:]+):([^@]+)@([^:/]+)/);
  if (!m) return null;
  return { user: m[1], pass: m[2], host: m[3], port: 22225 };
}

// ── CIRCUIT BREAKER ──────────────────────────────────────────
// Cada endpoint tem seu próprio estado
const breaker = {};
function getBreaker(name) {
  if (!breaker[name]) breaker[name] = { fails: 0, lastFail: 0, ok: true };
  return breaker[name];
}
function recordSuccess(name) {
  const b = getBreaker(name);
  b.fails = 0; b.ok = true;
}
function recordFail(name) {
  const b = getBreaker(name);
  b.fails++; b.lastFail = Date.now();
  if (b.fails >= 3) b.ok = false;
}
function isOpen(name) {
  const b = getBreaker(name);
  if (b.ok) return false;
  // Reset após 5 min
  if (Date.now() - b.lastFail > 300000) { b.fails = 0; b.ok = true; return false; }
  return true;
}

// ── ÚLTIMO ENDPOINT BOM ──────────────────────────────────────
let lastGoodEndpoint = null;
let lastSyncTime = 0;
let lastSyncCount = 0;

// ── ENDPOINTS CATALOG ────────────────────────────────────────
function getEndpoints(spcCds) {
  return [
    // v3 GET cursor-based — endpoint primário
    {
      name: 'v3-search_product_list',
      buildUrl: (cur) => 'https://seller.shopee.com.br/api/v3/opt/mpsku/list/v2/search_product_list' +
        '?SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&page_size=12&list_type=live_all' +
        '&request_attribute=&operation_sort_by=recommend_v2&need_ads=false' +
        (cur ? '&cursor=' + encodeURIComponent(cur) : ''),
      method: 'GET',
      paginated: true,
      extract: (d) => {
        const items = (d.data && d.data.products) || [];
        return {
          items,
          total: (d.data && d.data.page_info && d.data.page_info.total) || 0,
          nextCursor: (d.data && d.data.page_info && d.data.page_info.cursor) || '',
          ok: d.code === 0,
          expired: d.errcode === 2 || d.code === 2,
          errMsg: d.message || d.errcode || ''
        };
      }
    },
    // v3 GET alternativo (path diferente)
    {
      name: 'v3-mpsku-list',
      buildUrl: (cur) => 'https://seller.shopee.com.br/api/v3/opt/mpsku/list?' +
        'SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&page_size=12&list_type=live_all' +
        '&operation_sort_by=recommend_v2&need_ads=false' +
        (cur ? '&cursor=' + encodeURIComponent(cur) : ''),
      method: 'GET',
      paginated: true,
      extract: (d) => ({
        items: (d.data && (d.data.products || d.data.list)) || [],
        total: (d.data && d.data.page_info && d.data.page_info.total) || 0,
        nextCursor: (d.data && d.data.page_info && d.data.page_info.cursor) || '',
        ok: d.code === 0,
        expired: d.errcode === 2 || d.code === 2,
        errMsg: d.message || ''
      })
    },
    // v4 POST offset-based
    {
      name: 'v4-get_item_list',
      buildUrl: () => 'https://seller.shopee.com.br/api/v4/product/get_item_list' +
        '?SPC_CDS=' + spcCds + '&SPC_CDS_VER=2',
      method: 'POST',
      paginated: true,
      buildBody: (offset) => JSON.stringify({
        offset: offset || 0, page_size: 48,
        filter_status: 'NORMAL', filter_brand_ids: [],
        filter_condition: 'ALL', sort_by: 'POPULAR', reverse: false
      }),
      extract: (d) => ({
        items: (d.data && (d.data.item_list || d.data.items)) || [],
        total: (d.data && d.data.total) || 0,
        hasNext: !!(d.data && d.data.has_next_page),
        ok: !d.error && d.error !== 'error_not_found',
        expired: d.error === 'error_auth' || d.error === 'error_session',
        errMsg: d.error || d.message || ''
      })
    },
    // v3 product list (formato antigo)
    {
      name: 'v3-product-list_all',
      buildUrl: (page) => 'https://seller.shopee.com.br/api/v3/product/list_all' +
        '?SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&page_size=100&page=' + (page || 1),
      method: 'GET',
      paginated: false,
      extract: (d) => ({
        items: (d.data && (d.data.list || d.data.items || d.data.products)) || [],
        total: (d.data && d.data.total) || 0,
        ok: d.code === 0,
        expired: d.errcode === 2 || d.code === 2,
        errMsg: d.message || ''
      })
    },
    // v2 fallback
    {
      name: 'v2-product-list',
      buildUrl: (offset) => 'https://seller.shopee.com.br/api/v2/product/list' +
        '?SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&limit=100&offset=' + (offset || 0),
      method: 'GET',
      paginated: false,
      extract: (d) => ({
        items: (d.data && (d.data.list || d.data.items)) || d.items || [],
        total: d.total || (d.data && d.data.total) || 0,
        ok: !d.error && d.code !== 2,
        expired: d.code === 2,
        errMsg: d.message || d.error || ''
      })
    }
  ];
}

// ── FIELD AUTO-DETECTION ─────────────────────────────────────
// Detecta preço, imagem e stock em qualquer estrutura
function autoDetectFields(item) {
  if (!item || typeof item !== 'object') return null;

  // PREÇO — procura em ordem de prioridade
  let price = 0;
  if (item.price_detail) {
    price = parseFloat(item.price_detail.selling_price_min || item.price_detail.price_min || item.price_detail.current_price || 0) || 0;
  }
  if (!price && item.price_info && Array.isArray(item.price_info) && item.price_info[0]) {
    price = (item.price_info[0].current_price || item.price_info[0].original_price || 0) / 100000;
  }
  if (!price && item.price) price = item.price > 10000 ? item.price / 100000 : item.price;
  if (!price && item.min_price) price = item.min_price > 10000 ? item.min_price / 100000 : item.min_price;
  if (!price && item.selling_price) price = item.selling_price > 10000 ? item.selling_price / 100000 : item.selling_price;
  // Busca recursiva em qualquer campo com "price" no nome
  if (!price) {
    for (const k of Object.keys(item)) {
      if (k.toLowerCase().includes('price') && typeof item[k] === 'number' && item[k] > 0) {
        price = item[k] > 10000 ? item[k] / 100000 : item[k];
        break;
      }
    }
  }

  // IMAGEM — cover_image (v3) ou images[] ou image
  let img = '';
  const CDN = 'https://down-br.img.susercontent.com/file/';
  if (item.cover_image && typeof item.cover_image === 'string') {
    img = item.cover_image.startsWith('http') ? item.cover_image : CDN + item.cover_image;
  }
  if (!img && item.images) {
    const imgs = Array.isArray(item.images) ? item.images : [item.images];
    const first = imgs[0];
    if (first) {
      img = (first.image_url) ||
        (first.image_url_list && first.image_url_list[0]) ||
        (typeof first === 'string' ? (first.startsWith('http') ? first : CDN + first) : '');
    }
  }
  if (!img && item.image) {
    img = typeof item.image === 'string'
      ? (item.image.startsWith('http') ? item.image : CDN + item.image)
      : (item.image.url || item.image.image_url || '');
  }
  // Busca em model_list se cover_image não existir
  if (!img && item.model_list && item.model_list[0] && item.model_list[0].image) {
    const mi = item.model_list[0].image;
    img = typeof mi === 'string' ? (mi.startsWith('http') ? mi : CDN + mi) : '';
  }

  // STOCK
  let stock = 0;
  if (item.stock_detail) {
    stock = item.stock_detail.total_available_stock || item.stock_detail.total_seller_stock || 0;
  }
  if (!stock) stock = item.total_available_stock || item.stock || item.quantity || 0;

  // VENDAS
  let sales = 0;
  if (item.statistics) sales = item.statistics.sold_count || item.statistics.sales || 0;
  if (!sales) sales = item.sold || item.sold_count || item.sales || 0;

  // STATUS
  let status = item.item_status || item.status || 'NORMAL';

  return {
    id: item.item_id || item.id || item.item_id,
    name: item.name || item.item_name || item.title || '',
    price: Math.round(price * 100) / 100,
    stock,
    image: img,
    status,
    sales
  };
}

// ── HTTP via PROXY TUNNEL ────────────────────────────────────
function proxyRequest(proxy, targetUrl, opts) {
  return new Promise((resolve, reject) => {
    const parsed = url_mod.parse(targetUrl);
    const targetHost = parsed.hostname;
    const targetPort = parseInt(parsed.port) || 443;
    const timer = setTimeout(() => reject(new Error('Timeout 20s')), 20000);
    const proxyAuth = Buffer.from(proxy.user + ':' + proxy.pass).toString('base64');

    const connectReq = http.request({
      host: proxy.host, port: proxy.port,
      method: 'CONNECT',
      path: targetHost + ':' + targetPort,
      headers: {
        'Host': targetHost + ':' + targetPort,
        'Proxy-Authorization': 'Basic ' + proxyAuth,
        'Proxy-Connection': 'Keep-Alive'
      }
    });

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer); socket.destroy();
        return reject(new Error('Proxy CONNECT ' + res.statusCode));
      }
      const tlsSocket = tls.connect({ host: targetHost, socket, rejectUnauthorized: false }, () => {
        const path = parsed.path || '/';
        const headers = Object.assign({}, opts.headers || {}, { 'Host': targetHost, 'Connection': 'close' });
        if (opts.body) headers['Content-Length'] = Buffer.byteLength(opts.body);
        let reqStr = (opts.method || 'GET') + ' ' + path + ' HTTP/1.1\r\n';
        Object.keys(headers).forEach(k => { reqStr += k + ': ' + headers[k] + '\r\n'; });
        reqStr += '\r\n';
        if (opts.body) reqStr += opts.body;
        tlsSocket.write(reqStr);

        const chunks = [];
        tlsSocket.on('data', d => chunks.push(d));
        tlsSocket.on('end', () => {
          clearTimeout(timer);
          const raw = Buffer.concat(chunks).toString();
          const sep = raw.indexOf('\r\n\r\n');
          const headerPart = raw.slice(0, sep);
          let body = raw.slice(sep + 4);
          const statusMatch = headerPart.match(/HTTP\/1\.\d (\d+)/);
          const status = statusMatch ? parseInt(statusMatch[1]) : 0;
          // Handle chunked encoding
          if (headerPart.toLowerCase().includes('transfer-encoding: chunked')) {
            try {
              let decoded = '';
              let pos = 0;
              while (pos < body.length) {
                const nl = body.indexOf('\r\n', pos);
                if (nl < 0) break;
                const size = parseInt(body.slice(pos, nl), 16);
                if (!size) break;
                decoded += body.slice(nl + 2, nl + 2 + size);
                pos = nl + 2 + size + 2;
              }
              body = decoded;
            } catch (e) {}
          }
          resolve({ status, body });
        });
        tlsSocket.on('error', e => { clearTimeout(timer); reject(e); });
      });
      tlsSocket.on('error', e => { clearTimeout(timer); reject(e); });
    });
    connectReq.on('error', e => { clearTimeout(timer); reject(new Error('Connect: ' + e.message)); });
    connectReq.end();
  });
}

function directRequest(targetUrl, opts) {
  return new Promise((resolve, reject) => {
    const parsed = url_mod.parse(targetUrl);
    const timer = setTimeout(() => reject(new Error('Timeout 15s')), 15000);
    const headers = Object.assign({}, opts.headers || {}, { 'Host': parsed.hostname });
    if (opts.body) headers['Content-Length'] = Buffer.byteLength(opts.body);
    const req = https.request({
      hostname: parsed.hostname, path: parsed.path,
      method: opts.method || 'GET', headers, rejectUnauthorized: false
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }); });
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function shopeeReq(targetUrl, opts) {
  const proxy = getProxy();
  if (proxy) {
    try { return await proxyRequest(proxy, targetUrl, opts); }
    catch (e) { console.log('[req] proxy err: ' + e.message + ' — direto'); }
  }
  return directRequest(targetUrl, opts);
}

// ── COOKIE EXPIRY CHECK ──────────────────────────────────────
async function checkCookieValid(cookieStr, spcCds, feSession) {
  try {
    const hdrs = makeHeaders(cookieStr, feSession, '');
    const r = await shopeeReq(
      'https://seller.shopee.com.br/api/v1/account/basic_info/?SPC_CDS=' + spcCds + '&SPC_CDS_VER=2',
      { method: 'GET', headers: hdrs }
    );
    const d = JSON.parse(r.body);
    const expired = d.errcode === 2 || d.code === 2 || r.status === 401 || d.error === 'error_auth';
    return { valid: !expired, status: r.status, code: d.code || d.errcode };
  } catch (e) {
    return { valid: true }; // assume válido se não conseguiu checar
  }
}

// ── HEADERS ──────────────────────────────────────────────────
function makeHeaders(cookieStr, feSession, csrf) {
  return {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'pt-BR,pt;q=0.9',
    'content-type': 'application/json;charset=UTF-8',
    'cookie': cookieStr,
    'origin': 'https://seller.shopee.com.br',
    'referer': 'https://seller.shopee.com.br/portal/product/list/all',
    'sc-fe-session': feSession,
    'sc-fe-ver': '21.141883',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    'locale': 'pt-br',
    'caller-source': 'local_pc',
    'x-csrftoken': csrf || ''
  };
}

// ── MAIN SYNC ────────────────────────────────────────────────
async function syncElastic(cookieStr, spcCds, feSession) {
  const csrf = (cookieStr.match(/csrftoken=([^;]+)/) || [])[1] || '';
  const hdrs = makeHeaders(cookieStr, feSession, csrf);
  const endpoints = getEndpoints(spcCds);

  // Testa se cookies estão válidos primeiro
  const validity = await checkCookieValid(cookieStr, spcCds, feSession);
  if (!validity.valid) {
    const err = new Error('Cookies expirados. Reconecte a loja no Vendry.');
    err.code = 'COOKIES_EXPIRED';
    throw err;
  }

  // Ordena endpoints: lastGoodEndpoint primeiro
  const ordered = lastGoodEndpoint
    ? [endpoints.find(e => e.name === lastGoodEndpoint), ...endpoints.filter(e => e.name !== lastGoodEndpoint)].filter(Boolean)
    : endpoints;

  for (const ep of ordered) {
    if (isOpen(ep.name)) {
      console.log('[sync] circuit breaker aberto para ' + ep.name + ' — pulando');
      continue;
    }

    console.log('[sync] tentando ' + ep.name + '...');
    try {
      const all = await fetchPages(ep, hdrs);
      if (all.length > 0) {
        recordSuccess(ep.name);
        lastGoodEndpoint = ep.name;
        lastSyncTime = Date.now();
        lastSyncCount = all.length;
        return { products: all, strategy: ep.name };
      }
      console.log('[sync] ' + ep.name + ' retornou 0 items');
    } catch (e) {
      if (e.code === 'COOKIES_EXPIRED') throw e;
      console.log('[sync] ' + ep.name + ' falhou: ' + e.message);
      recordFail(ep.name);
    }
  }

  throw new Error('Todos os endpoints falharam. Veja logs do Railway.');
}

async function fetchPages(ep, hdrs) {
  const all = [];
  let cursor = '';
  let offset = 0;
  let pageNum = 0;
  const MAX = 100;

  while (pageNum < MAX) {
    pageNum++;
    const urlArg = ep.name.includes('v3-search') || ep.name.includes('v3-mpsku') ? cursor : (pageNum === 1 ? 0 : offset);
    const url = ep.buildUrl(urlArg);
    const body = ep.buildBody ? ep.buildBody(offset) : null;

    const r = await shopeeReq(url, { method: ep.method, headers: hdrs, body });
    let data;
    try { data = JSON.parse(r.body); } catch (e) { throw new Error('JSON parse fail'); }

    console.log('[sync] [' + ep.name + '] pg' + pageNum + ' status=' + r.status + ' code=' + (data.code || data.errcode || '-') + ' body=' + r.body.slice(0, 120));

    const ext = ep.extract(data);

    if (ext.expired) {
      const err = new Error('Cookies expirados');
      err.code = 'COOKIES_EXPIRED';
      throw err;
    }
    if (!ext.ok && ext.items.length === 0) throw new Error(ext.errMsg || 'endpoint nao ok');

    const mapped = ext.items.map(autoDetectFields).filter(Boolean);
    all.push(...mapped);

    const hasMore = ep.paginated && ext.items.length > 0 && (
      (ext.nextCursor && ext.nextCursor !== cursor) ||
      (ext.hasNext === true) ||
      (typeof ext.hasNext === 'undefined' && ext.nextCursor && ext.nextCursor !== cursor)
    );

    if (!hasMore) break;
    cursor = ext.nextCursor || cursor;
    offset += ext.items.length;
    await new Promise(r => setTimeout(r, 350));
  }
  return all;
}

// ── HTTP SERVER ──────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // Health com diagnóstico completo
  if (req.url === '/' || req.url === '/health') {
    const proxy = getProxy();
    res.writeHead(200);
    res.end(JSON.stringify({
      ok: true,
      service: 'vendry-sync',
      version: '7.0.0',
      proxy: proxy ? proxy.host + ':' + proxy.port : 'none',
      last_sync: lastSyncTime ? new Date(lastSyncTime).toISOString() : null,
      last_count: lastSyncCount,
      best_endpoint: lastGoodEndpoint,
      circuit_breakers: Object.keys(breaker).map(k => ({
        endpoint: k,
        ok: breaker[k].ok,
        fails: breaker[k].fails
      }))
    }));
    return;
  }

  const auth = req.headers['authorization'] || '';
  if (auth !== 'Bearer ' + SECRET) {
    res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return;
  }

  // POST /sync
  if (req.method === 'POST' && req.url === '/sync') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { cookies, spc_cds, fe_session } = JSON.parse(body);
        if (!cookies || !spc_cds) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'cookies e spc_cds obrigatorios' })); return;
        }
        const result = await syncElastic(cookies, spc_cds, fe_session || '');
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, products: result.products, total: result.products.length, strategy: result.strategy }));
      } catch (err) {
        console.error('[sync] erro:', err.message);
        const expired = err.code === 'COOKIES_EXPIRED';
        res.writeHead(expired ? 401 : 500);
        res.end(JSON.stringify({ error: err.message, code: err.code || 'SYNC_ERROR' }));
      }
    });
    return;
  }

  // POST /check — verifica se cookies estão válidos sem sincronizar
  if (req.method === 'POST' && req.url === '/check') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { cookies, spc_cds, fe_session } = JSON.parse(body);
        const result = await checkCookieValid(cookies, spc_cds, fe_session || '');
        res.writeHead(200);
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  const proxy = getProxy();
  console.log('Vendry Sync v7.0 MAXIMUM ELASTIC porta ' + PORT);
  console.log('Proxy: ' + (proxy ? proxy.host + ':' + proxy.port : 'NONE'));
  console.log('Endpoints: ' + getEndpoints('TEST').map(e => e.name).join(', '));
});
