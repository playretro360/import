// Vendry Sync Server v2.3 — Node.js para Railway
const http = require('http');
const WebSocket = require('ws');

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
    res.end(JSON.stringify({ ok: true, service: 'vendry-sync', bd_configured: !!BD_WSS, version: '2.3.0' }));
    return;
  }

  const auth = req.headers['authorization'] || '';
  if (auth !== 'Bearer ' + SECRET) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }

  if (req.method === 'POST' && req.url === '/sync') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const { cookies, spc_cds, fe_session } = payload;
        if (!cookies || !spc_cds) { res.writeHead(400); res.end(JSON.stringify({ error: 'cookies e spc_cds obrigatorios' })); return; }
        const products = await fetchAllProducts(cookies, spc_cds, fe_session || '');
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, products, total: products.length }));
      } catch (err) {
        console.error('Sync error:', err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

async function fetchAllProducts(cookieStr, spcCds, feSession) {
  return new Promise((resolve, reject) => {
    console.log('[sync] v2.3 conectando...');
    const ws = new WebSocket(BD_WSS);
    let sessionId = null;
    let settled = false;
    let cursor = '';
    let fetchMsgId = 100;
    const all = [];
    const PAGE_SIZE = 12; // limite real da API v3

    const globalTimer = setTimeout(() => {
      console.log('[sync] timeout — retornando ' + all.length + ' produtos');
      settle(all.length > 0 ? all : new Error('Timeout sem produtos'));
    }, 55000);

    const settle = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(globalTimer);
      try { ws.close(); } catch (e) {}
      val instanceof Error ? reject(val) : resolve(val);
    };

    const send = (msg) => ws.send(JSON.stringify(msg));

    // Usa endpoint v3 GET — mesmo do listAllProducts() do worker
    const buildFetchJs = (cur) => {
      const params = 'SPC_CDS=' + spcCds + '&SPC_CDS_VER=2&page_size=' + PAGE_SIZE +
        '&list_type=live_all&request_attribute=&operation_sort_by=recommend_v2&need_ads=false' +
        (cur ? '&cursor=' + encodeURIComponent(cur) : '');
      const url = 'https://seller.shopee.com.br/api/v3/opt/mpsku/list/v2/search_product_list?' + params;
      return [
        "(function(){",
        "return fetch('" + url + "',{",
        "method:'GET',",
        "credentials:'include',",
        "headers:{",
        "'accept':'application/json,text/plain,*/*',",
        "'referer':'https://seller.shopee.com.br/portal/product/list/all',",
        "'sc-fe-session':'" + feSession + "',",
        "'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'",
        "}}).then(r=>r.json()).then(d=>JSON.stringify(d)).catch(e=>JSON.stringify({error:e.message}));",
        "})()"
      ].join('');
    };

    const doFetch = () => {
      console.log('[sync] buscando cursor=' + (cursor || 'inicio'));
      send({ id: fetchMsgId, method: 'Runtime.evaluate', params: { expression: buildFetchJs(cursor), awaitPromise: true, returnByValue: true }, sessionId });
    };

    ws.on('open', () => send({ id: 1, method: 'Target.createTarget', params: { url: 'about:blank' } }));

    ws.on('message', (raw) => {
      try {
        const d = JSON.parse(raw);
        const mid = d.id;

        if (mid === 1 && d.result && d.result.targetId) {
          send({ id: 2, method: 'Target.attachToTarget', params: { targetId: d.result.targetId, flatten: true } });

        } else if (mid === 2 && d.result && d.result.sessionId) {
          sessionId = d.result.sessionId;
          const cookieArr = cookieStr.split(';').map(p => {
            const eq = p.indexOf('='); if (eq < 0) return null;
            const name = p.slice(0, eq).trim();
            const value = p.slice(eq + 1).trim();
            if (!name) return null;
            return { name, value, domain: '.shopee.com.br', path: '/', secure: true };
          }).filter(Boolean);
          console.log('[sync] session=' + sessionId + ' cookies=' + cookieArr.length);
          send({ id: 3, method: 'Network.setCookies', params: { cookies: cookieArr }, sessionId });

        } else if (mid === 3) {
          // Navega para seller center para ativar cookies
          send({ id: 4, method: 'Page.navigate', params: { url: 'https://seller.shopee.com.br/portal/product/list/all' }, sessionId });

        } else if (mid === 4) {
          // Aguarda 5s para página carregar
          console.log('[sync] navegou — aguardando 5s...');
          setTimeout(doFetch, 5000);

        } else if (mid >= 100) {
          const val = (d.result && d.result.result && d.result.result.value) || '{}';
          console.log('[sync] resposta:', val.slice(0, 200));
          let parsed;
          try { parsed = JSON.parse(val); } catch (e) { return settle(new Error('Parse: ' + val.slice(0, 100))); }

          if (parsed.error) return settle(new Error('fetch: ' + parsed.error));
          if (parsed.code !== 0 && parsed.code !== undefined) return settle(new Error('Shopee code ' + parsed.code + ': ' + parsed.message));

          const products = (parsed.data && parsed.data.products) || [];
          const total = (parsed.data && parsed.data.page_info && parsed.data.page_info.total) || 0;
          const nextCursor = (parsed.data && parsed.data.page_info && parsed.data.page_info.cursor) || '';

          products.forEach(p => {
            const imgs = p.images || p.image || [];
            const imgArr = Array.isArray(imgs) ? imgs : [imgs];
            const img = (imgArr[0] && imgArr[0].image_url) || (typeof imgArr[0] === 'string' ? 'https://down-br.img.susercontent.com/file/' + imgArr[0] : '');
            all.push({
              id: p.item_id || p.id,
              name: p.name || p.item_name || '',
              price: (p.price || p.min_price || 0) / 100000,
              stock: p.stock || p.total_available_stock || 0,
              image: img,
              status: p.item_status || 'NORMAL',
              sales: p.sold || 0
            });
          });

          console.log('[sync] +' + products.length + ' produtos (total: ' + all.length + '/' + total + ')');

          if (products.length > 0 && nextCursor && nextCursor !== cursor && all.length < total) {
            cursor = nextCursor;
            fetchMsgId++;
            setTimeout(doFetch, 400);
          } else {
            console.log('[sync] DONE: ' + all.length + ' produtos');
            settle(all);
          }
        }
      } catch (ex) {
        console.error('[sync] erro:', ex.message);
        settle(new Error('msg: ' + ex.message));
      }
    });

    ws.on('error', (err) => { console.error('[sync] WS error:', err.message); settle(new Error('WS: ' + err.message)); });
    ws.on('close', () => { if (!settled) { if (all.length > 0) settle(all); else settle(new Error('WS fechou sem produtos')); } });
  });
}

server.listen(PORT, () => {
  console.log('Vendry Sync v2.3 porta ' + PORT);
  console.log('BD_WSS: ' + BD_WSS.replace(/:([^:@]+)@/, ':***@'));
});
