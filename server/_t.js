const https = require('https');
const KEY = process.env.SBKEY;
console.log('KEY present:', !!KEY, 'len:', (KEY||'').length);
const H = { 'Content-Type':'application/json', 'apikey':KEY, 'Authorization':'Bearer '+KEY, 'Prefer':'resolution=merge-duplicates,return=representation' };
const ws = 'sbtest_'+Date.now();
const body = JSON.stringify({key:ws, value:{demo:true,n:1}});
const u = new URL('https://pvlvxrcfhecvegkyemer.supabase.co/rest/v1/kv');
const r = https.request(u, {method:'POST', headers:H}, (resp)=>{
  let d=''; resp.on('data',c=>d+=c); resp.on('end',()=>console.log('status', resp.statusCode, 'body', d.slice(0,200)));
});
r.on('error', e=>console.log('ERR', e.message));
r.write(body); r.end();
