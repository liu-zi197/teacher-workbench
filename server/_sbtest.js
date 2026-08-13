// 临时验证：模拟浏览器直连 Supabase 的 upsert + 读取 逻辑
const https = require('https');
const SB_URL = 'https://pvlvxrcfhecvegkyemer.supabase.co';
const KEY = process.env.SBKEY;
const H = { 'Content-Type':'application/json', 'apikey':KEY, 'Authorization':'Bearer '+KEY, 'Prefer':'resolution=merge-duplicates,return=representation' };
function req(method, path, body){
  return new Promise((res,rej)=>{
    const data = body? JSON.stringify(body):null;
    const u = new URL(SB_URL + path);
    const r = https.request(u, {method, headers:H}, (resp)=>{
      let d=''; resp.on('data',c=>d+=c); resp.on('end',()=>res({status:resp.statusCode, body:d}));
    });
    r.on('error', rej); if(data) r.write(data); r.end();
  });
}
(async()=>{
  const ws = 'sbtest_ws_'+Date.now();
  console.log('① upsert 写入:', (await req('POST','/rest/v1/kv',{key:ws,value:{demo:true,n:1}})).status);
  console.log('② 读取:', (await req('GET','/rest/v1/kv?key=eq.'+encodeURIComponent(ws)+'&select=value')).body);
  console.log('③ 再次 upsert(更新):', (await req('POST','/rest/v1/kv',{key:ws,value:{demo:true,n:2}})).status);
  console.log('④ 读回更新值:', (await req('GET','/rest/v1/kv?key=eq.'+encodeURIComponent(ws)+'&select=value')).body);
  console.log('⑤ 删除测试行:', (await req('DELETE','/rest/v1/kv?key=eq.'+encodeURIComponent(ws))).status);
  console.log('DONE');
})();
