// Vendry Sync Server v10.0 — ADAPTIVE INTELLIGENCE + 50 ENDPOINTS
// Detecta padrões de bloqueio em tempo real e adapta automaticamente
// Sistema: Response Classifier + Header Scorer + Time Learner + Adaptive Backoff

const http = require('http');
const https = require('https');
const url_mod = require('url');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.SYNC_SECRET || 'vendry-sync-2025';
const BD_WSS = process.env.BD_WSS || '';

function getProxy() {
  const m = (BD_WSS||'').match(/wss?:\/\/([^:]+):([^@]+)@([^:/]+)/);
  if (!m) return null;
  return { user: m[1], pass: m[2], host: m[3], port: 22225 };
}

// ════════════════════════════════════════════════════════════
// 🧠 ADAPTIVE INTELLIGENCE ENGINE
// ════════════════════════════════════════════════════════════

// ── RESPONSE CLASSIFIER ──────────────────────────────────────
// Classifica cada resposta da Shopee em categorias de bloqueio
const RESPONSE_TYPES = {
  OK:           'ok',
  SOFT_BLOCK:   'soft_block',    // 200 mas dados vazios/suspeitos
  RATE_LIMITED: 'rate_limited',  // 429 ou código de rate limit
  COOKIE_DEAD:  'cookie_dead',   // sessão expirada
  CAPTCHA:      'captcha',       // detectou bot
  REDIRECT:     'redirect',      // redirecionou para login
  EMPTY:        'empty',         // dados vazios sem erro
  ERROR:        'error',         // erro genérico
};

function classifyResponse(status, data, raw, itemsFound) {
  // Cookie expirado
  if (status === 401) return RESPONSE_TYPES.COOKIE_DEAD;
  if (data.errcode === 2 || data.code === 2) return RESPONSE_TYPES.COOKIE_DEAD;
  if (data.message === 'Invalid session.' || data.message === 'Please login first.') return RESPONSE_TYPES.COOKIE_DEAD;

  // Rate limited
  if (status === 429) return RESPONSE_TYPES.RATE_LIMITED;
  if (data.code === 4) return RESPONSE_TYPES.RATE_LIMITED; // Shopee rate limit code
  if (data.message && data.message.toLowerCase().includes('too many')) return RESPONSE_TYPES.RATE_LIMITED;

  // Captcha / bot detected
  if (raw && raw.includes('captcha')) return RESPONSE_TYPES.CAPTCHA;
  if (raw && raw.includes('robot')) return RESPONSE_TYPES.CAPTCHA;
  if (raw && raw.includes('Please verify')) return RESPONSE_TYPES.CAPTCHA;
  if (status === 403) return RESPONSE_TYPES.CAPTCHA;

  // Redirect para login
  if (status === 302 || status === 301) return RESPONSE_TYPES.REDIRECT;
  if (raw && raw.includes('login?next=')) return RESPONSE_TYPES.REDIRECT;

  // Soft block — resposta 200 mas suspeita
  if (status === 200 && itemsFound === 0 && data.code === 0) return RESPONSE_TYPES.SOFT_BLOCK;
  if (status === 200 && raw && raw.length < 50) return RESPONSE_TYPES.SOFT_BLOCK;

  // Dados vazios sem erro claro
  if (status === 200 && itemsFound === 0) return RESPONSE_TYPES.EMPTY;

  // OK
  if (status === 200 && itemsFound > 0) return RESPONSE_TYPES.OK;

  return RESPONSE_TYPES.ERROR;
}

// ── HEADER SCORER ─────────────────────────────────────────────
// Cada combinação de headers recebe um score baseado em histórico
const headerScores = {};

function getHeaderKey(headers) {
  // Chave baseada nos headers mais relevantes para detecção
  const ua = headers['User-Agent'] || '';
  const lang = headers['Accept-Language'] || '';
  const chua = headers['sec-ch-ua'] || '';
  return `${ua.slice(0,20)}|${lang.slice(0,5)}|${chua.slice(0,10)}`;
}

function scoreHeaders(headers, result) {
  const key = getHeaderKey(headers);
  if (!headerScores[key]) headerScores[key] = { score: 50, uses: 0, wins: 0, blocks: 0 };
  const h = headerScores[key];
  h.uses++;

  switch(result) {
    case RESPONSE_TYPES.OK:
      h.score = Math.min(100, h.score + 5);
      h.wins++;
      break;
    case RESPONSE_TYPES.SOFT_BLOCK:
    case RESPONSE_TYPES.CAPTCHA:
      h.score = Math.max(0, h.score - 20);
      h.blocks++;
      break;
    case RESPONSE_TYPES.RATE_LIMITED:
      h.score = Math.max(10, h.score - 10);
      break;
    case RESPONSE_TYPES.EMPTY:
      h.score = Math.max(20, h.score - 3);
      break;
  }
}

function getBestHeaderScore(headers) {
  const key = getHeaderKey(headers);
  return headerScores[key] ? headerScores[key].score : 50;
}

// ── TIME LEARNER ─────────────────────────────────────────────
// Aprende quais horários têm menos bloqueios
const timePattern = Array(24).fill(null).map(() => ({ ok: 0, block: 0, rate: 50 }));

