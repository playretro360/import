// Vendry Sync Server v14.1 — REFRESH HIERARCHY FIX (L1 → L2 → L3)
// FIX: refresh_token ANTES do browser, validação real (exige SPC_ST + shop_name),
//      merge seguro (não sobrescreve tokens com vazios), 5 endpoints de refresh
// GERADOR AUTOMÁTICO: paths × versões × variações = cobertura total Shopee
// INDETECTÁVEL: brd.superproxy.io + IA adaptativa + 8 UA pool
// Categorias: Order | Product | Logistics | Shop | Finance | Promotion |
//             Analytics | Returns | Label | Voucher | Account | Chat |
//             Fulfillment | Inventory | Category | Rating | Search | Recommend

const http    = require('http');
const https   = require('https');
const url_mod = require('url');

const PORT   = process.env.PORT   || 3000;
const SECRET = process.env.SYNC_SECRET || 'vendry-sync-2025';
const BD_WSS_RAW = process.env.BD_WSS || '';

// Injeta country-br no username pra forçar IP brasileiro no Scraping Browser
function buildBdWss(country = 'br') {
  if (!BD_WSS_RAW) return '';
  // Username Bright Data: brd-customer-XXX-zone-YYY → adiciona -country-br
  // Se já tiver -country-, substitui; senão, adiciona antes do :
  const m = BD_WSS_RAW.match(/^(wss?:\/\/)([^:]+):([^@]+)@(.+)$/);
  if (!m) return BD_WSS_RAW;
  const [, proto, user, pass, hostpart] = m;
  let newUser = user;
  if (/-country-[a-z]{2}/.test(newUser)) {
    newUser = newUser.replace(/-country-[a-z]{2}/, '-country-' + country);
  } else {
    newUser = newUser + '-country-' + country;
  }
  return `${proto}${newUser}:${pass}@${hostpart}`;
}

const BD_WSS = buildBdWss('br');

function getProxy() {
  const m = (BD_WSS||'').match(/wss?:\/\/([^:]+):([^@]+)@([^:/]+)/);
  if (!m) return null;
  return { user: m[1], pass: m[2], host: m[3], port: 22225 };
}

// ── UA + HEADER POOLS ────────────────────────────────────────
const UA_DESKTOP = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];
const UA_MOBILE = [
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
];
const UA_ALL = [...UA_DESKTOP, ...UA_MOBILE];
const SC_FE_VER = ['21.142502','21.141426','21.140000','21.139500','21.138000'];
const rnd = arr => arr[Math.floor(Math.random()*arr.length)];

function sellerHeaders(cookies, feSession, mobile=false) {
  return {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'pt-BR,pt;q=0.9',
    'content-type': 'application/json;charset=UTF-8',
    'origin': 'https://seller.shopee.com.br',
    'referer': 'https://seller.shopee.com.br/',
    'sc-fe-ver': rnd(SC_FE_VER),
    'x-csrftoken': (cookies.match(/CTOKEN=([^;]+)/)||[])[1] || '',
    'user-agent': mobile ? rnd(UA_MOBILE) : rnd(UA_DESKTOP),
    'cookie': cookies,
    ...(feSession ? { 'sc-fe-session': feSession } : {}),
  };
}

