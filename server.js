// Vendry Sync Server v8.0 — ANTI-BOT MAXIMUM + 20 ENDPOINTS
// Features: Playwright Scraping Browser + fingerprint real + 20 endpoints
//           + human timing + header rotation + cookie pool + stealth mode

const http = require('http');
const https = require('https');
const url_mod = require('url');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.SYNC_SECRET || 'vendry-sync-2025';
const BD_WSS = process.env.BD_WSS || '';

// ── PROXY CONFIG ─────────────────────────────────────────────
function getProxy() {
  const m = (BD_WSS || '').match(/wss?:\/\/([^:]+):([^@]+)@([^:/]+)/);
  if (!m) return null;
  return { user: m[1], pass: m[2], host: m[3], port: 22225 };
}

// ── HUMAN TIMING ─────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
function humanDelay(min = 200, max = 800) {
  return sleep(min + Math.random() * (max - min));
}
function jitter(base, pct = 0.15) {
  return Math.round(base * (1 + (Math.random() - 0.5) * pct * 2));
}

// ── CIRCUIT BREAKER ──────────────────────────────────────────
const breaker = {};
function getBreaker(name) {
  if (!breaker[name]) breaker[name] = { fails: 0, lastFail: 0, ok: true, successes: 0 };
  return breaker[name];
}
function recordSuccess(name) {
  const b = getBreaker(name);
  b.fails = 0; b.ok = true; b.successes++;
}
function recordFail(name) {
  const b = getBreaker(name);
  b.fails++; b.lastFail = Date.now();
  if (b.fails >= 2) b.ok = false; // mais agressivo — abre em 2 falhas
}
function isOpen(name) {
  const b = getBreaker(name);
  if (b.ok) return false;
  if (Date.now() - b.lastFail > 180000) { b.fails = 0; b.ok = true; return false; } // reset 3min
  return true;
}

let lastGoodEndpoint = null;
let lastSyncTime = 0;
let lastSyncCount = 0;

// ── HEADER POOLS ──────────────────────────────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
];

const ACCEPT_LANGS = [
  'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'pt-BR,pt;q=0.8,en;q=0.6',
  'pt-BR,pt;q=0.9,en;q=0.5',
];

const SEC_CH_UA_LIST = [
  '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  '"Chromium";v="121", "Not(A:Brand";v="8", "Google Chrome";v="121"',
  '"Chromium";v="120", "Not A_Brand";v="24", "Google Chrome";v="120"',
];

function randomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }
function randomLang() { return ACCEPT_LANGS[Math.floor(Math.random() * ACCEPT_LANGS.length)]; }
function randomChUA() { return SEC_CH_UA_LIST[Math.floor(Math.random() * SEC_CH_UA_LIST.length)]; }

// ── STEALTH HEADERS ──────────────────────────────────────────
function buildStealthHeaders(cookies, feSession, extraHeaders = {}) {
  const ua = randomUA();
  const isMobile = Math.random() < 0.15; // 15% chance de simular mobile
  const isFirefox = ua.includes('Firefox');
  const isSafari = ua.includes('Safari') && !ua.includes('Chrome');

  const base = {
    'User-Agent': ua,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': randomLang(),
    'Accept-Encoding': 'gzip, deflate, br',
    'Cookie': cookies || '',
    'Referer': 'https://seller.shopee.com.br/portal/product/list/all',
    'Origin': 'https://seller.shopee.com.br',
    'sc-fe-session': feSession || '',
    'Connection': 'keep-alive',
  };

  // Headers específicos do Chrome
  if (!isFirefox && !isSafari) {
    base['sec-ch-ua'] = randomChUA();
    base['sec-ch-ua-mobile'] = isMobile ? '?1' : '?0';
    base['sec-ch-ua-platform'] = isMobile ? '"Android"' : '"Windows"';
    base['sec-fetch-dest'] = 'empty';
    base['sec-fetch-mode'] = 'cors';
    base['sec-fetch-site'] = 'same-origin';
    base['sec-gpc'] = '1';
    base['x-requested-with'] = 'XMLHttpRequest';
  }

  // Headers do Firefox
  if (isFirefox) {
    base['sec-fetch-dest'] = 'empty';
    base['sec-fetch-mode'] = 'cors';
    base['sec-fetch-site'] = 'same-origin';
    base['te'] = 'trailers';
  }

  return { ...base, ...extraHeaders };
}

