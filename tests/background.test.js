import test from 'node:test';
import assert from 'node:assert/strict';
let seq=0;
const clone=x=>structuredClone(x);
async function boot({pending=false,automatic=true,auth=true}={}){
  const listeners={},local={},session=auth?{auth:'Bearer TEST_SESSION_ONLY'}:{};
  let actual=1,failWrite=false,user=10,requests=[],notices=[];
  const config={keyId:7,model:'model-test',platform:'openai',automatic,paused:false};
  local.app={configs:[config],states:{7:{expectedGroupId:1,...(pending?{pending:{from:1,to:2}}:{})}},logs:[],notices:{},pricing:{verified:true,basis:'base-times-rate'},account:10};
  function area(data){return {get:async key=>({[key]:clone(data[key])}),set:async obj=>Object.assign(data,clone(obj)),remove:async key=>{delete data[key];},setAccessLevel:async()=>{}};}
  globalThis.chrome={storage:{local:area(local),session:area(session)},runtime:{id:'test-id',getURL:p=>'chrome-extension://test-id/'+p,onMessage:{addListener:fn=>listeners.message=fn},onStartup:{addListener:fn=>listeners.start=fn},onInstalled:{addListener:()=>{}},openOptionsPage:async()=>{}},notifications:{create:async(id,x)=>notices.push({id,...x})},webRequest:{onBeforeSendHeaders:{addListener:fn=>listeners.auth=fn},onBeforeRequest:{addListener:fn=>listeners.external=fn}},alarms:{get:async()=>({}),create:async()=>{},onAlarm:{addListener:()=>{}}},action:{onClicked:{addListener:()=>{}}}};
  globalThis.fetch=async (url,options)=>{
    const path=new URL(url).pathname;requests.push({path,method:options.method,body:options.body});
    const now=Date.now(),expires=new Date(now+90000).toISOString();
    const price={input_per_million:2,cache_input_per_million:.1,cache_write_per_million:2.5,output_per_million:10};
    const group=id=>({group_id:id,code:'FAKE-'+id,platform:'openai',rate_multiplier:id===1?1:.1,available:id!==1,probe_state:'enabled',probe_expires_at:expires,long_context_pricing_enabled:false,subscription_type:'standard',model_detection:{model:'model-test',status:'passed',applicable:true,execution_complete:true},group_models:[{model:'model-test',price}],summary_models:{'model-test':{effective_input_price_per_million:id===1?1:.1,effective_multiplier:.1,effective_multiplier_ready:true}},model_cards:[{model:'model-test',health:'healthy',probe_state:'enabled',health_expires_at:expires}]});
    let data;
    if(path==='/api/v1/auth/me')data={id:user};
    else if(path==='/api/v1/keys')data={pages:1,items:[{id:7,name:'Fake key',key:'SECRET_KEY_MUST_NOT_PERSIST',status:'active',group_id:actual,max_rate_multiplier:0}]};
    else if(path==='/api/v1/groups/available')data=[1,2].map(id=>({id,rate_multiplier:id===1?1:.1,peak_rate_enabled:false,subscription_type:'standard'}));
    else if(path==='/api/v1/groups/rates')data=null;
    else if(path==='/api/v2/public/providers')data={stale:false,generated_at:new Date(now).toISOString(),items:[group(1),group(2)]};
    else if(path==='/api/v1/keys/7/group'){
      actual=JSON.parse(options.body).group_id;
      if(failWrite)throw new Error('simulated response lost');
      data={group_id:actual,key:'SECRET_KEY_MUST_NOT_PERSIST'};
    }else throw new Error('Unexpected path '+path);
    return {ok:true,status:200,json:async()=>({code:0,data})};
  };
  await import(`../extension/background.js?test=${seq++}`);
  const send=message=>new Promise(resolve=>listeners.message(message,{id:'test-id',url:'chrome-extension://test-id/options.html'},resolve));
  return {send,local,session,listeners,requests,notices,setActual:n=>actual=n,setUser:n=>user=n,loseResponse:()=>failWrite=true};
}
test('background writes only group_id and persists no API key or session token',async()=>{
  const b=await boot();await b.send({type:'check'});
  const writes=b.requests.filter(r=>r.method==='PUT');assert.equal(writes.length,1);assert.deepEqual(JSON.parse(writes[0].body),{group_id:2});
  assert.equal(b.local.app.states[7].expectedGroupId,2);assert.equal(b.local.app.states[7].pending,null);
  assert.ok(!JSON.stringify(b.local).includes('SECRET_KEY'));assert.ok(!JSON.stringify(b.local).includes('TEST_SESSION'));
});
test('preview never sends PUT',async()=>{const b=await boot({automatic:false});await b.send({type:'check'});assert.equal(b.requests.filter(r=>r.method==='PUT').length,0);assert.match(b.local.app.states[7].status,/预览/);});
test('lost mutation response journals intent then next cycle reads back without replaying',async()=>{
  const b=await boot();b.loseResponse();await b.send({type:'check'});assert.equal(b.local.app.states[7].pending.to,2);
  await b.send({type:'check'});assert.equal(b.requests.filter(r=>r.method==='PUT').length,1);assert.equal(b.local.app.states[7].pending,null);assert.equal(b.local.app.states[7].expectedGroupId,2);
});
test('pending unchanged group pauses instead of blindly retrying',async()=>{const b=await boot({pending:true});await b.send({type:'check'});assert.equal(b.local.app.configs[0].paused,true);assert.equal(b.requests.filter(r=>r.method==='PUT').length,0);});
test('account changes pause all configurations before reading keys or writing',async()=>{const b=await boot();b.setUser(99);await b.send({type:'check'});assert.equal(b.local.app.configs[0].paused,true);assert.equal(b.requests.length,1);});
test('missing session is notified once across repeated polls',async()=>{const b=await boot({auth:false});await b.send({type:'check'});await b.send({type:'check'});assert.equal(b.notices.length,1);assert.equal(b.requests.length,0);});
test('external group changes pause instead of overwriting',async()=>{const b=await boot();b.setActual(3);await b.send({type:'check'});assert.equal(b.local.app.configs[0].paused,true);assert.equal(b.requests.filter(r=>r.method==='PUT').length,0);});
test('credentials are captured only from platform tab requests, not extension requests',async()=>{
  const b=await boot({auth:false});b.listeners.auth({tabId:-1,requestHeaders:[{name:'Authorization',value:'Bearer fake-extension'}]});
  await b.send({type:'state'});assert.equal(b.session.auth,undefined);
  b.listeners.auth({tabId:8,initiator:'https://aihub.top',requestHeaders:[{name:'Authorization',value:'Bearer fake-site'}]});await b.send({type:'state'});assert.equal(b.session.auth,'Bearer fake-site');
});
test('global strategy update resets inheriting keys only and preserves pending journal',async()=>{
  const b=await boot();await b.send({type:'state'});
  b.local.app.configs.push({keyId:8,strategy:{mode:'success'},paused:false});
  b.local.app.states[7]={candidate:2,count:2,pending:{from:1,to:2}};
  b.local.app.states[8]={candidate:9,count:2};
  const r=await b.send({type:'strategy',strategy:{mode:'latency'}});assert.equal(r.error,undefined);
  assert.equal(b.local.app.defaultStrategy.mode,'latency');assert.equal(b.local.app.states[7].count,0);
  assert.deepEqual(b.local.app.states[7].pending,{from:1,to:2});assert.equal(b.local.app.states[8].count,2);
});
test('configure validates and saves independent strategy or explicit inheritance',async()=>{
  const b=await boot();
  const base={type:'configure',keyId:7,model:'model-test',platform:'openai',automatic:false};
  const invalid=await b.send({...base,strategy:{mode:'weighted',weights:{price:0,latency:0,success:0}}});assert.ok(invalid.error);
  await b.send({...base,strategy:{mode:'success'}});assert.equal(b.local.app.configs[0].strategy.mode,'success');
  await b.send({...base,strategy:null});assert.equal(b.local.app.configs[0].strategy,null);
});
test('manual switch revalidates and pauses automation even in preview mode',async()=>{
  const b=await boot({automatic:false});
  const r=await b.send({type:'manualSwitch',keyId:7,target:2,expectedGroupId:1});
  assert.equal(r.error,undefined);assert.equal(b.requests.filter(x=>x.method==='PUT').length,1);
  assert.equal(b.local.app.configs[0].paused,true);assert.equal(b.local.app.states[7].expectedGroupId,2);
  assert.match(b.local.app.states[7].status,/手动切换成功/);
});
test('manual switch rejects unqualified or stale selection without writing',async()=>{
  for(const message of [{target:999,expectedGroupId:1},{target:2,expectedGroupId:3}]){
    const b=await boot();const r=await b.send({type:'manualSwitch',keyId:7,...message});
    assert.ok(r.error);assert.equal(b.requests.filter(x=>x.method==='PUT').length,0);assert.equal(b.local.app.configs[0].paused,true);
  }
});
test('manual lost-response journal is read back while key is paused, never replayed',async()=>{
  const b=await boot();b.loseResponse();await b.send({type:'manualSwitch',keyId:7,target:2,expectedGroupId:1});
  assert.equal(b.local.app.configs[0].paused,true);assert.equal(b.local.app.states[7].pending.to,2);
  await b.send({type:'check'});assert.equal(b.local.app.states[7].pending,null);assert.equal(b.requests.filter(x=>x.method==='PUT').length,1);
});
test('changing interval resets observations even for independent strategies',async()=>{
  const b=await boot();await b.send({type:'state'});b.local.app.configs[0].strategy={mode:'price'};b.local.app.states[7].count=2;
  await b.send({type:'strategy',strategy:{mode:'price'},checkMinutes:1});assert.equal(b.local.app.checkMinutes,1);assert.equal(b.local.app.states[7].count,0);
});
test('catalog connects using an already-open logged-in site tab without waiting for a new request',async()=>{
  const b=await boot({auth:false});
  globalThis.chrome.tabs={query:async()=>[{id:3}]};
  globalThis.chrome.scripting={executeScript:async()=>[{result:'FAKE_SITE_TOKEN'}]};
  const r=await b.send({type:'catalog'});
  assert.equal(r.error,undefined);assert.equal(r.result.keys[0].id,7);
  assert.equal(b.session.auth,'Bearer FAKE_SITE_TOKEN');assert.ok(!JSON.stringify(b.local).includes('FAKE_SITE_TOKEN'));
});
test('catalog stops waiting and reports an error when browser tab lookup hangs',async()=>{
  const b=await boot({auth:false});
  globalThis.chrome.tabs={query:()=>new Promise(()=>{})};
  const r=await b.send({type:'catalog'});
  assert.match(r.error,/超时/);
  assert.equal(b.requests.length,0);
  assert.ok((await b.send({type:'state'})).result);
});