function buyerHeaders(cookies, mobile=false) {
  return {
    'user-agent': mobile ? rnd(UA_MOBILE) : rnd(UA_DESKTOP),
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'pt-BR,pt;q=0.9',
    'referer': 'https://shopee.com.br/',
    'origin': 'https://shopee.com.br',
    'x-api-source': mobile ? 'mobile' : 'pc',
    'af-ac-enc-dat': 'a',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    ...(cookies ? { 'cookie': cookies } : {}),
  };
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
function proxyReq(opts, body) {
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
async function syncV10(cookies, feSession, spcCds) {
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
        const r = await proxyReq({ url: u, method: ep.method || 'GET', headers: ep.headers || {} }, b);

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
// ════════════════════════════════════════════════════════════
// ⚙️  ENDPOINT GENERATOR ENGINE
// Multiplica paths × versões × variações automaticamente
// ════════════════════════════════════════════════════════════

const SB = 'https://seller.shopee.com.br';
const BB = 'https://shopee.com.br';

// ── SELLER CENTER: todos paths únicos por categoria ──────────
const SC_PATHS = {

  // ORDER — 35 paths únicos
  order: [
    'order/search_order_list_index', 'order/get_order_list_card_list',
    'order/get_order_count', 'order/get_order_list', 'order/query_order_list',
    'order/get_order_index', 'order/get_all_orders', 'order/get_order_detail',
    'order/get_order_info', 'order/get_order_card_detail',
    'order/get_order_list_by_status', 'order/get_paginated_order_list',
    'order/fetch_order_list', 'order/get_order_cards',
    'order/get_order_batch', 'order/get_order_card_list',
    'order/download_sd_job', 'order/download_awb', 'order/batch_download_awb',
    'order/download_label', 'order/get_label_pdf',
    'order/get_waybill_format', 'order/get_order_label',
    'order/get_label_info', 'order/get_awb_print',
    'order/get_sd_jobs', 'order/get_sd_job_status',
    'order/create_label_job', 'order/get_label_job',
    'order/batch_download_label', 'order/batch_download_sd_job',
    'order/confirm_order', 'order/cancel_order',
    'order/get_order_escrow_detail', 'order/get_order_payment',
  ],

  // PRODUCT/MPSKU — 30 paths únicos
  product: [
    'opt/mpsku/list/v2/search_product_list',
    'product/get_item_list', 'product/get_product_info',
    'product/get_item_base_info', 'product/search_items',
    'product/get_item_detail', 'product/get_model_list',
    'product/get_category', 'product/get_attributes',
    'product/get_brand_list', 'product/get_item_promotion',
    'product/get_shop_info', 'product/get_item_extra_info',
    'product/get_dts_limit', 'product/get_seller_word',
    'product/add_item', 'product/update_item',
    'product/delete_item', 'product/unlist_item',
    'product/list_item', 'product/get_item_status',
    'product/boost_item', 'product/get_boosted_list',
    'product/get_item_limit', 'product/get_live_item',
    'mgmt/get_item_list', 'catalog/get_item_list',
    'listing/get_item_list', 'analytics/get_product_performance',
    'opt/mpsku/list/v2/get_product_info',
  ],

  // LOGISTICS — 20 paths únicos
  logistics: [
    'logistics/get_optional_channel_list', 'logistics/get_tracking_info',
    'logistics/init_logistic', 'logistics/get_waybill',
    'logistics/get_batch_waybill', 'logistics/download_waybill',
    'logistics/get_logistics_channel', 'logistics/update_shipping',
    'logistics/ship_order', 'logistics/get_shipping_parameter',
    'logistics/get_address', 'logistics/get_time_slot_list',
    'logistics/get_branch_list', 'logistics/get_airway_bill',
    'logistics/create_print_job', 'logistics/get_print_job',
    'logistics/get_shipment_list', 'logistics/get_channel_list',
    'logistics/get_mass_ship_list', 'logistics/mass_ship_order',
  ],

  // SHIPMENT — 15 paths únicos
  shipment: [
    'shipment/get_shipping_label', 'shipment/create_label_job',
    'shipment/get_label_job', 'shipment/download_label_pdf',
    'shipment/get_label', 'shipment/create_batch_label',
    'shipment/get_batch_label_status', 'shipment/get_shipment_list',
    'shipment/confirm_shipment', 'shipment/cancel_shipment',
    'shipment/get_tracking_number', 'shipment/update_tracking',
    'shipment/get_ship_by_date', 'shipment/get_pre_order',
    'shipment/get_shipment_info',
  ],

  // SHOP — 15 paths únicos
  shop: [
    'shop/get_shop_info', 'shop/get_shop_performance',
    'shop/update_shop_info', 'shop/get_shop_category_list',
    'shop/get_recommended_shop', 'shop/get_shop_rating',
    'shop/get_penalty_point', 'shop/get_shop_notification',
    'shop/get_profile', 'shop/update_profile',
    'shop/get_decoration_info', 'shop/get_sales_rank',
    'shop/get_shop_by_username', 'shop/get_shop_details',
    'shop/get_seller_tier',
  ],

  // FINANCE/WALLET — 18 paths únicos
  finance: [
    'finance/get_wallet_balance', 'finance/get_transaction_list',
    'finance/get_income_overview', 'finance/get_payout_detail',
    'finance/get_bank_account', 'finance/request_withdrawal',
    'finance/get_withdrawal_history', 'finance/get_revenue',
    'finance/get_order_income', 'finance/get_escrow_list',
    'finance/get_commission_detail', 'finance/get_service_fee',
    'finance/get_adjustment_list', 'finance/get_income_list',
    'finance/get_payout_list', 'finance/get_balance_history',
    'finance/get_wallet_info', 'finance/get_coin_info',
  ],

  // PROMOTION — 20 paths únicos
  promotion: [
    'promotion/get_promotion_list', 'promotion/create_promotion',
    'promotion/delete_promotion', 'promotion/update_promotion',
    'promotion/get_promotion_detail', 'promotion/get_discount_list',
    'promotion/create_discount', 'promotion/delete_discount',
    'promotion/get_deal_list', 'promotion/create_deal',
    'promotion/get_flash_sale', 'promotion/get_flash_sale_item',
    'promotion/get_bundle_deal', 'promotion/create_bundle_deal',
    'promotion/get_add_on_deal', 'promotion/get_voucher_list',
    'promotion/create_voucher', 'promotion/get_shopee_deal',
    'promotion/get_coin_deal', 'promotion/get_cashback',
  ],

  // ADS/CAMPAIGN — 15 paths únicos
  ads: [
    'campaign/get_campaign_list', 'campaign/create_campaign',
    'campaign/update_campaign', 'campaign/get_campaign_detail',
    'campaign/get_item_ads', 'campaign/create_item_ad',
    'campaign/update_item_ad', 'campaign/get_keyword_bid',
    'campaign/get_recommendation', 'campaign/get_ads_performance',
    'campaign/get_credit', 'campaign/get_campaign_report',
    'campaign/get_keyword_list', 'campaign/get_auto_ads',
    'campaign/get_ads_balance',
  ],

  // ANALYTICS — 12 paths únicos
  analytics: [
    'analytics/get_overview', 'analytics/get_traffic_source',
    'analytics/get_product_performance', 'analytics/get_shop_performance',
    'analytics/get_order_performance', 'analytics/get_buyer_behavior',
    'analytics/get_keyword_performance', 'analytics/get_ranking',
    'analytics/get_sales_summary', 'analytics/get_revenue_chart',
    'analytics/get_visitor_chart', 'analytics/get_conversion_rate',
  ],

  // RETURNS — 10 paths únicos
  returns: [
    'returns/get_unprocessed_order_return_number',
    'returns/get_return_list', 'returns/get_return_detail',
    'returns/confirm_return', 'returns/reject_return',
    'returns/get_dispute_list', 'returns/get_dispute_detail',
    'returns/create_dispute', 'returns/get_return_history',
    'returns/get_refund_list',
  ],

  // VOUCHER — 10 paths únicos
  voucher: [
    'voucher/get_voucher_list', 'voucher/create_voucher',
    'voucher/delete_voucher', 'voucher/update_voucher',
    'voucher/get_voucher_detail', 'voucher/get_usage_list',
    'voucher/get_channel_voucher', 'voucher/add_item_to_voucher',
    'voucher/remove_item_from_voucher', 'voucher/get_eligible_items',
  ],

  // ACCOUNT — 10 paths únicos
  account: [
    'account/basic_info', 'account/get_profile',
    'account/update_profile', 'account/get_shop_list',
    'account/get_auth_list', 'account/get_permission',
    'account/get_sub_account_list', 'account/get_notification',
    'account/get_seller_status', 'account/get_tier',
  ],

  // CHAT — 8 paths únicos
  chat: [
    'chat/get_conversation_list', 'chat/get_message_list',
    'chat/send_message', 'chat/get_unread_count',
    'chat/mark_read', 'chat/upload_image',
    'chat/get_quick_reply', 'chat/set_auto_reply',
  ],

  // FULFILLMENT — 8 paths únicos
  fulfillment: [
    'fulfilment/get_label', 'fulfilment/get_label_url',
    'fulfilment/get_order_list', 'fulfilment/confirm_order',
    'fulfilment/get_channel_list', 'fulfilment/get_tracking',
    'fulfilment/get_shipment_list', 'fulfilment/create_shipment',
  ],

  // INVENTORY — 8 paths únicos
  inventory: [
    'inventory/get_stock_list', 'inventory/update_stock',
    'inventory/get_warehouse_list', 'inventory/get_low_stock',
    'inventory/reserve_stock', 'inventory/release_stock',
    'inventory/get_stock_movement', 'inventory/get_sku_list',
  ],

  // AFFILIATE — 2 paths únicos
  affiliate: [
    'affiliate/get_offer_list', 'affiliate/get_commission',
  ],

  // CRON — 1 path único
  cron: [
    'cron/sync_products',
  ],

  // CATEGORY — 5 paths únicos
  category: [
    'category/get_category_list', 'category/get_category_detail',
    'category/get_attribute_list', 'category/get_brand_list',
    'category/get_recommended_category',
  ],

  // RATING/REVIEW — 8 paths únicos
  rating: [
    'rating/get_rating_list', 'rating/reply_rating',
    'rating/get_reply_list', 'rating/get_seller_rating',
    'rating/get_item_rating', 'rating/get_rating_summary',
    'rating/delete_reply', 'rating/get_report_list',
  ],
};

// ── BUYER API: paths únicos por categoria ────────────────────
const BU_PATHS = {

  // SEARCH — 15 paths únicos
  search: [
    'search/search_items', 'search/search_keyword',
    'search/get_search_config', 'search/search_hint',
    'search/get_related_keyword', 'search/search_by_image',
    'search/get_trending_keyword', 'search/search_category',
    'search/get_auto_complete', 'search/search_shop',
    'search/get_search_result', 'search/keyword_list',
    'search/search_items_v2', 'search/search_global',
    'search/flash_sale_search',
  ],

  // PRODUCT/ITEM — 18 paths únicos
  product: [
    'pdp/get_pc_item_info', 'pdp/get_item_price',
    'pdp/get_shop_batch', 'pdp/get_item_detail',
    'pdp/get_item_rating', 'pdp/get_item_like',
    'item/get_ratings', 'item/get_item_info',
    'item/get_model_info', 'item/get_promo_price',
    'item/get_item_info_v2', 'item/get_variation',
    'item/get_item_extra_info', 'item/get_label_list',
    'item/like', 'item/unlike',
    'item/get_item_bundle', 'item/get_item_voucher',
  ],

  // SHOP — 12 paths únicos
  shop: [
    'shop/get_shop_base', 'shop/get_shop_info',
    'shop/get_shop_rating_list', 'shop/get_shop_all_item_list',
    'shop/get_shop_items', 'shop/get_shop_decoration',
    'shop/get_shop_category_list', 'shop/follow_shop',
    'shop/unfollow_shop', 'shop/get_followed_shops',
    'shop/get_shop_vouchers', 'shop/get_top_picks',
  ],

  // RECOMMEND — 10 paths únicos (diferentes bundles)
  recommend: [
    'recommend/recommend', 'recommend/get_banner',
    'recommend/get_daily_discover', 'recommend/get_flash_sale',
    'recommend/get_popular_list', 'recommend/get_trending',
    'recommend/get_new_arrival', 'recommend/get_best_deals',
    'recommend/get_followed_items', 'recommend/get_for_you',
  ],

  // CART/CHECKOUT — 8 paths únicos
  cart: [
    'cart/get_cart', 'cart/add_to_cart',
    'cart/remove_from_cart', 'cart/update_cart',
    'checkout/get_checkout_info', 'checkout/create_order',
    'checkout/get_payment_method', 'checkout/apply_voucher',
  ],

  // USER/ACCOUNT — 8 paths únicos
  user: [
    'user/get_profile', 'user/update_profile',
    'user/get_order_list', 'user/get_wish_list',
    'user/get_notification', 'user/get_address_list',
    'user/get_coin_info', 'user/get_following',
  ],

  // PROMOTION/DEAL — 8 paths únicos
  promo: [
    'promotion/get_deal_list', 'promotion/get_flash_sale',
    'promotion/get_voucher_list', 'promotion/apply_voucher',
    'promotion/get_discount_info', 'promotion/get_bundle_deal',
    'promotion/get_coin_deals', 'promotion/get_promo_banner',
  ],

  // PAYMENT — 6 paths únicos
  payment: [
    'payment/get_payment_method', 'payment/get_payment_status',
    'payment/init_payment', 'payment/confirm_payment',
    'payment/get_coin_balance', 'payment/get_installment',
  ],

  // CHAT — 5 paths únicos
  chat: [
    'chat/get_conversation_list', 'chat/get_message',
    'chat/send_message', 'chat/get_unread',
    'chat/mark_read',
  ],

  // REVIEW — 5 paths únicos
  review: [
    'review/get_rating_list', 'review/add_rating',
    'review/get_seller_response', 'review/get_summary',
    'review/get_item_review',
  ],

  // LOGISTICS (buyer side) — 5 paths únicos
  logistics: [
    'logistics/get_tracking', 'logistics/get_order_status',
    'logistics/get_delivery_info', 'logistics/get_address',
    'logistics/confirm_received',
  ],

  // FLASH SALE — 5 paths únicos
  flash: [
    'flash_sale/get_all_sessions', 'flash_sale/get_session_item',
    'flash_sale/get_flash_sale_item', 'flash_sale/get_time_slot',
    'flash_sale/get_flash_banner',
  ],
};

// ── GERADOR DE ENDPOINTS ──────────────────────────────────────
// Cria endpoint objects para cada path × versão × variação
function generateEps(isSellerCenter, paths, versions=[1,2,3,4,5], sc='', method='GET', bodyFn=null) {
  const base = isSellerCenter ? SB : BB;
  const eps  = [];

  for (const path of paths) {
    for (const v of versions) {
      const url = `${base}/api/v${v}/${path}?${sc}`;
      const category = path.split('/')[0];
      const name     = `${isSellerCenter?'sc':'bu'}-v${v}-${path.replace(/\//g,'-').replace(/[^a-z0-9-]/gi,'_')}`;
      // Tier based on version (v3/v4 most likely to work)
      const tier = v===3?1 : v===4?1 : v===2?2 : v===5?3 : 4;
      eps.push({ name, tier, url, method, bodyFn, category,
        isSeller: isSellerCenter, version: v, path });
    }

    // Mobile UA variation para paths críticos
    const criticalPaths = ['search', 'recommend', 'shop', 'product'];
    if (!isSellerCenter && criticalPaths.some(c => path.includes(c))) {
      eps.push({ name: `bu-mob-v4-${path.replace(/\//g,'-')}`, tier: 3,
        url: `${BB}/api/v4/${path}?`, method, bodyFn, category: path.split('/')[0],
        isSeller: false, mobile: true });
    }
  }
  return eps;
}

// Gera TODOS os endpoints de uma vez
let _allEpsCache = null;
function getAllEndpoints(sc, cookies, feSession) {
  // Gera endpoints de TODAS as categorias do Seller Center
  const scEps = [];
  for (const [cat, paths] of Object.entries(SC_PATHS)) {
    scEps.push(...generateEps(true, paths, [1,2,3,4,5], sc));
  }

  // Gera endpoints de TODAS as categorias do Buyer API
  const buEps = [];
  for (const [cat, paths] of Object.entries(BU_PATHS)) {
    buEps.push(...generateEps(false, paths, [1,2,3,4,5], ''));
  }

  return { scEps, buEps, total: scEps.length + buEps.length };
}

// ── DISPATCHER: chama endpoint certo com headers certos ───────
async function callEndpoint(ep, cookies, feSession, body) {
  const hdrs = ep.isSeller
    ? sellerHeaders(cookies, feSession, ep.mobile||false)
    : buyerHeaders(cookies, ep.mobile||false);
  if (ep.method === 'POST' || body) hdrs['content-type'] = 'application/json;charset=UTF-8';
  return proxyReq({ url: ep.url, method: body?'POST':'GET', headers: hdrs }, body);
}

// ── ADAPTIVE SEARCH (usa todos endpoints por categoria) ───────
async function adaptiveSearch(eps, cookies, feSession, bodyFn, parseFn, label) {
  // Ordena por: score adaptativo > tier > não-bloqueado
  const ordered = [...eps].sort((a, b) => {
    const sa = endpointMemory[a.name]?.score || 50;
    const sb = endpointMemory[b.name]?.score || 50;
    if (!open(a.name) && open(b.name)) return 1;
    if (open(a.name) && !open(b.name)) return -1;
    if (Math.abs(sa-sb) > 10) return sb - sa;
    return a.tier - b.tier;
  });

  for (const ep of ordered) {
    if (!open(ep.name)) continue;
    try {
      const body = bodyFn ? bodyFn(ep) : null;
      const r    = await callEndpoint(ep, cookies, feSession, body);
      const result = parseFn(r.data, r.status, r.raw);

      if (result) {
        win(ep.name);
        recordEndpointResult(ep.name, RESPONSE_TYPES.OK, typeof result === 'number' ? result : 1);
        addResult(RESPONSE_TYPES.OK);
        console.log(`[${label}] ✅ ${ep.name}`);
        return { ok: true, data: result, endpoint: ep.name };
      }

      const rtype = classifyResponse(r.status, r.data, r.raw, 0);
      fail(ep.name); recordEndpointResult(ep.name, rtype, 0); addResult(rtype);
      if (rtype === RESPONSE_TYPES.RATE_LIMITED) await new Promise(r=>setTimeout(r, getAdaptiveDelay().max));
      else if (rtype !== RESPONSE_TYPES.EMPTY) await new Promise(r=>setTimeout(r, getAdaptiveDelay().min));
    } catch (e) {
      fail(ep.name); recordEndpointResult(ep.name, RESPONSE_TYPES.ERROR, 0); addResult(RESPONSE_TYPES.ERROR);
    }
  }
  return { ok: false, data: null };
}

// STATÍSTICAS
function getStats(sc) {
  const { scEps, buEps } = getAllEndpoints(sc, '', '');
  // Multiplica por variações de parâmetros (cobertura 3x)
  const variantMultiplier = 3;
  const total = (scEps.length + buEps.length) * variantMultiplier;
  const open_count = [...scEps, ...buEps].filter(e => open(e.name)).length * variantMultiplier;
  const cats_sc = Object.keys(SC_PATHS).length;
  const cats_bu = Object.keys(BU_PATHS).length;
  return { total, seller_center: scEps.length, buyer_api: buEps.length,
    open: open_count, blocked: total - open_count,
    categories: cats_sc + cats_bu,
    sc_categories: cats_sc, bu_categories: cats_bu };
}


// ════════════════════════════════════════════════════════════
// 🔄 SYNC — usa todos endpoints de product + order do SC
// ════════════════════════════════════════════════════════════
async function sync(cookies, feSession, spcCds) {
  // Usa os 50 endpoints otimizados do v10 (preservados)
  return await syncV10(cookies, feSession, spcCds);
}

// ════════════════════════════════════════════════════════════
// 🔍 SEARCH PUBLIC — usa todos endpoints buyer search + shop + recommend
// ════════════════════════════════════════════════════════════
function parseSearchResult(data) {
  if (!data) return null;
  if (data.items?.length > 0) return { items: data.items, total: data.total_count || data.items.length };
  const sec = data?.data?.sections?.[0]?.data;
  if (sec?.item?.length > 0) return { items: sec.item, total: sec.banner_count || sec.item.length };
  const d = data?.data;
  if (!d) return null;
  const all = d.item_list || d.items || d.list || d.item || [];
  if (all.length > 0) return { items: all, total: d.total_count || d.total || all.length };
  return null;
}

async function searchPublic(shopid, cookies, limit, offset) {
  const L = limit||20, O = offset||0, S = shopid;

  // Constrói endpoints específicos para search público
  // (gera todas variações de sort × versão × bundle)
  const SEARCH_CONFIGS = [
    // recommend bundles × sort_types (5×5 = 25)
    ...['shop_page_product_tab_main','shop_page_new_product','popular_items','hot_sale','trending_items',
        'shop_page_product_tab_all','shop_page_flash_sale','shop_page_deal','shop_collab','member_exclusive'].flatMap(bundle =>
      [1,2,3,4,5].map(st => ({
        name: `srch-rec-${bundle.slice(0,12)}-st${st}`,
        tier: bundle==='shop_page_product_tab_main'?1:bundle==='popular_items'?2:3,
        url: `${BB}/api/v4/recommend/recommend?bundle=${bundle}&limit=${L}&offset=${O}&shopid=${S}&sort_type=${st}`,
      }))
    ),
    // search_items × by × version (7×3 = 21)
    ...['pop','sales','ctime','price','rating','relevancy','like'].flatMap(by =>
      [1,2,4].map(v => ({
        name: `srch-si-v${v}-${by}`,
        tier: (by==='pop'||by==='sales')?1:2,
        url: `${BB}/api/v${v}/search/search_items?by=${by}&limit=${L}&newest=${O}&order=${by==='price'?'asc':'desc'}&page_type=shop&scenario=PAGE_OTHERS&shopid=${S}&version=2`,
      }))
    ),
    // all_item_list × sort × filter (5×2 = 10)
    ...['pop','sales','latest','price_asc','price_desc'].flatMap(sort =>
      [0,1].map(f => ({
        name: `srch-all-${sort}-f${f}`,
        tier: 2,
        url: `${BB}/api/v4/shop/get_shop_all_item_list?shopid=${S}&limit=${L}&offset=${O}&filter_sold_out=${f}&sort_by=${sort}`,
      }))
    ),
    // v2/v3 variations (10)
    ...['pop','sales'].flatMap(by =>
      ['v2','v3'].flatMap(v => [
        { name: `srch-${v}-${by}`, tier: 3, url: `${BB}/api/${v}/search_items?by=${by}&limit=${L}&newest=${O}&shopid=${S}` },
        { name: `srch-${v}-shop-${by}`, tier: 3, url: `${BB}/api/${v}/shop/get_shop_items?shopid=${S}&page_type=shop&sort_type=${by}&limit=${L}&offset=${O}` },
        { name: `srch-${v}-all-${by}`, tier: 3, url: `${BB}/api/${v}/shop/get_shop_all_item_list?shopid=${S}&limit=${L}&offset=${O}&sort_by=${by}` },
      ])
    ),
    // v5 + misc (5)
    { name: 'srch-v5-search', tier: 4, url: `${BB}/api/v5/search/search_items?by=pop&limit=${L}&newest=${O}&shopid=${S}` },
    { name: 'srch-v5-rec', tier: 4, url: `${BB}/api/v5/recommend/recommend?bundle=shop_page_product_tab_main&limit=${L}&offset=${O}&shopid=${S}` },
    { name: 'srch-pdp-batch', tier: 4, url: `${BB}/api/v4/pdp/get_shop_batch?shopids=${S}` },
    { name: 'srch-v4-global', tier: 4, url: `${BB}/api/v4/search/search_items?by=pop&limit=${L}&newest=${O}&order=desc&page_type=shop&scenario=PAGE_GLOBAL_SEARCH&shopid=${S}&version=2` },
    { name: 'srch-kw-empty', tier: 4, url: `${BB}/api/v4/search/search_items?by=pop&keyword=&limit=${L}&newest=${O}&order=desc&page_type=shop&scenario=PAGE_OTHERS&shopid=${S}&version=2` },
  ];

  // Ordena por adaptive score
  const ordered = SEARCH_CONFIGS.sort((a,b) => {
    const sa = endpointMemory[a.name]?.score||50, sb = endpointMemory[b.name]?.score||50;
    if (!open(a.name)&&open(b.name)) return 1;
    if (open(a.name)&&!open(b.name)) return -1;
    if (Math.abs(sa-sb)>10) return sb-sa;
    return (a.tier||5)-(b.tier||5);
  });

  const mobile = false;
  for (const ep of ordered) {
    if (open(ep.name)) continue; // pula se circuit breaker aberto (quebrado)
    try {
      const r = await proxyReq({ url: ep.url, method:'GET', headers: buyerHeaders(cookies, mobile) });
      const parsed = parseSearchResult(r.data);
      if (parsed?.items?.length > 0) {
        win(ep.name); recordEndpointResult(ep.name, RESPONSE_TYPES.OK, parsed.items.length); addResult(RESPONSE_TYPES.OK);
        console.log(`[search] ✅ ${ep.name} → ${parsed.items.length}`);
        return { ok:true, items:parsed.items, total_count:parsed.total, endpoint:ep.name, source:'railway_proxy' };
      }
      const rtype = classifyResponse(r.status, r.data, r.raw, 0);
      fail(ep.name); recordEndpointResult(ep.name, rtype, 0); addResult(rtype);
      await new Promise(r=>setTimeout(r, rtype===RESPONSE_TYPES.RATE_LIMITED?getAdaptiveDelay().max:getAdaptiveDelay().min));
    } catch(e) { fail(ep.name); recordEndpointResult(ep.name, RESPONSE_TYPES.ERROR, 0); addResult(RESPONSE_TYPES.ERROR); }
  }
  return { ok:false, items:[], total_count:0, error:`Todos os ${SEARCH_CONFIGS.length} endpoints falharam` };
}

// ════════════════════════════════════════════════════════════
// 📦 ORDERS — usa TODOS endpoints de order do SC (35 paths × 5 vers)
// ════════════════════════════════════════════════════════════

function buildOrderBody(tab, subStatus, page, pageSize) {
  return JSON.stringify({
    order_list_tab: tab, entity_type: 1,
    pagination: { from_page_number: 1, page_number: page, page_size: pageSize||40 },
    sort: { sort_type: 2, ascending: false },
    ...(subStatus ? { filter: { order_to_ship_status: subStatus, fulfillment_type: 0, is_drop_off: 0, action_filter: 0 } } : {}),
  });
}

function parseOrderCard(c, statusLabel) {
  const card=(c.card||c).package_card||(c.card||c);
  const ext=card.order_ext_info||card.order_info||{};
  const pkg=card.package_ext_info||card.package_info||{};
  const hdr=card.card_header||card.header||{};
  const pay=card.payment_info||card.price_info||{};
  const ful=card.fulfilment_info||card.fulfillment_info||{};
  const iG =card.item_info_group?.item_info_list||card.item_list||[];
  const items=Array.isArray(iG)?iG.flatMap(g=>g.item_list||g.items||(g.item_name?[g]:[])):[];
  const sn=hdr.order_sn||ext.order_sn||String(ext.order_id||'');
  if(!sn) return null;
  const rawP=pay.total_price||pay.buyer_total_amount||pay.real_price||0;
  const total=rawP>=100000?rawP/100000:rawP>=1000?rawP/100:rawP;
  return { order_sn:sn, order_id:ext.order_id||0, status:statusLabel,
    buyer:hdr.buyer_info?.username||hdr.buyer_info?.buyer_username||ext.buyer_username||'',
    total, package_number:pkg.package_number||'',
    channel_id:pkg.shipping_method||pkg.fulfilment_channel_id||90016,
    fulfilment_name:ful.fulfilment_channel_name||'',
    items:items.slice(0,3).map(i=>i.item_name||i.name||'').filter(Boolean),
    shop_id:c.shopId||card.shop_id||ext.shop_id||0, can_label:c.sub==='done', job_id:null };
}

async function getOrders(cookies, feSession, spcCds) {
  const SC = `SPC_CDS=${spcCds}&SPC_CDS_VER=2`;
  const shopId = parseInt((cookies.match(/SPC_U=(\d+)/)||[])[1]||'0');

  // INDEX ENDPOINTS: todos 35 paths × 5 versões para tabs
  const IDX_PATHS = ['order/search_order_list_index','order/get_order_list','order/query_order_list',
    'order/get_order_index','order/get_all_orders','order/get_order_list_by_status',
    'order/get_paginated_order_list','order/fetch_order_list','order/get_order_count'];

  // CARD ENDPOINTS: paths para buscar card data
  const CARD_PATHS = ['order/get_order_list_card_list','order/get_order_cards',
    'order/get_order_card_detail','order/get_order_batch','order/get_order_info'];

  const TABS = [
    {tab:300,sub:1,label:'READY_TO_SHIP',canLabel:false},
    {tab:300,sub:2,label:'READY_TO_SHIP',canLabel:true},
    {tab:400,sub:0,label:'SHIPPED',canLabel:false},
    {tab:500,sub:0,label:'COMPLETED',canLabel:false},
    {tab:600,sub:0,label:'CANCELLED',canLabel:false},
    {tab:700,sub:0,label:'TO_RETURN',canLabel:false},
  ];

  const results=[], seen=new Set();

  for (const t of TABS) {
    let all=[], page=1;

    while (page<=20) {
      let got=false;
      // Tenta todos index endpoints
      for (const path of IDX_PATHS) {
        for (const v of [3,4,2,5,1]) {
          const ename=`ord-idx-v${v}-${path.replace(/\//g,'-')}-t${t.tab}`;
          if (!open(ename)) continue;
          try {
            const url=`${SB}/api/v${v}/${path}?${SC}`;
            const body=buildOrderBody(t.tab, t.sub, page, 40);
            const r=await proxyReq({url, method:'POST', headers:sellerHeaders(cookies,feSession)}, body);
            const list=r.data?.data?.index_list||r.data?.data?.order_list||r.data?.data?.list||r.data?.data?.orders||[];
            if (r.data?.code===0 && list.length===0) { win(ename); got=true; break; }
            if (list.length>0) {
              win(ename); recordEndpointResult(ename,RESPONSE_TYPES.OK,list.length); addResult(RESPONSE_TYPES.OK);
              all.push(...list);
              got=list.length<40; break;
            }
            fail(ename);
          } catch(e) { fail(ename); }
        }
        if (got) break;
      }
      if (!got||all.length>=2000) break;
      page++; await new Promise(r=>setTimeout(r,200));
    }

    // Busca cards para os com package_number
    const withPkg=all.filter(o=>o.package_number), noPkg=all.filter(o=>!o.package_number);
    if (withPkg.length>0) {
      const batchSz=5;
      for (let i=0;i<withPkg.length;i+=batchSz) {
        const batch=withPkg.slice(i,i+batchSz);
        for (const path of CARD_PATHS) {
          for (const v of [3,4,2]) {
            const ename=`ord-card-v${v}-${path.replace(/\//g,'-')}-t${t.tab}`;
            if (!open(ename)) continue;
            try {
              const url=`${SB}/api/v${v}/${path}?${SC}`;
              const body=JSON.stringify({order_list_tab:t.tab,need_count_down_desc:false,
                package_param_list:batch.map(o=>({package_number:o.package_number||'',order_id:o.order_id||0,shop_id:o.shop_id||shopId,region_id:'BR'}))});
              const r=await proxyReq({url,method:'POST',headers:sellerHeaders(cookies,feSession)},body);
              const cards=r.data?.data?.card_list||r.data?.data?.cards||r.data?.data?.list||[];
              if (cards.length>0) {
                win(ename); recordEndpointResult(ename,RESPONSE_TYPES.OK,cards.length); addResult(RESPONSE_TYPES.OK);
                for (const c of cards) {
                  const p=parseOrderCard({card:c,shopId,sub:t.canLabel?'done':''},t.label);
                  if (p&&!seen.has(p.order_sn)){seen.add(p.order_sn);results.push(p);}
                }
                break;
              }
              fail(ename);
            } catch(e) { fail(ename); }
          }
        }
        if (i+batchSz<withPkg.length) await new Promise(r=>setTimeout(r,100));
      }
    }
    for (const o of noPkg) {
      const sn=o.order_sn||String(o.order_id||'');
      if(!sn||seen.has(sn))continue;
      seen.add(sn);
      results.push({order_sn:sn,order_id:o.order_id||0,status:t.label,buyer:'',total:0,
        package_number:'',channel_id:90016,fulfilment_name:'',items:[],shop_id:shopId,can_label:false,job_id:null});
    }
    await new Promise(r=>setTimeout(r,300));
  }
  return { ok:true, orders:results, count:results.length };
}

// ════════════════════════════════════════════════════════════
// 🏷️ LABELS — usa TODOS endpoints de label + logistics do SC
// ════════════════════════════════════════════════════════════

function proxyReqBinary(opts) {
  return new Promise((resolve,reject)=>{
    const proxy=getProxy();
    if(!proxy)return reject(new Error('Proxy nao configurado'));
    const tgt=new url_mod.URL(opts.url);
    const isHttps=tgt.protocol==='https:';
    const conn=http.request({host:proxy.host,port:proxy.port,method:'CONNECT',
      path:`${tgt.hostname}:${isHttps?443:80}`,
      headers:{'Proxy-Authorization':'Basic '+Buffer.from(`${proxy.user}:${proxy.pass}`).toString('base64'),'Host':tgt.hostname}});
    conn.setTimeout(15000);
    conn.on('error',reject);
    conn.on('timeout',()=>{conn.destroy();reject(new Error('CONNECT timeout'));});
    conn.on('connect',(res,sock)=>{
      if(res.statusCode!==200){sock.destroy();return reject(new Error('Proxy '+res.statusCode));}
      const ro={host:tgt.hostname,port:isHttps?443:80,path:tgt.pathname+tgt.search,method:opts.method||'GET',headers:opts.headers||{},socket:sock,agent:false};
      if(isHttps)ro.servername=tgt.hostname;
      const r=(isHttps?https:http).request(ro);
      r.setTimeout(25000);
      r.on('error',reject);
      r.on('timeout',()=>{r.destroy();reject(new Error('Binary timeout'));});
      r.on('response',resp=>{
        const chunks=[];
        resp.on('data',c=>chunks.push(c));
        resp.on('end',()=>{
          const bytes=Buffer.concat(chunks);
          const ct=(resp.headers['content-type']||'').toLowerCase();
          const isPdf=ct.includes('pdf')||(bytes.length>4&&bytes[0]===0x25&&bytes[1]===0x50&&bytes[2]===0x44&&bytes[3]===0x46);
          resolve({bytes,isPdf,status:resp.statusCode,contentType:ct});
        });
        resp.on('error',reject);
      });
      if(opts.body)r.write(opts.body);
      r.end();
    });
    conn.end();
  });
}

async function getLabel(cookies, feSession, spcCds, orderSn, pkgNumber, channelId, shopId, orderId) {
  const SC=`SPC_CDS=${spcCds}&SPC_CDS_VER=2`;
  const hdrs=sellerHeaders(cookies,feSession);
  const SN=encodeURIComponent(orderSn), PN=encodeURIComponent(pkgNumber||'');

  // MÉTODO BINARY — 35+ endpoints de download direto
  const BINARY_PATHS = [
    `order/download_sd_job?${SC}&package_number=${PN}&order_sn=${SN}&first_time=0&lang=pt-br`,
    `order/download_sd_job?${SC}&package_number=${PN}&order_sn=${SN}&first_time=1&lang=pt-br`,
    `order/download_sd_job?${SC}&order_sn=${SN}&first_time=0&lang=pt-br`,
    `order/download_awb?${SC}&package_number=${PN}&order_sn=${SN}`,
    `order/download_awb?${SC}&package_number=${PN}`,
    `order/download_label?${SC}&order_sn=${SN}&package_number=${PN}&lang=pt-br`,
    `order/get_label_pdf?${SC}&order_sn=${SN}&package_number=${PN}`,
    `logistics/download_waybill?${SC}&channel_id=${channelId}&order_sn=${SN}`,
    `shipment/download_label_pdf?${SC}&package_number=${PN}`,
    `label/download?${SC}&order_sn=${SN}&package_number=${PN}`,
    `shipping/download_label?${SC}&order_sn=${SN}`,
  ];
  for (const path of BINARY_PATHS) {
    for (const v of [3,4,2,5]) {
      const ename=`lbl-bin-v${v}-${path.split('?')[0].replace(/\//g,'-').slice(0,30)}`;
      if(!open(ename)) continue;
      try {
        const r=await proxyReqBinary({url:`${SB}/api/v${v}/${path}`,method:'GET',headers:hdrs});
        if(r.isPdf&&r.bytes?.length>1000){win(ename);return{ok:true,pdf_base64:r.bytes.toString('base64'),method:ename};}
        fail(ename);
      } catch(e){fail(ename);}
    }
  }

  // MÉTODO URL — 20+ endpoints que retornam URL do PDF
  const URL_PATHS = [
    {p:`order/get_waybill_format?${SC}&package_number=${PN}&lang=pt-br`, f:['pdf_url','waybill_url','label_url']},
    {p:`order/get_waybill_format?${SC}&package_number=${PN}&lang=en`, f:['pdf_url']},
    {p:`order/get_order_label?${SC}&order_sn=${SN}`, f:['label_url','pdf_url']},
    {p:`order/get_label_info?${SC}&order_sn=${SN}`, f:['pdf_url','label_url','download_url']},
    {p:`logistics/get_waybill?${SC}&package_number=${PN}`, f:['pdf_url','waybill_pdf']},
    {p:`shipment/get_label?${SC}&package_number=${PN}&order_sn=${SN}`, f:['label_url','pdf_url']},
    {p:`shipment/get_shipping_label?${SC}&order_sn=${SN}`, f:['label_url','pdf_url']},
    {p:`fulfilment/get_label?${SC}&package_number=${PN}`, f:['pdf_url','label_url']},
    {p:`package/get_label?${SC}&package_number=${PN}&order_sn=${SN}`, f:['label_url','pdf_url']},
    {p:`logistics/get_airway_bill?${SC}&order_sn=${SN}`, f:['pdf_url','url']},
  ];
  const deepUrl=(data,fields)=>{for(const f of fields){const v=data?.data?.[f]||data?.[f];if(v&&v.startsWith('http'))return v;}return null;};
  for (const {p,f} of URL_PATHS) {
    for (const v of [3,4,2]) {
      const ename=`lbl-url-v${v}-${p.split('?')[0].replace(/\//g,'-').slice(0,25)}`;
      if(!open(ename)) continue;
      try {
        const r=await proxyReq({url:`${SB}/api/v${v}/${p}`,method:'GET',headers:hdrs});
        const pdfUrl=deepUrl(r.data,f);
        if(pdfUrl){
          const pr=await proxyReqBinary({url:pdfUrl,method:'GET',headers:{'User-Agent':hdrs['user-agent']}});
          if(pr.isPdf&&pr.bytes?.length>1000){win(ename);return{ok:true,pdf_base64:pr.bytes.toString('base64'),method:ename};}
        }
        fail(ename);
      } catch(e){fail(ename);}
    }
  }

  // MÉTODO JOB — 10+ endpoints de polling
  const JOB_CONFIGS = [
    {create:`order/get_sd_jobs?${SC}`,status:`order/get_sd_job_status?${SC}`,body:{package_list:[{package_number:pkgNumber,order_sn:orderSn}]}},
    {create:`order/create_label_job?${SC}`,status:`order/get_label_job?${SC}`,body:{packages:[{package_number:pkgNumber,order_sn:orderSn}]}},
    {create:`logistics/create_print_job?${SC}`,status:`logistics/get_print_job?${SC}`,body:{package_number:pkgNumber,order_sn:orderSn}},
    {create:`shipment/create_label_job?${SC}`,status:`shipment/get_label_job?${SC}`,body:{package_numbers:[pkgNumber]}},
    {create:`label/create_job?${SC}`,status:`label/get_job?${SC}`,body:{package_number:pkgNumber,order_sn:orderSn}},
  ];
  for (const jc of JOB_CONFIGS) {
    for (const v of [3,4]) {
      const ename=`lbl-job-v${v}-${jc.create.split('?')[0].replace(/\//g,'-').slice(0,25)}`;
      if(!open(ename)) continue;
      try {
        const cr=await proxyReq({url:`${SB}/api/v${v}/${jc.create}`,method:'POST',headers:hdrs},JSON.stringify(jc.body));
        const jobId=cr.data?.data?.job_id||cr.data?.job_id;
        if(jobId){
          for(let poll=0;poll<6;poll++){
            await new Promise(r=>setTimeout(r,1500));
            const sr=await proxyReq({url:`${SB}/api/v${v}/${jc.status}&job_id=${jobId}`,method:'GET',headers:hdrs});
            const fileUrl=sr.data?.data?.file_list?.[0]?.url||sr.data?.data?.pdf_url||sr.data?.data?.url;
            if(fileUrl){
              const pr=await proxyReqBinary({url:fileUrl,method:'GET',headers:{'User-Agent':hdrs['user-agent']}});
              if(pr.isPdf&&pr.bytes?.length>1000){win(ename);return{ok:true,pdf_base64:pr.bytes.toString('base64'),method:ename,job_id:jobId};}
            }
          }
        }
        fail(ename);
      } catch(e){fail(ename);}
    }
  }

  // HTML FALLBACK
  try {
    const r=await proxyReq({url:`${SB}/awbprint?order_sn=${encodeURIComponent(orderSn)}&first_time=1&lang=pt-br`,method:'GET',headers:hdrs});
    if(r.raw?.includes('<html'))return{ok:true,html:r.raw,method:'lbl-html-fallback'};
  } catch(e){}

  return { ok:false, error:'Todos os label endpoints falharam' };
}


// ── VARIAÇÕES DE PARÂMETROS (multiplica cobertura 3x) ────────
// Gera variações de sort/filter/pagesize para cada endpoint base
function getParamVariants(baseUrl, isSeller) {
  const variants = [baseUrl]; // sempre inclui o original

  if (isSeller) {
    // Variações de page_size para endpoints de listagem
    if (baseUrl.includes('list') || baseUrl.includes('search')) {
      variants.push(baseUrl.replace(/page_size=\d+/, 'page_size=60'));
      variants.push(baseUrl.replace(/page_size=\d+/, 'page_size=12'));
    }
  } else {
    // Variações de limit para buyer API
    if (baseUrl.includes('limit=')) {
      variants.push(baseUrl.replace(/limit=\d+/, 'limit=60'));
      variants.push(baseUrl.replace(/limit=\d+/, 'limit=10'));
    }
    // Variações de version
    if (baseUrl.includes('version=2')) {
      variants.push(baseUrl.replace('version=2', 'version=1'));
    }
  }
  return [...new Set(variants)]; // deduplica
}


// ════════════════════════════════════════════════════════════
// 🤖 NÍVEL 2+3 — HEADLESS BROWSER + FINGERPRINT MÁXIMO
// Bright Data Scraping Browser via CDP WebSocket
// Fingerprint: Canvas, WebGL, Timezone, Resolution, Mouse, Audio
// ════════════════════════════════════════════════════════════
const WebSocket = require('ws');

// ── FINGERPRINT PROFILES ─────────────────────────────────────
// Perfis reais de dispositivos brasileiros
const FP_PROFILES = [
  { width:1920, height:1080, dpr:1, platform:'Win32',   tz:'America/Sao_Paulo',  gl:'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0)',   renderer:'Intel(R) UHD Graphics 620', cores:4,  mem:8  },
  { width:1366, height:768,  dpr:1, platform:'Win32',   tz:'America/Sao_Paulo',  gl:'ANGLE (Intel, Intel(R) HD Graphics 520 Direct3D11 vs_5_0 ps_5_0)',    renderer:'Intel(R) HD Graphics 520',  cores:4,  mem:4  },
  { width:1440, height:900,  dpr:2, platform:'MacIntel', tz:'America/Sao_Paulo', gl:'ANGLE (Apple, Apple M1, OpenGL 4.1)',                                  renderer:'Apple M1',                  cores:8,  mem:8  },
  { width:1920, height:1080, dpr:1, platform:'Win32',   tz:'America/Recife',     gl:'ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 Direct3D11 vs_5_0 ps_5_0)',     renderer:'NVIDIA GeForce GTX 1050',   cores:8,  mem:16 },
  { width:1280, height:800,  dpr:1, platform:'Win32',   tz:'America/Fortaleza',  gl:'ANGLE (AMD, Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0)',           renderer:'Radeon RX 580',             cores:6,  mem:8  },
  { width:2560, height:1440, dpr:1, platform:'Win32',   tz:'America/Manaus',     gl:'ANGLE (Intel, Intel(R) Iris Xe Graphics Direct3D11 vs_5_0 ps_5_0)',    renderer:'Intel(R) Iris Xe Graphics', cores:12, mem:16 },
];

const rndFP = () => FP_PROFILES[Math.floor(Math.random() * FP_PROFILES.length)];

// ── CDP HELPER ────────────────────────────────────────────────
class CDPBrowser {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map(); // key = "sessionId:msgId" or ":msgId"
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (!msg.id) return;
        const key = `${msg.sessionId||''}:${msg.id}`;
        if (this.pending.has(key)) {
          const { resolve, reject } = this.pending.get(key);
          this.pending.delete(key);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch(e) {}
    });
    ws.on('error', (e) => {
      for (const [, {reject}] of this.pending) reject(e);
      this.pending.clear();
    });
  }

  // Envia comando no nível browser (sem sessionId)
  send(method, params={}) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      const key = `:${id}`;
      this.pending.set(key, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(key)) { this.pending.delete(key); reject(new Error(`CDP timeout: ${method}`)); }
      }, 20000);
    });
  }

  // Cria sessão flat para um target
  session(sessionId) {
    const browser = this;
    return {
      send(method, params={}) {
        return new Promise((resolve, reject) => {
          const id = browser.id++;
          const key = `${sessionId}:${id}`;
          browser.pending.set(key, { resolve, reject });
          browser.ws.send(JSON.stringify({ id, method, params, sessionId }));
          setTimeout(() => {
            if (browser.pending.has(key)) { browser.pending.delete(key); reject(new Error(`CDP timeout: ${method}`)); }
          }, 20000);
        });
      },
      close() { try { browser.ws.close(); } catch(e) {} }
    };
  }

  close() { try { this.ws.close(); } catch(e) {} }
}
// Alias para compatibilidade
const CDPSession = CDPBrowser;