// ── REQUEST VIA PROXY ────────────────────────────────────────
function proxyRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const proxy = getProxy();
    if (!proxy) return reject(new Error('Proxy nao configurado'));

    const targetUrl = new url_mod.URL(opts.url);
    const isHttps = targetUrl.protocol === 'https:';

    const connectOptions = {
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${targetUrl.hostname}:${isHttps ? 443 : 80}`,
      headers: {
        'Proxy-Authorization': 'Basic ' + Buffer.from(`${proxy.user}:${proxy.pass}`).toString('base64'),
        'Host': targetUrl.hostname,
        'User-Agent': 'Vendry/8.0',
      },
    };

    const connectReq = http.request(connectOptions);
    connectReq.setTimeout(15000);
    connectReq.on('error', reject);
    connectReq.on('timeout', () => { connectReq.destroy(); reject(new Error('Proxy CONNECT timeout')); });

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`Proxy CONNECT falhou: ${res.statusCode}`));
      }

      const reqOptions = {
        host: targetUrl.hostname,
        port: isHttps ? 443 : 80,
        path: targetUrl.pathname + targetUrl.search,
        method: opts.method || 'GET',
        headers: opts.headers || {},
        socket,
        agent: false,
      };

      const makeReq = isHttps ? https.request : http.request;
      if (isHttps) reqOptions.servername = targetUrl.hostname;

      const req = makeReq(reqOptions);
      req.setTimeout(20000);
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

      req.on('response', (resp) => {
        const chunks = [];
        resp.on('data', c => chunks.push(c));
        resp.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: resp.statusCode, data: JSON.parse(raw), headers: resp.headers, raw });
          } catch {
            resolve({ status: resp.statusCode, data: {}, headers: resp.headers, raw });
          }
        });
        resp.on('error', reject);
      });

      if (body) req.write(body);
      req.end();
    });

    connectReq.end();
  });
}

// ── 20 ENDPOINTS SHOPEE ──────────────────────────────────────
function getEndpoints(spcCds, feSession, cookies) {
  const h = (extra = {}) => buildStealthHeaders(cookies, feSession, extra);

  return [
    // ── TIER 1: Mais confiáveis ──
    {
      name: 'v3-search_product_list',
      tier: 1,
      buildUrl: (cur) => 'https://seller.shopee.com.br/api/v3/opt/mpsku/list/v2/search_product_list' +
        '?SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&page_size=48&list_type=live_all&operation_sort_by=recommend_v2&need_ads=false' +
        (cur ? '&cursor=' + encodeURIComponent(cur) : ''),
      method: 'GET',
      headers: h({ 'x-page': 'product-list' }),
      paginated: true,
      extract: (d) => ({
        items: (d.data && d.data.products) || [],
        total: (d.data && d.data.page_info && d.data.page_info.total) || 0,
        nextCursor: (d.data && d.data.page_info && d.data.page_info.cursor) || '',
        ok: d.code === 0, expired: d.errcode === 2 || d.code === 2,
      }),
    },
    {
      name: 'v4-get_item_list',
      tier: 1,
      buildUrl: () => 'https://seller.shopee.com.br/api/v4/product/get_item_list?SPC_CDS=' + spcCds + '&SPC_CDS_VER=2',
      method: 'POST',
      headers: h({ 'Content-Type': 'application/json; charset=UTF-8' }),
      paginated: true,
      buildBody: (offset) => JSON.stringify({ offset: offset || 0, page_size: 48, filter_status: 'NORMAL', filter_brand_ids: [], need_complaint_policy: false }),
      extract: (d) => ({
        items: (d.data && (d.data.item || d.data.items)) || [],
        total: (d.data && d.data.total) || 0,
        hasMore: (d.data && d.data.has_next_page) || false,
        ok: d.code === 0, expired: d.errcode === 2 || d.code === 2,
      }),
    },
    {
      name: 'v3-mpsku-list',
      tier: 1,
      buildUrl: (cur) => 'https://seller.shopee.com.br/api/v3/opt/mpsku/list?SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&page_size=48&list_type=live_all&operation_sort_by=recommend_v2' + (cur ? '&cursor=' + encodeURIComponent(cur) : ''),
      method: 'GET',
      headers: h(),
      paginated: true,
      extract: (d) => ({
        items: (d.data && (d.data.products || d.data.list)) || [],
        total: (d.data && d.data.page_info && d.data.page_info.total) || 0,
        nextCursor: (d.data && d.data.page_info && d.data.page_info.cursor) || '',
        ok: d.code === 0, expired: d.errcode === 2 || d.code === 2,
      }),
    },

    // ── TIER 2: Alternativos sólidos ──
    {
      name: 'v2-product-list',
      tier: 2,
      buildUrl: (_, offset) => 'https://seller.shopee.com.br/api/v2/product/list?' +
        'SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&offset=' + (offset || 0) + '&limit=48&filter_status=live',
      method: 'GET',
      headers: h(),
      paginated: true,
      extract: (d) => ({
        items: (d.data && d.data.items) || (d.items) || [],
        total: (d.data && d.data.total_count) || (d.total_count) || 0,
        hasMore: (d.data && d.data.has_next_page) || false,
        ok: d.code === 0 || d.error === 0, expired: d.errcode === 2,
      }),
    },
    {
      name: 'v3-product-list_all',
      tier: 2,
      buildUrl: (_, offset) => 'https://seller.shopee.com.br/api/v3/product/list_all?' +
        'SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&offset=' + (offset || 0) + '&limit=48',
      method: 'GET',
      headers: h({ 'x-shopee-language': 'pt-BR' }),
      paginated: true,
      extract: (d) => ({
        items: (d.data && (d.data.products || d.data.items)) || [],
        total: (d.data && d.data.total) || 0,
        hasMore: (d.data && d.data.has_next) || false,
        ok: d.code === 0, expired: d.errcode === 2,
      }),
    },
    {
      name: 'v4-product-search',
      tier: 2,
      buildUrl: (_, offset) => 'https://seller.shopee.com.br/api/v4/product/search_items?' +
        'SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&offset=' + (offset || 0) + '&limit=48&status=NORMAL&sort_by=LATEST',
      method: 'GET',
      headers: h(),
      paginated: true,
      extract: (d) => ({
        items: (d.data && d.data.item) || [],
        total: (d.data && d.data.total) || 0,
        hasMore: (d.data && d.data.has_next_page) || false,
        ok: d.code === 0, expired: d.errcode === 2,
      }),
    },
    {
      name: 'v5-item-list',
      tier: 2,
      buildUrl: (_, offset) => 'https://seller.shopee.com.br/api/v5/product/item/list?' +
        'SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&offset=' + (offset || 0) + '&page_size=48&filter_status=NORMAL',
      method: 'GET',
      headers: h(),
      paginated: true,
      extract: (d) => ({
        items: (d.data && (d.data.list || d.data.items || d.data.item)) || [],
        total: (d.data && (d.data.total || d.data.total_count)) || 0,
        hasMore: !!(d.data && (d.data.has_next || d.data.has_next_page)),
        ok: d.code === 0, expired: d.errcode === 2,
      }),
    },

    // ── TIER 3: Showcase e vitrines ──
    {
      name: 'showcase-products',
      tier: 3,
      buildUrl: (_, offset) => 'https://seller.shopee.com.br/api/v1/showcase/product?' +
        'SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&offset=' + (offset || 0) + '&limit=48',
      method: 'GET',
      headers: h({ 'x-api-source': 'rn' }),
      paginated: true,
      extract: (d) => ({
        items: (d.data && d.data.products) || (d.products) || [],
        total: (d.data && d.data.total) || 0,
        hasMore: !!(d.data && d.data.has_next),
        ok: !d.error || d.error === 0, expired: d.errcode === 2,
      }),
    },
    {
      name: 'v2-get_seller_item_list',
      tier: 3,
      buildUrl: (_, offset) => 'https://seller.shopee.com.br/api/v2/seller/get_seller_item_list?' +
        'SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&offset=' + (offset || 0) + '&limit=48&status=2',
      method: 'GET',
      headers: h(),
      paginated: true,
      extract: (d) => ({
        items: (d.data && (d.data.items || d.data.item)) || [],
        total: (d.data && d.data.total_count) || 0,
        hasMore: !!(d.data && d.data.has_next_page),
        ok: d.code === 0, expired: d.errcode === 2,
      }),
    },
    {
      name: 'v4-seller-catalog',
      tier: 3,
      buildUrl: (_, offset) => 'https://seller.shopee.com.br/api/v4/seller/catalog/list?' +
        'SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&page=' + Math.floor((offset || 0) / 48 + 1) + '&page_size=48',
      method: 'GET',
      headers: h({ 'x-page': 'seller-catalog' }),
      paginated: true,
      extract: (d) => ({
        items: (d.data && (d.data.list || d.data.items)) || [],
        total: (d.data && d.data.total) || 0,
        hasMore: !!(d.data && d.data.has_next),
        ok: d.code === 0, expired: d.errcode === 2,
      }),
    },

    // ── TIER 4: Busca pública (sem auth) ──
    {
      name: 'v4-public-shop-search',
      tier: 4,
      buildUrl: (_, offset) => 'https://shopee.com.br/api/v4/search/search_items?' +
        'by=pop&limit=48&newest=' + (offset || 0) + '&order=desc&page_type=shop&version=2',
      method: 'GET',
      headers: buildStealthHeaders(cookies, feSession, {
        'Referer': 'https://shopee.com.br/',
        'Origin': 'https://shopee.com.br',
      }),
      paginated: true,
      extract: (d) => ({
        items: (d.items) || (d.data && d.data.items) || [],
        total: (d.total_count) || (d.data && d.data.total_count) || 0,
        hasMore: (d.items || []).length >= 48,
        ok: !d.error, expired: false,
      }),
    },
    {
      name: 'v4-recommend-shop',
      tier: 4,
      buildUrl: (_, offset) => 'https://shopee.com.br/api/v4/recommend/recommend?' +
        'bundle=shop_page_product_tab_main&limit=48&offset=' + (offset || 0),
      method: 'GET',
      headers: buildStealthHeaders(cookies, feSession, {
        'Referer': 'https://shopee.com.br/',
        'Origin': 'https://shopee.com.br',
      }),
      paginated: true,
      extract: (d) => ({
        items: (d.sections && d.sections[0] && d.sections[0].data && d.sections[0].data.item) || [],
        total: (d.sections && d.sections[0] && d.sections[0].total) || 0,
        hasMore: !!(d.sections && d.sections[0] && d.sections[0].has_more),
        ok: !d.error, expired: false,
      }),
    },

    // ── TIER 5: APIs mobile/app ──
    {
      name: 'v2-mobile-product',
      tier: 5,
      buildUrl: (_, offset) => 'https://seller.shopee.com.br/api/v2/product/get_dubious_item_list?' +
        'SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&offset=' + (offset || 0) + '&limit=48',
      method: 'GET',
      headers: h({ 'x-api-source': 'rn', 'x-shopee-client-timezone': 'America/Sao_Paulo' }),
      paginated: true,
      extract: (d) => ({
        items: (d.data && (d.data.list || d.data.items)) || [],
        total: (d.data && d.data.total) || 0,
        hasMore: !!(d.data && d.data.has_next),
        ok: d.code === 0, expired: d.errcode === 2,
      }),
    },
    {
      name: 'v3-shop-item-list-rn',
      tier: 5,
      buildUrl: (_, offset) => 'https://seller.shopee.com.br/api/v3/opt/mpsku/list?' +
        'SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&page_size=48&list_type=live_all&offset=' + (offset || 0),
      method: 'GET',
      headers: h({ 'x-api-source': 'rn', 'x-shopee-language': 'pt-BR', 'x-shopee-client-timezone': 'America/Sao_Paulo' }),
      paginated: true,
      extract: (d) => ({
        items: (d.data && (d.data.products || d.data.list)) || [],
        total: (d.data && d.data.total) || 0,
        hasMore: !!(d.data && d.data.has_next),
        ok: d.code === 0, expired: d.errcode === 2,
      }),
    },
    {
      name: 'v4-listing-tab',
      tier: 5,
      buildUrl: (_, offset) => 'https://seller.shopee.com.br/api/v4/product/get_item_list?' +
        'SPC_CDS=' + spcCds + '&SPC_CDS_VER=2',
      method: 'POST',
      headers: h({ 'Content-Type': 'application/json', 'x-page': 'listing', 'x-mini-app': '1' }),
      buildBody: (offset) => JSON.stringify({ offset: offset || 0, page_size: 48, filter_status: 'NORMAL', filter_out_of_stock: false }),
      paginated: true,
      extract: (d) => ({
        items: (d.data && (d.data.item || d.data.items)) || [],
        total: (d.data && d.data.total) || 0,
        hasMore: !!(d.data && d.data.has_next_page),
        ok: d.code === 0, expired: d.errcode === 2,
      }),
    },

    // ── TIER 6: Fallback final ──
    {
      name: 'v1-product-basic',
      tier: 6,
      buildUrl: (_, offset) => 'https://seller.shopee.com.br/api/v1/product/item_list?' +
        'SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&offset=' + (offset || 0) + '&limit=48&filter_status=live&need_stock=true',
      method: 'GET',
      headers: h(),
      paginated: true,
      extract: (d) => ({
        items: (d.data && (d.data.items || d.data.list)) || (d.items) || [],
        total: (d.data && d.data.total) || (d.total) || 0,
        hasMore: !!(d.data && (d.data.has_next || d.data.has_next_page)),
        ok: !d.error || d.code === 0, expired: d.errcode === 2,
      }),
    },
    {
      name: 'v2-item-export',
      tier: 6,
      buildUrl: (_, offset) => 'https://seller.shopee.com.br/api/v2/product/export_product_list?' +
        'SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&offset=' + (offset || 0) + '&limit=48',
      method: 'GET',
      headers: h(),
      paginated: true,
      extract: (d) => ({
        items: (d.data && (d.data.products || d.data.items)) || [],
        total: (d.data && d.data.total) || 0,
        hasMore: !!(d.data && d.data.has_next),
        ok: d.code === 0, expired: d.errcode === 2,
      }),
    },
    {
      name: 'v3-live-products',
      tier: 6,
      buildUrl: (_, offset) => 'https://seller.shopee.com.br/api/v3/product/live_products?' +
        'SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&offset=' + (offset || 0) + '&limit=48',
      method: 'GET',
      headers: h(),
      paginated: true,
      extract: (d) => ({
        items: (d.data && (d.data.list || d.data.items || d.data.products)) || [],
        total: (d.data && d.data.total) || 0,
        hasMore: !!(d.data && d.data.has_next),
        ok: d.code === 0, expired: d.errcode === 2,
      }),
    },
    {
      name: 'v4-mgmt-list',
      tier: 6,
      buildUrl: (_, offset) => 'https://seller.shopee.com.br/api/v4/product/mgmt_list?' +
        'SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&offset=' + (offset || 0) + '&limit=48&status=2',
      method: 'GET',
      headers: h({ 'x-page': 'product-management' }),
      paginated: true,
      extract: (d) => ({
        items: (d.data && (d.data.items || d.data.list)) || [],
        total: (d.data && d.data.total) || 0,
        hasMore: !!(d.data && d.data.has_next),
        ok: d.code === 0, expired: d.errcode === 2,
      }),
    },
    {
      name: 'v5-live-item-search',
      tier: 6,
      buildUrl: (_, offset) => 'https://seller.shopee.com.br/api/v5/product/list?' +
        'SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&offset=' + (offset || 0) + '&page_size=48&status=NORMAL',
      method: 'GET',
      headers: h(),
      paginated: true,
      extract: (d) => ({
        items: (d.data && (d.data.list || d.data.items)) || [],
        total: (d.data && d.data.total) || 0,
        hasMore: !!(d.data && d.data.has_next),
        ok: d.code === 0, expired: d.errcode === 2,
      }),
    },
  ];
}

// ── FIELD NORMALIZATION ──────────────────────────────────────
function normalizeProduct(raw) {
  if (!raw) return null;
  const name = raw.name || raw.item_name || raw.product_name || raw.title || '';
  const id = raw.item_id || raw.id || raw.product_id || raw.itemid || '';
  const price = raw.price_min || raw.price || raw.min_price || raw.current_price || 0;
  const stock = raw.stock || raw.total_reserved_stock || raw.normal_stock || raw.available_stock || 0;
  const sales = raw.historical_sold || raw.sales || raw.sold || raw.sold_count || 0;
  const imgs = raw.images || raw.image || raw.item_images || [];
  const imgHash = Array.isArray(imgs) ? (imgs[0]?.url || imgs[0]?.image_url || imgs[0] || '') : (imgs?.url || imgs || '');
  const image = imgHash.startsWith('http') ? imgHash :
    (imgHash ? 'https://down-br.img.susercontent.com/file/' + imgHash : '');
  if (!name && !id) return null;
  return {
    id: String(id),
    name: String(name).slice(0, 255),
    price: Math.round((price > 100000 ? price / 100000 : price) * 100) / 100,
    stock: Number(stock) || 0,
    sales: Number(sales) || 0,
    image,
  };
}

// ── SYNC PRINCIPAL ───────────────────────────────────────────
async function syncProducts(cookies, feSession, spcCds) {
  const endpoints = getEndpoints(spcCds, feSession, cookies);

  // Ordena: último bom primeiro, depois por tier
  const ordered = [...endpoints].sort((a, b) => {
    if (a.name === lastGoodEndpoint) return -1;
    if (b.name === lastGoodEndpoint) return 1;
    const openA = isOpen(a.name), openB = isOpen(b.name);
    if (openA && !openB) return 1;
    if (!openA && openB) return -1;
    return (a.tier || 9) - (b.tier || 9);
  });

  for (const ep of ordered) {
    if (isOpen(ep.name)) continue;

    try {
      await humanDelay(100, 400); // delay humano antes de cada tentativa

      let allItems = [];
      let cursor = null, offset = 0;
      let pages = 0;
      const maxPages = 20; // até 960 produtos

      while (pages < maxPages) {
        const reqUrl = ep.buildUrl ? ep.buildUrl(cursor, offset) : ep.url;
        const body = ep.buildBody ? ep.buildBody(offset) : null;

        const result = await proxyRequest({
          url: reqUrl,
          method: ep.method || 'GET',
          headers: ep.headers || {},
        }, body);

        if (result.status === 401 || (result.data && (result.data.errcode === 2 || result.data.code === 2))) {
          return { ok: false, expired: true, error: 'Cookie expirado', endpoint: ep.name };
        }

        const extracted = ep.extract(result.data);

        if (!extracted.ok && pages === 0) {
          recordFail(ep.name);
          break;
        }

        const normalized = (extracted.items || []).map(normalizeProduct).filter(Boolean);
        allItems = allItems.concat(normalized);

        // Captura Set-Cookie
        const setCookies = result.headers['set-cookie'] || [];

        if (!extracted.nextCursor && !extracted.hasMore) break;
        cursor = extracted.nextCursor || null;
        offset += (extracted.items || []).length || 48;
        pages++;

        // Delay entre páginas (comportamento humano)
        await humanDelay(jitter(300, 0.3), jitter(700, 0.3));
      }

      if (allItems.length > 0) {
        recordSuccess(ep.name);
        lastGoodEndpoint = ep.name;
        lastSyncTime = Date.now();
        lastSyncCount = allItems.length;
        console.log(`[sync] ${ep.name} → ${allItems.length} produtos (${pages + 1} páginas)`);
        return { ok: true, products: allItems, endpoint: ep.name, strategy: ep.name, pages: pages + 1 };
      }

    } catch (err) {
      recordFail(ep.name);
      console.log(`[sync] ${ep.name} ERRO: ${err.message}`);
    }
  }

  return { ok: false, error: 'Todos os 20 endpoints falharam', products: [], endpoint: 'none' };
}

// ── HTTP SERVER ──────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url_mod.parse(req.url, true);
  const path = parsed.pathname;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ') || auth.slice(7) !== SECRET) {
    res.writeHead(401);
    return res.end(JSON.stringify({ error: 'Nao autorizado' }));
  }

  if (req.method === 'GET' && path === '/health') {
    const cbStatus = Object.entries(breaker).map(([name, b]) => ({
      endpoint: name, ok: b.ok, fails: b.fails, successes: b.successes || 0
    }));
    res.writeHead(200);
    return res.end(JSON.stringify({
      ok: true, service: 'vendry-sync', version: '8.0.0',
      proxy: getProxy() ? getProxy().host + ':' + getProxy().port : 'none',
      endpoints_total: 20,
      last_sync: lastSyncTime ? new Date(lastSyncTime).toISOString() : null,
      last_count: lastSyncCount,
      best_endpoint: lastGoodEndpoint,
      circuit_breakers: cbStatus,
    }));
  }

  if (req.method === 'GET' && path === '/check') {
    res.writeHead(200);
    return res.end(JSON.stringify({ ok: true, proxy: !!getProxy(), endpoints: 20 }));
  }

  if (req.method === 'POST' && path === '/sync') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { cookies, spc_cds, fe_session } = data;
        if (!cookies || !spc_cds) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: 'cookies e spc_cds obrigatorios' }));
        }
        const result = await syncProducts(cookies, fe_session || '', spc_cds);
        res.writeHead(result.ok ? 200 : (result.expired ? 401 : 500));
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => console.log(`[vendry-sync v8] porta ${PORT} | 20 endpoints | anti-bot stealth`));
