// Vendry Sync Server — Node.js para Railway
// Faz WebSocket CDP pro Bright Data Scraping Browser
// e retorna produtos da Shopee

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.SYNC_SECRET || 'vendry-sync-2025';
const BD_WSS = process.env.BD_WSS || '';

// ── SERVIDOR HTTP ────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(200); res.end(); return;
  }

  // Health check
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, service: 'vendry-sync' }));
    return;
  }

  // Auth
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${SECRET}`) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  // POST /sync — { cookies, spc_cds, fe_session }
  if (req.method === 'POST' && req.url === '/sync') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { cookies, spc_cds, fe_session } = JSON.parse(body);
        if (!cookies || !spc_cds) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'cookies e spc_cds obrigatorios' }));
          return;
        }
        const products = await syncViaScrapingBrowser(cookies, spc_cds, fe_session || '');
        res.writeHead(200);
        res.end(JSON.stringify({ products, total: products.length }));
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

// ── BRIGHT DATA SCRAPING BROWSER ─────────────────────────────
function syncViaScrapingBrowser(cookieStr, spcCds, feSession) {
  return new Promise((resolve, reject) => {
    const wssUrl = BD_WSS;
    if (!wssUrl) return reject(new Error('BD_WSS nao configurado'));

    console.log('Conectando ao Bright Data...');
    const ws = new WebSocket(wssUrl);
    let sessionId = null;
    let settled = false;

    const settle = (val) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (e) {}
      if (val instanceof Error) reject(val);
      else resolve(val);
    };

    const timer = setTimeout(() => settle(new Error('Timeout 30s')), 30000);
    const send = (msg) => ws.send(JSON.stringify(msg));

    ws.on('open', () => {
      console.log('Conectado! Criando target...');
      send({ id: 1, method: 'Target.createTarget', params: { url: 'about:blank' } });
    });

    ws.on('message', (data) => {
      const d = JSON.parse(data);
      const mid = d.id;

      if (mid === 1 && d.result?.targetId) {
        send({ id: 2, method: 'Target.attachToTarget', params: { targetId: d.result.targetId, flatten: true } });

      } else if (mid === 2 && d.result?.sessionId) {
        sessionId = d.result.sessionId;
        console.log('Session:', sessionId, '— Injetando cookies...');
        const cookies = cookieStr.split(';').map(p => {
          const eq = p.indexOf('=');
          if (eq < 0) return null;
          return { name: p.slice(0, eq).trim(), value: p.slice(eq + 1).trim(), domain: '.shopee.com.br', path: '/' };
        }).filter(Boolean);
        send({ id: 3, method: 'Network.setCookies', params: { cookies }, sessionId });

      } else if (mid === 3) {
        console.log('Cookies OK — Buscando produtos...');
        const js = `fetch('https://seller.shopee.com.br/api/v4/product/get_item_list?SPC_CDS=${spcCds}&SPC_CDS_VER=2',{method:'POST',headers:{'Content-Type':'application/json;charset=UTF-8','Referer':'https://seller.shopee.com.br/portal/product/list','sc-fe-session':'${feSession}'},body:JSON.stringify({offset:0,page_size:50,filter_status:'NORMAL',filter_brand_ids:[],filter_condition:'ALL',sort_by:'POPULAR',reverse:false})}).then(r=>r.json()).then(d=>JSON.stringify(d)).catch(e=>e.message)`;
        send({ id: 4, method: 'Runtime.evaluate', params: { expression: js, awaitPromise: true, returnByValue: true }, sessionId });

      } else if (mid === 4) {
        clearTimeout(timer);
        const val = d?.result?.result?.value || '{}';
        console.log('Resposta Shopee:', val.slice(0, 150));
        try {
          const data = JSON.parse(val);
          const items = data?.data?.item_list || data?.data?.items || [];
          const products = items.map(item => {
            const imgs = item.images || [];
            const img = imgs[0]?.image_url_list?.[0] || (typeof imgs[0] === 'string' ? 'https://down-br.img.susercontent.com/file/' + imgs[0] : '');
            const price = (item.price_info?.[0]?.current_price || 0) / 100000;
            return { id: item.item_id, name: item.item_name || '', price, stock: item.total_available_stock || 0, image: img };
          });
          console.log(`✅ ${products.length} produtos encontrados`);
          settle(products);
        } catch (ex) {
          settle(new Error('Parse error: ' + val.slice(0, 100)));
        }
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      console.error('WS error:', err.message);
      settle(new Error('WS: ' + err.message));
    });
  });
}

server.listen(PORT, () => {
  console.log(`✅ Vendry Sync Server rodando na porta ${PORT}`);
  console.log(`BD_WSS: ${BD_WSS ? 'configurado' : 'NAO CONFIGURADO'}`);
});