function recordTimeResult(type) {
  const hour = new Date().getUTCHours() - 3; // São Paulo
  const h = timePattern[((hour % 24) + 24) % 24];
  if (type === RESPONSE_TYPES.OK) {
    h.ok++;
    h.rate = Math.min(100, h.rate + 2);
  } else if ([RESPONSE_TYPES.SOFT_BLOCK, RESPONSE_TYPES.CAPTCHA, RESPONSE_TYPES.RATE_LIMITED].includes(type)) {
    h.block++;
    h.rate = Math.max(10, h.rate - 5);
  }
}

function getCurrentHourScore() {
  const hour = new Date().getUTCHours() - 3;
  return timePattern[((hour % 24) + 24) % 24].rate;
}

// ── ADAPTIVE BACKOFF ──────────────────────────────────────────
// Ajusta delays baseado no histórico recente de respostas
const recentResults = [];
const MAX_RECENT = 20;

function addResult(type) {
  recentResults.push({ type, time: Date.now() });
  if (recentResults.length > MAX_RECENT) recentResults.shift();
  recordTimeResult(type);
}

function getAdaptiveDelay() {
  const recent = recentResults.slice(-5);
  const blockCount = recent.filter(r =>
    [RESPONSE_TYPES.SOFT_BLOCK, RESPONSE_TYPES.CAPTCHA, RESPONSE_TYPES.RATE_LIMITED].includes(r.type)
  ).length;

  // Mais bloqueios recentes = maior delay
  const base = 200 + blockCount * 400;
  const hourScore = getCurrentHourScore();
  const hourMultiplier = 2 - (hourScore / 100); // hora ruim = delay maior

  const min = Math.round(base * hourMultiplier);
  const max = Math.round(min * 2);
  return { min, max };
}

function getPageDelay() {
  const { min, max } = getAdaptiveDelay();
  return sleep(min + Math.random() * (max - min));
}

// ── PATTERN MEMORY ────────────────────────────────────────────
// Memoriza quais endpoints funcionaram em qual contexto
const endpointMemory = {};

function recordEndpointResult(name, type, itemCount) {
  if (!endpointMemory[name]) endpointMemory[name] = { score: 50, lastType: null, lastItems: 0, uses: 0 };
  const m = endpointMemory[name];
  m.uses++;
  m.lastType = type;
  m.lastItems = itemCount;

  if (type === RESPONSE_TYPES.OK) m.score = Math.min(100, m.score + 8);
  else if (type === RESPONSE_TYPES.SOFT_BLOCK) m.score = Math.max(0, m.score - 15);
  else if (type === RESPONSE_TYPES.CAPTCHA) m.score = Math.max(0, m.score - 25);
  else if (type === RESPONSE_TYPES.RATE_LIMITED) m.score = Math.max(5, m.score - 10);
  else if (type === RESPONSE_TYPES.EMPTY) m.score = Math.max(15, m.score - 5);
}

// ════════════════════════════════════════════════════════════
// 🛡️ STEALTH HEADERS
// ════════════════════════════════════════════════════════════

const sleep = ms => new Promise(r => setTimeout(r, ms));
function jitter(v, p=0.2) { return Math.round(v*(1+(Math.random()-.5)*p*2)); }

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
];
const LANGS = ['pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7','pt-BR,pt;q=0.8,en;q=0.5','pt-BR,pt;q=0.9,en;q=0.4'];
const CHUA  = [
  '"Chromium";v="123","Not:A-Brand";v="8","Google Chrome";v="123"',
  '"Chromium";v="122","Not(A:Brand";v="24","Google Chrome";v="122"',
  '"Chromium";v="121","Not A_Brand";v="99","Google Chrome";v="121"',
];
const TIMEZONES = ['America/Sao_Paulo','America/Manaus','America/Recife','America/Fortaleza'];

function rnd(arr) { return arr[Math.floor(Math.random()*arr.length)]; }

// Seleciona headers com score mais alto
function H(cookies, feSession, extra={}, domain='seller') {
  // Cria 3 candidatos e escolhe o de maior score
  const candidates = Array(3).fill(null).map(() => {
    const ua = rnd(UAS);
    const isFF = ua.includes('Firefox');
    const isMob = ua.includes('iPhone');
    const ref = domain==='public'?'https://shopee.com.br/':'https://seller.shopee.com.br/portal/product/list/all';
    const orig = domain==='public'?'https://shopee.com.br':'https://seller.shopee.com.br';
    const h = {
      'User-Agent': ua,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': rnd(LANGS),
      'Accept-Encoding': 'gzip, deflate, br',
      'Cookie': cookies||'',
      'Referer': ref,
      'Origin': orig,
      'sc-fe-session': feSession||'',
      'Connection': 'keep-alive',
      'x-shopee-client-timezone': rnd(TIMEZONES),
      'x-shopee-language': 'pt-BR',
    };
    if (!isFF) {
      h['sec-ch-ua'] = rnd(CHUA);
      h['sec-ch-ua-mobile'] = isMob?'?1':'?0';
      h['sec-ch-ua-platform'] = isMob?'"Android"':'"Windows"';
      h['sec-fetch-dest'] = 'empty';
      h['sec-fetch-mode'] = 'cors';
      h['sec-fetch-site'] = 'same-origin';
      h['x-requested-with'] = 'XMLHttpRequest';
    }
    return {...h,...extra};
  });

  // Escolhe o candidato com maior score histórico
  return candidates.sort((a,b) => getBestHeaderScore(b) - getBestHeaderScore(a))[0];
}

