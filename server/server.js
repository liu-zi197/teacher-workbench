/* 中小学教师智能工作台 · 后端 (零依赖 Node)
 * 功能：托管前端静态 + 密钥登录 + 按workspace云端数据存储 + AI代理
 * 启动：node server.js   (端口可用 PORT 环境变量覆盖)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

/* 零依赖读取 .env（可选）：KEY=VALUE 每行一个 */
try{
  const envPath = path.join(__dirname, '.env');
  if(fs.existsSync(envPath)){
    fs.readFileSync(envPath,'utf8').split('\n').forEach(line=>{
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
      if(m && process.env[m[1]]===undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g,'');
    });
  }
}catch(e){}

const ROOT = path.join(__dirname, '..');            // teacher-workbench/
const DATA_DIR = path.join(__dirname, 'data');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');
const WS_DIR = path.join(DATA_DIR, 'ws');
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SECRET || crypto.randomBytes(32).toString('hex');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ALLOW_SELF_REGISTER = (process.env.ALLOW_SELF_REGISTER || 'true') === 'true';
// 跨域：对接 CloudStudio 等静态前端时填其域名；留空默认 *（允许任意来源）
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// ---------- 存储层（可插拔：Supabase / 本地文件） ----------
// Render 免费层文件系统是临时的，重启会丢数据；检测到 SUPABASE_URL 即改用 Supabase(PostgreSQL)。
// 本地开发不填则自动回退本地 JSON 文件。
const USE_SUPABASE = !!(process.env.SUPABASE_URL && process.env.SUPABASE_KEY);
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_KEY || '';
const SB_TABLE = process.env.SUPABASE_TABLE || 'kv';

function sbHeaders(extra){
  return Object.assign({
    'apikey': SB_KEY,
    'Authorization': 'Bearer ' + SB_KEY,
    'Content-Type': 'application/json'
  }, extra || {});
}
async function sbGet(key){
  const r = await fetch(SB_URL + '/rest/v1/' + SB_TABLE + '?key=eq.' + encodeURIComponent(key) + '&select=value', { headers: sbHeaders() });
  if(!r.ok) throw new Error('Supabase 读取失败 ' + r.status);
  const rows = await r.json();
  return rows.length ? rows[0].value : null;
}
async function sbSet(key, value){
  const r = await fetch(SB_URL + '/rest/v1/' + SB_TABLE, {
    method: 'POST',
    headers: sbHeaders({ 'Prefer': 'resolution=merge-duplicates' }),
    body: JSON.stringify({ key, value })
  });
  if(!r.ok) throw new Error('Supabase 写入失败 ' + r.status);
}
async function sbProbe(){
  try{ await sbGet('__probe__'); console.log('   ✅ Supabase 连接正常'); }
  catch(e){ console.warn('   ⚠️ Supabase 连接探测失败（请确认已建表并填写正确的 SUPABASE_URL/SUPABASE_KEY）：', e.message); }
}

const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif',
  '.svg':'image/svg+xml', '.ico':'image/x-icon', '.woff2':'font/woff2',
  '.txt':'text/plain; charset=utf-8'
};
const ALLOWED_EXT = Object.keys(MIME);

function ensureDir(d){ if(!fs.existsSync(d)) fs.mkdirSync(d, {recursive:true}); }
ensureDir(DATA_DIR); ensureDir(WS_DIR);

// 本地文件回退
function loadKeys(){
  if(!fs.existsSync(KEYS_FILE)) return [];
  try{ return JSON.parse(fs.readFileSync(KEYS_FILE,'utf8')); }catch(e){ return []; }
}
function saveKeys(k){ fs.writeFileSync(KEYS_FILE, JSON.stringify(k, null, 2)); }
function wsFile(ws){ return path.join(WS_DIR, ws + '.json'); }
function uid(){ return crypto.randomBytes(6).toString('hex'); }

// 统一异步接口（根据 USE_SUPABASE 自动选择后端）
async function loadKeysA(){ return USE_SUPABASE ? (await sbGet('keys') || []) : loadKeys(); }
async function saveKeysA(k){ if(USE_SUPABASE) await sbSet('keys', k); else { ensureDir(DATA_DIR); saveKeys(k); } }
async function loadWsA(ws){ if(USE_SUPABASE) return await sbGet('ws:' + ws); return fs.existsSync(wsFile(ws)) ? JSON.parse(fs.readFileSync(wsFile(ws),'utf8')) : null; }
async function saveWsA(ws, body){ if(USE_SUPABASE) await sbSet('ws:' + ws, body); else { ensureDir(WS_DIR); fs.writeFileSync(wsFile(ws), JSON.stringify(body)); } }

