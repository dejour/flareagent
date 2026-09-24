"""Integration checks against the local Cloudflare Vite dev server; never use on production."""
import concurrent.futures, json, os, urllib.request, urllib.error, uuid
BASE=os.environ.get('TEST_BASE_URL','http://localhost:3000')
assert BASE.startswith('http://localhost:') or BASE.startswith('http://127.0.0.1:'), 'Local dev only'
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))
USER='test-'+str(uuid.uuid4())
def call(path,method='GET',body=None,user=USER,origin=None):
    headers={'Content-Type':'application/json'}
    if user: headers.update({'x-cloudagent-test-user':user})
    if origin: headers['Origin']=origin
    req=urllib.request.Request(BASE+'/api/'+path,data=json.dumps(body).encode() if body is not None else None,headers=headers,method=method)
    try:
        with urllib.request.urlopen(req) as r:return r.status,json.load(r)
    except urllib.error.HTTPError as e:
        raw=e.read().decode()
        try: data=json.loads(raw)
        except json.JSONDecodeError: data={'error':raw[:300]}
        return e.code,data
def check(condition,label):
    assert condition,label
    print('PASS',label)
check(call('workspace',user=None)[0]==401,'anonymous API access rejected')
check(call('projects','POST',{'name':'x'},origin='https://outside.example')[0]==403,'cross-origin mutation rejected')
check(call('projects','POST',{'name':''})[0]==400,'invalid project rejected')
status,data=call('projects','POST',{'name':'Integration project','description':'Task isolation checks'})
check(status==201,'project creation');project=data['project']['id']
body={'prompt':'Verify durable task lifecycle','projectId':project,'requestId':str(uuid.uuid4())}
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool: results=list(pool.map(lambda _:call('tasks','POST',body),range(3)))
check(all(s==201 for s,_ in results) and len({d['task']['id'] for _,d in results})==1,'concurrent idempotent task creation')
task=results[0][1]['task']['id']
check(call('tasks','POST',{**body,'prompt':'Different prompt'})[0]==409,'idempotency key payload conflict rejected')
status,data=call('tasks/'+task)
check(status==200 and len(data['events'])==2 and data['task']['status']=='waiting_auth','task and initial events persisted')
check(call('tasks/'+task,user='another-user')[0]==404,'cross-user task read rejected')
check(call('tasks','POST',{**body,'requestId':str(uuid.uuid4())},user='another-user')[0]==404,'cross-user project reference rejected')
check(call('tasks/'+task,'PATCH',{'action':'cancel'},user='another-user')[0]==404,'cross-user task mutation rejected')
check(call('tasks/'+task+'/events','POST',{'content':'Additional acceptance criteria'})[0]==201,'follow-up persisted')
check(call('tasks/'+task,'PATCH',{'action':'cancel'})[0]==200,'cancel task')
check(call('tasks/'+task+'/events','POST',{'content':'Should fail'})[0]==409,'cancelled task rejects follow-up')
check(call('tasks/'+task,'PATCH',{'action':'cancel'})[0]==200,'repeated cancel is idempotent')
check(call('tasks/'+task,'PATCH',{'action':'resume'})[0]==200,'resume task')
status,data=call('tasks/'+task)
check(len(data['events'])==5 and data['task']['status']=='waiting_auth','all lifecycle events present without duplicates')
check(call('tasks/'+task,'PATCH',{'action':'complete'})[0]==400,'client cannot invent completion')
check(call('connections/openai','POST',{})[0]==503,'unconfigured execution reported truthfully')
check(any(t['id']==task for t in call('workspace')[1]['tasks']),'task available after fresh request')
print('All integration checks passed. Test data is local and isolated under',USER)