// ════════════════════════════════════════════════════════════
// 🔌 CIRCUIT BREAKER
// ════════════════════════════════════════════════════════════
const breaker = {};
function cb(name) { if(!breaker[name]) breaker[name]={fails:0,lastFail:0,ok:true,wins:0}; return breaker[name]; }
function win(name)  { const b=cb(name); b.fails=0; b.ok=true; b.wins++; }
function fail(name) { const b=cb(name); b.fails++; b.lastFail=Date.now(); if(b.fails>=2) b.ok=false; }
function open(name) { const b=cb(name); if(b.ok) return false; if(Date.now()-b.lastFail>180000){b.fails=0;b.ok=true;return false;} return true; }

let bestEp=null, lastTime=0, lastCount=0;

// ════════════════════════════════════════════════════════════
// 🌐 PROXY REQUEST
// ════════════════════════════════════════════════════════════
function req(opts, body) {
  return new Promise((resolve,reject)=>{
    const proxy=getProxy();
    if(!proxy) return reject(new Error('Proxy nao configurado'));
    const tgt=new url_mod.URL(opts.url);
    const isHttps=tgt.protocol==='https:';
    const conn=http.request({
      host:proxy.host,port:proxy.port,method:'CONNECT',
      path:`${tgt.hostname}:${isHttps?443:80}`,
      headers:{'Proxy-Authorization':'Basic '+Buffer.from(`${proxy.user}:${proxy.pass}`).toString('base64'),'Host':tgt.hostname},
    });
    conn.setTimeout(12000);
    conn.on('error',reject);
    conn.on('timeout',()=>{conn.destroy();reject(new Error('CONNECT timeout'));});
    conn.on('connect',(res,sock)=>{
      if(res.statusCode!==200){sock.destroy();return reject(new Error('Proxy '+res.statusCode));}
      const ro={host:tgt.hostname,port:isHttps?443:80,path:tgt.pathname+tgt.search,method:opts.method||'GET',headers:opts.headers||{},socket:sock,agent:false};
      if(isHttps) ro.servername=tgt.hostname;
      const r=(isHttps?https:http).request(ro);
      r.setTimeout(18000);
      r.on('error',reject);
      r.on('timeout',()=>{r.destroy();reject(new Error('Request timeout'));});
      r.on('response',resp=>{
        const chunks=[];
        resp.on('data',c=>chunks.push(c));
        resp.on('end',()=>{
          const raw=Buffer.concat(chunks).toString('utf8');
          try{ resolve({status:resp.statusCode,data:JSON.parse(raw),headers:resp.headers,raw}); }
          catch{ resolve({status:resp.statusCode,data:{},headers:resp.headers,raw}); }
        });
        resp.on('error',reject);
      });
      if(body) r.write(body);
      r.end();
    });
    conn.end();
  });
}