function signToken(ws, name){
  const payload = Buffer.from(JSON.stringify({ws, name, exp: Date.now()+86400000*30})).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function verifyToken(token){
  if(!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  if(sig.length !== expected.length) return null;
  try{ if(!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null; }catch(e){ return null; }
  try{
    const data = JSON.parse(Buffer.from(payload,'base64url').toString());
    if(data.exp < Date.now()) return null;
    return data;
  }catch(e){ return null; }
}

/* ---------- AI 代理：读取服务端环境变量中的 key，老师端无感调用 ---------- */
async function callAI(system, user){
  const key = process.env.AI_KEY;
  if(!key) return { ok:false, fallback:true, text:'未配置AI密钥，已回退使用内置模板生成。' };
  const base = process.env.AI_BASE || 'https://api.siliconflow.cn/v1';
  const model = process.env.AI_MODEL || 'deepseek-ai/DeepSeek-V3';
  try{
    const resp = await fetch(base + '/chat/completions', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+key },
      body: JSON.stringify({
        model,
        messages:[{role:'system', content:system},{role:'user', content:user}],
        temperature:0.7, max_tokens:2200
      })
    });
    if(!resp.ok) return { ok:false, fallback:true, text:'(AI接口返回 '+resp.status+')' };
    const j = await resp.json();
    const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '';
    return { ok:true, text };
  }catch(e){ return { ok:false, fallback:true, text:'(AI调用失败: '+e.message+')' }; }
}

/* ---------- 工具 ---------- */
function readBody(req){
  return new Promise((resolve)=>{
    let data='';
    req.on('data', c=> data+=c);
    req.on('end', ()=> resolve(data));
  });
}
function json(res, code, obj){
  res.writeHead(code, {'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(obj));
}
function authOf(req){
  const h = req.headers['authorization'] || '';
  return verifyToken(h.replace(/^Bearer\s+/i,''));
}
function setCors(res){
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

/* ---------- 路由 ---------- */
const server = http.createServer(async (req, res)=>{
  setCors(res);
  const u = new URL(req.url, 'http://localhost');
  const pathname = u.pathname;
  if(pathname.startsWith('/api/')) return handleApi(req, res, pathname);
  return serveStatic(res, pathname);
});

async function handleApi(req, res, pathname){
  try{
    if(req.method === 'OPTIONS'){ res.writeHead(204); return res.end(); }  // 跨域预检
    // 登录
    if(pathname === '/api/login' && req.method === 'POST'){
      const body = JSON.parse(await readBody(req) || '{}');
      const key = (body.key || '').trim();
      if(!key) return json(res, 400, {error:'请输入密钥'});
      let keys = await loadKeysA();
      let rec = keys.find(k => k.key === key && k.active);
      if(!rec){
        if(ALLOW_SELF_REGISTER){
          const ws = uid();
          rec = { key, name: body.name || '教师', ws, createdAt: Date.now(), active:true, role:'teacher' };
          keys.push(rec); await saveKeysA(keys);
        } else {
          return json(res, 401, {error:'密钥无效'});
        }
      }
      const token = signToken(rec.ws, rec.name);
      return json(res, 200, { token, name: rec.name, ws: rec.ws });
    }

    // 管理员发密钥（用 ADMIN_KEY 校验，不依赖登录态）
    if(pathname === '/api/admin/issue' && req.method === 'POST'){
      const body = JSON.parse(await readBody(req) || '{}');
      if(!ADMIN_KEY || body.adminKey !== ADMIN_KEY) return json(res, 403, {error:'管理员密钥错误'});
      const n = Math.max(1, Math.min(50, body.count || 1));
      const keys = await loadKeysA();
      const out = [];
      for(let i=0;i<n;i++){
        const k = 'TWB-' + crypto.randomBytes(5).toString('hex').toUpperCase();
        keys.push({ key:k, name: body.name || '教师', ws: uid(), createdAt: Date.now(), active:true, role:'teacher' });
        out.push(k);
      }
      await saveKeysA(keys);
      return json(res, 200, { keys: out });
    }

    // 以下需要登录
    const auth = authOf(req);
    if(!auth) return json(res, 401, {error:'未登录或登录已过期'});

    if(pathname === '/api/me' && req.method === 'GET'){
      return json(res, 200, { name: auth.name, ws: auth.ws });
    }

    // 云端数据读写（前端直接存取整个 DB 对象，按 workspace 隔离）
    if(pathname === '/api/data' && req.method === 'GET'){
      const db = await loadWsA(auth.ws);
      return json(res, 200, { db: db || null });
    }
    if(pathname === '/api/data' && req.method === 'POST'){
      const body = JSON.parse(await readBody(req) || '{}');
      if(!body.db) return json(res, 400, {error:'缺少数据'});
      await saveWsA(auth.ws, body.db);
      return json(res, 200, { ok:true });
    }

    // AI 代理
    if(pathname === '/api/ai' && req.method === 'POST'){
      const body = JSON.parse(await readBody(req) || '{}');
      const r = await callAI(body.system || '', body.user || '');
      return json(res, 200, r);
    }

    return json(res, 404, {error:'接口不存在'});
  }catch(e){
    return json(res, 500, {error: e.message});
  }
}

function serveStatic(res, pathname){
  let p = decodeURIComponent(pathname);
  if(p === '/' || p === '') p = '/index.html';
  const full = path.normalize(path.join(ROOT, p));
  const ext = path.extname(full).toLowerCase();
  const forbidden = !full.startsWith(ROOT)
    || full.includes(path.join(ROOT, 'server'))
    || full.includes(path.join(ROOT, 'data'))
    || !ALLOWED_EXT.includes(ext);
  if(forbidden){ res.writeHead(403); return res.end('Forbidden'); }
  if(!fs.existsSync(full) || fs.statSync(full).isDirectory()){
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, {'Content-Type': MIME[ext] || 'application/octet-stream'});
  fs.createReadStream(full).pipe(res);
}

server.listen(PORT, ()=>{
  console.log('✅ 教师工作台后端已启动: http://localhost:' + PORT);
  console.log('   存储：' + (USE_SUPABASE ? ('Supabase ('+SB_TABLE+')') : '本地文件 (data/) — 生产环境建议配置 Supabase 以免数据丢失'));
  if(!ADMIN_KEY) console.log('⚠️ 未设置 ADMIN_KEY：可在 .env 设置管理员密钥后用 /api/admin/issue 批量发教师密钥。当前为自助注册模式（任意密钥可建空间）。');
  console.log('   AI代理：' + (process.env.AI_KEY ? ('已配置 ('+(process.env.AI_MODEL||'deepseek-ai/DeepSeek-V3')+')') : '未配置，将自动回退模板生成'));
  if(USE_SUPABASE) sbProbe();
});
