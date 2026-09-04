/* ============================================================
   中小学教师智能工作台 · 原型版
   数据保存在 localStorage，支持导出 Word / PDF(打印另存) / A4打印
   OCR 为预留结构：图片上传 + 识别文本字段 + 手动校正区
   ============================================================ */

/* ==================== 1. 数据与存储 ==================== */
const DB_KEY = 'teacher_wb_v1';

/* ==================== 0. 云端模式（经 Cloudflare 中转直连 GitHub，老师零配置） ==================== */
// 数据存于公开仓库 teacher-workbench 的 data/ 目录，内容用 AES-GCM 加密（防公开仓库内容被随手读取）。
// 令牌由 Cloudflare Worker（worker.js）在服务端保管，前端无需任何令牌/同步码，老师拿密钥直接登。
const GH_REPO  = 'liu-zi197/teacher-workbench';
// 云端中转地址：部署 worker.js 后把你的 Worker 网址填到下面（形如 https://twb-proxy.xxxx.workers.dev）
const GH_PROXY = '';   // ← 部署 Cloudflare Worker 后填入；留空则自动回退本机存储
const GH_API   = GH_PROXY ? (GH_PROXY.replace(/\/$/,'') + '/repos/'+GH_REPO+'/contents/data/') : '';

// —— AES-GCM 加密（密钥在前端可见，仅防公开仓库内容被偶然读取，非绝对保密）——
const _enc = new TextEncoder(), _dec = new TextDecoder();
function _b64u(b){ const a=new Uint8Array(b); let s=''; for(let i=0;i<a.length;i++) s+=String.fromCharCode(a[i]); return btoa(s); }
function _b64d(s){ const b=atob(s); const a=new Uint8Array(b.length); for(let i=0;i<b.length;i++) a[i]=b.charCodeAt(i); return a; }
async function _ghKey(){
  const h=await crypto.subtle.digest('SHA-256', _enc.encode('twb-cloud-2026-liu-zi197'));
  return crypto.subtle.importKey('raw', h, {name:'AES-GCM'}, false, ['encrypt','decrypt']);
}
async function ghEncrypt(obj){
  const k=await _ghKey(); const iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=await crypto.subtle.encrypt({name:'AES-GCM', iv}, k, _enc.encode(JSON.stringify(obj)));
  return _b64u(iv)+'.'+_b64u(ct);
}
async function ghDecrypt(str){
  const p=str.split('.'); const k=await _ghKey();
  const pt=await crypto.subtle.decrypt({name:'AES-GCM', iv:_b64d(p[0])}, k, _b64d(p[1]));
  return JSON.parse(_dec.decode(pt));
}
function ghHead(){ return { 'Accept':'application/vnd.github+json', 'X-GitHub-Api-Version':'2022-11-28' }; }
// 读一行：404 返回 null，其余失败抛错（由调用方回退本地）
async function ghGetRow(key){
  if(!GH_API) throw new Error('未配置云端中转');
  const fn=encodeURIComponent(key)+'.json';
  const r=await fetch(GH_API+fn, {headers: ghHead()});
  if(r.status===404) return null;
  if(!r.ok) throw new Error('云端读取失败('+r.status+')');
  const j=await r.json();
  return await ghDecrypt(atob(j.content.replace(/\s/g,'')));
}
// 写一行：自动取 sha 以支持更新
async function ghSetRow(key, val){
  if(!GH_API) throw new Error('未配置云端中转');
  const fn=encodeURIComponent(key)+'.json';
  const body=_b64u(_enc.encode(await ghEncrypt(val)));
  let sha=null;
  try{ const r0=await fetch(GH_API+fn, {headers: ghHead()}); if(r0.ok){ const j0=await r0.json(); sha=j0.sha; } }catch(e){}
  const payload={ message:'twb sync '+key, content: body };
  if(sha) payload.sha=sha;
  const r=await fetch(GH_API+fn, {method:'PUT', headers: Object.assign(ghHead(),{'Content-Type':'application/json'}), body: JSON.stringify(payload)});
  if(!r.ok) throw new Error('云端保存失败('+r.status+')');
}

// 离线兜底：把管理员密码哈希内置到前端，即使云端完全不可达也能登录（国内网络常连不通）
const ADMIN_PWD_HASH = simpleHash('liu010806');

let WS_KEY   = localStorage.getItem('twb_ws') || '';   // 工作空间 ID（由发放的登录密钥映射得到，非密钥本身）
let USERNAME = localStorage.getItem('twb_user') || '';
let ONLINE   = false;
const KEYS_ROW  = 'twb_keys';   // 管理员发放的密钥登记表：{ 登录密钥: {name, ws, createdAt} }
const ADMIN_ROW = 'twb_admin';  // 管理员密码（哈希存储，已内置前端，无需云端）
const ADMIN_WS = 'ws_owner';   // 管理员本人专属空间（用管理员密码 liu010806 登录时进入）
const api = {
  // 登录：先用管理员密码校验，命中则进入管理员专属空间并自动解锁管理后台；
  // 否则校验是否命中发放的访问密钥。
  async login(key, name){
    key=(key||'').trim(); if(!key) throw new Error('请输入密钥');
    // ① 离线兜底：本地内置管理员密码，云端不可达也能进
    if(simpleHash(key) === ADMIN_PWD_HASH){
      WS_KEY = ADMIN_WS; USERNAME = name || '管理员'; ONLINE = true;
      sessionStorage.setItem('twb_admin_unlock','1');   // 自动解锁管理后台
      localStorage.setItem('twb_ws', WS_KEY); localStorage.setItem('twb_user', USERNAME);
      return;
    }
    // ② 普通老师：先试云端名单
    try{
      const reg = await ghGetRow(KEYS_ROW) || {};
      const rec = reg[key];
      if(rec){
        WS_KEY = rec.ws; USERNAME = rec.name || name || '老师'; ONLINE = true;
        sessionStorage.removeItem('twb_admin_unlock');
        localStorage.setItem('twb_ws', WS_KEY); localStorage.setItem('twb_user', USERNAME);
        return;
      }
    }catch(e){ /* 云端失败，继续走本机名单 */ }
    // ③ 离线本地名单兜底（本机管理员生成的密钥，保证本机可登）
    const localReg = JSON.parse(localStorage.getItem('twb_local_keys')||'{}');
    const lrec = localReg[key];
    if(lrec){
      WS_KEY = lrec.ws; USERNAME = lrec.name || name || '老师'; ONLINE = true;
      sessionStorage.removeItem('twb_admin_unlock');
      localStorage.setItem('twb_ws', WS_KEY); localStorage.setItem('twb_user', USERNAME);
      return;
    }
    throw new Error('密钥无效，请联系管理员获取');
  },
  async load(){
    try{
      const v = await ghGetRow(WS_KEY);
      if(v!==null && v!==undefined) return v;
    }catch(e){ /* 云端不可达，回退本地 */ }
    const local = localStorage.getItem('twb_data_'+WS_KEY);
    return local ? JSON.parse(local) : null;
  },
  async save(db){
    try{
      await ghSetRow(WS_KEY, db);
      return;
    }catch(e){ /* 云端不可达，存本地 */ }
    localStorage.setItem('twb_data_'+WS_KEY, JSON.stringify(db));
  },
  async getRow(k){ return ghGetRow(k); },
  async setRow(k,v){ return ghSetRow(k,v); },
  async ai(system, user){
    // 优先用老师个人密钥，否则回退到管理员统一密钥（全站免配置）
    const key   = localStorage.getItem('twb_ai_key')   || SHARED_AI_KEY;
    const base  = localStorage.getItem('twb_ai_base')  || SHARED_AI_BASE  || 'https://api.siliconflow.cn/v1';
    const model = localStorage.getItem('twb_ai_model') || SHARED_AI_MODEL || 'deepseek-ai/DeepSeek-V3';
    if(!key) return { ok:false, fallback:true, text:'' };
    try{
      const r = await fetch(base + '/chat/completions', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+key },
        body: JSON.stringify({ model, messages:[{role:'system',content:system},{role:'user',content:user}], temperature:0.7 })
      });
      if(!r.ok) return { ok:false, fallback:true, text:'' };
      const j = await r.json();
      const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      return text ? { ok:true, text } : { ok:false, fallback:true, text:'' };
    }catch(e){ return { ok:false, fallback:true, text:'' }; }
  },
  logout(){ WS_KEY=''; USERNAME=''; ONLINE=false; localStorage.removeItem('twb_ws'); localStorage.removeItem('twb_user'); sessionStorage.removeItem('twb_admin_unlock'); }
};

/* ==================== 保活心跳（GitHub 仓库不会休眠，此处仅做轻量连通自检） ==================== */
// 每次打开工作台/登录后：若距上次心跳 > 12 小时，就发一次轻量请求给云端中转。
// 多人使用 = 任何老师每天打开一次 = 项目永远"活跃"，免费层永不被清理。
function keepAlive(force){
  try{
    if(!GH_API) return;   // 未配置云端中转则跳过
    const KEY='twb_keepalive_ts';
    const last=parseInt(localStorage.getItem(KEY)||'0',10);
    const now=Date.now();
    if(!force && last && (now-last) < 12*3600*1000) return;   // 12 小时内已 ping 过则跳过
    localStorage.setItem(KEY, String(now));
    // GitHub 仓库不会被休眠清理，这里仅做轻量连通自检
    fetch(GH_API+'twb_probe.json', { headers: ghHead() })
      .then(r=>{ if(r.ok || r.status===404) console.log('[keepalive] cloud ping ok'); })
      .catch(e=>{ /* 网络失败不影响主功能 */ });
  }catch(e){}
}
// 管理员统一 AI 密钥（存于 GitHub 云端，全站老师免配置即可用真实 AI）
let SHARED_AI_KEY='', SHARED_AI_BASE='', SHARED_AI_MODEL='';
async function loadSharedAi(){
  if(!ONLINE) return;
  try{ const r=await api.getRow('twb_ai'); if(r){ SHARED_AI_KEY=r.key||''; SHARED_AI_BASE=r.base||''; SHARED_AI_MODEL=r.model||''; } }catch(e){}
}
async function saveAdminAi(){
  const k=(document.getElementById('admin_ai_key')||{}).value||'';
  const b=(document.getElementById('admin_ai_base')||{}).value||'';
  const m=(document.getElementById('admin_ai_model')||{}).value||'';
  SHARED_AI_KEY=k.trim(); SHARED_AI_BASE=b.trim()||'https://api.siliconflow.cn/v1'; SHARED_AI_MODEL=m.trim()||'deepseek-ai/DeepSeek-V3';
  try{
    await api.setRow('twb_ai',{key:SHARED_AI_KEY,base:SHARED_AI_BASE,model:SHARED_AI_MODEL});
    toast('AI 统一密钥已保存，全站老师现在可用真实 AI 生成');
  }catch(e){ toast('保存失败：'+(e.message||'网络错误')+'（请先在「基础设置→云端同步」配置 GitHub 令牌）'); }
}

function seedData(){
  return {
    meta:{
      grades:['一年级','二年级','三年级','四年级','五年级','六年级','七年级','八年级','九年级'],
      subjects:['语文','数学','英语','道德与法治','科学','物理','化学','生物','历史','地理'],
      versions:['人教版','北师大版','苏教版','沪教版','外研版'],
      classes:[],
      examTypes:['单元测试','周测','月考','期中考试','期末考试','模拟考试','随堂练习'],
      lessonTags:['新授课','复习课','练习课','公开课','期中复习','期末复习'],
      reasons:['审题不清','计算错误','概念不熟','方法不会','步骤不完整','书写不规范','粗心','时间不够','其他'],
      qtypes:['选择题','填空题','判断题','计算题','应用题','阅读题','简答题','作文题','实验题','综合题'],
      stuTags:['学习优秀','进步明显','基础薄弱','课堂活跃','作业拖拉','需要关注','心理敏感','纪律提醒']
    },
    catalogs:[
      {id:'c1',version:'人教版',subject:'数学',grade:'三年级',volume:'上册',
       units:['时、分、秒','万以内的加法和减法（一）','测量','万以内的加法和减法（二）','倍的认识','多位数乘一位数','长方形和正方形','分数的初步认识','数学广角——集合']},
      {id:'c2',version:'人教版',subject:'语文',grade:'三年级',volume:'上册',
       units:['第一单元 学校生活','第二单元 金秋时节','第三单元 童话世界','第四单元 预测策略','第五单元 观察发现','第六单元 祖国山河','第七单元 自然馈赠','第八单元 美好品质']},
      {id:'c3',version:'人教版',subject:'数学',grade:'七年级',volume:'上册',
       units:['有理数','整式的加减','一元一次方程','几何图形初步']}
    ],
    students:[
      {id:'s1',name:'王小明',gender:'男',sno:'2024001',cls:'三年级1班',grade:'三年级',phone:'138****1234',note:'',tags:['课堂活跃'],
       profile:{birth:'2017-03-12',nation:'汉',politics:'群众',boarding:'走读',status:'在读',gradSchool:'实验小学',stuNo:'2024001',enroll:'2024-09-01',eduStatus:'正常'},
       parents:[{name:'王强',relation:'父亲',phone:'138****1234',career:'工程师',comm:'配合'},{name:'刘芳',relation:'母亲',phone:'139****0001',career:'教师',comm:'积极'}],
       eval:{quality:'良好',award:'校级三好学生',discipline:'无违纪',help:'加强阅读量'}},
      {id:'s2',name:'李思雨',gender:'女',sno:'2024002',cls:'三年级1班',grade:'三年级',phone:'139****5678',note:'',tags:['学习优秀']},
      {id:'s3',name:'张浩然',gender:'男',sno:'2024003',cls:'三年级1班',grade:'三年级',phone:'136****2233',note:'计算基础需加强',tags:['基础薄弱','需要关注'],
       profile:{birth:'2017-06-08',nation:'汉',politics:'群众',boarding:'走读',status:'在读',gradSchool:'实验小学',stuNo:'2024003',enroll:'2024-09-01',eduStatus:'正常'},
       parents:[{name:'张伟',relation:'父亲',phone:'136****2233',career:'个体经营',comm:'配合'},{name:'陈丽',relation:'母亲',phone:'137****2233',career:'护士',comm:'一般'}],
       eval:{quality:'合格',award:'',discipline:'课堂违纪1次已教育',help:'每日进位竖式打卡+错题回练'}},
      {id:'s4',name:'陈雨桐',gender:'女',sno:'2024004',cls:'三年级1班',grade:'三年级',phone:'137****8899',note:'',tags:['进步明显']},
      {id:'s5',name:'刘子轩',gender:'男',sno:'2024005',cls:'三年级1班',grade:'三年级',phone:'135****4455',note:'作业经常迟交',tags:['作业拖拉']},
      {id:'s6',name:'赵欣怡',gender:'女',sno:'2024006',cls:'三年级1班',grade:'三年级',phone:'132****6677',note:'',tags:[]},
      {id:'s7',name:'孙一鸣',gender:'男',sno:'2024007',cls:'三年级1班',grade:'三年级',phone:'133****9900',note:'',tags:['课堂活跃']},
      {id:'s8',name:'周静怡',gender:'女',sno:'2024008',cls:'三年级1班',grade:'三年级',phone:'186****1122',note:'性格内向，多鼓励',tags:['心理敏感'],
       profile:{birth:'2017-09-21',nation:'汉',politics:'群众',boarding:'走读',status:'在读',gradSchool:'实验小学',stuNo:'2024008',enroll:'2024-09-01',eduStatus:'正常'},
       parents:[{name:'周涛',relation:'父亲',phone:'186****1122',career:'公务员',comm:'积极'},{name:'杨柳',relation:'母亲',phone:'187****1122',career:'会计',comm:'配合'}],
       eval:{quality:'良好',award:'书法比赛二等奖',discipline:'无违纪',help:'多给课堂展示机会，提升自信'}},
      {id:'s9',name:'吴宇航',gender:'男',sno:'2107001',cls:'七年级3班',grade:'七年级',phone:'186****3344',note:'',tags:['学习优秀']},
      {id:'s10',name:'郑晓彤',gender:'女',sno:'2107002',cls:'七年级3班',grade:'七年级',phone:'187****5566',note:'',tags:[]},
      {id:'s11',name:'冯凯',gender:'男',sno:'2107003',cls:'七年级3班',grade:'七年级',phone:'150****7788',note:'数学方程部分薄弱',tags:['基础薄弱']},
      {id:'s12',name:'杨梦琪',gender:'女',sno:'2107004',cls:'七年级3班',grade:'七年级',phone:'151****9911',note:'',tags:['进步明显']}
    ],
    lessons:[
      {id:'l1',grade:'三年级',subject:'数学',version:'人教版',volume:'上册',unit:'多位数乘一位数',title:'笔算乘法（不进位）',period:'第1课时',
       goals:'1. 理解多位数乘一位数（不进位）的笔算算理。\n2. 掌握竖式计算的书写格式，能正确计算。\n3. 培养认真书写、细心计算的习惯。',
       core:'数感、运算能力、推理意识',
       keyPoints:'掌握多位数乘一位数（不进位）笔算的计算方法与竖式格式。',
       difficulties:'理解"用一位数分别去乘多位数每一位"的算理。',
       prepare:'课件、小棒、练习纸',
       process:'一、复习导入（5分钟）\n口算：20×3、300×2、12×4，说说口算方法。\n\n二、探究新知（15分钟）\n1. 出示例题：12×3，先用小棒摆一摆。\n2. 引导学生尝试竖式书写，讨论从个位乘起的道理。\n3. 归纳笔算方法：相同数位对齐，从个位乘起。\n\n三、巩固练习（15分钟）\n完成教材"做一做"，同桌互批，展示典型错误并讲评。\n\n四、课堂小结（5分钟）\n这节课学会了什么？计算时要注意什么？',
       board:'笔算乘法（不进位）\n  1 2\n×   3\n-----\n  3 6\n相同数位对齐，从个位乘起',
       practice:'1. 竖式计算：23×3、32×2、11×5。\n2. 改错题：出示两道典型错误竖式，找错并改正。',
       homework:'必做：练习册第42页1-3题。\n选做：编一道生活中的乘法应用题并解答。',
       reflection:'',tags:['新授课'],files:[{name:'笔算乘法课件.pptx',size:'2.1MB'}]},
      {id:'l2',grade:'三年级',subject:'语文',version:'人教版',volume:'上册',unit:'第二单元 金秋时节',title:'古诗三首·山行',period:'第1课时',
       goals:'1. 会认"径、斜"等生字，正确朗读并背诵《山行》。\n2. 借助注释理解诗句大意，想象深秋山景。\n3. 体会诗人对秋天的喜爱之情。',
       core:'语言运用、审美创造、文化自信',
       keyPoints:'朗读背诵古诗，理解诗句意思。',
       difficulties:'想象"霜叶红于二月花"的画面，体会情感。',
       prepare:'课件、生字卡片、秋景图片',
       process:'一、看图导入（5分钟）：出示秋天山林图片，引出课题。\n二、初读古诗（10分钟）：自由读—指名读—正音—齐读。\n三、品读理解（18分钟）：借助注释逐句理解，重点品析"停车坐爱枫林晚"。\n四、背诵积累（7分钟）：多种形式背诵，配乐诵读。',
       board:'山行（唐·杜牧）\n远景：寒山、石径、白云、人家\n近景：枫林晚、霜叶红\n情感：喜爱秋天',
       practice:'1. 给生字注音组词。\n2. 用自己的话说说"白云生处有人家"的意思。',
       homework:'背诵并默写《山行》，为诗配一幅画。',
       reflection:'学生对"坐"字的古义理解有困难，下次可补充更多古今异义的例子。',tags:['新授课','公开课'],files:[]},
      {id:'l3',grade:'七年级',subject:'数学',version:'人教版',volume:'上册',unit:'一元一次方程',title:'解一元一次方程——移项',period:'第2课时',
       goals:'1. 理解移项法则，会用移项解一元一次方程。\n2. 经历"等式性质→移项"的推导过程，体会转化思想。',
       core:'运算能力、推理能力、模型观念',
       keyPoints:'移项法则的正确使用。',
       difficulties:'移项要变号，理解其依据是等式的性质。',
       prepare:'课件、导学案',
       process:'一、复习等式性质。\n二、由 3x+20=4x-25 引入移项。\n三、归纳移项法则：移项要变号。\n四、例题精讲+分层练习。\n五、小结与检测。',
       board:'移项：把等式一边的某项变号后移到另一边\n3x-4x = -25-20\n-x = -45\nx = 45',
       practice:'解方程：(1) 5x-7=2x+8  (2) 8-3x=x+4',
       homework:'教材第91页习题3.2第2、3题。',
       reflection:'',tags:['新授课'],files:[{name:'移项导学案.docx',size:'56KB'}]}
    ],
    mistakes:[
      {id:'m1',studentId:'s3',cls:'三年级1班',grade:'三年级',subject:'数学',source:'单元测试',examName:'第六单元测试',
       img:'',ocr:'竖式计算：24×3\n学生答案：62（错误：个位2×3=6，十位2×3=6，写成62）',
       qtype:'计算题',kp:'多位数乘一位数',reason:'方法不会',answer:'72',
       analysis:'24×3：个位4×3=12，写2进1；十位2×3=6，加进位1得7，结果为72。学生未掌握进位方法。',
       corrected:'已订正',count:2,reviewed:true,mastered:false},
      {id:'m2',studentId:'s5',cls:'三年级1班',grade:'三年级',subject:'数学',source:'课后作业',examName:'练习册P40',
       img:'',ocr:'一根绳子长36米，剪成同样长的4段，每段长多少米？\n学生列式：36×4=144（米）',
       qtype:'应用题',kp:'除法的应用',reason:'审题不清',answer:'36÷4=9（米）',
       analysis:'求"每段长多少"是平均分问题，应用除法。学生没有理解题意就套用乘法。',
       corrected:'未订正',count:1,reviewed:false,mastered:false},
      {id:'m3',studentId:'s8',cls:'三年级1班',grade:'三年级',subject:'语文',source:'单元测试',examName:'第二单元测试',
       img:'',ocr:'看拼音写词语：jìng（  ）\n学生写成"经"，正确为"径"（石径斜）',
       qtype:'填空题',kp:'生字词·同音字辨析',reason:'概念不熟',answer:'径',
       analysis:'"径"指小路，与"经"同音不同义。可结合诗句"远上寒山石径斜"记忆。',
       corrected:'已订正',count:1,reviewed:true,mastered:true},
      {id:'m4',studentId:'s11',cls:'七年级3班',grade:'七年级',subject:'数学',source:'周测',examName:'第10周周测',
       img:'',ocr:'解方程：5x-7=2x+8\n学生解：5x-2x=8-7 → 3x=1 → x=1/3（移项未变号）',
       qtype:'计算题',kp:'一元一次方程·移项',reason:'概念不熟',answer:'x=5',
       analysis:'-7从左边移到右边应变为+7：5x-2x=8+7，3x=15，x=5。移项必须变号。',
       corrected:'未订正',count:3,reviewed:true,mastered:false}
    ],
    exams:[
      {id:'e1',name:'第六单元测试',type:'单元测试',date:'2026-06-10',grade:'三年级',cls:'三年级1班',subject:'数学',full:100,
       kps:[{name:'多位数乘一位数',rate:68},{name:'倍的认识',rate:82},{name:'长方形和正方形',rate:75},{name:'解决问题',rate:64}],
       records:[
        {sid:'s1',name:'王小明',score:88,gradeRank:'',qscore:'',note:''},
        {sid:'s2',name:'李思雨',score:96,gradeRank:'',qscore:'',note:''},
        {sid:'s3',name:'张浩然',score:52,gradeRank:'',qscore:'',note:'计算失分多'},
        {sid:'s4',name:'陈雨桐',score:79,gradeRank:'',qscore:'',note:''},
        {sid:'s5',name:'刘子轩',score:63,gradeRank:'',qscore:'',note:''},
        {sid:'s6',name:'赵欣怡',score:85,gradeRank:'',qscore:'',note:''},
        {sid:'s7',name:'孙一鸣',score:91,gradeRank:'',qscore:'',note:''},
        {sid:'s8',name:'周静怡',score:74,gradeRank:'',qscore:'',note:''}]},
      {id:'e0',name:'第五单元测试',type:'单元测试',date:'2026-05-20',grade:'三年级',cls:'三年级1班',subject:'数学',full:100,
       kps:[{name:'倍的认识',rate:70},{name:'口算乘法',rate:80}],
       records:[
        {sid:'s1',name:'王小明',score:85,gradeRank:'',qscore:'',note:''},
        {sid:'s2',name:'李思雨',score:94,gradeRank:'',qscore:'',note:''},
        {sid:'s3',name:'张浩然',score:58,gradeRank:'',qscore:'',note:''},
        {sid:'s4',name:'陈雨桐',score:66,gradeRank:'',qscore:'',note:''},
        {sid:'s5',name:'刘子轩',score:60,gradeRank:'',qscore:'',note:''},
        {sid:'s6',name:'赵欣怡',score:83,gradeRank:'',qscore:'',note:''},
        {sid:'s7',name:'孙一鸣',score:92,gradeRank:'',qscore:'',note:''},
        {sid:'s8',name:'周静怡',score:70,gradeRank:'',qscore:'',note:''}]}
    ],
    attends:[
      {id:'at1',date:'2026-07-01',cls:'三年级1班',rows:[{sid:'s3',name:'张浩然',status:'迟到',note:'早读迟到5分钟'},{sid:'s5',name:'刘子轩',status:'事假',note:'家长带去复查牙齿'}]},
      {id:'at2',date:'2026-07-02',cls:'三年级1班',rows:[{sid:'s8',name:'周静怡',status:'病假',note:'感冒发烧在家休息'}]}
    ],
    leaves:[
      {id:'lv1',sid:'s5',name:'刘子轩',cls:'三年级1班',type:'事假',start:'2026-07-01',end:'2026-07-01',reason:'家长带去复查牙齿',approve:'已批准'},
      {id:'lv2',sid:'s8',name:'周静怡',cls:'三年级1班',type:'病假',start:'2026-07-02',end:'2026-07-03',reason:'感冒发烧',approve:'待审批'}
    ],
    contacts:[
      {id:'ct1',date:'2026-06-28',stuName:'张浩然',cls:'三年级1班',type:'电话',topic:'计算基础薄弱',content:'向家长反馈近期单元测试计算失分多，建议在家每天练习5道竖式。',result:'家长配合，已约定每日打卡',followup:'两周后回访计算进步情况'},
      {id:'ct2',date:'2026-07-05',stuName:'周静怡',cls:'三年级1班',type:'微信',topic:'性格内向多鼓励',content:'就孩子课堂不敢发言与家长沟通，建议多给孩子展示机会。',result:'家长表示理解并感谢',followup:''}
    ],
    homeworks:[
      {id:'hw1',date:'2026-07-01',cls:'三年级1班',subject:'数学',title:'竖式计算练习',layer:'必做',content:'练习册第42页1-3题',deadline:'2026-07-02',unsub:['刘子轩'],note:''},
      {id:'hw2',date:'2026-07-03',cls:'三年级1班',subject:'语文',title:'古诗背诵+配画',layer:'分层作业',content:'必做：背诵默写《山行》；选做：为诗配一幅画',deadline:'2026-07-05',unsub:[],note:'鼓励选做'}
    ],
    observes:[
      {id:'ob1',date:'2026-06-20',observer:'李老师',teacher:'王老师',subject:'数学',grade:'三年级',cls:'三年级1班',title:'笔算乘法（不进位）',score:88,dims:{目标:'清晰',内容:'充实',方法:'生动',效果:'良好',素养:'到位'},comments:'课堂节奏紧凑，练习设计有层次，建议增加小组互评环节。',suggestion:'在巩固练习环节加入同桌互批与典型错例展示。'}
    ],
    tutors:[
      {id:'tu1',sid:'s3',name:'张浩然',cls:'三年级1班',subject:'数学',type:'补差',reason:'计算基础薄弱，进位易错',plan:'每日5道进位竖式+错题回练',status:'进行中',records:[{date:'2026-07-01',content:'完成进位竖式5道，正确4道',progress:'有进步'}]},
      {id:'tu2',sid:'s2',name:'李思雨',cls:'三年级1班',subject:'语文',type:'培优',reason:'学有余力，写作可拔高',plan:'每周一篇随笔+古诗拓展',status:'进行中',records:[]}
    ],
    reflections:[
      {id:'rf1',date:'2026-07-01',subject:'数学',chapter:'多位数乘一位数',cls:'三年级1班',tag:'新授课',content:'进位算理学生理解较慢，小棒操作环节帮助较大。',improve:'下次增加"先估后算"环节，并准备易错对比练习。',effect:'良好'},
      {id:'rf2',date:'2026-07-02',subject:'语文',chapter:'古诗三首·山行',cls:'三年级1班',tag:'新授课',content:'"坐"的古今异义是难点，学生易错。',improve:'补充更多古今异义例子，结合语境记忆。',effect:'良好'}
    ],
    disciplines:[
      {id:'dp1',date:'2026-07-01',name:'刘子轩',cls:'三年级1班',type:'作业未完成',note:'数学练习册未交，已提醒',handle:'课后补做并面批',status:'已处理'},
      {id:'dp2',date:'2026-07-03',name:'张浩然',cls:'三年级1班',type:'课堂违纪',note:'上课转笔影响他人',handle:'课间谈话，约定专注',status:'已处理'},
      {id:'dp3',date:'2026-07-05',name:'孙一鸣',cls:'三年级1班',type:'课间打闹',note:'走廊追跑',handle:'安全教育，写保证书',status:'跟进中'}
    ],
    activities:[
      {id:'ac1',date:'2026-06-15',title:'《做时间的主人》主题班会',type:'主题班会',cls:'三年级1班',content:'引导学生制定周末计划，分享时间管理小妙招。',template:'班会'},
      {id:'ac2',date:'2026-05-20',title:'春季研学——走进植物园',type:'研学旅行',cls:'三年级1班',content:'观察植物生长，完成观察日记。',template:'研学'}
    ],
    courseChanges:[
      {id:'cc1',date:'2026-07-04',fromSubj:'数学',toSubj:'体育',fromTime:'周三第2节',toTime:'周五第4节',reason:'学校运动会彩排占用操场',note:''},
      {id:'cc2',date:'2026-07-08',fromSubj:'语文',toSubj:'语文',fromTime:'周二第1节',toTime:'周四第3节',reason:'调休串课',note:''}
    ],
    worklogs:[
      {id:'wl1',date:'2026-07-01',type:'教学',title:'完成第六单元试卷讲评',content:'重点讲解进位计算与解决问题，布置分层巩固。',cls:'三年级1班'},
      {id:'wl2',date:'2026-07-03',type:'家校沟通',title:'与张浩然家长电话沟通',content:'反馈计算薄弱，约定每日5道竖式打卡。',cls:'三年级1班'},
      {id:'wl3',date:'2026-07-05',type:'班级管理',title:'处理课间打闹事件',content:'对孙一鸣进行安全教育，班级重申课间纪律。',cls:'三年级1班'}
    ]
  };
}

let DB;
try{ DB = JSON.parse(localStorage.getItem(DB_KEY)) || seedData(); }
catch(e){ DB = seedData(); }
let _saveTimer=null;
function save(){
  // 本地兜底（始终写一份，保证离线可用）
  try{ localStorage.setItem(DB_KEY, JSON.stringify(DB)); }catch(e){ toast('本地存储空间不足，图片过多时请删除部分图片'); }
  // 云端同步（防抖，失败不阻断本地）
  if(ONLINE){
    clearTimeout(_saveTimer);
    _saveTimer=setTimeout(()=>{ api.save(DB).catch(e=>console.warn('云端保存失败:',e.message)); }, 400);
  }
}

/* ==================== 2. 工具函数 ==================== */
function uid(){ return 'id'+Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function jsEsc(s){ return String(s==null?'':s).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\n/g,'\\n').replace(/\r/g,'\\r'); }
function nl2br(s){ return esc(s).replace(/\n/g,'<br>'); }
function today(){ return new Date().toISOString().slice(0,10); }
function toast(msg){
  const t=document.getElementById('toast'); t.textContent=msg;
  t.classList.remove('pop'); void t.offsetWidth; t.classList.add('show','pop');
  clearTimeout(t._tm); t._tm=setTimeout(()=>t.classList.remove('show'),2600);
}
function stuById(id){ return DB.students.find(s=>s.id===id); }
function stuName(id){ const s=stuById(id); return s?s.name:'（未关联）'; }
function matchQ(q, fields){
  if(!q) return true;
  const key=String(q).toLowerCase();
  const text=fields.map(f=>String(f==null?'':f)).join(' ').toLowerCase();
  return text.includes(key);
}

/* ---- 弹窗 ---- */
function openModal(title, bodyHtml, footHtml, narrow){
  document.getElementById('modalTitle').textContent=title;
  document.getElementById('modalBody').innerHTML=bodyHtml;
  document.getElementById('modalFoot').innerHTML=footHtml||'<button class="btn" onclick="closeModal()">关闭</button>';
  document.getElementById('modalBox').className=narrow?'narrow':'';
  document.getElementById('modalMask').classList.remove('hidden');
}
function closeModal(){ document.getElementById('modalMask').classList.add('hidden'); }
function fv(id){ const el=document.getElementById(id); return el?el.value.trim():''; }
function pills(boxId){ return [...document.querySelectorAll('#'+boxId+' .check-pill.on')].map(p=>p.dataset.v); }
function pillHtml(boxId, options, selected){
  return `<div class="check-group" id="${boxId}">`+options.map(o=>
    `<span class="check-pill ${selected&&selected.includes(o)?'on':''}" data-v="${esc(o)}" onclick="this.classList.toggle('on')">${esc(o)}</span>`).join('')+`</div>`;
}
function optHtml(arr, sel, blank){
  let h = blank? `<option value="">${blank}</option>`:'';
  return h + arr.map(v=>`<option ${v===sel?'selected':''}>${esc(v)}</option>`).join('');
}

/* ---- 导出 / 打印 ---- */
function download(filename, blob){
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename;
  document.body.appendChild(a); a.click(); a.remove();
}
function exportWordDoc(filename, bodyHtml){
  const html=`<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${esc(filename)}</title><style>
  body{font-family:SimSun;font-size:12pt;line-height:1.8}
  h1{text-align:center;font-size:17pt;font-family:SimHei} h2{font-size:13pt;font-family:SimHei}
  table{border-collapse:collapse;width:100%} td,th{border:1pt solid #000;padding:4pt;font-size:10.5pt;vertical-align:top}
  th{background:#f0f0f0;font-family:SimHei}
  .p-space-normal{height:75pt;border-bottom:1pt dashed #999}
  .p-space-large{height:155pt;border-bottom:1pt dashed #999}
  .p-space-xlarge{height:270pt;border-bottom:1pt dashed #999}
  .p-ans{background:#f5f5f5;border:1pt solid #999;padding:4pt;font-size:10pt}
  .p-info-line{border-bottom:1pt solid #000;padding-bottom:4pt}
  pre{white-space:pre-wrap;font-family:SimSun;font-size:11pt}
  img{max-width:100%;border:1pt solid #999}
  </style></head><body>${bodyHtml}</body></html>`;
  download(filename+'.doc', new Blob(['\ufeff'+html],{type:'application/msword'}));
  toast('Word 文档已导出：'+filename+'.doc');
}
function doPrint(bodyHtml){
  document.getElementById('printArea').innerHTML=`<div class="p-doc">${bodyHtml}</div>`;
  setTimeout(()=>window.print(),100);
}
function exportPDFDoc(bodyHtml){
  doPrint(bodyHtml);
  toast('已打开打印窗口：在"目标打印机"中选择「另存为PDF」即可导出PDF');
}

/* 学情报告样式（供 Word 导出时内联，避免独立文档丢失卡片样式） */
const RPT_CSS=`
.rpt{font-size:14px;color:#26343f}
.rpt-header{background:linear-gradient(135deg,#2f7fd1 0%,#4aa3e3 100%);border-radius:14px;padding:26px 28px;color:#fff;display:flex;justify-content:space-between;align-items:center;gap:20px;box-shadow:0 1px 2px rgba(31,95,168,.05),0 6px 18px rgba(31,95,168,.07);margin-bottom:16px}
.rpt-header h1{font-size:26px;font-weight:700;margin:10px 0 7px;color:#fff;letter-spacing:.5px}
.rpt-type{display:inline-block;background:rgba(255,255,255,.22);color:#fff;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:600}
.rpt-meta{font-size:13px;opacity:.93}
.rpt-header-score{text-align:center;background:rgba(255,255,255,.18);border-radius:16px;padding:18px 30px;min-width:130px}
.rpt-header-score span{display:block;font-size:12px;opacity:.9}
.rpt-header-score b{display:block;font-size:42px;font-weight:700;line-height:1.1}
.rpt-judge{background:#f1f7ff;border-left:4px solid #2f7fd1;border-radius:12px;padding:13px 17px;margin:16px 0;display:flex;align-items:center;gap:10px;color:#33415c;font-size:13px}
.rpt-kpi-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:16px 0}
.rpt-kpi{background:#fff;border-radius:14px;padding:16px;display:flex;align-items:center;gap:13px;box-shadow:0 1px 2px rgba(31,95,168,.05),0 6px 18px rgba(31,95,168,.07);border:1px solid #eef3f8;transition:.15s}
.rpt-kpi .rpt-ico{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;color:#fff;background:#2f7fd1;flex:0 0 44px}
.rpt-kpi div span{display:block;font-size:12px;color:#7a8aa0}
.rpt-kpi div b{font-size:22px;color:#26343f}
.kpi-avg .rpt-ico{background:linear-gradient(135deg,#2f7fd1,#4aa3e3)}.kpi-max .rpt-ico{background:linear-gradient(135deg,#2e9e6b,#56cc9d)}.kpi-min .rpt-ico{background:linear-gradient(135deg,#5b6b78,#8fa0ad)}.kpi-exc .rpt-ico{background:linear-gradient(135deg,#27ae60,#56cc9d)}.kpi-pass .rpt-ico{background:linear-gradient(135deg,#2f7fd1,#4aa3e3)}.kpi-low .rpt-ico{background:linear-gradient(135deg,#d9534f,#ff7b7b)}
.rpt-card{background:#fff;border-radius:14px;padding:20px;box-shadow:0 1px 2px rgba(31,95,168,.05),0 6px 18px rgba(31,95,168,.07);border:1px solid #eef3f8}
.rpt-card-full{margin:16px 0}
.rpt-card-title{font-size:15px;font-weight:700;color:#26343f;display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap}
.rpt-sub{font-size:12px;color:#8fa0ad;font-weight:400;margin-left:auto}
.rpt-dot{width:10px;height:10px;border-radius:50%;display:inline-block;background:#ccc;flex:0 0 10px}
.rpt-dot.blue{background:#2f7fd1}.rpt-dot.green{background:#2e9e6b}.rpt-dot.orange{background:#e6a817}.rpt-dot.red{background:#d9534f}.rpt-dot.purple{background:#7b68ee}.rpt-dot.teal{background:#17a2b8}.rpt-dot.pink{background:#e91e63}
.rpt-grid-2{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;margin:16px 0}
.rpt-chart svg{display:block;margin:0 auto;max-width:100%}
.rpt-donut{display:flex;justify-content:center;padding:6px 0}
.rpt-mini{width:100%;border-collapse:collapse;margin-top:12px;font-size:12px}
.rpt-mini th,.rpt-mini td{padding:8px 10px;text-align:left;border-bottom:1px solid #eef3f8}
.rpt-mini th{color:#5b6b78;font-weight:600;background:#fbfdff}
.rpt-mini tr:last-child td{border-bottom:none}
.rpt-layer-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
.rpt-layer-card{border-radius:14px;padding:15px;background:#f8fbff;border:1px solid #e6f0fa}
.rpt-layer-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.rpt-layer-head b{font-size:14px;color:#26343f}
.rpt-layer-head span{font-size:11px;color:#7a8aa0;background:#fff;padding:3px 9px;border-radius:12px;border:1px solid #eef3f8}
.rpt-layer-body{display:flex;flex-wrap:wrap;gap:7px;min-height:26px}
.rpt-tag{font-size:12px;padding:4px 9px;border-radius:7px;background:#eef3f8;color:#33415c}
.rpt-tag.tag-green{background:#e6f5ee;color:#1e7e4a}.rpt-tag.tag-blue{background:#eaf3fb;color:#1f5fa8}.rpt-tag.tag-yellow{background:#fdf4dd;color:#946c08}.rpt-tag.tag-red{background:#fbe9e8;color:#a82420}
.layer-green{background:#f1fbf4;border-color:#d6f0dd}.layer-blue{background:#f1f7ff;border-color:#d6e6fb}.layer-yellow{background:#fdfbf3;border-color:#f5e9c8}.layer-red{background:#fdf5f5;border-color:#f6dcdc}
.rpt-empty{font-size:13px;color:#8fa0ad;padding:6px 0}
.rpt-list{list-style:none;padding:0;margin:0}
.rpt-list li{position:relative;padding:10px 0 10px 24px;border-bottom:1px solid #f4f7fa;color:#33415c;font-size:13px;line-height:1.6}
.rpt-list li:last-child{border-bottom:none}
.rpt-list li:before{content:'';position:absolute;left:0;top:14px;width:8px;height:8px;border-radius:50%;background:#2f7fd1}
.rpt-advice-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
.rpt-advice-item{border-radius:14px;padding:14px;background:#f8fbff;border:1px solid #e6f0fa}
.rpt-advice-item b{display:block;font-size:13px;color:#26343f;margin-bottom:5px}
.rpt-advice-item p{font-size:12px;color:#5b6b78;line-height:1.5;margin:0}
.donut-box{text-align:center;padding:8px 0}
.donut-pills{display:flex;justify-content:center;gap:10px;flex-wrap:wrap;margin-top:14px}
.donut-pill{display:inline-flex;align-items:center;gap:6px;background:#f8fbff;border:1px solid #e6f0fa;border-radius:20px;padding:6px 12px;font-size:12px;color:#33415c}
.donut-pill i{width:9px;height:9px;border-radius:50%}
.donut-pill b{font-weight:600}
.donut-pill span{color:#7a8aa0}
`;

/* ---- CSV ---- */
function parseCSVText(text){
  return text.replace(/^\ufeff/,'').split(/\r?\n/).map(l=>l.trim()).filter(l=>l)
    .map(l=>l.split(/[,，\t]/).map(c=>c.trim()));
}
function readFileText(file, cb){
  const r=new FileReader(); r.onload=e=>cb(e.target.result); r.readAsText(file,'utf-8');
}
/* 解析 Excel(.xlsx/.xls)：读取第一个工作表，返回二维数组 [[...],[...]]；库未加载时回调 null */
function readXlsx(file, cb){
  if(typeof XLSX==='undefined'){ toast('Excel 解析库未加载（需联网首次使用），请改用粘贴或 CSV 文件'); cb(null); return; }
  const r=new FileReader();
  r.onload=e=>{ try{
    const wb=XLSX.read(new Uint8Array(e.target.result),{type:'array'});
    const ws=wb.Sheets[wb.SheetNames[0]];
    const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:''}).map(r=>r.map(c=>c==null?'':String(c).trim()));
    cb(rows);
  }catch(err){ toast('Excel 解析失败：'+(err.message||err)); cb(null); } };
  r.readAsArrayBuffer(file);
}
/* 浏览器端 OCR 识别（Tesseract.js，支持中英文），返回识别文本；库不可用时返回空串 */
function runOCR(file){
  return new Promise(resolve=>{
    if(typeof Tesseract==='undefined'){ resolve(''); return; }
    Tesseract.recognize(file,'chi_sim+eng',{ logger:()=>{} })
      .then(({data})=>resolve((data.text||'').trim()))
      .catch(()=>resolve(''));
  });
}

/* ==================== 3. 路由与全局筛选 ==================== */
const F={q:'',grade:'',subject:'',cls:''};
const NAVS=[
  {id:'dashboard',ico:'台',label:'首页仪表盘',color:'blue'},
  {id:'lessons',ico:'备',label:'备课资源库',color:'purple'},
  {id:'mistakes',ico:'错',label:'错题管理库',color:'red'},
  {id:'scores',ico:'成',label:'成绩分析库',color:'green'},
  {id:'trend',ico:'趋',label:'成绩趋势对比',color:'green'},
  {id:'papers',ico:'卷',label:'试卷/习题生成',color:'orange'},
  {id:'mybank',ico:'库',label:'我的题库',color:'indigo'},
  {id:'reflection',ico:'思',label:'课后反思',color:'cyan'},
  {id:'homework',ico:'业',label:'作业管理',color:'amber'},
  {id:'research',ico:'研',label:'教研与跟踪',color:'slate'},
  {id:'students',ico:'生',label:'学生与班级管理',color:'teal'},
  {id:'growth',ico:'档',label:'学生成长档案',color:'teal'},
  {id:'attend',ico:'勤',label:'考勤与请假',color:'rose'},
  {id:'contact',ico:'联',label:'家校沟通',color:'violet'},
  {id:'discipline',ico:'纪',label:'违纪统计',color:'red'},
  {id:'activities',ico:'活',label:'班级活动',color:'orange'},
  {id:'worklog',ico:'痕',label:'工作留痕',color:'slate'},
  {id:'headteacher',ico:'班',label:'班主任仪表盘',color:'blue'},
  {id:'timetable',ico:'课',label:'课表与教学计划',color:'cyan'},
  {id:'coursechange',ico:'换',label:'换课记录',color:'violet'},
  {id:'calendar',ico:'历',label:'待办与工作日历',color:'slate'},
  {id:'tools',ico:'具',label:'教师工具箱',color:'yellow'},
  {id:'backup',ico:'备',label:'数据备份',color:'gray'},
  {id:'settings',ico:'设',label:'基础设置',color:'gray'}
];
const NAV_GROUPS=[
  {g:'教学工作区', ids:['dashboard','lessons','mistakes','scores','trend','papers','mybank','reflection','homework','research']},
  {g:'班主任工作区', ids:['students','growth','attend','contact','discipline','activities','worklog','headteacher']},
  {g:'课表管理区', ids:['timetable','coursechange','calendar','tools']},
  {g:'系统设置', ids:['backup','settings']}
];
let current='dashboard';

function navBadgeCount(id){
  switch(id){
    case 'attend': return DB.leaves.filter(l=>l.approve==='待审批').length;
    case 'homework': return DB.homeworks.filter(h=>(h.unsub||[]).length>0).length;
    case 'contact': return DB.contacts.filter(c=>(c.followup||'').trim()).length;
    case 'discipline': return DB.disciplines.filter(d=>d.status==='跟进中').length;
    case 'calendar': return DB.todos.filter(t=>!t.done).length;
    default: return 0;
  }
}
function renderNav(){
  ensureSchema();
  const map={}; NAVS.forEach(n=>map[n.id]=n);
  const html=NAV_GROUPS.map(grp=>{
    const items=grp.ids.map(id=>map[id]).filter(Boolean).map(n=>{
      const cnt=navBadgeCount(n.id);
      return `<div class="nav-item ${n.id===current?'active':''}" onclick="nav('${n.id}')"><span class="nav-ico ico-${n.color}">${n.ico}</span>${n.label}${cnt?`<span class="nav-badge">${cnt}</span>`:''}</div>`;
    }).join('');
    return `<div class="nav-group"><div class="nav-group-title">${grp.g}</div>${items}</div>`;
  }).join('');
  document.getElementById('navList').innerHTML=html;
}
function fillGlobalSelects(){
  document.getElementById('gGrade').innerHTML=optHtml(DB.meta.grades,F.grade,'全部年级');
  document.getElementById('gSubject').innerHTML=subSelectOptions(F.subject,'全部学科');
  document.getElementById('gClass').innerHTML=clsSelectOptions(F.cls,'全部班级');
}
function onGlobalFilter(){
  F.q=document.getElementById('gSearch').value.trim();
  F.grade=document.getElementById('gGrade').value;
  const gSub=document.getElementById('gSubject');
  if(gSub.value==='__add__'){
    const name=prompt('请输入新学科名称（如：信息技术、劳动、心理健康）：');
    if(name&&name.trim()){ subjectAdd(name.trim()); F.subject=name.trim(); }
    else { gSub.value=F.subject||''; }
    gSub.innerHTML=subSelectOptions(F.subject,'全部学科');
    return;
  }
  F.subject=gSub.value;
  const gCls=document.getElementById('gClass');
  if(gCls.value==='__add__'){
    const name=prompt('请输入新班级名称（如：三年级1班、七年级3班）：');
    if(name&&name.trim()){ classAdd(name.trim()); F.cls=name.trim(); }
    else { gCls.value=F.cls||''; }
    gCls.innerHTML=clsSelectOptions(F.cls,'全部班级');
    return;
  }
  F.cls=gCls.value;
  render();
}
function ensureSchema(){
  ['attends','leaves','contacts','homeworks','observes','tutors','timetables','growth','todos','plans',
   'reflections','disciplines','activities','courseChanges','worklogs'].forEach(k=>{ if(!Array.isArray(DB[k])) DB[k]=[]; });
  if(!DB.meta) DB.meta={};
  const defaults={
    grades:['一年级','二年级','三年级','四年级','五年级','六年级','七年级','八年级','九年级'],
    subjects:['语文','数学','英语','道德与法治','科学','物理','化学','生物','历史','地理'],
    classes:[],
    examTypes:['单元测试','周测','月考','期中考试','期末考试','模拟考试','随堂练习'],
    lessonTags:['新授课','复习课','练习课','公开课','期中复习','期末复习'],
    reasons:['审题不清','计算错误','概念不熟','方法不会','步骤不完整','书写不规范','粗心','时间不够','其他'],
    qtypes:['选择题','填空题','判断题','计算题','应用题','阅读题','简答题','作文题','实验题','综合题'],
    stuTags:['学习优秀','进步明显','基础薄弱','课堂活跃','作业拖拉','需要关注','心理敏感','纪律提醒'],
    disciplineTypes:['课堂违纪','作业未完成','迟到早退','仪容仪表','课间打闹','其他'],
    activityTypes:['主题班会','班级活动','社会实践','研学旅行','节日庆祝','其他'],
    worklogTypes:['教学','班级管理','教研','家校沟通','其他'],
    qualityLevels:['优秀','良好','合格','待提升']
  };
  Object.keys(defaults).forEach(k=>{ if(!Array.isArray(DB.meta[k])||!DB.meta[k].length) DB.meta[k]=defaults[k].slice(); });
  DB.students.forEach(s=>{
    if(!s.profile) s.profile={birth:'',nation:'汉',politics:'群众',boarding:'走读',status:'在读',gradSchool:'',stuNo:s.sno||'',enroll:'',eduStatus:'正常'};
    if(!Array.isArray(s.parents)) s.parents=[];
    if(!s.eval) s.eval={quality:'',award:'',discipline:'',help:''};
  });
}
function classList(){
  // 班级列表完全由老师在「班级管理」中维护，不再自动从学生记录里收集，避免示例/旧数据污染下拉框
  return Array.from(DB.meta.classes||[]).sort((a,b)=>a.localeCompare(b,'zh'));
}
function clsSelectHtml(value,id,allLabel,attrs='',onchange=''){
  const list=classList();
  let opts='';
  if(allLabel!==undefined) opts+=`<option value="">${allLabel}</option>`;
  list.forEach(c=>{ opts+=`<option value="${esc(c)}" ${c===value?'selected':''}>${esc(c)}</option>`; });
  opts+=`<option value="__add__">+ 新增班级</option>`;
  const oc=onchange?`; ${onchange}`:'';
  return `<select id="${id}" onfocus="this.dataset.prevVal=this.value" onchange="clsSelectAdd(this)${oc}" ${attrs}>${opts}</select>`;
}
function clsSelectAdd(el){
  if(el.value!=='__add__') return;
  const name=prompt('请输入新班级名称（如：三年级1班、七年级3班）：');
  if(name&&name.trim()){
    const n=name.trim();
    classAdd(n);
    const allLabel=el.options[0]&&el.options[0].value===''?el.options[0].text:undefined;
    el.innerHTML=clsSelectOptions(n, allLabel);
    el.value=n;
    el.dispatchEvent(new Event('change'));
  } else {
    el.value=el.dataset.prevVal||'';
  }
}
function clsSelectOptions(value,allLabel){
  const list=classList();
  let opts='';
  if(allLabel!==undefined) opts+=`<option value="">${allLabel}</option>`;
  list.forEach(c=>{ opts+=`<option value="${esc(c)}" ${c===value?'selected':''}>${esc(c)}</option>`; });
  opts+=`<option value="__add__">+ 新增班级</option>`;
  return opts;
}
function classAdd(name){
  if(!name||!name.trim()) return false;
  const n=name.trim();
  if(!DB.meta.classes) DB.meta.classes=[];
  if(!DB.meta.classes.includes(n)){
    DB.meta.classes.push(n);
    DB.meta.classes.sort((a,b)=>a.localeCompare(b,'zh'));
    save();
  }
  return true;
}
function classEdit(oldName,newName){
  const o=oldName.trim(), n=newName.trim();
  if(!o||!n||o===n) return;
  if(!DB.meta.classes.includes(o)) return;
  if(DB.meta.classes.includes(n)){ toast('该班级名称已存在'); return; }
  DB.meta.classes=DB.meta.classes.map(c=>c===o?n:c);
  DB.students.forEach(s=>{ if(s.cls===o) s.cls=n; });
  DB.exams.forEach(e=>{ if(e.cls===o) e.cls=n; });
  ['attends','leaves','contacts','homeworks','observes','tutors','timetables','plans','growth','disciplines','activities','courseChanges','worklogs'].forEach(k=>{
    DB[k].forEach(x=>{ if(x.cls===o) x.cls=n; });
  });
  save(); render();
}
function classDel(name){
  const n=name.trim();
  const used=DB.students.some(s=>s.cls===n)||DB.exams.some(e=>e.cls===n);
  if(used){ if(!confirm(`班级「${n}」已有学生或考试关联，删除后相关记录会保留但班级字段会变空，确定删除？`)) return; }
  else { if(!confirm(`确定删除班级「${n}」？`)) return; }
  DB.meta.classes=DB.meta.classes.filter(c=>c!==n);
  DB.students.forEach(s=>{ if(s.cls===n) s.cls=''; });
  DB.exams.forEach(e=>{ if(e.cls===n) e.cls=''; });
  ['attends','leaves','contacts','homeworks','observes','tutors','timetables','plans','growth','disciplines','activities','courseChanges','worklogs'].forEach(k=>{
    DB[k].forEach(x=>{ if(x.cls===n) x.cls=''; });
  });
  save(); render();
}

/* 学科下拉：与班级下拉同样支持「+ 新增学科」 */
function subjectList(){ return Array.from(DB.meta.subjects||[]).sort((a,b)=>a.localeCompare(b,'zh')); }
function subSelectHtml(value,id,allLabel,attrs='',onchange=''){
  const list=subjectList();
  let opts='';
  if(allLabel!==undefined) opts+=`<option value="">${allLabel}</option>`;
  list.forEach(s=>{ opts+=`<option value="${esc(s)}" ${s===value?'selected':''}>${esc(s)}</option>`; });
  opts+=`<option value="__add__">+ 新增学科</option>`;
  const oc=onchange?`; ${onchange}`:'';
  return `<select id="${id}" onfocus="this.dataset.prevVal=this.value" onchange="subSelectAdd(this)${oc}" ${attrs}>${opts}</select>`;
}
function subSelectAdd(el){
  if(el.value!=='__add__') return;
  const name=prompt('请输入新学科名称（如：信息技术、劳动、心理健康）：');
  if(name&&name.trim()){
    const n=name.trim();
    subjectAdd(n);
    const allLabel=el.options[0]&&el.options[0].value===''?el.options[0].text:undefined;
    el.innerHTML=subSelectOptions(n, allLabel);
    el.value=n;
    el.dispatchEvent(new Event('change'));
  } else {
    el.value=el.dataset.prevVal||'';
  }
}
function subSelectOptions(value,allLabel){
  const list=subjectList();
  let opts='';
  if(allLabel!==undefined) opts+=`<option value="">${allLabel}</option>`;
  list.forEach(s=>{ opts+=`<option value="${esc(s)}" ${s===value?'selected':''}>${esc(s)}</option>`; });
  opts+=`<option value="__add__">+ 新增学科</option>`;
  return opts;
}
function subjectAdd(name){
  if(!name||!name.trim()) return false;
  const n=name.trim();
  if(!DB.meta.subjects) DB.meta.subjects=[];
  if(!DB.meta.subjects.includes(n)){
    DB.meta.subjects.push(n);
    DB.meta.subjects.sort((a,b)=>a.localeCompare(b,'zh'));
    save(); fillGlobalSelects();
  }
  return true;
}
function classEditPrompt(oldName){ const n=prompt('修改班级名称',oldName); if(n&&n.trim()) classEdit(oldName,n.trim()); }
function classDelPrompt(name){ classDel(name); }
function classClearAll(){
  if(!DB.meta.classes||!DB.meta.classes.length){ toast('班级列表已经是空的'); return; }
  if(!confirm(`确定一键清空班级列表中的 ${DB.meta.classes.length} 个班级吗？\n\n注意：\n1. 学生、考试等记录会保留，但相关记录的「班级」字段将变空；\n2. 所有班级下拉框将变为空，你需要重新添加自己的班级。`)) return;
  const cleared=[...DB.meta.classes];
  DB.meta.classes=[];
  DB.students.forEach(s=>{ if(cleared.includes(s.cls)) s.cls=''; });
  DB.exams.forEach(e=>{ if(cleared.includes(e.cls)) e.cls=''; });
  ['attends','leaves','contacts','homeworks','observes','tutors'].forEach(k=>{
    DB[k].forEach(x=>{ if(cleared.includes(x.cls)) x.cls=''; });
  });
  F.cls='';
  save(); fillGlobalSelects(); render(); toast('班级列表已清空，请添加自己的班级');
}
function nav(page){ current=page; renderNav(); render(); closeNavMobile(); }
function closeNavMobile(){
  if(window.innerWidth<=768){
    const sb=document.getElementById('sidebar'), bd=document.getElementById('navBackdrop');
    if(sb) sb.classList.remove('sidebar-open');
    if(bd) bd.classList.remove('show');
  }
}
function toggleNav(){
  const sb=document.getElementById('sidebar'); if(!sb) return;
  const bd=document.getElementById('navBackdrop');
  const open=sb.classList.toggle('sidebar-open');
  if(bd) bd.classList.toggle('show', open);
}
function render(){
  ensureSchema();
  const fn={dashboard:renderDashboard,lessons:renderLessons,mistakes:renderMistakes,scores:renderScores,
            trend:renderTrend,papers:renderPapers,mybank:renderBank,students:renderStudents,
            timetable:renderTimetable,growth:renderGrowth,attend:renderAttend,contact:renderContact,homework:renderHomework,research:renderResearch,
            calendar:renderCalendar,tools:renderTools,settings:renderSettings,backup:renderBackup,
            reflection:renderReflection,discipline:renderDiscipline,activities:renderActivities,
            coursechange:renderCourseChange,worklog:renderWorklog,headteacher:renderHeadTeacher}[current];
  if(!fn){ toast('未知页面: '+current); return; }
  try{ fn(); }catch(e){ console.error(e); const p=document.getElementById('page'); if(p) p.innerHTML='<div class="card" style="color:#a82420"><b>页面加载失败</b><br>'+esc(e&&e.message?e.message:String(e))+'<br><button class="btn" onclick="render()">重试</button></div>'; }
  window.scrollTo(0,0);
}

/* 模块通用工具条 */
function moduleToolbar(btns){
  return `<div class="toolbar">${btns.join('')}</div>`;
}

/* ==================== 4. 首页仪表盘 ==================== */
/* 精致 SVG 图标（currentColor 随卡片主题变色） */
function svgIcon(viewBox,path,cls=''){ return `<svg class="dash-icon ${cls}" viewBox="${viewBox}" fill="none" xmlns="http://www.w3.org/2000/svg">${path}</svg>`; }
const iconTodo=()=>svgIcon('0 0 24 24','<rect x="3" y="5" width="18" height="16" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M8 11.5l2.5 2.5L17 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 5V3M16 5V3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>');
const iconBook=()=>svgIcon('0 0 24 24','<path d="M4 19.5A2.5 2.5 0 016.5 17H20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 7h8M8 11h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>');
const iconWarn=()=>svgIcon('0 0 24 24','<path d="M12 3l9 16H3L12 3z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 10v4M12 17h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>');
const iconTrend=()=>svgIcon('0 0 24 24','<path d="M3 17l6-6 4 4 7-9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 4h4v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>');
const iconTeacher=()=>svgIcon('0 0 200 200','<defs><clipPath id="tFace"><ellipse cx="100" cy="84" rx="42" ry="45"/></clipPath></defs><path d="M50 165c0-22 22-38 50-38s50 16 50 38v30H50z" fill="#a7e9d4"/><path d="M58 165c0-16 18-28 42-28s42 12 42 28v30H58z" fill="#8bdcc2"/><path d="M95 145v24l5 8 5-8v-24" fill="#fff"/><path d="M98 152h4v20h-4z" fill="#e86a8a"/><ellipse cx="100" cy="84" rx="42" ry="45" fill="#f8d5c2"/><path d="M58 80c0-32 18-52 42-52s42 20 42 52c0 4-2 6-5 5-6-8-16-12-26-12s-26 4-32 12c-3 1-6-1-6-5-8-2-13 4-15 12z" fill="#5fc4a8"/><path d="M68 52c6-10 18-16 32-16s26 6 32 16c-8-4-18-4-26 0-10-4-22-4-32 0-2-1-4-1-6 0z" fill="#4bb093"/><path d="M73 82c0-14 11-20 20-20h14c9 0 20 6 20 20v4c0 6-4 10-10 10H83c-6 0-10-4-10-10z" fill="#5fc4a8"/><circle cx="72" cy="100" r="4" fill="#f4a6b7" opacity=".7"/><circle cx="128" cy="100" r="4" fill="#f4a6b7" opacity=".7"/><circle cx="85" cy="92" r="5.5" fill="#fff"/><circle cx="85" cy="92" r="5.5" fill="none" stroke="#4a4a4a" stroke-width="1.8"/><circle cx="85" cy="92" r="2" fill="#3a3a3a"/><circle cx="115" cy="92" r="5.5" fill="#fff"/><circle cx="115" cy="92" r="5.5" fill="none" stroke="#4a4a4a" stroke-width="1.8"/><circle cx="115" cy="92" r="2" fill="#3a3a3a"/><path d="M82 82c0-8 8-14 18-14s18 6 18 14" stroke="#4a4a4a" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M93 118c4 4 10 4 14 0" stroke="#d66a6a" stroke-width="2.5" fill="none" stroke-linecap="round"/><path d="M80 76h40" stroke="#4a4a4a" stroke-width="1.8" fill="none"/><ellipse cx="100" cy="126" rx="9" ry="5" fill="#f4a6b7" opacity=".6"/><path d="M55 155c10-8 24-12 45-12s35 4 45 12" stroke="#7bccb3" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M100 145l-18 16c-2 2-2 5 0 7l18 12 18-12c2-2 2-5 0-7z" fill="#fff" stroke="#e2e8f0" stroke-width="1.5"/><path d="M100 145v25" stroke="#e2e8f0" stroke-width="1.5"/><path d="M87 156l13 6 13-6" stroke="#f87171" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M86 162l14 6 14-6" stroke="#f87171" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M60 102c-2 0-4 2-4 4v20c0 2 2 4 4 4" stroke="#5fc4a8" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M140 102c2 0 4 2 4 4v20c0 2-2 4-4 4" stroke="#5fc4a8" stroke-width="5" fill="none" stroke-linecap="round"/>');
const iconBell=()=>svgIcon('0 0 18 18','<path d="M9 2a4 4 0 00-4 4v3l-2 2h12l-2-2V6a4 4 0 00-4-4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M10 14a1 1 0 01-2 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>');
const iconFlag=()=>svgIcon('0 0 18 18','<path d="M4 2v14M4 3l9 4-9 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>');
const iconExam=()=>svgIcon('0 0 18 18','<path d="M4 3h10a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V4a1 1 0 011-1z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 7h6M6 10h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>');
const iconLesson=()=>svgIcon('0 0 18 18','<path d="M3 5a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V5z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 4v11M12 4v11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>');

function dashCard(iconHTML,title,sub,badge,barPct,barTxt,btn1,btn2,colorCls){
  barPct=Math.max(0,Math.min(100,barPct||0));
  return `<div class="dash-card dash-${colorCls}">
    <div class="dash-top">
      <div class="dash-emoji">${iconHTML}</div>
      <div class="dash-info">
        <div class="dash-title">${title}</div>
        <div class="dash-sub">${sub}</div>
      </div>
      <div class="dash-badge">${badge}</div>
    </div>
    <div class="dash-progress">
      <div class="dash-bar"><span style="width:${barPct}%"></span></div>
      <div class="dash-progress-txt">${barTxt}</div>
    </div>
    <div class="dash-actions">${btn1}${btn2}</div>
  </div>`;
}
function renderDashboard(){
  const unMastered=DB.mistakes.filter(m=>!m.mastered).length;
  const unCorrected=DB.mistakes.filter(m=>m.corrected!=='已订正').length;
  const focusStu=DB.students.filter(s=>s.tags.includes('需要关注')||s.tags.includes('基础薄弱'));
  const latest=[...DB.exams].sort((a,b)=>b.date.localeCompare(a.date))[0];
  let dLayer=[];
  if(latest){ const a=calcExam(latest); dLayer=a.layers.D; }

  // 今日待办
  const tStr=today();
  const todosAll=DB.todos;
  const todayUndone=todosAll.filter(t=>!t.done&&t.date<=tStr);
  const todayDone=todosAll.filter(t=>t.done&&t.date<=tStr);
  const todoTotal=todayUndone.length+todayDone.length;
  const todoRate=todoTotal?Math.round(todayDone.length/todoTotal*100):100;

  // 本周课程（按当前星期几作为时间进度）
  const wd=new Date().getDay()||7;
  const weekRate=Math.round(wd/7*100);
  const ttCount=DB.timetables.length;

  // 学生预警
  const warnTotal=focusStu.length+dLayer.length;
  const warnRate=DB.students.length?Math.round(warnTotal/DB.students.length*100):0;

  // 成绩待分析（未订正错题占比）
  const exCount=DB.exams.length;
  const anaRate=exCount?100:0;
  const unAnalyzed=unCorrected;

  const banner=`<div class="dash-banner">
    <div class="dash-banner-emoji"><img src="banner-teacher.png" alt="老师插画" class="banner-teacher-img"></div>
    <div class="dash-banner-text">
      <div class="dash-banner-title">欢迎回来，老师 <span style="font-size:20px;vertical-align:-2px">👋</span></div>
      <div class="dash-banner-sub">今天是 ${tStr} · 您有 ${todayUndone.length} 项待办、${warnTotal} 个学生需要关注。一起把今天安排好～</div>
    </div>
    <div class="dash-banner-actions">
      <button class="btn btn-primary" onclick="nav('lessons');setTimeout(lessonAdd,50)">+ 新建备课</button>
      <button class="btn" onclick="nav('mistakes');setTimeout(mistakeAdd,50)">+ 录入错题</button>
      <button class="btn" onclick="nav('scores');setTimeout(examAdd,50)">+ 新建考试</button>
    </div>
  </div>`;

  const cards=`<div class="dash-grid">
    ${dashCard(iconTodo(),'今日待办', todayUndone.length?`还有 ${todayUndone.length} 项待完成`:'今日已清空，棒！', todayUndone.length, todoRate, `完成度 ${todoRate}%`,
      `<button class="btn btn-sm" onclick="nav('calendar')">查看日历</button>`,
      `<button class="btn btn-sm btn-primary" onclick="todoAdd('${tStr}')">+ 新增待办</button>`, 'blue')}
    ${dashCard(iconBook(),'本周课程', ttCount?`已排 ${ttCount} 节课`:'还没排课哦', ttCount, weekRate, `本周已过 ${weekRate}%`,
      `<button class="btn btn-sm" onclick="nav('timetable')">打开课表</button>`,
      `<button class="btn btn-sm btn-primary" onclick="nav('timetable')">+ 教学进度</button>`, 'cyan')}
    ${dashCard(iconWarn(),'学生预警', warnTotal?`${focusStu.length} 名需关注 · ${dLayer.length} 名D层`:'暂无风险学生', warnTotal, warnRate, `占在册 ${warnRate}%`,
      `<button class="btn btn-sm" onclick="nav('students')">学生管理</button>`,
      `<button class="btn btn-sm btn-primary" onclick="nav('scores')">成绩分析</button>`, 'rose')}
    ${dashCard(iconTrend(),'成绩待分析', unAnalyzed?`${unAnalyzed} 道错题待订正`:`已记录 ${exCount} 场考试`, unAnalyzed, anaRate, exCount?`${exCount} 场已分析`:'待录入',
      `<button class="btn btn-sm" onclick="nav('mistakes')">错题库</button>`,
      `<button class="btn btn-sm btn-primary" onclick="nav('scores');setTimeout(examAdd,50)">+ 新建考试</button>`, 'green')}
  </div>`;

  // 教学数据总览（各模块迷你可视化）
  const hwAvg=DB.homeworks.length?Math.round(DB.homeworks.reduce((s,h)=>s+hwStatsOf(h).submitRate,0)/DB.homeworks.length):0;
  const hwPending=DB.homeworks.filter(h=>(h.unsub||[]).length>0).length;
  const contactFollow=DB.contacts.filter(c=>(c.followup||'').trim()!=='').length;
  const mMastered=DB.mistakes.filter(m=>m.mastered).length;
  const mCorrected=DB.mistakes.filter(m=>m.corrected==='已订正'&&!m.mastered).length;
  const mRest=DB.mistakes.length-mMastered-mCorrected;
  const recentExams=[...DB.exams].sort((a,b)=>a.date.localeCompare(b.date)).slice(-6);
  const examTrend=recentExams.map(e=>({label:e.date.slice(5),value:+calcExam(e).avg}));
  const wkMonth=today().slice(0,7);
  const monthTodos=DB.todos.filter(t=>t.date.slice(0,7)===wkMonth);
  const monthDone=monthTodos.filter(t=>t.done).length;
  const monthRate=monthTodos.length?Math.round(monthDone/monthTodos.length*100):0;
  const activeCounts=[{label:'备课',val:DB.lessons.length,color:'#2f80ed'},{label:'反思',val:DB.reflections.length,color:'#0891b2'},{label:'听课',val:DB.observes.length,color:'#7c3aed'},{label:'活动',val:DB.activities.length,color:'#d97706'}];
  const maxA=Math.max(1,...activeCounts.map(a=>a.val));
  const vizCard=(icon,title,tint,chart,insight)=>`<div class="card card-tint-${tint}" style="margin:0">
    <div class="card-title">${cardTitleIcon(icon,title)}</div>
    <div class="viz-body">${chart}</div>
    <div class="viz-insight">${insight}</div>
  </div>`;
  const wHw=vizCard(ICO_CLIPBOARD,'作业收缴','amber',
    donutSVG([{label:'已交',value:hwAvg,color:'#2e9e6b'},{label:'未交',value:100-hwAvg,color:'#e57373'}],150,130),
    hwPending?`<b>${hwPending}</b> 次作业有待收缴`:`平均收缴率 <b>${hwAvg}%</b>`);
  const wContact=vizCard(ICO_CHAT,'家校沟通','violet',
    donutSVG([{label:'已跟进',value:contactFollow,color:'#2e9e6b'},{label:'待跟进',value:Math.max(0,DB.contacts.length-contactFollow),color:'#e6a817'}],150,130),
    `${contactFollow} 条待跟进 · 共 ${DB.contacts.length} 条`);
  const wMistake=vizCard(ICO_BOOK,'错题掌握','green',
    DB.mistakes.length?donutSVG([{label:'已掌握',value:mMastered,color:'#2e9e6b'},{label:'待巩固',value:mCorrected,color:'#e6a817'},{label:'未订正',value:mRest,color:'#d9534f'}],150,130):'<div class="empty">暂无错题</div>',
    `${mRest} 道待订正 · 共 ${DB.mistakes.length} 道`);
  const wTodo=vizCard(ICO_CHECK,'本月待办','cyan',
    monthTodos.length?donutSVG([{label:'已完成',value:monthDone,color:'#2e9e6b'},{label:'未完成',value:monthTodos.length-monthDone,color:'#9aa7b2'}],150,130):'<div class="empty">本月暂无待办</div>',
    `完成率 <b>${monthRate}%</b>`);
  const wExam=vizCard(ICO_CHART,'成绩走势','blue',
    recentExams.length?lineChartSVG(examTrend,250,130):'<div class="empty">暂无考试</div>',
    recentExams.length?`最近 ${recentExams.length} 场平均分走势`:'录入考试后显示');
  const wActive=vizCard(ICO_BULB,'教学活跃','slate',
    `<div class="viz-bars">${activeCounts.map(a=>`<div class="viz-bar-row"><span class="viz-bar-label">${a.label}</span><span class="viz-bar-track"><span class="viz-bar-fill" style="width:${Math.round(a.val/maxA*100)}%;background:${a.color}"></span></span><span class="viz-bar-val">${a.val}</span></div>`).join('')}</div>`,
    `累计教学沉淀 ${DB.lessons.length+DB.reflections.length+DB.observes.length+DB.activities.length} 条`);
  const vizSection=`<div class="viz-section-h">📊 教学数据总览</div>
  <div class="viz-grid">${wHw}${wContact}${wMistake}${wTodo}${wExam}${wActive}</div>`;

  const todoList=todayUndone.slice(0,4).map(t=>`<div class="mini-row" onclick="nav('calendar')"><span class="mini-dot mini-${todoColor(t.type)}"></span><b>${esc(t.title)}</b><span class="muted">${t.date}${t.time?' '+t.time:''}</span></div>`).join('')||'<div class="empty-mini">🎉 今日暂无待办，享受轻松时刻～</div>';

  document.getElementById('page').innerHTML=
    wbHead('首页仪表盘','title-blue','您的一天教学总览')+
    `${banner}
  ${cards}
  ${vizSection}
  <div class="dash-bottom">
    <div class="card dash-mini">
      <div class="card-title">${iconBell()} 今日待办清单</div>
      ${todoList}
    </div>
    <div class="card dash-mini">
      <div class="card-title">${iconFlag()} 待办提醒</div>
      ${unCorrected? `<div class="bar-row"><span class="tag tag-yellow">提醒</span>有 <b>${unCorrected}</b> 道错题未订正，<span class="link" onclick="nav('mistakes')">去处理 →</span></div>`:''}
      ${DB.mistakes.filter(m=>!m.reviewed).length? `<div class="bar-row"><span class="tag tag-yellow">提醒</span>有 <b>${DB.mistakes.filter(m=>!m.reviewed).length}</b> 道错题未讲评，可 <span class="link" onclick="genReviewList()">生成讲评清单 →</span></div>`:''}
      ${dLayer.length? `<div class="bar-row"><span class="tag tag-red">风险</span>最近考试（${esc(latest.name)}）有 <b>${dLayer.length}</b> 名D层重点关注：${dLayer.map(esc).join('、')}</div>`:''}
      ${focusStu.length? `<div class="bar-row"><span class="tag tag-red">关注</span>需关注/基础薄弱：${focusStu.map(s=>esc(s.name)).join('、')}</div>`:''}
      ${!unCorrected&&!dLayer.length&&!focusStu.length? `<div class="empty-mini">暂无待办事项，一切正常</div>`:''}
    </div>
    <div class="card dash-mini">
      <div class="card-title">${iconExam()} 最近考试</div>
      ${DB.exams.length? `<div class="tbl-wrap"><table class="tbl"><tr><th class="nosort">考试</th><th class="nosort">班级/学科</th><th class="nosort">日期</th><th class="nosort">平均分</th><th class="nosort">操作</th></tr>
        ${[...DB.exams].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5).map(e=>{const a=calcExam(e);return `<tr><td>${esc(e.name)}</td><td>${esc(e.cls)} · ${esc(e.subject)}</td><td>${e.date}</td><td class="num">${a.avg}</td><td><span class="link" onclick="examReport('${e.id}')">分析报告</span></td></tr>`;}).join('')}
      </table></div>`:'<div class="empty-mini">暂无考试记录</div>'}
    </div>
  </div>
  <div class="card">
    <div class="card-title">${iconLesson()} 最近备课</div>
    ${DB.lessons.length? `<div class="res-grid">${DB.lessons.slice(-3).reverse().map(lessonCardHtml).join('')}</div>`:'<div class="empty">暂无备课资源</div>'}
  </div>`;
}

/* ==================== 5. 备课资源库 ==================== */
let lessonTagFilter='';
function lessonCardHtml(l){
  return `<div class="res-card">
    <div class="res-title">${esc(l.title)}</div>
    <div class="res-meta">${esc(l.grade)} · ${esc(l.subject)} · ${esc(l.version)} · ${esc(l.volume)}<br>单元：${esc(l.unit)}　${esc(l.period)}</div>
    <div>${(l.tags||[]).map(t=>`<span class="tag tag-blue">${esc(t)}</span>`).join('')}
      ${(l.files||[]).map(f=>`<span class="tag tag-gray">📎 ${esc(f.name)}</span>`).join('')}</div>
    <div class="res-foot">
      <button class="btn btn-sm" onclick="lessonView('${l.id}')">查看</button>
      <button class="btn btn-sm" onclick="lessonEdit('${l.id}')">编辑</button>
      <button class="btn btn-sm" onclick="lessonExport('${l.id}','word')">Word</button>
      <button class="btn btn-sm" onclick="lessonExport('${l.id}','pdf')">PDF</button>
      <button class="btn btn-sm" onclick="lessonExport('${l.id}','print')">打印</button>
      <button class="btn btn-sm btn-danger" onclick="lessonDel('${l.id}')">删除</button>
    </div>
  </div>`;
}
function lessonList(){
  return DB.lessons.filter(l=>
    (!F.grade||l.grade===F.grade)&&(!F.subject||l.subject===F.subject)&&
    (!lessonTagFilter||(l.tags||[]).includes(lessonTagFilter))&&
    matchQ(F.q,[l.title,l.unit,l.grade,l.subject,l.version,l.volume,l.goals,l.keyPoints,l.difficulties,(l.tags||[]).join(' ')]));
}
function renderLessons(){
  const list=lessonList();
  document.getElementById('page').innerHTML=`
  <div class="page-head">
    <div><div class="page-title title-purple">备课资源库</div><div class="page-desc">按年级 / 学科 / 教材版本 / 单元 / 课时整理备课资料，支持模板生成与A4打印</div></div>
    ${moduleToolbar([
      `<button class="btn btn-primary" onclick="lessonAdd()">+ 新增备课</button>`,
      `<button class="btn" onclick="lessonAdd(true)">一键生成备课模板</button>`,
      `<button class="btn" onclick="toast('请在新增/编辑备课时通过附件区域上传 PPT、Word、PDF、图片')">上传附件</button>`
    ])}
  </div>
  <div class="card">
    <div class="filter-bar">
      <span class="filter-label">课型标签：</span>
      <select onchange="lessonTagFilter=this.value;render()">${optHtml(DB.meta.lessonTags,lessonTagFilter,'全部标签')}</select>
      <span class="filter-label">（年级/学科请使用顶部筛选栏，当前：${F.grade||'全部年级'} · ${F.subject||'全部学科'}）</span>
    </div>
    ${list.length? `<div class="res-grid">${list.map(lessonCardHtml).join('')}</div>`
      : `<div class="empty">暂无符合条件的备课资源<br><span class="link" onclick="lessonAdd()">点击新增第一份备课 →</span></div>`}
  </div>`;
}
const LESSON_TPL={
  goals:'1. 知识与技能：掌握本课核心知识点，能正确运用。\n2. 过程与方法：通过自主探究与合作交流，经历知识形成过程。\n3. 情感态度：激发学习兴趣，培养良好学习习惯。',
  core:'（按学科课标填写，如：语言运用 / 运算能力 / 科学思维 / 文化自信）',
  keyPoints:'（本课必须落实的核心知识与技能）',
  difficulties:'（学生最容易出错、最难理解的点）',
  prepare:'课件、学案、教具（板贴/卡片/实物）',
  process:'一、导入新课（5分钟）\n（情境/复习/问题导入）\n\n二、探究新知（15分钟）\n（活动设计、关键提问、学生活动）\n\n三、巩固练习（15分钟）\n（基础练习→变式练习→拓展练习）\n\n四、课堂小结（5分钟）\n（学生自主总结+教师提升）',
  board:'（主板书结构：课题 + 知识框架 + 例题示范）',
  practice:'1. 基础题：\n2. 变式题：\n3. 拓展题：',
  homework:'必做：\n选做：\n实践性作业：',
  reflection:'（课后填写：目标达成情况 / 学生问题 / 改进措施）'
};
function lessonForm(l){
  l=l||{};
  const cat=DB.catalogs.map(c=>c.units.map(u=>`<option value="${esc(u)}">`).join('')).join('');
  return `
  <div class="form-grid">
    <div class="form-item"><label>年级 <i>*</i></label><select id="f_grade">${optHtml(DB.meta.grades,l.grade||F.grade||'三年级')}</select></div>
    <div class="form-item"><label>学科 <i>*</i></label>${subSelectHtml(l.subject||F.subject||'数学','f_subject')}</div>
    <div class="form-item"><label>教材版本</label><select id="f_version">${optHtml(DB.meta.versions,l.version||'人教版')}</select></div>
    <div class="form-item"><label>册别</label><select id="f_volume">${optHtml(['上册','下册'],l.volume||'上册')}</select></div>
    <div class="form-item"><label>单元名称</label><input id="f_unit" list="unitList" value="${esc(l.unit||'')}" placeholder="可从教材目录选择"><datalist id="unitList">${cat}</datalist></div>
    <div class="form-item"><label>课题名称 <i>*</i></label><input id="f_title" value="${esc(l.title||'')}" placeholder="如：笔算乘法（不进位）"></div>
    <div class="form-item"><label>课时</label><input id="f_period" value="${esc(l.period||'第1课时')}"></div>
    <div class="form-item"><label>课型标签</label>${pillHtml('f_tags',DB.meta.lessonTags,l.tags||[])}</div>
    <div class="form-item full"><label>教学目标</label><textarea id="f_goals">${esc(l.goals||'')}</textarea></div>
    <div class="form-item full"><label>核心素养目标</label><textarea id="f_core" style="min-height:44px">${esc(l.core||'')}</textarea></div>
    <div class="form-item"><label>教学重点</label><textarea id="f_key">${esc(l.keyPoints||'')}</textarea></div>
    <div class="form-item"><label>教学难点</label><textarea id="f_diff">${esc(l.difficulties||'')}</textarea></div>
    <div class="form-item full"><label>教学准备</label><input id="f_prepare" value="${esc(l.prepare||'')}"></div>
    <div class="form-item full"><label>教学过程</label><textarea id="f_process" style="min-height:130px">${esc(l.process||'')}</textarea></div>
    <div class="form-item full"><label>板书设计</label><textarea id="f_board">${esc(l.board||'')}</textarea></div>
    <div class="form-item"><label>课堂练习</label><textarea id="f_practice">${esc(l.practice||'')}</textarea></div>
    <div class="form-item"><label>课后作业（作业设计）</label><textarea id="f_homework">${esc(l.homework||'')}</textarea></div>
    <div class="form-item full"><label>教学反思</label><textarea id="f_reflect">${esc(l.reflection||'')}</textarea></div>
    <div class="form-item full"><label>附件上传（PPT / Word / PDF / 图片）</label>
      <input type="file" id="f_files" multiple accept=".ppt,.pptx,.doc,.docx,.pdf,image/*" onchange="stageLessonFiles(this)">
      <div id="f_fileList">${(l.files||[]).map(f=>`<span class="tag tag-gray">📎 ${esc(f.name)}（${esc(f.size||'')}）</span>`).join('')}</div>
      <div class="form-hint">原型阶段保存文件名信息；接入服务器后可保存完整文件。</div>
    </div>
  </div>`;
}
let _stagedFiles=[];
function stageLessonFiles(input){
  _stagedFiles=[..._stagedFiles,...[...input.files].map(f=>({name:f.name,size:(f.size/1024/1024>1?(f.size/1048576).toFixed(1)+'MB':(f.size/1024).toFixed(0)+'KB')}))];
  document.getElementById('f_fileList').innerHTML=_stagedFiles.map(f=>`<span class="tag tag-gray">📎 ${esc(f.name)}（${f.size}）</span>`).join('');
  toast('已添加 '+input.files.length+' 个附件');
}
function lessonAdd(useTpl){
  _stagedFiles=[];
  const base=useTpl===true? Object.assign({},LESSON_TPL):{};
  openModal(useTpl===true?'新增备课（已填入标准备课模板）':'新增备课', lessonForm(base),
    `<button class="btn" onclick="fillLessonTpl()">套用备课模板</button>
     <button class="btn" onclick="closeModal()">取消</button>
     <button class="btn btn-primary" onclick="lessonSave('')">保存</button>`);
}
function fillLessonTpl(){
  const map={f_goals:'goals',f_core:'core',f_key:'keyPoints',f_diff:'difficulties',f_prepare:'prepare',f_process:'process',f_board:'board',f_practice:'practice',f_homework:'homework',f_reflect:'reflection'};
  for(const id in map){ const el=document.getElementById(id); if(el&&!el.value.trim()) el.value=LESSON_TPL[map[id]]; }
  toast('已按标准模板补全空白字段（含教学目标/核心素养/重难点/过程/作业设计等）');
}
function lessonEdit(id){
  _stagedFiles=[...(DB.lessons.find(x=>x.id===id).files||[])];
  openModal('编辑备课', lessonForm(DB.lessons.find(x=>x.id===id)),
    `<button class="btn" onclick="fillLessonTpl()">套用备课模板</button>
     <button class="btn" onclick="closeModal()">取消</button>
     <button class="btn btn-primary" onclick="lessonSave('${id}')">保存</button>`);
}
function lessonSave(id){
  if(!fv('f_title')){ toast('请填写课题名称'); return; }
  const obj={
    id:id||uid(),grade:fv('f_grade'),subject:fv('f_subject'),version:fv('f_version'),volume:fv('f_volume'),
    unit:fv('f_unit'),title:fv('f_title'),period:fv('f_period'),tags:pills('f_tags'),
    goals:fv('f_goals'),core:fv('f_core'),keyPoints:fv('f_key'),difficulties:fv('f_diff'),prepare:fv('f_prepare'),
    process:fv('f_process'),board:fv('f_board'),practice:fv('f_practice'),homework:fv('f_homework'),reflection:fv('f_reflect'),
    files:_stagedFiles
  };
  if(id){ const i=DB.lessons.findIndex(x=>x.id===id); DB.lessons[i]=obj; } else DB.lessons.push(obj);
  save(); closeModal(); render(); toast('备课已保存');
}
function lessonDel(id){
  if(!confirm('确定删除这份备课资源吗？')) return;
  DB.lessons=DB.lessons.filter(x=>x.id!==id); save(); render(); toast('已删除');
}
function lessonView(id){
  const l=DB.lessons.find(x=>x.id===id);
  openModal('备课详情 · '+l.title, lessonPrintHtml(l),
    `<button class="btn" onclick="lessonExport('${id}','word')">导出Word</button>
     <button class="btn" onclick="lessonExport('${id}','pdf')">导出PDF</button>
     <button class="btn btn-primary" onclick="lessonExport('${id}','print')">A4打印</button>
     <button class="btn" onclick="closeModal()">关闭</button>`);
}
function lessonPrintHtml(l){
  const meta=l.grade+l.subject+' · '+l.version+l.volume+' · '+l.unit+' · '+l.period;
  const block=(title,content,icon='')=>`
    <div style="background:#fff;border:1px solid #e8edf2;border-radius:12px;padding:16px;box-shadow:0 1px 3px rgba(31,95,168,.04)">
      <div style="font-size:13px;font-weight:600;color:#1f5fa8;margin-bottom:10px;display:flex;align-items:center;gap:6px">
        ${icon?'<span style="font-size:15px">'+icon+'</span>':''}<span>${title}</span>
      </div>
      <div style="line-height:1.75;color:#2c3e50;white-space:pre-wrap;font-size:13px">${esc(content||'—')}</div>
    </div>`;
  return `
  <div style="max-width:800px;margin:0 auto;padding:4px">
    <div style="text-align:center;margin-bottom:22px">
      <h1 style="font-size:24px;color:#1a2b3c;margin:0 0 8px">${esc(l.title)} 教学设计</h1>
      <div style="color:#5b6b78;font-size:13px">${esc(meta)}</div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:14px">
      ${block('教学目标',l.goals,'🎯')}
      ${block('核心素养目标',l.core,'🌟')}
      ${block('教学重点',l.keyPoints,'🔑')}
      ${block('教学难点',l.difficulties,'⚠️')}
      ${block('教学准备',l.prepare,'🎒')}
    </div>
    <div style="margin-bottom:14px">${block('教学过程',l.process,'📋')}</div>
    <div style="margin-bottom:14px">${block('板书设计',l.board,'📝')}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px">
      ${block('课堂练习',l.practice,'✏️')}
      ${block('作业设计',l.homework,'📚')}
      ${block('教学反思',l.reflection,'💡')}
    </div>
  </div>`;
}
function lessonExport(id,mode){
  const l=DB.lessons.find(x=>x.id===id); const html=lessonPrintHtml(l);
  if(mode==='word') exportWordDoc(l.title+'-教学设计',html);
  else if(mode==='pdf') exportPDFDoc(html);
  else doPrint(html);
}

/* ==================== 6. 错题管理库 ==================== */
const MF={stu:'',kp:'',qtype:'',reason:''};
function mistakeList(){
  return DB.mistakes.filter(m=>
    (!F.grade||m.grade===F.grade)&&(!F.subject||m.subject===F.subject)&&(!F.cls||m.cls===F.cls)&&
    (!MF.stu||m.studentId===MF.stu)&&(!MF.kp||m.kp.includes(MF.kp))&&
    (!MF.qtype||m.qtype===MF.qtype)&&(!MF.reason||m.reason===MF.reason)&&
    matchQ(F.q,[stuName(m.studentId),m.cls,m.subject,m.kp,m.ocr,m.examName,m.qtype,m.reason,m.note]));
}
function renderMistakes(){
  const list=mistakeList();
  const kps=[...new Set(DB.mistakes.map(m=>m.kp).filter(Boolean))];
  document.getElementById('page').innerHTML=`
  <div class="page-head">
    <div><div class="page-title title-red">错题管理库</div><div class="page-desc">拍照/图片上传 + OCR识别文本 + 手动校正（OCR接口已预留），支持变式题与A4错题本</div></div>
    ${moduleToolbar([
      `<button class="btn btn-primary" onclick="mistakeAdd()">+ 录入错题</button>`,
      `<button class="btn" onclick="mistakeBatch()">批量上传图片</button>`,
      `<button class="btn" onclick="genReviewList()">生成讲评清单</button>`,
      `<button class="btn" onclick="exportMistakeBook('word')">导出Word错题本</button>`,
      `<button class="btn" onclick="exportMistakeBook('pdf')">导出PDF</button>`,
      `<button class="btn" onclick="exportMistakeBook('print')">A4打印错题本</button>`
    ])}
  </div>
  <div class="card">
    <div class="filter-bar">
      <select onchange="MF.stu=this.value;render()">${optHtml2(DB.students.map(s=>[s.id,s.name+'（'+s.cls+'）']),MF.stu,'全部学生')}</select>
      <select onchange="MF.kp=this.value;render()">${optHtml(kps,MF.kp,'全部知识点')}</select>
      <select onchange="MF.qtype=this.value;render()">${optHtml(DB.meta.qtypes,MF.qtype,'全部题型')}</select>
      <select onchange="MF.reason=this.value;render()">${optHtml(DB.meta.reasons,MF.reason,'全部错误原因')}</select>
      <span class="filter-label">共 ${list.length} 道错题</span>
    </div>
    <div class="tbl-wrap"><table class="tbl">
      <tr><th class="nosort">学生</th><th class="nosort">学科/知识点</th><th class="nosort">题目摘要</th><th class="nosort">题型</th><th class="nosort">错误原因</th><th class="nosort">错题次数</th><th class="nosort">状态</th><th class="nosort">操作</th></tr>
      ${list.map(m=>`<tr>
        <td><span class="link" onclick="stuView('${m.studentId}')">${esc(stuName(m.studentId))}</span><br><span class="filter-label">${esc(m.cls)}</span></td>
        <td>${esc(m.subject)}<br><span class="tag tag-blue">${esc(m.kp||'未标注')}</span></td>
        <td style="max-width:260px">${m.img?`<img class="img-thumb" src="${m.img}" onclick="previewImg('${m.id}')"> `:''}${esc((m.ocr||'').slice(0,42))}${(m.ocr||'').length>42?'…':''}</td>
        <td>${esc(m.qtype)}</td><td><span class="tag tag-yellow">${esc(m.reason)}</span></td>
        <td class="num">${m.count||1}</td>
        <td>${m.corrected==='已订正'?'<span class="tag tag-green">已订正</span>':'<span class="tag tag-red">未订正</span>'}
            ${m.reviewed?'<span class="tag tag-green">已讲评</span>':'<span class="tag tag-yellow">待讲评</span>'}
            ${m.mastered?'<span class="tag tag-green">已掌握</span>':'<span class="tag tag-red">未掌握</span>'}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-sm" onclick="mistakeEdit('${m.id}')">编辑</button>
          <button class="btn btn-sm" onclick="genVariantsFor('${m.id}')">变式题</button>
          <button class="btn btn-sm" onclick="genPractice('${m.id}')">巩固练习</button>
          <button class="btn btn-sm btn-danger" onclick="mistakeDel('${m.id}')">删除</button>
        </td></tr>`).join('') || '<tr><td colspan="8"><div class="empty">暂无错题，点击上方「录入错题」或「批量上传图片」</div></td></tr>'}
    </table></div>
  </div>`;
}
function optHtml2(pairs, sel, blank){
  return `<option value="">${blank}</option>`+pairs.map(([v,t])=>`<option value="${esc(v)}" ${v===sel?'selected':''}>${esc(t)}</option>`).join('');
}
let _stagedImg='';
function mistakeForm(m){
  m=m||{};
  return `
  <div class="ocr-box">📷 上传题目图片后会自动 OCR 识别文字并填入下方「OCR识别文本」（支持中英文，首次需联网下载识别模型，约几秒~十几秒）。识别结果请务必校对，可在文本框直接修改。</div>
  <div class="form-grid">
    <div class="form-item"><label>学生 <i>*</i></label><select id="f_sid">${optHtml2(DB.students.map(s=>[s.id,s.name+'（'+s.cls+'）']),m.studentId,'请选择学生')}</select></div>
    <div class="form-item"><label>学科</label>${subSelectHtml(m.subject||F.subject||'数学','f_msub')}</div>
    <div class="form-item"><label>题目来源</label><select id="f_source">${optHtml(['单元测试','周测','月考','期中考试','期末考试','课后作业','课堂练习','其他'],m.source||'课后作业')}</select></div>
    <div class="form-item"><label>考试/作业名称</label><input id="f_exam" value="${esc(m.examName||'')}"></div>
    <div class="form-item full"><label>题目图片（拍照/上传）</label>
      <input type="file" accept="image/*" capture="environment" onchange="stageMistakeImg(this)">
      <div id="f_imgPrev">${m.img?`<img src="${m.img}" style="max-width:220px;max-height:150px;border-radius:8px;border:1px solid #dde7ef;margin-top:6px">`:''}</div>
    </div>
    <div class="form-item full"><label>OCR识别文本（可手动校正） <i>*</i></label><textarea id="f_ocr" style="min-height:90px" placeholder="OCR识别结果将显示在此处，当前请手动输入题目内容与学生错误答案">${esc(m.ocr||'')}</textarea></div>
    <div class="form-item"><label>题型</label><select id="f_qtype">${optHtml(DB.meta.qtypes,m.qtype||'计算题')}</select></div>
    <div class="form-item"><label>知识点</label><input id="f_kp" value="${esc(m.kp||'')}" placeholder="如：多位数乘一位数"></div>
    <div class="form-item"><label>错误原因</label><select id="f_reason">${optHtml(DB.meta.reasons,m.reason||'概念不熟')}</select></div>
    <div class="form-item"><label>错题次数</label><input id="f_count" type="number" min="1" value="${m.count||1}"></div>
    <div class="form-item full"><label>正确答案</label><textarea id="f_ans" style="min-height:44px">${esc(m.answer||'')}</textarea></div>
    <div class="form-item full"><label>解析</label><textarea id="f_ana">${esc(m.analysis||'')}</textarea></div>
    <div class="form-item"><label>订正状态</label><select id="f_corr">${optHtml(['未订正','已订正'],m.corrected||'未订正')}</select></div>
    <div class="form-item"><label>是否已讲评</label><select id="f_rev">${optHtml(['否','是'],m.reviewed?'是':'否')}</select></div>
    <div class="form-item"><label>是否已掌握</label><select id="f_mas">${optHtml(['否','是'],m.mastered?'是':'否')}</select></div>
    <div class="form-item full"><label style="display:flex;align-items:center;gap:6px;font-weight:400;color:#4a5d75"><input type="checkbox" id="f_tobank"> 录入后同时存入「我的题库」（沉淀为可复用资源）</label></div>
  </div>`;
}
function stageMistakeImg(input){
  const f=input.files[0]; if(!f) return;
  const r=new FileReader();
  r.onload=e=>{
    _stagedImg=e.target.result;
    document.getElementById('f_imgPrev').innerHTML=`<img src="${_stagedImg}" style="max-width:220px;max-height:150px;border-radius:8px;border:1px solid #dde7ef;margin-top:6px">`;
    const ocrEl=document.getElementById('f_ocr');
    if(ocrEl&&!ocrEl.value.trim()){
      if(typeof Tesseract!=='undefined'){
        toast('正在识别图片文字，请稍候…（首次约需下载识别模型）');
        runOCR(f).then(t=>{ if(t){ ocrEl.value=t; toast('OCR 识别完成，请校对'); } else { ocrEl.value=''; toast('识别为空，请手动录入题目内容'); } });
      }else{
        ocrEl.value='【OCR识别占位】图片已上传，OCR 库未加载（需联网），请手动录入题目内容。';
        toast('图片已上传，请在OCR文本区录入/校正题目内容');
      }
    }
  };
  r.readAsDataURL(f);
}
function mistakeAdd(){ _stagedImg=''; openModal('录入错题（拍照/上传 + OCR校正）', mistakeForm(),
  `<button class="btn" onclick="closeModal()">取消</button><button class="btn" onclick="mistakeSave('','continue')">保存并继续录入</button><button class="btn btn-primary" onclick="mistakeSave('')">保存</button>`); }
function mistakeEdit(id){ const m=DB.mistakes.find(x=>x.id===id); _stagedImg=m.img||'';
  openModal('编辑错题', mistakeForm(m),
  `<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="mistakeSave('${id}')">保存</button>`); }
function mistakeSave(id, mode){
  const sid=fv('f_sid'); if(!sid){ toast('请选择学生'); return; }
  if(!fv('f_ocr')){ toast('请填写题目内容（OCR识别文本区）'); return; }
  const stu=stuById(sid);
  const obj={id:id||uid(),studentId:sid,cls:stu.cls,grade:stu.grade,subject:fv('f_msub'),source:fv('f_source'),
    examName:fv('f_exam'),img:_stagedImg,ocr:fv('f_ocr'),qtype:fv('f_qtype'),kp:fv('f_kp'),reason:fv('f_reason'),
    answer:fv('f_ans'),analysis:fv('f_ana'),corrected:fv('f_corr'),count:+fv('f_count')||1,
    reviewed:fv('f_rev')==='是',mastered:fv('f_mas')==='是'};
  if(id){ const i=DB.mistakes.findIndex(x=>x.id===id); DB.mistakes[i]=obj; } else DB.mistakes.push(obj);
  const toBankEl=document.getElementById('f_tobank');
  if(toBankEl && toBankEl.checked){ bankPush({qtype:obj.qtype,subject:obj.subject,grade:stu?stu.grade:'',kp:obj.kp,level:'',text:obj.ocr,ans:obj.answer,ana:obj.analysis,source:'错题录入'}); }
  save();
  if(mode==='continue' && !id){
    toast('已保存，可继续录入下一道');
    ['f_ocr','f_kp','f_ans','f_ana'].forEach(x=>{ const e=document.getElementById(x); if(e) e.value=''; });
    const c=document.getElementById('f_count'); if(c) c.value='1';
    const p=document.getElementById('f_imgPrev'); if(p) p.innerHTML=''; _stagedImg='';
    const o=document.getElementById('f_ocr'); if(o) o.focus();
  } else { closeModal(); render(); toast('错题已保存'); }
}
function mistakeDel(id){ if(!confirm('确定删除这道错题吗？'))return; DB.mistakes=DB.mistakes.filter(x=>x.id!==id); save(); render(); }
function previewImg(id){ const m=DB.mistakes.find(x=>x.id===id);
  openModal('题目图片', `<img src="${m.img}" style="max-width:100%">`,'',true); }
function mistakeBatch(){
  openModal('批量上传错题图片',
   `<div class="ocr-box">选择多张错题照片，系统将为每张图片创建一条错题记录（OCR文本为占位，请之后逐条打开编辑校正）。</div>
    <div class="form-grid">
      <div class="form-item"><label>默认学生</label><select id="f_bsid">${optHtml2(DB.students.map(s=>[s.id,s.name+'（'+s.cls+'）']),'','请选择（可后期修改）')}</select></div>
      <div class="form-item"><label>默认学科</label>${subSelectHtml('数学','f_bsub')}</div>
      <div class="form-item full"><label>选择图片（可多选）</label><input type="file" id="f_bimgs" accept="image/*" multiple></div>
    </div>`,
   `<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="mistakeBatchSave()">创建错题记录</button>`,true);
}
async function mistakeBatchSave(){
  const files=[...document.getElementById('f_bimgs').files];
  if(!files.length){ toast('请先选择图片'); return; }
  const sid=fv('f_bsid'); const stu=sid?stuById(sid):null; const sub=fv('f_bsub');
  const useOcr=typeof Tesseract!=='undefined';
  if(useOcr) toast('正在逐张识别图片文字，请稍候…（共 '+files.length+' 张）');
  let done=0;
  for(const f of files){
    const img=await new Promise(res=>{ const r=new FileReader(); r.onload=e=>res(e.target.result); r.readAsDataURL(f); });
    const text=useOcr? await runOCR(f) : '';
    DB.mistakes.push({id:uid(),studentId:sid,cls:stu?stu.cls:'',grade:stu?stu.grade:'',subject:sub,source:'批量上传',
      examName:'',img:img,ocr:text?text:'【OCR识别为空，请编辑此记录手动录入题目内容】',
      qtype:'综合题',kp:'',reason:'其他',answer:'',analysis:'',corrected:'未订正',count:1,reviewed:false,mastered:false});
    if(++done===files.length){ save(); closeModal(); render(); toast('已创建 '+done+' 条错题记录（已尝试OCR识别），请逐条编辑完善'); }
  }
}
/* 讲评清单 */
function genReviewList(){
  const list=mistakeList().filter(m=>!m.reviewed);
  const all=list.length?list:mistakeList();
  if(!all.length){ toast('当前筛选条件下没有错题'); return; }
  const byKp={};
  all.forEach(m=>{ (byKp[m.kp||'未标注知识点']=byKp[m.kp||'未标注知识点']||[]).push(m); });
  let i=1;
  const kpCards=[];
  for(const kp in byKp){
    const items=byKp[kp];
    kpCards.push(`
      <div style="background:#fff;border:1px solid #e8edf2;border-radius:12px;padding:16px;margin-bottom:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
          <div style="font-size:14px;font-weight:600;color:#1f5fa8;display:flex;align-items:center;gap:6px"><span>📌</span><span>${esc(kp)}</span></div>
          <span class="tag tag-blue">${items.length} 题</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px">
          ${items.map(m=>`
            <div style="background:#fbfdfe;border:1px solid #eef3f8;border-radius:10px;padding:14px">
              <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:10px;flex-wrap:wrap">
                <span style="flex:0 0 28px;height:28px;border-radius:50%;background:#eef3ff;color:#1f5fa8;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700">${i++}</span>
                <div style="flex:1;min-width:200px;line-height:1.7;color:#1a2b3c;white-space:pre-wrap;font-size:13px">${esc(m.ocr)}</div>
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                <span class="tag tag-gray">${esc(stuName(m.studentId))}</span>
                <span class="tag tag-yellow">${esc(m.reason)}</span>
              </div>
              <div style="margin-top:10px;background:#fff;border-radius:8px;padding:10px;border:1px dashed #dde7ef;color:#5b6b78;font-size:13px;line-height:1.7;white-space:pre-wrap">${esc(m.analysis||'讲评要点：可在此处补充讲解思路与注意点')}</div>
            </div>`).join('')}
        </div>
      </div>`);
  }
  const html=`
    <div style="max-width:800px;margin:0 auto;padding:4px">
      <div style="text-align:center;margin-bottom:20px">
        <h1 style="font-size:22px;color:#1a2b3c;margin:0 0 6px">错题讲评清单</h1>
        <div style="color:#5b6b78;font-size:13px">生成日期：${today()} · 共 ${all.length} 题${list.length?'（未讲评）':''}</div>
      </div>
      ${kpCards.join('')}
    </div>`;
  openModal('错题讲评清单预览', html,
    `<button class="btn" onclick="markReviewed()">全部标记为已讲评</button>
     <button class="btn" onclick="exportWordDoc('错题讲评清单',document.getElementById('modalBody').innerHTML)">导出Word</button>
     <button class="btn" onclick="exportPDFDoc(document.getElementById('modalBody').innerHTML)">导出PDF</button>
     <button class="btn btn-primary" onclick="doPrint(document.getElementById('modalBody').innerHTML)">A4打印</button>
     <button class="btn" onclick="closeModal()">关闭</button>`);
}
function markReviewed(){ mistakeList().forEach(m=>m.reviewed=true); save(); toast('已全部标记为已讲评'); render(); }
/* 变式题生成（模板引擎，预留AI接口） */
function buildVariants(m){
  const kp=m.kp||'本题知识点';
  return [
    {level:'基础题（★）',q:`围绕「${kp}」的基础训练：仿照原题「${(m.ocr||'').split('\n')[0].slice(0,30)}…」，将数字/条件换成更简单的数据，考查最基本的方法。\n（示例题干，可直接编辑成具体题目）`,
     a:m.answer?('参考原题答案思路：'+m.answer):'（填写答案）',
     s:`本题直接考查「${kp}」的基本方法，与原题同结构、降低数据难度，用于确认学生是否掌握基本步骤。`},
    {level:'提高题（★★）',q:`「${kp}」变式：保持原题考点不变，改变情境或增加一个中间步骤（如先求中间量再求结果），检验学生是否真正理解而非套模板。\n（示例题干，可直接编辑成具体题目）`,
     a:'（填写答案）',
     s:`针对原题错误原因「${m.reason}」设计：${m.reason==='审题不清'?'加入干扰条件，训练圈画关键词。':m.reason==='计算错误'?'数据稍复杂，训练计算的准确率与验算习惯。':'增加一步推理，暴露概念理解漏洞。'}`},
    {level:'挑战题（★★★）',q:`「${kp}」综合应用：将本知识点与相邻知识点结合，设计一道开放性/综合性问题，鼓励多种解法。\n（示例题干，可直接编辑成具体题目）`,
     a:'（填写答案）',
     s:`拓展提升，适合A、B层学生；C、D层学生可选做。讲评时重点展示解题思路的多样性。`}
  ];
}
function stageVariantImg(idx, input){
  const f=input.files[0]; if(!f) return;
  window._variantImgs=window._variantImgs||[{}, {}, {}];
  const r=new FileReader();
  r.onload=e=>{
    window._variantImgs[idx]={name:f.name, data:e.target.result};
    const box=document.getElementById('vimg_prev_'+idx); if(!box) return;
    box.innerHTML=`<img src="${e.target.result}" style="max-width:220px;max-height:150px;border-radius:8px;border:1px solid #dde7ef">`+
      `<span style="color:#6b7b8f;font-size:12px;margin-left:8px">${esc(f.name)}</span>`;
  };
  r.readAsDataURL(f);
}
function genVariantsFor(id){
  const m=DB.mistakes.find(x=>x.id===id);
  const vs=buildVariants(m);
  window._variantImgs = window._variantImgs || [{},{},{}];
  const levelMeta=[
    {cls:'基础题', color:'#22a565', star:'★'},
    {cls:'提高题', color:'#f59e0b', star:'★★'},
    {cls:'挑战题', color:'#e5465e', star:'★★★'}
  ];
  const card=(v,i)=>{
    const meta=levelMeta[i];
    const img=(window._variantImgs&&window._variantImgs[i])||{};
    return `<div style="background:#fff;border:1px solid #dde7ef;border-radius:12px;box-shadow:0 2px 8px rgba(59,125,221,.06);margin-bottom:16px;overflow:hidden">
      <div style="background:#f6faff;padding:12px 16px;border-bottom:1px solid #eaf1f8;font-weight:600;color:${meta.color};font-size:15px;display:flex;align-items:center;gap:8px">
        <span style="width:26px;height:26px;background:${meta.color}15;color:${meta.color};border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:13px">${i+1}</span>
        <span>${esc(meta.cls)}（${meta.star}）</span>
      </div>
      <div style="padding:16px">
        <div class="form-item full" style="margin-bottom:12px"><label style="color:#3b7ddd;font-weight:600">题干</label><textarea id="vq${i}" style="min-height:80px;border:1px solid #e6f0f8;background:#fbfdff;border-radius:8px;padding:10px">${esc(v.q)}</textarea></div>
        <div class="form-item full" style="margin-bottom:12px">
          <label style="color:#3b7ddd;font-weight:600;display:block;margin-bottom:6px">题目配图（可选）</label>
          <input type="file" accept="image/*" onchange="stageVariantImg(${i},this)">
          <div id="vimg_prev_${i}" style="margin-top:8px">${img.data?`<img src="${img.data}" style="max-width:220px;max-height:150px;border-radius:8px;border:1px solid #dde7ef"><span style="color:#6b7b8f;font-size:12px;margin-left:8px">${esc(img.name||'')}</span>`:''}</div>
        </div>
        <div class="two-col" style="gap:12px">
          <div class="form-item" style="margin-bottom:0"><label style="color:#3b7ddd;font-weight:600">答案</label><textarea id="va${i}" style="min-height:60px;border:1px solid #e6f0f8;background:#fbfdff;border-radius:8px;padding:10px">${esc(v.a)}</textarea></div>
          <div class="form-item" style="margin-bottom:0"><label style="color:#3b7ddd;font-weight:600">解析</label><textarea id="vs${i}" style="min-height:60px;border:1px solid #e6f0f8;background:#fbfdff;border-radius:8px;padding:10px">${esc(v.s)}</textarea></div>
        </div>
      </div>
    </div>`;
  };
  const body=`<div style="background:#f6faff;border:1px solid #dde7ef;border-radius:12px;padding:14px 16px;margin-bottom:16px;color:#4a5d75;font-size:14px;line-height:1.6">
    已根据知识点「<b>${esc(m.kp||'未标注')}</b>」与错误原因「<b>${esc(m.reason)}</b>」生成 3 道不同难度变式题。下方每道题都可直接编辑，编辑后导出/打印即生效。
  </div>
  ${vs.map((v,i)=>card(v,i)).join('')}
  <div style="background:#fff;border:1px solid #dde7ef;border-radius:12px;box-shadow:0 2px 8px rgba(59,125,221,.06);overflow:hidden">
    <div style="background:#f6faff;padding:12px 16px;border-bottom:1px solid #eaf1f8;font-weight:600;color:#3b7ddd;font-size:15px;display:flex;align-items:center;gap:8px">
      <span style="width:4px;height:16px;background:#3b7ddd;border-radius:2px;display:inline-block"></span>导出设置
    </div>
    <div style="padding:16px">
      <div class="form-item" style="margin-bottom:0"><label>答题空位</label><select id="vspace"><option value="normal">普通</option><option value="large" selected>较大</option><option value="xlarge">超大</option></select></div>
    </div>
  </div>`;
  openModal('变式题生成 · '+stuName(m.studentId), body,
    `     <button class="btn btn-green" onclick="aiVariants('${id}')">AI生成变式题</button>
     <button class="btn btn-indigo" onclick="variantsToBank('${id}')">沉淀到我的题库</button>
     <button class="btn" onclick="exportVariants('${id}','word')">导出Word</button>
     <button class="btn" onclick="exportVariants('${id}','pdf')">导出PDF</button>
     <button class="btn btn-primary" onclick="exportVariants('${id}','print')">A4打印</button>
     <button class="btn" onclick="closeModal()">关闭</button>`);
}
function exportVariants(id,mode){
  const m=DB.mistakes.find(x=>x.id===id);
  const sp=fv('vspace')||'large';
  const levels=['基础题（★）','提高题（★★）','挑战题（★★★）'];
  const levelColor=['#22a565','#f59e0b','#e5465e'];
  let html=`<h1 style="font-size:22px;margin:0 0 6px;color:#1f3a5f">变式训练 · ${esc(m.kp||'专项练习')}</h1>
  <div style="color:#6b7b8f;font-size:13px;margin-bottom:18px">${esc(stuName(m.studentId))} · ${esc(m.cls)} · ${today()}</div>
  <div style="background:#fff;border:1px solid #dde7ef;border-radius:12px;box-shadow:0 2px 8px rgba(59,125,221,.06);margin-bottom:16px;overflow:hidden">
    <div style="background:#f6faff;padding:12px 16px;border-bottom:1px solid #eaf1f8;font-weight:600;color:#3b7ddd;font-size:15px;display:flex;align-items:center;gap:8px">
      <span style="width:4px;height:16px;background:#3b7ddd;border-radius:2px;display:inline-block"></span>原题回顾
    </div>
    <div style="padding:16px">
      <pre style="margin:0;background:#f8fafc;padding:10px;border-radius:8px;border:1px solid #eef3f8;white-space:pre-wrap;word-break:break-word">${esc(m.ocr)}</pre>
      ${m.img?`<img src="${m.img}" style="max-width:100%;margin-top:10px;border-radius:8px;border:1px solid #eef3f8">`:''}
    </div>
  </div>`;
  for(let i=0;i<3;i++){
    const img=(window._variantImgs&&window._variantImgs[i])||{};
    html+=`<div style="background:#fff;border:1px solid #dde7ef;border-radius:12px;box-shadow:0 2px 8px rgba(59,125,221,.06);margin-bottom:16px;overflow:hidden">
      <div style="background:#f6faff;padding:12px 16px;border-bottom:1px solid #eaf1f8;font-weight:600;color:${levelColor[i]};font-size:15px;display:flex;align-items:center;gap:8px">
        <span style="width:26px;height:26px;background:${levelColor[i]}15;color:${levelColor[i]};border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:13px">${i+1}</span>
        <span>${levels[i]}</span>
      </div>
      <div style="padding:16px">
        <pre style="margin:0 0 10px;background:#f8fafc;padding:10px;border-radius:8px;border:1px solid #eef3f8;white-space:pre-wrap;word-break:break-word">${esc(fv('vq'+i))}</pre>
        ${img.data?`<img src="${img.data}" style="max-width:100%;max-height:240px;margin-bottom:10px;border-radius:8px;border:1px solid #eef3f8">`:''}
        <div class="p-space-${sp}"></div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:13px;color:#495057">
          <div style="flex:1;min-width:160px"><b style="color:${levelColor[i]}">答案：</b>${esc(fv('va'+i))}</div>
          <div style="flex:2;min-width:240px"><b style="color:${levelColor[i]}">解析：</b>${esc(fv('vs'+i))}</div>
        </div>
      </div>
    </div>`;
  }
  if(mode==='word') exportWordDoc('变式训练-'+(m.kp||'练习'),html);
  else if(mode==='pdf') exportPDFDoc(html);
  else doPrint(html);
}
/* 同知识点巩固练习 */
function aiVariants(id){
  const m=DB.mistakes.find(x=>x.id===id);
  const sys='你是中小学出题专家，擅长根据一道错题的知识点与错误原因，设计分层变式训练题。';
  const user=`【原题（学生作答）】\n${m.ocr||'(见图片)'}\n\n【知识点】${m.kp||'未标注'}\n【错误原因】${m.reason||'未标注'}\n【正确答案】${m.answer||''}\n【解析参考】${m.analysis||''}\n\n请为该错题生成3道难度递增的变式题（基础题 / 提高题 / 挑战题），每题包含：题干、答案、解析。请直接列出三题，不要过多解释。`;
  showAiResult('AI 变式题参考 · '+stuName(m.studentId), sys, user);
}
function genPractice(id){
  const m=DB.mistakes.find(x=>x.id===id);
  const same=DB.mistakes.filter(x=>x.kp===m.kp&&x.kp);
  const card=(title, body, accent='#3b7ddd')=>`<div style="background:#fff;border:1px solid #dde7ef;border-radius:12px;box-shadow:0 2px 8px rgba(59,125,221,.06);margin-bottom:16px;overflow:hidden">
    <div style="background:#f6faff;padding:12px 16px;border-bottom:1px solid #eaf1f8;font-weight:600;color:${accent};font-size:15px;display:flex;align-items:center;gap:8px">
      <span style="width:4px;height:16px;background:${accent};border-radius:2px;display:inline-block"></span>${title}
    </div>
    <div style="padding:16px">${body}</div>
  </div>`;
  const smallCard=(idx, level, q, a, s)=>{
    const levelColor = level==='基础题'?'#22a565':level==='提高题'?'#f59e0b':'#e5465e';
    return `<div style="background:#fbfdff;border:1px solid #e6f0f8;border-radius:10px;padding:14px;margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        <span style="width:26px;height:26px;background:#eef3ff;color:#3b7ddd;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:13px">${idx}</span>
        ${level?`<span style="background:${levelColor}15;color:${levelColor};border:1px solid ${levelColor}30;padding:2px 8px;border-radius:6px;font-size:12px;font-weight:600">${esc(level)}</span>`:''}
      </div>
      <pre style="margin:0 0 10px;background:#f8fafc;padding:10px;border-radius:8px;border:1px solid #eef3f8;white-space:pre-wrap;word-break:break-word">${esc(q)}</pre>
      <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:13px;color:#495057">
        <div style="flex:1;min-width:160px"><b style="color:#3b7ddd">答案：</b>${esc(a||'（见教师版）')}</div>
        <div style="flex:2;min-width:240px"><b style="color:#3b7ddd">解析：</b>${esc(s||'暂无')}</div>
      </div>
    </div>`;
  };
  const stu=stuById(m.studentId);
  const stuNameText=stu?stu.name:'学生姓名';
  let html=`<h1 style="font-size:22px;margin:0 0 6px;color:#1f3a5f">${esc(m.kp||'专项')} 巩固练习</h1>
  <div style="color:#6b7b8f;font-size:13px;margin-bottom:18px">${esc(m.subject)} · ${esc(m.cls)} · ${today()}</div>`;
  html+=card('练习信息', `
    <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:14px">
      <div><b style="color:#3b7ddd">知识点：</b>${esc(m.kp||'未标注')}</div>
      <div><b style="color:#3b7ddd">学科：</b>${esc(m.subject)}</div>
      <div><b style="color:#3b7ddd">班级：</b>${esc(m.cls)}</div>
      <div><b style="color:#3b7ddd">学生：</b>${esc(stuNameText)}</div>
      <div><b style="color:#3b7ddd">日期：</b>${today()}</div>
    </div>
  `);
  html+=card('一、错题重做（共 '+(same.length||1)+' 题）', (same.length?same:[m]).map((x,i)=>smallCard(i+1,'',x.ocr,x.answer,x.analysis)).join(''));
  html+=card('二、变式巩固（3题）', buildVariants(m).map((v,i)=>smallCard(i+1,v.level,v.q,v.a,v.s)).join(''), '#8b5cf6');
  openModal('巩固练习预览 · '+(m.kp||''), html,
    `<button class="btn" onclick="exportWordDoc('巩固练习-${esc(m.kp||'练习')}',document.getElementById('modalBody').innerHTML)">导出Word</button>
     <button class="btn" onclick="exportPDFDoc(document.getElementById('modalBody').innerHTML)">导出PDF</button>
     <button class="btn btn-primary" onclick="doPrint(document.getElementById('modalBody').innerHTML)">A4打印</button>
     <button class="btn" onclick="closeModal()">关闭</button>`);
}
/* A4错题本导出 */
function exportMistakeBook(mode){
  const list=mistakeList();
  if(!list.length){ toast('当前筛选条件下没有错题'); return; }
  let html=`<h1>错题本</h1><div class="p-sub">${F.cls||'全部班级'} · ${F.subject||'全部学科'} · 共${list.length}题 · ${today()}</div>`;
  list.forEach((m,i)=>{
    html+=`<div class="p-q"><b>${i+1}.</b>【${esc(m.subject)} · ${esc(m.kp||'未标注')} · ${esc(m.qtype)} · ${esc(stuName(m.studentId))}】<br>
    <pre>${esc(m.ocr)}</pre>${m.img?`<img class="p-img" src="${m.img}">`:''}
    <div><b>重做区：</b></div><div class="p-space-large"></div>
    <div class="p-ans"><b>正确答案：</b>${esc(m.answer||'')}<br><b>解析：</b>${esc(m.analysis||'')}<br><b>错误原因：</b>${esc(m.reason)}</div></div>`;
  });
  if(mode==='word') exportWordDoc('错题本-'+today(),html);
  else if(mode==='pdf') exportPDFDoc(html);
  else doPrint(html);
}

/* ==================== 7. 成绩分析库 ==================== */
function calcExam(e){
  const scores=e.records.map(r=>+r.score||0);
  const n=scores.length||1;
  const avg=(scores.reduce((a,b)=>a+b,0)/n).toFixed(1);
  const max=Math.max(...scores,0), min=scores.length?Math.min(...scores):0;
  const full=+e.full||100;
  const exc=e.records.filter(r=>r.score>=full*0.85), pass=e.records.filter(r=>r.score>=full*0.6), low=e.records.filter(r=>r.score<full*0.4);
  const layers={A:[],B:[],C:[],D:[]};
  e.records.forEach(r=>{
    const p=r.score/full;
    if(p>=0.9)layers.A.push(r.name); else if(p>=0.75)layers.B.push(r.name);
    else if(p>=0.6)layers.C.push(r.name); else layers.D.push(r.name);
  });
  const seg=[0,0,0,0,0]; // 90-100,80-89,70-79,60-69,<60 (按满分比例)
  e.records.forEach(r=>{ const p=r.score/full*100;
    if(p>=90)seg[0]++; else if(p>=80)seg[1]++; else if(p>=70)seg[2]++; else if(p>=60)seg[3]++; else seg[4]++; });
  // 进步学生：与同班同学科上一次考试比
  const prev=DB.exams.filter(x=>x.cls===e.cls&&x.subject===e.subject&&x.date<e.date).sort((a,b)=>b.date.localeCompare(a.date))[0];
  let progress=[];
  if(prev){
    e.records.forEach(r=>{
      const pr=prev.records.find(p=>p.name===r.name);
      if(pr&&(r.score/full-pr.score/prev.full)>=0.05) progress.push(r.name+'（+'+(r.score-pr.score*full/prev.full).toFixed(0)+'分）');
    });
  }
  const weakKps=(e.kps||[]).filter(k=>+k.rate<70);
  return {n:scores.length,avg,max,min,full,excRate:(exc.length/n*100).toFixed(1),passRate:(pass.length/n*100).toFixed(1),
    lowRate:(low.length/n*100).toFixed(1),layers,seg,progress,weakKps,excNames:exc.map(r=>r.name),prev};
}
function renderScores(){
  const list=DB.exams.filter(e=>
    (!F.grade||e.grade===F.grade)&&(!F.subject||e.subject===F.subject)&&(!F.cls||e.cls===F.cls)&&
    matchQ(F.q,[e.name,e.type,e.cls,e.subject,e.note])).sort((a,b)=>b.date.localeCompare(a.date));
  const scoreTrend=DB.exams.slice().sort((a,b)=>a.date.localeCompare(b.date)).slice(-8).map(e=>({label:e.date.slice(5),value:+calcExam(e).avg}));
  document.getElementById('page').innerHTML=`
  <div class="page-head">
    <div><div class="page-title title-green">成绩分析库</div><div class="page-desc">录入/导入成绩后，自动生成班级分析、学生分层、薄弱知识点与教学建议</div></div>
    ${moduleToolbar([
      `<button class="btn btn-primary" onclick="examAdd()">+ 新建考试</button>`,
      `<button class="btn" onclick="toast('打开某场考试后，可在成绩录入页使用「导入成绩」粘贴Excel数据')">批量导入</button>`,
      `<span style="width:1px;height:22px;background:var(--line);display:inline-block;margin:0 2px"></span>`,
      `<button class="btn btn-green" onclick="classReportExport('preview')">班级分析报告</button>`,
      `<button class="btn" onclick="classReportExport('word')">导出Word</button>`,
      `<button class="btn" onclick="classReportExport('pdf')">PDF</button>`,
      `<button class="btn" onclick="classReportExport('print')">打印</button>`
    ])}
  </div>
  <div class="card">
    ${list.length? `<div class="tbl-wrap"><table class="tbl">
      <tr><th class="nosort">考试名称</th><th class="nosort">类型</th><th class="nosort">日期</th><th class="nosort">班级/学科</th><th class="nosort">满分</th><th class="nosort">人数</th><th class="nosort">平均分</th><th class="nosort">及格率</th><th class="nosort">优秀率</th><th class="nosort">操作</th></tr>
      ${list.map(e=>{const a=calcExam(e);return `<tr>
        <td><b>${esc(e.name)}</b></td><td><span class="tag tag-blue">${esc(e.type)}</span></td><td>${e.date}</td>
        <td>${esc(e.cls)} · ${esc(e.subject)}</td><td class="num">${e.full}</td><td class="num">${a.n}</td>
        <td class="num"><b>${a.avg}</b></td><td class="num">${a.passRate}%</td><td class="num">${a.excRate}%</td>
        <td style="white-space:nowrap">
          <button class="btn btn-sm" onclick="examOpen('${e.id}')">成绩录入</button>
          <button class="btn btn-sm btn-green" onclick="examReport('${e.id}')">分析报告</button>
          <button class="btn btn-sm btn-danger" onclick="examDel('${e.id}')">删除</button>
        </td></tr>`;}).join('')}
    </table></div>`
    : `<div class="empty">暂无考试记录<br><span class="link" onclick="examAdd()">点击新建第一场考试 →</span></div>`}
  </div>`;
}
function examAdd(){
  openModal('新建考试',`
  <div class="form-grid">
    <div class="form-item"><label>考试名称 <i>*</i></label><input id="f_ename" placeholder="如：期中考试（数学）"></div>
    <div class="form-item"><label>考试类型</label><select id="f_etype">${optHtml(DB.meta.examTypes,'单元测试')}</select>
      <div class="form-hint">类型可在「基础设置」中自由增删</div></div>
    <div class="form-item"><label>考试时间</label><input id="f_edate" type="date" value="${today()}"></div>
    <div class="form-item"><label>年级</label><select id="f_egrade">${optHtml(DB.meta.grades,F.grade||'三年级')}</select></div>
    <div class="form-item"><label>班级</label>${clsSelectHtml(F.cls||classList()[0]||'','f_ecls','')}</div>
    <div class="form-item"><label>学科</label>${subSelectHtml(F.subject||'数学','f_esub')}</div>
    <div class="form-item"><label>满分</label><input id="f_efull" type="number" value="100"></div>
  </div>
  <div class="form-hint" style="margin-top:8px">创建后将自动带入该班级的学生名单，可直接录入成绩或粘贴导入。</div>`,
  `<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="examSave()">创建并录入成绩</button>`,true);
}
function examSave(){
  if(!fv('f_ename')){ toast('请填写考试名称'); return; }
  const cls=fv('f_ecls');
  if(cls){ if(!DB.meta.classes.includes(cls)) DB.meta.classes.push(cls); DB.meta.classes.sort((a,b)=>a.localeCompare(b,'zh')); }
  const e={id:uid(),name:fv('f_ename'),type:fv('f_etype'),date:fv('f_edate')||today(),grade:fv('f_egrade'),cls,
    subject:fv('f_esub'),full:+fv('f_efull')||100,kps:[],
    records:DB.students.filter(s=>s.cls===cls).map(s=>({sid:s.id,name:s.name,score:0,gradeRank:'',qscore:'',note:''}))};
  DB.exams.push(e); save(); closeModal(); render(); examOpen(e.id);
}
function examDel(id){ if(!confirm('确定删除这场考试及全部成绩吗？'))return; DB.exams=DB.exams.filter(x=>x.id!==id); save(); render(); }
function examOpen(id){
  const e=DB.exams.find(x=>x.id===id);
  const ranked=[...e.records].sort((a,b)=>b.score-a.score);
  const body=`
  <div class="notice">${esc(e.name)} · ${esc(e.cls)} · ${esc(e.subject)} · 满分${e.full}分 · 修改分数后点击「保存成绩」自动计算班级排名</div>
  <div class="toolbar" style="margin-bottom:10px">
    <button class="btn btn-sm" onclick="importScoresCSV('${id}')">导入成绩（粘贴Excel）</button>
    <button class="btn btn-sm" onclick="examAddStu('${id}')">+ 补录学生</button>
  </div>
  <div class="tbl-wrap"><table class="tbl">
    <tr><th class="nosort">学生姓名</th><th class="nosort">成绩</th><th class="nosort">班级排名</th><th class="nosort">年级排名</th><th class="nosort">题号得分（选填）</th><th class="nosort">备注</th></tr>
    ${e.records.map((r,i)=>`<tr>
      <td>${esc(r.name)}</td>
      <td><input style="width:80px;padding:5px;border:1px solid #dde7ef;border-radius:6px" type="number" id="sc_${i}" value="${r.score}"></td>
      <td class="num">${ranked.findIndex(x=>x===r)+1}</td>
      <td><input style="width:70px;padding:5px;border:1px solid #dde7ef;border-radius:6px" id="gr_${i}" value="${esc(r.gradeRank)}"></td>
      <td><input style="width:150px;padding:5px;border:1px solid #dde7ef;border-radius:6px" id="qs_${i}" value="${esc(r.qscore)}" placeholder="如 1:5,2:3,3:8"></td>
      <td><input style="width:120px;padding:5px;border:1px solid #dde7ef;border-radius:6px" id="nt_${i}" value="${esc(r.note)}"></td>
    </tr>`).join('')}
  </table></div>
  <h4 style="margin:14px 0 8px">知识点得分率（用于薄弱知识点分析）</h4>
  <div id="kpRows">${(e.kps||[]).map((k,i)=>`<div class="filter-bar">
    <input id="kpn_${i}" value="${esc(k.name)}" placeholder="知识点名称">
    <input id="kpr_${i}" type="number" value="${k.rate}" style="width:80px" placeholder="得分率"> %
  </div>`).join('')}</div>
  <button class="btn btn-sm" onclick="examAddKpRow()">+ 添加知识点</button>`;
  openModal('成绩录入 · '+e.name, body,
    `<button class="btn" onclick="closeModal()">取消</button>
     <button class="btn btn-green" onclick="examEntrySave('${id}');examReport('${id}')">保存并查看分析</button>
     <button class="btn btn-primary" onclick="examEntrySave('${id}')">保存成绩</button>`);
  window._kpCount=(e.kps||[]).length;
}
function examAddKpRow(){
  const i=window._kpCount++;
  document.getElementById('kpRows').insertAdjacentHTML('beforeend',
    `<div class="filter-bar"><input id="kpn_${i}" placeholder="知识点名称"><input id="kpr_${i}" type="number" style="width:80px" placeholder="得分率"> %</div>`);
}
function examAddStu(id){
  const name=prompt('输入要补录的学生姓名（若不在学生名单中，仅记录在本场考试）');
  if(!name)return;
  const e=DB.exams.find(x=>x.id===id);
  const s=DB.students.find(x=>x.name===name);
  e.records.push({sid:s?s.id:'',name,score:0,gradeRank:'',qscore:'',note:''});
  save(); examOpen(id);
}
function examEntrySave(id){
  const e=DB.exams.find(x=>x.id===id);
  e.records.forEach((r,i)=>{
    r.score=+fv('sc_'+i)||0; r.gradeRank=fv('gr_'+i); r.qscore=fv('qs_'+i); r.note=fv('nt_'+i);
  });
  e.kps=[];
  for(let i=0;i<window._kpCount;i++){
    const n=fv('kpn_'+i); if(n) e.kps.push({name:n,rate:+fv('kpr_'+i)||0});
  }
  save(); closeModal(); render(); toast('成绩已保存，班级排名已自动更新');
}
function importScoresCSV(id){
  openModal('导入成绩',`
  <div class="notice">支持三种方式：① 从 Excel 复制两列（姓名、分数）粘贴到下方；② 直接选择 <b>.xlsx/.xls</b> 文件（自动取前两列）；③ 选择 CSV 文件。每行格式：<b>姓名,分数</b>。按姓名自动匹配学生。</div>
  <div class="form-item full"><label>粘贴区</label><textarea id="f_csv" style="min-height:150px" placeholder="王小明,88&#10;李思雨,96"></textarea></div>
  <div class="form-item full"><label>或选择 Excel 文件(.xlsx/.xls，自动取前两列：姓名、分数)</label><input type="file" accept=".xlsx,.xls" onchange="readXlsx(this.files[0],rows=>{if(rows)document.getElementById('f_csv').value=rows.map(r=>[r[0]||'',r[1]||''].join(',')).join('\\n')})"></div>
  <div class="form-item full"><label>或选择CSV文件</label><input type="file" accept=".csv,.txt" onchange="readFileText(this.files[0],t=>document.getElementById('f_csv').value=t)"></div>`,
  `<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="doImportScores('${id}')">导入</button>`,true);
}
function doImportScores(id){
  const e=DB.exams.find(x=>x.id===id);
  const rows=parseCSVText(fv('f_csv'));
  let ok=0,miss=[];
  rows.forEach(([name,score])=>{
    if(!name||isNaN(+score))return;
    let r=e.records.find(x=>x.name===name);
    if(!r){ const s=DB.students.find(x=>x.name===name); r={sid:s?s.id:'',name,score:0,gradeRank:'',qscore:'',note:''}; e.records.push(r); miss.push(name); }
    r.score=+score; ok++;
  });
  save(); closeModal(); examOpen(id);
  toast(`成功导入 ${ok} 条成绩`+(miss.length?`（新增学生记录：${miss.join('、')}）`:''));
}
/* ============ 可视化图表（纯SVG，离线可用，无需第三方库） ============ */
function chartColBar(seg){
  const labels=['90%以上','80-89','70-79','60-69','60以下'];
  const colors=['#27ae60','#56cc9d','#f2c94c','#f2994a','#eb5757'];
  const max=Math.max(...seg,1); const W=300,H=150,padB=24,padT=18,bw=32,gap=33;
  let s=seg.map((v,i)=>{const h=v/max*(H-padB-padT);const x=6+i*(bw+gap);const y=H-padB-h;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw}" height="${h.toFixed(1)}" rx="4" fill="${colors[i]}"></rect>`+
    `<text x="${(x+bw/2).toFixed(1)}" y="${(y-4).toFixed(1)}" text-anchor="middle" font-size="11" fill="#556">${v}</text>`+
    `<text x="${(x+bw/2).toFixed(1)}" y="${H-8}" text-anchor="middle" font-size="9" fill="#889">${labels[i]}</text>`;}).join('');
  return `<svg viewBox="0 0 300 170" width="100%" preserveAspectRatio="xMidYMid meet" style="max-width:300px">${s}</svg>`;
}
function chartDonut(layers){
  const parts=[{l:'A层',v:layers.A.length,c:'#27ae60'},{l:'B层',v:layers.B.length,c:'#2f80ed'},
    {l:'C层',v:layers.C.length,c:'#f2c94c'},{l:'D层',v:layers.D.length,c:'#eb5757'}];
  const total=parts.reduce((a,b)=>a+b.v,0);
  const cx=80,cy=80,R=70,r=46; let acc=0,s='';
  parts.forEach(p=>{const ang=total?(p.v/total)*360:0;
    if(p.v>0){
      if(ang>=359.9){ s+=`<circle cx="${cx}" cy="${cy}" r="${(R+r)/2}" fill="none" stroke="${p.c}" stroke-width="${R-r}"></circle>`; }
      else{
        const a0=(-90+acc)*Math.PI/180,a1=(-90+acc+ang)*Math.PI/180;
        const x0=cx+R*Math.cos(a0),y0=cy+R*Math.sin(a0),x1=cx+R*Math.cos(a1),y1=cy+R*Math.sin(a1);
        const xi0=cx+r*Math.cos(a0),yi0=cy+r*Math.sin(a0),xi1=cx+r*Math.cos(a1),yi1=cy+r*Math.sin(a1);
        const large=ang>180?1:0;
        s+=`<path d="M${x0.toFixed(1)} ${y0.toFixed(1)} A${R} ${R} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)} L${xi1.toFixed(1)} ${yi1.toFixed(1)} A${r} ${r} 0 ${large} 0 ${xi0.toFixed(1)} ${yi0.toFixed(1)} Z" fill="${p.c}"></path>`;
      }
    } acc+=ang;});
  if(total===0) s=`<circle cx="${cx}" cy="${cy}" r="${R}" fill="#eef3f8"></circle>`;
  const pills=parts.map(p=>`<div class="donut-pill"><i style="background:${p.c}"></i><b>${p.l}</b><span>${p.v}人</span></div>`).join('');
  return `<div class="donut-box"><svg viewBox="0 0 160 160" width="160" height="160">${s}<text x="${cx}" y="${cy-3}" text-anchor="middle" font-size="26" fill="#26343f" font-weight="700">${total}</text><text x="${cx}" y="${cy+16}" text-anchor="middle" font-size="10" fill="#8fa0ad">总人数</text></svg><div class="donut-pills">${pills}</div></div>`;
}
function chartKPbars(kps){
  const W=560,rowH=28,labX=6,labW=120,barX=labW+10,barW=W-barX-46,H=kps.length*rowH+8;
  let s=kps.map((k,i)=>{const y=8+i*rowH;const pct=+k.rate||0;const col=pct<60?'#eb5757':pct<70?'#f2994a':pct<85?'#f2c94c':'#27ae60';
    const w=pct/100*barW;
    return `<text x="${labX}" y="${y+14}" font-size="12" fill="#445">${esc(k.name).slice(0,9)}</text>`+
    `<rect x="${barX}" y="${y+3}" width="${barW}" height="15" rx="7.5" fill="#eef3f8"></rect>`+
    `<rect x="${barX}" y="${y+3}" width="${w.toFixed(1)}" height="15" rx="7.5" fill="${col}"></rect>`+
    `<text x="${W-4}" y="${y+15}" text-anchor="end" font-size="12" fill="#445">${pct}%</text>`;}).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMinYMin meet">${s}</svg>`;
}
function chartTrend(e){
  const series=DB.exams.filter(x=>x.cls===e.cls&&x.subject===e.subject&&x.date<=e.date).sort((a,b)=>a.date.localeCompare(b.date));
  if(series.length<2) return '';
  const data=series.map(x=>+calcExam(x).avg);
  const W=560,H=170,p=28;const max=Math.max(...data,100),min=Math.min(...data,0);
  const xstep=(W-p*2)/(data.length-1);
  const pts=data.map((v,i)=>{const x=p+i*xstep;const y=H-p-((v-min)/((max-min)||1))*(H-p*2);return [x,y];});
  const path=pts.map((q,i)=>(i?'L':'M')+q[0].toFixed(1)+' '+q[1].toFixed(1)).join(' ');
  let s=pts.map((q,i)=>`<circle cx="${q[0].toFixed(1)}" cy="${q[1].toFixed(1)}" r="3.5" fill="#2f80ed"></circle>`+
    `<text x="${q[0].toFixed(1)}" y="${(q[1]-8).toFixed(1)}" text-anchor="middle" font-size="10" fill="#2f80ed">${data[i]}</text>`+
    `<text x="${q[0].toFixed(1)}" y="${H-8}" text-anchor="middle" font-size="9" fill="#889">${series[i].date.slice(5)}</text>`).join('');
  const grid=`<line x1="${p}" y1="${H-p}" x2="${W-p}" y2="${H-p}" stroke="#e3e9f0"></line>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">${grid}${s}<path d="${path}" fill="none" stroke="#2f80ed" stroke-width="2"></path></svg>`;
}
/* 学情分析报告 */
function examAnalysisHtml(e){
  const a=calcExam(e);
  const trend=chartTrend(e);
  const judge=+a.avg>=e.full*0.8?'班级整体掌握情况良好，大部分学生达到了教学目标。':
              +a.avg>=e.full*0.65?'班级整体处于中等水平，两极分化需要关注。':'班级整体掌握情况不理想，需要放慢进度、夯实基础。';
  const layerMeta=[
    {key:'A',title:'优势学生',sub:'≥90%',color:'green',names:a.layers.A},
    {key:'B',title:'稳定学生',sub:'75%~89%',color:'blue',names:a.layers.B},
    {key:'C',title:'待提升学生',sub:'60%~74%',color:'yellow',names:a.layers.C},
    {key:'D',title:'重点关注学生',sub:'<60%',color:'red',names:a.layers.D}
  ];
  const segLabels=['90%以上','80%~89%','70%~79%','60%~69%','60%以下'];
  const hasKps=(e.kps||[]).length>0;
  const progressList=a.progress.length?a.progress.map(x=>`<span class="rpt-tag tag-green">${esc(x)}</span>`).join(''):'<span class="rpt-empty">暂无进步幅度≥5%的学生</span>';
  return `<div class="rpt">
  <div class="rpt-header">
    <div class="rpt-header-main">
      <div class="rpt-type">${esc(e.type)}</div>
      <h1>${esc(e.name)}</h1>
      <div class="rpt-meta">${esc(e.grade)} ${esc(e.cls)} · ${esc(e.subject)} · ${e.date} · 满分${e.full}分 · ${a.n}人参考</div>
    </div>
    <div class="rpt-header-score"><span>平均分</span><b>${a.avg}</b></div>
  </div>
  <div class="rpt-judge"><i class="rpt-dot blue"></i>${judge}</div>
  <div class="rpt-kpi-grid">
    <div class="rpt-kpi kpi-avg"><div class="rpt-ico">均</div><div><span>平均分</span><b>${a.avg}</b></div></div>
    <div class="rpt-kpi kpi-max"><div class="rpt-ico">高</div><div><span>最高分</span><b>${a.max}</b></div></div>
    <div class="rpt-kpi kpi-min"><div class="rpt-ico">低</div><div><span>最低分</span><b>${a.min}</b></div></div>
    <div class="rpt-kpi kpi-exc"><div class="rpt-ico">优</div><div><span>优秀率</span><b>${a.excRate}%</b></div></div>
    <div class="rpt-kpi kpi-pass"><div class="rpt-ico">及</div><div><span>及格率</span><b>${a.passRate}%</b></div></div>
    <div class="rpt-kpi kpi-low"><div class="rpt-ico">险</div><div><span>低分率</span><b>${a.lowRate}%</b></div></div>
  </div>
  ${trend?`<div class="rpt-card rpt-card-full"><div class="rpt-card-title"><i class="rpt-dot blue"></i>班级成绩趋势 <span class="rpt-sub">同班同学科历次平均分</span></div><div class="rpt-chart">${trend}</div></div>`:''}
  <div class="rpt-grid-2">
    <div class="rpt-card">
      <div class="rpt-card-title"><i class="rpt-dot green"></i>分数段人数分布</div>
      <div class="rpt-chart">${chartColBar(a.seg)}</div>
      <table class="rpt-mini"><tr><th>分数段</th><th>人数</th><th>占比</th></tr>
      ${a.seg.map((c,i)=>`<tr><td>${segLabels[i]}</td><td>${c}人</td><td>${((c/(a.n||1))*100).toFixed(1)}%</td></tr>`).join('')}</table>
    </div>
    <div class="rpt-card">
      <div class="rpt-card-title"><i class="rpt-dot orange"></i>学生分层占比</div>
      <div class="rpt-donut">${chartDonut(a.layers)}</div>
    </div>
  </div>
  <div class="rpt-card">
    <div class="rpt-card-title"><i class="rpt-dot purple"></i>学生分层名单</div>
    <div class="rpt-layer-grid">
      ${layerMeta.map(l=>`<div class="rpt-layer-card layer-${l.color}"><div class="rpt-layer-head"><b>${l.key}层 · ${l.title}</b><span>${l.sub}</span></div><div class="rpt-layer-body">${l.names.length?l.names.map(n=>`<span class="rpt-tag tag-${l.color}">${esc(n)}</span>`).join(''):'<span class="rpt-empty">暂无</span>'}</div></div>`).join('')}
    </div>
    <div style="margin-top:16px">
      <div class="rpt-card-title" style="margin-bottom:8px"><i class="rpt-dot green"></i>进步学生 <span class="rpt-sub">与上次同班同科对比提升≥5%</span></div>
      <div class="rpt-layer-body">${progressList}</div>
    </div>
  </div>
  ${hasKps?`<div class="rpt-card"><div class="rpt-card-title"><i class="rpt-dot red"></i>薄弱知识点 <span class="rpt-sub">得分率&lt;70%标红</span></div><div class="rpt-chart">${chartKPbars(e.kps)}</div></div>`:`<div class="rpt-card"><div class="rpt-card-title"><i class="rpt-dot red"></i>薄弱知识点</div><p class="rpt-empty">未录入知识点得分率，可在成绩录入页添加。</p></div>`}
  <div class="rpt-grid-2">
    <div class="rpt-card">
      <div class="rpt-card-title"><i class="rpt-dot teal"></i>后续教学建议</div>
      <ul class="rpt-list">
        <li>针对${a.weakKps.length?'薄弱知识点「'+a.weakKps.map(k=>esc(k.name)).join('、')+'」':'基础知识'}安排1-2课时专项复习，配套错题变式训练。</li>
        <li>将本次考试典型错题录入错题库，生成讲评清单，安排一节试卷讲评课。</li>
        <li>加强审题与计算规范训练，每日安排5分钟基础口算/听写。</li>
        <li>对D层学生逐一分析失分点，与家长沟通形成家校合力。</li>
      </ul>
    </div>
    <div class="rpt-card">
      <div class="rpt-card-title"><i class="rpt-dot pink"></i>分层辅导方案</div>
      <div class="rpt-advice-grid">
        <div class="rpt-advice-item"><b>A层 · 优势学生</b><p>提供拓展性、挑战性任务，鼓励一题多解，可担任小老师参与讲评。</p></div>
        <div class="rpt-advice-item"><b>B层 · 稳定学生</b><p>保持稳定训练量，重点突破中档题失分点，向A层跃升。</p></div>
        <div class="rpt-advice-item"><b>C层 · 待提升学生</b><p>回归课本与基础题型，建立个人错题本，每周一次基础过关。</p></div>
        <div class="rpt-advice-item"><b>D层 · 重点关注学生</b><p>降低起点、小步子推进，课后小组辅导+每日基础打卡，优先解决${a.weakKps[0]?('「'+esc(a.weakKps[0].name)+'」'):'基础知识'}问题。</p></div>
      </div>
    </div>
  </div>
  ${scoresInsightHtml()}
</div>`;
}
/* 成绩分析增强：班级均分趋势 + 进退步榜 */
let _siCls='', _siSubj='';
function scoresInsightHtml(){
  const cls=_siCls||classList()[0]||'';
  const subj=_siSubj||subjectList()[0]||'';
  const exs=DB.exams.filter(e=>e.cls===cls&&e.subject===subj).sort((a,b)=>a.date.localeCompare(b.date));
  const trendData=exs.map(e=>({label:e.date.slice(5),value:Math.round(e.records.reduce((s,r)=>s+(+r.score||0),0)/Math.max(1,e.records.length))}));
  const trendChart=trendData.length>=2?lineChartSVG(trendData,560,180):'<div class="empty">该班级该学科暂不足两次考试，无法绘制均分趋势</div>';
  let progHtml='<div class="empty">不足两次考试，无法计算进退步</div>';
  if(exs.length>=2){
    const e2=exs[exs.length-1], e1=exs[exs.length-2];
    const m1={}; e1.records.forEach(r=>m1[r.name]=+r.score||0);
    const rows=e2.records.map(r=>({name:r.name,now:+r.score||0,prev:m1[r.name]!=null?m1[r.name]:null}))
      .filter(r=>r.prev!=null).map(r=>({name:r.name,diff:r.now-r.prev}))
      .sort((a,b)=>b.diff-a.diff);
    const fmt=arr=>arr.map(r=>`<span class="rpt-tag ${r.diff>=0?'tag-green':'tag-red'}">${esc(r.name)} ${r.diff>=0?'+':''}${r.diff}</span>`).join('')||'<span class="rpt-empty">—</span>';
    progHtml=`<div style="margin-bottom:10px"><div class="rpt-sub" style="margin-bottom:6px">↑ 进步最快（对比「${esc(e1.name)}」）</div><div class="rpt-layer-body">${fmt(rows.slice(0,6))}</div></div>
      <div><div class="rpt-sub" style="margin-bottom:6px">↓ 退步明显</div><div class="rpt-layer-body">${fmt(rows.slice(-6).reverse())}</div></div>`;
  }
  const fb=clsSelectHtml(cls,'si_cls','选择班级','','_siCls=this.value;renderScores()');
  const sb=subSelectHtml(subj,'si_subj','选择学科','','_siSubj=this.value;renderScores()');
  return `<div class="feishu-board" style="margin-top:16px">
    <div class="fsb-section-head"><span class="fsb-dot fsb-dot-green"></span><h4>📈 班级均分趋势（${esc(cls)} · ${esc(subj)}）</h4></div>
    <div class="filter-bar" style="margin-bottom:10px">${fb}${sb}</div>
    ${trendChart}
    <div class="fsb-section-head" style="margin-top:14px"><span class="fsb-dot fsb-dot-blue"></span><h4>🔁 进退步榜（最近两次考试）</h4></div>
    ${progHtml}
  </div>`;
}
function examReport(id){
  const e=DB.exams.find(x=>x.id===id);
  const html=examAnalysisHtml(e);
  openModal('学情分析报告 · '+e.name, html,
    `<button class="btn" onclick="exportWordDoc('${esc(e.name)}-学情分析报告',document.getElementById('modalBody').innerHTML)">导出Word</button>
     <button class="btn" onclick="exportPDFDoc(document.getElementById('modalBody').innerHTML)">导出PDF</button>
     <button class="btn btn-primary" onclick="doPrint(document.getElementById('modalBody').innerHTML)">A4打印</button>
     <button class="btn" onclick="closeModal()">关闭</button>`);
}

/* ==================== 8. 试卷/习题生成 ==================== */
let _lastPaper=null;
let _lastClassReport=null;
function renderPapers(){
  document.getElementById('page').innerHTML=
    wbHead('试卷 / 习题生成库','title-orange','按年级、学科、知识点、难度快速生成练习卷（模板生成，接入AI后可自动生成具体题干）')+
    `<div class="two-col">
    <div class="card">
      <div class="card-title">生成设置</div>
      <div class="form-grid">
        <div class="form-item"><label>年级</label><select id="p_grade">${optHtml(DB.meta.grades,F.grade||'三年级')}</select></div>
        <div class="form-item"><label>学科</label>${subSelectHtml(F.subject||'数学','p_subject')}</div>
        <div class="form-item full"><label>知识点（多个用顿号/逗号分隔）</label>
          <input id="p_kps" placeholder="如：多位数乘一位数、倍的认识" list="kpList">
          <datalist id="kpList">${[...new Set(DB.mistakes.map(m=>m.kp).filter(Boolean))].map(k=>`<option value="${esc(k)}">`).join('')}</datalist></div>
        <div class="form-item full"><label>题型（可多选）</label>${pillHtml('p_qtypes',DB.meta.qtypes,['选择题','填空题','计算题','应用题'])}</div>
        <div class="form-item"><label>难度结构</label><select id="p_diff">
          <option value="basic">基础卷（易70% 中30%）</option>
          <option value="normal" selected>标准卷（易50% 中35% 难15%）</option>
          <option value="hard">提高卷（易30% 中40% 难30%）</option>
          <option value="layered">分层卷（A/B/C三组分层）</option></select></div>
        <div class="form-item"><label>每种题型题量</label><input id="p_count" type="number" value="3" min="1" max="10"></div>
        <div class="form-item"><label>含答案</label><select id="p_ans"><option>是</option><option>否</option></select></div>
        <div class="form-item"><label>含解析</label><select id="p_ana"><option>是</option><option>否</option></select></div>
        <div class="form-item"><label>答题空位</label><select id="p_space"><option value="normal">普通</option><option value="large" selected>较大</option><option value="xlarge">超大</option></select></div>
        <div class="form-item"><label>打印格式</label><select id="p_fmt"><option>A4竖版</option><option>A4横版（可对折）</option></select></div>
        <div class="form-item full"><label>试卷标题</label><input id="p_title" placeholder="留空自动生成，如：三年级数学专项练习"></div>
      </div>
      <div class="toolbar" style="margin-top:14px">
        <button class="btn btn-primary" onclick="paperGen('kp')">生成试卷</button>
        <button class="btn" onclick="paperGen('mistake')">根据错题生成变式卷</button>
        <button class="btn btn-green" onclick="aiPaper()">AI智能出题</button>
      </div>
    </div>
    <div class="card">
      <div class="card-title">试卷预览</div>
      <div id="paperPreview" class="empty">设置左侧参数后点击「生成试卷」<br>预览将显示在这里</div>
      <div class="toolbar" style="margin-top:12px">
        <button class="btn btn-indigo" onclick="paperToBank()">沉淀到我的题库</button>
        <button class="btn" onclick="paperExport('word')">导出Word</button>
        <button class="btn" onclick="paperExport('pdf')">导出PDF</button>
        <button class="btn btn-primary" onclick="paperExport('print')">打印</button>
      </div>
    </div>
  </div>`;
}
const DIFF_MAP={basic:[['★ 基础',.7],['★★ 中档',.3]],normal:[['★ 基础',.5],['★★ 中档',.35],['★★★ 提高',.15]],
  hard:[['★ 基础',.3],['★★ 中档',.4],['★★★ 提高',.3]],layered:[['A组 · 基础过关',.34],['B组 · 能力提升',.33],['C组 · 思维挑战',.33]]};
function paperQTemplate(qt,kp,lv,sub){
  const t={
   '选择题':`（${lv}）下列关于「${kp}」的说法/结果，正确的一项是（　　）\nA.____　B.____　C.____　D.____`,
   '填空题':`（${lv}）与「${kp}」相关的填空：____________。`,
   '判断题':`（${lv}）判断对错：关于「${kp}」的说法“________”。（　　）`,
   '计算题':`（${lv}）计算下列各题（考查：${kp}），要求写出完整过程：`,
   '应用题':`（${lv}）应用「${kp}」解决实际问题：（结合生活情境命题，写清已知条件和问题）`,
   '阅读题':`（${lv}）阅读下面材料，完成练习（考查：${kp}）：`,
   '简答题':`（${lv}）简答：请结合「${kp}」谈谈你的理解/说明理由。`,
   '作文题':`（${lv}）习作：围绕「${kp}」主题写一篇作文，不少于规定字数。`,
   '实验题':`（${lv}）实验探究（考查：${kp}）：写出实验目的、器材、步骤和结论。`,
   '综合题':`（${lv}）综合运用「${kp}」及相关知识解决下列问题：`
  };
  return (t[qt]||t['综合题'])+`\n（示例题干模板，可在导出Word后编辑为具体题目；接入AI后自动生成）`;
}
function paperGen(mode){
  const kps=fv('p_kps').split(/[、,，;；]/).map(s=>s.trim()).filter(Boolean);
  const qtypes=pills('p_qtypes');
  const cnt=+fv('p_count')||3;
  const diff=DIFF_MAP[fv('p_diff')||'normal']||DIFF_MAP.normal;
  const withAns=fv('p_ans')!=='否', withAna=fv('p_ana')!=='否';
  let qs=[];
  if(mode==='mistake'){
    const src=mistakeList().filter(m=>!kps.length||kps.some(k=>m.kp.includes(k)));
    if(!src.length){ toast('错题库中没有匹配的错题（检查顶部筛选与知识点）'); return; }
    src.forEach(m=>{
      buildVariants(m).forEach(v=>qs.push({qtype:'错题变式·'+m.qtype,text:`（${v.level}）${v.q}`,ans:v.a,ana:v.s}));
    });
  }else{
    if(!kps.length){ toast('请至少填写一个知识点'); return; }
    if(!qtypes.length){ toast('请至少选择一种题型'); return; }
    qtypes.forEach(qt=>{
      for(let i=0;i<cnt;i++){
        const lv=diff[Math.min(Math.floor(i/cnt*diff.length),diff.length-1)][0];
        const kp=kps[i%kps.length];
        qs.push({qtype:qt,text:paperQTemplate(qt,kp,lv,fv('p_subject')),
          ans:withAns?'（参考答案）':'',ana:withAna?`考查「${kp}」，${lv.includes('★★★')||lv.includes('C组')?'综合性较强，关注思路的完整表达。':lv.includes('★★')||lv.includes('B组')?'中档难度，注意方法选择。':'基础题，确保步骤规范、计算准确。'}`:''});
      }
    });
  }
  _lastPaper={title:fv('p_title')||`${fv('p_grade')}${fv('p_subject')}${mode==='mistake'?'错题变式卷':'专项练习卷'}`,
    grade:fv('p_grade'),subject:fv('p_subject'),space:fv('p_space')||'large',withAns,withAna,qs,fmt:fv('p_fmt')};
  const kpStat={};
  qs.forEach(q=>{ const kp=(q.text.match(/「([^」]+)」/)||[])[1]||'未标注知识点'; kpStat[kp]=(kpStat[kp]||0)+1; });
  const statHtml=`<div style="margin-top:10px"><div style="font-size:13px;color:#5b6b78;margin-bottom:6px">双向细目表（知识点分布）</div>${
    Object.keys(kpStat).map(k=>`<span class="tag tag-blue" style="margin:2px">${esc(k)} · ${kpStat[k]}题</span>`).join('')
  }</div>`;
  document.getElementById('paperPreview').innerHTML=
    `<div class="notice">已生成 <b>${qs.length}</b> 道题 · ${esc(_lastPaper.title)} · ${_lastPaper.fmt}</div>`+
    qs.slice(0,6).map((q,i)=>`<div style="border-bottom:1px dashed #dde7ef;padding:8px 0;font-size:13px"><b>${i+1}. [${esc(q.qtype)}]</b><br>${nl2br(q.text)}</div>`).join('')+
    (qs.length>6?`<div class="empty" style="padding:10px">…共${qs.length}题，导出/打印查看完整试卷</div>`:'')+statHtml;
  toast('试卷已生成，可导出Word/PDF或直接打印');
}
function paperHtml(p){
  let html=`<h1>${esc(p.title)}</h1>
  <div class="p-info-line"><span>班级：__________</span><span>姓名：__________</span><span>学号：______</span><span>得分：______</span></div>`;
  let group=''; let n=0;
  p.qs.forEach(q=>{
    if(q.qtype!==group){ group=q.qtype; html+=`<h2>${esc(group)}</h2>`; n=0; }
    n++;
    html+=`<div class="p-q"><b>${n}.</b> <pre>${esc(q.text)}</pre><div class="p-space-${p.space}"></div></div>`;
  });
  if(p.withAns||p.withAna){
    html+=`<h2 style="page-break-before:always">参考答案与解析（教师版）</h2><table><tr><th style="width:40px">题号</th><th>答案</th><th>解析</th></tr>`;
    let i=0; p.qs.forEach(q=>{ html+=`<tr><td>${++i}</td><td>${esc(q.ans||'—')}</td><td>${esc(q.ana||'—')}</td></tr>`; });
    html+=`</table>`;
  }
  return html;
}
function paperExport(mode){
  if(!_lastPaper){ toast('请先生成试卷'); return; }
  const html=paperHtml(_lastPaper);
  if(mode==='word') exportWordDoc(_lastPaper.title,html);
  else if(mode==='pdf') exportPDFDoc(html);
  else doPrint(html);
}
function aiPaper(){
  const kps=fv('p_kps'); const subj=fv('p_subject'); const grade=fv('p_grade'); const qt=(pills('p_qtypes')||[]).join('、');
  if(!kps && !DB.mistakes.length){ toast('请先填写知识点，或在错题库选好错题'); return; }
  const sys='你是中小学出题专家，能按知识点、题型与难度生成高质量练习题，含答案与解析。';
  let user;
  if(fv('p_kps')){
    user=`请为${grade||''}${subj||'小学'}生成一套练习题：\n知识点：${kps}\n题型：${qt||'综合'}\n难度：由易到难。\n每题包含：题干、答案、解析。请直接列出题目。`;
  }else{
    user=`请根据以下错题设计一份变式练习卷（${subj||''}）：\n`+
      mistakeList().slice(0,5).map(m=>`- ${(m.ocr||'').split('\n')[0]}（知识点：${m.kp||''}；错误原因：${m.reason||''}）`).join('\n')+
      `\n\n请生成6-8道变式题，涵盖上述知识点，难度递增，每题含题干、答案、解析。`;
  }
  showAiResult('AI 智能出题 · '+subj+grade, sys, user);
}
function showAiResult(title, sys, user){
  openModal(title, `<div class="notice">AI 正在生成，请稍候…（若未配置AI密钥将自动回退提示）</div><textarea id="aiOut" class="result-box" style="min-height:320px" placeholder="AI 生成内容将显示在这里，可直接编辑、复制"></textarea>`,
    `<button class="btn" onclick="copyEl('aiOut')">复制</button><button class="btn" onclick="closeModal()">关闭</button>`);
  const box=document.getElementById('aiOut');
  if(ONLINE){
    api.ai(sys,user).then(r=>{
      box.value=(r.ok&&r.text&&r.text.trim())?r.text:(r.fallback?'（未配置AI密钥，暂无法智能生成。本工作台已保留模板生成功能，可在右上角「基础设置」或联系管理员配置AI）':'（AI返回为空）');
    }).catch(e=>box.value='生成出错：'+e.message);
  }else{
    box.value='（当前为本地模式，未登录云端。登录后即可使用 AI 智能生成——老师无需自己的密钥，由平台统一提供。）';
  }
}
function copyEl(id){
  const v=document.getElementById(id).value;
  if(!v){ toast('没有可复制的内容'); return; }
  navigator.clipboard? navigator.clipboard.writeText(v).then(()=>toast('已复制到剪贴板')) :
    (document.getElementById(id).select(), document.execCommand('copy'), toast('已复制'));
}

/* ==================== 8.5 我的题库（沉淀与复用） ==================== */
let bankState={subject:'',grade:'',qtype:'',level:'',q:''};
let _bankImg='';
function bankArr(){ DB.bank=DB.bank||[]; return DB.bank; }
function bankPush(it){
  DB.bank=DB.bank||[];
  DB.bank.unshift({id:uid(),qtype:it.qtype||'综合题',subject:it.subject||'',grade:it.grade||'',kp:it.kp||'',
    level:it.level||'',text:it.text||'',ans:it.ans||'',ana:it.ana||'',source:it.source||'',
    tags:it.tags||[],img:it.img||'',createdAt:today(),used:0});
  save();
}
function bankFilter(){
  const q=bankState.q.toLowerCase();
  return bankArr().filter(b=>
    (!bankState.subject||b.subject===bankState.subject)&&
    (!bankState.grade||b.grade===bankState.grade)&&
    (!bankState.qtype||b.qtype===bankState.qtype)&&
    (!bankState.level||b.level===bankState.level)&&
    (!q||(b.text+' '+(b.kp||'')+' '+(b.subject||'')+' '+((b.tags||[]).join(' '))).toLowerCase().includes(q)));
}
function bankFilterGo(){
  bankState.subject=document.getElementById('bk_subject').value;
  bankState.grade=document.getElementById('bk_grade').value;
  bankState.qtype=document.getElementById('bk_qtype').value;
  bankState.level=document.getElementById('bk_level').value;
  bankState.q=(document.getElementById('bk_search').value||'').trim();
  renderBank();
}
function renderBank(){
  const list=bankFilter();
  document.getElementById('page').innerHTML=`
  <div class="page-head">
    <div><div class="page-title title-indigo">我的题库 · 沉淀与复用</div><div class="page-desc">把生成的变式题、试卷题、错题例题沉淀到这里，按学科/知识点检索复用，形成你自己的可检索资源库。</div></div>
    ${moduleToolbar([
      `<button class="btn btn-primary" onclick="bankAdd()">+ 新增题目</button>`,
      `<button class="btn" onclick="bankImport()">从Excel导入</button>`,
      `<button class="btn" onclick="bankExport('word')">导出Word</button>`,
      `<button class="btn" onclick="bankExport('pdf')">导出PDF</button>`,
      `<button class="btn" onclick="bankExport('print')">A4打印</button>`
    ])}
  </div>
  <div class="card">
    <div class="filter-bar" style="flex-wrap:wrap">
      ${subSelectHtml(bankState.subject,'bk_subject','全部学科','','bankFilterGo()')}
      <select id="bk_grade" onchange="bankFilterGo()">${optHtml(DB.meta.grades,bankState.grade,'全部年级')}</select>
      <select id="bk_qtype" onchange="bankFilterGo()">${optHtml(['','选择题','填空题','判断题','计算题','应用题','阅读题','简答题','作文题','实验题','综合题'],bankState.qtype,'全部题型')}</select>
      <select id="bk_level" onchange="bankFilterGo()">${optHtml(['','基础题','提高题','挑战题'],bankState.level,'全部难度')}</select>
      <input id="bk_search" placeholder="搜索题干/知识点/标签" value="${esc(bankState.q)}" oninput="bankFilterGo()" style="width:200px">
      <span class="tag tag-indigo">共 ${list.length} 题</span>
    </div>
    ${list.length? list.map(bankCard).join('') : '<div class="empty" style="padding:30px">题库还是空的。去「错题管理库」生成变式题时点击「沉淀到我的题库」，或点上方「+ 新增题目」手动添加。</div>'}
  </div>`;
}
function bankCard(b){
  const lvColor=b.level==='基础题'?'#22a565':b.level==='提高题'?'#f59e0b':'#e5465e';
  return `
  <div style="background:#fff;border:1px solid #e8edf2;border-radius:12px;padding:16px;margin-bottom:14px;box-shadow:0 2px 8px rgba(99,102,241,.05)">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px">
      <span class="tag tag-indigo">${esc(b.qtype)}</span>
      ${b.subject?`<span class="tag tag-gray">${esc(b.subject)}</span>`:''}
      ${b.grade?`<span class="tag tag-gray">${esc(b.grade)}</span>`:''}
      ${b.kp?`<span class="tag tag-blue">${esc(b.kp)}</span>`:''}
      ${b.level?`<span style="background:${lvColor}15;color:${lvColor};border:1px solid ${lvColor}30;padding:2px 8px;border-radius:6px;font-size:12px;font-weight:600">${esc(b.level)}</span>`:''}
      <span style="margin-left:auto;font-size:12px;color:#9aa7b5">${esc(b.source||'')}${b.createdAt?' · '+b.createdAt:''}</span>
    </div>
    <pre style="margin:0 0 10px;white-space:pre-wrap;word-break:break-word;line-height:1.7;color:#1a2b3c;font-size:14px">${esc(b.text)}</pre>
    ${b.img?`<img src="${b.img}" style="max-width:200px;max-height:140px;border-radius:8px;border:1px solid #eef3f8;margin-bottom:10px">`:''}
    <div style="background:#f7f9fc;border-radius:8px;padding:10px;border:1px dashed #e2e8f0;font-size:13px;line-height:1.7;color:#4a5d75">
      <b style="color:${lvColor||'#6366f1'}">答案：</b>${esc(b.ans||'（待补充）')}<br>
      <b style="color:${lvColor||'#6366f1'}">解析：</b>${esc(b.ana||'（待补充）')}
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
      <button class="btn btn-sm" onclick="bankCopyText('${b.id}')">复制题干</button>
      <button class="btn btn-sm" onclick="bankEdit('${b.id}')">编辑</button>
      <button class="btn btn-sm" onclick="bankDel('${b.id}')">删除</button>
    </div>
  </div>`;
}
function bankForm(b){
  b=b||{};
  return `
  <div class="form-grid">
    <div class="form-item"><label>题型</label><select id="bk_qtype2">${optHtml(DB.meta.qtypes,b.qtype||'计算题')}</select></div>
    <div class="form-item"><label>学科</label>${subSelectHtml(b.subject||'数学','bk_subject2')}</div>
    <div class="form-item"><label>年级</label><select id="bk_grade2">${optHtml(DB.meta.grades,b.grade||'三年级')}</select></div>
    <div class="form-item"><label>难度</label><select id="bk_level2">${optHtml(['基础题','提高题','挑战题'],b.level||'基础题')}</select></div>
    <div class="form-item full"><label>知识点</label><input id="bk_kp2" value="${esc(b.kp||'')}" placeholder="如：多位数乘一位数"></div>
    <div class="form-item full"><label>题干</label><textarea id="bk_text2" style="min-height:90px">${esc(b.text||'')}</textarea></div>
    <div class="form-item full"><label>答案</label><textarea id="bk_ans2" style="min-height:44px">${esc(b.ans||'')}</textarea></div>
    <div class="form-item full"><label>解析</label><textarea id="bk_ana2" style="min-height:44px">${esc(b.ana||'')}</textarea></div>
    <div class="form-item full"><label>标签（逗号分隔）</label><input id="bk_tags2" value="${esc((b.tags||[]).join('，'))}" placeholder="如：期末复习，易错题"></div>
    <div class="form-item full"><label>配图（可选）</label><input type="file" accept="image/*" onchange="bankStageImg(this)"></div>
    <div class="form-item full" id="bk_imgPrev">${b.img?`<img src="${b.img}" style="max-width:200px;max-height:140px;border-radius:8px;border:1px solid #dde7ef">`:''}</div>
  </div>`;
}
function bankStageImg(input){
  const f=input.files[0]; if(!f) return;
  const r=new FileReader();
  r.onload=e=>{ _bankImg=e.target.result; document.getElementById('bk_imgPrev').innerHTML=`<img src="${_bankImg}" style="max-width:200px;max-height:140px;border-radius:8px;border:1px solid #dde7ef">`; };
  r.readAsDataURL(f);
}
function bankAdd(){ _bankImg=''; openModal('新增题目', bankForm(),
  `<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="bankSave('')">保存</button>`); }
function bankEdit(id){ const b=bankArr().find(x=>x.id===id); _bankImg=b.img||''; openModal('编辑题目', bankForm(b),
  `<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="bankSave('${id}')">保存</button>`); }
function bankSave(id){
  const obj={qtype:fv('bk_qtype2'),subject:fv('bk_subject2'),grade:fv('bk_grade2'),level:fv('bk_level2'),
    kp:fv('bk_kp2'),text:fv('bk_text2'),ans:fv('bk_ans2'),ana:fv('bk_ana2'),
    tags:(fv('bk_tags2')||'').split(/[，,]/).map(s=>s.trim()).filter(Boolean),img:_bankImg,source:'手动添加',createdAt:today()};
  if(id){ const i=bankArr().findIndex(x=>x.id===id); if(i>=0)bankArr()[i]={...bankArr()[i],...obj}; }
  else bankArr().unshift({id:uid(),used:0,...obj});
  save(); closeModal(); renderBank(); toast('已保存到我的题库');
}
function bankDel(id){ if(!confirm('确定从题库删除这道题吗？'))return; DB.bank=DB.bank.filter(x=>x.id!==id); save(); renderBank(); }
function bankCopyText(id){ const b=bankArr().find(x=>x.id===id); if(!b){toast('未找到');return;} copyText(b.text); toast('题干已复制'); }
function copyText(t){ if(navigator.clipboard){ navigator.clipboard.writeText(t).then(()=>{}).catch(()=>{}); } else { window.prompt('复制下面的题干：',t); } }
function bankImport(){
  openModal('从Excel/CSV导入题目',
   `<div class="notice">选择 Excel(.xlsx/.xls) 或 CSV 文件，第一行为表头：<b>题型,学科,年级,知识点,难度,题干,答案,解析</b>；也可直接粘贴文本（每行一题，逗号分隔各字段）。</div>
    <div class="form-item full"><label>选择文件</label><input type="file" id="bk_file" accept=".xlsx,.xls,.csv,.txt" onchange="bankFileToArea(this)"></div>
    <div class="form-item full"><label>或粘贴文本</label><textarea id="bk_paste" style="min-height:140px" placeholder="计算题,数学,三年级,多位数乘一位数,基础题,24×3=?,72,进位乘法"></textarea></div>`,
   `<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="bankImportDo()">导入</button>`,true);
}
function bankFileToArea(input){
  const f=input.files[0]; if(!f) return;
  if(/\.xlsx?$/i.test(f.name)){ readXlsx(f, rows=>{ if(rows){ const body=rows.slice(1).map(r=>r.join(',')).join('\n'); document.getElementById('bk_paste').value=body; toast('已读取Excel，请确认后点导入'); } }); }
  else readFileText(f, t=>{ document.getElementById('bk_paste').value=t; toast('已读取文件'); });
}
function bankImportDo(){
  const txt=document.getElementById('bk_paste').value.trim();
  if(!txt){ toast('请先选择文件或粘贴文本'); return; }
  const rows=parseCSVText(txt);
  let n=0;
  rows.forEach(c=>{
    if(!c[0]&&!c[5]) return;
    bankPush({qtype:c[0],subject:c[1],grade:c[2],kp:c[3],level:c[4],text:c[5],ans:c[6]||'',ana:c[7]||'',source:'Excel导入'});
    n++;
  });
  if(!n){ toast('没有可导入的题目（检查格式）'); return; }
  closeModal(); renderBank(); toast('成功导入 '+n+' 道题到我的题库');
}
function bankExport(mode){
  const list=bankFilter();
  if(!list.length){ toast('题库为空，无法导出'); return; }
  let html=`<h1>我的题库（共 ${list.length} 题）</h1><div class="p-info-line"><span>导出日期：${today()}</span><span>学科：${bankState.subject||'全部'}</span><span>年级：${bankState.grade||'全部'}</span></div>`;
  list.forEach((b,i)=>{
    const lv=b.level||'';
    html+=`<h2>第 ${i+1} 题 · ${esc(b.qtype)}${b.kp?'（'+esc(b.kp)+'）':''}${lv?' · '+esc(lv):''}</h2>`+
      `<div class="p-q"><pre>${esc(b.text)}</pre>${b.img?`<img src="${b.img}">`:''}<div class="p-ans"><b>答案：</b>${esc(b.ans||'—')}<br><b>解析：</b>${esc(b.ana||'—')}</div></div>`;
  });
  if(mode==='word') exportWordDoc('我的题库',html);
  else if(mode==='pdf') exportPDFDoc(html);
  else doPrint(html);
}
/* 沉淀入口：变式题 / 试卷 → 我的题库 */
function variantsToBank(id){
  const m=DB.mistakes.find(x=>x.id===id); if(!m)return;
  let n=0;
  for(let i=0;i<3;i++){
    const q=fv('vq'+i); if(!q||!q.trim())continue;
    bankPush({qtype:'变式题',subject:m.subject,grade:m.grade,kp:m.kp,level:['基础题','提高题','挑战题'][i],
      text:q,ans:fv('va'+i),ana:fv('vs'+i),source:'变式生成',img:(window._variantImgs&&window._variantImgs[i]||{}).data||''});
    n++;
  }
  if(!n){ toast('没有可沉淀的题目（请先生成/编辑变式题）'); return; }
  toast('已沉淀 '+n+' 道变式题到「我的题库」');
}
function paperToBank(){
  if(!_lastPaper){ toast('请先生成试卷'); return; }
  let n=0;
  _lastPaper.qs.forEach(q=>{
    const kp=(q.text.match(/「([^」]+)」/)||[])[1]||'';
    bankPush({qtype:q.qtype,subject:_lastPaper.subject,grade:_lastPaper.grade,kp:kp,text:q.text,ans:q.ans,ana:q.ana,source:'试卷生成'});
    n++;
  });
  toast('已沉淀 '+n+' 道试卷题到「我的题库」');
}

/* ==================== 9. 学生与班级管理 ==================== */
let stuSort={key:'sno',asc:true};
function renderStudents(){
  let list=DB.students.filter(s=>
    (!F.grade||s.grade===F.grade)&&(!F.cls||s.cls===F.cls)&&
    matchQ(F.q,[s.name,s.sno,s.cls,s.grade,s.phone,s.note,(s.tags||[]).join(' ')]));
  list.sort((a,b)=>{const k=stuSort.key;const r=String(a[k]).localeCompare(String(b[k]),'zh');return stuSort.asc?r:-r;});
  document.getElementById('page').innerHTML=`
  <div class="page-head">
    <div><div class="page-title title-teal">学生名单与班级管理</div><div class="page-desc">学生信息关联错题记录、成绩记录与分层标签（点击姓名查看学生档案）</div></div>
    ${moduleToolbar([
      `<button class="btn btn-primary" onclick="stuAdd()">+ 新增学生</button>`,
      `<button class="btn" onclick="importStudents()">批量导入（Excel/CSV）</button>`,
      `<button class="btn" onclick="stuBatchAdd()">批量新增</button>`,
      `<button class="btn" onclick="exportStuList('word')">导出Word</button>`,
      `<button class="btn" onclick="exportStuList('pdf')">导出PDF</button>`,
      `<button class="btn" onclick="exportStuList('print')">A4打印</button>`,
      `<button class="btn btn-danger" onclick="clearSampleData()">清空示例数据</button>`
    ])}
  </div>
  <div class="card">
    <div class="card-title title-teal">班级管理 <span class="filter-label" style="font-weight:400">（完全由你维护，支持新增/修改/删除，一键清空）</span></div>
    <div class="filter-bar" style="gap:8px;flex-wrap:wrap;margin-bottom:10px">
      <input id="new_cls_name" placeholder="输入新班级，如：三年级1班、七年级3班" style="flex:1 1 180px;min-width:120px">
      <button class="btn btn-primary" onclick="classAdd(fv('new_cls_name'))&&render()">+ 新增班级</button>
      ${classList().length?`<button class="btn" onclick="classClearAll()">一键清空班级</button>`:''}
    </div>
    ${classList().length?`<div style="display:flex;gap:8px;flex-wrap:wrap">${classList().map(c=>`<span class="tag tag-blue" style="display:inline-flex;align-items:center;gap:4px;padding:6px 10px">${esc(c)}
      <span class="link" style="font-size:12px" onclick="classEditPrompt('${jsEsc(c)}')">✎</span>
      <span class="link" style="font-size:12px;color:#e11d48" onclick="classDelPrompt('${jsEsc(c)}')">×</span>
    </span>`).join('')}</div>`:`<div class="notice">暂无班级。请先在上方输入并新增班级（如「三年级1班」「七年级3班」……可一次性添加多个），再录入学生。</div>`}
  </div>
  <div class="card">
    <div class="filter-bar" style="justify-content:space-between;align-items:center">
      <span class="filter-label">共 ${list.length} 名学生（班级筛选请用顶部筛选栏，当前：${F.cls||'全部班级'}）· 点击表头排序</span>
      <div class="toolbar" style="margin:0">
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:12px"><input type="checkbox" onchange="document.querySelectorAll('.stu-chk').forEach(c=>c.checked=this.checked)"> 全选</label>
        <button class="btn btn-sm btn-danger" onclick="stuBatchDel()">批量删除</button>
      </div>
    </div>
    <div class="tbl-wrap"><table class="tbl">
      <tr>
        <th class="nosort" style="width:36px"><input type="checkbox" onclick="document.querySelectorAll('.stu-chk').forEach(c=>c.checked=this.checked)" title="全选"></th>
        <th onclick="stuSortBy('name')">姓名 ${stuSort.key==='name'?(stuSort.asc?'↑':'↓'):''}</th>
        <th onclick="stuSortBy('gender')">性别</th>
        <th onclick="stuSortBy('sno')">学号 ${stuSort.key==='sno'?(stuSort.asc?'↑':'↓'):''}</th>
        <th onclick="stuSortBy('cls')">班级</th>
        <th onclick="stuSortBy('grade')">年级</th>
        <th class="nosort">家长联系方式</th><th class="nosort">学生标签</th><th class="nosort">错题</th><th class="nosort">备注</th><th class="nosort">操作</th></tr>
      ${list.map(s=>{
        const mc=DB.mistakes.filter(m=>m.studentId===s.id).length;
        return `<tr>
        <td><input type="checkbox" class="stu-chk" value="${s.id}"></td>
        <td><span class="link" onclick="stuView('${s.id}')"><b>${esc(s.name)}</b></span></td>
        <td>${esc(s.gender)}</td><td>${esc(s.sno)}</td><td>${esc(s.cls)}</td><td>${esc(s.grade)}</td>
        <td>${esc(s.phone)}</td>
        <td>${s.tags.map(t=>`<span class="tag ${['需要关注','基础薄弱','心理敏感','纪律提醒'].includes(t)?'tag-red':['学习优秀','进步明显'].includes(t)?'tag-green':['作业拖拉'].includes(t)?'tag-yellow':'tag-blue'}">${esc(t)}</span>`).join('')||'—'}</td>
        <td class="num">${mc?`<span class="link" onclick="MF.stu='${s.id}';nav('mistakes')">${mc}题</span>`:'0'}</td>
        <td>${esc(s.note)||'—'}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-sm" onclick="gotoGrowth('${s.id}')">档案</button>
          <button class="btn btn-sm" onclick="stuEdit('${s.id}')">编辑</button>
          <button class="btn btn-sm btn-danger" onclick="stuDel('${s.id}')">删除</button>
        </td></tr>`;}).join('') || '<tr><td colspan="11">'+emptyState('还没有学生','先从 Excel 粘贴或批量新增，再录入成绩与错题。', '<button class="btn btn-primary" onclick="stuAdd()">+ 新增学生</button><button class="btn" onclick="importStudents()">批量导入</button>')+'</td></tr>'}
    </table></div>
  </div>`;
}
function stuSortBy(k){ if(stuSort.key===k)stuSort.asc=!stuSort.asc; else{stuSort.key=k;stuSort.asc=true;} render(); }
function stuForm(s){
  s=s||{};
  return `<div class="form-grid">
    <div class="form-item"><label>学生姓名 <i>*</i></label><input id="f_sname" value="${esc(s.name||'')}"></div>
    <div class="form-item"><label>性别</label><select id="f_sgender">${optHtml(['男','女'],s.gender||'男')}</select></div>
    <div class="form-item"><label>学号</label><input id="f_ssno" value="${esc(s.sno||'')}"></div>
    <div class="form-item"><label>班级</label>${clsSelectHtml(s.cls||F.cls||classList()[0]||'','f_scls','')}</div>
    <div class="form-item"><label>年级</label><select id="f_sgrade">${optHtml(DB.meta.grades,s.grade||F.grade||'三年级')}</select></div>
    <div class="form-item"><label>家长联系方式</label><input id="f_sphone" value="${esc(s.phone||'')}"></div>
    <div class="form-item full"><label>学生标签</label>${pillHtml('f_stags',DB.meta.stuTags,s.tags||[])}</div>
    <div class="form-item full"><label>备注</label><textarea id="f_snote" style="min-height:50px">${esc(s.note||'')}</textarea></div>
  </div>`;
}
function stuAdd(){ openModal('新增学生', stuForm(),
  `<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="stuSave('')">保存</button>`,true); }
function stuEdit(id){ openModal('编辑学生', stuForm(stuById(id)),
  `<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="stuSave('${id}')">保存</button>`,true); }
function stuSave(id){
  if(!fv('f_sname')){ toast('请填写学生姓名'); return; }
  const cls=fv('f_scls');
  if(cls){ if(!DB.meta.classes.includes(cls)) DB.meta.classes.push(cls); DB.meta.classes.sort((a,b)=>a.localeCompare(b,'zh')); }
  const obj={id:id||uid(),name:fv('f_sname'),gender:fv('f_sgender'),sno:fv('f_ssno'),cls:cls,
    grade:fv('f_sgrade'),phone:fv('f_sphone'),note:fv('f_snote'),tags:pills('f_stags')};
  if(id){ const i=DB.students.findIndex(x=>x.id===id); DB.students[i]=obj; } else DB.students.push(obj);
  save(); closeModal(); render(); toast('学生信息已保存');
}
function stuDel(id){
  const mc=DB.mistakes.filter(m=>m.studentId===id).length;
  if(!confirm('确定删除该学生吗？'+(mc?'（其名下'+mc+'条错题记录将保留但显示为未关联）':''))) return;
  DB.students=DB.students.filter(x=>x.id!==id); save(); render();
}
function stuBatchDel(){
  const ids=[...document.querySelectorAll('.stu-chk:checked')].map(c=>c.value);
  if(!ids.length){ toast('请先勾选要删除的学生'); return; }
  if(!confirm('确定批量删除 '+ids.length+' 名学生吗？')) return;
  DB.students=DB.students.filter(s=>!ids.includes(s.id)); save(); render(); toast('已删除 '+ids.length+' 名学生');
}
function stuBatchAdd(){
  const defaultCls=classList()[0]||'';
  const body=`<div class="form-grid" style="grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
    <div class="form-item full" style="grid-column:1/-1"><label>粘贴学生名单</label>
      <textarea id="ba_list" rows="10" style="width:100%;padding:12px;border:1px solid var(--line);border-radius:10px;font-family:inherit;line-height:1.7" placeholder="每行一个学生，格式：姓名,性别,学号,班级,年级,电话,备注&#10;性别、学号、电话、备注可省略&#10;王小明,男,2024001,三年级1班,三年级,138****1234&#10;李小红,女,2024002,三年级1班" oninput="baParse()"></textarea>
      <div class="form-hint" style="margin-top:6px">支持逗号/制表符分隔；若某行没写班级，会自动使用下方“默认班级”。</div>
    </div>
    <div class="form-item"><label>默认班级（行内未填班级时使用）</label>${clsSelectHtml(defaultCls,'ba_cls','')}</div>
    <div class="form-item" style="display:flex;align-items:flex-end"><div id="ba_hint" class="form-hint" style="padding-bottom:10px">请输入或粘贴名单</div></div>
  </div>`;
  openModal('批量新增学生',body,
    `<button class="btn btn-primary" onclick="stuBatchAddSave()">保存</button><button class="btn" onclick="closeModal()">取消</button>`);
  setTimeout(baParse,0);
}
function baParse(){
  const text=fv('ba_list');
  const lines=text.split(/\n/).filter(l=>l.trim());
  let ok=0, bad=0;
  lines.forEach(line=>{
    const parts=line.split(/[,，\t]/).map(s=>s.trim()).filter(Boolean);
    if(!parts.length) return;
    if(parts[0]) ok++; else bad++;
  });
  const el=document.getElementById('ba_hint');
  if(el) el.innerHTML=`共识别 <b>${ok}</b> 名学生${bad?`，<span style="color:#d9534f">${bad} 行姓名缺失</span>`:''}`;
}
function stuBatchAddSave(){
  const text=fv('ba_list'); if(!text.trim()){toast('请粘贴名单');return;}
  const defaultCls=fv('ba_cls');
  const lines=text.split(/\n/).filter(l=>l.trim());
  let ok=0; const addedClasses=new Set();
  lines.forEach(line=>{
    const parts=line.split(/[,，\t]/).map(s=>s.trim());
    const [name,gender,sno,cls,grade,phone,note]=parts;
    if(!name) return;
    let finalCls=cls||defaultCls||'';
    if(finalCls){ if(!DB.meta.classes.includes(finalCls)) DB.meta.classes.push(finalCls); DB.meta.classes.sort((a,b)=>a.localeCompare(b,'zh')); addedClasses.add(finalCls); }
    if(grade&&!DB.meta.grades.includes(grade)) DB.meta.grades.push(grade);
    DB.students.push({id:uid(),name,gender:gender||'男',sno:sno||'',cls:finalCls,grade:grade||'',phone:phone||'',note:note||'',tags:[]});
    ok++;
  });
  if(!ok){ toast('没有成功识别到学生，请检查格式'); return; }
  save(); closeModal();
  // 新增后清空搜索，方便立刻看到新学生
  F.q=''; const gs=document.getElementById('gSearch'); if(gs) gs.value='';
  // 若只新增到一个班级，自动聚焦该班级；否则显示全部
  if(addedClasses.size===1){ F.cls=[...addedClasses][0]; }
  fillGlobalSelects(); render();
  toast('成功新增 '+ok+' 名学生');
}
function stuView(id){
  const s=stuById(id); if(!s){ toast('未找到该学生'); return; }
  const ms=DB.mistakes.filter(m=>m.studentId===id);
  const es=DB.exams.filter(e=>e.records.some(r=>r.sid===id||r.name===s.name));
  const layerOf=score=>(score>=0.9?'A层':score>=0.75?'B层':score>=0.6?'C层':'D层');
  const layerTag=p=>`<span class="tag tag-${p>=0.9?'green':p>=0.75?'blue':p>=0.6?'yellow':'red'}">${layerOf(p)}</span>`;
  const infoCard=`
    <div style="background:linear-gradient(135deg,#f2f7fc 0%,#ffffff 100%);border:1px solid #e8edf2;border-radius:14px;padding:18px 20px;margin-bottom:14px;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <div style="width:56px;height:56px;border-radius:16px;background:linear-gradient(135deg,var(--blue) 0%,#4aa3e3 100%);color:#fff;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700">${esc(s.name.slice(0,1))}</div>
      <div style="flex:1;min-width:200px">
        <div style="font-size:18px;font-weight:700;color:#1a2b3c;margin-bottom:4px">${esc(s.name)}</div>
        <div style="font-size:13px;color:#5b6b78;line-height:1.7">
          ${esc(s.grade)} ${esc(s.cls)} · 学号 ${esc(s.sno)||'—'} · ${esc(s.gender)} · 家长电话 ${esc(s.phone)||'—'}
        </div>
        <div style="margin-top:6px">${s.tags.map(t=>`<span class="tag tag-blue">${esc(t)}</span>`).join('')||'<span style="color:#8c9bab;font-size:12px">暂无标签</span>'}</div>
      </div>
      ${s.note?`<div style="flex:1;min-width:220px;background:#fff;border-radius:10px;padding:12px;border:1px solid #eef3f8"><div style="font-size:12px;color:#8c9bab;margin-bottom:4px">备注</div><div style="font-size:13px;color:#2c3e50">${esc(s.note)}</div></div>`:''}
    </div>`;
  const scoreCard=es.length?`
    <div style="background:#fff;border:1px solid #e8edf2;border-radius:12px;padding:16px;margin-bottom:14px">
      <div style="font-size:13px;font-weight:600;color:#1f5fa8;margin-bottom:12px;display:flex;align-items:center;gap:6px"><span>📊</span><span>成绩记录（${es.length}场）</span></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px">
        ${es.map(e=>{const r=e.records.find(r=>r.sid===id||r.name===s.name);const p=r.score/e.full;return `
          <div style="background:#fbfdfe;border:1px solid #eef3f8;border-radius:10px;padding:12px">
            <div style="font-size:12px;color:#5b6b78;margin-bottom:4px">${esc(e.name)} · ${esc(e.subject)}</div>
            <div style="font-size:20px;font-weight:700;color:#1a2b3c">${r.score}<span style="font-size:12px;color:#8c9bab;font-weight:400">/${e.full}</span></div>
            <div style="margin-top:6px">${layerTag(p)}</div>
          </div>`;}).join('')}
      </div>
    </div>`:`<div class="empty" style="padding:16px;border-radius:12px;margin-bottom:14px">暂无成绩记录</div>`;
  const mistakeCard=ms.length?`
    <div style="background:#fff;border:1px solid #e8edf2;border-radius:12px;padding:16px;margin-bottom:14px">
      <div style="font-size:13px;font-weight:600;color:#1f5fa8;margin-bottom:12px;display:flex;align-items:center;gap:6px"><span>📝</span><span>错题记录（${ms.length}题，未掌握 ${ms.filter(m=>!m.mastered).length}题）</span></div>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${ms.map(m=>`
          <div style="background:#fbfdfe;border:1px solid #eef3f8;border-radius:10px;padding:12px;display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap">
            <div style="flex:1;min-width:200px">
              <div style="font-size:13px;color:#1a2b3c;line-height:1.6">${esc((m.ocr||'').slice(0,60))}${(m.ocr||'').length>60?'…':''}</div>
              <div style="margin-top:6px">${esc(m.subject)} · <span class="tag tag-blue">${esc(m.kp||'未标注')}</span> · <span class="tag tag-yellow">${esc(m.reason)}</span></div>
            </div>
            <div>${m.mastered?'<span class="tag tag-green">已掌握</span>':'<span class="tag tag-red">未掌握</span>'}</div>
          </div>`).join('')}
      </div>
    </div>`:`<div class="empty" style="padding:16px;border-radius:12px;margin-bottom:14px">暂无错题记录</div>`;
  const adviceCard=`
    <div style="background:#fff;border:1px solid #e8edf2;border-radius:12px;padding:16px">
      <div style="font-size:13px;font-weight:600;color:#1f5fa8;margin-bottom:12px;display:flex;align-items:center;gap:6px"><span>💡</span><span>辅导建议</span></div>
      <div style="line-height:1.8;color:#2c3e50;font-size:13px">${stuAdvice(s,ms,es)}</div>
    </div>`;
  openModal('学生档案 · '+s.name,`
  <div style="max-width:800px;margin:0 auto;padding:4px">
    ${infoCard}${scoreCard}${mistakeCard}${adviceCard}
  </div>`,
  `<button class="btn btn-primary" onclick="closeModal();gotoGrowth('${id}')">查看成长档案</button><button class="btn" onclick="stuEdit('${id}')">编辑信息</button><button class="btn" onclick="closeModal()">关闭</button>`);
}
function stuAdvice(s,ms,es){
  const parts=[];
  const weak=[...new Set(ms.filter(m=>!m.mastered).map(m=>m.kp).filter(Boolean))];
  if(weak.length) parts.push(`未掌握知识点：${weak.join('、')}，建议使用错题库「巩固练习」功能生成专项训练。`);
  if(s.tags.includes('基础薄弱')) parts.push('基础薄弱：建议降低起点、小步推进，每日安排基础打卡。');
  if(s.tags.includes('作业拖拉')) parts.push('作业拖拉：建议拆分作业任务、当日面批，并与家长约定完成时间。');
  if(s.tags.includes('心理敏感')) parts.push('心理敏感：多用鼓励性评价，避免当众批评。');
  if(s.tags.includes('学习优秀')) parts.push('学有余力：可布置拓展任务，担任小组长/小老师。');
  return parts.join('<br>')||'表现平稳，保持常规关注即可。';
}
function gotoGrowth(sid){
  const st=DB.students.find(s=>s.id===sid); if(!st){toast('未找到该学生');return;}
  _growthCls=st.cls||''; _growthSid=sid; nav('growth');
}
function importStudents(){
  openModal('批量导入学生名单',`
  <div class="notice">支持三种方式：① 从 Excel 复制后粘贴；② 直接选择 <b>.xlsx/.xls</b> 文件（自动解析）；③ 上传名单照片，自动 OCR 识别为文本（中文，需联网）。每行格式：<b>姓名,性别,学号,班级,年级,家长电话,备注</b>（姓名必填，其余可空）。</div>
  <div class="form-item full"><label>粘贴区</label><textarea id="f_scsv" style="min-height:150px" placeholder="王小明,男,2024001,三年级1班,三年级,138xxxx1234,&#10;李思雨,女,2024002,三年级1班,三年级,,"></textarea></div>
  <div class="form-item full"><label>或选择 Excel 文件(.xlsx/.xls)</label><input type="file" accept=".xlsx,.xls" onchange="readXlsx(this.files[0],rows=>{if(rows)document.getElementById('f_scsv').value=rows.map(r=>r.join(',')).join('\\n')})"></div>
  <div class="form-item full"><label>或选择 CSV 文件</label><input type="file" accept=".csv,.txt" onchange="readFileText(this.files[0],t=>document.getElementById('f_scsv').value=t)"></div>
  <div class="form-item full"><label>或上传名单照片（自动 OCR 识别）</label><input type="file" accept="image/*" onchange="stuPhotoOCR(this)"></div>`,
  `<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="doImportStudents()">导入</button>`,true);
}
function stuPhotoOCR(input){
  const f=input.files[0]; if(!f) return;
  if(typeof Tesseract==='undefined'){ toast('OCR 库未加载（需联网），请手动粘贴名单'); return; }
  toast('正在识别名单照片，请稍候…');
  runOCR(f).then(t=>{ const el=document.getElementById('f_scsv'); if(t){ el.value=t; toast('OCR 完成，请校对姓名/班级'); } else toast('识别为空，请手动粘贴'); });
}
function doImportStudents(){
  const rows=parseCSVText(fv('f_scsv'));
  let ok=0;
  rows.forEach(r=>{
    const [name,gender,sno,cls,grade,phone,note]=r;
    if(!name)return;
    if(cls){ if(!DB.meta.classes.includes(cls)) DB.meta.classes.push(cls); DB.meta.classes.sort((a,b)=>a.localeCompare(b,'zh')); }
    if(grade&&!DB.meta.grades.includes(grade)) DB.meta.grades.push(grade);
    DB.students.push({id:uid(),name,gender:gender||'男',sno:sno||'',cls:cls||'',grade:grade||'',phone:phone||'',note:note||'',tags:[]});
    ok++;
  });
  save(); closeModal(); fillGlobalSelects(); render(); toast('成功导入 '+ok+' 名学生');
}
function exportStuList(mode){
  const list=DB.students.filter(s=>(!F.cls||s.cls===F.cls)&&(!F.grade||s.grade===F.grade));
  let html=`<h1>学生名单</h1><div class="p-sub">${F.cls||'全部班级'} · 共${list.length}人 · ${today()}</div>
  <table><tr><th>姓名</th><th>性别</th><th>学号</th><th>班级</th><th>家长联系方式</th><th>标签</th><th>备注</th></tr>
  ${list.map(s=>`<tr><td>${esc(s.name)}</td><td>${esc(s.gender)}</td><td>${esc(s.sno)}</td><td>${esc(s.cls)}</td><td>${esc(s.phone)}</td><td>${s.tags.map(esc).join('、')}</td><td>${esc(s.note)}</td></tr>`).join('')}</table>`;
  if(mode==='word') exportWordDoc('学生名单-'+(F.cls||'全部'),html);
  else if(mode==='pdf') exportPDFDoc(html);
  else doPrint(html);
}

/* ==================== 10. 教师工具箱 ==================== */
const TOOLS=[
 {id:'comment',ico:'评',name:'评语生成器',desc:'输入学生特点，生成期末/日常评语',
  fields:[['学生姓名','text','王小明'],['性别','select','男|女'],['表现亮点','text','课堂发言积极、乐于助人'],['待改进点','text','计算粗心'],['评语风格','select','亲切鼓励|正式规范|简洁有力']],
  gen:v=>{const ta=v[1]==='女'?'她':'他';return `${v[0]}同学：\n\n本学期${ta}给老师留下了深刻的印象。${v[2]?`${v[2].replace(/[、,，]/g,'，')}，这些闪光点让${ta}在班级中脱颖而出。`:''}${v[3]?`如果在${v[3]}方面再下一番功夫，相信${ta}会有更大的进步。`:''}\n\n${v[4]==='正式规范'?`希望${v[0]}同学再接再厉，在新学期取得更优异的成绩。`:v[4]==='简洁有力'?`继续加油，未来可期！`:`老师期待看到更棒的你，加油，${v[0]}！`}`}},
 {id:'notice',ico:'通',name:'家长通知生成器',desc:'快速生成规范的家长通知',
  fields:[['通知类型','select','放假通知|考试通知|活动通知|安全提醒|作业提醒|缴费通知'],['事项内容','textarea','5月1日至5月5日放假，5月6日正常返校'],['需家长配合','text','督促孩子完成假期作业，注意出行安全'],['落款','text','三年级1班班主任']],
  gen:v=>`尊敬的各位家长：\n\n您好！现将${v[0].replace('通知','')}相关事项通知如下：\n\n${v[1]}\n\n${v[2]?`需要您配合的事项：\n${v[2]}\n\n`:''}如有疑问，欢迎随时与我联系。感谢您一直以来对班级工作的支持与配合！\n\n${v[3]||'班主任'}\n${today()}`},
 {id:'meeting',ico:'班',name:'班会主题生成器',desc:'生成完整班会方案（目标+流程）',
  fields:[['年级','text','三年级'],['主题方向','select','习惯养成|安全教育|心理健康|集体荣誉|感恩教育|考前动员|网络安全|劳动教育'],['班会时长','select','15分钟|30分钟|40分钟']],
  gen:v=>`《${v[1]}》主题班会方案（${v[0]}）\n\n一、班会目标\n1. 让学生理解${v[1]}的重要意义；\n2. 结合真实案例引发思考，形成正确认知；\n3. 落实到具体行动约定。\n\n二、班会流程（共${v[2]}）\n1. 情境导入（5分钟）：播放短片/讲述案例，提问引发讨论。\n2. 主题讨论（10分钟）：分小组围绕"我们身边的${v[1]}问题"讨论并派代表发言。\n3. 深化认识（10分钟）：教师小结+正反案例对比。\n4. 行动约定（5分钟）：全班共同制定3条班级公约并签名。\n5. 总结升华：齐读公约，合影留念。\n\n三、准备材料\n课件、案例视频、公约海报纸、马克笔。\n\n四、后续跟进\n一周后利用晨会回顾公约执行情况，评选践行之星。`},
 {id:'plan',ico:'案',name:'教案模板生成器',desc:'按学科课题生成标准教案框架',
  fields:[['学科','text','数学'],['年级','text','三年级'],['课题','text','笔算乘法'],['课时','text','第1课时']],
  gen:v=>`《${v[2]}》教学设计（${v[1]}${v[0]} · ${v[3]}）\n\n【教学目标】\n1. 知识与技能：\n2. 过程与方法：\n3. 情感态度与价值观：\n\n【核心素养目标】\n（按${v[0]}课标填写）\n\n【教学重点】\n\n【教学难点】\n\n【教学准备】\n课件、学案、教具\n\n【教学过程】\n一、导入新课（5分钟）\n\n二、探究新知（15分钟）\n\n三、巩固练习（15分钟）\n\n四、课堂小结（5分钟）\n\n【板书设计】\n\n【课堂练习】\n\n【作业设计】\n必做：\n选做：\n\n【教学反思】\n（课后填写）\n\n提示：也可到「备课资源库」新增备课并一键套用模板，支持直接导出A4教案。`},
 {id:'paperAna',ico:'析',name:'试卷分析生成器',desc:'输入考试数据，生成试卷分析文字',
  fields:[['考试名称','text','期中考试（数学）'],['平均分','text','82.5'],['最高分/最低分','text','98/52'],['及格率/优秀率','text','92%/45%'],['主要失分点','textarea','计算粗心；应用题审题不清']],
  gen:v=>`《${v[0]}》试卷分析\n\n一、总体情况\n本次考试平均分${v[1]}分，最高分/最低分为${v[2]}，及格率/优秀率为${v[3]}。整体来看，学生对基础知识掌握${parseFloat(v[1])>=80?'较好':'仍需加强'}。\n\n二、主要失分点\n${(v[4]||'').split(/[;；\n]/).filter(Boolean).map((s,i)=>`${i+1}. ${s.trim()}`).join('\n')}\n\n三、原因分析\n1. 部分学生基础不够扎实，概念理解停留在表面；\n2. 审题习惯与书写规范有待加强；\n3. 中档题训练量不足，知识迁移能力弱。\n\n四、改进措施\n1. 针对失分点安排专项复习课，配套变式训练；\n2. 建立错题本制度，每周回顾；\n3. 加强审题三步法训练（圈关键词→明确问题→选择方法）；\n4. 分层布置作业，D层学生课后小组辅导。`},
 {id:'review',ico:'讲',name:'错题讲评稿生成器',desc:'输入错题信息，生成讲评课发言稿',
  fields:[['知识点','text','多位数乘一位数'],['典型错误','textarea','进位时忘记加进位数'],['错误人数','text','12'],['正确方法','textarea','个位相乘满十向十位进一，十位相乘后要加上进位数']],
  gen:v=>`「${v[0]}」错题讲评稿\n\n【导入】\n同学们，这道题全班有${v[2]||'不少'}人做错了，说明它很有代表性，我们一起来"会诊"。\n\n【展示错误】\n（投影典型错例）请大家先观察这个解法，谁能发现问题出在哪里？\n——典型错误：${v[1]}\n\n【剖析原因】\n这个错误的根源在于对"${v[0]}"的方法掌握不牢。请注意：\n${v[3]}\n\n【正确示范】\n（板书完整过程，边写边说思路）\n\n【变式巩固】\n现在请大家完成2道变式题（可用错题库"变式题"功能生成），做完同桌互查。\n\n【总结】\n请一位同学总结这类题的注意点，我们把它记到错题本上：错误原因 + 正确方法 + 提醒自己的一句话。`},
 {id:'layered',ico:'层',name:'分层辅导方案生成器',desc:'按ABCD四层生成辅导安排',
  fields:[['班级','text','三年级1班'],['学科','text','数学'],['薄弱知识点','text','多位数乘一位数、解决问题'],['辅导周期','select','两周|一个月|一学期']],
  gen:v=>`${v[0]}${v[1]}分层辅导方案（周期：${v[3]}）\n\n一、分层依据\n结合最近考试成绩与课堂表现，将学生分为A（≥90%）、B（75%~89%）、C（60%~74%）、D（<60%）四层（名单见成绩分析报告）。\n\n二、各层目标与措施\n【A层 · 优势学生】\n目标：拓展思维，保持领先。\n措施：每周2道挑战题；担任小老师参与讲评；参加学科拓展活动。\n\n【B层 · 稳定学生】\n目标：突破中档题，向A层跃升。\n措施：每周1次中档题专练；建立个人易错点清单。\n\n【C层 · 待提升学生】\n目标：夯实基础，稳定及格。\n措施：聚焦薄弱点（${v[2]}）每周2次基础过关；错题本每周检查一次。\n\n【D层 · 重点关注学生】\n目标：重建信心，掌握核心基础。\n措施：课后小组辅导每周3次，每次20分钟；作业分层降低起点；每日基础打卡；每两周与家长沟通一次。\n\n三、评估与流动\n每次单元测试后重新评估分层，鼓励向上流动；对连续两次下滑的学生启动一对一谈话。`},
 {id:'summary',ico:'结',name:'学期总结生成器',desc:'输入亮点与不足，生成教学工作总结',
  fields:[['学期','text','2025-2026学年第二学期'],['学科/班级','text','三年级1班数学'],['工作亮点','textarea','错题本制度落地；平均分提升5分；两名学生获区级奖项'],['存在不足','textarea','分层作业执行不够稳定；家校沟通频次偏少']],
  gen:v=>`${v[0]}教学工作总结（${v[1]}）\n\n一、基本情况\n本学期我承担${v[1]}的教学工作，围绕"夯实基础、培养习惯、分层提升"的思路开展教学，较好地完成了教学任务。\n\n二、主要工作与成效\n${(v[2]||'').split(/[;；\n]/).filter(Boolean).map((s,i)=>`${i+1}. ${s.trim()}；`).join('\n')}\n\n三、存在的不足\n${(v[3]||'').split(/[;；\n]/).filter(Boolean).map((s,i)=>`${i+1}. ${s.trim()}；`).join('\n')}\n\n四、下学期改进方向\n1. 坚持并优化错题管理与变式训练机制；\n2. 细化分层辅导方案，确保每周落实；\n3. 建立更规律的家校沟通节奏（每月至少一次全覆盖）；\n4. 加强命题研究，提高课堂练习的针对性。\n\n总之，本学期有收获也有反思，我将继续以学生发展为中心，把常规工作做实、做细。`}
];
let _toolId='';
function renderTools(){
  const card=(t,fn)=>`<div class="tool-card" onclick="${fn}('${t.id}')">
      <div class="t-ico">${t.ico}</div><h4>${t.name}</h4><p>${t.desc}</p></div>`;
  document.getElementById('page').innerHTML=
    wbHead('教师工具箱','title-yellow','班主任与学科教师高频工具：班级事务 + 文书生成，输入关键信息 → 一键生成 → 复制/导出')+
    `<div class="card" style="margin-bottom:14px">
    <div class="card-title title-cyan">班级事务（班主任专用）</div>
    <div class="tool-grid">${CLASSTOOLS.map(t=>card(t,'classToolOpen')).join('')}</div>
  </div>
  <div class="card">
    <div class="card-title title-yellow">文书生成（教师通用）</div>
    <div class="tool-grid">${TOOLS.map(t=>card(t,'toolOpen')).join('')}</div>
  </div>`;
}
function toolOpen(id){
  const t=TOOLS.find(x=>x.id===id); _toolId=id;
  const body=`<div class="form-grid">
  ${t.fields.map(([label,type,def],i)=>{
    if(type==='select') return `<div class="form-item"><label>${label}</label><select id="t_${i}">${def.split('|').map(o=>`<option>${o}</option>`).join('')}</select></div>`;
    if(type==='textarea') return `<div class="form-item full"><label>${label}</label><textarea id="t_${i}" placeholder="${esc(def)}"></textarea></div>`;
    return `<div class="form-item"><label>${label}</label><input id="t_${i}" placeholder="${esc(def)}"></div>`;
  }).join('')}
  </div>
  <div style="margin:12px 0"><button class="btn btn-primary" onclick="toolGen()">生成内容</button></div>
  <textarea id="toolResult" class="result-box" placeholder="生成结果将显示在这里，可直接编辑"></textarea>`;
  openModal(t.name, body,
    `<button class="btn" onclick="copyResult()">复制</button>
     <button class="btn" onclick="toolExport('word')">导出Word</button>
     <button class="btn" onclick="toolExport('pdf')">导出PDF</button>
     <button class="btn btn-primary" onclick="toolExport('print')">A4打印</button>
     <button class="btn" onclick="closeModal()">关闭</button>`);
}
function toolGen(){
  const t=TOOLS.find(x=>x.id===_toolId);
  const vals=t.fields.map((f,i)=>fv('t_'+i)||f[2].split('|')[0]);
  const sys='你是中小学一线教师的智能助手，擅长生成评语、家长通知、班会方案、教案、试卷分析、错题讲评稿、分层辅导方案、学期总结等教育文案。请用中文，语气符合中国中小学教育场景，专业、温暖、可落地执行。';
  const user='请帮我生成一份《'+t.name.replace('生成器','')+'》，按以下信息撰写：\n'+
    t.fields.map((f,i)=>f[0]+'：'+vals[i]).join('\n')+
    '\n\n请直接输出成品文案，不要过多解释。';
  const box=document.getElementById('toolResult');
  if(ONLINE){
    box.value='AI 生成中…';
    api.ai(sys,user).then(r=>{
      box.value=(r.ok&&r.text&&r.text.trim())?r.text:t.gen(vals);
      toast(r.ok?'AI 已生成':'未配置AI，已用模板生成');
    }).catch(e=>{ box.value=t.gen(vals); toast('AI调用失败，已用模板'); });
  }else{
    box.value=t.gen(vals);
    toast('已用模板生成（登录云端后可调用AI智能生成）');
  }
}
function copyResult(){
  const v=fv('toolResult'); if(!v){ toast('请先生成内容'); return; }
  navigator.clipboard? navigator.clipboard.writeText(v).then(()=>toast('已复制到剪贴板')) :
  (document.getElementById('toolResult').select(),document.execCommand('copy'),toast('已复制'));
}
function toolExport(mode){
  const v=fv('toolResult'); if(!v){ toast('请先生成内容'); return; }
  const t=TOOLS.find(x=>x.id===_toolId);
  const html=`<h1>${esc(t.name.replace('生成器',''))}</h1><pre>${esc(v)}</pre>`;
  if(mode==='word') exportWordDoc(t.name.replace('生成器','')+'-'+today(),html);
  else if(mode==='pdf') exportPDFDoc(html);
  else doPrint(html);
}

/* ==================== 10.5 班务工具（班主任高频事务） ==================== */
const CLASSTOOLS=[
  {id:'batchComment',ico:'评',name:'期末评语批量生成',desc:'按班级一键生成全班评语，可逐条编辑、AI润色、导出Word'},
  {id:'parentNotice',ico:'信',name:'家长通知书生成',desc:'放假/考试/活动通知，支持全班个性化通知书'},
  {id:'seating',ico:'座',name:'智能排座位',desc:'按男女生搭配/成绩互补/随机自动排座，可视化呈现'},
  {id:'duty',ico:'值',name:'值日表生成',desc:'按小组轮值自动生成一周/两周值日安排表'}
];
function renderClassTools(){
  document.getElementById('page').innerHTML=
    wbHead('班务工具','title-cyan','班主任高频事务：批量评语、家长通知、智能排座、值日轮值——输入关键信息 → 一键生成 → 复制/导出')+
    `<div class="tool-grid">
    ${CLASSTOOLS.map(t=>`<div class="tool-card" onclick="classToolOpen('${t.id}')">
      <div class="t-ico">${t.ico}</div><h4>${t.name}</h4><p>${t.desc}</p></div>`).join('')}
  </div>`;
}
function classToolOpen(id){
  if(id==='batchComment') batchCommentOpen();
  else if(id==='parentNotice') parentNoticeOpen();
  else if(id==='seating') seatingOpen();
  else if(id==='duty') dutyOpen();
}
/* 通用小工具 */
function copyText(t){
  if(!t){ toast('没有可复制的内容'); return; }
  if(navigator.clipboard){ navigator.clipboard.writeText(t).then(()=>toast('已复制到剪贴板')); return; }
  const ta=document.createElement('textarea'); ta.value=t; document.body.appendChild(ta); ta.select();
  try{ document.execCommand('copy'); toast('已复制'); }catch(e){ toast('复制失败'); }
  document.body.removeChild(ta);
}
function shuffle(a){ for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }
function avgScore(id){ let sum=0,n=0; DB.exams.forEach(e=>{const r=e.records.find(x=>x.sid===id||x.name===stuName(id)); if(r){sum+=(+r.score||0);n++;}}); return n?sum/n:0; }

/* ---- 1. 期末评语批量生成 ---- */
let _bcList=[];
function batchCommentOpen(){
  const body=`<div class="form-grid">
    <div class="form-item"><label>班级</label>${clsSelectHtml('','bc_cls','全部班级')}</div>
    <div class="form-item"><label>评语风格</label><select id="bc_style"><option>亲切鼓励</option><option>正式规范</option><option>简洁有力</option></select></div>
  </div>
  <div style="margin:12px 0"><button class="btn btn-primary" onclick="batchCommentGen()">生成全班评语</button>
    <span class="user-hint" style="margin-left:10px">当前选择：<b id="bc_cnt">${DB.students.length}</b> 名学生</span></div>
  <div id="bc_list"><div class="empty" style="padding:20px">请选择班级后点击「生成全班评语」</div></div>`;
  openModal('期末评语批量生成', body,
    `<button class="btn" onclick="bcCopyAll()">复制全部</button>
     <button class="btn" onclick="bcExportWord()">导出Word</button>
     <button class="btn" onclick="closeModal()">关闭</button>`);
}
function stuStats(s){
  const exams=[]; DB.exams.forEach(e=>{ const r=e.records.find(x=>x.sid===s.id||x.name===s.name); if(r) exams.push({name:e.name,subject:e.subject,score:+r.score,full:+e.full,date:e.date}); });
  exams.sort((a,b)=>b.date.localeCompare(a.date));
  const avg=exams.length?(exams.reduce((sum,e)=>sum+e.score,0)/exams.length).toFixed(1):0;
  const latest=exams[0];
  const ms=DB.mistakes.filter(m=>m.studentId===s.id);
  const unMastered=ms.filter(m=>!m.mastered).length;
  return {avg,examCount:exams.length,latest,mistakeCount:ms.length,unMastered};
}
function genComment(s, style){
  const ta=s.gender==='女'?'她':'他';
  const st=stuStats(s);
  const {avg,examCount,latest,mistakeCount,unMastered}=st;
  const layer=examCount?(avg/latest.full>=0.9?'A层（优秀）':avg/latest.full>=0.75?'B层（良好）':avg/latest.full>=0.6?'C层（及格）':'D层（需努力）'):'暂无成绩分层';
  const pos=['学习优秀','进步明显','课堂活跃'];
  const neg=['基础薄弱','作业拖拉','需要关注','心理敏感','纪律提醒'];
  const pt=(s.tags||[]).filter(t=>pos.includes(t));
  const nt=(s.tags||[]).filter(t=>neg.includes(t));
  const tagText=pt.length?`在${pt.join('、')}等方面表现突出，`:nt.length?`在${nt.join('、')}方面还需加强，`:'';
  const scoreText=examCount?`近${examCount}次考试平均分${avg}分（${layer}）${latest?`，最近一次《${latest.name}》取得${latest.score}分`:''}。`:`目前暂无考试成绩记录。`;
  const mistakeText=mistakeCount?`错题本中共有${mistakeCount}道题，其中${unMastered}道尚未掌握，建议假期重点回练。`:`错题记录较少，继续保持细心。`;
  if(style==='简洁有力'){
    return `${s.name}同学：\n\n${tagText}${scoreText}${mistakeText}\n\n望${ta}扬长避短，再接再厉！`;
  }
  const open=style==='正式规范'?`${s.name}同学：\n\n本学期，${ta}`:`${s.name}同学：\n\n这一学期，${ta}`;
  const body=`${tagText}学习态度端正，能积极参与课堂、按时完成学习任务。${scoreText}${mistakeText}`;
  const end=style==='正式规范'?`\n\n期待${ta}在新学期扬长避短，取得更大进步。`:`\n\n老师相信，只要${ta}坚持努力，一定会越来越棒。加油，${s.name}！`;
  return open+body+end;
}
function batchCommentGen(){
  const cls=fv('bc_cls'); const style=fv('bc_style')||'亲切鼓励';
  _bcList = cls? DB.students.filter(s=>s.cls===cls): DB.students.slice();
  if(!_bcList.length){ toast('该班级暂无学生'); return; }
  document.getElementById('bc_cnt').textContent=_bcList.length;
  document.getElementById('bc_list').innerHTML=_bcList.map((s,i)=>`<div class="card" style="margin-bottom:12px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><b>${esc(s.name)}</b><span class="user-hint">${esc(s.cls)}</span></div>
    <textarea id="bc_c_${i}" class="result-box" style="min-height:90px">${esc(genComment(s,style))}</textarea>
    <div style="margin-top:6px"><button class="btn btn-sm" onclick="bcPolish(${i})">AI润色</button></div>
  </div>`).join('');
  toast('已生成 '+_bcList.length+' 条评语（模板），可逐条编辑或用AI润色');
}
function bcPolish(i){
  if(!ONLINE){ toast('未登录云端，无法AI润色'); return; }
  const ta=document.getElementById('bc_c_'+i); const cur=fv('bc_c_'+i)||'';
  ta.value='润色中…';
  api.ai('你是中小学班主任，擅长把学生评语润色得温暖、真诚、有针对性，符合中国中小学教育场景，不虚构事实。',
    '请帮我把下面这条学生评语润色得更自然、真诚、有温度，保留关键信息：\n\n'+cur)
    .then(r=>{ if(r.ok&&r.text) ta.value=r.text; else { ta.value=cur; toast('未配置AI，保持原模板'); } })
    .catch(()=>{ ta.value=cur; toast('润色失败，保持原模板'); });
}
function bcCopyAll(){
  if(!_bcList.length){ toast('请先生成'); return; }
  copyText(_bcList.map((s,i)=>(fv('bc_c_'+i)||'')).join('\n\n————————————————\n\n'));
}
function bcExportWord(){
  if(!_bcList.length){ toast('请先生成'); return; }
  const items=_bcList.map((s,i)=>`<h2>${esc(s.name)}（${esc(s.cls)}）</h2><pre>${esc(fv('bc_c_'+i)||'')}</pre>`).join('');
  exportWordDoc('期末评语-'+today(), `<h1>期末评语</h1>${items}`);
}

/* ---- 2. 家长通知书生成 ---- */
let _pnList=[];
function parentNoticeOpen(){
  const body=`<div class="form-grid">
    <div class="form-item"><label>通知类型</label><select id="pn_type">${['放假通知','考试通知','活动通知','安全提醒','作业提醒','缴费通知','其他'].map(t=>`<option>${t}</option>`).join('')}</select></div>
    <div class="form-item"><label>班级</label>${clsSelectHtml('','pn_cls','全部班级')}</div>
    <div class="form-item full"><label>事项内容</label><textarea id="pn_content" placeholder="如：5月1日至5月5日放假，5月6日正常返校"></textarea></div>
    <div class="form-item full"><label>需家长配合</label><input id="pn_coop" placeholder="如：督促孩子完成假期作业，注意出行安全"></div>
    <div class="form-item"><label>落款</label><input id="pn_sign" value="${esc(USERNAME||'班主任')}"></div>
  </div>
  <div style="margin:12px 0">
    <button class="btn btn-primary" onclick="pnGenSingle()">生成通知</button>
    <button class="btn" style="margin-left:8px" onclick="pnGenBatch()">为全班生成个性化通知书</button>
  </div>
  <div id="pn_list"></div>`;
  openModal('家长通知书生成', body,
    `<button class="btn" onclick="pnCopyAll()">复制全部</button>
     <button class="btn" onclick="pnExportWord()">导出Word</button>
     <button class="btn" onclick="closeModal()">关闭</button>`);
}
function genNoticeText(type, content, coop, sign, stuName){
  const head=stuName?`尊敬的${stuName}家长：`:'尊敬的各位家长：';
  return `${head}\n\n您好！现将${type.replace('通知','')}相关事项通知如下：\n\n${content||''}\n\n${coop?`需要您配合的事项：\n${coop}\n\n`:''}如有疑问，欢迎随时与我联系。感谢您一直以来对班级工作的支持与配合！\n\n${sign||'班主任'}\n${today()}`;
}
function pnGenSingle(){
  const type=fv('pn_type'),content=fv('pn_content'),coop=fv('pn_coop'),sign=fv('pn_sign')||'班主任';
  const text=genNoticeText(type,content,coop,sign,'');
  _pnList=[{name:'全体',text}];
  document.getElementById('pn_list').innerHTML=`<div class="card"><b>全体家长</b><textarea id="pn_0" class="result-box" style="min-height:200px;margin-top:6px">${esc(text)}</textarea></div>`;
  toast('已生成通知，可直接编辑');
}
function pnGenBatch(){
  const type=fv('pn_type'),cls=fv('pn_cls'),content=fv('pn_content'),coop=fv('pn_coop'),sign=fv('pn_sign')||'班主任';
  const list=cls?DB.students.filter(s=>s.cls===cls):DB.students.slice();
  if(!list.length){ toast('该班级暂无学生'); return; }
  _pnList=list.map(s=>({name:s.name,text:genNoticeText(type,content,coop,sign,s.name)}));
  document.getElementById('pn_list').innerHTML=_pnList.map((it,i)=>`<div class="card" style="margin-bottom:12px"><b>${esc(it.name)}家长</b><textarea id="pn_${i}" class="result-box" style="min-height:160px;margin-top:6px">${esc(it.text)}</textarea></div>`).join('');
  toast('已生成 '+list.length+' 份个性化通知书');
}
function pnCopyAll(){
  if(!_pnList.length){ toast('请先生成'); return; }
  copyText(_pnList.map((it,i)=>fv('pn_'+i)||it.text).join('\n\n————————————————\n\n'));
}
function pnExportWord(){
  if(!_pnList.length){ toast('请先生成'); return; }
  const items=_pnList.map((it,i)=>`<h2>${esc(it.name)}家长</h2><pre>${esc(fv('pn_'+i)||it.text)}</pre>`).join('');
  exportWordDoc('家长通知书-'+today(), `<h1>家长通知书</h1>${items}`);
}

/* ---- 3. 智能排座位 ---- */
let _seatInfo='',_seatTable='';
function seatingOpen(){
  const body=`<div class="form-grid">
    <div class="form-item"><label>班级</label>${clsSelectHtml('','st_cls','全部班级')}</div>
    <div class="form-item"><label>排数（行）</label><input id="st_rows" type="number" value="6" min="1" max="12"></div>
    <div class="form-item"><label>列数</label><input id="st_cols" type="number" value="7" min="1" max="12"></div>
    <div class="form-item"><label>排座方式</label><select id="st_rule"><option>随机</option><option>按学号</option><option>男女生搭配</option><option>成绩好差搭配</option></select></div>
  </div>
  <div style="margin:12px 0"><button class="btn btn-primary" onclick="seatingGen()">生成座位表</button></div>
  <div id="st_out"></div>`;
  openModal('智能排座位', body,
    `<button class="btn" onclick="stExport()">导出Word</button>
     <button class="btn" onclick="stPrint()">打印</button>
     <button class="btn" onclick="closeModal()">关闭</button>`);
}
function seatingGen(){
  const cls=fv('st_cls');
  let list=cls?DB.students.filter(s=>s.cls===cls):DB.students.slice();
  const rows=Math.max(1,Math.min(12,parseInt(fv('st_rows'))||6));
  const cols=Math.max(1,Math.min(12,parseInt(fv('st_cols'))||7));
  const rule=fv('st_rule')||'随机';
  let arr=list.slice();
  if(rule==='随机') shuffle(arr);
  else if(rule==='按学号') arr.sort((a,b)=>(a.sno||'').toString().localeCompare((b.sno||'').toString(),'zh'));
  else if(rule==='男女生搭配'){ const boys=arr.filter(s=>s.gender==='男'),girls=arr.filter(s=>s.gender==='女'); arr=[]; const n=Math.max(boys.length,girls.length); for(let i=0;i<n;i++){ if(boys[i])arr.push(boys[i]); if(girls[i])arr.push(girls[i]); } }
  else if(rule==='成绩好差搭配'){ const ws=arr.map(s=>({s,sc:avgScore(s.id)})).sort((a,b)=>a.sc-b.sc); arr=[]; let lo=0,hi=ws.length-1; while(lo<=hi){ if(lo<=hi)arr.push(ws[lo].s); if(lo<hi)arr.push(ws[hi].s); lo++; hi--; } }
  let grid=`<div class="seat-grid" style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:6px;margin-top:10px">`;
  const total=rows*cols;
  for(let i=0;i<total;i++){ const s=arr[i]; const seatNo=i+1;
    grid+=`<div style="border:1px solid #dde7ef;border-radius:8px;padding:8px 4px;text-align:center;min-height:46px;background:#fff"><div style="font-size:11px;color:#9aa7b5">第${seatNo}座</div><div style="font-weight:600;color:#1f3a5f">${s?esc(s.name):'<span style="color:#cbd5e1">空</span>'}</div></div>`;
  }
  grid+=`</div>`;
  let trows='';
  for(let r=0;r<rows;r++){ trows+='<tr>'+Array.from({length:cols},(_,c)=>{const idx=r*cols+c; const s=arr[idx]; return `<td style="border:1px solid #ccc;padding:8px;text-align:center;vertical-align:middle">${s?esc(s.name)+'<br><span style="font-size:10px;color:#999">第'+(idx+1)+'座</span>':'空'}</td>`;}).join('')+'</tr>'; }
  _seatTable=`<table style="border-collapse:collapse;width:100%">${trows}</table>`;
  _seatInfo=`${arr.length}名学生 · ${rows}排×${cols}列 · 排座方式：${rule}`;
  document.getElementById('st_out').innerHTML=`<div class="notice">${_seatInfo}</div>`+grid;
}
function stExport(){ if(!_seatTable){toast('请先生成');return;} exportWordDoc('座位表-'+today(), `<h1>班级座位表</h1><div>${_seatInfo}</div>${_seatTable}`); }
function stPrint(){ if(!_seatTable){toast('请先生成');return;} doPrint(`<h1>班级座位表</h1><div>${_seatInfo}</div>${_seatTable}`); }

/* ---- 4. 值日表生成 ---- */
let _dutyHtml='';
function dutyOpen(){
  const body=`<div class="form-grid">
    <div class="form-item"><label>班级</label>${clsSelectHtml('','dy_cls','全部班级')}</div>
    <div class="form-item"><label>周期</label><select id="dy_cycle"><option>一周（5天）</option><option>两周（10天）</option></select></div>
    <div class="form-item full"><label>值日任务（每行一个）</label><textarea id="dy_tasks" style="min-height:80px">扫地
拖地
擦黑板
倒垃圾
摆桌椅
关门窗</textarea></div>
    <div class="form-item full"><label>说明（可选）</label><input id="dy_note" placeholder="如：每天放学后完成，组长检查"></div>
  </div>
  <div style="margin:12px 0"><button class="btn btn-primary" onclick="dutyGen()">生成值日表</button></div>
  <div id="dy_out"></div>`;
  openModal('值日表生成', body,
    `<button class="btn" onclick="dutyExport()">导出Word</button>
     <button class="btn" onclick="dutyPrint()">打印</button>
     <button class="btn" onclick="closeModal()">关闭</button>`);
}
function dutyGen(){
  const cls=fv('dy_cls');
  const list=cls?DB.students.filter(s=>s.cls===cls):DB.students.slice();
  if(!list.length){ toast('该班级暂无学生'); return; }
  const tasks=fv('dy_tasks').split(/\n/).map(t=>t.trim()).filter(Boolean);
  if(!tasks.length){ toast('请填写值日任务'); return; }
  const weeks=fv('dy_cycle').includes('两周')?2:1;
  const dayNames=['周一','周二','周三','周四','周五'];
  let html=`<div class="notice">${esc(cls||'全部班级')} · ${esc(fv('dy_cycle'))} · 共 ${tasks.length} 项值日任务</div><div class="tbl-wrap" style="margin-top:10px"><table class="tbl"><tr><th class="nosort">周期</th><th class="nosort">星期</th>${tasks.map(t=>`<th class="nosort">${esc(t)}</th>`).join('')}</tr>`;
  let idx=0;
  for(let w=0;w<weeks;w++){ for(let d=0;d<5;d++){
    const cells=tasks.map((t,k)=>{ const s=list[(idx+k)%list.length]; return `<td>${s?esc(s.name):'—'}</td>`; }).join('');
    idx+=tasks.length;
    html+=`<tr><td>${w===0?'第一周':'第二周'}</td><td>${dayNames[d]}</td>${cells}</tr>`;
  }}
  html+=`</table></div>`;
  if(fv('dy_note')) html+=`<div class="user-hint" style="margin-top:8px">说明：${esc(fv('dy_note'))}</div>`;
  document.getElementById('dy_out').innerHTML=html;
  _dutyHtml=html;
}
function dutyExport(){ if(!_dutyHtml){toast('请先生成');return;} exportWordDoc('值日表-'+today(), `<h1>值日表</h1>${_dutyHtml}`); }
function dutyPrint(){ if(!_dutyHtml){toast('请先生成');return;} doPrint(`<h1>值日表</h1>${_dutyHtml}`); }

/* ==================== 11. 基础设置 ==================== */
const META_DEFS=[
  ['grades','年级（可自由新增，如"预备班"）'],['subjects','学科'],['versions','教材版本'],
  ['classes','班级'],['examTypes','考试类型'],['lessonTags','备课课型标签'],['stuTags','学生标签']
];
function exportAllData(){
  const blob=new Blob([JSON.stringify(DB,null,2)],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='teacher-workbench-backup-'+today()+'.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已导出备份');
}
function importAllData(input){
  const file=input.files[0];
  if(!file) return;
  const reader=new FileReader();
  reader.onload=e=>{
    try{
      const data=JSON.parse(e.target.result);
      if(!data||!data.students||!Array.isArray(data.students)){
        toast('备份文件格式不正确');
        return;
      }
      if(!confirm('导入将覆盖当前全部数据，建议先导出备份。确认继续？')) return;
      DB=data;
      ensureSchema();
      save();
      render();
      toast('数据导入成功');
    }catch(err){
      toast('解析失败：'+err.message);
    }
  };
  reader.readAsText(file);
}
function renderBackup(){
  const items=[
    ['学生', DB.students.length, '#0ea5e9'],
    ['考试', DB.exams.length, '#22c55e'],
    ['错题', DB.mistakes.length, '#ef4444'],
    ['作业', DB.homeworks.length, '#f59e0b'],
    ['家校沟通', DB.contacts.length, '#8b5cf6'],
    ['待办', DB.todos.length, '#06b6d4'],
    ['课表', DB.timetables.length, '#14b8a6'],
    ['违纪', DB.disciplines.length, '#fb7185'],
    ['活动', DB.activities.length, '#f97316'],
    ['工作留痕', DB.worklogs.length, '#64748b']
  ];
  document.getElementById('page').innerHTML=
    wbHead('数据备份与恢复','title-gray','导出完整数据为 JSON 文件，换设备或误删后可一键恢复；导入前建议先导出当前备份',
      `<button class="btn btn-primary" onclick="exportAllData()">导出全部数据</button><label class="btn"><input type="file" accept=".json" style="display:none" onchange="importAllData(this)">导入备份文件</label>`)+
    `<div class="two-col">
      <div class="card card-tint-slate">
        ${cardTitleIcon(ICO_BRIEFCASE,'备份操作')}
        <div class="notice">点击下方按钮可<b>导出</b>当前全部数据为 JSON 文件（涵盖学生、成绩、错题、作业、家校沟通、待办、课表、违纪等所有模块）；需要恢复时，点击<b>导入备份文件</b>选择此前导出的 JSON 即可。导入将覆盖当前数据，请谨慎操作。</div>
        <div class="filter-bar" style="margin-top:14px">
          <button class="btn btn-primary" onclick="exportAllData()">导出全部数据</button>
          <label class="btn"><input type="file" accept=".json" style="display:none" onchange="importAllData(this)">导入备份文件</label>
        </div>
        <div class="notice" style="margin-top:12px">💡 备份文件保存在你本地设备，不会上传到任何服务器，请妥善保管。</div>
      </div>
      <div class="card card-tint-cyan">
        ${cardTitleIcon(ICO_CHART,'当前数据概览')}
        <div class="notice" style="margin-bottom:10px">以下为将随备份一起导出的数据条目数。</div>
        <div class="stat-grid">
          ${items.map(([k,v,c])=>statCard(k,v,c,'')).join('')}
        </div>
      </div>
    </div>`;
}
function renderSettings(){
  const adminUnlocked = sessionStorage.getItem('twb_admin_unlock') === '1';
  document.getElementById('page').innerHTML=`
  <div class="page-head">
    <div><div class="page-title title-gray">基础设置</div><div class="page-desc">自由新增/删除年级、学科、班级、教材版本、考试类型等基础数据；维护教材单元目录</div></div>
    ${moduleToolbar([
      `<button class="btn btn-danger" onclick="clearSampleData()">清空示例数据</button>`,
      `<button class="btn" onclick="resetData()">恢复示例数据</button>`
    ])}
  </div>
  <div class="two-col">
    <div>
    ${META_DEFS.map(([key,label])=>`<div class="card">
      <div class="card-title">${label}</div>
      <div>${DB.meta[key].map((v,i)=>`<span class="chip">${esc(v)}<b onclick="metaDel('${key}',${i})">×</b></span>`).join('')}</div>
      <div class="filter-bar" style="margin-top:8px;margin-bottom:0">
        <input id="add_${key}" placeholder="输入后点击新增" onkeydown="if(event.key==='Enter')metaAdd('${key}')">
        <button class="btn btn-sm btn-primary" onclick="metaAdd('${key}')">新增</button>
      </div>
    </div>`).join('')}
    </div>
    <div>
    <div class="card">
      <div class="card-title">教材单元目录（不含教材全文，仅目录结构）</div>
      <div class="notice">仅保存教材的目录、单元结构与知识点标签，用于备课时快速选择单元。不内置任何教材正文内容。</div>
      ${DB.catalogs.map(c=>`<div style="border:1px solid #dde7ef;border-radius:8px;padding:10px;margin-bottom:10px">
        <b>${esc(c.version)} · ${esc(c.subject)} · ${esc(c.grade)}${esc(c.volume)}</b>
        <button class="btn btn-sm btn-danger" style="float:right" onclick="catalogDel('${c.id}')">删除</button>
        <div style="margin-top:6px">${c.units.map(u=>`<span class="tag tag-gray">${esc(u)}</span>`).join('')}</div>
      </div>`).join('')||'<div class="empty">暂无目录</div>'}
      <div class="card-title" style="margin-top:14px">新增教材目录</div>
      <div class="form-grid">
        <div class="form-item"><label>版本</label><select id="c_ver">${optHtml(DB.meta.versions,'人教版')}</select></div>
        <div class="form-item"><label>学科</label>${subSelectHtml('数学','c_sub')}</div>
        <div class="form-item"><label>年级</label><select id="c_grade">${optHtml(DB.meta.grades,'三年级')}</select></div>
        <div class="form-item"><label>册别</label><select id="c_vol">${optHtml(['上册','下册'],'上册')}</select></div>
        <div class="form-item full"><label>单元列表（每行一个单元名）</label><textarea id="c_units" placeholder="第一单元 ……&#10;第二单元 ……"></textarea></div>
      </div>
      <button class="btn btn-primary" style="margin-top:10px" onclick="catalogAdd()">保存目录</button>
    </div>
    <!-- 管理员专区：普通老师默认不可见，验证后展开 -->
    <div id="adminArea" style="${adminUnlocked?'':'display:none'}">
    <div class="card" style="background:#f8fbff;border-color:#d6e6fb">
      <div class="card-title">✅ 管理员身份已验证</div>
      <div class="filter-bar" style="margin-top:8px;margin-bottom:0">
        <span class="tag tag-green">已解锁管理后台</span>
        <button class="btn btn-sm" onclick="adminLogout()">退出管理</button>
      </div>
    </div>
    <div class="card">
      <div class="card-title">云端同步状态</div>
      <div class="notice">数据经 Cloudflare 中转直连 GitHub 仓库（永久免费、国内可达）。每个「工作空间密钥」对应一个独立的加密云端空间，<b>跨手机/电脑自动同步</b>。老师登录无需填任何码。</div>
      <div class="filter-bar" style="margin-top:8px;margin-bottom:0">
        <span class="tag ${GH_PROXY?'tag-green':'tag-gray'}">${GH_PROXY?'☁️ 云端中转已启用':'⚠️ 云端中转未配置（仅本机存储）'}</span>
        <span class="tag tag-gray">当前空间：${esc(WS_KEY||'未登录')}</span>
      </div>
    </div>
    <div class="card" style="border:2px solid #3b7ddd">
      <div class="card-title">🔑 密钥管理（管理员专用）</div>
      <div class="notice">这里用来给每位老师<b>发放不同的访问密钥</b>。生成后把密钥发给对应老师，他们登录时粘贴即可进入，<b>无需填任何码</b>。不同密钥对应完全隔离的云端空间，老师之间互不可见，且跨手机/电脑自动同步。</div>
      <div class="filter-bar" style="margin-bottom:8px;margin-top:10px">
        <input id="gen_count" type="number" min="1" max="50" value="5" style="width:70px">
        <span style="margin:0 6px">个密钥</span>
        <button class="btn btn-sm btn-primary" onclick="genKeys()">生成</button>
        <button class="btn btn-sm" onclick="refreshKeys()">刷新列表</button>
      </div>
      <div id="keyList" class="notice"></div>
    </div>
    <div class="card" style="border:2px solid #7c5cff">
      <div class="card-title">🤖 AI 统一密钥（管理员设置）</div>
      <div class="notice">在这里填入一个硅基流动 / DeepSeek 密钥，<b>全站所有老师无需各自配置</b>即可使用真实 AI 出题、生成试卷、写教案。密钥仅存于你的 GitHub 云端，不会暴露给老师。</div>
      <div class="form-grid">
        <div class="form-item full"><label>AI 密钥</label><input id="admin_ai_key" placeholder="sk-... 或 DeepSeek 密钥" value="${esc(SHARED_AI_KEY)}"></div>
        <div class="form-item full"><label>接口地址</label><input id="admin_ai_base" placeholder="https://api.siliconflow.cn/v1" value="${esc(SHARED_AI_BASE||'https://api.siliconflow.cn/v1')}"></div>
        <div class="form-item full"><label>模型</label><input id="admin_ai_model" placeholder="deepseek-ai/DeepSeek-V3" value="${esc(SHARED_AI_MODEL||'deepseek-ai/DeepSeek-V3')}"></div>
      </div>
      <button class="btn btn-primary" style="margin-top:10px" onclick="saveAdminAi()">保存并启用全站 AI</button>
    </div>
    </div>
    </div>
    <!-- 管理员入口：未验证时显示 -->
    <div class="card" id="adminUnlockCard" style="${adminUnlocked?'display:none':''}">
      <div class="card-title">🔒 管理员入口（仅限管理员）</div>
      <div class="notice">普通老师无需操作此项。管理员验证后可管理访问密钥与云端连接配置。</div>
      <div class="form-grid">
        <div class="form-item full"><label>管理员密码</label><input id="admin_pwd" type="password" autocomplete="new-password" placeholder="请输入管理员密码"></div>
      </div>
      <div class="filter-bar" style="margin-top:8px;margin-bottom:0">
        <button class="btn btn-sm btn-primary" onclick="adminEnter()">验证并进入管理后台</button>
      </div>
    </div>
    <div class="card">
      <div class="card-title">AI 智能生成（个人，可选）</div>
      <div class="notice">若管理员已配置「统一 AI 密钥」，你无需填写即可直接使用真实 AI。也可在此填入<b>你自己的</b>硅基流动 / DeepSeek 密钥（仅存本机浏览器，优先级高于统一密钥）。不填且无统一密钥时，自动使用内置模板生成。</div>
      <div class="form-grid">
        <div class="form-item full"><label>AI 密钥（选填）</label><input id="ai_key" placeholder="sk-... 或你的硅基流动/DeepSeek 密钥" value="${esc(localStorage.getItem('twb_ai_key')||'')}"></div>
        <div class="form-item full"><label>接口地址（选填）</label><input id="ai_base" placeholder="https://api.siliconflow.cn/v1" value="${esc(localStorage.getItem('twb_ai_base')||'https://api.siliconflow.cn/v1')}"></div>
        <div class="form-item full"><label>模型（选填）</label><input id="ai_model" placeholder="deepseek-ai/DeepSeek-V3" value="${esc(localStorage.getItem('twb_ai_model')||'deepseek-ai/DeepSeek-V3')}"></div>
      </div>
      <button class="btn btn-primary" style="margin-top:10px" onclick="saveAiKey()">保存 AI 配置</button>
    </div>
    </div>
  </div>`;
  if(adminUnlocked) setTimeout(refreshKeys, 0);
  // 防止浏览器自动填充管理员密码：每次渲染设置页都清空密码框
  setTimeout(()=>{ const p=document.getElementById('admin_pwd'); if(p) p.value=''; }, 0);
}
function metaAdd(key){
  const v=fv('add_'+key); if(!v){ toast('请输入内容'); return; }
  if(DB.meta[key].includes(v)){ toast('已存在'); return; }
  DB.meta[key].push(v); save(); fillGlobalSelects(); render(); toast('已新增：'+v);
}
function metaDel(key,i){
  if(!confirm('删除「'+DB.meta[key][i]+'」？（不影响已有数据记录）'))return;
  DB.meta[key].splice(i,1); save(); fillGlobalSelects(); render();
}
function catalogAdd(){
  const units=fv('c_units').split('\n').map(s=>s.trim()).filter(Boolean);
  if(!units.length){ toast('请填写单元列表'); return; }
  DB.catalogs.push({id:uid(),version:fv('c_ver'),subject:fv('c_sub'),grade:fv('c_grade'),volume:fv('c_vol'),units});
  save(); render(); toast('教材目录已保存');
}
function catalogDel(id){ if(!confirm('删除该教材目录？'))return; DB.catalogs=DB.catalogs.filter(c=>c.id!==id); save(); render(); }
function resetData(){
  if(!confirm('确定清空当前全部数据并恢复为示例数据吗？此操作不可恢复！'))return;
  DB=seedData(); save(); fillGlobalSelects(); render(); toast('已重置为示例数据');
}
function clearSampleData(){
  if(!confirm('确定清空所有示例学生、示例备课、示例考试等演示数据吗？\n\n保留项：年级/学科/班级等基础枚举、你的班级列表、AI 配置。\n此操作不可恢复，请确认已不需要示例数据。'))return;
  // 清空所有业务示例数据，但保留 meta 配置和班级列表
  const keepClasses=(DB.meta.classes||[]).slice();
  const keepGrades=(DB.meta.grades||[]).slice();
  const keepSubjects=(DB.meta.subjects||[]).slice();
  DB.students=[]; DB.lessons=[]; DB.mistakes=[]; DB.exams=[]; DB.papers=[]; DB.bank=[];
  DB.attends=[]; DB.leaves=[]; DB.contacts=[]; DB.homeworks=[]; DB.observes=[]; DB.tutors=[];
  DB.meta.classes=keepClasses;
  if(!DB.meta.classes.length) DB.meta.classes=[];
  save(); fillGlobalSelects(); render(); toast('示例数据已清空，请从「班级管理」添加自己的班级，再录入学生。');
}

/* ==================== 12. 当前页导出 ==================== */
function exportCurrent(mode){
  const titleMap={dashboard:'工作台总览',lessons:'备课资源清单',mistakes:'错题清单',scores:'考试成绩清单',
    papers:'试卷生成',students:'学生名单',tools:'工具箱',settings:'基础设置'};
  if(current==='students'){ exportStuList(mode); return; }
  if(current==='mistakes'){ exportMistakeBook(mode); return; }
  if(current==='papers'){ paperExport(mode); return; }
  if(current==='scores'){
    const list=DB.exams.filter(e=>(!F.cls||e.cls===F.cls)&&(!F.subject||e.subject===F.subject));
    let html=`<h1>考试成绩汇总</h1><div class="p-sub">${today()}</div>
    <table><tr><th>考试</th><th>类型</th><th>日期</th><th>班级/学科</th><th>平均分</th><th>最高</th><th>最低</th><th>及格率</th><th>优秀率</th></tr>
    ${list.map(e=>{const a=calcExam(e);return `<tr><td>${esc(e.name)}</td><td>${esc(e.type)}</td><td>${e.date}</td><td>${esc(e.cls)}·${esc(e.subject)}</td><td>${a.avg}</td><td>${a.max}</td><td>${a.min}</td><td>${a.passRate}%</td><td>${a.excRate}%</td></tr>`;}).join('')}</table>`;
    if(mode==='word')exportWordDoc('考试成绩汇总',html); else if(mode==='pdf')exportPDFDoc(html); else doPrint(html);
    return;
  }
  if(current==='lessons'){
    const list=lessonList();
    let html=`<h1>备课资源清单</h1><div class="p-sub">${today()} · 共${list.length}份</div>
    <table><tr><th>课题</th><th>年级/学科</th><th>版本/册别</th><th>单元</th><th>课时</th><th>标签</th></tr>
    ${list.map(l=>`<tr><td>${esc(l.title)}</td><td>${esc(l.grade)}${esc(l.subject)}</td><td>${esc(l.version)}${esc(l.volume)}</td><td>${esc(l.unit)}</td><td>${esc(l.period)}</td><td>${(l.tags||[]).map(esc).join('、')}</td></tr>`).join('')}</table>`;
    if(mode==='word')exportWordDoc('备课资源清单',html); else if(mode==='pdf')exportPDFDoc(html); else doPrint(html);
    return;
  }
  toast('当前页面（'+titleMap[current]+'）建议进入具体模块使用导出功能');
}

/* ==================== 3.5 班级整体分析报告（一键导出） ==================== */
function classAvgChart(calc){
  const data=calc.map(c=>+c.a.avg);
  const labels=calc.map(c=>c.e.date.slice(5));
  const W=560,H=170,p=28,maxV=Math.max(...data,100),n=data.length;
  const bw=Math.min(56,(W-p*2)/n-18), gap=(W-p*2-bw*n)/(n+1);
  let s=`<line x1="${p}" y1="${H-p}" x2="${W-p}" y2="${H-p}" stroke="#e3e9f0" stroke-width="1"></line>`;
  data.forEach((v,i)=>{
    const x=p+gap+i*(bw+gap), h=(v/maxV)*(H-p*2), y=(H-p)-h;
    s+=`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="5" fill="#2f80ed"></rect>`;
    s+=`<text x="${(x+bw/2).toFixed(1)}" y="${(y-6).toFixed(1)}" text-anchor="middle" font-size="11" fill="#2f80ed" font-weight="700">${v}</text>`;
    s+=`<text x="${(x+bw/2).toFixed(1)}" y="${H-9}" text-anchor="middle" font-size="9" fill="#889">${labels[i]}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMinYMin meet" style="max-width:560px;margin:0 auto;display:block">${s}</svg>`;
}
function classReportExport(mode){
  try{
  const list=DB.exams.filter(e=>(!F.grade||e.grade===F.grade)&&(!F.subject||e.subject===F.subject)&&(!F.cls||e.cls===F.cls)&&matchQ(F.q,[e.name,e.type,e.cls,e.subject,e.note])).sort((a,b)=>a.date.localeCompare(b.date));
  if(!list.length){ toast('当前筛选条件下没有可导出的考试'); return; }
  toast('正在生成班级分析报告…');
  const calc=list.map(e=>({e,a:calcExam(e)}));
  const mean=a=>(a.reduce((x,y)=>+x+(+y),0)/a.length).toFixed(1);
  const avgAvgs=mean(calc.map(c=>c.a.avg));
  const best=calc.reduce((m,c)=>+c.a.avg>+m.a.avg?c:m);
  const worst=calc.reduce((m,c)=>+c.a.avg<+m.a.avg?c:m);
  const avgExc=mean(calc.map(c=>c.a.excRate));
  const avgPass=mean(calc.map(c=>c.a.passRate));
  const avgLow=mean(calc.map(c=>c.a.lowRate));
  const cls=F.cls||'全部班级', subj=F.subject||'全部学科';
  const range=list[0].date+' ~ '+list[list.length-1].date;
  let html=`<div class="rpt">
  <div class="rpt-header">
    <div class="rpt-header-main">
      <div class="rpt-type">班级整体</div>
      <h1>班级整体分析报告</h1>
      <div class="rpt-meta">${esc(cls)} · ${esc(subj)} · ${range} · 共 ${list.length} 场考试</div>
    </div>
    <div class="rpt-header-score"><span>考试场次</span><b>${list.length}</b></div>
  </div>
  <div class="rpt-judge"><i class="rpt-dot blue"></i>本报告汇总当前筛选条件下 ${list.length} 场考试的整体数据，供班级教学质量诊断、教研复盘与家校沟通使用。</div>
  <div class="rpt-kpi-grid">
    <div class="rpt-kpi kpi-avg"><div class="rpt-ico">均</div><div><span>历次平均分</span><b>${avgAvgs}</b></div></div>
    <div class="rpt-kpi kpi-max"><div class="rpt-ico">高</div><div><span>最高平均分</span><b>${best.a.avg}</b></div></div>
    <div class="rpt-kpi kpi-min"><div class="rpt-ico">低</div><div><span>最低平均分</span><b>${worst.a.avg}</b></div></div>
    <div class="rpt-kpi kpi-exc"><div class="rpt-ico">优</div><div><span>平均优秀率</span><b>${avgExc}%</b></div></div>
    <div class="rpt-kpi kpi-pass"><div class="rpt-ico">及</div><div><span>平均及格率</span><b>${avgPass}%</b></div></div>
    <div class="rpt-kpi kpi-low"><div class="rpt-ico">险</div><div><span>平均低分率</span><b>${avgLow}%</b></div></div>
  </div>
  <div class="rpt-card rpt-card-full">
    <div class="rpt-card-title"><i class="rpt-dot blue"></i>历次考试平均分对比 <span class="rpt-sub">${esc(cls)} · ${esc(subj)}</span></div>
    <div class="rpt-chart">${classAvgChart(calc)}</div>
  </div>`;
  calc.forEach((c,i)=>{
    html+=`<h2 style="font-family:'SimHei','Heiti SC',sans-serif;font-size:15pt;margin:20px 0 8px;color:#1f5fa8;border-left:5px solid #2f7fd1;padding-left:10px">${i+1}. ${esc(c.e.name)}（${esc(c.e.date)}）</h2>`;
    html+=examAnalysisHtml(c.e);
  });
  html+=`</div>`;
  const title='班级整体分析报告_'+cls+'_'+today();
  _lastClassReport={html,title,cls,subj};
  if(mode==='word'){ exportWordDoc(title,'<style>'+RPT_CSS+'</style>'+html); }
  else if(mode==='pdf'){ exportPDFDoc(html); }
  else if(mode==='print'){ doPrint(html); }
  else{
    openModal(title+' · 预览', html,
      `<button class="btn btn-green" onclick="classReportExport('word')">导出 Word</button>
       <button class="btn" onclick="classReportExport('pdf')">导出 PDF</button>
       <button class="btn btn-primary" onclick="classReportExport('print')">A4 打印</button>
       <button class="btn" onclick="closeModal()">关闭</button>`);
  }
  }catch(err){ console.error(err); toast('报告生成失败：'+(err&&err.message?err.message:err)); }
}

/* ==================== 13. 初始化 / 登录 ==================== */
// 页面打开立即触发一次心跳（轻量连通自检，不影响主功能）
keepAlive();
function startApp(){
  document.getElementById('loginScreen').style.display='none';
  document.getElementById('appRoot').style.display='';
  renderNav(); fillGlobalSelects(); render(); updateUserBar();
  loadSharedAi();   // 异步加载管理员统一 AI 密钥（老师免配置）
  keepAlive(true);  // 登录成功后再补一次心跳
}
function showLogin(){
  document.getElementById('appRoot').style.display='none';
  document.getElementById('loginScreen').style.display='flex';
}
function updateUserBar(){
  const el=document.getElementById('userBar');
  if(ONLINE){
    el.innerHTML=`<span class="user-name">👤 ${esc(USERNAME)}</span><button class="btn btn-sm" onclick="doLogout()">退出登录</button>`;
  }else{
    el.innerHTML=`<span class="user-hint">未登录 · 请使用管理员发放的密钥</span><button class="btn btn-sm btn-primary" onclick="showLogin()">用密钥登录</button>`;
  }
}
async function doLogin(){
  const key=fv('loginKey'); if(!key){ toast('请输入密钥'); return; }
  try{
    await api.login(key, fv('loginName')||'老师');
    const db=await api.load();
    DB = db ? db : (localStorage.getItem(DB_KEY)? JSON.parse(localStorage.getItem(DB_KEY)) : seedData());
    if(!db){ await api.save(DB); }   // 新空间：用示例数据初始化
    startApp(); toast('登录成功，欢迎使用云端工作台');
  }catch(e){
    ONLINE=false;
    const msg=(e&&e.message)||'网络错误';
    toast('登录失败：'+msg+'（请联系管理员确认密钥是否正确）');
  }
}
function doLogout(){ api.logout(); toast('已退出登录'); showLogin(); }
function saveAiKey(){
  const k=(document.getElementById('ai_key')||{}).value||'';
  if(k.trim()) localStorage.setItem('twb_ai_key', k.trim()); else localStorage.removeItem('twb_ai_key');
  const b=(document.getElementById('ai_base')||{}).value||'';
  if(b.trim()) localStorage.setItem('twb_ai_base', b.trim()); else localStorage.removeItem('twb_ai_base');
  const m=(document.getElementById('ai_model')||{}).value||'';
  if(m.trim()) localStorage.setItem('twb_ai_model', m.trim()); else localStorage.removeItem('twb_ai_model');
  toast('AI 配置已保存（仅存本机浏览器）');
}

function simpleHash(s){ let h=0; for(let i=0;i<s.length;i++){ h=(h*31+s.charCodeAt(i))>>>0; } return 'h'+h.toString(16); }
function copyText(t){ if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(t).catch(()=>{}); } else { const ta=document.createElement('textarea'); ta.value=t; document.body.appendChild(ta); ta.select(); try{document.execCommand('copy');}catch(e){} document.body.removeChild(ta); } }
async function adminEnter(){
  const pwd=(document.getElementById('admin_pwd')||{}).value||'';
  if(!pwd){ toast('请输入密码'); return; }
  if(simpleHash(pwd)!==ADMIN_PWD_HASH){ toast('密码错误'); return; }
  sessionStorage.setItem('twb_admin_unlock','1');
  toast('管理员验证通过');
  renderSettings();
}
function adminLogout(){ sessionStorage.removeItem('twb_admin_unlock'); renderSettings(); toast('已退出管理'); }
async function genKeys(){
  const n=Math.max(1, Math.min(50, parseInt((document.getElementById('gen_count')||{}).value||'1')||1));
  try{
    let reg={};
    try{ reg = await api.getRow(KEYS_ROW) || {}; }catch(e){ reg = {}; }
    const fresh=[];
    for(let i=0;i<n;i++){
      let k; do{ k='TWB-'+Math.random().toString(36).slice(2,8).toUpperCase(); }while(reg[k]);
      reg[k]={ name:'', ws:'ws_'+Math.random().toString(36).slice(2,12), createdAt:Date.now() };
      fresh.push(k);
    }
    try{ await api.setRow(KEYS_ROW, reg); }catch(e){ /* 云端失败忽略 */ }
    // 本机兜底：存一份到本地，保证本机老师可登（跨设备同步需云端可用）
    const localReg = JSON.parse(localStorage.getItem('twb_local_keys')||'{}');
    Object.assign(localReg, reg);
    localStorage.setItem('twb_local_keys', JSON.stringify(localReg));
    refreshKeys(fresh);
    toast('已生成 '+n+' 个密钥，点击密钥即可复制（本机可用）');
  }catch(e){ toast('生成失败：'+(e.message||'网络错误')); }
}
let KEY_LIST_EXPANDED = sessionStorage.getItem('twb_key_list_expand') === '1';
const KEY_LIST_PAGE_SIZE = 5;
function toggleKeyListExpand(){
  KEY_LIST_EXPANDED = !KEY_LIST_EXPANDED;
  sessionStorage.setItem('twb_key_list_expand', KEY_LIST_EXPANDED ? '1' : '0');
  refreshKeys();
}
async function refreshKeys(fresh){
  const box=document.getElementById('keyList'); if(!box)return;
  try{
    let reg={};
    try{ reg = await api.getRow(KEYS_ROW) || {}; }catch(e){ reg={}; }
    // 合并本机本地名单（云端不可达时仍可见）
    try{ const localReg = JSON.parse(localStorage.getItem('twb_local_keys')||'{}'); reg = Object.assign({}, localReg, reg); }catch(e){}
    const keys=Object.keys(reg);
    if(!keys.length){ box.innerHTML='暂无已发放密钥。输入数量后点「生成」。'; return; }
    const total=keys.length;
    const showAll = KEY_LIST_EXPANDED || total <= KEY_LIST_PAGE_SIZE;
    const visibleKeys = showAll ? keys : keys.slice(0, KEY_LIST_PAGE_SIZE);
    const rows=visibleKeys.map((k)=>{
      const idx=keys.indexOf(k);
      const r=reg[k];
      const tag=(fresh&&fresh.indexOf(k)>=0)?'<span class="tag tag-blue">新</span>':'';
      return `<tr>
        <td style="text-align:center;color:var(--ink2);width:48px">${idx+1}</td>
        <td><code style="background:#eef3ff;padding:3px 9px;border-radius:6px;cursor:pointer;font-weight:600" onclick="copyKey('${k}')" title="点击复制">${esc(k)}</code>${tag}</td>
        <td><input id="kn_${k}" value="${esc(r.name||'')}" placeholder="填写老师姓名" style="width:100%;min-width:120px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:#fbfdfe" onchange="saveKeyName('${k}')" onkeydown="if(event.key==='Enter')saveKeyName('${k}')"></td>
        <td style="text-align:right;white-space:nowrap"><button class="btn btn-sm" onclick="revokeKey('${k}')">撤销</button></td>
      </tr>`;
    }).join('');
    const expandBar = total > KEY_LIST_PAGE_SIZE
      ? `<div style="text-align:center;margin-top:10px">
           <button class="btn btn-sm" onclick="toggleKeyListExpand()">${showAll ? '收起 ↑' : '展开全部（共 '+total+' 个） ↓'}</button>
         </div>`
      : '';
    box.innerHTML='<div style="margin-bottom:8px">已发放 <b>'+total+'</b> 个密钥（点击密钥可复制，填写老师姓名后自动保存）：</div>'+
      '<table class="tbl"><thead><tr><th style="width:48px">序号</th><th>访问密钥</th><th>老师姓名</th><th style="text-align:right">操作</th></tr></thead><tbody>'+rows+'</tbody></table>'+expandBar;
  }catch(e){ box.innerHTML='读取失败：'+(e.message||'网络错误'); }
}
async function saveKeyName(k){
  const v=(document.getElementById('kn_'+k)||{}).value||'';
  try{
    const localReg = JSON.parse(localStorage.getItem('twb_local_keys')||'{}');
    if(localReg[k]){ localReg[k].name=v.trim(); localStorage.setItem('twb_local_keys', JSON.stringify(localReg)); }
  }catch(e){}
  try{
    const reg=await api.getRow(KEYS_ROW) || {};
    if(reg[k]){ reg[k].name=v.trim(); await api.setRow(KEYS_ROW, reg); }
    toast('已保存 '+esc(k)+' 的姓名为：'+esc(v||'(空)'));
  }catch(e){ toast('已在本机保存姓名（云端同步暂不可用）'); }
}
async function revokeKey(k){
  if(!confirm('撤销密钥 '+k+'？\n该老师将不能再登录此密钥，但其数据会保留。'))return;
  try{
    const localReg = JSON.parse(localStorage.getItem('twb_local_keys')||'{}');
    delete localReg[k]; localStorage.setItem('twb_local_keys', JSON.stringify(localReg));
  }catch(e){}
  try{
    const reg=await api.getRow(KEYS_ROW) || {};
    delete reg[k];
    await api.setRow(KEYS_ROW, reg);
    refreshKeys();
    toast('已撤销 '+k);
  }catch(e){ refreshKeys(); toast('已在本机撤销 '+k+'（云端同步暂不可用）'); }
}
function copyKey(k){ copyText(k); toast('已复制密钥：'+k); }

async function boot(){
  // 每次打开都显示登录屏，不再自动登录（避免他人在同一浏览器直接进入）
  WS_KEY=''; USERNAME=''; ONLINE=false;
  localStorage.removeItem('twb_ws'); localStorage.removeItem('twb_user');
  sessionStorage.removeItem('twb_admin_unlock');
  DB = seedData();
  showLogin();
}
boot();

/* ==================== 通用 KPI 卡片 ==================== */
function statCard(title, num, color, unit){
  return `<div class="stat-card"><div class="stat-ico" style="background:${color}1a;color:${color}">${esc(title.slice(0,2))}</div>
    <div><div class="share-num" style="display:flex;align-items:baseline;gap:3px"><span class="stat-num">${num}</span><span style="font-size:12px;color:var(--ink3)">${unit||''}</span></div>
    <div class="stat-label">${esc(title)}</div></div></div>`;
}

/* ==================== 考勤与请假 ==================== */
let _attTab='roll', _attCls='', _rollRows=[];
function renderAttend(){
  ensureSchema();
  const clsOpts=clsSelectHtml(_attCls,'att_cls','全部班级','','_attCls=this.value;renderAttend()');
  let list=_attCls?DB.attends.filter(a=>a.cls===_attCls):DB.attends.slice();
  if(F.q) list=list.filter(a=>matchQ(F.q,[a.date,a.cls,a.rows.map(r=>r.name+' '+r.status+' '+r.note).join(' ')]));
  list.sort((a,b)=>b.date.localeCompare(a.date));
  let leaves=_attCls?DB.leaves.filter(l=>l.cls===_attCls):DB.leaves.slice();
  if(F.q) leaves=leaves.filter(l=>matchQ(F.q,[l.name,l.cls,l.type,l.reason,l.start,l.end,l.approve]));
  const pending=leaves.filter(l=>l.approve==='待审批').length;
  let late=0,absent=0; DB.attends.forEach(a=>a.rows.forEach(r=>{if(r.status==='迟到')late++;if(r.status==='缺勤')absent++;}));
  const kpis=`<div class="stat-grid">
    ${statCard('点名记录',DB.attends.length,'#e11d48','次')}
    ${statCard('待审批请假',pending,'#7c3aed','条')}
    ${statCard('累计迟到',late,'#d97706','人次')}
    ${statCard('累计缺勤',absent,'#a82420','人次')}
  </div>`;
  const seg=`<div class="seg"><button class="${_attTab==='roll'?'on':''}" onclick="_attTab='roll';renderAttend()">点名记录</button><button class="${_attTab==='leave'?'on':''}" onclick="_attTab='leave';renderAttend()">请假管理</button></div>`;
  let main;
  if(_attTab==='roll'){
    const rowsHtml=list.map(a=>{
      const c={}; a.rows.forEach(r=>c[r.status]=(c[r.status]||0)+1);
      const sum=Object.keys(c).map(k=>k+c[k]).join(' · ')||'全勤';
      return `<div class="list-row"><div class="lr-main"><div class="lr-title">${a.date} · ${esc(a.cls)}</div><div class="lr-sub">${esc(sum)}　共 ${a.rows.length} 人</div></div>
        <div class="lr-actions"><button class="btn btn-sm" onclick="openRoll('${a.id}')">查看/编辑</button><button class="btn btn-sm" onclick="delRoll('${a.id}')">删除</button></div></div>`;
    }).join('') || emptyState('还没有点名记录','每次点名都会自动汇总考勤数据，便于月底统计与家校沟通。', '<button class="btn btn-primary" onclick="openRoll()">+ 新建点名</button>');
    main=`<div class="card card-tint-rose">${cardTitleIcon(ICO_CHECK,'点名记录（'+list.length+' 次）')}${rowsHtml}</div>`;
  } else {
    const rowsHtml=leaves.map(l=>`<div class="list-row"><div class="lr-main"><div class="lr-title">${esc(l.name)} · ${esc(l.cls)} · ${esc(l.type)}</div><div class="lr-sub">${l.start}${l.start!==l.end?' ~ '+l.end:''}　${esc(l.reason)}</div></div>
      <div class="lr-actions">
        ${l.approve==='待审批'?`<button class="btn btn-sm btn-green" onclick="approveLeave('${l.id}','已批准')">批准</button><button class="btn btn-sm" onclick="approveLeave('${l.id}','已驳回')">驳回</button>`:`<span class="tag ${l.approve==='已批准'?'tag-green':'tag-red'}">${l.approve}</span>`}
        <button class="btn btn-sm" onclick="openLeave('${l.id}')">编辑</button><button class="btn btn-sm" onclick="delLeave('${l.id}')">删除</button>
      </div></div>`).join('')||emptyState('还没有请假记录','学生病事假在线审批，状态实时同步至考勤统计。', '<button class="btn btn-primary" onclick="openLeave()">+ 新增请假</button>');
    main=`<div class="card card-tint-rose">${cardTitleIcon(ICO_CHECK,'请假管理（待审批 '+pending+' 条）')}${rowsHtml}</div>`;
  }
  const headActions=`${_attTab==='roll'?`<button class="btn btn-primary" onclick="openRoll()">+ 新建点名</button>`:`<button class="btn btn-primary" onclick="openLeave()">+ 新增请假</button>`}<button class="btn" onclick="attendStats()">考勤统计</button>`;
  const attStatus={}; DB.attends.forEach(a=>a.rows.forEach(r=>attStatus[r.status]=(attStatus[r.status]||0)+1));
  document.getElementById('page').innerHTML=
    wbHead('考勤与请假','title-rose','每日点名、病事假审批与考勤统计——班主任最高频事务，一键完成',headActions)+
    `<div class="filter-bar">${clsOpts}</div>
    ${kpis}${seg}${main}`;
}
function renderRollRows(){
  const box=document.getElementById('roll_rows'); if(!box) return;
  box.innerHTML=_rollRows.map((r,i)=>`
   <div style="display:flex;gap:8px;align-items:center;padding:7px 0;border-bottom:1px dashed var(--line)">
     <div style="flex:0 0 84px;font-weight:600">${esc(r.name)}</div>
     <select onchange="_rollRows[${i}].status=this.value" style="flex:0 0 104px;padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:#fff">
       ${['出勤','迟到','病假','事假','缺勤'].map(s=>`<option ${r.status===s?'selected':''}>${s}</option>`).join('')}
     </select>
     <input placeholder="备注（可选）" value="${esc(r.note)}" oninput="_rollRows[${i}].note=this.value" style="flex:1;min-width:0;padding:6px 8px;border:1px solid var(--line);border-radius:8px">
   </div>`).join('') || '<div class="empty">该班级暂无学生</div>';
}
function rollChangeCls(){
  const cls=document.getElementById('roll_cls').value;
  _rollRows=DB.students.filter(s=>s.cls===cls).map(s=>({sid:s.id,name:s.name,status:'出勤',note:''}));
  renderRollRows();
}
function openRoll(id){
  const isNew=!id; const sess=isNew?null:DB.attends.find(a=>a.id===id);
  const cls=isNew?(_attCls||classList()[0]):sess.cls;
  const date=isNew?today():sess.date;
  _rollRows=isNew?DB.students.filter(s=>s.cls===cls).map(s=>({sid:s.id,name:s.name,status:'出勤',note:''}))
            :sess.rows.map(r=>({...r}));
  const body=`<div class="form-grid">
    <div class="form-item"><label>日期</label><input id="roll_date" type="date" value="${date}"></div>
    <div class="form-item"><label>班级</label>${clsSelectHtml(cls,'roll_cls','','','rollChangeCls()')}</div>
  </div>
  <div class="card-title" style="margin-top:6px">学生考勤（共 ${_rollRows.length} 人）</div>
  <div id="roll_rows"></div>`;
  openModal((isNew?'新建':'编辑')+'点名记录',body,
    `<button class="btn btn-primary" onclick="saveRoll('${isNew?'new':id}')">保存</button>
     <button class="btn" onclick="closeModal()">取消</button>`);
  renderRollRows();
}
function saveRoll(id){
  const date=fv('roll_date'), cls=fv('roll_cls');
  if(!cls){toast('请选择班级');return;}
  if(!_rollRows.length){toast('该班级暂无学生');return;}
  if(id==='new'){ DB.attends.push({id:uid(),date,cls,rows:_rollRows.slice()}); }
  else { const s=DB.attends.find(a=>a.id===id); s.date=date; s.cls=cls; s.rows=_rollRows.slice(); }
  save(); closeModal(); renderAttend(); toast('已保存点名记录');
}
function delRoll(id){ if(!confirm('删除该点名记录？'))return; DB.attends=DB.attends.filter(a=>a.id!==id); save(); renderAttend(); }
function openLeave(id){
  const isNew=!id; const lv=isNew?null:DB.leaves.find(l=>l.id===id);
  const body=`<div class="form-grid">
   <div class="form-item full"><label>学生</label><select id="lv_sid">${DB.students.map(s=>`<option value="${s.id}" ${lv&&lv.sid===s.id?'selected':''}>${esc(s.name)}（${esc(s.cls)}）</option>`).join('')}</select></div>
   <div class="form-item"><label>请假类型</label><select id="lv_type">${['病假','事假'].map(t=>`<option ${lv&&lv.type===t?'selected':''}>${t}</option>`).join('')}</select></div>
   <div class="form-item"><label>开始日期</label><input id="lv_start" type="date" value="${lv?lv.start:today()}"></div>
   <div class="form-item"><label>结束日期</label><input id="lv_end" type="date" value="${lv?lv.end:today()}"></div>
   <div class="form-item full"><label>请假事由</label><textarea id="lv_reason" placeholder="如：感冒发烧需就医">${lv?esc(lv.reason):''}</textarea></div>
  </div>`;
  openModal((isNew?'新增':'编辑')+'请假申请',body,
    `<button class="btn btn-primary" onclick="saveLeave('${isNew?'new':id}')">${isNew?'提交申请':'保存'}</button>
     <button class="btn" onclick="closeModal()">取消</button>`);
}
function saveLeave(id){
  const sid=fv('lv_sid'); const st=DB.students.find(s=>s.id===sid); if(!st){toast('请选择学生');return;}
  const rec={sid,name:st.name,cls:st.cls,type:fv('lv_type'),start:fv('lv_start'),end:fv('lv_end'),reason:fv('lv_reason'),
             approve:id==='new'?'待审批':DB.leaves.find(l=>l.id===id).approve};
  if(id==='new'){rec.id=uid();DB.leaves.push(rec);} else {Object.assign(DB.leaves.find(x=>x.id===id),rec);}
  save(); closeModal(); renderAttend(); toast('已保存请假');
}
function approveLeave(id,st){ const l=DB.leaves.find(x=>x.id===id); if(!l)return; l.approve=st; save(); renderAttend(); toast('已'+st); }
function delLeave(id){ if(!confirm('删除该请假记录？'))return; DB.leaves=DB.leaves.filter(l=>l.id!==id); save(); renderAttend(); }
function attendStats(){
  ensureSchema();
  const map={};
  DB.attends.forEach(a=>a.rows.forEach(r=>{
    if(!map[r.name])map[r.name]={name:r.name,cls:a.cls,出勤:0,迟到:0,病假:0,事假:0,缺勤:0};
    if(map[r.name][r.status]!=null)map[r.name][r.status]++;
  }));
  const arr=Object.values(map);
  const body=`<div class="card"><div class="card-title">考勤统计（全部点名记录汇总 · 共 ${DB.attends.length} 次点名）</div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>学生</th><th>班级</th><th>出勤</th><th>迟到</th><th>病假</th><th>事假</th><th>缺勤</th><th>异常合计</th></tr></thead><tbody>
    ${arr.map(m=>`<tr><td>${esc(m.name)}</td><td>${esc(m.cls)}</td><td>${m.出勤}</td><td>${m.迟到}</td><td>${m.病假}</td><td>${m.事假}</td><td>${m.缺勤}</td><td><b>${m.迟到+m.病假+m.事假+m.缺勤}</b></td></tr>`).join('')}
    </tbody></table></div></div>`;
  openModal('考勤统计',body,`<button class="btn" onclick="attendExportWord()">导出Word</button><button class="btn" onclick="closeModal()">关闭</button>`);
  window.__attStats=arr;
}
function attendExportWord(){
  const arr=window.__attStats||[];
  const tbl=`<table><thead><tr><th>学生</th><th>班级</th><th>出勤</th><th>迟到</th><th>病假</th><th>事假</th><th>缺勤</th><th>异常合计</th></tr></thead><tbody>${arr.map(m=>`<tr><td>${esc(m.name)}</td><td>${esc(m.cls)}</td><td>${m.出勤}</td><td>${m.迟到}</td><td>${m.病假}</td><td>${m.事假}</td><td>${m.缺勤}</td><td>${m.迟到+m.病假+m.事假+m.缺勤}</td></tr>`).join('')}</tbody></table>`;
  exportWordDoc('考勤统计_'+today(),'<h1>班级考勤统计</h1>'+tbl);
}

/* ==================== 家校沟通 ==================== */
let _contactCls='', _contactType='', _contactQ='';
function renderContact(){
  ensureSchema();
  let list=DB.contacts.slice();
  if(_contactCls) list=list.filter(c=>c.cls===_contactCls);
  if(_contactType) list=list.filter(c=>c.type===_contactType);
  const q=(F.q||_contactQ||'').trim().toLowerCase();
  if(q) list=list.filter(c=>(c.stuName+c.topic+c.content+c.result+c.cls+c.type).toLowerCase().includes(q));
  list.sort((a,b)=>b.date.localeCompare(a.date));
  const total=DB.contacts.length;
  const byType=t=>DB.contacts.filter(c=>c.type===t).length;
  const follow=DB.contacts.filter(c=>(c.followup||'').trim()!=='').length;
  const kpis=`<div class="stat-grid">
    ${statCard('沟通总次数',total,'#7c3aed','次')}
    ${statCard('电话沟通',byType('电话'),'#2f80ed','次')}
    ${statCard('微信沟通',byType('微信'),'#0891b2','次')}
    ${statCard('待跟进',follow,'#d97706','条')}
  </div>`;
  const fb=clsSelectHtml(_contactCls,'contact_cls','全部班级','','_contactCls=this.value;renderContact()');
  const tb=`<select onchange="_contactType=this.value;renderContact()">${['','电话','微信','家访','家长会','其他'].map(t=>`<option value="${t}" ${_contactType===t?'selected':''}>${t||'全部类型'}</option>`).join('')}</select>`;
  const qb=`<input placeholder="搜索学生/主题/内容" value="${esc(_contactQ)}" oninput="_contactQ=this.value;renderContact()">`;
  const rowsHtml=list.map(c=>`<div class="list-row"><div class="lr-main">
      <div class="lr-title">${esc(c.stuName)} · <span class="tag tag-blue">${esc(c.type)}</span> · ${c.date}</div>
      <div class="lr-sub"><b>主题：</b>${esc(c.topic)||'—'}</div>
      <div class="lr-sub">${esc(c.content)||'—'}</div>
      ${c.result?`<div class="lr-sub"><b>结果：</b>${esc(c.result)}</div>`:''}
      ${c.followup?`<div class="lr-sub"><b style="color:#d97706">待跟进：</b>${esc(c.followup)}</div>`:''}
    </div>
    <div class="lr-actions"><button class="btn btn-sm" onclick="openContact('${c.id}')">编辑</button><button class="btn btn-sm" onclick="delContact('${c.id}')">删除</button></div></div>`).join('')
    || emptyState('还没有沟通记录','记录每次家校联系，期末评优、突发事件追溯一目了然。', '<button class="btn btn-primary" onclick="openContact()">+ 新增沟通</button>');
  const headActions=`<button class="btn btn-primary" onclick="openContact()">+ 新增沟通</button><button class="btn" onclick="contactSummary()">AI小结</button><button class="btn" onclick="contactExportWord()">导出Word</button>`;
  document.getElementById('page').innerHTML=
    wbHead('家校沟通台账','title-violet','电话/微信/家访/家长会记录沉淀，便于期末评优与突发事件追溯，支持一键生成沟通小结',headActions)+
    `<div class="filter-bar">${fb}${tb}${qb}</div>
    ${kpis}
    <div class="card card-tint-violet">${cardTitleIcon(ICO_CHAT,'沟通记录（'+list.length+' 条）')}${rowsHtml}</div>`;
}
function openContact(id){
  const isNew=!id; const c=isNew?null:DB.contacts.find(x=>x.id===id);
  const body=`<div class="form-grid">
   <div class="form-item"><label>日期</label><input id="ct_date" type="date" value="${c?c.date:today()}"></div>
   <div class="form-item"><label>学生</label><select id="ct_sid">${DB.students.map(s=>`<option value="${s.id}" ${c&&c.stuName===s.name?'selected':''}>${esc(s.name)}（${esc(s.cls)}）</option>`).join('')}</select></div>
   <div class="form-item"><label>沟通方式</label><select id="ct_type">${['电话','微信','家访','家长会','其他'].map(t=>`<option ${c&&c.type===t?'selected':''}>${t}</option>`).join('')}</select></div>
   <div class="form-item"><label>沟通主题</label><input id="ct_topic" value="${c?esc(c.topic):''}" placeholder="如：计算基础薄弱"></div>
   <div class="form-item full"><label>沟通内容</label><textarea id="ct_content" placeholder="沟通的具体情况与反馈">${c?esc(c.content):''}</textarea></div>
   <div class="form-item full"><label>沟通结果</label><input id="ct_result" value="${c?esc(c.result):''}" placeholder="如：家长配合，已约定每日打卡"></div>
   <div class="form-item full"><label>后续跟进</label><input id="ct_followup" value="${c?esc(c.followup):''}" placeholder="需要后续做的事（留空表示无需跟进）"></div>
  </div>`;
  openModal((isNew?'新增':'编辑')+'沟通记录',body,
    `<button class="btn btn-primary" onclick="saveContact('${isNew?'new':id}')">保存</button>
     <button class="btn" onclick="closeModal()">取消</button>`);
}
function saveContact(id){
  const sid=fv('ct_sid'); const st=DB.students.find(s=>s.id===sid); if(!st){toast('请选择学生');return;}
  const rec={date:fv('ct_date'),stuName:st.name,cls:st.cls,type:fv('ct_type'),topic:fv('ct_topic'),content:fv('ct_content'),result:fv('ct_result'),followup:fv('ct_followup')};
  if(id==='new'){rec.id=uid();DB.contacts.push(rec);} else {Object.assign(DB.contacts.find(x=>x.id===id),rec);}
  save(); closeModal(); renderContact(); toast('已保存沟通记录');
}
function delContact(id){ if(!confirm('删除该沟通记录？'))return; DB.contacts=DB.contacts.filter(c=>c.id!==id); save(); renderContact(); }
function contactExportWord(){
  const items=DB.contacts.slice().sort((a,b)=>b.date.localeCompare(a.date)).map(c=>`<h2>${esc(c.stuName)}（${esc(c.cls)}）· ${esc(c.type)} · ${c.date}</h2>
    <p><b>主题：</b>${esc(c.topic)||'—'}</p><p><b>内容：</b>${esc(c.content)||'—'}</p>${c.result?`<p><b>结果：</b>${esc(c.result)}</p>`:''}${c.followup?`<p><b>后续跟进：</b>${esc(c.followup)}</p>`:''}`).join('');
  exportWordDoc('家校沟通台账_'+today(),'<h1>家校沟通台账</h1>'+items);
}
function contactSummary(){
  if(!ONLINE){ toast('未连接云端，无法生成AI小结，请先在管理员后台配置AI密钥'); return; }
  const recent=DB.contacts.slice().sort((a,b)=>b.date.localeCompare(a.date)).slice(0,12)
    .map(c=>`${c.date} ${c.stuName}(${c.cls}) ${c.type} 主题:${c.topic} 内容:${c.content} 结果:${c.result}`).join('\n');
  if(!recent){ toast('暂无沟通记录'); return; }
  openModal('AI生成沟通小结', '<div id="ct_sum" style="min-height:160px">正在生成…</div>', '<button class="btn" onclick="copyText(document.getElementById(\'ct_sum\').innerText)">复制</button><button class="btn" onclick="closeModal()">关闭</button>');
  api.ai('你是中小学班主任，擅长把家校沟通记录提炼成简明、专业、可用于期末评优或突发事件追溯的沟通小结。','以下是近期家校沟通记录，请按"总体情况、重点关注学生、后续建议"三段式生成一份沟通小结：\n\n'+recent)
    .then(r=>{ const el=document.getElementById('ct_sum'); if(el){ el.innerHTML='<pre style="white-space:pre-wrap;font-family:inherit;line-height:1.8">'+esc(r.ok?r.text:'生成失败')+'</pre>'; } })
    .catch(e=>{ const el=document.getElementById('ct_sum'); if(el) el.textContent='生成失败：'+(e.message||e); });
}

/* ==================== 作业管理 ==================== */
let _hwCls='', _hwSubject='';
function hwStatsOf(h){
  const total=DB.students.filter(s=>s.cls===h.cls).length;
  const unsub=(h.unsub||[]).length;
  const sub=Math.max(0,total-unsub);
  const submitRate=total?Math.round(sub/total*100):100;
  const corrected=+(h.correctedN||0);
  const corrRate=total?Math.min(100,Math.round(corrected/total*100)):0;
  return {total,unsub,sub,submitRate,corrected,corrRate};
}
function renderHomework(){
  ensureSchema();
  let list=DB.homeworks.slice();
  if(_hwCls) list=list.filter(h=>h.cls===_hwCls);
  if(_hwSubject) list=list.filter(h=>h.subject===_hwSubject);
  if(F.q) list=list.filter(h=>matchQ(F.q,[h.title,h.cls,h.subject,h.layer,h.content,h.deadline,(h.unsub||[]).join(' ')]));
  list.sort((a,b)=>b.date.localeCompare(a.date));
  const total=DB.homeworks.length;
  const pending=DB.homeworks.filter(h=>(h.unsub||[]).length>0).length;
  const layer=DB.homeworks.filter(h=>h.layer==='分层作业').length;
  const avgRate=DB.homeworks.length?Math.round(DB.homeworks.reduce((s,h)=>s+hwStatsOf(h).submitRate,0)/DB.homeworks.length):100;
  const kpis=`<div class="stat-grid">
    ${statCard('累计布置',total,'#d97706','次')}
    ${statCard('待收缴',pending,'#e11d48','次')}
    ${statCard('分层作业',layer,'#7c3aed','次')}
    ${statCard('平均提交率',avgRate,'#2f80ed','%')}
  </div>`;
  const fb=clsSelectHtml(_hwCls,'hw_cls','全部班级','','_hwCls=this.value;renderHomework()');
  const sb=subSelectHtml(_hwSubject,'hw_filter_subject','全部学科','','_hwSubject=this.value;renderHomework()');
  const rowsHtml=list.map(h=>{ const st=hwStatsOf(h); return `<div class="list-row"><div class="lr-main">
      <div class="lr-title">${esc(h.title)} · ${esc(h.cls)} · ${esc(h.subject)} <span class="tag tag-blue">${esc(h.layer)}</span></div>
      <div class="lr-sub">布置 ${h.date}　截止 ${esc(h.deadline||'—')}</div>
      <div class="lr-sub">${esc(h.content)||'—'}</div>
      <div class="lr-sub" style="display:flex;gap:16px;flex-wrap:wrap;margin-top:4px">
        <span>提交率 <b style="color:${st.submitRate>=90?'#1e7e4a':st.submitRate>=70?'#d97706':'#e11d48'}">${st.submitRate}%</b>（${st.sub}/${st.total}）</span>
        <span>批改 <b style="color:#2f80ed">${st.corrRate}%</b>（${st.corrected}/${st.total}）</span>
        ${st.unsub?`<span style="color:#e11d48">未交 ${st.unsub} 人</span>`:`<span style="color:#1e7e4a">已全部收缴 ✓</span>`}
      </div>
      <div class="mini-bar"><span style="width:${st.submitRate}%;background:#2f80ed"></span></div>
      <div class="mini-bar"><span style="width:${st.corrRate}%;background:#7c3aed"></span></div>
    </div>
    <div class="lr-actions">
      <button class="btn btn-sm" onclick="markUnsub('${h.id}')">标记未交</button>
      <button class="btn btn-sm" onclick="markCorrected('${h.id}')">批改进度</button>
      <button class="btn btn-sm" onclick="openHomework('${h.id}')">编辑</button>
      <button class="btn btn-sm btn-danger" onclick="delHomework('${h.id}')">删除</button>
    </div></div>`; }).join('')
    || emptyState('还没有作业记录','布置分层作业、追踪提交与批改进度，一键催交未交学生。', '<button class="btn btn-primary" onclick="openHomework()">+ 布置作业</button>');
  const headActions=`<button class="btn btn-primary" onclick="openHomework()">+ 布置作业</button><button class="btn" onclick="hwStats()">收缴统计</button><button class="btn" onclick="hwExportWord()">导出Word</button>`;
  document.getElementById('page').innerHTML=
    wbHead('作业管理','title-amber','作业布置、分层设计与收缴统计，学科教师日常刚需，一键追踪未交',headActions)+
    `<div class="filter-bar">${fb}${sb}</div>
    ${kpis}
    <div class="card card-tint-amber">${cardTitleIcon(ICO_CLIPBOARD,'作业记录（'+list.length+' 条）')}${rowsHtml}</div>`;
}
function openHomework(id){
  const isNew=!id; const h=isNew?null:DB.homeworks.find(x=>x.id===id);
  const cls=isNew?(_hwCls||classList()[0]):h.cls;
  const body=`<div class="form-grid">
   <div class="form-item"><label>布置日期</label><input id="hw_date" type="date" value="${h?h.date:today()}"></div>
   <div class="form-item"><label>班级</label>${clsSelectHtml(cls,'hw_modal_cls',undefined,'','hwChangeCls()')}</div>
   <div class="form-item"><label>学科</label>${subSelectHtml(h?h.subject:'','hw_subject')}</div>
   <div class="form-item"><label>作业标题</label><input id="hw_title" value="${h?esc(h.title):''}" placeholder="如：竖式计算练习"></div>
   <div class="form-item"><label>作业类型</label><select id="hw_layer">${['必做','选做','分层作业'].map(t=>`<option ${h&&h.layer===t?'selected':''}>${t}</option>`).join('')}</select></div>
   <div class="form-item"><label>截止日期</label><input id="hw_deadline" type="date" value="${h?esc(h.deadline||''):''}"></div>
   <div class="form-item"><label>已批改人数</label><input id="hw_corrected" type="number" min="0" value="${h?(h.correctedN||0):0}" placeholder="0" style="width:110px"></div>
   <div class="form-item full"><label>作业内容</label><textarea id="hw_content" placeholder="如：练习册第42页1-3题">${h?esc(h.content):''}</textarea></div>
   <div class="form-item full"><label>备注</label><input id="hw_note" value="${h?esc(h.note||''):''}" placeholder="如：鼓励选做"></div>
  </div>`;
  openModal((isNew?'布置':'编辑')+'作业',body,
    `<button class="btn btn-primary" onclick="saveHomework('${isNew?'new':id}')">保存</button>
     <button class="btn" onclick="closeModal()">取消</button>`);
}
function hwChangeCls(){ /* 标记未交时按班级取学生，此处无需重建 */ }
function saveHomework(id){
  const cls=fv('hw_modal_cls'); if(!cls||cls==='__add__'){toast('请选择班级');return;}
  const rec={date:fv('hw_date'),cls,subject:fv('hw_subject'),title:fv('hw_title'),layer:fv('hw_layer'),content:fv('hw_content'),deadline:fv('hw_deadline'),note:fv('hw_note'),correctedN:parseInt(fv('hw_corrected'))||0,unsub:[]};
  if(id==='new'){rec.id=uid();DB.homeworks.push(rec);} else {const o=DB.homeworks.find(x=>x.id===id);rec.unsub=o.unsub||[];Object.assign(o,rec);}
  save(); closeModal(); renderHomework(); toast('已保存作业');
}
function delHomework(id){ if(!confirm('删除该作业记录？'))return; DB.homeworks=DB.homeworks.filter(h=>h.id!==id); save(); renderHomework(); }
function markUnsub(id){
  const h=DB.homeworks.find(x=>x.id===id); if(!h)return;
  const students=DB.students.filter(s=>s.cls===h.cls);
  const cur=h.unsub||[];
  const body=`<div class="card-title">${esc(h.cls)} · 《${esc(h.title)}》未交名单</div>
    <div id="unsub_box" class="check-group">${students.map(s=>`<span class="check-pill ${cur.includes(s.name)?'on':''}" data-v="${esc(s.name)}" onclick="this.classList.toggle('on')">${esc(s.name)}</span>`).join('')}</div>
    <div style="margin-top:8px;color:var(--ink3);font-size:12px">点选未交学生，再次点击取消</div>`;
  openModal('标记未交',body,
    `<button class="btn btn-primary" onclick="saveUnsub('${id}')">保存</button><button class="btn" onclick="closeModal()">取消</button>`);
}
function saveUnsub(id){
  const h=DB.homeworks.find(x=>x.id===id); if(!h)return;
  h.unsub=[...document.querySelectorAll('#unsub_box .check-pill.on')].map(p=>p.dataset.v);
  save(); closeModal(); renderHomework(); toast('已更新未交名单（'+h.unsub.length+'人）');
}
function markCorrected(id){
  const h=DB.homeworks.find(x=>x.id===id); if(!h)return;
  const total=DB.students.filter(s=>s.cls===h.cls).length;
  const body=`<div class="form-grid">
    <div class="form-item"><label>班级人数</label><input value="${total} 人" disabled></div>
    <div class="form-item"><label>已批改人数</label><input id="cc_n" type="number" min="0" value="${h.correctedN||0}" style="width:120px"></div>
  </div>
  <div style="color:var(--ink3);font-size:12px">批改进度 = 已批改 / 班级人数，将显示在作业列表中</div>`;
  openModal('批改进度',body,`<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="saveCorrected('${id}')">保存</button>`);
}
function saveCorrected(id){
  const h=DB.homeworks.find(x=>x.id===id); if(!h)return;
  h.correctedN=parseInt(fv('cc_n'))||0;
  save(); closeModal(); renderHomework(); toast('已更新批改进度');
}
function hwStats(){
  const byCls={}; DB.homeworks.forEach(h=>{ byCls[h.cls]=(byCls[h.cls]||0)+1; });
  const unsubAll=DB.homeworks.filter(h=>(h.unsub||[]).length>0)
    .map(h=>`${esc(h.cls)}《${esc(h.title)}》未交：${esc((h.unsub||[]).join('、'))||'—'}`);
  const body=`<div class="card"><div class="card-title">各班级作业布置量</div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>班级</th><th>布置次数</th></tr></thead><tbody>
    ${Object.keys(byCls).map(c=>`<tr><td>${esc(c)}</td><td>${byCls[c]}</td></tr>`).join('')||'<tr><td colspan="2">暂无</td></tr>'}</tbody></table></div></div>
    <div class="card"><div class="card-title">未交汇总（${unsubAll.length} 次有待收缴）</div>
    ${unsubAll.map(t=>`<div class="lr-sub" style="padding:6px 0">${t}</div>`).join('')||'<div class="empty">全部作业已收缴 ✓</div>'}</div>`;
  openModal('作业收缴统计',body,`<button class="btn" onclick="hwExportWord()">导出Word</button><button class="btn" onclick="closeModal()">关闭</button>`);
}
function hwExportWord(){
  const items=DB.homeworks.slice().sort((a,b)=>b.date.localeCompare(a.date))
    .map(h=>`<h2>${esc(h.cls)} · ${esc(h.subject)} · 《${esc(h.title)}》</h2>
    <p>布置日期：${h.date}　截止：${esc(h.deadline||'—')}　类型：${esc(h.layer)}</p>
    <p><b>内容：</b>${esc(h.content)||'—'}</p>
    <p><b>未交：</b>${esc((h.unsub||[]).join('、')||'全部已交')}</p>`).join('');
  exportWordDoc('作业管理_'+today(),'<h1>作业管理台账</h1>'+items);
}

/* ==================== 教研与跟踪 ==================== */
let _researchTab='observe';
function renderResearch(){
  ensureSchema();
  const total=DB.observes.length;
  const avg=total?Math.round(DB.observes.reduce((s,o)=>s+(+o.score||0),0)/total):0;
  const tutCount=DB.tutors.length;
  const active=DB.tutors.filter(t=>t.status==='进行中').length;
  const kpis=`<div class="stat-grid">
    ${statCard('听课节数',total,'#475569','节')}
    ${statCard('平均评分',avg,'#2f80ed','分')}
    ${statCard('跟踪学生',tutCount,'#7c3aed','人')}
    ${statCard('进行中跟踪',active,'#d97706','人')}
  </div>`;
  const seg=`<div class="seg"><button class="${_researchTab==='observe'?'on':''}" onclick="_researchTab='observe';renderResearch()">听课评课</button><button class="${_researchTab==='tutor'?'on':''}" onclick="_researchTab='tutor';renderResearch()">培优补差</button></div>`;
  let main;
  if(_researchTab==='observe'){
    let obs=DB.observes.slice();
    if(F.q) obs=obs.filter(o=>matchQ(F.q,[o.title,o.subject,o.cls,o.teacher,o.observer,o.comments,o.suggestion]));
    obs.sort((a,b)=>b.date.localeCompare(a.date));
    const rowsHtml=obs.map(o=>`<div class="list-row"><div class="lr-main">
        <div class="lr-title">${esc(o.title)} · ${esc(o.subject)} <span class="tag tag-blue">${esc(o.cls)}</span> 评分 ${o.score}</div>
        <div class="lr-sub">${o.date}　授课：${esc(o.teacher)}　听课：${esc(o.observer)}</div>
        <div class="lr-sub">${esc(o.comments)||'—'}</div>
        ${o.suggestion?`<div class="lr-sub"><b style="color:#2f80ed">建议：</b>${esc(o.suggestion)}</div>`:''}
      </div>
      <div class="lr-actions"><button class="btn btn-sm" onclick="openObserve('${o.id}')">编辑</button><button class="btn btn-sm" onclick="delObserve('${o.id}')">删除</button></div></div>`).join('')
      || emptyState('还没有听课记录','记录同行听课评课，沉淀教研思考与个人教学智库。', '<button class="btn btn-primary" onclick="openObserve()">+ 听课评课</button>');
    main=`<div class="card card-tint-slate">${cardTitleIcon(ICO_BOOK,'听课评课记录（'+obs.length+' 节）')}${rowsHtml}</div>`;
  } else {
    let tuts=DB.tutors.slice();
    if(F.q) tuts=tuts.filter(t=>matchQ(F.q,[t.name,t.cls,t.subject,t.type,t.reason,t.plan,t.status,(t.records||[]).map(r=>r.content).join(' ')]));
    tuts.sort((a,b)=>(b.status==='进行中')-(a.status==='进行中'));
    const rowsHtml=tuts.map(t=>`<div class="list-row"><div class="lr-main">
        <div class="lr-title">${esc(t.name)} · ${esc(t.cls)} · ${esc(t.subject)} <span class="tag ${t.type==='培优'?'tag-blue':'tag-red'}">${esc(t.type)}</span> <span class="tag ${t.status==='进行中'?'tag-green':'tag-gray'}">${esc(t.status)}</span></div>
        <div class="lr-sub"><b>薄弱/方向：</b>${esc(t.reason)||'—'}</div>
        <div class="lr-sub"><b>计划：</b>${esc(t.plan)||'—'}</div>
        <div class="lr-sub">跟踪记录 ${t.records.length} 次</div>
      </div>
      <div class="lr-actions">
        <button class="btn btn-sm" onclick="addTutorRecord('${t.id}')">+ 跟踪记录</button>
        <button class="btn btn-sm" onclick="openTutor('${t.id}')">编辑</button>
        <button class="btn btn-sm" onclick="delTutor('${t.id}')">删除</button>
      </div></div>`).join('')
      || emptyState('还没有跟踪对象','为培优或补差学生建立跟踪档案，记录每次辅导进展。', '<button class="btn btn-primary" onclick="openTutor()">+ 培优补差</button>');
    main=`<div class="card card-tint-slate">${cardTitleIcon(ICO_GRAD,'培优补差跟踪（'+tuts.length+' 人）')}${rowsHtml}</div>`;
  }
  const headActions=`${_researchTab==='observe'?`<button class="btn btn-primary" onclick="openObserve()">+ 听课评课</button>`:`<button class="btn btn-primary" onclick="openTutor()">+ 培优补差</button>`}<button class="btn" onclick="researchExportWord()">导出Word</button>`;
  document.getElementById('page').innerHTML=
    wbHead('教研与跟踪','title-slate','听课评课记录 + 培优补差长期跟踪台账，沉淀教研过程，支撑薄弱生持续帮扶',headActions)+
    `${kpis}${seg}${main}`;
}
function openObserve(id){
  const isNew=!id; const o=isNew?null:DB.observes.find(x=>x.id===id);
  const dims=o?o.dims:{目标:'',内容:'',方法:'',效果:'',素养:''};
  const body=`<div class="form-grid">
   <div class="form-item"><label>日期</label><input id="ob_date" type="date" value="${o?o.date:today()}"></div>
   <div class="form-item"><label>听课人</label><input id="ob_observer" value="${o?esc(o.observer):esc(USERNAME||'')}" placeholder="如：李老师"></div>
   <div class="form-item"><label>授课教师</label><input id="ob_teacher" value="${o?esc(o.teacher):''}" placeholder="如：王老师"></div>
   <div class="form-item"><label>学科</label>${subSelectHtml(o?o.subject:'','ob_subject')}</div>
   <div class="form-item"><label>年级</label><select id="ob_grade">${optHtml(DB.meta.grades,o?o.grade:'','')}</select></div>
   <div class="form-item"><label>班级</label>${clsSelectHtml(o?o.cls:'','ob_cls','')}</div>
   <div class="form-item full"><label>课题</label><input id="ob_title" value="${o?esc(o.title):''}" placeholder="如：笔算乘法（不进位）"></div>
   <div class="form-item"><label>综合评分</label><input id="ob_score" type="number" value="${o?o.score:''}" placeholder="0-100" style="width:100px"></div>
   <div class="form-item" style="flex:2"><label>维度评价（目标/内容/方法/效果/素养）</label>
     <div style="display:flex;gap:6px;flex-wrap:wrap">
       ${['目标','内容','方法','效果','素养'].map(k=>`<input id="ob_dim_${k}" value="${esc(dims[k]||'')}" placeholder="${k}" style="flex:1;min-width:80px;padding:6px 8px;border:1px solid var(--line);border-radius:8px">`).join('')}
     </div></div>
   <div class="form-item full"><label>评课意见</label><textarea id="ob_comments" placeholder="课堂亮点、不足与改进">${o?esc(o.comments):''}</textarea></div>
   <div class="form-item full"><label>教学建议</label><textarea id="ob_suggestion" placeholder="可操作的具体建议">${o?esc(o.suggestion):''}</textarea></div>
  </div>`;
  openModal((isNew?'新增':'编辑')+'听课评课',body,
    `<button class="btn btn-primary" onclick="saveObserve('${isNew?'new':id}')">保存</button>
     <button class="btn" onclick="closeModal()">取消</button>`);
}
function saveObserve(id){
  const rec={date:fv('ob_date'),observer:fv('ob_observer'),teacher:fv('ob_teacher'),subject:fv('ob_subject'),grade:fv('ob_grade'),cls:fv('ob_cls'),title:fv('ob_title'),
    score:fv('ob_score')||0,dims:{目标:fv('ob_dim_目标'),内容:fv('ob_dim_内容'),方法:fv('ob_dim_方法'),效果:fv('ob_dim_效果'),素养:fv('ob_dim_素养')},
    comments:fv('ob_comments'),suggestion:fv('ob_suggestion')};
  if(id==='new'){rec.id=uid();DB.observes.push(rec);} else {Object.assign(DB.observes.find(x=>x.id===id),rec);}
  save(); closeModal(); renderResearch(); toast('已保存听课记录');
}
function delObserve(id){ if(!confirm('删除该听课记录？'))return; DB.observes=DB.observes.filter(o=>o.id!==id); save(); renderResearch(); }
function openTutor(id){
  const isNew=!id; const t=isNew?null:DB.tutors.find(x=>x.id===id);
  const body=`<div class="form-grid">
   <div class="form-item full"><label>学生</label><select id="tu_sid">${DB.students.map(s=>`<option value="${s.id}" ${t&&t.sid===s.id?'selected':''}>${esc(s.name)}（${esc(s.cls)}）</option>`).join('')}</select></div>
   <div class="form-item"><label>学科</label>${subSelectHtml(t?t.subject:'','tu_subject')}</div>
   <div class="form-item"><label>类型</label><select id="tu_type">${['培优','补差'].map(x=>`<option ${t&&t.type===x?'selected':''}>${x}</option>`).join('')}</select></div>
   <div class="form-item"><label>状态</label><select id="tu_status">${['进行中','已结束'].map(x=>`<option ${t&&t.status===x?'selected':''}>${x}</option>`).join('')}</select></div>
   <div class="form-item full"><label>薄弱点/培养方向</label><input id="tu_reason" value="${t?esc(t.reason):''}" placeholder="如：计算基础薄弱，进位易错"></div>
   <div class="form-item full"><label>辅导计划</label><textarea id="tu_plan" placeholder="如：每日5道进位竖式+错题回练">${t?esc(t.plan):''}</textarea></div>
  </div>`;
  openModal((isNew?'新增':'编辑')+'培优补差跟踪',body,
    `<button class="btn btn-primary" onclick="saveTutor('${isNew?'new':id}')">保存</button>
     <button class="btn" onclick="closeModal()">取消</button>`);
}
function saveTutor(id){
  const sid=fv('tu_sid'); const st=DB.students.find(s=>s.id===sid); if(!st){toast('请选择学生');return;}
  const rec={sid,name:st.name,cls:st.cls,subject:fv('tu_subject'),type:fv('tu_type'),status:fv('tu_status'),reason:fv('tu_reason'),plan:fv('tu_plan'),records:[]};
  if(id==='new'){rec.id=uid();DB.tutors.push(rec);} else {const o=DB.tutors.find(x=>x.id===id);rec.records=o.records||[];Object.assign(o,rec);}
  save(); closeModal(); renderResearch(); toast('已保存跟踪');
}
function delTutor(id){ if(!confirm('删除该跟踪记录？'))return; DB.tutors=DB.tutors.filter(t=>t.id!==id); save(); renderResearch(); }
function addTutorRecord(id){
  const t=DB.tutors.find(x=>x.id===id); if(!t)return;
  const body=`<div class="form-grid">
   <div class="form-item"><label>日期</label><input id="tr_date" type="date" value="${today()}"></div>
   <div class="form-item"><label>进展</label><input id="tr_progress" placeholder="如：有进步/持平" value="有进步"></div>
   <div class="form-item full"><label>本次跟踪内容</label><textarea id="tr_content" placeholder="如：完成进位竖式5道，正确4道"></textarea></div>
  </div>`;
  openModal('添加跟踪记录 · '+esc(t.name),body,
    `<button class="btn btn-primary" onclick="saveTutorRecord('${id}')">保存</button>
     <button class="btn" onclick="closeModal()">取消</button>`);
}
function saveTutorRecord(id){
  const t=DB.tutors.find(x=>x.id===id); if(!t)return;
  t.records=t.records||[];
  t.records.push({date:fv('tr_date'),content:fv('tr_content'),progress:fv('tr_progress')});
  if(t.status!=='进行中') t.status='进行中';
  save(); closeModal(); renderResearch(); toast('已添加跟踪记录');
}
function researchExportWord(){
  const obs=DB.observes.slice().sort((a,b)=>b.date.localeCompare(a.date))
    .map(o=>`<h2>${esc(o.title)} · ${esc(o.subject)} · ${esc(o.cls)}（评分 ${o.score}）</h2>
    <p>${o.date}　授课：${esc(o.teacher)}　听课：${esc(o.observer)}</p>
    <p><b>维度评价：</b>目标-${esc(o.dims.目标||'—')} / 内容-${esc(o.dims.内容||'—')} / 方法-${esc(o.dims.方法||'—')} / 效果-${esc(o.dims.效果||'—')} / 素养-${esc(o.dims.素养||'—')}</p>
    <p><b>评课意见：</b>${esc(o.comments)||'—'}</p><p><b>教学建议：</b>${esc(o.suggestion)||'—'}</p>`).join('');
  const tus=DB.tutors.map(t=>`<h2>${esc(t.name)} · ${esc(t.cls)} · ${esc(t.subject)}（${esc(t.type)}·${esc(t.status)}）</h2>
    <p><b>方向：</b>${esc(t.reason)||'—'}</p><p><b>计划：</b>${esc(t.plan)||'—'}</p>
    <p><b>跟踪记录：</b></p><ul>${(t.records||[]).map(r=>`<li>${r.date} ${esc(r.progress||'')}：${esc(r.content||'')}</li>`).join('')||'<li>暂无</li>'}</ul>`).join('');
  exportWordDoc('教研与跟踪_'+today(),'<h1>听课评课与培优补差台账</h1><h2>一、听课评课</h2>'+obs+'<h2>二、培优补差跟踪</h2>'+tus);
}

/* ==================== 成绩趋势对比 ==================== */
let _trendCls='', _trendSub='', _trendStu='';
function wbHead(title,colorCls,desc,actionsHtml=''){
  return `<div class="page-head"><div class="page-head-left"><div class="page-title ${colorCls}">${esc(title)}</div>${desc?`<div class="page-desc">${esc(desc)}</div>`:''}</div>${actionsHtml?`<div class="page-head-actions">${actionsHtml}</div>`:''}</div>`;
}
/* 卡片标题小图标（统一 16x16 线性 SVG，颜色随 .ct-ico 主题） */
function ctSvg(path){ return `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14">${path}</svg>`; }
const ICO_BULB=ctSvg('<path d="M9 18h6M10 21h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12 3a6 6 0 00-3.5 10.9c.5.4.8 1 .8 1.6V16h5.4v-.5c0-.6.3-1.2.8-1.6A6 6 0 0012 3z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>');
const ICO_CLIPBOARD=ctSvg('<rect x="5" y="4" width="14" height="17" rx="2.5" stroke="currentColor" stroke-width="1.8"/><path d="M9 4.5A1.5 1.5 0 0110.5 3h3A1.5 1.5 0 0115 4.5V6H9V4.5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 11h6M9 15h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>');
const ICO_BOOK=ctSvg('<path d="M4 19.2A2.2 2.2 0 016.2 17H20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M6.2 3H20v18H6.2A2.2 2.2 0 014 18.8V5.2A2.2 2.2 0 016.2 3z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 7.5h7M8 11h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>');
const ICO_GRAD=ctSvg('<path d="M12 4l9 4.5-9 4.5-9-4.5L12 4z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M6.5 10.8V15c0 1.7 2.5 3 5.5 3s5.5-1.3 5.5-3v-4.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M21 8.5v5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>');
const ICO_CHECK=ctSvg('<circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.8"/><path d="M8.2 12.3l2.6 2.6 5-5.4" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>');
const ICO_CHAT=ctSvg('<path d="M20 13.5c0 3-3.1 5.4-7 5.4-.9 0-1.7-.1-2.5-.3L5.5 20.5l.9-3.2C5 16.3 4 15 4 13.5 4 10.5 7.1 8 11 8s9 2.5 9 5.5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8.5 12.5h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>');
const ICO_ALERT=ctSvg('<path d="M12 4.2l8.4 15H3.6l8.4-15z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 10v4M12 16.8h.01" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>');
const ICO_FLAG=ctSvg('<path d="M6 3v18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M6 4.5h11l-2.2 3.6L17 11.7H6V4.5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>');
const ICO_BRIEFCASE=ctSvg('<rect x="3" y="7.5" width="18" height="12.5" rx="2.5" stroke="currentColor" stroke-width="1.8"/><path d="M9 7.5V6a2 2 0 012-2h2a2 2 0 012 2v1.5" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M3 12.5h18" stroke="currentColor" stroke-width="1.6"/>');
const ICO_CALENDAR=ctSvg('<rect x="3.5" y="5" width="17" height="15.5" rx="2.5" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 9.8h17" stroke="currentColor" stroke-width="1.6"/><path d="M8 3.5V6M16 3.5V6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M7.5 13h3M7.5 16.5h7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>');
const ICO_USER=ctSvg('<circle cx="12" cy="8" r="3.8" stroke="currentColor" stroke-width="1.8"/><path d="M4.8 20c.6-3.6 3.6-6 7.2-6s6.6 2.4 7.2 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>');
const ICO_USERS=ctSvg('<circle cx="9.5" cy="8.5" r="3.2" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 19.5c.5-3.1 3-5.2 6-5.2s5.5 2.1 6 5.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M16 5.6a3.2 3.2 0 010 6.2M17.5 14.6c2 .7 3.3 2.5 3.7 4.9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>');
const ICO_STAR=ctSvg('<path d="M12 4l2.5 5.1 5.6.8-4 3.9 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4-3.9 5.6-.8L12 4z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>');
const ICO_CHART=ctSvg('<path d="M4 20h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><rect x="6" y="11" width="3.2" height="6" rx="1.2" stroke="currentColor" stroke-width="1.8"/><rect x="11.4" y="7" width="3.2" height="10" rx="1.2" stroke="currentColor" stroke-width="1.8"/><rect x="16.8" y="13.5" width="3.2" height="3.5" rx="1.2" stroke="currentColor" stroke-width="1.8"/>');
function cardTitleIcon(icon,title){ return `<div class="card-title"><span class="ct-ico">${icon}</span><span>${esc(title)}</span></div>`; }
/* 通用空状态（飞书知识库风格：插画 + 标题 + 引导文案 + 快捷按钮） */
const ES_ICO=`<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect x="26" y="38" width="68" height="54" rx="12" fill="#eaf4fb" stroke="#bfe0f7" stroke-width="3"/>
<rect x="42" y="26" width="36" height="15" rx="7.5" fill="#d3e9fb" stroke="#bfe0f7" stroke-width="3"/>
<path d="M44 60h32M44 72h22" stroke="#9cc6ea" stroke-width="3.4" stroke-linecap="round"/>
<circle cx="86" cy="84" r="15" fill="#ffffff" stroke="#3f8fd6" stroke-width="3.4"/>
<path d="M86 78v12M80 84h12" stroke="#3f8fd6" stroke-width="3.4" stroke-linecap="round"/>
</svg>`;
function emptyState(title, desc, btnHtml){
  return `<div class="empty-state">
    <div class="es-ico">${ES_ICO}</div>
    <div class="es-title">${esc(title)}</div>
    ${desc?`<div class="es-desc">${esc(desc)}</div>`:''}
    ${btnHtml?`<div class="es-actions">${btnHtml}</div>`:''}
  </div>`;
}
function trChangeCls(el){ _trendCls=el.value; _trendStu=''; renderTrend(); }
function lineChartSVG(data, w, h){
  if(!data||!data.length) return '<div class="empty">暂无数据</div>';
  const vals=data.map(d=>d.value);
  let max=Math.max(...vals), min=Math.min(...vals);
  if(max===min){ max+=10; min=Math.max(0,min-10); }
  const padL=38,padR=14,padT=16,padB=30, cw=w-padL-padR, ch=h-padT-padB;
  const xs=data.map((d,i)=> padL + (data.length>1? i/(data.length-1):0.5)*cw);
  const yOf=v=> padT + ch - ((v-min)/(max-min))*ch;
  const pts=data.map((d,i)=>`${xs[i].toFixed(1)},${yOf(d.value).toFixed(1)}`).join(' ');
  const dots=data.map((d,i)=>`<circle cx="${xs[i].toFixed(1)}" cy="${yOf(d.value).toFixed(1)}" r="3.5" fill="#2f7d4f"><title>${esc(d.label)}: ${d.value}</title></circle>`).join('');
  const labels=data.map((d,i)=>`<text x="${xs[i].toFixed(1)}" y="${(h-8)}" font-size="10" text-anchor="middle" fill="#778">${esc(String(d.label).slice(0,6))}</text>`).join('');
  const gl=`${[0,0.5,1].map(t=>{const y=padT+ch-t*ch; const v=min+(max-min)*t; return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL+cw}" y2="${y.toFixed(1)}" stroke="#eef2f6"/><text x="${padL-5}" y="${(y+3).toFixed(1)}" font-size="9" text-anchor="end" fill="#aab">${Math.round(v)}</text>`;}).join('')}`;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px;height:auto;display:block">${gl}<polyline points="${pts}" fill="none" stroke="#2f7d4f" stroke-width="2"/>${dots}${labels}</svg>`;
}
function renderTrend(){
  ensureSchema();
  const clsOpts=clsSelectHtml(_trendCls,'tr_cls','请选择班级','','trChangeCls(this)');
  const stuOpts=_trendCls?`<option value="">全班（不分学生）</option>`+DB.students.filter(s=>s.cls===_trendCls).map(s=>`<option value="${s.id}" ${s.id===_trendStu?'selected':''}>${esc(s.name)}</option>`).join(''):'<option value="">请先选择班级</option>';
  let body=`<div class="card" style="margin-bottom:14px"><div class="form-grid">
    <div class="form-item"><label>班级</label>${clsOpts}</div>
    <div class="form-item"><label>学科</label>${subSelectHtml(_trendSub,'tr_sub','请选择学科','','_trendSub=this.value;renderTrend()')}</div>
    <div class="form-item"><label>学生（可选）</label><select id="tr_stu" onchange="_trendStu=this.value;renderTrend()">${stuOpts}</select></div>
  </div></div>`;
  if(!_trendCls||!_trendSub){
    body+=`<div class="card"><div class="empty">请先选择「班级」和「学科」，系统将自动调取该班级该学科的所有历次考试，绘制成绩趋势。</div></div>`;
    document.getElementById('page').innerHTML=wbHead('成绩趋势对比','title-green','选择班级与学科后，自动对比历次考试的班级平均分、学生个人进退步与偏科诊断')+body;
    return;
  }
  const exams=DB.exams.filter(e=>(!_trendCls||e.cls===_trendCls)&&(!_trendSub||e.subject===_trendSub)).sort((a,b)=>a.date.localeCompare(b.date));
  if(!exams.length){
    body+=`<div class="card"><div class="empty">该班级该学科暂无考试记录，请先在「成绩分析库」录入考试。</div></div>`;
    document.getElementById('page').innerHTML=wbHead('成绩趋势对比','title-green','选择班级与学科后，自动对比历次考试的班级平均分、学生个人进退步与偏科诊断')+body;
    return;
  }
  const clsData=exams.map(e=>({label:e.date.slice(5), value:+calcExam(e).avg}));
  body+=`<div class="card" style="margin-bottom:14px">
    <h4 style="margin:2px 0 10px">📈 班级平均分趋势（${esc(_trendCls)} · ${esc(_trendSub)}，共 ${exams.length} 场）</h4>
    ${lineChartSVG(clsData,640,220)}
    <div class="muted" style="margin-top:8px">历次平均分：</div>
    <div class="chips">${exams.map((e,i)=>`<span class="chip">${e.date.slice(5)} · ${clsData[i].value}</span>`).join('')}</div>
  </div>`;
  if(_trendStu){
    const st=DB.students.find(s=>s.id===_trendStu);
    const stuData=exams.map(e=>{ const r=e.records.find(x=>x.name===st.name); return r?{label:e.date.slice(5),value:+r.score||0}:null; }).filter(Boolean);
    body+=`<div class="card" style="margin-bottom:14px">
      <h4 style="margin:2px 0 10px">👤 ${esc(st.name)} 个人成绩趋势</h4>
      ${lineChartSVG(stuData,640,220)}
      ${trendStuProgress(exams,st.name)}
    </div>`;
    body+=biasDiagnose(st);
  } else {
    body+=trendClassProgress(exams);
  }
  document.getElementById('page').innerHTML=wbHead('成绩趋势对比','title-green','选择班级与学科后，自动对比历次考试的班级平均分、学生个人进退步与偏科诊断')+body;
}
function trendStuProgress(exams,stuName){
  if(exams.length<2) return '<div class="muted">需至少两场考试才能对比进退步。</div>';
  const a=exams[exams.length-2], b=exams[exams.length-1];
  const ra=a.records.find(r=>r.name===stuName), rb=b.records.find(r=>r.name===stuName);
  if(!ra||!rb) return '';
  const diff=+rb.score-+ra.score;
  return `<div class="muted" style="margin:10px 0 4px">最近两场对比（${a.date} → ${b.date}）：</div>
    <div class="alert ${diff>=0?'alert-ok':'alert-warn'}">${esc(stuName)} 由 ${ra.score} 分 ${diff>=0?'提升':'下降'}至 ${rb.score} 分（${diff>=0?'+':''}${diff} 分）</div>`;
}
function trendClassProgress(exams){
  if(exams.length<2) return '';
  const a=exams[exams.length-2], b=exams[exams.length-1];
  const names=new Set([...a.records.map(r=>r.name),...b.records.map(r=>r.name)]);
  let up=[],down=[];
  [...names].forEach(n=>{
    const ra=a.records.find(r=>r.name===n), rb=b.records.find(r=>r.name===n);
    if(ra&&rb){ const d=+rb.score-+ra.score; if(d>=5)up.push(n+'（+'+d+'）'); else if(d<=-5)down.push(n+'（'+d+'）'); }
  });
  return `<div class="card"><h4 style="margin:2px 0 10px">⚠️ 全班进退步预警（${a.date} → ${b.date}）</h4>
    <div class="grid2">
      <div><div class="muted">明显进步（≥5分）</div>${up.length?up.map(x=>`<span class="chip chip-green">${esc(x)}</span>`).join(' '):'<span class="muted">无</span>'}</div>
      <div><div class="muted">明显退步（≤-5分）</div>${down.length?down.map(x=>`<span class="chip chip-red">${esc(x)}</span>`).join(' '):'<span class="muted">无</span>'}</div>
    </div></div>`;
}
function biasDiagnose(st){
  const map={};
  DB.exams.forEach(e=>{ const r=e.records.find(x=>x.name===st.name); if(r){ if(!map[e.subject]||e.date>map[e.subject].date) map[e.subject]={date:e.date,score:+r.score,full:+e.full}; } });
  const arr=Object.entries(map).map(([sub,v])=>({sub,rate:v.score/v.full*100,score:v.score,full:v.full}));
  if(arr.length<2) return `<div class="card"><h4 style="margin:2px 0 10px">🧭 偏科诊断（${esc(st.name)}）</h4><div class="muted">该生至少需参加两个学科考试才能做偏科诊断。</div></div>`;
  arr.sort((a,b)=>b.rate-a.rate);
  const max=arr[0].rate, min=arr[arr.length-1].rate, gap=(max-min);
  const bars=arr.map(a=>`<div class="bar-row"><span class="bar-label">${esc(a.sub)}</span><span class="bar-track"><span class="bar-fill" style="width:${a.rate.toFixed(0)}%;background:${a.rate>=75?'#2e9e6b':a.rate>=60?'#e6a817':'#d9534f'}"></span></span><span class="bar-val">${a.score}/${a.full}</span></div>`).join('');
  return `<div class="card"><h4 style="margin:2px 0 10px">🧭 偏科诊断（${esc(st.name)}）</h4>${bars}
    <div class="alert ${gap>=20?'alert-warn':'alert-ok'}">最高 ${esc(arr[0].sub)}（${max.toFixed(0)}%），最低 ${esc(arr[arr.length-1].sub)}（${min.toFixed(0)}%），落差 ${gap.toFixed(0)}%。${gap>=20?'建议重点补强 '+esc(arr[arr.length-1].sub)+'。':'各学科发展较均衡。'}</div></div>`;
}

/* ==================== 课表与教学计划 ==================== */
const TT_WEEK=[['周一',1],['周二',2],['周三',3],['周四',4],['周五',5],['周六',6],['周日',7]];
const TT_TIMES={0:['早读','07:30-08:00','reading'],1:['第1节','08:00-08:45','morning'],2:['第2节','08:55-09:40','morning'],3:['第3节','10:00-10:45','morning'],4:['第4节','10:55-11:40','morning'],5:['第5节','14:00-14:45','afternoon'],6:['第6节','14:55-15:40','afternoon'],7:['第7节','16:00-16:45','afternoon'],8:['第8节','16:55-17:40','afternoon']};
function ttTimeOf(p){ return TT_TIMES[p] || ['第'+p+'节','','normal']; }
function subjColor(s){ const map={'语文':'#fef3c2','数学':'#dbeafe','英语':'#fce7f3','物理':'#d1fae5','化学':'#e9d5ff','体育':'#fed7aa','音乐':'#e0f2fe','美术':'#fde68a','科学':'#ccfbf1','道德与法治':'#f3e8ff','历史':'#fee2e2','地理':'#dcfce7','生物':'#cffafe','信息技术':'#e2e8f0','自习':'#f8fafc'}; return map[s]||'#f1f5f9'; }
let _ttCls='';
function ttPeriods(){
  ensureSchema();
  if(!Array.isArray(DB.meta.ttPeriods)||!DB.meta.ttPeriods.length) DB.meta.ttPeriods=[1,2,3,4,5,6,7,8];
  return DB.meta.ttPeriods;
}
function ttChangeCls(el){ _ttCls=el.value; renderTimetable(); }
function renderTimetable(){
  ensureSchema();
  const periods=ttPeriods();
  const clsOpts=clsSelectHtml(_ttCls,'tt_cls','请选择班级','','ttChangeCls(this)');
  const headActions=`<button class="btn" onclick="document.getElementById('tt_ocr_file').click()" title="上传课表图片自动识别">📷 图片识别</button><button class="btn" onclick="ttConflictCheck()" title="检查排课冲突与空课">🔍 课表检查</button>`;
  let body=`<div class="filter-bar">${clsOpts}</div>`;
  if(!_ttCls){
    body+=`<div class="card"><div class="empty">请选择班级，查看/编辑该班周课表与教学进度。</div></div>`;
    document.getElementById('page').innerHTML=wbHead('课表与教学计划','title-cyan','可视化周课表 + 教学进度跟踪，按班级维护',headActions)+body;
    return;
  }
  let rows='';
  periods.forEach(p=>{
    const [plabel,ptime,ptype]=ttTimeOf(p);
    let cells=`<td class="tt-period tt-period-${ptype}"><div class="tt-plabel">${esc(plabel)}</div>${ptime?`<div class="tt-ptime">${esc(ptime)}</div>`:''}</td>`;
    TT_WEEK.forEach(([label,day])=>{
      const c=DB.timetables.find(t=>t.cls===_ttCls&&t.day===day&&t.period===p);
      if(c){
        const bg=subjColor(c.subject);
        cells+=`<td class="tt-cell tt-has" style="background:${bg}" onclick="ttEdit(${day},${p})"><span class="tt-bar" style="background:${bg}"></span><div class="tt-sub">${esc(c.subject)}</div><div class="tt-meta">${esc(c.teacher||'')}${c.room?' · '+esc(c.room):''}</div></td>`;
      } else {
        cells+=`<td class="tt-cell tt-empty" onclick="ttEdit(${day},${p})"><span class="tt-add">+</span></td>`;
      }
    });
    rows+=`<tr>${cells}</tr>`;
  });
  body+=`<div class="card tt-card" style="margin-bottom:14px">
    <div class="tt-head">
      <div class="tt-title"><span class="tt-ico">${ICO_CALENDAR}</span><div><h4>${esc(_ttCls)} 周课表</h4><span class="muted">点击任意格子编辑，支持自定义节数</span></div></div>
      <div class="tt-ops">
        <button class="btn btn-sm" onclick="ttDelPeriod()" title="减少最后一节">− 减少节数</button>
        <button class="btn btn-sm btn-primary" onclick="ttAddPeriod()" title="增加一节">+ 增加节数</button>
      </div>
    </div>
    <div class="tbl-wrap"><table class="tbl tt-tbl"><thead><tr><th class="tt-period-head">节次</th>${TT_WEEK.map(([l])=>`<th>${l}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
  </div>`;
  const plans=DB.plans.filter(p=>p.cls===_ttCls).sort((a,b)=>b.date.localeCompare(a.date));
  body+=`<div class="card"><div class="tt-head"><h4 style="margin:2px 0">📋 教学进度跟踪</h4><button class="btn btn-sm btn-primary" onclick="planAdd()">+ 新增进度</button></div>
    ${plans.length?`<div>${plans.map(p=>`<div class="list-row"><div class="lr-main"><b>${esc(p.content)}</b><span class="muted">${esc(p.subject||'')}${p.date?' · '+p.date:''} · 进度 ${esc(p.progress||'—')}</span></div><div class="lr-ops"><button class="btn btn-sm" onclick="planEdit('${p.id}')">编辑</button><button class="btn btn-sm btn-danger" onclick="planDel('${p.id}')">删</button></div></div>`).join('')}</div>`:'<div class="empty">暂无教学进度记录</div>'}
  </div>`;
  document.getElementById('page').innerHTML=wbHead('课表与教学计划','title-cyan','可视化周课表 + 教学进度跟踪，按班级维护')+body;
}
function ttEdit(day,period){
  const c=DB.timetables.find(t=>t.cls===_ttCls&&t.day===day&&t.period===period);
  const body=`<div class="form-grid">
    <div class="form-item"><label>学科</label><input id="tt_subject" value="${c?esc(c.subject):''}" placeholder="如：数学"></div>
    <div class="form-item"><label>教师</label><input id="tt_teacher" value="${c?esc(c.teacher):''}" placeholder="任课教师"></div>
    <div class="form-item"><label>教室</label><input id="tt_room" value="${c?esc(c.room):''}" placeholder="如：301"></div>
    <div class="form-item"><label>备注</label><input id="tt_note" value="${c?esc(c.note):''}" placeholder="选填"></div>
  </div>`;
  openModal('编辑课表 · 第'+period+'节',body,
    `<button class="btn" onclick="closeModal()">取消</button>${c?`<button class="btn btn-danger" onclick="ttDelete(${day},${period})">删除</button>`:''}<button class="btn btn-primary" onclick="ttSave(${day},${period})">保存</button>`);
}
function ttSave(day,period){
  const subject=fv('tt_subject'); if(!subject){toast('请填写学科');return;}
  let c=DB.timetables.find(t=>t.cls===_ttCls&&t.day===day&&t.period===period);
  if(c){ c.subject=subject; c.teacher=fv('tt_teacher'); c.room=fv('tt_room'); c.note=fv('tt_note'); }
  else DB.timetables.push({id:uid(),cls:_ttCls,day,period,subject,teacher:fv('tt_teacher'),room:fv('tt_room'),note:fv('tt_note')});
  save(); closeModal(); renderTimetable(); toast('已保存');
}
function ttDelete(day,period){
  if(!confirm('删除该课表项？'))return;
  DB.timetables=DB.timetables.filter(t=>!(t.cls===_ttCls&&t.day===day&&t.period===period));
  save(); closeModal(); renderTimetable(); toast('已删除');
}
function planAdd(){ planEdit('new'); }
function planEdit(id){
  const isNew=!id||id==='new'; const p=isNew?null:DB.plans.find(x=>x.id===id);
  const body=`<div class="form-grid">
    <div class="form-item"><label>学科</label>${subSelectHtml(p?p.subject:'','pl_subject')}</div>
    <div class="form-item"><label>日期</label><input id="pl_date" type="date" value="${p?p.date:today()}"></div>
    <div class="form-item full"><label>本周教学内容</label><input id="pl_content" value="${p?esc(p.content):''}" placeholder="如：第三单元《小数乘法》例1-例3"></div>
    <div class="form-item"><label>完成进度</label><input id="pl_progress" value="${p?esc(p.progress):''}" placeholder="如：已完成80%"></div>
    <div class="form-item full"><label>备注</label><input id="pl_note" value="${p?esc(p.note):''}" placeholder="选填"></div>
  </div>`;
  openModal((isNew?'新增':'编辑')+'教学进度 · '+esc(_ttCls),body,
    `<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="planSave('${isNew?'new':id}')">保存</button>`);
}
function planSave(id){
  const content=fv('pl_content'); if(!content){toast('请填写教学内容');return;}
  const rec={cls:_ttCls,subject:fv('pl_subject'),date:fv('pl_date'),content,progress:fv('pl_progress'),note:fv('pl_note')};
  if(id==='new'){rec.id=uid();DB.plans.push(rec);} else Object.assign(DB.plans.find(x=>x.id===id),rec);
  save(); closeModal(); renderTimetable(); toast('已保存');
}
function planDel(id){ if(!confirm('删除该进度记录？'))return; DB.plans=DB.plans.filter(p=>p.id!==id); save(); renderTimetable(); }
function ttAddPeriod(){
  const periods=ttPeriods();
  if(periods.length>=16){toast('最多支持 16 节课');return;}
  const next=(periods[periods.length-1]||0)+1;
  DB.meta.ttPeriods.push(next);
  save(); renderTimetable(); toast('已增加至 '+next+' 节');
}
function ttDelPeriod(){
  const periods=ttPeriods();
  if(periods.length<=1){toast('至少保留 1 节课');return;}
  const last=periods[periods.length-1];
  const has=DB.timetables.some(t=>t.cls===_ttCls&&t.period===last);
  if(has && !confirm(`第 ${last} 节已有课程安排，删除节数将同时清空这些课程，确认？`)) return;
  DB.meta.ttPeriods.pop();
  DB.timetables=DB.timetables.filter(t=>!(t.cls===_ttCls&&t.period===last));
  save(); renderTimetable(); toast('已减少至 '+DB.meta.ttPeriods.length+' 节');
}
function ttConflictCheck(){
  if(!_ttCls){toast('请先选择班级');return;}
  const periods=ttPeriods();
  const clsTT=DB.timetables.filter(t=>t.cls===_ttCls);
  const total=periods.length*TT_WEEK.length;
  const empty=total-clsTT.length;
  const known=subjectList();
  const unknown=[...new Set(clsTT.map(t=>t.subject).filter(s=>!known.includes(s)))];
  const bySlot={};
  DB.timetables.forEach(t=>{ if(!t.teacher) return; const k=t.day+'-'+t.period; (bySlot[k]=bySlot[k]||[]).push(t); });
  const conflicts=[];
  Object.keys(bySlot).forEach(k=>{
    const map={};
    bySlot[k].forEach(t=>{ (map[t.teacher]=map[t.teacher]||[]).push(t.cls); });
    Object.keys(map).forEach(te=>{ if(map[te].length>1) conflicts.push({te,slot:k,cls:map[te]}); });
  });
  const body=`<div class="card-title">${esc(_ttCls)} 课表检查</div>
    <div class="lr-sub">总课时：${total} 节　已排：${clsTT.length} 节　<b style="color:${empty?'#e11d48':'#1e7e4a'}">空课：${empty} 节</b></div>
    ${unknown.length?`<div class="lr-sub" style="color:#d97706">学科库未收录：${esc(unknown.join('、'))}（建议在学科下拉中新增）</div>`:'<div class="lr-sub" style="color:#1e7e4a">✓ 所有学科均在学科库中</div>'}
    <div class="fsb-section-head" style="margin-top:12px"><span class="fsb-dot fsb-dot-red"></span><h4>教师跨班冲突（${conflicts.length}）</h4></div>
    ${conflicts.length?conflicts.map(c=>`<div class="lr-sub">第 ${c.slot.split('-')[1]} 节 · 教师 ${esc(c.te)} 同时出现在：${esc(c.cls.join('、'))}</div>`).join(''):'<div class="empty">✓ 未发现教师冲突</div>'}
  `;
  openModal('课表匹配检查',body,`<button class="btn" onclick="closeModal()">关闭</button>`);
}
let _ttOcrText='';
function ttOcrUpload(input){
  const file=input.files[0]; if(!file) return;
  if(!_ttCls){ toast('请先选择班级'); input.value=''; return; }
  toast('正在识别图片，请稍候…');
  runOCR(file).then(text=>{
    input.value='';
    _ttOcrText=text||'';
    if(!_ttOcrText){ toast('未识别到文字，请尝试更清晰的手写/打印课表图片'); return; }
    const parsed=ttOcrParse(_ttOcrText);
    const body=`<div class="form-item full"><label>识别原文（可手动修正后重新解析）</label><textarea id="tt_ocr_text" rows="8" style="font-family:monospace;font-size:12px">${esc(_ttOcrText)}</textarea></div>
      <div class="form-item full"><label>解析结果预览（共 ${parsed.length} 条）</label><div id="tt_ocr_preview" style="max-height:180px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:10px;background:#fbfdff;font-size:13px">
        ${parsed.length?parsed.map(r=>`<div style="padding:3px 0">周${['','一','二','三','四','五','六','日'][r.day]} · 第${r.period}节 · ${esc(r.subject)}${r.teacher?' · '+esc(r.teacher):''}</div>`).join(''):'<div class="empty-mini">未解析出有效课程，请检查原文或手动填写。</div>'}
      </div></div>
      <div class="filter-bar" style="margin-top:10px">
        <button class="btn" onclick="ttOcrReparse()">重新解析</button>
        <button class="btn btn-primary" onclick="ttOcrApply()" ${parsed.length?'':'disabled'}>一键填入课表</button>
      </div>`;
    openModal('课表图片识别 · '+esc(_ttCls), body, `<button class="btn" onclick="closeModal()">关闭</button>`);
  });
}
function ttOcrParse(text){
  const lines=(text||'').split(/\n/).map(s=>s.trim()).filter(Boolean);
  const dayMap={'周一':1,'周二':2,'周三':3,'周四':4,'周五':5,'周六':6,'周日':7,'星期一':1,'星期二':2,'星期三':3,'星期四':4,'星期五':5,'星期六':6,'星期日':7,'1':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7};
  const subs=subjectList();
  const res=[];
  lines.forEach(line=>{
    const dayMatch=Object.keys(dayMap).find(d=>line.includes(d));
    const periodMatch=line.match(/第\s*(\d+)\s*节/);
    const subject=subs.find(s=>line.includes(s));
    if(dayMatch && periodMatch && subject){
      res.push({day:dayMap[dayMatch],period:+periodMatch[1],subject});
    }
  });
  return res;
}
function ttOcrReparse(){ _ttOcrText=fv('tt_ocr_text'); const parsed=ttOcrParse(_ttOcrText); ttOcrUpdatePreview(parsed); }
function ttOcrUpdatePreview(parsed){
  const el=document.getElementById('tt_ocr_preview');
  if(!el) return;
  el.innerHTML=parsed.length?parsed.map(r=>`<div style="padding:3px 0">周${['','一','二','三','四','五','六','日'][r.day]} · 第${r.period}节 · ${esc(r.subject)}${r.teacher?' · '+esc(r.teacher):''}</div>`).join(''):'<div class="empty-mini">未解析出有效课程，请检查原文或手动填写。</div>';
  const btn=document.querySelector('[onclick="ttOcrApply()"]'); if(btn) btn.disabled=!parsed.length;
}
function ttOcrApply(){
  const parsed=ttOcrParse(fv('tt_ocr_text'));
  if(!parsed.length){ toast('没有可填入的课程'); return; }
  if(!confirm(`将识别出的 ${parsed.length} 条课程填入「${_ttCls}」课表，重复格子会覆盖，确认？`)) return;
  parsed.forEach(r=>{
    let c=DB.timetables.find(t=>t.cls===_ttCls&&t.day===r.day&&t.period===r.period);
    if(c) c.subject=r.subject;
    else DB.timetables.push({id:uid(),cls:_ttCls,day:r.day,period:r.period,subject:r.subject,teacher:'',room:'',note:''});
    if(!DB.meta.subjects.includes(r.subject)) subjectAdd(r.subject);
  });
  const maxPeriod=Math.max(...parsed.map(r=>r.period), ttPeriods().length);
  if(maxPeriod>ttPeriods().length){
    const cur=ttPeriods();
    for(let i=cur.length+1;i<=maxPeriod;i++) DB.meta.ttPeriods.push(i);
  }
  save(); closeModal(); renderTimetable(); toast('已填入 '+parsed.length+' 条课程');
}

/* ==================== 学生成长档案 ==================== */
const GROWTH_TYPES=['操行评定','获奖荣誉','奖惩记录','成长记录','综合素质','其他'];
let _growthCls='', _growthSid='';
function grChangeCls(el){ _growthCls=el.value; _growthSid=''; renderGrowth(); }
let _growthTab='growth';
let _gsSubj='';
function renderGrowth(){
  ensureSchema();
  const clsOpts=clsSelectHtml(_growthCls,'gr_cls','请选择班级','','grChangeCls(this)');
  const classStus=_growthCls?DB.students.filter(s=>s.cls===_growthCls):[];
  const stuOpts=_growthCls
    ? `<option value="">请选择学生（${classStus.length}人）</option>`+classStus.map(s=>`<option value="${s.id}" ${s.id===_growthSid?'selected':''}>${esc(s.name)}</option>`).join('')
    : '<option value="">请先选择班级</option>';
  let body=`<div class="card" style="margin-bottom:14px"><div class="form-grid">
    <div class="form-item"><label>班级</label>${clsOpts}</div>
    <div class="form-item"><label>学生</label><select id="gr_stu" onchange="_growthSid=this.value;renderGrowth()">${stuOpts}</select></div>
  </div>`;
  if(_growthCls && !classStus.length){
    body+=`<div class="alert alert-warn" style="margin-top:12px;margin-bottom:0">该班级暂无学生，请先到「学生与班级管理」添加学生，或 <button class="btn btn-sm btn-primary" onclick="nav('students');setTimeout(stuAdd,50)">+ 新增学生</button></div></div>`;
    document.getElementById('page').innerHTML=wbHead('学生成长档案','title-teal','学生综合素质与成长轨迹，满足过程性评价与家校沟通需要','')+body;
    return;
  }
  body+=`</div>`;
  if(!_growthSid){
    body+=`<div class="card">${emptyState('选择一名学生','在上方选择班级与学生，即可查看其完整成长档案：学籍、家长、评价、成绩与成长轨迹。')}</div>`;
    document.getElementById('page').innerHTML=wbHead('学生成长档案','title-teal','学生综合素质与成长轨迹，满足过程性评价与家校沟通需要','')+body;
    return;
  }
  const st=DB.students.find(s=>s.id===_growthSid);
  if(!st){ _growthSid=''; renderGrowth(); return; }
  const items=DB.growth.filter(g=>g.sid===_growthSid).sort((a,b)=>b.date.localeCompare(a.date));
  const award=items.filter(g=>g.type==='获奖荣誉').length;
  const punish=items.filter(g=>g.type==='奖惩记录'&&/惩|批评|警告|处分/.test(g.title+g.content)).length;
  const conduct=items.filter(g=>g.type==='操行评定')[0];
  const exs=DB.exams.filter(e=>e.records.some(r=>r.name===st.name));
  const headActions=`<button class="btn btn-primary" onclick="growthAdd()">+ 新增记录</button><button class="btn" onclick="growthBatchAdd()">+ 批量记录</button><button class="btn" onclick="growthExportWord('${st.id}')">导出Word</button>`;
  // 顶部学生信息卡片
  body+=`<div class="card" style="margin-bottom:14px"><div class="stu-head">
    <div class="stu-avatar">${esc((st.name||'').slice(0,1))}</div>
    <div class="stu-info"><div class="stu-name">${esc(st.name)}</div><div class="muted">${esc(st.cls)} · ${esc(st.grade||'—')}${st.tags&&st.tags.length?' · '+st.tags.map(t=>esc(t)).join('/') : ''}</div></div>
    <div class="stu-stat"><span><b>${items.length}</b>记录</span><span><b>${award}</b>获奖</span><span><b>${punish}</b>惩戒</span><span><b>${exs.length}</b>考试</span></div>
  </div>${conduct?`<div class="alert alert-ok">最近操行评定（${conduct.date}）：${esc(conduct.content||conduct.title)}</div>`:''}</div>`;
  // 整页聚合大卡片
  body+=`<div class="growth-page card-tint-green">`;
  body+=growthProfileSection(st);
  body+=growthParentsSection(st);
  body+=growthEvalSection(st);
  body+=growthScoresSection(st);
  body+=growthTimelineSection(st, items);
  body+=`</div>`;
  document.getElementById('page').innerHTML=wbHead('学生成长档案','title-teal','学生综合素质与成长轨迹，满足过程性评价与家校沟通需要',headActions)+body;
}
function growthAdd(){ growthEdit('new'); }
function growthEdit(id){
  const isNew=!id||id==='new'; const g=isNew?null:DB.growth.find(x=>x.id===id);
  const body=`<div class="form-grid">
    <div class="form-item"><label>类型</label><select id="gr_type">${GROWTH_TYPES.map(t=>`<option ${g&&g.type===t?'selected':''}>${t}</option>`).join('')}</select></div>
    <div class="form-item"><label>日期</label><input id="gr_date" type="date" value="${g?g.date:today()}"></div>
    <div class="form-item full"><label>标题</label><input id="gr_title" value="${g?esc(g.title):''}" placeholder="如：校级三好学生 / 单元测满分"></div>
    <div class="form-item"><label>等级/分值</label><input id="gr_score" value="${g&&g.score!=null?esc(g.score):''}" placeholder="选填，如：优/A/95"></div>
    <div class="form-item full"><label>详情</label><textarea id="gr_content" placeholder="记录具体事迹或评价">${g?esc(g.content):''}</textarea></div>
  </div>`;
  openModal((isNew?'新增':'编辑')+'成长档案 · '+esc((DB.students.find(s=>s.id===_growthSid)||{}).name||''),body,
    `<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="growthSave('${isNew?'new':id}')">保存</button>`);
}
function growthSave(id){
  const title=fv('gr_title'); if(!title){toast('请填写标题');return;}
  const st=DB.students.find(s=>s.id===_growthSid);
  const rec={sid:_growthSid,name:st.name,cls:st.cls,type:fv('gr_type'),date:fv('gr_date'),title,score:fv('gr_score'),content:fv('gr_content')};
  if(id==='new'){rec.id=uid();DB.growth.push(rec);} else Object.assign(DB.growth.find(x=>x.id===id),rec);
  save(); closeModal(); renderGrowth(); toast('已保存');
}
function growthDel(id){ if(!confirm('删除该档案记录？'))return; DB.growth=DB.growth.filter(g=>g.id!==id); save(); renderGrowth(); }
function growthBatchAdd(){
  if(!_growthCls){ toast('请先选择班级'); return; }
  const list=DB.students.filter(s=>s.cls===_growthCls);
  if(!list.length){ toast('该班级暂无学生'); return; }
  const body=`<div class="form-grid">
    <div class="form-item"><label>类型</label><select id="grb_type">${GROWTH_TYPES.map(t=>`<option>${t}</option>`).join('')}</select></div>
    <div class="form-item"><label>日期</label><input id="grb_date" type="date" value="${today()}"></div>
    <div class="form-item full"><label>标题</label><input id="grb_title" placeholder="如：校级三好学生 / 期中操行评定"></div>
    <div class="form-item"><label>等级/分值</label><input id="grb_score" placeholder="选填，如：优/A/95"></div>
    <div class="form-item full"><label>详情</label><textarea id="grb_content" placeholder="记录具体事迹或评价"></textarea></div>
    <div class="form-item full"><label>应用学生（勾选）</label><div style="max-height:180px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:10px;background:#fbfdff">
      ${list.map(s=>`<label style="display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer"><input type="checkbox" class="grb-sid" value="${s.id}" checked style="width:16px;height:16px">${esc(s.name)}</label>`).join('')}
    </div></div>
  </div>`;
  openModal('批量新增成长档案 · '+esc(_growthCls), body,
    `<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="growthBatchSave()">保存</button>`);
}
function growthBatchSave(){
  const title=fv('grb_title'); if(!title){toast('请填写标题');return;}
  const sids=Array.from(document.querySelectorAll('.grb-sid:checked')).map(cb=>cb.value);
  if(!sids.length){toast('请至少选择一名学生');return;}
  const type=fv('grb_type'), date=fv('grb_date'), score=fv('grb_score'), content=fv('grb_content');
  let ok=0;
  sids.forEach(sid=>{
    const st=DB.students.find(s=>s.id===sid); if(!st) return;
    DB.growth.push({id:uid(),sid,name:st.name,cls:st.cls,type,date,title,score,content});
    ok++;
  });
  save(); closeModal(); renderGrowth(); toast('已为 '+ok+' 名学生新增记录');
}

/* 成长档案：整页聚合分区 */
function growthProfileSection(st){
  const p=st.profile||{};
  const fields=[
    ['学号',esc(p.stuNo||'—')],['出生日期',esc(p.birth||'—')],['民族',esc(p.nation||'—')],['政治面貌',esc(p.politics||'—')],
    ['就读状态',esc(p.status||'—')],['寄宿/走读',esc(p.boarding||'—')],['毕业小学',esc(p.gradSchool||'—')],['入学时间',esc(p.enroll||'—')],['学籍状态',esc(p.eduStatus||'—')]
  ];
  return `<div class="growth-section">
    <div class="growth-sec-head">${cardTitleIcon(ICO_USER,'学籍信息')}<button class="btn btn-sm" onclick="growthProfileEdit('${st.id}')">编辑</button></div>
    <div class="growth-info-grid">${fields.map(f=>`<div class="growth-info-item"><span class="muted">${f[0]}</span><b>${f[1]}</b></div>`).join('')}</div>
  </div>`;
}
function growthProfileEdit(id){
  const st=DB.students.find(s=>s.id===id); if(!st)return; const p=st.profile||{};
  const body=`<div class="form-grid">
    <div class="form-item"><label>学号</label><input id="gp_stuno" value="${esc(p.stuNo||'')}"></div>
    <div class="form-item"><label>出生日期</label><input id="gp_birth" type="date" value="${esc(p.birth||'')}"></div>
    <div class="form-item"><label>民族</label><input id="gp_nation" value="${esc(p.nation||'')}"></div>
    <div class="form-item"><label>政治面貌</label><input id="gp_politics" value="${esc(p.politics||'')}"></div>
    <div class="form-item"><label>就读状态</label><input id="gp_status" value="${esc(p.status||'')}"></div>
    <div class="form-item"><label>寄宿/走读</label><select id="gp_boarding">${['走读','寄宿'].map(x=>`<option ${p.boarding===x?'selected':''}>${x}</option>`).join('')}</select></div>
    <div class="form-item"><label>毕业小学</label><input id="gp_grad" value="${esc(p.gradSchool||'')}"></div>
    <div class="form-item"><label>入学时间</label><input id="gp_enroll" type="date" value="${esc(p.enroll||'')}"></div>
    <div class="form-item full"><label>学籍状态</label><input id="gp_edu" value="${esc(p.eduStatus||'')}"></div>
  </div>`;
  openModal('编辑学籍信息',body,`<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="growthProfileSave('${st.id}')">保存</button>`);
}
function growthProfileSave(id){
  const st=DB.students.find(s=>s.id===id); if(!st)return; st.profile=st.profile||{};
  Object.assign(st.profile,{stuNo:fv('gp_stuno'),birth:fv('gp_birth'),nation:fv('gp_nation'),politics:fv('gp_politics'),status:fv('gp_status'),boarding:fv('gp_boarding'),gradSchool:fv('gp_grad'),enroll:fv('gp_enroll'),eduStatus:fv('gp_edu')});
  save(); closeModal(); renderGrowth(); toast('学籍信息已保存');
}
function growthParentsSection(st){
  const ps=st.parents||[];
  const rows=ps.length?ps.map((p,i)=>`<div class="list-row"><div class="lr-main">
    <div class="lr-title">${esc(p.name||'')} · ${esc(p.relation||'')} <span class="tag tag-violet">${esc(p.comm||'')}</span></div>
    <div class="lr-sub">电话：${esc(p.phone||'—')}　职业：${esc(p.career||'—')}</div>
  </div><div class="lr-actions">
    <button class="btn btn-sm" onclick="parentEdit('${st.id}',${i})">编辑</button>
    <button class="btn btn-sm btn-danger" onclick="parentDel('${st.id}',${i})">删除</button>
  </div></div>`).join(''):'<div class="empty">暂无家长信息</div>';
  return `<div class="growth-section">
    <div class="growth-sec-head">${cardTitleIcon(ICO_USERS,'家长信息')}<button class="btn btn-sm btn-primary" onclick="parentEdit('${st.id}',-1)">+ 添加家长</button></div>
    ${rows}
  </div>`;
}
function parentEdit(sid,i){
  const st=DB.students.find(s=>s.id===sid); st.parents=st.parents||[];
  const p=i>=0?st.parents[i]:null;
  const body=`<div class="form-grid">
    <div class="form-item"><label>姓名</label><input id="pp_name" value="${p?esc(p.name):''}"></div>
    <div class="form-item"><label>关系</label><input id="pp_rel" value="${p?esc(p.relation):''}" placeholder="如：父亲/母亲/监护人"></div>
    <div class="form-item"><label>电话</label><input id="pp_phone" value="${p?esc(p.phone):''}"></div>
    <div class="form-item"><label>职业</label><input id="pp_career" value="${p?esc(p.career):''}"></div>
    <div class="form-item full"><label>沟通状态</label><input id="pp_comm" value="${p?esc(p.comm):''}" placeholder="如：配合/积极/一般"></div>
  </div>`;
  openModal((p?'编辑':'添加')+'家长',body,`<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="parentSave('${sid}',${i})">保存</button>`);
}
function parentSave(sid,i){
  const st=DB.students.find(s=>s.id===sid); st.parents=st.parents||[];
  const rec={name:fv('pp_name'),relation:fv('pp_rel'),phone:fv('pp_phone'),career:fv('pp_career'),comm:fv('pp_comm')};
  if(!rec.name){toast('请填写家长姓名');return;}
  if(i>=0) st.parents[i]=rec; else st.parents.push(rec);
  save(); closeModal(); renderGrowth(); toast('已保存');
}
function parentDel(sid,i){ if(!confirm('删除该家长信息？'))return; const st=DB.students.find(s=>s.id===sid); st.parents.splice(i,1); save(); renderGrowth(); }
function growthEvalSection(st){
  const e=st.eval||{};
  const fields=[['素质评级',esc(e.quality||'—')],['获奖情况',esc(e.award||'—')],['纪律表现',esc(e.discipline||'—')],['帮扶措施',esc(e.help||'—')]];
  return `<div class="growth-section">
    <div class="growth-sec-head">${cardTitleIcon(ICO_STAR,'综合评价')}<button class="btn btn-sm" onclick="growthEvalEdit('${st.id}')">编辑</button></div>
    <div class="growth-info-grid">${fields.map(f=>`<div class="growth-info-item full"><span class="muted">${f[0]}</span><b>${f[1]}</b></div>`).join('')}</div>
  </div>`;
}
function growthEvalEdit(id){
  const st=DB.students.find(s=>s.id===id); if(!st)return; const e=st.eval||{};
  const body=`<div class="form-grid">
    <div class="form-item"><label>素质评级</label><select id="ge_quality">${DB.meta.qualityLevels.map(x=>`<option ${e.quality===x?'selected':''}>${x}</option>`).join('')}</select></div>
    <div class="form-item"><label>获奖情况</label><input id="ge_award" value="${esc(e.award||'')}"></div>
    <div class="form-item full"><label>纪律表现</label><input id="ge_disc" value="${esc(e.discipline||'')}"></div>
    <div class="form-item full"><label>帮扶措施</label><textarea id="ge_help" placeholder="如：每日基础打卡、课后辅导">${esc(e.help||'')}</textarea></div>
  </div>`;
  openModal('编辑综合评价',body,`<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="growthEvalSave('${st.id}')">保存</button>`);
}
function growthEvalSave(id){
  const st=DB.students.find(s=>s.id===id); if(!st)return; st.eval=st.eval||{};
  Object.assign(st.eval,{quality:fv('ge_quality'),award:fv('ge_award'),discipline:fv('ge_disc'),help:fv('ge_help')});
  save(); closeModal(); renderGrowth(); toast('综合评价已保存');
}
function growthScoresSection(st){
  let exs=DB.exams.filter(e=>e.records.some(r=>r.name===st.name));
  if(_gsSubj) exs=exs.filter(e=>e.subject===_gsSubj);
  exs.sort((a,b)=>b.date.localeCompare(a.date));
  const sb=subSelectHtml(_gsSubj,'gs_subj','全部学科','','_gsSubj=this.value;renderGrowth()');
  const rows=exs.map(e=>{
    const r=e.records.find(x=>x.name===st.name); if(!r) return '';
    const avg=Math.round(e.records.reduce((s,x)=>s+(+x.score||0),0)/Math.max(1,e.records.length));
    return `<tr><td>${esc(e.name)}</td><td>${esc(e.subject)}</td><td>${esc(e.cls)}</td><td><b>${r.score}</b></td><td>${avg}</td><td>${esc(r.gradeRank||'—')}</td></tr>`;
  }).join('');
  return `<div class="growth-section">
    <div class="growth-sec-head">${cardTitleIcon(ICO_CHART,'成绩聚合（共 '+exs.length+' 次考试）')}<div class="filter-bar" style="margin:0;padding:0;background:transparent;border:0;box-shadow:none">${sb}</div></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>考试</th><th>学科</th><th>班级</th><th>成绩</th><th>班均分</th><th>排名</th></tr></thead><tbody>${rows||'<tr><td colspan="6" class="empty">暂无成绩记录</td></tr>'}</tbody></table></div>
  </div>`;
}
function growthTimelineSection(st, items){
  const colorOf=t=>t==='获奖荣誉'?'green':t==='操行评定'?'blue':t==='奖惩记录'?'red':t==='综合素质'?'purple':'amber';
  const emojiOf=t=>({获奖荣誉:'🏆',操行评定:'📋',奖惩记录:'⚖️',成长记录:'🌱',综合素质:'⭐',其他:'📌'})[t]||'📌';
  const rows=items.length?`<div class="timeline">${items.map(g=>`<div class="tl-item">
    <div class="tl-dot tl-emoji">${emojiOf(g.type)}</div>
    <div class="tl-body">
      <div class="tl-top"><span class="tag tag-${colorOf(g.type)}">${esc(g.type)}</span><span class="muted">${g.date}</span>${g.score!==''&&g.score!=null?`<span class="tag tag-amber">${esc(g.score)}</span>`:''}</div>
      <div class="tl-title"><b>${esc(g.title)}</b></div>${g.content?`<div class="muted">${esc(g.content)}</div>`:''}
      <div class="tl-ops"><button class="btn btn-sm" onclick="growthEdit('${g.id}')">编辑</button><button class="btn btn-sm btn-danger" onclick="growthDel('${g.id}')">删</button></div>
    </div></div>`).join('')}</div>`:'<div class="empty">该生暂无成长档案记录</div>';
  return `<div class="growth-section">
    <div class="growth-sec-head">${cardTitleIcon(ICO_BOOK,'成长记录（'+items.length+' 条）')}</div>
    ${rows}
  </div>`;
}
function growthExportWord(sid){
  const st=DB.students.find(s=>s.id===sid); if(!st)return;
  const items=DB.growth.filter(g=>g.sid===sid).sort((a,b)=>b.date.localeCompare(a.date));
  const p=st.profile||{}, e=st.eval||{};
  const ps=(st.parents||[]).map(p=>`<p>${esc(p.name)}（${esc(p.relation)}） 电话：${esc(p.phone||'—')} 职业：${esc(p.career||'—')} 沟通状态：${esc(p.comm||'—')}</p>`).join('');
  const timeline=items.map(g=>`<p><b>${g.date} · ${esc(g.type)}</b>：${esc(g.title)} ${g.score?`（${esc(g.score)}）`:''}<br>${esc(g.content||'')}</p>`).join('');
  const body=`<h1>${esc(st.name)} 成长档案</h1>
    <p>班级：${esc(st.cls)}　学号：${esc(p.stuNo||'—')}　出生：${esc(p.birth||'—')}　民族：${esc(p.nation||'—')}　政治面貌：${esc(p.politics||'—')}</p>
    <p>就读状态：${esc(p.status||'—')}　寄宿/走读：${esc(p.boarding||'—')}　毕业小学：${esc(p.gradSchool||'—')}　入学时间：${esc(p.enroll||'—')}</p>
    <h2>家长信息</h2>${ps||'<p>暂无</p>'}
    <h2>综合评价</h2><p>素质评级：${esc(e.quality||'—')}　获奖情况：${esc(e.award||'—')}　纪律表现：${esc(e.discipline||'—')}　帮扶措施：${esc(e.help||'—')}</p>
    <h2>成长记录</h2>${timeline||'<p>暂无</p>'}`;
  exportWordDoc('成长档案_'+esc(st.name),body);
}

/* ==================== 待办与工作日历 ==================== */
const TODO_TYPES=['考试','家长会','教研','缴费','班会','其他'];
let _calY=new Date().getFullYear(), _calM=new Date().getMonth()+1;
let _calSubject='';
function todoColor(type){ return ({考试:'red',家长会:'violet',教研:'blue',缴费:'amber',班会:'green',其他:'gray'})[type]||'gray'; }
function renderCalendar(){
  ensureSchema();
  const y=_calY, m=_calM;
  const first=new Date(y,m-1,1).getDay();
  const days=new Date(y,m,0).getDate();
  const lead=(first+6)%7;
  const cellCount=Math.ceil((lead+days)/7)*7;
  const W=['一','二','三','四','五','六','日'];
  const cells=[];
  const todayStr=today();
  const monthTodos=DB.todos.filter(t=>t.date.startsWith(`${y}-${String(m).padStart(2,'0')}`) && (!_calSubject||t.subject===_calSubject));
  for(let i=0;i<cellCount;i++){
    const d=i-lead+1;
    if(d<1||d>days){ cells.push('<td class="cal-empty"></td>'); continue; }
    const ds=`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const items=DB.todos.filter(t=>t.date===ds && (!_calSubject||t.subject===_calSubject));
    const cls='cal-cell'+(ds===todayStr?' cal-today':'')+(items.length?' cal-has':'');
    const dots=items.length?`<div class="cal-dots">${items.slice(0,4).map(t=>`<span class="cal-dot cal-${todoColor(t.type)} ${t.done?'cal-dot-done':''}"></span>`).join('')}</div>`:'';
    const list=items.slice(0,2).map(t=>`<div class="cal-item cal-${todoColor(t.type)} ${t.done?'cal-done':''}">${t.done?'✓ ':''}${esc(t.title)}</div>`).join('');
    cells.push(`<td class="${cls}" onclick="todoAdd('${ds}')"><div class="cal-date-box"><span class="cal-date-num ${ds===todayStr?'cal-date-today':''}">${d}</span>${items.length?`<span class="cal-count">${items.length}</span>`:''}</div>${list}${dots}${items.length>2?`<div class="cal-more">+${items.length-2} 项</div>`:''}</td>`);
  }
  let grid='';
  for(let i=0;i<cellCount;i+=7) grid+=`<tr>${cells.slice(i,i+7).join('')}</tr>`;
  const undone=DB.todos.filter(t=>!t.done && (!_calSubject||t.subject===_calSubject)).sort((a,b)=>a.date.localeCompare(b.date));
  const doneList=DB.todos.filter(t=>t.done && (!_calSubject||t.subject===_calSubject)).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,20);
  const allMonth=DB.todos.filter(t=>t.date.startsWith(`${y}-${String(m).padStart(2,'0')}`));
  const stats=[
    {label:'本月事项',val:allMonth.length,color:'blue'},
    {label:'待完成',val:undone.length,color:'amber'},
    {label:'已完成',val:doneList.length,color:'green'}
  ];
  const subjFilter=`<select onchange="_calSubject=this.value;renderCalendar()">${subSelectOptions(_calSubject,'全部学科')}</select>`;
  const headActions=`<button class="btn" onclick="todoAdd('${todayStr}')">+ 新增待办</button>`;
  document.getElementById('page').innerHTML=wbHead('待办与工作日历','title-slate','将考试、家长会、教研、缴费等事项放进日历，避免遗漏；点日期即可添加待办',headActions)+
  `<div class="filter-bar" style="margin-bottom:12px">${subjFilter}<span class="muted">按学科筛选</span></div>
  <div class="feishu-board" style="margin-bottom:14px">
    <div class="fsb-header">
      <div class="fsb-title">
        <span class="fsb-month">${y} 年 ${m} 月</span>
        <span class="fsb-sub">${['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'][m-1]}工作历</span>
      </div>
      <div class="fsb-actions">
        <button class="btn btn-sm" onclick="calStep(-1)">‹ 上月</button>
        <button class="btn btn-sm" onclick="calToday()">今天</button>
        <button class="btn btn-sm" onclick="calStep(1)">下月 ›</button>
      </div>
    </div>
    <div class="fsb-stats">${stats.map(s=>`<div class="fsb-stat fsb-stat-${s.color}"><b>${s.val}</b><span>${s.label}</span></div>`).join('')}</div>
    <div class="tbl-wrap"><table class="tbl cal-tbl"><thead><tr>${W.map(w=>`<th>周${w}</th>`).join('')}</tr></thead><tbody>${grid}</tbody></table></div>
    <div class="cal-legend">${TODO_TYPES.map(t=>`<span class="cal-leg cal-${todoColor(t)}">${t}</span>`).join('')}</div>
  </div>
  <div class="feishu-board" style="margin-bottom:14px">
    <div class="fsb-section-head"><span class="fsb-dot fsb-dot-amber"></span><h4>📌 未完成（${undone.length}）</h4></div>
    ${undone.length?`<div>${undone.map(t=>todoRow(t)).join('')}</div>`:'<div class="empty">全部完成，太棒了！</div>'}
  </div>
  ${doneList.length?`<div class="feishu-board"><div class="fsb-section-head"><span class="fsb-dot fsb-dot-green"></span><h4>✅ 已完成</h4></div><div>${doneList.map(t=>todoRow(t)).join('')}</div></div>`:''}`;
}
function calStep(n){ _calM+=n; if(_calM<1){_calM=12;_calY--;} if(_calM>12){_calM=1;_calY++;} renderCalendar(); }
function calToday(){ _calY=new Date().getFullYear(); _calM=new Date().getMonth()+1; renderCalendar(); }
function todoRow(t){
  const emojiOf=t=>({考试:'📝',家长会:'👪',教研:'📚',缴费:'💰',班会:'🎓',其他:'📌'})[t]||'📌';
  return `<div class="list-row"><label class="lr-check"><input type="checkbox" ${t.done?'checked':''} onchange="todoToggle('${t.id}',this.checked)"></label>
    <span class="lr-emoji">${emojiOf(t.type)}</span>
    <div class="lr-main"><b class="${t.done?'done':''}">${esc(t.title)}</b><span class="muted">${t.date}${t.time?' '+t.time:''} · <span class="tag tag-${todoColor(t.type)}">${esc(t.type)}</span>${t.subject?` · <span class="tag tag-gray">${esc(t.subject)}</span>`:''}${t.note?' · '+esc(t.note):''}</span></div>
    <div class="lr-ops"><button class="btn btn-sm" onclick="todoEdit('${t.id}')">编辑</button><button class="btn btn-sm btn-danger" onclick="todoDel('${t.id}')">删</button></div>
  </div>`;
}
function todoAdd(date){ todoEdit('new',date); }
function todoEdit(id,presetDate){
  const isNew=!id||id==='new'; const t=isNew?null:DB.todos.find(x=>x.id===id);
  const body=`<div class="form-grid">
    <div class="form-item"><label>事项</label><input id="td_title" value="${t?esc(t.title):''}" placeholder="如：初一3班家长会"></div>
    <div class="form-item"><label>类型</label><select id="td_type">${TODO_TYPES.map(x=>`<option ${t&&t.type===x?'selected':''}>${x}</option>`).join('')}</select></div>
    <div class="form-item"><label>学科</label>${subSelectHtml(t?t.subject:'','td_subject','无')}</div>
    <div class="form-item"><label>日期</label><input id="td_date" type="date" value="${t?t.date:(presetDate||today())}"></div>
    <div class="form-item"><label>时间</label><input id="td_time" value="${t?esc(t.time):''}" placeholder="选填，如 14:30"></div>
    <div class="form-item full"><label>备注</label><input id="td_note" value="${t?esc(t.note):''}" placeholder="选填"></div>
  </div>`;
  openModal((isNew?'新增':'编辑')+'待办',body,
    `<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="todoSave('${isNew?'new':id}')">保存</button>`);
}
function todoSave(id){
  const title=fv('td_title'); if(!title){toast('请填写事项');return;}
  const rec={title,type:fv('td_type'),subject:fv('td_subject'),date:fv('td_date'),time:fv('td_time'),note:fv('td_note'),done:false};
  if(id==='new'){rec.id=uid();DB.todos.push(rec);} else {const o=DB.todos.find(x=>x.id===id);rec.done=o.done;Object.assign(o,rec);}
  save(); closeModal(); renderCalendar(); toast('已保存');
}
function todoToggle(id,done){ const t=DB.todos.find(x=>x.id===id); if(t){t.done=done;save();renderCalendar();} }
function todoDel(id){ if(!confirm('删除该待办？'))return; DB.todos=DB.todos.filter(t=>t.id!==id); save(); renderCalendar(); }

/* =========================================================================
   新增模块：课后反思 / 违纪统计 / 班级活动 / 换课记录 / 工作留痕 / 班主任仪表盘
   ========================================================================= */
function donutSVG(segs, w, h){
  const total=segs.reduce((s,x)=>s+x.value,0);
  if(!total) return '<div class="empty">暂无数据</div>';
  const r=Math.min(w,h)/2-16, cx=w/2, cy=h/2;
  let ang=-Math.PI/2, parts=[];
  segs.forEach(s=>{
    const a2=ang + s.value/total*Math.PI*2;
    const x1=cx+r*Math.cos(ang), y1=cy+r*Math.sin(ang);
    const x2=cx+r*Math.cos(a2), y2=cy+r*Math.sin(a2);
    const large=(a2-ang)>Math.PI?1:0;
    parts.push(`<path d="M${cx} ${cy} L${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z" fill="${s.color}"><title>${esc(s.label)}: ${s.value}</title></path>`);
    ang=a2;
  });
  const legend=segs.map(s=>`<span class="donut-leg"><i style="background:${s.color}"></i>${esc(s.label)} ${s.value}</span>`).join('');
  return `<div class="donut-wrap"><svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${parts.join('')}<text x="${cx}" y="${cy-3}" text-anchor="middle" font-size="20" font-weight="700" fill="#26343f">${total}</text><text x="${cx}" y="${cy+15}" text-anchor="middle" font-size="11" fill="#8fa0ad">总计</text></svg><div class="donut-legend">${legend}</div></div>`;
}
/* 通用模块可视化小卡（donut / bar），供各页面数据概览复用 */
function groupCount(arr, fn){
  const m={}; arr.forEach(x=>{const k=fn(x); if(k==null||k==='')return; m[k]=(m[k]||0)+1;});
  return Object.entries(m).map(([label,value])=>({label,value})).sort((a,b)=>b.value-a.value);
}
const VIZ_PAL=['#2f80ed','#0891b2','#7c3aed','#d97706','#22c55e','#f43f5e','#8b5cf6','#0ea5e9','#e6a817','#64748b'];
function vizCardG(icon,title,tint,chart,insight){
  return `<div class="card card-tint-${tint}" style="margin:0">
    <div class="card-title">${cardTitleIcon(icon,title)}</div>
    <div class="viz-body">${chart}</div>
    <div class="viz-insight">${insight}</div></div>`;
}
function vizBarCardG(icon,title,tint,items,insight){
  const max=Math.max(1,...items.map(i=>i.value));
  const bars=items.map((i,idx)=>`<div class="viz-bar-row"><span class="viz-bar-label">${esc(String(i.label))}</span><span class="viz-bar-track"><span class="viz-bar-fill" style="width:${Math.round(i.value/max*100)}%;background:${i.color||VIZ_PAL[idx%VIZ_PAL.length]}"></span></span><span class="viz-bar-val">${i.value}</span></div>`).join('');
  return vizCardG(icon,title,tint,`<div class="viz-bars">${bars}</div>`,insight);
}
function vizDonutCardG(icon,title,tint,segs,insight){
  return vizCardG(icon,title,tint, segs.length?donutSVG(segs,160,140):'<div class="empty">暂无数据</div>', insight);
}
function studentOpts(cls, sel){
  let o='<option value="">选择学生</option>';
  DB.students.filter(s=>!cls||s.cls===cls).forEach(s=>{ o+=`<option value="${esc(s.name)}" ${s.name===sel?'selected':''}>${esc(s.name)}</option>`; });
  return o;
}

/* ---------------- 课后反思 ---------------- */
let _reflSubj='', _reflCls='';
function renderReflection(){
  ensureSchema();
  let list=DB.reflections.slice();
  if(_reflSubj) list=list.filter(r=>r.subject===_reflSubj);
  if(_reflCls) list=list.filter(r=>r.cls===_reflCls);
  if(F.q) list=list.filter(r=>matchQ(F.q,[r.subject,r.chapter,r.cls,r.content,r.improve,r.tag]));
  list.sort((a,b)=>b.date.localeCompare(a.date));
  const wk=today().slice(0,7);
  const kpis=`<div class="stat-grid">
    ${statCard('累计反思',DB.reflections.length,'#0891b2','篇')}
    ${statCard('本月反思',DB.reflections.filter(r=>r.date.slice(0,7)===wk).length,'#7c3aed','篇')}
    ${statCard('覆盖学科',new Set(DB.reflections.map(r=>r.subject)).size,'#2f80ed','科')}
    ${statCard('最近反思',DB.reflections.length?DB.reflections.slice().sort((a,b)=>b.date.localeCompare(a.date))[0].date:'—','#d97706','')}
  </div>`;
  const fb=clsSelectHtml(_reflCls,'rf_cls','全部班级','','_reflCls=this.value;renderReflection()');
  const sb=subSelectHtml(_reflSubj,'rf_subj','全部学科','','_reflSubj=this.value;renderReflection()');
  const rows=list.map(r=>`<div class="list-row"><div class="lr-main">
      <div class="lr-title">${esc(r.subject)} · 《${esc(r.chapter)}》 <span class="tag tag-cyan">${esc(r.cls)}</span> <span class="tag tag-blue">${esc(r.tag||'')}</span></div>
      <div class="lr-sub">${r.date}　教学效果：${esc(r.effect||'—')}</div>
      <div class="lr-sub"><b>反思：</b>${esc(r.content)||'—'}</div>
      ${r.improve?`<div class="lr-sub"><b style="color:#1e64ad">改进：</b>${esc(r.improve)}</div>`:''}
    </div><div class="lr-actions">
      <button class="btn btn-sm" onclick="reflEdit('${r.id}')">编辑</button>
      <button class="btn btn-sm btn-danger" onclick="reflDel('${r.id}')">删除</button>
    </div></div>`).join('') || emptyState('还没有教学反思','每节课后三分钟复盘课堂得失，长期积累即你的教学智库。', '<button class="btn btn-primary" onclick="reflEdit()">+ 写反思</button>');
  const headActions=`<button class="btn btn-primary" onclick="reflEdit()">+ 写反思</button><button class="btn" onclick="reflExport()">导出Word</button>`;
  document.getElementById('page').innerHTML=
    wbHead('课后反思','title-cyan','每节课后三分钟复盘：课堂得失、改进方向、教学效果，长期积累即个人教学智库',headActions)+
    `<div class="filter-bar">${sb}${fb}</div>
    ${kpis}
    <div class="card card-tint-cyan">${cardTitleIcon(ICO_BULB,'反思记录（'+list.length+' 篇）')}${rows}</div>`;
}
function reflEdit(id){
  const isNew=!id; const r=isNew?null:DB.reflections.find(x=>x.id===id);
  const body=`<div class="form-grid">
    <div class="form-item"><label>日期</label><input id="rf_date" type="date" value="${r?r.date:today()}"></div>
    <div class="form-item"><label>学科</label>${subSelectHtml(r?r.subject:'','rf_subject')}</div>
    <div class="form-item"><label>章节/课题</label><input id="rf_chapter" value="${r?esc(r.chapter):''}" placeholder="如：多位数乘一位数"></div>
    <div class="form-item"><label>班级</label>${clsSelectHtml(r?r.cls:'','rf_cls2',undefined)}</div>
    <div class="form-item"><label>课型</label><select id="rf_tag">${DB.meta.lessonTags.map(t=>`<option ${r&&r.tag===t?'selected':''}>${t}</option>`).join('')}</select></div>
    <div class="form-item"><label>教学效果</label><select id="rf_effect">${['良好','一般','待改进'].map(t=>`<option ${r&&r.effect===t?'selected':''}>${t}</option>`).join('')}</select></div>
    <div class="form-item full"><label>课堂反思</label><textarea id="rf_content" placeholder="本节课的亮点、不足、学生反应">${r?esc(r.content):''}</textarea></div>
    <div class="form-item full"><label>改进方向</label><textarea id="rf_improve" placeholder="下次如何调整">${r?esc(r.improve):''}</textarea></div>
  </div>`;
  openModal((isNew?'写':'编辑')+'课后反思',body,`<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="reflSave('${isNew?'new':id}')">保存</button>`);
}
function reflSave(id){
  const rec={date:fv('rf_date'),subject:fv('rf_subject'),chapter:fv('rf_chapter'),cls:fv('rf_cls2'),tag:fv('rf_tag'),effect:fv('rf_effect'),content:fv('rf_content'),improve:fv('rf_improve')};
  if(id==='new'){rec.id=uid();DB.reflections.push(rec);} else {Object.assign(DB.reflections.find(x=>x.id===id),rec);}
  save(); closeModal(); renderReflection(); toast('已保存');
}
function reflDel(id){ if(!confirm('删除该反思？'))return; DB.reflections=DB.reflections.filter(r=>r.id!==id); save(); renderReflection(); }
function reflExport(){ const items=DB.reflections.slice().sort((a,b)=>b.date.localeCompare(a.date)).map(r=>`<h2>${r.date} · ${esc(r.subject)} · 《${esc(r.chapter)}》</h2><p><b>课型：</b>${esc(r.tag)}　<b>效果：</b>${esc(r.effect)}</p><p><b>反思：</b>${esc(r.content)||'—'}</p><p><b>改进：</b>${esc(r.improve)||'—'}</p>`).join(''); exportWordDoc('课后反思_'+today(),'<h1>课后反思台账</h1>'+items); }

/* ---------------- 违纪统计 ---------------- */
let _dpCls='', _dpType='';
function renderDiscipline(){
  ensureSchema();
  let list=DB.disciplines.slice();
  if(_dpCls) list=list.filter(d=>d.cls===_dpCls);
  if(_dpType) list=list.filter(d=>d.type===_dpType);
  if(F.q) list=list.filter(d=>matchQ(F.q,[d.name,d.cls,d.type,d.note,d.handle,d.status]));
  list.sort((a,b)=>b.date.localeCompare(a.date));
  const pending=list.filter(d=>d.status==='跟进中').length;
  const students=new Set(list.map(d=>d.name)).size;
  const byType={}; list.forEach(d=>byType[d.type]=(byType[d.type]||0)+1);
  const palette={'课堂违纪':'#e11d48','作业未完成':'#d97706','迟到早退':'#7c3aed','仪容仪表':'#0891b2','课间打闹':'#2f80ed','其他':'#8fa0ad'};
  const segs=Object.keys(byType).map(t=>({label:t,value:byType[t],color:palette[t]||'#8fa0ad'}));
  const wk=today().slice(0,7);
  const kpis=`<div class="stat-grid">
    ${statCard('违纪总数',list.length,'#e11d48','次')}
    ${statCard('待跟进',pending,'#7c3aed','次')}
    ${statCard('本月违纪',list.filter(d=>d.date.slice(0,7)===wk).length,'#d97706','次')}
    ${statCard('涉及学生',students,'#2f80ed','人')}
  </div>`;
  const fb=clsSelectHtml(_dpCls,'dp_cls','全部班级','','_dpCls=this.value;renderDiscipline()');
  const tb=`<select id="dp_type" onchange="_dpType=this.value;renderDiscipline()">${optHtml(DB.meta.disciplineTypes,_dpType,'全部类型')}</select>`;
  const rows=list.map(d=>`<div class="list-row"><div class="lr-main">
      <div class="lr-title">${esc(d.name)} · ${esc(d.cls)} <span class="tag tag-red">${esc(d.type)}</span> <span class="tag ${d.status==='跟进中'?'tag-amber':'tag-green'}">${esc(d.status)}</span></div>
      <div class="lr-sub">${d.date}</div>
      <div class="lr-sub"><b>情况：</b>${esc(d.note)||'—'}</div>
      <div class="lr-sub"><b>处理：</b>${esc(d.handle)||'—'}</div>
    </div><div class="lr-actions">
      <button class="btn btn-sm" onclick="dpEdit('${d.id}')">编辑</button>
      <button class="btn btn-sm btn-danger" onclick="dpDel('${d.id}')">删除</button>
    </div></div>`).join('') || emptyState('班级纪律良好','目前没有违纪登记。如有情况可随时登记并跟进处理。', '<button class="btn btn-primary" onclick="dpEdit()">+ 登记违纪</button>');
  const headActions=`<button class="btn btn-primary" onclick="dpEdit()">+ 登记违纪</button><button class="btn" onclick="dpExport()">导出Word</button>`;
  const dpByMonth=groupCount(list.filter(d=>d.date), d=>d.date.slice(0,7)).slice(-6).map(x=>({label:x.label,value:x.value}));
  document.getElementById('page').innerHTML=
    wbHead('违纪统计','title-red','违纪登记、类型分布与处理跟进，用数据看见班级纪律变化，及时干预',headActions)+
    `<div class="filter-bar">${fb}${tb}</div>
    ${kpis}
    <div class="feishu-board" style="margin-bottom:14px"><div class="fsb-section-head"><span class="fsb-dot fsb-dot-red"></span><h4>违纪类型分布</h4></div>${donutSVG(segs,260,200)}</div>
    <div class="card card-tint-rose">${cardTitleIcon(ICO_ALERT,'违纪记录（'+list.length+' 条）')}${rows}</div>`;
}
function dpEdit(id){
  const isNew=!id; const d=isNew?null:DB.disciplines.find(x=>x.id===id);
  const cls=d?d.cls:(_dpCls||classList()[0]||'');
  const body=`<div class="form-grid">
    <div class="form-item"><label>日期</label><input id="dp_date" type="date" value="${d?d.date:today()}"></div>
    <div class="form-item"><label>班级</label>${clsSelectHtml(cls,'dp_modal_cls',undefined,'','')}</div>
    <div class="form-item"><label>学生</label><select id="dp_name">${studentOpts(cls,d?d.name:'')}</select></div>
    <div class="form-item"><label>类型</label><select id="dp_type2">${DB.meta.disciplineTypes.map(t=>`<option ${d&&d.type===t?'selected':''}>${t}</option>`).join('')}</select></div>
    <div class="form-item"><label>状态</label><select id="dp_status">${['已处理','跟进中'].map(t=>`<option ${d&&d.status===t?'selected':''}>${t}</option>`).join('')}</select></div>
    <div class="form-item full"><label>违纪情况</label><textarea id="dp_note" placeholder="具体描述">${d?esc(d.note):''}</textarea></div>
    <div class="form-item full"><label>处理方式</label><input id="dp_handle" value="${d?esc(d.handle):''}" placeholder="如：谈话教育、家校沟通、写检查"></div>
  </div>`;
  openModal((isNew?'登记':'编辑')+'违纪',body,`<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="dpSave('${isNew?'new':id}')">保存</button>`);
}
function dpSave(id){
  const rec={date:fv('dp_date'),cls:fv('dp_modal_cls'),name:fv('dp_name'),type:fv('dp_type2'),status:fv('dp_status'),note:fv('dp_note'),handle:fv('dp_handle')};
  if(id==='new'){rec.id=uid();DB.disciplines.push(rec);} else {Object.assign(DB.disciplines.find(x=>x.id===id),rec);}
  save(); closeModal(); renderDiscipline(); toast('已保存');
}
function dpDel(id){ if(!confirm('删除该记录？'))return; DB.disciplines=DB.disciplines.filter(d=>d.id!==id); save(); renderDiscipline(); }
function dpExport(){ const items=DB.disciplines.slice().sort((a,b)=>b.date.localeCompare(a.date)).map(d=>`<h2>${d.date} · ${esc(d.name)} · ${esc(d.cls)}</h2><p><b>类型：</b>${esc(d.type)}　<b>状态：</b>${esc(d.status)}</p><p><b>情况：</b>${esc(d.note)||'—'}</p><p><b>处理：</b>${esc(d.handle)||'—'}</p>`).join(''); exportWordDoc('违纪统计_'+today(),'<h1>班级违纪台账</h1>'+items); }

/* ---------------- 班级活动 ---------------- */
let _acCls='', _acType='';
const MEETING_TEMPLATES=[
  {t:'安全教育主题班会',c:'围绕交通、防溺水、校园欺凌开展讨论，学生分享自护妙招，签订安全承诺书。'},
  {t:'习惯养成主题班会',c:'聚焦作业、阅读、作息三大习惯，制定班级公约与个人打卡表。'},
  {t:'感恩教育主题班会',c:'通过信件、视频表达对父母师长的感谢，培养感恩之心。'},
  {t:'考前动员主题班会',c:'梳理复习计划，分享减压方法，宣读诚信考试倡议。'},
  {t:'心理健康主题班会',c:'认识情绪、学会倾诉，开展简单的放松训练与同伴支持活动。'},
  {t:'劳动教育主题班会',c:'讨论班级值日分工与家务劳动，评选劳动小能手。'}
];
function renderActivities(){
  ensureSchema();
  let list=DB.activities.slice();
  if(_acCls) list=list.filter(a=>a.cls===_acCls);
  if(_acType) list=list.filter(a=>a.type===_acType);
  if(F.q) list=list.filter(a=>matchQ(F.q,[a.title,a.cls,a.type,a.content]));
  list.sort((a,b)=>b.date.localeCompare(a.date));
  const wk=today().slice(0,4);
  const kpis=`<div class="stat-grid">
    ${statCard('活动总数',DB.activities.length,'#f2994a','场')}
    ${statCard('本学年',DB.activities.filter(a=>a.date.slice(0,4)===wk).length,'#7c3aed','场')}
    ${statCard('班会数',DB.activities.filter(a=>a.type==='主题班会').length,'#2f80ed','场')}
    ${statCard('最近活动',DB.activities.length?DB.activities.slice().sort((a,b)=>b.date.localeCompare(a.date))[0].date:'—','#d97706','')}
  </div>`;
  const fb=clsSelectHtml(_acCls,'ac_cls','全部班级','','_acCls=this.value;renderActivities()');
  const tb=`<select id="ac_type" onchange="_acType=this.value;renderActivities()">${optHtml(DB.meta.activityTypes,_acType,'全部类型')}</select>`;
  const rows=list.map(a=>`<div class="list-row"><div class="lr-main">
      <div class="lr-title">${esc(a.title)} <span class="tag tag-orange">${esc(a.type)}</span> <span class="tag tag-blue">${esc(a.cls)}</span></div>
      <div class="lr-sub">${a.date}${a.template?` · 模板：${esc(a.template)}`:''}</div>
      <div class="lr-sub">${esc(a.content)||'—'}</div>
    </div><div class="lr-actions">
      <button class="btn btn-sm" onclick="acEdit('${a.id}')">编辑</button>
      <button class="btn btn-sm btn-danger" onclick="acDel('${a.id}')">删除</button>
    </div></div>`).join('') || emptyState('还没有班级活动','主题班会、社会实践一键记录，模板库帮你三秒生成方案。', '<button class="btn btn-primary" onclick="acEdit()">+ 新建活动</button><button class="btn" onclick="acTemplates()">班会模板库</button>');
  const headActions=`<button class="btn btn-primary" onclick="acEdit()">+ 新建活动</button><button class="btn" onclick="acTemplates()">班会模板库</button><button class="btn" onclick="acExport()">导出Word</button>`;
  document.getElementById('page').innerHTML=
    wbHead('班级活动','title-orange','主题班会、社会实践、研学旅行一站式记录，模板库一键生成方案，活动留痕不遗漏',headActions)+
    `<div class="filter-bar">${fb}${tb}</div>
    ${kpis}
    <div class="card card-tint-orange">${cardTitleIcon(ICO_FLAG,'活动记录（'+list.length+' 场）')}${rows}</div>`;
}
function acEdit(id){
  const isNew=!id; const a=isNew?null:DB.activities.find(x=>x.id===id);
  const body=`<div class="form-grid">
    <div class="form-item"><label>日期</label><input id="ac_date" type="date" value="${a?a.date:today()}"></div>
    <div class="form-item"><label>类型</label><select id="ac_type2">${DB.meta.activityTypes.map(t=>`<option ${a&&a.type===t?'selected':''}>${t}</option>`).join('')}</select></div>
    <div class="form-item"><label>班级</label>${clsSelectHtml(a?a.cls:'','ac_modal_cls',undefined)}</div>
    <div class="form-item full"><label>活动标题</label><input id="ac_title" value="${a?esc(a.title):''}" placeholder="如：《做时间的主人》主题班会"></div>
    <div class="form-item full"><label>活动内容 / 方案</label><textarea id="ac_content" placeholder="活动目标、流程、总结">${a?esc(a.content):''}</textarea></div>
    <div class="form-item"><label>模板</label><input id="ac_template" value="${a?esc(a.template||''):''}" placeholder="选填，如 班会/研学"></div>
  </div>`;
  openModal((isNew?'新建':'编辑')+'活动',body,`<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="acSave('${isNew?'new':id}')">保存</button>`);
}
function acSave(id){
  const rec={date:fv('ac_date'),type:fv('ac_type2'),cls:fv('ac_modal_cls'),title:fv('ac_title'),content:fv('ac_content'),template:fv('ac_template')};
  if(id==='new'){rec.id=uid();DB.activities.push(rec);} else {Object.assign(DB.activities.find(x=>x.id===id),rec);}
  save(); closeModal(); renderActivities(); toast('已保存');
}
function acDel(id){ if(!confirm('删除该活动？'))return; DB.activities=DB.activities.filter(a=>a.id!==id); save(); renderActivities(); }
function acTemplates(){
  const body=`<div class="tmpl-list">${MEETING_TEMPLATES.map((t,i)=>`<div class="tmpl-item" onclick="acUseTmpl(${i})"><div class="tmpl-t">${esc(t.t)}</div><div class="tmpl-c">${esc(t.c)}</div></div>`).join('')}</div>`;
  openModal('班会模板库',body,`<button class="btn" onclick="closeModal()">关闭</button>`);
}
function acUseTmpl(i){ closeModal(); const t=MEETING_TEMPLATES[i]; setTimeout(()=>{ acEdit(); setTimeout(()=>{ const ti=document.getElementById('ac_title'); if(ti) ti.value=t.t; const co=document.getElementById('ac_content'); if(co) co.value=t.c; const ty=document.getElementById('ac_type2'); if(ty) ty.value='主题班会'; const te=document.getElementById('ac_template'); if(te) te.value=t.t; },30); },30); }
function acExport(){ const items=DB.activities.slice().sort((a,b)=>b.date.localeCompare(a.date)).map(a=>`<h2>${a.date} · ${esc(a.title)}</h2><p><b>类型：</b>${esc(a.type)}　<b>班级：</b>${esc(a.cls)}</p><p>${esc(a.content)||'—'}</p>`).join(''); exportWordDoc('班级活动_'+today(),'<h1>班级活动台账</h1>'+items); }

/* ---------------- 换课记录 ---------------- */
let _ccCls='';
function renderCourseChange(){
  ensureSchema();
  let list=DB.courseChanges.slice();
  if(F.q) list=list.filter(c=>matchQ(F.q,[c.fromSubj,c.toSubj,c.fromTime,c.toTime,c.reason,c.note]));
  list.sort((a,b)=>b.date.localeCompare(a.date));
  const wk=today().slice(0,7);
  const kpis=`<div class="stat-grid">
    ${statCard('换课次数',DB.courseChanges.length,'#7c3aed','次')}
    ${statCard('本月换课',DB.courseChanges.filter(c=>c.date.slice(0,7)===wk).length,'#d97706','次')}
    ${statCard('涉及学科',new Set(DB.courseChanges.map(c=>c.fromSubj)).size,'#2f80ed','科')}
    ${statCard('最近换课',DB.courseChanges.length?DB.courseChanges.slice().sort((a,b)=>b.date.localeCompare(a.date))[0].date:'—','#0891b2','')}
  </div>`;
  const rows=list.map(c=>`<div class="list-row"><div class="lr-main">
      <div class="lr-title">${esc(c.fromSubj)} → ${esc(c.toSubj)} <span class="tag tag-violet">换课</span></div>
      <div class="lr-sub">${c.date}　${esc(c.fromTime)} → ${esc(c.toTime)}</div>
      <div class="lr-sub"><b>原因：</b>${esc(c.reason)||'—'}${c.note?` · ${esc(c.note)}`:''}</div>
    </div><div class="lr-actions">
      <button class="btn btn-sm" onclick="ccEdit('${c.id}')">编辑</button>
      <button class="btn btn-sm btn-danger" onclick="ccDel('${c.id}')">删除</button>
    </div></div>`).join('') || '<div class="empty">暂无换课记录</div>';
  const headActions=`<button class="btn btn-primary" onclick="ccEdit()">+ 登记换课</button><button class="btn" onclick="ccExport()">导出Word</button>`;
  document.getElementById('page').innerHTML=
    wbHead('换课记录','title-violet','调课、串课、代课一目了然，避免课程冲突与遗漏',headActions)+
    `${kpis}
    <div class="card"><div class="card-title">换课记录（${list.length} 条）</div>${rows}</div>`;
}
function ccEdit(id){
  const isNew=!id; const c=isNew?null:DB.courseChanges.find(x=>x.id===id);
  const body=`<div class="form-grid">
    <div class="form-item"><label>日期</label><input id="cc_date" type="date" value="${c?c.date:today()}"></div>
    <div class="form-item"><label>原学科</label>${subSelectHtml(c?c.fromSubj:'','cc_from')}</div>
    <div class="form-item"><label>调整后学科</label>${subSelectHtml(c?c.toSubj:'','cc_to')}</div>
    <div class="form-item"><label>原时间</label><input id="cc_fromtime" value="${c?esc(c.fromTime):''}" placeholder="如：周三第2节"></div>
    <div class="form-item"><label>调整时间</label><input id="cc_totime" value="${c?esc(c.toTime):''}" placeholder="如：周五第4节"></div>
    <div class="form-item full"><label>原因</label><input id="cc_reason" value="${c?esc(c.reason):''}" placeholder="如：运动会彩排占用操场"></div>
    <div class="form-item full"><label>备注</label><input id="cc_note" value="${c?esc(c.note||''):''}" placeholder="选填"></div>
  </div>`;
  openModal((isNew?'登记':'编辑')+'换课',body,`<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="ccSave('${isNew?'new':id}')">保存</button>`);
}
function ccSave(id){
  const rec={date:fv('cc_date'),fromSubj:fv('cc_from'),toSubj:fv('cc_to'),fromTime:fv('cc_fromtime'),toTime:fv('cc_totime'),reason:fv('cc_reason'),note:fv('cc_note')};
  if(id==='new'){rec.id=uid();DB.courseChanges.push(rec);} else {Object.assign(DB.courseChanges.find(x=>x.id===id),rec);}
  save(); closeModal(); renderCourseChange(); toast('已保存');
}
function ccDel(id){ if(!confirm('删除该换课记录？'))return; DB.courseChanges=DB.courseChanges.filter(c=>c.id!==id); save(); renderCourseChange(); }
function ccExport(){ const items=DB.courseChanges.slice().sort((a,b)=>b.date.localeCompare(a.date)).map(c=>`<h2>${c.date} · ${esc(c.fromSubj)} → ${esc(c.toSubj)}</h2><p>${esc(c.fromTime)} → ${esc(c.toTime)}</p><p><b>原因：</b>${esc(c.reason)||'—'}</p>`).join(''); exportWordDoc('换课记录_'+today(),'<h1>换课记录台账</h1>'+items); }

/* ---------------- 工作留痕 ---------------- */
let _wlType='';
function renderWorklog(){
  ensureSchema();
  let list=DB.worklogs.slice();
  if(_wlType) list=list.filter(w=>w.type===_wlType);
  if(F.q) list=list.filter(w=>matchQ(F.q,[w.type,w.title,w.cls,w.content]));
  list.sort((a,b)=>b.date.localeCompare(a.date));
  const wk=today().slice(0,7);
  const kpis=`<div class="stat-grid">
    ${statCard('留痕总数',DB.worklogs.length,'#475569','条')}
    ${statCard('本月',DB.worklogs.filter(w=>w.date.slice(0,7)===wk).length,'#d97706','条')}
    ${statCard('教学类',DB.worklogs.filter(w=>w.type==='教学').length,'#2f80ed','条')}
    ${statCard('管理类',DB.worklogs.filter(w=>w.type==='班级管理').length,'#7c3aed','条')}
  </div>`;
  const tb=`<select id="wl_type" onchange="_wlType=this.value;renderWorklog()">${optHtml(DB.meta.worklogTypes,_wlType,'全部类型')}</select>`;
  const rows=list.map(w=>`<div class="list-row"><div class="lr-main">
      <div class="lr-title">${esc(w.title)} <span class="tag tag-slate">${esc(w.type)}</span> ${w.cls?`<span class="tag tag-blue">${esc(w.cls)}</span>`:''}</div>
      <div class="lr-sub">${w.date}</div>
      <div class="lr-sub">${esc(w.content)||'—'}</div>
    </div><div class="lr-actions">
      <button class="btn btn-sm" onclick="wlEdit('${w.id}')">编辑</button>
      <button class="btn btn-sm btn-danger" onclick="wlDel('${w.id}')">删除</button>
    </div></div>`).join('') || '<div class="empty">暂无工作留痕，随手记录教学与管理的点滴</div>';
  const headActions=`<button class="btn btn-primary" onclick="wlEdit()">+ 记录</button><button class="btn" onclick="wlExport()">导出Word</button>`;
  document.getElementById('page').innerHTML=
    wbHead('工作留痕','title-slate','把每天的教学、管理、家校沟通随手记下来，学期末复盘与考核时有据可依',headActions)+
    `    <div class="filter-bar">${tb}</div>
    ${kpis}
    <div class="card card-tint-slate">${cardTitleIcon(ICO_BRIEFCASE,'工作留痕（'+list.length+' 条）')}${rows}</div>`;
}
function wlEdit(id){
  const isNew=!id; const w=isNew?null:DB.worklogs.find(x=>x.id===id);
  const body=`<div class="form-grid">
    <div class="form-item"><label>日期</label><input id="wl_date" type="date" value="${w?w.date:today()}"></div>
    <div class="form-item"><label>类型</label><select id="wl_type2">${DB.meta.worklogTypes.map(t=>`<option ${w&&w.type===t?'selected':''}>${t}</option>`).join('')}</select></div>
    <div class="form-item"><label>班级</label>${clsSelectHtml(w?w.cls:'','wl_cls',undefined)}</div>
    <div class="form-item full"><label>标题</label><input id="wl_title" value="${w?esc(w.title):''}" placeholder="如：完成第六单元试卷讲评"></div>
    <div class="form-item full"><label>内容</label><textarea id="wl_content" placeholder="简述过程与结果">${w?esc(w.content):''}</textarea></div>
  </div>`;
  openModal((isNew?'记录':'编辑')+'工作留痕',body,`<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="wlSave('${isNew?'new':id}')">保存</button>`);
}
function wlSave(id){
  const rec={date:fv('wl_date'),type:fv('wl_type2'),cls:fv('wl_cls'),title:fv('wl_title'),content:fv('wl_content')};
  if(id==='new'){rec.id=uid();DB.worklogs.push(rec);} else {Object.assign(DB.worklogs.find(x=>x.id===id),rec);}
  save(); closeModal(); renderWorklog(); toast('已保存');
}
function wlDel(id){ if(!confirm('删除该记录？'))return; DB.worklogs=DB.worklogs.filter(w=>w.id!==id); save(); renderWorklog(); }
function wlExport(){ const items=DB.worklogs.slice().sort((a,b)=>b.date.localeCompare(a.date)).map(w=>`<h2>${w.date} · ${esc(w.title)}</h2><p><b>类型：</b>${esc(w.type)}　<b>班级：</b>${esc(w.cls||'—')}</p><p>${esc(w.content)||'—'}</p>`).join(''); exportWordDoc('工作留痕_'+today(),'<h1>工作留痕台账</h1>'+items); }

/* ---------------- 班主任仪表盘 ---------------- */
let _htCls='';
function renderHeadTeacher(){
  ensureSchema();
  const cls=_htCls||classList()[0]||'';
  const students=DB.students.filter(s=>s.cls===cls);
  const attends=DB.attends.filter(a=>a.cls===cls);
  const leaves=DB.leaves.filter(l=>l.cls===cls);
  const homeworks=DB.homeworks.filter(h=>h.cls===cls);
  const disciplines=DB.disciplines.filter(d=>d.cls===cls);
  const growth=DB.growth.filter(g=>g.cls===cls);
  const contacts=DB.contacts.filter(c=>c.cls===cls);
  const tStr=today();
  const late=attends.reduce((s,a)=>s+a.rows.filter(r=>r.status==='迟到').length,0);
  const absent=attends.reduce((s,a)=>s+a.rows.filter(r=>r.status==='缺勤').length,0);
  const leavePending=leaves.filter(l=>l.approve==='待审批').length;
  const unsubTotal=homeworks.reduce((s,h)=>s+(h.unsub||[]).length,0);
  const todoUndone=DB.todos.filter(t=>!t.done&&t.date<=tStr).length;
  const focusStu=students.filter(s=>(s.tags||[]).some(t=>['需要关注','基础薄弱','纪律提醒'].includes(t)));
  const lowScore=students.filter(s=>{
    const exs=DB.exams.filter(e=>e.cls===cls);
    if(!exs.length) return false;
    const last=exs.sort((a,b)=>b.date.localeCompare(a.date))[0];
    const rec=last.records.find(r=>r.name===s.name);
    return rec&&+rec.score<60;
  });
  const kpis=`<div class="stat-grid">
    ${statCard('学生人数',students.length,'#2f80ed','人')}
    ${statCard('待办事项',todoUndone,'#d97706','项')}
    ${statCard('未交作业',unsubTotal,'#e11d48','人次')}
    ${statCard('待批请假',leavePending,'#7c3aed','条')}
    ${statCard('违纪(累计)',disciplines.length,'#a82420','次')}
    ${statCard('重点关注',focusStu.length+lowScore.length,'#0891b2','人')}
  </div>`;
  const fb=clsSelectHtml(cls,'ht_cls','选择班级','','_htCls=this.value;renderHeadTeacher()');
  const recentDisc=disciplines.slice().sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5)
    .map(d=>`<div class="lr-sub">${d.date} · ${esc(d.name)} · <span class="tag tag-red">${esc(d.type)}</span> · ${esc(d.handle||'')}</div>`).join('') || '<div class="empty">无违纪记录</div>';
  const alerts=[...focusStu.map(s=>`<span class="tag tag-amber">${esc(s.name)}·需关注</span>`),...lowScore.map(s=>`<span class="tag tag-red">${esc(s.name)}·低分</span>`)].join(' ') || '<span class="muted">暂无预警学生</span>';
  const unsubList=homeworks.filter(h=>(h.unsub||[]).length).map(h=>`<div class="lr-sub">${esc(h.cls)}《${esc(h.title)}》未交：${esc((h.unsub||[]).join('、'))}</div>`).join('') || '<div class="empty">全部作业已收缴 ✓</div>';
  const headActions=`<button class="btn" onclick="htExportWord()">导出Word</button>`;
  document.getElementById('page').innerHTML=
    wbHead('班主任仪表盘','title-blue','班级管理全景视图：人数、考勤、作业、违纪、家校沟通一屏掌握，优先处理红色预警',headActions)+
    `<div class="filter-bar">${fb}</div>
    ${kpis}
    <div class="card"><div class="card-title">🔔 重点关注（${focusStu.length+lowScore.length}）</div><div style="display:flex;flex-wrap:wrap;gap:6px">${alerts}</div></div>
    <div class="feishu-board" style="margin-bottom:14px"><div class="fsb-section-head"><span class="fsb-dot fsb-dot-red"></span><h4>近期违纪</h4></div>${recentDisc}</div>
    <div class="feishu-board"><div class="fsb-section-head"><span class="fsb-dot fsb-dot-amber"></span><h4>作业未交汇总</h4></div>${unsubList}</div>
    <div class="card" style="margin-top:14px"><div class="card-title">📞 家校沟通（${contacts.length}）</div>${contacts.slice().sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5).map(c=>`<div class="lr-sub">${c.date} · ${esc(c.stuName)} · ${esc(c.topic)} · ${esc(c.result||'')}</div>`).join('')||'<div class="empty">暂无沟通记录</div>'}</div>`;
}
function htExportWord(){
  const cls=_htCls||classList()[0]||'';
  const students=DB.students.filter(s=>s.cls===cls);
  const attends=DB.attends.filter(a=>a.cls===cls);
  const leaves=DB.leaves.filter(l=>l.cls===cls);
  const homeworks=DB.homeworks.filter(h=>h.cls===cls);
  const disciplines=DB.disciplines.filter(d=>d.cls===cls);
  const late=attends.reduce((s,a)=>s+a.rows.filter(r=>r.status==='迟到').length,0);
  const absent=attends.reduce((s,a)=>s+a.rows.filter(r=>r.status==='缺勤').length,0);
  const leavePending=leaves.filter(l=>l.approve==='待审批').length;
  const unsubTotal=homeworks.reduce((s,h)=>s+(h.unsub||[]).length,0);
  const focusStu=students.filter(s=>(s.tags||[]).some(t=>['需要关注','基础薄弱','纪律提醒'].includes(t)));
  const lowScore=students.filter(s=>{
    const exs=DB.exams.filter(e=>e.cls===cls); if(!exs.length) return false;
    const last=exs.sort((a,b)=>b.date.localeCompare(a.date))[0];
    const rec=last.records.find(r=>r.name===s.name); return rec&&+rec.score<60;
  });
  const body=`<h1>班主任仪表盘 · ${esc(cls)}</h1><p>统计日期：${today()}</p>
    <p>学生人数：${students.length}　迟到：${late}　缺勤：${absent}　待批请假：${leavePending}　未交作业：${unsubTotal}　违纪：${disciplines.length}　重点关注：${focusStu.length+lowScore.length}</p>
    <p><b>重点关注学生：</b>${[...focusStu.map(s=>s.name),...lowScore.map(s=>s.name)].join('、')||'无'}</p>`;
  exportWordDoc('班主任仪表盘_'+esc(cls),body);
}