// ════════════════════════════════════════════════════════════
// 📋 50 ENDPOINTS
// ════════════════════════════════════════════════════════════
function getEndpoints(spcCds, feSession, cookies) {
  const sc=`SPC_CDS=${spcCds}&SPC_CDS_VER=2`;
  const E=(name,tier,buildUrl,method,hdrs,extract,buildBody)=>({name,tier,buildUrl,method:method||'GET',headers:hdrs,extract,buildBody,paginated:true});
  const extr=(d,ip,tp,cp,hp)=>{
    const g=(o,p)=>p.split('.').reduce((a,k)=>a&&a[k],o);
    return{items:g(d,ip)||[],total:g(d,tp)||0,nextCursor:cp?g(d,cp)||'':'',hasMore:hp?!!(g(d,hp)):false,ok:d.code===0||d.error===0||(!d.error&&!d.errcode),expired:d.errcode===2||d.code===2||d.message==='Invalid session.'};
  };

  return [
    E('v3-search-recommend',1,cur=>`https://seller.shopee.com.br/api/v3/opt/mpsku/list/v2/search_product_list?${sc}&page_size=48&list_type=live_all&operation_sort_by=recommend_v2&need_ads=false${cur?'&cursor='+encodeURIComponent(cur):''}`,
      'GET',H(cookies,feSession,{'x-page':'product-list'}),d=>extr(d,'data.products','data.page_info.total','data.page_info.cursor','')),
    E('v3-search-price',1,cur=>`https://seller.shopee.com.br/api/v3/opt/mpsku/list/v2/search_product_list?${sc}&page_size=48&list_type=live_all&operation_sort_by=price_asc&need_ads=false${cur?'&cursor='+encodeURIComponent(cur):''}`,
      'GET',H(cookies,feSession),d=>extr(d,'data.products','data.page_info.total','data.page_info.cursor','')),
    E('v3-search-latest',1,cur=>`https://seller.shopee.com.br/api/v3/opt/mpsku/list/v2/search_product_list?${sc}&page_size=48&list_type=live_all&operation_sort_by=latest&need_ads=false${cur?'&cursor='+encodeURIComponent(cur):''}`,
      'GET',H(cookies,feSession),d=>extr(d,'data.products','data.page_info.total','data.page_info.cursor','')),
    E('v4-post-normal',2,(_,off)=>`https://seller.shopee.com.br/api/v4/product/get_item_list?${sc}`,
      'POST',H(cookies,feSession,{'Content-Type':'application/json; charset=UTF-8'}),d=>extr(d,'data.item','data.total','','data.has_next_page'),
      off=>JSON.stringify({offset:off||0,page_size:48,filter_status:'NORMAL',filter_brand_ids:[],need_complaint_policy:false})),
    E('v4-post-sold',2,(_,off)=>`https://seller.shopee.com.br/api/v4/product/get_item_list?${sc}`,
      'POST',H(cookies,feSession,{'Content-Type':'application/json'}),d=>extr(d,'data.item','data.total','','data.has_next_page'),
      off=>JSON.stringify({offset:off||0,page_size:48,filter_status:'NORMAL',sort_by:'sold'})),
    E('v4-post-stock',2,(_,off)=>`https://seller.shopee.com.br/api/v4/product/get_item_list?${sc}`,
      'POST',H(cookies,feSession,{'Content-Type':'application/json'}),d=>extr(d,'data.item','data.total','','data.has_next_page'),
      off=>JSON.stringify({offset:off||0,page_size:48,filter_status:'NORMAL',sort_by:'stock'})),
    E('v3-mpsku',3,cur=>`https://seller.shopee.com.br/api/v3/opt/mpsku/list?${sc}&page_size=48&list_type=live_all&operation_sort_by=recommend_v2${cur?'&cursor='+encodeURIComponent(cur):''}`,
      'GET',H(cookies,feSession),d=>extr(d,'data.products','data.page_info.total','data.page_info.cursor','')),
    E('v3-mpsku-v2',3,cur=>`https://seller.shopee.com.br/api/v3/opt/mpsku/list/v2?${sc}&page_size=48&list_type=live_all${cur?'&cursor='+encodeURIComponent(cur):''}`,
      'GET',H(cookies,feSession),d=>extr(d,'data.products','data.page_info.total','data.page_info.cursor','')),
    E('v3-list-all',3,(_,off)=>`https://seller.shopee.com.br/api/v3/product/list_all?${sc}&offset=${off||0}&limit=48`,
      'GET',H(cookies,feSession),d=>extr(d,'data.products','data.total','','data.has_next')),
    E('v3-live-products',3,(_,off)=>`https://seller.shopee.com.br/api/v3/product/live_products?${sc}&offset=${off||0}&limit=48`,
      'GET',H(cookies,feSession),d=>extr(d,'data.list','data.total','','data.has_next')),
    E('v2-list-live',4,(_,off)=>`https://seller.shopee.com.br/api/v2/product/list?${sc}&offset=${off||0}&limit=48&filter_status=live`,
      'GET',H(cookies,feSession),d=>extr(d,'data.items','data.total_count','','data.has_next_page')),
    E('v2-list-all',4,(_,off)=>`https://seller.shopee.com.br/api/v2/product/list?${sc}&offset=${off||0}&limit=48`,
      'GET',H(cookies,feSession),d=>extr(d,'data.items','data.total_count','','data.has_next_page')),
    E('v2-seller-items',4,(_,off)=>`https://seller.shopee.com.br/api/v2/seller/get_seller_item_list?${sc}&offset=${off||0}&limit=48&status=2`,
      'GET',H(cookies,feSession),d=>extr(d,'data.items','data.total_count','','data.has_next_page')),
    E('v2-export',4,(_,off)=>`https://seller.shopee.com.br/api/v2/product/export_product_list?${sc}&offset=${off||0}&limit=48`,
      'GET',H(cookies,feSession),d=>extr(d,'data.products','data.total','','data.has_next')),
    E('v2-dubious',4,(_,off)=>`https://seller.shopee.com.br/api/v2/product/get_dubious_item_list?${sc}&offset=${off||0}&limit=48`,
      'GET',H(cookies,feSession,{'x-api-source':'rn'}),d=>extr(d,'data.list','data.total','','data.has_next')),
    E('v4-search',5,(_,off)=>`https://seller.shopee.com.br/api/v4/product/search_items?${sc}&offset=${off||0}&limit=48&status=NORMAL&sort_by=LATEST`,
      'GET',H(cookies,feSession),d=>extr(d,'data.item','data.total','','data.has_next_page')),
    E('v4-mgmt',5,(_,off)=>`https://seller.shopee.com.br/api/v4/product/mgmt_list?${sc}&offset=${off||0}&limit=48&status=2`,
      'GET',H(cookies,feSession,{'x-page':'product-management'}),d=>extr(d,'data.items','data.total','','data.has_next')),
    E('v4-catalog',5,(_,off)=>`https://seller.shopee.com.br/api/v4/seller/catalog/list?${sc}&page=${Math.floor((off||0)/48)+1}&page_size=48`,
      'GET',H(cookies,feSession),d=>extr(d,'data.list','data.total','','data.has_next')),
    E('v4-listing',5,(_,off)=>`https://seller.shopee.com.br/api/v4/product/get_item_list?${sc}`,
      'POST',H(cookies,feSession,{'Content-Type':'application/json','x-page':'listing','x-mini-app':'1'}),d=>extr(d,'data.item','data.total','','data.has_next_page'),
      off=>JSON.stringify({offset:off||0,page_size:48,filter_status:'NORMAL',filter_out_of_stock:false})),
    E('v4-campaign',5,(_,off)=>`https://seller.shopee.com.br/api/v4/product/get_item_list?${sc}`,
      'POST',H(cookies,feSession,{'Content-Type':'application/json','x-shopee-page':'campaign'}),d=>extr(d,'data.item','data.total','','data.has_next_page'),
      off=>JSON.stringify({offset:off||0,page_size:48,filter_status:'NORMAL',need_campaign_info:true})),
    E('v5-item-list',5,(_,off)=>`https://seller.shopee.com.br/api/v5/product/item/list?${sc}&offset=${off||0}&page_size=48&filter_status=NORMAL`,
      'GET',H(cookies,feSession),d=>extr(d,'data.list','data.total','','data.has_next')),
    E('v5-product-list',5,(_,off)=>`https://seller.shopee.com.br/api/v5/product/list?${sc}&offset=${off||0}&page_size=48&status=NORMAL`,
      'GET',H(cookies,feSession),d=>extr(d,'data.list','data.total','','data.has_next')),
    E('v5-live-search',5,(_,off)=>`https://seller.shopee.com.br/api/v5/product/live_item_list?${sc}&offset=${off||0}&limit=48`,
      'GET',H(cookies,feSession),d=>extr(d,'data.items','data.total','','data.has_next')),
    E('v3-rn-mpsku',6,cur=>`https://seller.shopee.com.br/api/v3/opt/mpsku/list?${sc}&page_size=48&list_type=live_all${cur?'&cursor='+encodeURIComponent(cur):''}`,
      'GET',H(cookies,feSession,{'x-api-source':'rn','x-shopee-client-timezone':'America/Sao_Paulo'}),d=>extr(d,'data.products','data.page_info.total','data.page_info.cursor','')),
    E('v4-rn-items',6,(_,off)=>`https://seller.shopee.com.br/api/v4/product/get_item_list?${sc}`,
      'POST',H(cookies,feSession,{'Content-Type':'application/json','x-api-source':'rn','x-mini-app':'1'}),d=>extr(d,'data.item','data.total','','data.has_next_page'),
      off=>JSON.stringify({offset:off||0,page_size:48,filter_status:'NORMAL'})),
    E('v2-rn-list',6,(_,off)=>`https://seller.shopee.com.br/api/v2/product/list?${sc}&offset=${off||0}&limit=48&filter_status=live`,
      'GET',H(cookies,feSession,{'x-api-source':'rn','x-shopee-client-timezone':'America/Recife'}),d=>extr(d,'data.items','data.total_count','','data.has_next_page')),
    E('v1-showcase',7,(_,off)=>`https://seller.shopee.com.br/api/v1/showcase/product?${sc}&offset=${off||0}&limit=48`,
      'GET',H(cookies,feSession,{'x-api-source':'rn'}),d=>extr(d,'data.products','data.total','','data.has_next')),
    E('v1-basic',7,(_,off)=>`https://seller.shopee.com.br/api/v1/product/item_list?${sc}&offset=${off||0}&limit=48&filter_status=live&need_stock=true`,
      'GET',H(cookies,feSession),d=>extr(d,'data.items','data.total','','data.has_next')),
    E('v1-seller',7,(_,off)=>`https://seller.shopee.com.br/api/v1/seller/product/list?${sc}&offset=${off||0}&limit=48`,
      'GET',H(cookies,feSession),d=>extr(d,'data.list','data.total','','data.has_next')),
    E('v2-category',7,(_,off)=>`https://seller.shopee.com.br/api/v2/product/get_item_base_info?${sc}&offset=${off||0}&limit=48&status=NORMAL`,
      'GET',H(cookies,feSession),d=>extr(d,'data.item_list','data.total','','data.has_next_page')),
    E('v3-channel',7,(_,off)=>`https://seller.shopee.com.br/api/v3/product/channel_product_list?${sc}&offset=${off||0}&limit=48`,
      'GET',H(cookies,feSession),d=>extr(d,'data.list','data.total','','data.has_next')),
    E('public-pop',8,(_,off)=>`https://shopee.com.br/api/v4/search/search_items?by=pop&limit=48&newest=${off||0}&order=desc&page_type=shop&version=2`,
      'GET',H(cookies,feSession,{'Referer':'https://shopee.com.br/','Origin':'https://shopee.com.br'},'public'),
      d=>({items:d.items||[],total:d.total_count||0,hasMore:(d.items||[]).length>=48,ok:!d.error,expired:false})),
    E('public-latest',8,(_,off)=>`https://shopee.com.br/api/v4/search/search_items?by=ctime&limit=48&newest=${off||0}&order=desc&page_type=shop&version=2`,
      'GET',H(cookies,feSession,{'Referer':'https://shopee.com.br/','Origin':'https://shopee.com.br'},'public'),
      d=>({items:d.items||[],total:d.total_count||0,hasMore:(d.items||[]).length>=48,ok:!d.error,expired:false})),
    E('public-price',8,(_,off)=>`https://shopee.com.br/api/v4/search/search_items?by=price&limit=48&newest=${off||0}&order=asc&page_type=shop&version=2`,
      'GET',H(cookies,feSession,{'Referer':'https://shopee.com.br/','Origin':'https://shopee.com.br'},'public'),
      d=>({items:d.items||[],total:d.total_count||0,hasMore:(d.items||[]).length>=48,ok:!d.error,expired:false})),
    E('public-recommend',8,(_,off)=>`https://shopee.com.br/api/v4/recommend/recommend?bundle=shop_page_product_tab_main&limit=48&offset=${off||0}`,
      'GET',H(cookies,feSession,{'Referer':'https://shopee.com.br/','Origin':'https://shopee.com.br'},'public'),
      d=>({items:(d.sections&&d.sections[0]&&d.sections[0].data&&d.sections[0].data.item)||[],total:(d.sections&&d.sections[0]&&d.sections[0].total)||0,hasMore:!!(d.sections&&d.sections[0]&&d.sections[0].has_more),ok:!d.error,expired:false})),
    E('public-recommend-v2',8,(_,off)=>`https://shopee.com.br/api/v4/recommend/recommend?bundle=shop_page_tab_main&limit=48&offset=${off||0}`,
      'GET',H(cookies,feSession,{'Referer':'https://shopee.com.br/','Origin':'https://shopee.com.br'},'public'),
      d=>({items:(d.sections&&d.sections[0]&&d.sections[0].data&&d.sections[0].data.item)||[],total:(d.sections&&d.sections[0]&&d.sections[0].total)||0,hasMore:!!(d.sections&&d.sections[0]&&d.sections[0].has_more),ok:!d.error,expired:false})),
    E('public-rating',8,(_,off)=>`https://shopee.com.br/api/v4/search/search_items?by=rating&limit=48&newest=${off||0}&order=desc&page_type=shop&version=2`,
      'GET',H(cookies,feSession,{'Referer':'https://shopee.com.br/','Origin':'https://shopee.com.br'},'public'),
      d=>({items:d.items||[],total:d.total_count||0,hasMore:(d.items||[]).length>=48,ok:!d.error,expired:false})),
    E('v4-promotion',8,(_,off)=>`https://seller.shopee.com.br/api/v4/promotion/get_discount_list?${sc}&offset=${off||0}&limit=48`,
      'GET',H(cookies,feSession),d=>({items:(d.data&&(d.data.discount_list||d.data.list))||[],total:(d.data&&d.data.total)||0,hasMore:!!(d.data&&d.data.more),ok:d.code===0,expired:d.errcode===2})),
    E('v2-keyword-search',8,(_,off)=>`https://seller.shopee.com.br/api/v2/product/search?${sc}&keyword=&offset=${off||0}&limit=48&status=live`,
      'GET',H(cookies,feSession),d=>extr(d,'data.items','data.total','','data.has_next_page')),
    E('v3-all-include',8,(_,off)=>`https://seller.shopee.com.br/api/v3/product/list_all?${sc}&offset=${off||0}&limit=48&include_unpublished=false`,
      'GET',H(cookies,feSession,{'x-shopee-language':'pt-BR'}),d=>extr(d,'data.products','data.total','','data.has_next')),
    E('v4-batch-info',8,(_,off)=>`https://seller.shopee.com.br/api/v4/product/get_item_list?${sc}`,
      'POST',H(cookies,feSession,{'Content-Type':'application/json','x-shopee-page':'batch'}),d=>extr(d,'data.item','data.total','','data.has_next_page'),
      off=>JSON.stringify({offset:off||0,page_size:48,filter_status:'NORMAL',need_tax_info:false})),
    E('v5-seller-all',8,(_,off)=>`https://seller.shopee.com.br/api/v5/product/item/list?${sc}&offset=${off||0}&page_size=48&filter_status=NORMAL&sort_type=1`,
      'GET',H(cookies,feSession,{'x-api-source':'rn'}),d=>extr(d,'data.list','data.total','','data.has_next')),
    E('v3-search-boosted',8,cur=>`https://seller.shopee.com.br/api/v3/opt/mpsku/list/v2/search_product_list?${sc}&page_size=48&list_type=live_all&operation_sort_by=recommend_v2&need_ads=true${cur?'&cursor='+encodeURIComponent(cur):''}`,
      'GET',H(cookies,feSession),d=>extr(d,'data.products','data.page_info.total','data.page_info.cursor','')),
    E('v4-analytics',8,(_,off)=>`https://seller.shopee.com.br/api/v4/product/get_item_list?${sc}`,
      'POST',H(cookies,feSession,{'Content-Type':'application/json','x-page':'analytics'}),d=>extr(d,'data.item','data.total','','data.has_next_page'),
      off=>JSON.stringify({offset:off||0,page_size:48,filter_status:'NORMAL',need_complaint_policy:false})),
    E('v3-search-count',9,cur=>`https://seller.shopee.com.br/api/v3/opt/mpsku/list/v2/search_product_list?${sc}&page_size=48&list_type=all&operation_sort_by=recommend_v2${cur?'&cursor='+encodeURIComponent(cur):''}`,
      'GET',H(cookies,feSession,{'x-shopee-page':'product-count'}),d=>extr(d,'data.products','data.page_info.total','data.page_info.cursor','')),
    E('v2-all-status',9,(_,off)=>`https://seller.shopee.com.br/api/v2/product/list?${sc}&offset=${off||0}&limit=48&filter_status=all`,
      'GET',H(cookies,feSession,{'x-shopee-page':'all-products'}),d=>extr(d,'data.items','data.total_count','','data.has_next_page')),
    E('v4-post-all',9,(_,off)=>`https://seller.shopee.com.br/api/v4/product/get_item_list?${sc}`,
      'POST',H(cookies,feSession,{'Content-Type':'application/json','x-shopee-page':'all'}),d=>extr(d,'data.item','data.total','','data.has_next_page'),
      off=>JSON.stringify({offset:off||0,page_size:48,filter_status:'ALL'})),
    E('v3-soldout',9,cur=>`https://seller.shopee.com.br/api/v3/opt/mpsku/list?${sc}&page_size=48&list_type=soldout${cur?'&cursor='+encodeURIComponent(cur):''}`,
      'GET',H(cookies,feSession),d=>extr(d,'data.products','data.page_info.total','data.page_info.cursor','')),
    E('v2-soldout-fallback',9,(_,off)=>`https://seller.shopee.com.br/api/v2/product/list?${sc}&offset=${off||0}&limit=48&filter_status=soldout`,
      'GET',H(cookies,feSession),d=>extr(d,'data.items','data.total_count','','data.has_next_page')),
    E('v1-all-fallback',9,(_,off)=>`https://seller.shopee.com.br/api/v1/product/item_list?${sc}&offset=${off||0}&limit=48&need_stock=true&need_price=true`,
      'GET',H(cookies,feSession,{'x-api-source':'rn'}),d=>extr(d,'data.items','data.total','','data.has_next')),
  ];
}