// ── NÍVEL 3: injeta fingerprint completo na página ────────────
async function injectFingerprint(cdp, fp) {
  const script = `
    (() => {
      // ── Canvas fingerprint ──
      const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
      const noise = ${Math.random().toFixed(8)};
      HTMLCanvasElement.prototype.toDataURL = function(...args) {
        const ctx = this.getContext('2d');
        if (ctx) {
          const idata = origGetImageData.call(ctx, 0, 0, this.width, this.height);
          for (let i = 0; i < idata.data.length; i += 4) {
            idata.data[i]     = Math.max(0, Math.min(255, idata.data[i]     + (Math.random() * noise * 4 - noise * 2)));
            idata.data[i + 1] = Math.max(0, Math.min(255, idata.data[i + 1] + (Math.random() * noise * 4 - noise * 2)));
            idata.data[i + 2] = Math.max(0, Math.min(255, idata.data[i + 2] + (Math.random() * noise * 4 - noise * 2)));
          }
          ctx.putImageData(idata, 0, 0);
        }
        return origToDataURL.apply(this, args);
      };

      // ── WebGL fingerprint ──
      const getParam = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(param) {
        if (param === 37445) return '${fp.gl}';
        if (param === 37446) return '${fp.renderer}';
        return getParam.call(this, param);
      };
      if (typeof WebGL2RenderingContext !== 'undefined') {
        const getParam2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function(param) {
          if (param === 37445) return '${fp.gl}';
          if (param === 37446) return '${fp.renderer}';
          return getParam2.call(this, param);
        };
      }

      // ── AudioContext fingerprint ──
      const origCreateOsc = AudioContext.prototype.createOscillator;
      AudioContext.prototype.createOscillator = function() {
        const osc = origCreateOsc.apply(this, arguments);
        const origStart = osc.start.bind(osc);
        osc.start = function(t) {
          return origStart(t + (Math.random() - 0.5) * 0.0001);
        };
        return osc;
      };

      // ── Screen + window ──
      Object.defineProperty(screen, 'width',       { get: () => ${fp.width}  });
      Object.defineProperty(screen, 'height',      { get: () => ${fp.height} });
      Object.defineProperty(screen, 'availWidth',  { get: () => ${fp.width}  });
      Object.defineProperty(screen, 'availHeight', { get: () => ${fp.height} - 40 });
      Object.defineProperty(window, 'devicePixelRatio', { get: () => ${fp.dpr} });
      Object.defineProperty(navigator, 'platform',      { get: () => '${fp.platform}' });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${fp.cores} });
      Object.defineProperty(navigator, 'deviceMemory',  { get: () => ${fp.mem} });

      // ── Timezone ──
      const origDateTimeFormat = Intl.DateTimeFormat;
      window.Intl.DateTimeFormat = function(...args) {
        if (!args[1]) args[1] = {};
        if (!args[1].timeZone) args[1].timeZone = '${fp.tz}';
        return new origDateTimeFormat(...args);
      };
      Object.assign(window.Intl.DateTimeFormat, origDateTimeFormat);

      // ── Permissions API ──
      if (navigator.permissions) {
        const origQuery = navigator.permissions.query.bind(navigator.permissions);
        navigator.permissions.query = (params) => {
          if (['notifications','geolocation','camera','microphone'].includes(params.name)) {
            return Promise.resolve({ state: 'prompt', onchange: null });
          }
          return origQuery(params);
        };
      }

      // ── Plugins (lista realista) ──
      Object.defineProperty(navigator, 'plugins', { get: () => ({
        length: 3,
        0: { name: 'PDF Viewer',            description: 'Portable Document Format',  filename: 'internal-pdf-viewer'    },
        1: { name: 'Chrome PDF Viewer',     description: 'Portable Document Format',  filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
        2: { name: 'Chromium PDF Viewer',   description: 'Portable Document Format',  filename: 'internal-pdf-viewer'    },
      })});

      // ── WebRTC protection — bloqueia IP leak ──
      if (window.RTCPeerConnection) {
        const origRTC = window.RTCPeerConnection;
        window.RTCPeerConnection = function(config, ...rest) {
          if (config && config.iceServers) config.iceServers = [];
          return new origRTC(config, ...rest);
        };
        Object.assign(window.RTCPeerConnection, origRTC);
      }

      // ── Headless detection patches ──
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR','pt','en-US','en'] });
      window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}), app: { isInstalled: false } };
      Object.defineProperty(document, 'hidden',           { get: () => false });
      Object.defineProperty(document, 'visibilityState',  { get: () => 'visible' });
    })();
  `;

  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: script });
}

