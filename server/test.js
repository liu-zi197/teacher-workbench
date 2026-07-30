const base = process.env.BASE || 'http://localhost:3000';
async function main(){
  let r = await fetch(base+'/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({key:'test-key-1', name:'王老师'})});
  let j = await r.json();
  console.log('1) login =>', JSON.stringify(j).slice(0,80));
  const token = j.token;

  r = await fetch(base+'/api/data', {headers:{Authorization:'Bearer '+token}});
  console.log('2) data GET (首次应为null) =>', (await r.json()).db === null ? 'null OK' : 'HAS DATA');

  r = await fetch(base+'/api/data', {method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer '+token}, body: JSON.stringify({db:{students:[{name:'小明'}], lessons:[]}})});
  console.log('3) data POST =>', JSON.stringify(await r.json()));

  r = await fetch(base+'/api/data', {headers:{Authorization:'Bearer '+token}});
  let d = await r.json();
  console.log('4) data GET (应读回) =>', d.db ? ('读回 students='+d.db.students.length+'人') : 'FAIL');

  r = await fetch(base+'/api/ai', {method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer '+token}, body: JSON.stringify({system:'你是出题助手', user:'出一道三年级乘法题'})});
  console.log('5) ai (无key应回退) =>', JSON.stringify(await r.json()).slice(0,80));

  r = await fetch(base+'/api/data');
  console.log('6) 未登录访问 data =>', r.status, '(应401)');

  r = await fetch(base+'/api/admin/issue', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({count:2})});
  console.log('7) 无管理员密钥发key =>', r.status, '(应403)');

  // 静态托管
  r = await fetch(base+'/index.html');
  console.log('8) 静态 index.html =>', r.status, r.headers.get('content-type'));
  r = await fetch(base+'/server/server.js');
  console.log('9) 禁止访问 server 源码 =>', r.status, '(应403)');

  console.log('\\n✅ 后端核心链路验证完成');
}
main().catch(e=>{ console.error('测试失败:', e); process.exit(1); });
