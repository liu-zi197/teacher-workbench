/* ============================================================
   中小学教师智能工作台 · 原型版
   数据保存在 localStorage，支持导出 Word / PDF(打印另存) / A4打印
   OCR 为预留结构：图片上传 + 识别文本字段 + 手动校正区
   ============================================================ */

/* ==================== 1. 数据与存储 ==================== */
const DB_KEY = 'teacher_wb_v1';

/* ==================== 0. 云端模式（直连 Supabase，无需后端服务器） ==================== */
// 已内置一个可用的云端密钥（service_role，仅在受信任的内部同事间使用）。
// 若日后想更规范，可在「基础设置 → 云端密钥」里替换为 Supabase 的 anon public key。
const SB_URL  = 'https://pvlvxrcfhecvegkyemer.supabase.co';
// 默认云端密钥（已验证可用；若连接异常可在「基础设置→云端密钥」里替换）
const SB_KEY_DEFAULT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2bHZ4cmNmaGVjdmVna3llbWVyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NTM4MTQyNiwiZXhwIjoyMTAwOTU3NDI2fQ.-26jakMneXNlTDPvsWg0izOYTvWYBsW11JBv2nHFJ_8';
// 当前生效的云端密钥：默认用上面的，若用户在设置里覆盖则优先用本地的
let SB_ANON = localStorage.getItem('twb_sb_anon') || SB_KEY_DEFAULT;
const SB_KV   = SB_URL + '/rest/v1/kv';
function sbHead(){ return { 'Content-Type':'application/json', 'apikey':SB_ANON, 'Authorization':'Bearer '+SB_ANON, 'Prefer':'resolution=merge-duplicates,return=representation' }; }

let WS_KEY   = localStorage.getItem('twb_ws') || '';   // 工作空间 ID（由发放的登录密钥映射得到，非密钥本身）
let USERNAME = localStorage.getItem('twb_user') || '';
let ONLINE   = false;
const KEYS_ROW  = 'twb_keys';   // 管理员发放的密钥登记表：{ 登录密钥: {name, ws, createdAt} }
const ADMIN_ROW = 'twb_admin';  // 管理员密码（哈希存储）
async function sbGetRow(key){
  const r = await fetch(SB_KV + '?key=eq.' + encodeURIComponent(key) + '&select=value', { headers: sbHead() });
  if(!r.ok) throw new Error('云端读取失败('+r.status+')');
  const rows = await r.json();
  return rows.length ? rows[0].value : null;
}
async function sbSetRow(key, val){
  const r = await fetch(SB_KV, { method:'POST', headers: sbHead(), body: JSON.stringify({key, value:val}) });
  if(!r.ok) throw new Error('云端写入失败('+r.status+')');
}
const ADMIN_WS = 'ws_owner';   // 管理员本人专属空间（用管理员密码 liu010806 登录时进入）
const api = {
  // 登录：先用管理员密码校验，命中则进入管理员专属空间并自动解锁管理后台；
  // 否则校验是否命中发放的访问密钥。
  async login(key, name){
    key=(key||'').trim(); if(!key) throw new Error('请输入密钥');
    // ① 管理员专属密钥：与管理员密码一致
    try{
      const adminRec = await sbGetRow(ADMIN_ROW);
      if(adminRec && adminRec.pwd === simpleHash(key)){
        WS_KEY = ADMIN_WS; USERNAME = name || '管理员'; ONLINE = true;
        sessionStorage.setItem('twb_admin_unlock','1');   // 自动解锁管理后台
        localStorage.setItem('twb_ws', WS_KEY); localStorage.setItem('twb_user', USERNAME);
        return;
      }
    }catch(e){ /* 读取管理员密码失败则忽略，继续走普通校验 */ }
    // ② 普通老师：校验发放名单
    const reg = await sbGetRow(KEYS_ROW) || {};
    const rec = reg[key];
    if(!rec) throw new Error('密钥无效，请联系管理员获取');
    WS_KEY = rec.ws; USERNAME = rec.name || name || '老师'; ONLINE = true;
    sessionStorage.removeItem('twb_admin_unlock');   // 普通老师不解锁管理后台
    localStorage.setItem('twb_ws', WS_KEY); localStorage.setItem('twb_user', USERNAME);
  },
  async load(){
    const r = await fetch(SB_KV + '?key=eq.' + encodeURIComponent(WS_KEY) + '&select=value', { headers: sbHead() });
    if(!r.ok) throw new Error('云端读取失败('+r.status+')');
    const rows = await r.json();
    return rows.length ? rows[0].value : null;
  },
  async save(db){
    const r = await fetch(SB_KV, { method:'POST', headers: sbHead(), body: JSON.stringify({key:WS_KEY, value:db}) });
    if(!r.ok) throw new Error('云端保存失败('+r.status+')');
  },
  async getRow(k){ return sbGetRow(k); },
  async setRow(k,v){ return sbSetRow(k,v); },
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
// 管理员统一 AI 密钥（存于 Supabase，全站老师免配置即可用真实 AI）
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
  }catch(e){ toast('保存失败：'+(e.message||'网络错误')+'（可到云端密钥处测试连接）'); }
}