// ════════════════════════════════════════════════════════════
// 🔄 NORMALIZE
// ════════════════════════════════════════════════════════════
function normalize(raw) {
  if(!raw) return null;
  const name=raw.name||raw.item_name||raw.product_name||raw.title||'';
  const id=raw.item_id||raw.id||raw.product_id||raw.itemid||'';
  let price=raw.price_min||raw.price||raw.min_price||raw.current_price||0;
  if(price>100000) price=price/100000;
  const stock=raw.stock||raw.total_reserved_stock||raw.normal_stock||raw.available_stock||0;
  const sales=raw.historical_sold||raw.sales||raw.sold||raw.sold_count||0;
  const imgs=raw.images||raw.image||raw.item_images||[];
  const imgH=Array.isArray(imgs)?(imgs[0]?.url||imgs[0]?.image_url||imgs[0]||''):(imgs?.url||imgs||'');
  const image=imgH.startsWith('http')?imgH:(imgH?'https://down-br.img.susercontent.com/file/'+imgH:'');
  if(!name&&!id) return null;
  return {id:String(id),name:String(name).slice(0,255),price:Math.round(price*100)/100,stock:Number(stock)||0,sales:Number(sales)||0,image};
}

// ════════════════════════════════════════════════════════════
// 🚀 ADAPTIVE SYNC
// ════════════════════════════════════════════════════════════
async function sync(cookies, feSession, spcCds) {
  const eps = getEndpoints(spcCds, feSession, cookies);

  // Ordena por: melhor score adaptativo > sem bloqueio > tier
  const ordered = [...eps].sort((a, b) => {
    if (a.name === bestEp) return -1;
    if (b.name === bestEp) return 1;
    const openA = open(a.name), openB = open(b.name);
    if (openA && !openB) return 1;
    if (!openA && openB) return -1;
    const scoreA = (endpointMemory[a.name]?.score || 50);
    const scoreB = (endpointMemory[b.name]?.score || 50);
    if (Math.abs(scoreA - scoreB) > 10) return scoreB - scoreA; // score diferente → prioriza maior
    return (a.tier || 9) - (b.tier || 9); // score similar → usa tier
  });

  for (const ep of ordered) {
    if (open(ep.name)) continue;

    // Delay adaptativo baseado no histórico
    const { min, max } = getAdaptiveDelay();
    await sleep(min + Math.random() * (max - min));

    try {
      let all = [], cursor = null, offset = 0, pages = 0;

      while (pages < 25) {
        const u = ep.buildUrl ? ep.buildUrl(cursor, offset) : ep.url;
        const b = ep.buildBody ? ep.buildBody(offset) : null;
        const r = await req({ url: u, method: ep.method || 'GET', headers: ep.headers || {} }, b);

        const x = ep.extract(r.data);
        const items = (x.items || []).map(normalize).filter(Boolean);
        const responseType = classifyResponse(r.status, r.data, r.raw, items.length);

        // Registra no sistema adaptativo
        scoreHeaders(ep.headers, responseType);
        recordEndpointResult(ep.name, responseType, items.length);
        addResult(responseType);

        // Ação baseada na classificação
        if (responseType === RESPONSE_TYPES.COOKIE_DEAD) {
          return { ok: false, expired: true, error: 'Cookie expirado', endpoint: ep.name };
        }
        if (responseType === RESPONSE_TYPES.CAPTCHA) {
          fail(ep.name);
          console.log(`[v10] ${ep.name} CAPTCHA — trocando endpoint`);
          break;
        }
        if (responseType === RESPONSE_TYPES.RATE_LIMITED) {
          fail(ep.name);
          await sleep(jitter(3000, 0.3)); // aguarda mais em rate limit
          break;
        }
        if (responseType === RESPONSE_TYPES.SOFT_BLOCK && pages === 0) {
          fail(ep.name);
          console.log(`[v10] ${ep.name} SOFT BLOCK — tentando próximo`);
          break;
        }
        if (responseType === RESPONSE_TYPES.ERROR && pages === 0) {
          fail(ep.name);
          break;
        }

        all = all.concat(items);
        if (!x.nextCursor && !x.hasMore) break;
        cursor = x.nextCursor || null;
        offset += items.length || 48;
        pages++;

        // Delay adaptativo entre páginas
        await getPageDelay();
      }

      if (all.length > 0) {
        win(ep.name);
        bestEp = ep.name;
        lastTime = Date.now();
        lastCount = all.length;
        const hourScore = getCurrentHourScore();
        console.log(`[v10] ✅ ${ep.name} tier${ep.tier} → ${all.length} prods | hour_score:${hourScore} | pages:${pages + 1}`);
        return { ok: true, products: all, endpoint: ep.name, strategy: ep.name, pages: pages + 1,
          intelligence: { hour_score: hourScore, endpoint_score: endpointMemory[ep.name]?.score || 50 } };
      }

    } catch (e) {
      fail(ep.name);
      recordEndpointResult(ep.name, RESPONSE_TYPES.ERROR, 0);
      addResult(RESPONSE_TYPES.ERROR);
      console.log(`[v10] ❌ ${ep.name} ERR: ${e.message}`);
    }
  }

  return { ok: false, error: 'Todos os 50 endpoints falharam', products: [], endpoint: 'none' };
}