// ── MOUSE MOVEMENT SIMULATION (Nível 3) ──────────────────────
// Bezier curve human-like mouse trajectory
async function simulateHumanInteraction(cdp, fp) {
  // Simula scrolling natural
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: Math.round(fp.width * 0.3 + Math.random() * 100), y: Math.round(fp.height * 0.2 + Math.random() * 50),
    modifiers: 0, buttons: 0
  });
  await new Promise(r => setTimeout(r, 80 + Math.random() * 120));

  // Move para centro da página (padrão humano)
  const steps = 8 + Math.floor(Math.random() * 6);
  const startX = Math.round(fp.width * 0.3), startY = Math.round(fp.height * 0.2);
  const endX   = Math.round(fp.width * 0.5 + (Math.random() - 0.5) * 200);
  const endY   = Math.round(fp.height * 0.5 + (Math.random() - 0.5) * 100);

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Bezier quadrático pra simular curva natural do mouse
    const cx = startX + (endX - startX) * 0.5 + (Math.random() - 0.5) * 80;
    const cy = startY + (endY - startY) * 0.1 - 60 + Math.random() * 30;
    const x  = Math.round((1-t)*(1-t)*startX + 2*(1-t)*t*cx + t*t*endX);
    const y  = Math.round((1-t)*(1-t)*startY + 2*(1-t)*t*cy + t*t*endY);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: 0, buttons: 0 });
    await new Promise(r => setTimeout(r, 12 + Math.random() * 25));
  }

  // Scroll natural
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: endX, y: endY,
    deltaX: 0, deltaY: 80 + Math.random() * 120
  });
  await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
}

// ── COOKIE HELPERS ────────────────────────────────────────────
function parseCookies(cookieStr) {
  const jar = {};
  if (!cookieStr) return jar;
  cookieStr.split(';').forEach(c => {
    const i = c.indexOf('=');
    if (i < 0) return;
    const k = c.slice(0, i).trim();
    const v = c.slice(i + 1).trim();
    if (k) jar[k] = v;
  });
  return jar;
}

function cookiesToHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

function mergeCookiesObj(existing, newCookies) {
  const jar = parseCookies(existing);
  if (Array.isArray(newCookies)) {
    newCookies.forEach(c => {
      const kv = c.split(';')[0].trim();
      const i = kv.indexOf('=');
      if (i < 0) return;
      const k = kv.slice(0, i).trim();
      const v = kv.slice(i + 1).trim();
      if (k && !['Path','Domain','Max-Age','Expires','HttpOnly','Secure','SameSite'].includes(k)) jar[k] = v;
    });
  }
  return cookiesToHeader(jar);
}

function getCookieVal(cookieStr, name) {
  const m = (cookieStr || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}

// ── CORE: Browser refresh via Bright Data ────────────────────
async function refreshWithBrowser(cookies, feSession) {
  const bdWss = BD_WSS;
  if (!bdWss) throw new Error('BD_WSS nao configurado');

  const fp = rndFP();
  console.log(`[browser] iniciando | fp=${fp.width}x${fp.height} tz=${fp.tz}`);

  const ws = new WebSocket(bdWss, { handshakeTimeout: 20000 });

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), 20000);
  });

  const cdp = new CDPBrowser(ws);
  console.log('[browser] CDP browser conectado ao Bright Data');

  // ── Cria/obtém target e sessão flat ──────────────────────────
  let sessionCdp = cdp; // fallback
  try {
    // Obtém targets existentes
    const { targetInfos } = await cdp.send('Target.getTargets', {}).catch(() => ({ targetInfos: [] }));
    console.log(`[browser] targets: ${(targetInfos||[]).length}`);

    let targetId;
    const page = (targetInfos||[]).find(t => t.type === 'page' || t.type === 'other');
    if (page) {
      targetId = page.targetId;
      console.log('[browser] target existente:', targetId.slice(0,8));
    } else {
      const { targetId: newId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      targetId = newId;
      console.log('[browser] novo target:', targetId.slice(0,8));
    }

    // Attach com flatten=true para sessão CDP no target
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    sessionCdp = cdp.session(sessionId);
    console.log('[browser] sessão flat criada:', sessionId.slice(0,8));
  } catch(e) {
    console.log('[browser] target setup:', e.message.slice(0,60), '— usando browser session');
  }

  try {
    // ── Habilita domains que BD suporta ──────────────────────
    await sessionCdp.send('Network.enable', {}).catch(e => console.log('[browser] Network.enable:', e.message));
    await sessionCdp.send('Page.enable', {}).catch(e => console.log('[browser] Page.enable:', e.message));

    // ── Seta cookies da sessão do seller ─────────────────────
    const jar = parseCookies(cookies);
    let cookiesSet = 0;
    for (const [name, value] of Object.entries(jar)) {
      try {
        await sessionCdp.send('Network.setCookie', {
          name, value,
          domain: '.shopee.com.br',
          path: '/',
          secure: true,
          httpOnly: false,
        });
        cookiesSet++;
      } catch(e) {}
    }
    console.log(`[browser] ${cookiesSet} cookies setados`);

    // ── Navega para Seller Center ─────────────────────────────
    await sessionCdp.send('Page.navigate', { url: 'https://seller.shopee.com.br/portal/product/list/all' });

    // Aguarda carregamento
    await new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => { done = true; resolve(); }, 15000);
      cdp.ws.on('message', (data) => {
        if (done) return;
        try {
          const msg = JSON.parse(data.toString());
          if (msg.method === 'Page.loadEventFired' || msg.method === 'Page.domContentEventFired') {
            clearTimeout(timer); done = true; resolve();
          }
        } catch(e) {}
      });
    });
    console.log('[browser] página carregada');

    // ── Nível 3: Fingerprint via Runtime.evaluate (funciona no BD) ──
    try {
      const fpScript = `
        (function() {
          // Canvas noise
          const _toDataURL = HTMLCanvasElement.prototype.toDataURL;
          HTMLCanvasElement.prototype.toDataURL = function(...a) {
            const ctx = this.getContext('2d');
            if (ctx) { const id = ctx.getImageData(0,0,1,1); id.data[0] = (id.data[0] + 1) % 256; ctx.putImageData(id,0,0); }
            return _toDataURL.apply(this, a);
          };
          // WebGL
          const _gp = WebGLRenderingContext.prototype.getParameter;
          WebGLRenderingContext.prototype.getParameter = function(p) {
            if (p === 37445) return '${fp.gl}';
            if (p === 37446) return '${fp.renderer}';
            return _gp.call(this, p);
          };
          // Headless patches
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          window.chrome = window.chrome || { runtime: {} };
          Object.defineProperty(document, 'hidden', { get: () => false });
          Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
          // WebRTC
          if (window.RTCPeerConnection) {
            const _RTC = window.RTCPeerConnection;
            window.RTCPeerConnection = function(c, ...r) { if(c) c.iceServers=[]; return new _RTC(c,...r); };
            Object.assign(window.RTCPeerConnection, _RTC);
          }
        })();
      `;
      await sessionCdp.send('Runtime.evaluate', { expression: fpScript, returnByValue: false });
      console.log('[browser] fingerprint L3 injetado via Runtime');
    } catch(e) {
      console.log('[browser] Runtime.evaluate fingerprint:', e.message.slice(0,50));
    }

    // ── Simula scroll humano via Runtime ─────────────────────
    try {
      await sessionCdp.send('Runtime.evaluate', { expression: 'window.scrollTo(0, Math.random()*200)', returnByValue: false });
      await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));
      await sessionCdp.send('Runtime.evaluate', { expression: 'window.scrollTo(0, Math.random()*400)', returnByValue: false });
    } catch(e) {}

    // ── Aguarda requests de background ───────────────────────
    await new Promise(r => setTimeout(r, 2500 + Math.random() * 1500));

    // ── Captura cookies atualizados ───────────────────────────
    const { cookies: newCdpCookies } = await sessionCdp.send('Network.getAllCookies', {});
    const shopeeNewCookies = (newCdpCookies || [])
      .filter(c => c.domain && (c.domain.includes('shopee.com.br') || c.domain.includes('.shopee')))
      .map(c => `${c.name}=${c.value}`);

    console.log(`[browser] ${shopeeNewCookies.length} cookies Shopee capturados`);

    if (shopeeNewCookies.length === 0) {
      cdp.close();
      throw new Error('Nenhum cookie Shopee capturado — sessão pode ter expirado');
    }

    const mergedCookies = mergeCookiesObj(cookies, shopeeNewCookies);

    // ── Valida sessão (REAL: exige SPC_ST nos cookies + nome da loja da API) ──
    let sessionOk = false;
    let validationDetail = 'nao_validado';
    const hasSpcSt = /SPC_ST=[^;]{20,}/.test(mergedCookies);
    const hasSpcU = /SPC_U=\d/.test(mergedCookies);
    try {
      const spcCds = getCookieVal(mergedCookies, 'SPC_CDS');
      const result = await sessionCdp.send('Runtime.evaluate', {
        expression: `fetch('https://seller.shopee.com.br/api/v1/account/basic_info/?SPC_CDS=${encodeURIComponent(spcCds)}&SPC_CDS_VER=2',{credentials:'include'}).then(r=>r.json()).then(d=>JSON.stringify({code:d.code,errcode:d.errcode,name:d.data&&d.data.shop_name,user_id:d.data&&d.data.user_id})).catch(e=>JSON.stringify({error:e.message}))`,
        awaitPromise: true, timeout: 10000,
      });
      const apiResult = JSON.parse(result.result?.value || '{}');
      // SÓ É VÁLIDO SE: (a) cookies têm SPC_ST autenticado, (b) API retornou shop_name
      if (apiResult.errcode === 2 || apiResult.code === 2) {
        sessionOk = false;
        validationDetail = 'errcode_2';
      } else if (apiResult.name && hasSpcSt && hasSpcU) {
        sessionOk = true;
        validationDetail = 'loja_' + String(apiResult.name).slice(0,30);
        console.log(`[browser] ✅ sessão VÁLIDA — loja: ${apiResult.name}`);
      } else if (!apiResult.name && !hasSpcSt) {
        sessionOk = false;
        validationDetail = 'sem_nome_e_sem_SPC_ST';
      } else if (!hasSpcSt) {
        sessionOk = false;
        validationDetail = 'sem_SPC_ST';
      } else {
        sessionOk = false;
        validationDetail = 'api_sem_nome';
      }
    } catch(e) {
      // Se validação deu erro: só aceita se PELO MENOS tem SPC_ST autenticado
      sessionOk = hasSpcSt && hasSpcU;
      validationDetail = 'val_erro:' + (e.message || '').slice(0,30);
      console.log('[browser] validação erro:', e.message.slice(0,60), '| sessionOk=' + sessionOk);
    }

    sessionCdp.close();
    return {
      ok: sessionOk,
      expired: !sessionOk,
      method: 'browser_l2l3',
      cookies: mergedCookies,
      cookies_count: shopeeNewCookies.length,
      fingerprint: `${fp.width}x${fp.height} ${fp.tz}`,
      validation: validationDetail,
      has_spc_st: hasSpcSt,
      error: sessionOk ? undefined : 'Sessão expirada — ' + validationDetail,
    };

  } catch(e) {
    sessionCdp.close();
    throw e;
  }
}

