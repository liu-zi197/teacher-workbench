import urllib.request, json, os, time
SB_URL='https://pvlvxrcfhecvegkyemer.supabase.co'
KEY=os.environ.get('SBKEY')
H={'Content-Type':'application/json','apikey':KEY,'Authorization':'Bearer '+KEY,'Prefer':'resolution=merge-duplicates,return=representation'}
def req(method,path,body=None):
    url=SB_URL+path
    data=json.dumps(body).encode() if body is not None else None
    r=urllib.request.Request(url,data=data,method=method,headers=H)
    try:
        resp=urllib.request.urlopen(r)
        return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
ws='sbp_'+str(int(time.time()))
print('① POST upsert #1:', req('POST','/rest/v1/kv',{'key':ws,'value':{'n':1}})[0])
print('② GET:', req('GET','/rest/v1/kv?key=eq.'+urllib.parse.quote(ws)+'&select=value')[1][:120])
print('③ POST upsert #2 (更新, 关键):', req('POST','/rest/v1/kv',{'key':ws,'value':{'n':2}})[0])
print('④ GET 更新值:', req('GET','/rest/v1/kv?key=eq.'+urllib.parse.quote(ws)+'&select=value')[1][:120])
print('⑤ DELETE:', req('DELETE','/rest/v1/kv?key=eq.'+urllib.parse.quote(ws))[0])
print('DONE')
