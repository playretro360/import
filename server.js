// Vendry Sync Server v2.1 — Node.js para Railway
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
    res.end(JSON.stringify({ ok: true, service: 'vendry-sync', bd_configured: !!BD_WSS, version: '2.1.0' }));
    return;
  }

  const auth = req.headers['authorization'] || '';
  if (auth !== 'Bearer ' + SECRET) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  if (req.method === 'POST' && req.url === '/sync') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const { cookies, spc_cds, fe_session } = payload;
        const pageSize = Math.min(parseInt(payload.page_size) || 50, 100);
        if (!cookies || !spc_cds) { res.writeHead(400); res.end(JSON.stringify({ error: 'cookies e spc_cds obrigatorios' })); return; }
        const products = await fetchAllProducts(cookies, spc_cds, fe_session || '', pageSize);
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

async function fetchAllProducts(cookieStr, spcCds, feSession, pageSize) {
  return new Promise((resolve, reject) => {
    console.log('[sync] Conectando BD WSS... ' + BD_WSS.replace(/:([^:@]+)@/, ':***@'));
    const ws = new WebSocket(BD_WSS);
    let sessionId = null;
    let settled = false;
    let offset = 0;
    let fetchMsgId = 100;
    const all = [];

    const globalTimer = setTimeout(() => settle(new Error('Timeout 55s — ' + all.length + ' produtos parciais')), 55000);

    const settle = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(globalTimer);
      try { ws.close(); } catch (e) {}
      val instanceof Error ? reject(val) : resolve(val);
    };

    const send = (msg) => ws.send(JSON.stringify(msg));

    const buildJs = (off) => {
      const b = JSON.stringify({ offset: off, page_size: pageSize, filter_status: 'NORMAL', filter_brand_ids: [], filter_condition: 'ALL', sort_by: 'POPULAR', reverse: false });
      return "(function(){return fetch('https://seller.shopee.com.br/api/v4/product/get_item_list?SPC_CDS=" + spcCds + "&SPC_CDS_VER=2',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json;charset=UTF-8','Referer':'https://seller.shopee.com.br/portal/product/list','sc-fe-session':'" + feSession + "'},body:'" + b.replace(/'/g,"\\'") + "'}).then(r=>r.json()).then(d=>JSON.stringify(d)).catch(e=>JSON.stringify({error:e.message}));})()";
    };

    const doFetch = () => {
      console.log('[sync] offset=' + offset);
      send({ id: fetchMsgId, method: 'Runtime.evaluate', params: { expression: buildJs(offset), awaitPromise: true, returnByValue: true }, sessionId });
    };

    ws.on('open', () => send({ id: 1, method: 'Target.createTarget', params: { url: 'about:blank' } }));

    ws.on('message', (data) => {
      try {
        const d = JSON.parse(data);
        const mid = d.id;
        if (mid === 1 && d.result && d.result.targetId) {
          send({ id: 2, method: 'Target.attachToTarget', params: { targetId: d.result.targetId, flatten: true } });
        } else if (mid === 2 && d.result && d.result.sessionId) {
          sessionId = d.result.sessionId;
          const cookies = cookieStr.split(';').map(p => {
            const eq = p.indexOf('='); if (eq < 0) return null;
            return { name: p.slice(0, eq).trim(), value: p.slice(eq + 1).trim(), domain: '.shopee.com.br', path: '/' };
          }).filter(Boolean);
          send({ id: 3, method: 'Network.setCookies', params: { cookies }, sessionId });
        } else if (mid === 3) {
          doFetch();
        } else if (mid >= 100) {
          const val = (d && d.result && d.result.result && d.result.result.value) || '{}';
          let parsed;
          try { parsed = JSON.parse(val); } catch (e) { return settle(new Error('Parse: ' + val.slice(0, 80))); }
          if (parsed.error) return settle(new Error('Shopee: ' + parsed.error));
          const items = (parsed.data && parsed.data.item_list) || (parsed.data && parsed.data.items) || [];
          const total = (parsed.data && parsed.data.total) || 0;
          const hasNext = parsed.data && parsed.data.has_next_page != null ? parsed.data.has_next_page : items.length === pageSize;
          items.forEach(item => {
            const imgs = item.images || [];
            const img = (imgs[0] && imgs[0].image_url_list && imgs[0].image_url_list[0]) || (typeof imgs[0] === 'string' ? 'https://down-br.img.susercontent.com/file/' + imgs[0] : '');
            all.push({ id: item.item_id, name: item.item_name || '', price: ((item.price_info && item.price_info[0] && item.price_info[0].current_price) || 0) / 100000, stock: item.total_available_stock || 0, image: img, status: item.item_status || 'NORMAL', sales: item.sold || 0 });
          });
          console.log('[sync] +' + items.length + ' (total: ' + all.length + '/' + (total || '?') + ')');
          if (hasNext && items.length > 0 && (total === 0 || all.length < total)) {
            offset += pageSize; fetchMsgId++;
            setTimeout(doFetch, 300);
          } else {
            console.log('[sync] Concluido: ' + all.length + ' produtos');
            settle(all);
          }
        }
      } catch (ex) { settle(new Error('WS msg: ' + ex.message)); }
    });

    ws.on('error', (err) => { console.error('[sync] WS error:', err.message); settle(new Error('WS: ' + err.message)); });
    ws.on('close', () => { if (!settled) { if (all.length > 0) settle(all); else settle(new Error('WS fechou sem produtos')); } });
  });
}

server.listen(PORT, () => {
  console.log('Vendry Sync v2.1 porta ' + PORT);
  console.log('BD_WSS: ' + (BD_WSS ? BD_WSS.replace(/:([^:@]+)@/, ':***@') : 'NAO CONFIGURADO'));
});