// ════════════════════════════════════════════════════════════
// 🖥️ HTTP SERVER
// ════════════════════════════════════════════════════════════
http.createServer(async (req, res) => {
  const p = url_mod.parse(req.url, true).pathname;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ') || auth.slice(7) !== SECRET) {
    res.writeHead(401);
    return res.end(JSON.stringify({ error: 'Nao autorizado' }));
  }

  if (req.method === 'GET' && p === '/health') {
    const topHeaders = Object.entries(headerScores)
      .sort((a,b) => b[1].score - a[1].score).slice(0, 3)
      .map(([k, v]) => ({ key: k.slice(0, 30), score: v.score, wins: v.wins }));
    const topEndpoints = Object.entries(endpointMemory)
      .sort((a,b) => b[1].score - a[1].score).slice(0, 5)
      .map(([n, v]) => ({ name: n, score: v.score, uses: v.uses }));
    const hourScore = getCurrentHourScore();
    const recentTypes = recentResults.slice(-10).map(r => r.type);
    const cbList = Object.entries(breaker).map(([n, b]) => ({ endpoint: n, ok: b.ok, fails: b.fails, wins: b.wins || 0 }));

    res.writeHead(200);
    return res.end(JSON.stringify({
      ok: true, service: 'vendry-sync', version: '10.0.0',
      proxy: getProxy() ? getProxy().host + ':' + getProxy().port : 'none',
      endpoints_total: 50,
      last_sync: lastTime ? new Date(lastTime).toISOString() : null,
      last_count: lastCount,
      best_endpoint: bestEp,
      intelligence: {
        hour_score: hourScore,
        recent_results: recentTypes,
        top_headers: topHeaders,
        top_endpoints: topEndpoints,
        adaptive_delay: getAdaptiveDelay(),
      },
      circuit_breakers: cbList,
    }));
  }

  if (req.method === 'GET' && p === '/intelligence') {
    res.writeHead(200);
    return res.end(JSON.stringify({
      header_scores: headerScores,
      endpoint_memory: endpointMemory,
      time_pattern: timePattern.map((h, i) => ({ hour: i, ...h })),
      recent_results: recentResults.slice(-20),
    }));
  }

  if (req.method === 'GET' && p === '/check') {
    res.writeHead(200);
    return res.end(JSON.stringify({ ok: true, proxy: !!getProxy(), endpoints: 50, version: '10.0.0', intelligence: true }));
  }

  if (req.method === 'POST' && p === '/sync') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const d = JSON.parse(body);
        if (!d.cookies || !d.spc_cds) { res.writeHead(400); return res.end(JSON.stringify({ error: 'cookies e spc_cds obrigatorios' })); }
        const r = await sync(d.cookies, d.fe_session || '', d.spc_cds);
        res.writeHead(r.ok ? 200 : r.expired ? 401 : 500);
        res.end(JSON.stringify(r));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
}).listen(PORT, () => console.log(`[vendry-sync v10] ${PORT} | 50 endpoints | adaptive intelligence ON`));
