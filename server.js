// Vendry Sync Server v6.0 — BD como HTTP Proxy (porta 22225)
// Node.js faz requests direto via proxy residencial — sem browser, sem Puppeteer
// Cookie header funciona perfeitamente em Node.js (não é browser)
const http = require('http');
const https = require('https');
const url_mod = require('url');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.SYNC_SECRET || 'vendry-sync-2025';
// BD WSS: wss://user:pass@host:9222 → HTTP proxy: http://user:pass@host:22225
const BD_WSS = process.env.BD_WSS || 'wss://brd-customer-hl_22f8cdf5-zone-scraping_browser1:tv264i12x4he@brd.superproxy.io:9222';

// Extrai credenciais do BD_WSS e monta proxy HTTP na porta 22225
function getProxyConfig() {
  const m = BD_WSS.match(/wss?:\/\/([^:]+):([^@]+)@([^:/]+)/);
  if (!m) return null;
  return { user: m[1], pass: m[2], host: m[3], port: 22225 };
}

// Faz request via proxy CONNECT tunnel (HTTPS over HTTP proxy)
function proxyRequest(proxyConf, targetUrl, options) {
  return new Promise((resolve, reject) => {
    const parsed = url_mod.parse(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const targetHost = parsed.hostname;
    const targetPort = parsed.port || (isHttps ? 443 : 80);

    const timer = setTimeout(() => reject(new Error('Timeout 20s')), 20000);

    // Conecta ao proxy
    const proxyAuth = Buffer.from(proxyConf.user + ':' + proxyConf.pass).toString('base64');
    const connectReq = http.request({
      host: proxyConf.host,
      port: proxyConf.port,
      method: 'CONNECT',
      path: targetHost + ':' + targetPort,
      headers: {
        'Host': targetHost + ':' + targetPort,
        'Proxy-Authorization': 'Basic ' + proxyAuth,
        'Proxy-Connection': 'Keep-Alive',
      }
    });

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        socket.destroy();
        return reject(new Error('Proxy CONNECT falhou: ' + res.statusCode));
      }

      // Tunnel estabelecido — faz request HTTPS por dentro
      const tlsSocket = require('tls').connect({
        host: targetHost,
        socket: socket,
        rejectUnauthorized: false,
      }, () => {
        const path = parsed.path || '/';
        const headers = Object.assign({}, options.headers || {}, {
          'Host': targetHost,
          'Connection': 'close',
        });
        if (options.body) headers['Content-Length'] = Buffer.byteLength(options.body);

        let reqStr = (options.method || 'GET') + ' ' + path + ' HTTP/1.1\r\n';
        Object.keys(headers).forEach(k => { reqStr += k + ': ' + headers[k] + '\r\n'; });
        reqStr += '\r\n';
        if (options.body) reqStr += options.body;

        tlsSocket.write(reqStr);

        let respData = '';
        tlsSocket.on('data', d => respData += d.toString());
        tlsSocket.on('end', () => {
          clearTimeout(timer);
          // Parse HTTP response
          const sep = respData.indexOf('\r\n\r\n');
          const headerPart = respData.slice(0, sep);
          const bodyPart = respData.slice(sep + 4);
          const statusMatch = headerPart.match(/HTTP\/1\.\d (\d+)/);
          const statusCode = statusMatch ? parseInt(statusMatch[1]) : 0;
          resolve({ status: statusCode, body: bodyPart });
        });
        tlsSocket.on('error', e => { clearTimeout(timer); reject(e); });
      });
      tlsSocket.on('error', e => { clearTimeout(timer); reject(e); });
    });

    connectReq.on('error', e => { clearTimeout(timer); reject(new Error('Proxy connect error: ' + e.message)); });
    connectReq.end();
  });
}

// Faz request direto (sem proxy) como fallback
function directRequest(targetUrl, options) {
  return new Promise((resolve, reject) => {
    const parsed = url_mod.parse(targetUrl);
    const timer = setTimeout(() => reject(new Error('Timeout 15s')), 15000);
    const headers = Object.assign({}, options.headers || {}, { 'Host': parsed.hostname });
    if (options.body) headers['Content-Length'] = Buffer.byteLength(options.body);

    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.path,
      method: options.method || 'GET',
      headers,
      rejectUnauthorized: false,
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, body: data }); });
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function shopeeRequest(targetUrl, options, proxyConf) {
  // Tenta via proxy primeiro, fallback direto
  if (proxyConf) {
    try {
      const r = await proxyRequest(proxyConf, targetUrl, options);
      console.log('[req] proxy status=' + r.status + ' url=' + targetUrl.split('?')[0].split('/').slice(-2).join('/'));
      return r;
    } catch (e) {
      console.log('[req] proxy falhou: ' + e.message + ' — tentando direto');
    }
  }
  return directRequest(targetUrl, options);
}

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
    'x-csrftoken': csrf,
  };
}