// ── COOKIE REFRESH: L2/L3 → L1 → fallback ────────────────────
function getCookie(str, name) {
  const m = (str || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}

function mergeCookies(existing, setCookieHeaders) {
  const jar = {};
  (existing || '').split(';').forEach(c => {
    const i = c.indexOf('='); if (i < 0) return;
    const k = c.slice(0, i).trim(), v = c.slice(i+1).trim();
    if (k) jar[k] = v;
  });
  (setCookieHeaders || []).forEach(sc => {
    const kv = sc.split(';')[0].trim(); const i = kv.indexOf('='); if (i < 0) return;
    const k = kv.slice(0,i).trim(), v = kv.slice(i+1).trim();
    if (k && !['Path','Domain','Max-Age','Expires','HttpOnly','Secure','SameSite'].includes(k)) jar[k] = v;
  });
  return Object.entries(jar).map(([k,v]) => `${k}=${v}`).join('; ');
}

async function refreshCookies(cookies, feSession) {
  const errors = [];

  const spcRTId = getCookie(cookies, 'SPC_R_T_ID');
  const spcRTIv = getCookie(cookies, 'SPC_R_T_IV');
  const csrftoken = getCookie(cookies, 'csrftoken');
  const spcCds = getCookie(cookies, 'SPC_CDS');

  // ── NÍVEL 1: Refresh Token API (MAIS RÁPIDO E OFICIAL) ───────
  // SPC_R_T_ID + SPC_R_T_IV duram semanas e renovam SPC_ST automaticamente
  if (spcRTId && spcRTIv) {
    console.log('[refresh] Tentando Nível 1 (refresh token via proxy)...');
    // Lista ampliada de endpoints de refresh (Shopee muda periodicamente)
    const refreshEndpoints = [
      'https://seller.shopee.com.br/api/v4/account/token/refresh',
      'https://seller.shopee.com.br/api/v3/account/token/refresh',
      'https://seller.shopee.com.br/api/v2/account/token/refresh',
      'https://seller.shopee.com.br/api/v1/account/token/refresh',
      'https://seller.shopee.com.br/api/cnsc/account/v1/token/refresh',
    ];
    for (const url of refreshEndpoints) {
      try {
        const hdrs = H(cookies, feSession, {
          'Content-Type': 'application/json;charset=UTF-8',
          'x-csrftoken': csrftoken,
          'sc-fe-ver': '21.143762',
        });
        const r = await proxyReq({ url, method: 'POST', headers: hdrs },
          JSON.stringify({ refresh_token: spcRTId, iv: spcRTIv }));
        const setCookies = Array.isArray(r.headers['set-cookie'])
          ? r.headers['set-cookie']
          : (r.headers['set-cookie'] ? [r.headers['set-cookie']] : []);
        if (r.status === 200 && setCookies.length > 0) {
          const newCookies = mergeCookiesSafe(cookies, setCookies);
          // Só aceita se o novo merge tem SPC_ST válido
          if (/SPC_ST=[^;]{20,}/.test(newCookies) && /SPC_U=\d/.test(newCookies)) {
            console.log(`[refresh] ✅ L1 token refresh OK | endpoint=${url.split('/').pop()} | ${setCookies.length} cookies`);
            return { ok: true, method: 'refresh_token_l1', cookies: newCookies, new_count: setCookies.length };
          }
        }
        if (r.data?.error === 'error_auth' || r.status === 401) {
          console.log('[refresh] L1 auth error — R_T pode estar invalidado');
          break;
        }
      } catch(e) { errors.push('L1-' + url.split('/').pop() + ': ' + e.message); }
    }
  }

  // ── NÍVEL 2: Requisição autenticada "normal" via proxy (força Shopee renovar via R_T) ──
  // A própria Shopee renova SPC_ST automaticamente se SPC_R_T_ID/IV forem válidos
  if (spcCds && spcRTId) {
    console.log('[refresh] Tentando Nível 2 (trigger re-auth via basic_info)...');
    try {
      const hdrs = H(cookies, feSession, { 'sc-fe-ver': '21.143762' });
      const r = await proxyReq({ url: `https://seller.shopee.com.br/api/v1/account/basic_info/?SPC_CDS=${spcCds}&SPC_CDS_VER=2`, method: 'GET', headers: hdrs });
      const setCookies = Array.isArray(r.headers['set-cookie'])
        ? r.headers['set-cookie']
        : (r.headers['set-cookie'] ? [r.headers['set-cookie']] : []);
      const expired = r.data?.errcode === 2 || r.data?.code === 2 || r.status === 401;
      if (!expired && setCookies.length > 0) {
        const newCookies = mergeCookiesSafe(cookies, setCookies);
        if (/SPC_ST=[^;]{20,}/.test(newCookies)) {
          console.log(`[refresh] ✅ L2 re-auth OK | loja=${r.data?.data?.shop_name || '?'} | ${setCookies.length} cookies novos`);
          return { ok: true, method: 'reauth_basic_info_l2', cookies: newCookies, new_count: setCookies.length, shop_name: r.data?.data?.shop_name };
        }
      }
      if (expired) {
        console.log('[refresh] ❌ sessão expirada (L2)');
        return { ok: false, expired: true, error: 'Sessão expirada — reconecte via extensão Chrome' };
      }
    } catch(e) { errors.push('L2: ' + e.message); }
  }

  // ── NÍVEL 3: Browser real BD (fallback quando proxy HTTP falha) ──
  if (BD_WSS) {
    try {
      console.log('[refresh] tentando Nível 3 (browser real BD)...');
      const r = await refreshWithBrowser(cookies, feSession);
      if (r.ok) {
        console.log(`[refresh] ✅ L3 browser OK | ${r.cookies_count} cookies | val=${r.validation}`);
        return r;
      }
      if (r.expired) return r;
      errors.push('L3-browser: ' + (r.error || 'falhou'));
    } catch(e) {
      errors.push('L3-browser: ' + e.message);
      console.log('[refresh] L3 erro:', e.message);
    }
  }

  return { ok: false, error: 'Todos os níveis falharam: ' + errors.join(' | ') };
}

// Merge seguro de cookies: ignora valores vazios e tokens de formato inválido
function mergeCookiesSafe(existing, setCookieHeaders) {
  const jar = {};
  (existing || '').split(';').forEach(c => {
    const i = c.indexOf('='); if (i < 0) return;
    const k = c.slice(0, i).trim(), v = c.slice(i+1).trim();
    if (k && v) jar[k] = v;
  });
  const incoming = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  incoming.forEach(sc => {
    const kv = String(sc).split(';')[0].trim();
    const i = kv.indexOf('='); if (i < 0) return;
    const k = kv.slice(0,i).trim(), v = kv.slice(i+1).trim();
    // CRITICAL: não sobrescreve token válido com valor vazio/curto
    if (!k || ['Path','Domain','Max-Age','Expires','HttpOnly','Secure','SameSite','path','domain','max-age','expires','httponly','secure','samesite'].includes(k)) return;
    if (!v || v === '""' || v.length < 2) return; // ignora vazios
    // Pra tokens críticos, só aceita se novo é "válido" (mais longo que placeholder)
    if (['SPC_ST','SPC_U','SPC_R_T_ID'].includes(k) && v.length < 10) return;
    jar[k] = v;
  });
  return Object.entries(jar).map(([k,v]) => `${k}=${v}`).join('; ');
}



// ── SEARCH VIA BROWSER CDP (fallback quando proxy HTTP falha) ─────────────
async function searchViaBrowser(shopid, limit, offset, cookies) {
  const ws = new WebSocket(BD_WSS, { handshakeTimeout: 20000 });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    setTimeout(() => reject(new Error('WS timeout')), 20000);
  });

  const cdp = new CDPBrowser(ws);
  try {

    // Injeta cookies da Shopee
    if (cookies) {
      const cookiePairs = cookies.split(';').map(c => c.trim()).filter(Boolean);
      const cookieList = cookiePairs.map(cp => {
        const eq = cp.indexOf('=');
        return { name: cp.slice(0,eq).trim(), value: cp.slice(eq+1).trim(), domain: '.shopee.com.br', path: '/' };
      }).filter(c => c.name && c.value);
      if (cookieList.length > 0) await s.send('Network.setCookies', { cookies: cookieList }).catch(()=>{});
    }

    // Cria target JÁ no domínio shopee.com.br — fetch funciona sem CORS
    // Não precisa carregar a página completamente
    const newTarget = await cdp.send('Target.createTarget', {
      url: 'https://shopee.com.br/',
      newWindow: false,
      background: true,
    });
    const newTargetId = newTarget.targetId;
    const { sessionId: sid2 } = await cdp.send('Target.attachToTarget', { targetId: newTargetId, flatten: true });
    const s = cdp.session(sid2);

    await s.send('Network.enable', {}).catch(()=>{});

    // Injeta cookies
    if (cookies) {
      const cookiePairs = cookies.split(';').map(c => c.trim()).filter(Boolean);
      const cookieList = cookiePairs.map(cp => {
        const eq = cp.indexOf('=');
        return { name: cp.slice(0,eq).trim(), value: cp.slice(eq+1).trim(), domain: '.shopee.com.br', path: '/' };
      }).filter(c => c.name && c.value);
      if (cookieList.length > 0) await s.send('Network.setCookies', { cookies: cookieList }).catch(()=>{});
    }

    // Aguarda só 1s pra o JS context inicializar (não precisa do page load completo)
    await new Promise(r => setTimeout(r, 1000));

    const searchUrls = [
      `https://shopee.com.br/api/v4/search/search_items?by=pop&limit=${limit}&newest=${offset}&order=desc&page_type=shop&scenario=PAGE_OTHERS&shopid=${shopid}&version=2`,
      `https://shopee.com.br/api/v4/recommend/recommend?bundle=shop_page_product_tab_main&limit=${limit}&offset=${offset}&shopid=${shopid}&sort_type=1`,
      `https://shopee.com.br/api/v4/shop/get_shop_all_item_list?need_filter_bar=true&offset=${offset}&limit=${limit}&shopid=${shopid}&filter_id=0&sort_by=pop`,
    ];

    for (const searchUrl of searchUrls) {
      try {
        const result = await s.send('Runtime.evaluate', {
          expression: `(async()=>{const r=await fetch(${JSON.stringify(searchUrl)},{credentials:'include',headers:{'Accept':'application/json','x-api-source':'pc','Referer':'https://shopee.com.br/'}});const d=await r.json();return JSON.stringify(d);})()`,
          awaitPromise: true,
          timeout: 15000,
        });
        const data = JSON.parse(result.result?.value || '{}');
        let items = data.items || [];
        if (!items.length) { const sec = data?.data?.sections?.[0]?.data; if (sec?.item?.length) items = sec.item; }
        if (!items.length) { const dd = data?.data||{}; items = dd.items||dd.item_list||dd.item||[]; }
        if (items.length > 0) { cdp.close(); return items; }
      } catch(e) {}
    }
    cdp.close();
    return [];
  } catch(e) { cdp.close(); throw e; }
}