function seedData(){
  return {
    meta:{
      grades:['一年级','二年级','三年级','四年级','五年级','六年级','七年级','八年级','九年级'],
      subjects:['语文','数学','英语','道德与法治','科学','物理','化学','生物','历史','地理'],
      versions:['人教版','北师大版','苏教版','沪教版','外研版'],
      classes:['三年级1班','三年级2班','七年级3班'],
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
      {id:'s1',name:'王小明',gender:'男',sno:'2024001',cls:'三年级1班',grade:'三年级',phone:'138****1234',note:'',tags:['课堂活跃']},
      {id:'s2',name:'李思雨',gender:'女',sno:'2024002',cls:'三年级1班',grade:'三年级',phone:'139****5678',note:'',tags:['学习优秀']},
      {id:'s3',name:'张浩然',gender:'男',sno:'2024003',cls:'三年级1班',grade:'三年级',phone:'136****2233',note:'计算基础需加强',tags:['基础薄弱','需要关注']},
      {id:'s4',name:'陈雨桐',gender:'女',sno:'2024004',cls:'三年级1班',grade:'三年级',phone:'137****8899',note:'',tags:['进步明显']},
      {id:'s5',name:'刘子轩',gender:'男',sno:'2024005',cls:'三年级1班',grade:'三年级',phone:'135****4455',note:'作业经常迟交',tags:['作业拖拉']},
      {id:'s6',name:'赵欣怡',gender:'女',sno:'2024006',cls:'三年级1班',grade:'三年级',phone:'132****6677',note:'',tags:[]},
      {id:'s7',name:'孙一鸣',gender:'男',sno:'2024007',cls:'三年级1班',grade:'三年级',phone:'133****9900',note:'',tags:['课堂活跃']},
      {id:'s8',name:'周静怡',gender:'女',sno:'2024008',cls:'三年级1班',grade:'三年级',phone:'186****1122',note:'性格内向，多鼓励',tags:['心理敏感']},
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
function nl2br(s){ return esc(s).replace(/\n/g,'<br>'); }
function today(){ return new Date().toISOString().slice(0,10); }
function toast(msg){
  const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show');
  clearTimeout(t._tm); t._tm=setTimeout(()=>t.classList.remove('show'),2600);
}
function stuById(id){ return DB.students.find(s=>s.id===id); }
function stuName(id){ const s=stuById(id); return s?s.name:'（未关联）'; }

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
  {id:'papers',ico:'卷',label:'试卷/习题生成',color:'orange'},
  {id:'students',ico:'生',label:'学生与班级管理',color:'teal'},
  {id:'tools',ico:'具',label:'教师工具箱',color:'yellow'},
  {id:'settings',ico:'设',label:'基础设置',color:'gray'}
];
let current='dashboard';

function renderNav(){
  document.getElementById('navList').innerHTML=NAVS.map(n=>
    `<div class="nav-item ${n.id===current?'active':''}" onclick="nav('${n.id}')"><span class="nav-ico ico-${n.color}">${n.ico}</span>${n.label}</div>`).join('');
}
function fillGlobalSelects(){
  document.getElementById('gGrade').innerHTML=optHtml(DB.meta.grades,F.grade,'全部年级');
  document.getElementById('gSubject').innerHTML=optHtml(DB.meta.subjects,F.subject,'全部学科');
  document.getElementById('gClass').innerHTML=optHtml(DB.meta.classes,F.cls,'全部班级');
}
function onGlobalFilter(){
  F.q=document.getElementById('gSearch').value.trim();
  F.grade=document.getElementById('gGrade').value;
  F.subject=document.getElementById('gSubject').value;
  F.cls=document.getElementById('gClass').value;
  render();
}
function nav(page){ current=page; renderNav(); render(); }
function render(){
  const fn={dashboard:renderDashboard,lessons:renderLessons,mistakes:renderMistakes,scores:renderScores,
            papers:renderPapers,students:renderStudents,tools:renderTools,settings:renderSettings}[current];
  fn && fn();
  window.scrollTo(0,0);
}

/* 模块通用工具条 */
function moduleToolbar(btns){
  return `<div class="toolbar">${btns.join('')}</div>`;
}

/* ==================== 4. 首页仪表盘 ==================== */
function renderDashboard(){
  const unMastered=DB.mistakes.filter(m=>!m.mastered).length;
  const unCorrected=DB.mistakes.filter(m=>m.corrected!=='已订正').length;
  const focusStu=DB.students.filter(s=>s.tags.includes('需要关注')||s.tags.includes('基础薄弱'));
  const latest=[...DB.exams].sort((a,b)=>b.date.localeCompare(a.date))[0];
  let dLayer=[];
  if(latest){ const a=calcExam(latest); dLayer=a.layers.D; }

  document.getElementById('page').innerHTML=`
  <div class="page-head">
    <div><div class="page-title title-blue">首页仪表盘</div><div class="page-desc">今天是 ${today()} · 欢迎回来，这里是您的教学工作总览</div></div>
    ${moduleToolbar([
      `<button class="btn btn-primary" onclick="nav('lessons');setTimeout(lessonAdd,50)">+ 新建备课</button>`,
      `<button class="btn" onclick="nav('mistakes');setTimeout(mistakeAdd,50)">+ 录入错题</button>`,
      `<button class="btn" onclick="nav('scores');setTimeout(examAdd,50)">+ 新建考试</button>`
    ])}
  </div>
  <div class="stat-grid">
    <div class="stat-card"><div class="stat-ico ico-blue">生</div><div><div class="stat-num">${DB.students.length}</div><div class="stat-label">在册学生 · ${DB.meta.classes.length}个班级</div></div></div>
    <div class="stat-card"><div class="stat-ico ico-blue">备</div><div><div class="stat-num">${DB.lessons.length}</div><div class="stat-label">备课资源</div></div></div>
    <div class="stat-card"><div class="stat-ico ico-yellow">错</div><div><div class="stat-num">${DB.mistakes.length}</div><div class="stat-label">错题总数 · ${unMastered}题未掌握</div></div></div>
    <div class="stat-card"><div class="stat-ico ico-green">成</div><div><div class="stat-num">${DB.exams.length}</div><div class="stat-label">考试记录</div></div></div>
  </div>
  <div class="two-col">
    <div class="card">
      <div class="card-title">待办提醒</div>
      ${unCorrected? `<div class="bar-row"><span class="tag tag-yellow">提醒</span>有 <b>${unCorrected}</b> 道错题未订正，<span class="link" onclick="nav('mistakes')">去处理 →</span></div>`:''}
      ${DB.mistakes.filter(m=>!m.reviewed).length? `<div class="bar-row"><span class="tag tag-yellow">提醒</span>有 <b>${DB.mistakes.filter(m=>!m.reviewed).length}</b> 道错题未讲评，可 <span class="link" onclick="genReviewList()">生成讲评清单 →</span></div>`:''}
      ${dLayer.length? `<div class="bar-row"><span class="tag tag-red">风险</span>最近考试（${esc(latest.name)}）有 <b>${dLayer.length}</b> 名D层重点关注学生：${dLayer.map(esc).join('、')}</div>`:''}
      ${focusStu.length? `<div class="bar-row"><span class="tag tag-red">关注</span>标记为需关注/基础薄弱的学生：${focusStu.map(s=>esc(s.name)).join('、')}</div>`:''}
      ${!unCorrected&&!dLayer.length&&!focusStu.length? `<div class="empty">暂无待办事项，一切正常</div>`:''}
    </div>
    <div class="card">
      <div class="card-title">最近考试</div>
      ${DB.exams.length? `<div class="tbl-wrap"><table class="tbl"><tr><th class="nosort">考试</th><th class="nosort">班级/学科</th><th class="nosort">日期</th><th class="nosort">平均分</th><th class="nosort">操作</th></tr>
        ${[...DB.exams].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,5).map(e=>{const a=calcExam(e);return `<tr><td>${esc(e.name)}</td><td>${esc(e.cls)} · ${esc(e.subject)}</td><td>${e.date}</td><td class="num">${a.avg}</td><td><span class="link" onclick="examReport('${e.id}')">分析报告</span></td></tr>`;}).join('')}
      </table></div>`:'<div class="empty">暂无考试记录</div>'}
    </div>
  </div>
  <div class="card">
    <div class="card-title">最近备课</div>
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
    (!F.q||(l.title+l.unit+(l.tags||[]).join('')).includes(F.q)));
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
    <div class="form-item"><label>学科 <i>*</i></label><select id="f_subject">${optHtml(DB.meta.subjects,l.subject||F.subject||'数学')}</select></div>
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
    (!F.q||(stuName(m.studentId)+m.kp+m.ocr+m.examName).includes(F.q)));
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
    <div class="form-item"><label>学科</label><select id="f_msub">${optHtml(DB.meta.subjects,m.subject||F.subject||'数学')}</select></div>
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
  `<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="mistakeSave('')">保存</button>`); }
function mistakeEdit(id){ const m=DB.mistakes.find(x=>x.id===id); _stagedImg=m.img||'';
  openModal('编辑错题', mistakeForm(m),
  `<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="mistakeSave('${id}')">保存</button>`); }
function mistakeSave(id){
  const sid=fv('f_sid'); if(!sid){ toast('请选择学生'); return; }
  if(!fv('f_ocr')){ toast('请填写题目内容（OCR识别文本区）'); return; }
  const stu=stuById(sid);
  const obj={id:id||uid(),studentId:sid,cls:stu.cls,grade:stu.grade,subject:fv('f_msub'),source:fv('f_source'),
    examName:fv('f_exam'),img:_stagedImg,ocr:fv('f_ocr'),qtype:fv('f_qtype'),kp:fv('f_kp'),reason:fv('f_reason'),
    answer:fv('f_ans'),analysis:fv('f_ana'),corrected:fv('f_corr'),count:+fv('f_count')||1,
    reviewed:fv('f_rev')==='是',mastered:fv('f_mas')==='是'};
  if(id){ const i=DB.mistakes.findIndex(x=>x.id===id); DB.mistakes[i]=obj; } else DB.mistakes.push(obj);
  save(); closeModal(); render(); toast('错题已保存');
}
function mistakeDel(id){ if(!confirm('确定删除这道错题吗？'))return; DB.mistakes=DB.mistakes.filter(x=>x.id!==id); save(); render(); }
function previewImg(id){ const m=DB.mistakes.find(x=>x.id===id);
  openModal('题目图片', `<img src="${m.img}" style="max-width:100%">`,'',true); }
function mistakeBatch(){
  openModal('批量上传错题图片',
   `<div class="ocr-box">选择多张错题照片，系统将为每张图片创建一条错题记录（OCR文本为占位，请之后逐条打开编辑校正）。</div>
    <div class="form-grid">
      <div class="form-item"><label>默认学生</label><select id="f_bsid">${optHtml2(DB.students.map(s=>[s.id,s.name+'（'+s.cls+'）']),'','请选择（可后期修改）')}</select></div>
      <div class="form-item"><label>默认学科</label><select id="f_bsub">${optHtml(DB.meta.subjects,'数学')}</select></div>
      <div class="form-item full"><label>选择图片（可多选）</label><input type="file" id="f_bimgs" accept="image/*" multiple></div>
    </div>`,
   `<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="mistakeBatchSave()">创建错题记录</button>`,true);
}
function mistakeBatchSave(){
  const files=[...document.getElementById('f_bimgs').files];
  if(!files.length){ toast('请先选择图片'); return; }
  const sid=fv('f_bsid'); const stu=sid?stuById(sid):null; const sub=fv('f_bsub');
  let done=0;
  files.forEach(f=>{
    const r=new FileReader();
    r.onload=e=>{
      DB.mistakes.push({id:uid(),studentId:sid,cls:stu?stu.cls:'',grade:stu?stu.grade:'',subject:sub,source:'批量上传',
        examName:'',img:e.target.result,ocr:'【OCR识别占位】待接入OCR后自动识别，请编辑此记录手动录入题目内容。',
        qtype:'综合题',kp:'',reason:'其他',answer:'',analysis:'',corrected:'未订正',count:1,reviewed:false,mastered:false});
      if(++done===files.length){ save(); closeModal(); render(); toast('已创建 '+done+' 条错题记录，请逐条编辑完善'); }
    };
    r.readAsDataURL(f);
  });
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
function genVariantsFor(id){
  const m=DB.mistakes.find(x=>x.id===id);
  const vs=buildVariants(m);
  const body=`<div class="notice">已根据知识点「${esc(m.kp||'未标注')}」与错误原因「${esc(m.reason)}」生成3道不同难度变式题（模板生成，接入AI后可自动生成具体题干）。所有内容均可编辑后再导出。</div>
  ${vs.map((v,i)=>`
    <div class="form-item full"><label>${v.level} 题干</label><textarea id="vq${i}" style="min-height:70px">${esc(v.q)}</textarea></div>
    <div class="two-col">
      <div class="form-item"><label>答案</label><textarea id="va${i}" style="min-height:44px">${esc(v.a)}</textarea></div>
      <div class="form-item"><label>解析</label><textarea id="vs${i}" style="min-height:44px">${esc(v.s)}</textarea></div>
    </div>`).join('')}
  <div class="form-item"><label>答题空位</label><select id="vspace"><option value="normal">普通</option><option value="large" selected>较大</option><option value="xlarge">超大</option></select></div>`;
  openModal('变式题生成 · '+stuName(m.studentId), body,
    `<button class="btn btn-green" onclick="aiVariants('${id}')">AI生成变式题</button>
     <button class="btn" onclick="exportVariants('${id}','word')">导出Word</button>
     <button class="btn" onclick="exportVariants('${id}','pdf')">导出PDF</button>
     <button class="btn btn-primary" onclick="exportVariants('${id}','print')">A4打印</button>
     <button class="btn" onclick="closeModal()">关闭</button>`);
}
function exportVariants(id,mode){
  const m=DB.mistakes.find(x=>x.id===id);
  const sp=fv('vspace')||'large';
  const levels=['基础题（★）','提高题（★★）','挑战题（★★★）'];
  let html=`<h1>变式训练 · ${esc(m.kp||'专项练习')}</h1>
  <div class="p-info-line"><span>姓名：${esc(stuName(m.studentId))}</span><span>班级：${esc(m.cls)}</span><span>日期：____月____日</span><span>用时：______分钟</span></div>
  <h2>原题回顾</h2><div class="p-q"><pre>${esc(m.ocr)}</pre>${m.img?`<img class="p-img" src="${m.img}">`:''}</div>`;
  for(let i=0;i<3;i++){
    html+=`<h2>${levels[i]}</h2><div class="p-q"><pre>${esc(fv('vq'+i))}</pre><div class="p-space-${sp}"></div>
    <div class="p-ans"><b>答案：</b>${esc(fv('va'+i))}<br><b>解析：</b>${esc(fv('vs'+i))}</div></div>`;
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
  let html=`<h1>「${esc(m.kp||'专项')}」巩固练习</h1>
  <div class="p-info-line"><span>姓名：__________</span><span>班级：${esc(m.cls)}</span><span>日期：____月____日</span></div>
  <h2>一、错题重做（共${same.length||1}题）</h2>`;
  (same.length?same:[m]).forEach((x,i)=>{
    html+=`<div class="p-q"><b>${i+1}.</b> <pre>${esc(x.ocr)}</pre><div class="p-space-large"></div>
    <div class="p-ans"><b>答案：</b>${esc(x.answer||'（见教师版）')}　<b>解析：</b>${esc(x.analysis||'')}</div></div>`;
  });
  html+=`<h2>二、变式巩固（3题）</h2>`;
  buildVariants(m).forEach((v,i)=>{
    html+=`<div class="p-q"><b>${i+1}.（${v.level}）</b><pre>${esc(v.q)}</pre><div class="p-space-large"></div>
    <div class="p-ans"><b>答案：</b>${esc(v.a)}　<b>解析：</b>${esc(v.s)}</div></div>`;
  });
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
    (!F.q||(e.name+e.type).includes(F.q))).sort((a,b)=>b.date.localeCompare(a.date));
  document.getElementById('page').innerHTML=`
  <div class="page-head">
    <div><div class="page-title title-green">成绩分析库</div><div class="page-desc">录入/导入成绩后，自动生成班级分析、学生分层、薄弱知识点与教学建议</div></div>
    ${moduleToolbar([
      `<button class="btn btn-primary" onclick="examAdd()">+ 新建考试</button>`,
      `<button class="btn" onclick="toast('打开某场考试后，可在成绩录入页使用「导入成绩」粘贴Excel数据')">批量导入</button>`
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
    <div class="form-item"><label>班级</label><select id="f_ecls">${optHtml(DB.meta.classes,F.cls||DB.meta.classes[0])}</select></div>
    <div class="form-item"><label>学科</label><select id="f_esub">${optHtml(DB.meta.subjects,F.subject||'数学')}</select></div>
    <div class="form-item"><label>满分</label><input id="f_efull" type="number" value="100"></div>
  </div>
  <div class="form-hint" style="margin-top:8px">创建后将自动带入该班级的学生名单，可直接录入成绩或粘贴导入。</div>`,
  `<button class="btn" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="examSave()">创建并录入成绩</button>`,true);
}
function examSave(){
  if(!fv('f_ename')){ toast('请填写考试名称'); return; }
  const cls=fv('f_ecls');
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
function renderPapers(){
  document.getElementById('page').innerHTML=`
  <div class="page-head">
    <div><div class="page-title title-orange">试卷 / 习题生成库</div><div class="page-desc">按年级、学科、知识点、难度快速生成练习卷（模板生成，接入AI后可自动生成具体题干）</div></div>
  </div>
  <div class="two-col">
    <div class="card">
      <div class="card-title">生成设置</div>
      <div class="form-grid">
        <div class="form-item"><label>年级</label><select id="p_grade">${optHtml(DB.meta.grades,F.grade||'三年级')}</select></div>
        <div class="form-item"><label>学科</label><select id="p_subject">${optHtml(DB.meta.subjects,F.subject||'数学')}</select></div>
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
  document.getElementById('paperPreview').innerHTML=
    `<div class="notice">已生成 <b>${qs.length}</b> 道题 · ${esc(_lastPaper.title)} · ${_lastPaper.fmt}</div>`+
    qs.slice(0,6).map((q,i)=>`<div style="border-bottom:1px dashed #dde7ef;padding:8px 0;font-size:13px"><b>${i+1}. [${esc(q.qtype)}]</b><br>${nl2br(q.text)}</div>`).join('')+
    (qs.length>6?`<div class="empty" style="padding:10px">…共${qs.length}题，导出/打印查看完整试卷</div>`:'');
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

/* ==================== 9. 学生与班级管理 ==================== */
let stuSort={key:'sno',asc:true};
function renderStudents(){
  let list=DB.students.filter(s=>
    (!F.grade||s.grade===F.grade)&&(!F.cls||s.cls===F.cls)&&
    (!F.q||(s.name+s.sno+s.tags.join('')).includes(F.q)));
  list.sort((a,b)=>{const k=stuSort.key;const r=String(a[k]).localeCompare(String(b[k]),'zh');return stuSort.asc?r:-r;});
  document.getElementById('page').innerHTML=`
  <div class="page-head">
    <div><div class="page-title title-teal">学生名单与班级管理</div><div class="page-desc">学生信息关联错题记录、成绩记录与分层标签（点击姓名查看学生档案）</div></div>
    ${moduleToolbar([
      `<button class="btn btn-primary" onclick="stuAdd()">+ 新增学生</button>`,
      `<button class="btn" onclick="importStudents()">批量导入（Excel/CSV）</button>`,
      `<button class="btn" onclick="exportStuList('word')">导出Word</button>`,
      `<button class="btn" onclick="exportStuList('pdf')">导出PDF</button>`,
      `<button class="btn" onclick="exportStuList('print')">A4打印</button>`
    ])}
  </div>
  <div class="card">
    <div class="filter-bar">
      <span class="filter-label">共 ${list.length} 名学生（班级筛选请用顶部筛选栏，当前：${F.cls||'全部班级'}）· 点击表头排序</span>
    </div>
    <div class="tbl-wrap"><table class="tbl">
      <tr>
        <th onclick="stuSortBy('name')">姓名 ${stuSort.key==='name'?(stuSort.asc?'↑':'↓'):''}</th>
        <th onclick="stuSortBy('gender')">性别</th>
        <th onclick="stuSortBy('sno')">学号 ${stuSort.key==='sno'?(stuSort.asc?'↑':'↓'):''}</th>
        <th onclick="stuSortBy('cls')">班级</th>
        <th onclick="stuSortBy('grade')">年级</th>
        <th class="nosort">家长联系方式</th><th class="nosort">学生标签</th><th class="nosort">错题</th><th class="nosort">备注</th><th class="nosort">操作</th></tr>
      ${list.map(s=>{
        const mc=DB.mistakes.filter(m=>m.studentId===s.id).length;
        return `<tr>
        <td><span class="link" onclick="stuView('${s.id}')"><b>${esc(s.name)}</b></span></td>
        <td>${esc(s.gender)}</td><td>${esc(s.sno)}</td><td>${esc(s.cls)}</td><td>${esc(s.grade)}</td>
        <td>${esc(s.phone)}</td>
        <td>${s.tags.map(t=>`<span class="tag ${['需要关注','基础薄弱','心理敏感','纪律提醒'].includes(t)?'tag-red':['学习优秀','进步明显'].includes(t)?'tag-green':['作业拖拉'].includes(t)?'tag-yellow':'tag-blue'}">${esc(t)}</span>`).join('')||'—'}</td>
        <td class="num">${mc?`<span class="link" onclick="MF.stu='${s.id}';nav('mistakes')">${mc}题</span>`:'0'}</td>
        <td>${esc(s.note)||'—'}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-sm" onclick="stuEdit('${s.id}')">编辑</button>
          <button class="btn btn-sm btn-danger" onclick="stuDel('${s.id}')">删除</button>
        </td></tr>`;}).join('') || '<tr><td colspan="10"><div class="empty">暂无学生，点击「新增学生」或「批量导入」</div></td></tr>'}
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
    <div class="form-item"><label>班级</label><select id="f_scls">${optHtml(DB.meta.classes,s.cls||F.cls||DB.meta.classes[0])}</select></div>
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
  const obj={id:id||uid(),name:fv('f_sname'),gender:fv('f_sgender'),sno:fv('f_ssno'),cls:fv('f_scls'),
    grade:fv('f_sgrade'),phone:fv('f_sphone'),note:fv('f_snote'),tags:pills('f_stags')};
  if(id){ const i=DB.students.findIndex(x=>x.id===id); DB.students[i]=obj; } else DB.students.push(obj);
  save(); closeModal(); render(); toast('学生信息已保存');
}
function stuDel(id){
  const mc=DB.mistakes.filter(m=>m.studentId===id).length;
  if(!confirm('确定删除该学生吗？'+(mc?'（其名下'+mc+'条错题记录将保留但显示为未关联）':''))) return;
  DB.students=DB.students.filter(x=>x.id!==id); save(); render();
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
  `<button class="btn" onclick="stuEdit('${id}')">编辑信息</button><button class="btn" onclick="closeModal()">关闭</button>`);
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
    if(cls&&!DB.meta.classes.includes(cls)) DB.meta.classes.push(cls);
    if(grade&&!DB.meta.grades.includes(grade)) DB.meta.grades.push(grade);
    DB.students.push({id:uid(),name,gender:gender||'男',sno:sno||'',cls:cls||DB.meta.classes[0],grade:grade||'',phone:phone||'',note:note||'',tags:[]});
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
  document.getElementById('page').innerHTML=`
  <div class="page-head">
    <div><div class="page-title title-yellow">教师常用工具箱</div><div class="page-desc">8个高频文书工具：输入关键信息 → 一键生成 → 复制/导出Word/PDF</div></div>
  </div>
  <div class="tool-grid">
    ${TOOLS.map(t=>`<div class="tool-card" onclick="toolOpen('${t.id}')">
      <div class="t-ico">${t.ico}</div><h4>${t.name}</h4><p>${t.desc}</p></div>`).join('')}
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

/* ==================== 11. 基础设置 ==================== */
const META_DEFS=[
  ['grades','年级（可自由新增，如"预备班"）'],['subjects','学科'],['versions','教材版本'],
  ['classes','班级'],['examTypes','考试类型'],['lessonTags','备课课型标签'],['stuTags','学生标签']
];
function renderSettings(){
  const adminUnlocked = sessionStorage.getItem('twb_admin_unlock') === '1';
  document.getElementById('page').innerHTML=`
  <div class="page-head">
    <div><div class="page-title title-gray">基础设置</div><div class="page-desc">自由新增/删除年级、学科、班级、教材版本、考试类型等基础数据；维护教材单元目录</div></div>
    ${moduleToolbar([`<button class="btn btn-danger" onclick="resetData()">重置为示例数据</button>`])}
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
        <div class="form-item"><label>学科</label><select id="c_sub">${optHtml(DB.meta.subjects,'数学')}</select></div>
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
      <div class="notice">数据已直连 Supabase 免费数据库，无需任何后端服务器。每个「工作空间密钥」对应一个独立的云端空间。</div>
      <div class="filter-bar" style="margin-top:8px;margin-bottom:0">
        <span class="tag tag-blue">Supabase 已连接</span>
        <span class="tag tag-gray">当前空间：${esc(WS_KEY||'未登录')}</span>
      </div>
      <div class="card-title" style="margin-top:14px">云端密钥</div>
      <div class="notice">前端连接 Supabase 的密钥已内置（一般无需修改）。若日后连接异常，可由管理员替换为 Supabase 的 anon public key。</div>
      <div class="form-grid">
        <div class="form-item full"><label>云端密钥（一般无需修改）</label><input id="sb_anon" placeholder="eyJ..." value="${esc(SB_ANON)}"></div>
      </div>
      <div class="filter-bar" style="margin-top:8px;margin-bottom:0">
        <button class="btn btn-sm btn-primary" onclick="saveSbAnon()">保存并重试连接</button>
        <button class="btn btn-sm" onclick="testSb()">仅测试连接</button>
      </div>
      <div id="sb_test_out" class="notice" style="margin-top:8px;display:none"></div>
    </div>
    <div class="card" style="border:2px solid #3b7ddd">
      <div class="card-title">🔑 密钥管理（管理员专用）</div>
      <div class="notice">这里用来给每位老师<b>发放不同的访问密钥</b>。生成后把密钥发给对应老师，他们登录时粘贴即可，<b>无需任何配置</b>。不同密钥对应完全隔离的云端空间，老师之间互不可见。</div>
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
      <div class="notice">在这里填入一个硅基流动 / DeepSeek 密钥，<b>全站所有老师无需各自配置</b>即可使用真实 AI 出题、生成试卷、写教案。密钥仅存于你的 Supabase，不会暴露给老师。</div>
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

/* ==================== 13. 初始化 / 登录 ==================== */
function startApp(){
  document.getElementById('loginScreen').style.display='none';
  document.getElementById('appRoot').style.display='';
  renderNav(); fillGlobalSelects(); render(); updateUserBar();
  loadSharedAi();   // 异步加载管理员统一 AI 密钥（老师免配置）
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
function saveSbAnon(){
  const v=(document.getElementById('sb_anon')||{}).value||'';
  if(!v.trim()){ toast('请输入云端密钥'); return; }
  localStorage.setItem('twb_sb_anon', v.trim());
  SB_ANON = v.trim();
  toast('已保存，正在测试连接…');
  testSb();
}
async function testSb(){
  const out=document.getElementById('sb_test_out');
  if(out){ out.style.display='block'; out.textContent='连接测试中…'; }
  try{
    const r=await fetch(SB_KV+'?select=key&limit=1',{headers:sbHead()});
    if(r.ok){ if(out) out.innerHTML='✅ 连接成功（HTTP '+r.status+'），可正常云端同步'; toast('云端连接正常'); }
    else { if(out) out.innerHTML='❌ 连接失败：HTTP '+r.status+(r.status===401?' —— 密钥无效，请重新点击 anon public 行的 Copy 按钮复制最新密钥':''); toast('连接失败：'+r.status); }
  }catch(e){ if(out) out.innerHTML='❌ 网络错误：'+((e&&e.message)||e); toast('网络错误'); }
}

function simpleHash(s){ let h=0; for(let i=0;i<s.length;i++){ h=(h*31+s.charCodeAt(i))>>>0; } return 'h'+h.toString(16); }
function copyText(t){ if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(t).catch(()=>{}); } else { const ta=document.createElement('textarea'); ta.value=t; document.body.appendChild(ta); ta.select(); try{document.execCommand('copy');}catch(e){} document.body.removeChild(ta); } }
async function adminEnter(){
  const pwd=(document.getElementById('admin_pwd')||{}).value||'';
  if(!pwd){ toast('请输入密码'); return; }
  try{
    const rec=await api.getRow(ADMIN_ROW);
    if(!rec){ await api.setRow(ADMIN_ROW,{pwd:simpleHash(pwd)}); toast('管理员密码已设置'); }
    else if(rec.pwd!==simpleHash(pwd)){ toast('密码错误'); return; }
    sessionStorage.setItem('twb_admin_unlock','1');
    toast('管理员验证通过');
    renderSettings();
  }catch(e){ toast('操作失败：'+(e.message||'网络错误')+'（若提示 401，请先到「云端密钥」更新）'); }
}
function adminLogout(){ sessionStorage.removeItem('twb_admin_unlock'); renderSettings(); toast('已退出管理'); }
async function genKeys(){
  const n=Math.max(1, Math.min(50, parseInt((document.getElementById('gen_count')||{}).value||'1')||1));
  try{
    const reg=await api.getRow(KEYS_ROW) || {};
    const fresh=[];
    for(let i=0;i<n;i++){
      let k; do{ k='TWB-'+Math.random().toString(36).slice(2,8).toUpperCase(); }while(reg[k]);
      reg[k]={ name:'', ws:'ws_'+Math.random().toString(36).slice(2,12), createdAt:Date.now() };
      fresh.push(k);
    }
    await api.setRow(KEYS_ROW, reg);
    refreshKeys(fresh);
    toast('已生成 '+n+' 个密钥，点击密钥即可复制');
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
    const reg=await api.getRow(KEYS_ROW) || {};
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
    const reg=await api.getRow(KEYS_ROW) || {};
    if(reg[k]){ reg[k].name=v.trim(); await api.setRow(KEYS_ROW, reg); toast('已保存 '+esc(k)+' 的姓名为：'+esc(v||'(空)')); }
  }catch(e){ toast('保存姓名失败：'+(e.message||'网络错误')); }
}
async function revokeKey(k){
  if(!confirm('撤销密钥 '+k+'？\n该老师将不能再登录此密钥，但其云端数据会保留。'))return;
  try{
    const reg=await api.getRow(KEYS_ROW) || {};
    delete reg[k];
    await api.setRow(KEYS_ROW, reg);
    refreshKeys();
    toast('已撤销 '+k);
  }catch(e){ toast('撤销失败：'+(e.message||'网络错误')); }
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