async function fetchAllProducts(cookieStr, spcCds, feSession) {
  const proxy = getProxyConfig();
  console.log('[sync] proxy: ' + (proxy ? proxy.host + ':' + proxy.port : 'nenhum'));
  const csrf = (cookieStr.match(/csrftoken=([^;]+)/) || [])[1] || '';
  const hdrs = makeHeaders(cookieStr, feSession, csrf);

  // Estratégia 1: v3 GET cursor-based
  try {
    console.log('[sync] tentando v3 GET search_product_list...');
    const all = [];
    let cursor = '';
    let page = 0;
    while (page < 50) {
      page++;
      const u = 'https://seller.shopee.com.br/api/v3/opt/mpsku/list/v2/search_product_list?SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&page_size=12&list_type=live_all&request_attribute=&operation_sort_by=recommend_v2&need_ads=false' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      const r = await shopeeRequest(u, { method: 'GET', headers: hdrs }, proxy);
      console.log('[sync] v3 pg' + page + ' status=' + r.status + ' body=' + r.body.slice(0, 200));
      const d = JSON.parse(r.body);
      if (d.code !== 0) throw new Error('code=' + d.code + ' msg=' + (d.message || d.errcode));
      const items = (d.data && d.data.products) || [];
      const total = (d.data && d.data.page_info && d.data.page_info.total) || 0;
      const nextCursor = (d.data && d.data.page_info && d.data.page_info.cursor) || '';
      all.push(...items);
      console.log('[sync] v3 +' + items.length + ' (acum=' + all.length + '/' + total + ')');
      if (!nextCursor || nextCursor === cursor || all.length >= total) break;
      cursor = nextCursor;
      await new Promise(r => setTimeout(r, 350));
    }
    if (all.length > 0) return { products: all.map(mapProduct).filter(Boolean), strategy: 'v3-proxy' };
  } catch (e) {
    console.log('[sync] v3 falhou: ' + e.message);
  }

  // Estratégia 2: v4 POST offset-based
  try {
    console.log('[sync] tentando v4 POST get_item_list...');
    const all = [];
    let offset = 0;
    while (offset < 2000) {
      const body = JSON.stringify({ offset, page_size: 48, filter_status: 'NORMAL', filter_brand_ids: [], filter_condition: 'ALL', sort_by: 'POPULAR', reverse: false });
      const r = await shopeeRequest('https://seller.shopee.com.br/api/v4/product/get_item_list?SPC_CDS=' + spcCds + '&SPC_CDS_VER=2', { method: 'POST', headers: hdrs, body }, proxy);
      console.log('[sync] v4 offset=' + offset + ' status=' + r.status + ' body=' + r.body.slice(0, 200));
      const d = JSON.parse(r.body);
      if (d.error) throw new Error(d.error);
      const items = (d.data && (d.data.item_list || d.data.items)) || [];
      const total = (d.data && d.data.total) || 0;
      if (!items.length) break;
      all.push(...items);
      console.log('[sync] v4 +' + items.length + ' (acum=' + all.length + '/' + total + ')');
      if (!d.data.has_next_page || all.length >= total) break;
      offset += items.length;
      await new Promise(r => setTimeout(r, 350));
    }
    if (all.length > 0) return { products: all.map(mapProduct).filter(Boolean), strategy: 'v4-proxy' };
  } catch (e) {
    console.log('[sync] v4 falhou: ' + e.message);
  }

  throw new Error('Todos os endpoints falharam. Veja os logs do Railway.');
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

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.url === '/' || req.url === '/health') {
    const proxy = getProxyConfig();
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, service: 'vendry-sync', version: '6.0.0', proxy: proxy ? proxy.host + ':' + proxy.port : 'none' }));
    return;
  }

  const auth = req.headers['authorization'] || '';
  if (auth !== 'Bearer ' + SECRET) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }

  if (req.method === 'POST' && req.url === '/raw') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { cookies, spc_cds, fe_session } = JSON.parse(body);
        const proxy = getProxyConfig();
        const csrf = (cookies.match(/csrftoken=([^;]+)/) || [])[1] || '';
        const hdrs = makeHeaders(cookies, fe_session || '', csrf);
        const u = 'https://seller.shopee.com.br/api/v3/opt/mpsku/list/v2/search_product_list?SPC_CDS=' + spc_cds + '&SPC_CDS_VER=2&page_size=2&list_type=live_all&request_attribute=&operation_sort_by=recommend_v2&need_ads=false';
        const r = await shopeeRequest(u, { method: 'GET', headers: hdrs }, proxy);
        res.writeHead(200);
        res.end(r.body);
      } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/sync') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { cookies, spc_cds, fe_session } = JSON.parse(body);
        if (!cookies || !spc_cds) { res.writeHead(400); res.end(JSON.stringify({ error: 'cookies e spc_cds obrigatorios' })); return; }
        const result = await fetchAllProducts(cookies, spc_cds, fe_session || '');
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, products: result.products, total: result.products.length, strategy: result.strategy }));
      } catch (err) {
        console.error('[sync] erro final:', err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  const proxy = getProxyConfig();
  console.log('Vendry Sync v6.0 porta ' + PORT);
  console.log('Proxy: ' + (proxy ? proxy.host + ':' + proxy.port : 'nenhum configurado'));
});