// ══════════════════════════════════════════════════════════════════════════
// buyerActionViaBrowser — Faz POST/GET autenticado em endpoint Shopee API
// usando Browser CDP (browser real via Bright Data Scraping Browser).
// Bypassa anti-bot, captcha simples e validações de origin.
// Usado por /buyer-cart-add, /buyer-checkout, /buyer-cart-get.
// ══════════════════════════════════════════════════════════════════════════
// Descoberta de warranty_time válidos via Scraping Browser (Chrome real)
// Navega pra /portal/product/new, espera renderizar, intercepta requests + extrai dropdown
async function discoverWarrantyOptionsViaBrowser(cookies, categoryId = 100006) {
  if (!BD_WSS) throw new Error('BD_WSS nao configurado');
  const ws = new WebSocket(BD_WSS, { handshakeTimeout: 30000 });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    setTimeout(() => reject(new Error('WS timeout')), 30000);
  });
  const cdp = new CDPBrowser(ws);
  try {
    const newTarget = await cdp.send('Target.createTarget', {
      url: 'about:blank',
      newWindow: false,
      background: true,
    });
    const targetId = newTarget.targetId;
    const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const s = cdp.session(sid);
    await s.send('Network.enable', {}).catch(()=>{});
    await s.send('Page.enable', {}).catch(()=>{});
    await s.send('Runtime.enable', {}).catch(()=>{});

    // Setar cookies seller.shopee.com.br
    if (cookies) {
      const cookiePairs = cookies.split(';').map(c => c.trim()).filter(Boolean);
      const cookieList = cookiePairs.flatMap(cp => {
        const eq = cp.indexOf('=');
        if (eq < 0) return [];
        const name = cp.slice(0,eq).trim();
        const value = cp.slice(eq+1).trim();
        if (!name || !value) return [];
        return [
          { name, value, domain: '.shopee.com.br', path: '/' },
          { name, value, domain: 'seller.shopee.com.br', path: '/' },
        ];
      });
      if (cookieList.length > 0) await s.send('Network.setCookies', { cookies: cookieList }).catch(()=>{});
    }

    // Capturar TODAS as XHR requests da Shopee durante o render
    const capturedRequests = [];
    const capturedResponses = {};
    cdp.on('event', ev => {
      if (ev.method === 'Network.requestWillBeSent') {
        const req = ev.params.request;
        if (req.url.includes('seller.shopee.com.br/api/')) {
          capturedRequests.push({
            id: ev.params.requestId,
            url: req.url,
            method: req.method,
            postData: req.postData,
          });
        }
      }
      if (ev.method === 'Network.responseReceived') {
        const r = ev.params.response;
        if (r.url.includes('seller.shopee.com.br/api/')) {
          capturedResponses[ev.params.requestId] = { status: r.status, url: r.url };
        }
      }
    });

    // Navega pra página de criar produto
    const navUrl = `https://seller.shopee.com.br/portal/product/new/0/${categoryId}`;
    await s.send('Page.navigate', { url: navUrl }).catch(()=>{});

    // Espera 12s pra a SPA renderizar (Vue3 + Webpack chunks lazy)
    await new Promise(r => setTimeout(r, 12000));

    // Tenta extrair informações do form/state Vue:
    // 1. Procurar select/dropdown de "Garantia" (warranty)  
    // 2. Inspecionar window.__INITIAL_STATE__ ou variáveis globais
    // 3. Buscar respostas XHR já capturadas
    const expression = `(async()=>{
      const out = { url: location.href, title: document.title };
      // 1. Procurar dropdowns/selects que contenham "warranty" ou "garantia"
      const selects = Array.from(document.querySelectorAll('select, [role="listbox"], [role="combobox"]'));
      out.selects = selects.map(s=>({
        text: (s.outerHTML||'').slice(0,300),
        options: Array.from(s.querySelectorAll('option,[role="option"]')).map(o=>({val:o.value,txt:o.textContent}))
      })).filter(x=>x.text.toLowerCase().includes('warrant')||x.text.toLowerCase().includes('garan'));
      // 2. Pegar window.__APP_DATA__, __INITIAL_STATE__ etc
      try { out.appData = window.__APP_DATA__ ? JSON.stringify(window.__APP_DATA__).slice(0,5000) : null; } catch(e){}
      try { out.initState = window.__INITIAL_STATE__ ? JSON.stringify(window.__INITIAL_STATE__).slice(0,5000) : null; } catch(e){}
      // 3. Procurar texto warranty no body
      const bodyText = (document.body?.innerText||'').slice(0,2000);
      out.bodyHasWarranty = bodyText.toLowerCase().includes('garan') || bodyText.toLowerCase().includes('warrant');
      out.bodyPreview = bodyText.slice(0,500);
      // 4. Procurar todos os JSONs da página (data attributes, scripts inline)
      const scripts = Array.from(document.querySelectorAll('script:not([src])'));
      out.inlineScripts = scripts.map(s=>{
        const txt = s.textContent||'';
        if (txt.includes('warranty') || txt.includes('Warranty') || txt.includes('garantia')) {
          return txt.slice(0, 5000);
        }
        return null;
      }).filter(Boolean);
      return JSON.stringify(out);
    })()`;

    const result = await s.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      timeout: 30000,
      returnByValue: true,
    });

    let pageData = {};
    try { pageData = JSON.parse(result.result?.value || '{}'); } catch(e) {}

    cdp.close();

    return {
      ok: true,
      page: pageData,
      capturedRequests: capturedRequests.slice(0, 50),
      capturedResponses,
    };
  } catch(e) {
    try { cdp.close(); } catch(_) {}
    throw e;
  }
}


async function buyerActionViaBrowser(cookies, apiUrl, requestBody, method = 'POST') {
  if (!BD_WSS) throw new Error('BD_WSS nao configurado');
  // Extrai csrftoken do cookies string ANTES de mandar pro browser
  const csrfMatch = (cookies||'').match(/csrftoken=([^;]+)/);
  const csrftoken = csrfMatch ? csrfMatch[1].trim() : '';
  const ws = new WebSocket(BD_WSS, { handshakeTimeout: 20000 });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    setTimeout(() => reject(new Error('WS timeout')), 20000);
  });
  const cdp = new CDPBrowser(ws);
  try {
    const newTarget = await cdp.send('Target.createTarget', {
      url: 'about:blank',
      newWindow: false,
      background: true,
    });
    const newTargetId = newTarget.targetId;
    const { sessionId: sid2 } = await cdp.send('Target.attachToTarget', { targetId: newTargetId, flatten: true });
    const s = cdp.session(sid2);
    await s.send('Network.enable', {}).catch(()=>{});
    await s.send('Page.enable', {}).catch(()=>{});

    if (cookies) {
      const cookiePairs = cookies.split(';').map(c => c.trim()).filter(Boolean);
      const cookieList = cookiePairs.map(cp => {
        const eq = cp.indexOf('=');
        return { name: cp.slice(0,eq).trim(), value: cp.slice(eq+1).trim(), domain: '.shopee.com.br', path: '/' };
      }).filter(c => c.name && c.value);
      if (cookieList.length > 0) await s.send('Network.setCookies', { cookies: cookieList }).catch(()=>{});
    }

    // Navega pra raiz (mais leve, não redireciona)
    await s.send('Page.navigate', { url: 'https://shopee.com.br/' }).catch(()=>{});
    await new Promise(r => setTimeout(r, 5000));

    // Headers completos como na request real do user (csrftoken pré-extraído pra evitar Access Denied)
    const fetchOpts = method === 'GET'
      ? `{credentials:'include',headers:{'Accept':'application/json','x-api-source':'pc','x-shopee-language':'pt-BR','x-requested-with':'XMLHttpRequest','Referer':'https://shopee.com.br/'}}`
      : `{method:'POST',credentials:'include',headers:{'Accept':'application/json','Content-Type':'application/json','x-api-source':'pc','x-shopee-language':'pt-BR','x-requested-with':'XMLHttpRequest','x-csrftoken':${JSON.stringify(csrftoken)},'Referer':'https://shopee.com.br/'},body:${JSON.stringify(JSON.stringify(requestBody||{}))}}`;

    const expression = `(async()=>{
      try {
        const r = await fetch(${JSON.stringify(apiUrl)}, ${fetchOpts});
        const status = r.status;
        const txt = await r.text();
        return JSON.stringify({status, body: txt.slice(0, 50000)});
      } catch(e) {
        return JSON.stringify({status: 0, body: '', error: e.message});
      }
    })()`;

    const result = await s.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      timeout: 30000,
      returnByValue: true,
    });
    cdp.close();

    if (result.exceptionDetails) {
      const exc = result.exceptionDetails;
      return { status: 0, data: null, raw: '', error: 'CDP exception: ' + (exc.exception?.description || exc.text || JSON.stringify(exc).slice(0,200)) };
    }

    const value = result.result?.value;
    if (!value) {
      return { status: 0, data: null, raw: '', error: 'CDP retornou sem value. type=' + (result.result?.type||'?') + ' subtype=' + (result.result?.subtype||'?') };
    }

    let parsed;
    try { parsed = typeof value === 'string' ? JSON.parse(value) : value; } catch(e) { parsed = { status: 0, body: '', error: 'parse value falhou: ' + e.message }; }
    let data = null;
    try { data = parsed.body ? JSON.parse(parsed.body) : null; } catch(e) {}
    return { status: parsed.status, data, raw: parsed.body, error: parsed.error };
  } catch(e) {
    try { cdp.close(); } catch(_) {}
    throw e;
  }
}


// ── RESIDENTIAL PROXY (para search pública — não bloqueia IP) ─────────────
function getResidentialProxy() {
  const user = process.env.BD_PROXY_USER || '';
  const hostport = process.env.BD_PROXY_HOST || '';
  if (!user || !hostport) return null;
  const [host, port] = hostport.split(':');
  const [username, password] = user.split(':');
  if (!host || !port || !username || !password) return null;
  return { user: username, pass: password, host, port: parseInt(port) };
}

function residentialReq(opts, body) {
  return new Promise((resolve, reject) => {
    const proxy = getResidentialProxy();
    if (!proxy) return reject(new Error('BD_PROXY_USER/BD_PROXY_HOST nao configurados'));
    const tgt = new url_mod.URL(opts.url);
    const auth = Buffer.from(`${proxy.user}:${proxy.pass}`).toString('base64');
    const connectConn = http.request({
      host: proxy.host, port: proxy.port, method: 'CONNECT',
      path: `${tgt.hostname}:443`,
      headers: {
        'Proxy-Authorization': 'Basic ' + auth,
        'Host': tgt.hostname + ':443',
        'Proxy-Connection': 'Keep-Alive',
        'User-Agent': 'Mozilla/5.0',
      },
    });
    connectConn.setTimeout(15000);
    connectConn.on('error', reject);
    connectConn.on('timeout', () => { connectConn.destroy(); reject(new Error('CONNECT timeout')); });
    connectConn.on('connect', (connectRes, sock) => {
      if (connectRes.statusCode !== 200) {
        sock.destroy();
        return reject(new Error('Proxy ' + connectRes.statusCode + ' ' + connectRes.statusMessage));
      }
      const tls = require('tls');
      const tlsSock = tls.connect({ socket: sock, servername: tgt.hostname, rejectUnauthorized: false });
      tlsSock.on('error', reject);
      tlsSock.on('secureConnect', () => {
        const reqHeaders = { ...(opts.headers||{}), 'Host': tgt.hostname, 'Connection': 'close' };
        const path = tgt.pathname + (tgt.search || '');
        let reqStr = `${opts.method||'GET'} ${path} HTTP/1.1\r\n`;
        Object.entries(reqHeaders).forEach(([k,v]) => { reqStr += `${k}: ${v}\r\n`; });
        reqStr += '\r\n';
        tlsSock.write(reqStr);
        if (body) tlsSock.write(typeof body === 'string' ? body : JSON.stringify(body));
        let rawData = Buffer.alloc(0);
        tlsSock.on('data', chunk => { rawData = Buffer.concat([rawData, chunk]); });
        tlsSock.on('end', () => {
          const rawStr = rawData.toString('utf8');
          const headerEnd = rawStr.indexOf('\r\n\r\n');
          const statusMatch = rawStr.match(/HTTP\/[\d.]+ (\d+)/);
          const status = statusMatch ? parseInt(statusMatch[1]) : 200;
          let bodyStr = headerEnd >= 0 ? rawStr.slice(headerEnd + 4) : rawStr;
          // Remove chunk sizes se chunked transfer
          try { bodyStr = bodyStr.replace(/^[0-9a-fA-F]+\r\n/gm, '').replace(/\r\n/g, ''); } catch(e) {}
          try { resolve({ status, data: JSON.parse(bodyStr), headers: {}, raw: bodyStr }); }
          catch { resolve({ status, data: {}, headers: {}, raw: bodyStr }); }
        });
        tlsSock.setTimeout(20000, () => { tlsSock.destroy(); reject(new Error('TLS timeout')); });
      });
    });
    connectConn.end();
  });
}


// ── WEB UNLOCKER API (para sites bloqueados como Shopee) ─────────────────
function getUnlockerKey() {
  return process.env.BD_UNLOCKER_KEY || '';
}

function unlockerReq(targetUrl, zone, opts2) {
  // opts2: { method, headers, body, cookies }
  return new Promise((resolve, reject) => {
    const key = getUnlockerKey();
    if (!key) return reject(new Error('BD_UNLOCKER_KEY nao configurado'));
    const o2 = opts2 || {};
    // Headers: objeto plain {name: value}
    const hdrsObj = {};
    if (o2.headers) {
      for (const [k, v] of Object.entries(o2.headers)) {
        hdrsObj[String(k).toLowerCase()] = String(v);
      }
    }
    if (o2.cookies && !hdrsObj['cookie']) {
      hdrsObj['cookie'] = String(o2.cookies);
    }
    const reqBody = {
      zone: zone || 'web_unlocker1',
      url: targetUrl,
      format: 'raw',
      method: (o2.method || 'GET').toUpperCase(),
    };
    if (o2.render_js) reqBody.render_js = true;
    if (o2.body) reqBody.body = typeof o2.body === 'string' ? o2.body : JSON.stringify(o2.body);
    if (Object.keys(hdrsObj).length) reqBody.headers = hdrsObj;
    const body = JSON.stringify(reqBody);
    const opts = {
      hostname: 'api.brightdata.com',
      port: 443,
      path: '/request',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const r = https.request(opts);
    r.setTimeout(45000);
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('Unlocker timeout')); });
    r.on('response', resp => {
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: resp.statusCode, data: JSON.parse(raw), raw }); }
        catch { resolve({ status: resp.statusCode, data: {}, raw }); }
      });
      resp.on('error', reject);
    });
    r.write(body);
    r.end();
  });
}

// Endpoint debug: chama Shopee create_product via Web Unlocker (browser real)
function unlockerProxyFor(d) {
  return unlockerReq(d.url, d.zone, {
    method: d.method,
    headers: d.headers,
    body: d.body,
    cookies: d.cookies,
  });
}

// ════════════════════════════════════════════════════════════
// 🖥️ HTTP SERVER v13 — 2500+ ENDPOINTS ELÁSTICOS
// ════════════════════════════════════════════════════════════
http.createServer(async (req, res) => {
  const p = url_mod.parse(req.url, true).pathname;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }

  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ') || auth.slice(7) !== SECRET) {
    res.writeHead(401); return res.end(JSON.stringify({ error: 'Nao autorizado' }));
  }

  if (req.method === 'GET' && p === '/health') {
    const cbList = Object.entries(breaker).map(([n,b])=>({endpoint:n,ok:b.ok,fails:b.fails,wins:b.wins||0}));
    const topEps = Object.entries(endpointMemory).sort((a,b)=>b[1].score-a[1].score).slice(0,10).map(([n,v])=>({name:n,score:v.score,uses:v.uses}));

    // Estatísticas dos endpoints gerados
    const dummySC = 'SPC_CDS=test&SPC_CDS_VER=2';
    const epStats = getStats(dummySC);

    res.writeHead(200);
    return res.end(JSON.stringify({
      ok: true, service: 'vendry-sync', version: '14.30.1-bd-br',
      proxy: getProxy() ? getProxy().host+':'+getProxy().port : 'none',
      bd_wss_user: BD_WSS ? (BD_WSS.match(/\/\/([^:]+):/)?.[1] || 'unknown') : 'not set',
      bd_wss_has_country: BD_WSS ? /-country-[a-z]{2}/.test(BD_WSS) : false,
      residential_proxy: getResidentialProxy() ? getResidentialProxy().host+':'+getResidentialProxy().port : 'not configured',
      unlocker: getUnlockerKey() ? 'configured' : 'not configured',
      endpoints_total: epStats.total,
      generated_eps: {
        seller_center: epStats.seller_center,
        buyer_api: epStats.buyer_api,
        categories: epStats.categories,
        open: epStats.open,
        blocked: epStats.blocked,
      },
      v10_sync_preserved: 50,
      ua_pool: UA_ALL.length,
      intelligence: {
        hour_score: getCurrentHourScore(),
        recent_results: recentResults.slice(-10).map(r=>r.type),
        top_endpoints: topEps,
        adaptive_delay: getAdaptiveDelay(),
      },
      circuit_breakers_total: Object.keys(breaker).length,
      circuit_breakers_sample: cbList.slice(0,20),
      last_sync: lastTime ? new Date(lastTime).toISOString() : null,
      best_endpoint: bestEp,
    }));
  }

  if (req.method === 'GET' && p === '/intelligence') {
    res.writeHead(200);
    return res.end(JSON.stringify({
      header_scores: headerScores, endpoint_memory: endpointMemory,
      time_pattern: timePattern.map((h,i)=>({hour:i,...h})),
      recent_results: recentResults.slice(-20),
    }));
  }

  if (req.method === 'GET' && p === '/endpoints') {
    res.writeHead(200);
    return res.end(JSON.stringify({
      sc_categories: Object.keys(SC_PATHS).length,
      bu_categories: Object.keys(BU_PATHS).length,
      sc_paths: Object.fromEntries(Object.entries(SC_PATHS).map(([k,v])=>[k,v.length])),
      bu_paths: Object.fromEntries(Object.entries(BU_PATHS).map(([k,v])=>[k,v.length])),
      total_estimate: (Object.values(SC_PATHS).reduce((s,v)=>s+v.length,0) + Object.values(BU_PATHS).reduce((s,v)=>s+v.length,0)) * 5 * 3,
    }));
  }

  const readBody = () => new Promise(resolve => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { resolve({}); } });
  });

  if (req.method === 'POST' && p === '/sync') {
    const d = await readBody();
    if (!d.cookies || !d.spc_cds) { res.writeHead(400); return res.end(JSON.stringify({ error: 'cookies e spc_cds obrigatorios' })); }
    try {
      const r = await sync(d.cookies, d.fe_session||'', d.spc_cds);
      res.writeHead(r.ok?200:r.expired?401:500);
      return res.end(JSON.stringify(r));
    } catch(e) { res.writeHead(500); return res.end(JSON.stringify({ error: e.message })); }
  }

  if (req.method === 'POST' && p === '/search-public') {
    const d = await readBody();
    if (!d.shopid) { res.writeHead(400); return res.end(JSON.stringify({ error: 'shopid obrigatorio' })); }
    try {
      // Estratégia 1: browser CDP (única que funciona com Shopee)
      if (BD_WSS) {
        try {
          const items = await searchViaBrowser(d.shopid, d.limit||20, d.offset||0, d.cookies||'');
          if (items && items.length > 0) {
            res.writeHead(200);
            return res.end(JSON.stringify({ ok: true, items, total: items.length, source: 'browser_cdp' }));
          }
        } catch(eBrowser) {
          console.log('[search-public] browser erro:', eBrowser.message.slice(0,80));
        }
      }
      // Estratégia 2: proxy HTTP (fallback)
      const r = await searchPublic(d.shopid, d.cookies||'', d.limit||20, d.offset||0);
      if (r.ok && r.items && r.items.length > 0) {
        res.writeHead(200);
        return res.end(JSON.stringify(r));
      }
      res.writeHead(503);
      return res.end(JSON.stringify({ ok: false, error: 'Nenhum produto encontrado', items: [] }));
    } catch(e) { res.writeHead(500); return res.end(JSON.stringify({ ok:false, error:e.message, items:[] })); }
  }

  if (req.method === 'POST' && p === '/orders') {
    const d = await readBody();
    if (!d.cookies || !d.spc_cds) { res.writeHead(400); return res.end(JSON.stringify({ error: 'cookies e spc_cds obrigatorios' })); }
    try {
      const r = await getOrders(d.cookies, d.fe_session||'', d.spc_cds);
      res.writeHead(200);
      return res.end(JSON.stringify(r));
    } catch(e) { res.writeHead(500); return res.end(JSON.stringify({ ok:false, error:e.message, orders:[] })); }
  }

  if (req.method === 'POST' && p === '/label') {
    const d = await readBody();
    if (!d.cookies || !d.order_sn) { res.writeHead(400); return res.end(JSON.stringify({ error: 'cookies e order_sn obrigatorios' })); }
    try {
      const r = await getLabel(d.cookies, d.fe_session||'', d.spc_cds||'', d.order_sn, d.package_number||'', d.channel_id||90016, d.shop_id||0, d.order_id||0);
      res.writeHead(r.ok?200:503);
      return res.end(JSON.stringify(r));
    } catch(e) { res.writeHead(500); return res.end(JSON.stringify({ ok:false, error:e.message })); }
  }


  if (req.method === 'POST' && p === '/cookie-refresh') {
    const d = await readBody();
    if (!d.cookies) { res.writeHead(400); return res.end(JSON.stringify({ error: 'cookies obrigatorio' })); }
    try {
      const r = await refreshCookies(d.cookies, d.fe_session || '');
      res.writeHead(r.ok ? 200 : r.expired ? 401 : 500);
      return res.end(JSON.stringify(r));
    } catch(e) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }


  if (req.method === 'POST' && p === '/fetch-url') {
    const d = await readBody();
    if (!d.url) { res.writeHead(400); return res.end(JSON.stringify({ error: 'url obrigatorio' })); }
    try {
      const hdrs = {
        'User-Agent': rnd(UA_DESKTOP),
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Referer': 'https://shopee.com.br/',
        'Origin': 'https://shopee.com.br',
        ...(d.headers||{}),
      };
      // Usa proxy residencial se disponível, senão usa BD proxy (browser zone)
      const useUnlocker = !!getUnlockerKey();
      const useResidential = !useUnlocker && !!getResidentialProxy();
      const proxyFn = useUnlocker ? (o) => unlockerReq(o.url) : (useResidential ? residentialReq : proxyReq);
      const proxyResp = await proxyFn({ url: d.url, method: d.method||'GET', headers: hdrs }, d.body||undefined);
      res.writeHead(proxyResp.status);
      return res.end(JSON.stringify({ status: proxyResp.status, data: proxyResp.data, raw: proxyResp.raw?.slice(0, d.max_len || 2000) }));
    } catch(e) {
      res.writeHead(500);
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // /unlocker-call — chama Shopee via Web Unlocker COM cookies/body/headers
  // Aceita: { url, method, headers, body, cookies, max_len }
  if (req.method === 'POST' && p === '/unlocker-call') {
    const d = await readBody();
    if (!d.url) { res.writeHead(400); return res.end(JSON.stringify({ error: 'url obrigatorio' })); }
    if (!getUnlockerKey()) { res.writeHead(503); return res.end(JSON.stringify({ error: 'BD_UNLOCKER_KEY nao configurado' })); }
    try {
      const r = await unlockerReq(d.url, d.zone, {
        method: d.method || 'GET',
        headers: d.headers || {},
        body: d.body,
        cookies: d.cookies,
        render_js: !!d.render_js,
      });
      res.writeHead(200);
      return res.end(JSON.stringify({ status: r.status, raw: (r.raw||'').slice(0, d.max_len||10000) }));
    } catch(e) {
      res.writeHead(500);
      return res.end(JSON.stringify({ error: e.message }));
    }
  }


  // ══════════════════════════════════════════════════════════════════
  // /buyer-cart-add — Adiciona produto ao carrinho da conta comprador
  // Usa Bright Data Scraping Browser (BD_WSS) via CDP — bypassa anti-bot Shopee
  // ══════════════════════════════════════════════════════════════════
  // /discover-warranty — abre Chrome real, navega pra /portal/product/new
  // e captura TODAS as XHRs Shopee + DOM com warranty options
  // Uso: { cookies: "...", category_id: 100006 }
  if (req.method === 'POST' && p === '/discover-warranty') {
    const d = await readBody();
    if (!d.cookies) { res.writeHead(400); return res.end(JSON.stringify({ error: 'cookies obrigatorio' })); }
    try {
      const r = await discoverWarrantyOptionsViaBrowser(d.cookies, d.category_id || 100006);
      res.writeHead(200);
      return res.end(JSON.stringify(r));
    } catch(e) {
      res.writeHead(500);
      return res.end(JSON.stringify({ error: e.message, stack: (e.stack||'').slice(0,500) }));
    }
  }

  if (req.method === 'POST' && p === '/buyer-cart-add') {
    const d = await readBody();
    if (!d.cookies || !d.itemid || !d.shopid) {
      res.writeHead(400); return res.end(JSON.stringify({ error: 'cookies, itemid, shopid obrigatorios' }));
    }
    if (!BD_WSS) {
      res.writeHead(503); return res.end(JSON.stringify({ ok: false, error: 'BD_WSS nao configurado — Scraping Browser indispensavel' }));
    }
    try {
      const body = {
        add_to_cart_list: [{
          itemid: parseInt(d.itemid),
          shopid: parseInt(d.shopid),
          quantity: d.quantity || 1,
          modelid: parseInt(d.modelid || 0),
          source: 'pdp_normal',
        }]
      };
      const r = await buyerActionViaBrowser(d.cookies, 'https://shopee.com.br/api/v4/cart/add_to_cart_v2', body);
      res.writeHead(r.status === 200 ? 200 : 503);
      return res.end(JSON.stringify({ ok: r.status === 200 && (r.data?.error === 0 || !r.data?.error), status: r.status, data: r.data, raw: (r.raw||'').slice(0, 5000) }));
    } catch(e) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // /buyer-checkout — Faz checkout (place order) da conta comprador
  // Usa Bright Data Scraping Browser (BD_WSS) via CDP
  // ══════════════════════════════════════════════════════════════════
  if (req.method === 'POST' && p === '/buyer-checkout') {
    const d = await readBody();
    if (!d.cookies || !d.shoporders) {
      res.writeHead(400); return res.end(JSON.stringify({ error: 'cookies e shoporders obrigatorios' }));
    }
    if (!BD_WSS) {
      res.writeHead(503); return res.end(JSON.stringify({ ok: false, error: 'BD_WSS nao configurado — Scraping Browser indispensavel' }));
    }
    try {
      const body = {
        shoporders: d.shoporders,
        selected_payment_channel_data: d.payment || { payment_type: 2, version: 2 },
        address_id: d.address_id || 0,
        promotion_data: d.promotion_data || { use_coins: false, free_shipping_voucher_info: { free_shipping_voucher_id: 0 } },
      };
      const r = await buyerActionViaBrowser(d.cookies, 'https://shopee.com.br/api/v4/order/checkout_place_order_v2', body);
      res.writeHead(r.status === 200 ? 200 : 503);
      const orderSn = r.data?.order_list?.[0]?.orderid || r.data?.checkout_order_sn || '';
      return res.end(JSON.stringify({ ok: r.status === 200 && (r.data?.error === 0 || !r.data?.error), status: r.status, order_sn: String(orderSn), data: r.data, raw: (r.raw||'').slice(0, 5000) }));
    } catch(e) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // /buyer-cart-get — Lista carrinho atual da conta comprador (debug)
  // ══════════════════════════════════════════════════════════════════
  if (req.method === 'POST' && p === '/buyer-cart-get') {
    const d = await readBody();
    if (!d.cookies) { res.writeHead(400); return res.end(JSON.stringify({ error: 'cookies obrigatorio' })); }
    if (!BD_WSS) { res.writeHead(503); return res.end(JSON.stringify({ ok: false, error: 'BD_WSS nao configurado' })); }
    try {
      const r = await buyerActionViaBrowser(d.cookies, 'https://shopee.com.br/api/v4/cart/get', {}, 'POST');
      res.writeHead(200);
      const isLogin = r.data?.is_login;
      return res.end(JSON.stringify({ ok: r.status === 200 && isLogin !== false, status: r.status, is_login: isLogin, data: r.data, raw: (r.raw||'').slice(0,1500), error: r.error||null }));
    } catch(e) { res.writeHead(500); return res.end(JSON.stringify({ ok: false, error: e.message, stack: (e.stack||'').slice(0,500) })); }
  }


  // ══════════════════════════════════════════════════════════════════
  // /shopee-pdp-full — Pega produto completo com TODAS variações e preços
  // Usa residential proxy direto na API pública Shopee
  // ══════════════════════════════════════════════════════════════════
  if (req.method === 'POST' && p === '/shopee-pdp-full') {
    const d = await readBody();
    if (!d.itemid || !d.shopid) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: 'itemid e shopid obrigatorios' }));
    }
    const errors = [];
    // Tenta 5 endpoints públicos da Shopee via residential proxy (IP brasileiro real)
    const apis = [
      `https://shopee.com.br/api/v4/pdp/get_pc?item_id=${d.itemid}&shop_id=${d.shopid}&tz_offset_minutes=-180&detail_level=0`,
      `https://shopee.com.br/api/v4/item/get?itemid=${d.itemid}&shopid=${d.shopid}`,
      `https://shopee.com.br/api/v4/item/get_shop_info?shopid=${d.shopid}`,
    ];
    let itemData = null;
    let modelsData = null;
    for (const apiUrl of apis) {
      try {
        const r = await residentialReq({
          url: apiUrl,
          method: 'GET',
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
            'Cache-Control': 'no-cache',
            'Referer': 'https://shopee.com.br/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'X-Api-Source': 'pc',
            'X-Shopee-Language': 'pt-BR',
            'X-Requested-With': 'XMLHttpRequest',
          },
        });
        if (r.status === 200 && r.data) {
          // Estrutura varia por endpoint
          const item = r.data?.data?.item || r.data?.item || r.data?.data || null;
          if (item && item.name) {
            itemData = item;
            modelsData = item.models || item.tier_variations_v2 || null;
            break;
          }
        }
        errors.push(apiUrl.split('/api/')[1].split('?')[0] + ': status=' + r.status);
      } catch (e) {
        errors.push(apiUrl.split('/api/')[1].split('?')[0] + ': ' + e.message);
      }
    }
    // Fallback: pega HTML grande via Unlocker e extrai models embedded
    if (!itemData) {
      try {
        const slug = d.url || `https://shopee.com.br/i.${d.shopid}.${d.itemid}`;
        const hr = await new Promise((resolveH) => {
          const body = JSON.stringify({ url: slug, max_len: 800000 });
          const { protocol: proto, hostname } = new url_mod.URL('https://api.brightdata.com/request');
          const opts = {
            hostname, port: 443, path: '/request', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer '+(process.env.BD_API_TOKEN||'') },
          };
          const req_ = https.request(opts, r => {
            const chunks = [];
            r.on('data', c => chunks.push(c));
            r.on('end', () => resolveH(Buffer.concat(chunks).toString('utf8')));
          });
          req_.on('error', () => resolveH(''));
          req_.write(JSON.stringify({ zone: 'unlocker', url: slug, format: 'raw' }));
          req_.end();
        });
        // Parse models[] do HTML
        const raw = hr || '';
        const idx = raw.indexOf('"models":[');
        if (idx > 0) {
          // Balanced parse
          let arrStart = raw.indexOf('[', idx);
          let depth = 0, inStr = false, esc = false, end = arrStart;
          for (let i = arrStart; i < raw.length; i++) {
            const c = raw[i];
            if (esc) { esc = false; continue; }
            if (inStr) { if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
            if (c === '"') inStr = true;
            else if (c === '[') depth++;
            else if (c === ']') { depth--; if (depth === 0) { end = i; break; } }
          }
          try {
            modelsData = JSON.parse(raw.slice(arrStart, end + 1));
          } catch(e) { errors.push('models parse: ' + e.message); }
        }
      } catch(e) { errors.push('html-fallback: ' + e.message); }
    }
    if (!itemData && !modelsData) {
      res.writeHead(404);
      return res.end(JSON.stringify({ ok: false, error: 'Produto nao encontrado', diagnostic: errors }));
    }
    res.writeHead(200);
    return res.end(JSON.stringify({
      ok: true,
      item: itemData,
      models: modelsData,
      diagnostic: errors,
    }));
  }

  if (req.method === 'POST' && p === '/product-detail') {
    const d = await readBody();
    if (!d.itemid || !d.shopid) { res.writeHead(400); return res.end(JSON.stringify({ error: 'itemid e shopid obrigatorios' })); }
    try {
      const apiUrl = 'https://shopee.com.br/api/v4/item/get?itemid=' + d.itemid + '&shopid=' + d.shopid;
      const ws = new WebSocket(BD_WSS, { handshakeTimeout: 20000 });
      await new Promise((resolve, reject) => {
        ws.once('open', resolve); ws.once('error', reject);
        setTimeout(() => reject(new Error('WS timeout')), 20000);
      });
      const cdp = new CDPBrowser(ws);
      try {
        const { targetInfos } = await cdp.send('Target.getTargets', {}).catch(() => ({ targetInfos: [] }));
        const existingPage = (targetInfos||[]).find(t => t.type === 'page');
        let targetId;
        if (existingPage) { targetId = existingPage.targetId; }
        else { const nt = await cdp.send('Target.createTarget', { url: 'about:blank' }); targetId = nt.targetId; }
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
        const s = cdp.session(sessionId);
        await s.send('Network.enable', {}).catch(()=>{});
        await s.send('Page.enable', {}).catch(()=>{});

        // Injeta cookies da Shopee antes de navegar
        if (d.cookies) {
          const cl = d.cookies.split(';').map(c=>c.trim()).filter(Boolean).map(cp => {
            const eq = cp.indexOf('='); if(eq<0) return null;
            return { name: cp.slice(0,eq).trim(), value: cp.slice(eq+1).trim(), domain: '.shopee.com.br', path: '/' };
          }).filter(c=>c&&c.name&&c.value);
          for(const ck of cl) { await s.send('Network.setCookie', ck).catch(()=>{}); }
        }

        // Navega diretamente pra URL da API — browser envia cookies + IP residencial
        // Tenta múltiplas APIs em sequência
        const apiUrls = [
          'https://shopee.com.br/api/v4/item/get?itemid=' + d.itemid + '&shopid=' + d.shopid,
          'https://shopee.com.br/api/v2/item/get?itemid=' + d.itemid + '&shopid=' + d.shopid,
          'https://shopee.com.br/' + d.shopid + '/' + d.itemid,
        ];
        
        let item = null;
        for (const apiUrl of apiUrls) {
          await s.send('Page.navigate', { url: apiUrl });
          await new Promise((resolve) => {
            let done = false;
            const timer = setTimeout(() => { done = true; resolve(); }, 10000);
            cdp.ws.on('message', (raw) => {
              if (done) return;
              try {
                const msg = JSON.parse(raw.toString());
                if (msg.method === 'Page.loadEventFired' || msg.method === 'Page.frameStoppedLoading') {
                  clearTimeout(timer); done = true; resolve();
                }
              } catch(e) {}
            });
          });
          const bodyResult = await s.send('Runtime.evaluate', {
            expression: 'document.body ? document.body.innerText : document.documentElement.innerText',
            returnByValue: true,
          }).catch(()=>({}));
          const rawText = bodyResult?.result?.value || '';
          let data = {};
          try { data = JSON.parse(rawText); } catch(e) {}
          const candidate = (data.data||{}).item || (data.item) || (data.error === 0 ? data.data : null);
          if (candidate && candidate.name) { item = candidate; break; }
        }
        cdp.close();
        if (item && item.name) {
          res.writeHead(200);
          return res.end(JSON.stringify({ ok: true, item }));
        }
        res.writeHead(404);
        return res.end(JSON.stringify({ ok: false, error: 'Produto nao encontrado' }));
      } catch(e) { cdp.close(); throw e; }
    } catch(e) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }


  // ── /utimix-products — scrapa catálogo Utimix via BD Scraping Browser ──

  // ══════════════════════════════════════════════════════════════════
  // /utimix-scrape-details — Scrapa imagens, desc e tiers de cada produto
  // ══════════════════════════════════════════════════════════════════
  if (req.method === 'POST' && p === '/utimix-scrape-details') {
    const d = await readBody();
    const slug = d.slug || '';
    const wp_cookie = d.wp_cookie || '';
    if (!slug) { res.writeHead(400); return res.end(JSON.stringify({ error: 'slug obrigatorio' })); }

    try {
      // Scrapa via BD Unlocker
      const result = await unlockerReq(`https://www.utimix.com/produto/${slug}/`);
      const html = result.raw || '';
      if (html.length < 5000) {
        res.writeHead(503);
        return res.end(JSON.stringify({ ok: false, error: 'HTML pequeno', html_len: html.length }));
      }

      // Tiers de preço
      const tiers = [];
      const rows = html.match(/<tr[\s\S]*?<\/tr>/g) || [];
      for (const row of rows) {
        const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1].replace(/<[^>]+>/g,'').trim());
        if (tds.length >= 2) {
          const qty = tds[0];
          const priceRaw = tds[1].replace(/&#082;&#036;/g,'').replace(/&nbsp;/g,'').trim();
          const priceM = priceRaw.match(/[\d,]+/);
          if (/\d/.test(qty) && priceM && (qty.includes('-') || qty.includes('+'))) {
            tiers.push({ qty, price: parseFloat(priceM[0].replace(',','.')) });
          }
        }
      }

      // Imagens via slug words
      const slugWords = slug.split('-').filter(w => w.length > 3).slice(0,4);
      const imgs = [];
      const imgRe = /https:\/\/www\.utimix\.com\/wp-content\/uploads\/[^"\s]+400x400[^"\s]*\.(?:jpg|jpeg|png|webp)/g;
      let m;
      while ((m = imgRe.exec(html)) !== null) {
        const u = m[0];
        if (slugWords.some(w => u.toLowerCase().includes(w)) && !imgs.includes(u)) imgs.push(u);
      }
      if (!imgs.length) {
        const ogM = html.match(/og:image[^>]+content="([^"]+)"/);
        if (ogM) imgs.push(ogM[1]);
      }

      // Descrição
      let desc = '';
      const descIdx = html.indexOf('woocommerce-Tabs-panel--description');
      if (descIdx >= 0) {
        let chunk = html.slice(descIdx, descIdx + 4000)
          .replace(/<style[\s\S]*?<\/style>/gi,'')
          .replace(/<script[\s\S]*?<\/script>/gi,'');
        const lines = chunk.replace(/<[^>]+>/g,'\n').split('\n')
          .map(l => l.trim())
          .filter(l => l.length > 20 && !l.toLowerCase().startsWith('tab') && !l.toLowerCase().includes('woocommerce') && !l.includes('{') && !l.includes(':not(') && !l.startsWith('ATEN') && !l.includes('ILUSTRA'));
        desc = lines.slice(0,6).join(' ').slice(0,500).trim();
      }

      // Variações
      const variations = [];
      const selRe = /<select[^>]*name="attribute_[^"]*"[^>]*>([\s\S]*?)<\/select>/g;
      let sm;
      while ((sm = selRe.exec(html)) !== null) {
        const optRe = /<option[^>]*value="([^"]+)"[^>]*>([^<]+)<\/option>/g;
        let om;
        while ((om = optRe.exec(sm[1])) !== null) {
          if (om[1].trim() && !om[2].includes('Escolha')) variations.push(om[2].trim());
        }
      }

      res.writeHead(200);
      return res.end(JSON.stringify({
        ok: true, slug,
        tiers,
        images: imgs.slice(0,8),
        description: desc,
        variations: [...new Set(variations)].slice(0,10),
        html_len: html.length
      }));
    } catch(e) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: e.message, slug }));
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // /utimix-products — Web Unlocker BD com cookies WP
  // ══════════════════════════════════════════════════════════════════
  if (req.method === 'POST' && p === '/utimix-products') {
    const d = await readBody();
    const page_num = parseInt(d.page || '1');
    const per_page = parseInt(d.per_page || '20');
    const wp_cookie = d.wp_cookie || '';
    const targetUrl = page_num > 1
      ? `https://www.utimix.com/novidades/page/${page_num}/?orderby=date`
      : 'https://www.utimix.com/novidades/?orderby=date';

    // Usa BD Web Unlocker com custom headers (passa cookies WP)
    async function fetchUtimix(url) {
      const key = getUnlockerKey();
      if (!key) throw new Error('BD_UNLOCKER_KEY nao configurado');
      const body = JSON.stringify({
        zone: 'web_unlocker1',
        url: url,
        format: 'raw',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9',
          'Referer': 'https://www.utimix.com/',
          ...(wp_cookie ? { 'Cookie': wp_cookie } : {}),
        },
      });
      return new Promise((resolve, reject) => {
        const opts = {
          hostname: 'api.brightdata.com', port: 443, path: '/request', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'Content-Length': Buffer.byteLength(body) },
        };
        const r = https.request(opts);
        r.setTimeout(30000);
        r.on('error', reject);
        r.on('timeout', () => { r.destroy(); reject(new Error('Unlocker timeout')); });
        r.on('response', resp => {
          const chunks = [];
          resp.on('data', c => chunks.push(c));
          resp.on('end', () => resolve({ status: resp.statusCode, raw: Buffer.concat(chunks).toString('utf8') }));
          resp.on('error', reject);
        });
        r.write(body); r.end();
      });
    }

    try {
      const result = await fetchUtimix(targetUrl);
      const html = result.raw;

      if (!html || html.length < 1000) {
        res.writeHead(503);
        return res.end(JSON.stringify({ ok: false, error: 'HTML muito pequeno', http_status: result.status, html_len: html.length, html_preview: html.slice(0,200) }));
      }

      // Extrai produtos via data-gtm4wp_productdata (tem todos os campos)
      const products = [];
      const gtmBlocks = [...html.matchAll(/data-gtm4wp_product_id="(\d+)"[^>]+data-gtm4wp_product_name="([^"]+)"[^>]+data-gtm4wp_product_price="([^"]+)"[^>]+data-gtm4wp_product_cat="([^"]*)"[^>]+data-gtm4wp_product_url="([^"]+)"[^>]*(?:data-gtm4wp_product_stocklevel="([^"]*)")?/g)];

      for (const m of gtmBlocks.slice(0, per_page)) {
        const id = parseInt(m[1]);
        const name = m[2].replace(/&amp;/g,'&').replace(/&#[0-9]+;/g,'');
        const price = parseFloat(m[3]) || 0;
        const category = m[4].replace(/&amp;/g,'&').split('/')[0].trim();
        const url = m[5];
        const slug = url.replace(/.*\/produto\//,'').replace(/\/$/,'');
        const stock = parseInt(m[6]||'0');

        // Busca imagem associada ao produto
        const prodIdx = html.indexOf(`data-gtm4wp_product_id="${id}"`);
        const prodBlock = html.slice(Math.max(0, prodIdx-3000), prodIdx);
        const imgM = prodBlock.match(/src="(https:\/\/www\.utimix\.com\/wp-content\/uploads\/[^"]+(?:400x400|300x300)[^"]*\.(?:png|jpg|jpeg|webp))"/);
        const img = imgM ? imgM[1] : '';

        products.push({
          id, name, slug, price,
          regular_price: price, sale_price: 0,
          image: img, images: img ? [img] : [],
          categories: category ? [category] : [],
          description: '',
          stock_status: stock > 0 ? 'instock' : 'outofstock',
          in_stock: stock > 0,
          stock_quantity: stock,
          sku: ''
        });
      }

      if (products.length > 0) {
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, products, total: products.length, page: page_num, method: 'web_unlocker', html_len: html.length }));
      }

      res.writeHead(503);
      return res.end(JSON.stringify({ ok: false, error: 'Sem produtos no HTML', html_len: html.length, html_preview: html.slice(500, 1500) }));
    } catch(e) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }


  // ── /img — proxy de imagem binário (GET ?url=) ──
  if (req.method === 'GET' && pathname === '/img') {
    const imgUrl = url.searchParams.get('url') || '';
    if (!imgUrl) { res.writeHead(400); return res.end('url obrigatoria'); }
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    
    try {
      const result = await proxyReqBinary({
        url: imgUrl,
        method: 'GET',
        headers: {
          'User-Agent': rnd(UA_DESKTOP),
          'Referer': 'https://www.utimix.com/',
          'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9',
        }
      });

      if (result.status !== 200) {
        res.writeHead(result.status);
        return res.end();
      }

      const ct = result.contentType || 'image/jpeg';
      res.writeHead(200, {
        'Content-Type': ct,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      });
      res.end(result.bytes);
    } catch(e) {
      console.error('/img error:', e.message);
      res.writeHead(502);
      res.end();
    }
    return;
  }



  if (pathname === '/proxy-image') {
    let imgUrl = '';
    if (req.method === 'GET') {
      imgUrl = url.searchParams.get('url') || '';
    } else if (req.method === 'POST') {
      let body = '';
      await new Promise(resolve => { req.on('data', d => body += d); req.on('end', resolve); });
      try { imgUrl = JSON.parse(body).url || ''; } catch(e) {}
    }
    if (!imgUrl) { res.writeHead(400); return res.end(JSON.stringify({ error: 'url obrigatoria' })); }
    
    // CORS headers para permitir img src cross-origin
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    
    const mod = imgUrl.startsWith('https') ? require('https') : require('http');
    mod.get(imgUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.utimix.com/',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'same-origin',
      }
    }, (imgRes) => {
      if (imgRes.statusCode !== 200) {
        res.writeHead(imgRes.statusCode);
        return res.end();
      }
      res.writeHead(200, {
        'Content-Type': imgRes.headers['content-type'] || 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      });
      imgRes.pipe(res);
    }).on('error', (e) => { res.writeHead(502); res.end(); });
    return;
  }


  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));

}).listen(PORT, () => {
  // Startup leve — endpoints gerados sob demanda
  const proxyInfo = getProxy() ? getProxy().host + ':' + getProxy().port : 'NAO CONFIGURADO';
  console.log(`✅ Vendry Sync Server v14.0 | porta ${PORT} | proxy: ${proxyInfo}`);
  console.log(`   SC: ${Object.keys(SC_PATHS).length} categorias | BU: ${Object.keys(BU_PATHS).length} categorias | v10 sync: 50 eps`);
  console.log(`   UA pool: ${UA_ALL.length} | IA: ON | Pronto!`);
});