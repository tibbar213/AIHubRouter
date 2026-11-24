import test from 'node:test';
import assert from 'node:assert/strict';
let seq=0;
const clone=x=>structuredClone(x);
async function boot({pending=false,automatic=true,auth=true,noPrices=false,cacheRates=false,modelHealthOnly=false}={}){
  const listeners={},local={},session=auth?{auth:'Bearer TEST_SESSION_ONLY'}:{};
  let actual=1,failWrite=false,user=10,requests=[],notices=[],stale=false;
  const config={keyId:7,model:'model-test',platform:'openai',automatic,paused:false,strategy:{mode:'price'}};
  local.app={configs:[config],states:{7:{expectedGroupId:1,...(pending?{pending:{from:1,to:2}}:{})}},logs:[],notices:{},pricing:{verified:true,basis:'base-times-rate'},account:10};
  function area(data){return {get:async key=>({[key]:clone(data[key])}),set:async obj=>Object.assign(data,clone(obj)),remove:async key=>{delete data[key];},setAccessLevel:async()=>{}};}
  globalThis.chrome={storage:{local:area(local),session:area(session)},runtime:{id:'test-id',getURL:p=>'chrome-extension://test-id/'+p,onMessage:{addListener:fn=>listeners.message=fn},onStartup:{addListener:fn=>listeners.start=fn},onInstalled:{addListener:()=>{}},openOptionsPage:async()=>{}},notifications:{create:async(id,x)=>notices.push({id,...x})},webRequest:{onBeforeSendHeaders:{addListener:fn=>listeners.auth=fn},onBeforeRequest:{addListener:fn=>listeners.external=fn}},alarms:{get:async()=>({}),create:async()=>{},onAlarm:{addListener:()=>{}}},action:{onClicked:{addListener:()=>{}}}};
  globalThis.fetch=async (url,options)=>{
    const path=new URL(url).pathname;requests.push({path,method:options.method,body:options.body});
    const now=Date.now(),expires=new Date(now+90000).toISOString();
    const price={input_per_million:2,cache_input_per_million:.1,cache_write_per_million:2.5,output_per_million:10};
    const group=id=>({group_id:id,code:'FAKE-'+id,platform:'openai',rate_multiplier:id===1?1:.1,available:id!==1,probe_state:'enabled',probe_expires_at:expires,long_context_pricing_enabled:false,subscription_type:'standard',model_detection:{model:'model-test',status:'passed',applicable:true,execution_complete:true},group_models:[{model:'model-test',price}],summary_models:{'model-test':{}},model_cards:[{model:'model-test',health:'healthy',probe_state:'enabled',health_expires_at:expires}]});
    let data;
    if(path==='/api/v1/auth/me')data={id:user};
    else if(path==='/api/v1/keys')data={pages:1,items:[{id:7,name:'Fake key',key:'SECRET_KEY_MUST_NOT_PERSIST',status:'active',group_id:actual,max_rate_multiplier:0}]};
    else if(path==='/api/v1/groups/available')data=[1,2].map(id=>({id,rate_multiplier:id===1?1:.1,peak_rate_enabled:false,subscription_type:'standard'}));
    else if(path==='/api/v1/groups/rates')data=null;
    else if(path==='/api/v2/public/providers'){
      const items=[group(1),group(2),{...group(3),platform:'new-provider'}];
      if(modelHealthOnly){
        items.push(group(4));
        for(const g of items){
          g.visible_in_hall=g.group_id===1;
          g.available=false;
          g.detections_enabled=true;
          g.probe_skipped=false;
        }
        delete items[0].probe_state;
        delete items[0].probe_expires_at;
        delete items[0].model_cards[0].probe_state;
      }
      if(noPrices)for(const g of items){g.available=true;g.group_models[0].price={input_per_million:price.input_per_million};}
      if(cacheRates)for(const g of items){g.available=true;g.summary_models['model-test'].range_cache={ready:true,coverage_complete:true,stale:false,usage_records:10,refreshed_at:new Date(now).toISOString(),cache_hit_rate:g.group_id===1?.8:.9};}
      data={stale,generated_at:new Date(now).toISOString(),items};
    }
    else if(path==='/api/v1/keys/7/group'){
      actual=JSON.parse(options.body).group_id;
      if(failWrite)throw new Error('simulated response lost');
      data={group_id:actual,key:'SECRET_KEY_MUST_NOT_PERSIST'};
    }else throw new Error('Unexpected path '+path);
    return {ok:true,status:200,json:async()=>({code:0,data})};
  };
  const created=[];
  globalThis.chrome.tabs={query:async()=>[],create:async opts=>{created.push(opts);return {id:99};}};globalThis.chrome.scripting={executeScript:async()=>[]};
  await import(`../extension/background.js?test=${seq++}`);
  const send=message=>new Promise(resolve=>listeners.message(message,{id:'test-id',url:'chrome-extension://test-id/options.html'},resolve));
  return {send,local,session,listeners,requests,notices,created,setActual:n=>actual=n,setUser:n=>user=n,setStale:v=>stale=v,loseResponse:()=>failWrite=true};
}
test('stale platform snapshot reports expiry and never switches',async()=>{const b=await boot();b.setStale(true);await b.send({type:'check'});assert.match(b.local.app.lastError,/数据已过期/);assert.equal(b.requests.filter(r=>r.method==='PUT').length,0);});
test('background writes only group_id and persists no API key or session token',async()=>{
  const b=await boot();await b.send({type:'check'});
  const writes=b.requests.filter(r=>r.method==='PUT');assert.equal(writes.length,1);assert.deepEqual(JSON.parse(writes[0].body),{group_id:2});
  assert.equal(b.local.app.states[7].expectedGroupId,2);assert.equal(b.local.app.states[7].pending,null);
  assert.ok(!JSON.stringify(b.local).includes('SECRET_KEY'));assert.ok(!JSON.stringify(b.local).includes('TEST_SESSION'));
});
test('preview never sends PUT',async()=>{const b=await boot({automatic:false});await b.send({type:'check'});assert.equal(b.requests.filter(r=>r.method==='PUT').length,0);assert.match(b.local.app.states[7].status,/预览/);});
test('candidate preview includes healthy bindable groups with both Hall flags false',async()=>{
  const b=await boot({modelHealthOnly:true,automatic:false});
  await b.send({type:'check'});
  assert.deepEqual(b.local.app.states[7].choices.map(c=>c.id),[2,1]);
  assert.equal(b.local.app.states[7].excluded['当前账号不可绑定'],2);
  assert.match(b.local.app.states[7].status,/预览/);
  assert.equal(b.requests.filter(r=>r.method==='PUT').length,0);
});
test('automatic all-unpriced fallback writes the lower account rate and confirms readback',async()=>{
  const b=await boot({noPrices:true});await b.send({type:'check'});
  const writes=b.requests.filter(r=>r.method==='PUT');assert.equal(writes.length,1);
  assert.deepEqual(JSON.parse(writes[0].body),{group_id:2});
  assert.equal(b.local.app.states[7].rankingBasis,'accountMultiplier');
  assert.equal(b.local.app.states[7].expectedGroupId,2);
  assert.equal(b.local.app.states[7].status,'已确认切换成功');
  assert.equal(b.local.app.states[7].pending,null);
  await b.send({type:'check'});assert.equal(b.requests.filter(r=>r.method==='PUT').length,1);
  assert.match(b.local.app.states[7].status,/同倍率不切/);
  const preview=await boot({noPrices:true,automatic:false});await preview.send({type:'check'});
  assert.equal(preview.requests.filter(r=>r.method==='PUT').length,0);
});

test('per-key cache threshold persists and prevents writes without model cache data',async()=>{
  const b=await boot();
  const result=await b.send({type:'keyStrategy',keyId:7,strategy:{mode:'price',rules:{minCacheHit:80}}});
  assert.equal(result.error,undefined);assert.equal(b.local.app.configs[0].strategy.rules.minCacheHit,80);
  await b.send({type:'check'});
  assert.equal(b.requests.filter(r=>r.method==='PUT').length,0);
  assert.equal(b.local.app.states[7].excluded['指定模型缓存率未知或数据未就绪'],1);
});

test('lost mutation response journals intent then next cycle reads back without replaying',async()=>{
  const b=await boot();b.loseResponse();await b.send({type:'check'});assert.equal(b.local.app.states[7].pending.to,2);
  await b.send({type:'check'});assert.equal(b.requests.filter(r=>r.method==='PUT').length,1);assert.equal(b.local.app.states[7].pending,null);assert.equal(b.local.app.states[7].expectedGroupId,2);
});
test('pending unchanged group pauses instead of blindly retrying',async()=>{const b=await boot({pending:true});await b.send({type:'check'});assert.equal(b.local.app.configs[0].paused,true);assert.equal(b.requests.filter(r=>r.method==='PUT').length,0);});
test('account changes pause all configurations before reading keys or writing',async()=>{const b=await boot();b.setUser(99);await b.send({type:'check'});assert.equal(b.local.app.configs[0].paused,true);assert.equal(b.requests.length,1);});
test('missing session is notified once across repeated polls',async()=>{const b=await boot({auth:false});await b.send({type:'check'});await b.send({type:'check'});assert.equal(b.notices.length,1);assert.equal(b.requests.length,0);});
test('external group changes update baseline without pausing or writing in same cycle',async()=>{const b=await boot();b.setActual(3);await b.send({type:'check'});assert.equal(b.local.app.configs[0].paused,false);assert.equal(b.local.app.states[7].expectedGroupId,3);assert.equal(b.requests.filter(r=>r.method==='PUT').length,0);});
test('detection toggle creates per-key strategy while preserving global settings',async()=>{const b=await boot();await b.send({type:'state'});await b.send({type:'toggleKey',keyId:7,field:'requireDetection',enabled:false});assert.equal(b.local.app.configs[0].strategy.requireDetection,false);assert.equal(b.local.app.defaultStrategy.requireDetection,true);});
test('resuming a paused key preserves config and allows a later automatic check',async()=>{
  const b=await boot();
  await b.send({type:'toggleKey',keyId:7,field:'excludeWarnings',enabled:true});
  assert.equal(b.local.app.configs[0].strategy.mode,'price');
  const config=clone(b.local.app.configs[0]);
  await b.send({type:'pause',keyId:7});
  assert.equal(b.local.app.configs[0].paused,true);
  assert.equal((await b.send({type:'resume',keyId:7})).error,undefined);
  assert.deepEqual(b.local.app.configs[0],config);
  assert.equal(b.requests.filter(r=>r.method==='PUT').length,0);
  await b.send({type:'check'});
  assert.equal(b.requests.filter(r=>r.method==='PUT').length,1);
});
test('resume blocks unresolved switches and a different platform account',async()=>{
  const b=await boot({pending:true});
  await b.send({type:'pause',keyId:7});
  const pending=await b.send({type:'resume',keyId:7});
  assert.match(pending.error,/核实上次切换结果/);
  assert.equal(b.requests.length,0);
  await b.send({type:'check'});
  b.setUser(99);
  const mismatch=await b.send({type:'resume',keyId:7});
  assert.match(mismatch.error,/账号/);
  assert.equal(b.local.app.configs[0].paused,true);
  assert.equal(b.requests.filter(r=>r.method==='PUT').length,0);
});
test('catalog deduplicates the model across platforms and configure stores the model alone',async()=>{
  const b=await boot();const catalog=await b.send({type:'catalog'});
  assert.deepEqual(catalog.result.models.map(m=>m.model),['model-test']);
  assert.ok(catalog.result.models[0].minPrice===null||Number.isFinite(catalog.result.models[0].minPrice));
  await b.send({type:'remove',keyId:7});
  const result=await b.send({type:'configure',keyId:7,model:'model-test',automatic:false});
  assert.equal(result.error,undefined);
  assert.equal(b.local.app.configs[0].model,'model-test');
  assert.equal(Object.hasOwn(b.local.app.configs[0],'platform'),false);
});
test('credentials are captured only from platform tab requests, not extension requests',async()=>{
  const b=await boot({auth:false});b.listeners.auth({tabId:-1,requestHeaders:[{name:'Authorization',value:'Bearer fake-extension'}]});
  await b.send({type:'state'});assert.equal(b.session.auth,undefined);
  b.listeners.auth({tabId:8,initiator:'https://aihub.top',requestHeaders:[{name:'Authorization',value:'Bearer fake-site'}]});await b.send({type:'state'});assert.equal(b.session.auth,'Bearer fake-site');
});
test('editing the default template preserves existing key strategies and observations',async()=>{
  const b=await boot();await b.send({type:'state'});
  b.local.app.configs.push({keyId:8,strategy:{mode:'balanced'},paused:false});
  b.local.app.states[7]={candidate:2,count:2,pending:{from:1,to:2}};
  b.local.app.states[8]={candidate:9,count:2};
  const r=await b.send({type:'strategy',strategy:{mode:'weighted'}});assert.equal(r.error,undefined);
  assert.equal(b.local.app.defaultStrategy.mode,'weighted');assert.equal(b.local.app.configs[0].strategy.mode,'price');assert.equal(b.local.app.states[7].count,2);
  assert.deepEqual(b.local.app.states[7].pending,{from:1,to:2});assert.equal(b.local.app.states[8].count,2);
});
test('configure copies the default for new keys and preserves the strategy on rebinding',async()=>{
  const b=await boot();
  const base={type:'configure',keyId:7,model:'model-test',automatic:false};
  const invalid=await b.send({...base,strategy:{mode:'weighted',weights:{price:0,latency:0,success:0}}});assert.ok(invalid.error);
  await b.send({...base,strategy:{mode:'balanced'}});assert.equal(b.local.app.configs[0].strategy.mode,'balanced');
  await b.send({type:'strategy',strategy:{mode:'weighted'}});
  await b.send(base);assert.equal(b.local.app.configs[0].strategy.mode,'balanced');
  await b.send({type:'remove',keyId:7});
  await b.send(base);assert.equal(b.local.app.configs[0].strategy.mode,'weighted');
});
test('inline strategy updates only the selected key and preserves its monitoring controls',async()=>{
  const b=await boot();
  await b.send({type:'state'});
  b.local.app.configs[0].strategy.requireDetection=false;
  b.local.app.configs[0].excludeWarnings=true;
  b.local.app.configs[0].paused=true;
  b.local.app.configs.push({keyId:8,strategy:{mode:'balanced'},paused:false});
  b.local.app.states[7].count=2;
  b.local.app.states[8]={candidate:9,count:2};
  const change=await b.send({type:'keyStrategy',keyId:7,strategy:{mode:'weighted',weights:{latency:100},rules:{confirmRounds:3}}});
  assert.equal(change.error,undefined);
  const [updated,other]=b.local.app.configs;
  assert.equal(updated.strategy.mode,'weighted');
  assert.equal(updated.strategy.rules.confirmRounds,3);
  assert.equal(updated.strategy.requireDetection,false);
  assert.equal(updated.automatic,true);
  assert.equal(updated.excludeWarnings,true);
  assert.equal(updated.paused,true);
  assert.equal(other.strategy.mode,'balanced');
  assert.equal(b.local.app.defaultStrategy.mode,'balanced');
  assert.equal(b.local.app.states[7].count,0);
  assert.equal(b.local.app.states[8].count,2);
  assert.equal(b.requests.length,0);
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
test('scheduled checks reconnect from an open site tab after session loss',async()=>{
  const b=await boot({auth:false,automatic:false});await b.send({type:'check'});assert.match(b.local.app.lastError,/登录已失效/);
  chrome.tabs.query=async()=>[{id:3}];chrome.scripting.executeScript=async()=>[{result:'RENEWED_TEST_SESSION'}];
  await b.send({type:'check'});assert.equal(b.local.app.lastError,null);assert.equal(b.local.app.notices['read-AUTH'],undefined);assert.equal(b.session.auth,'Bearer RENEWED_TEST_SESSION');assert.equal(b.requests.filter(x=>x.method==='PUT').length,0);
});
test('manual check reports the real error instead of success when the platform is unreachable',async()=>{
  const b=await boot({auth:false,automatic:false});
  const manual=(await b.send({type:'check',manual:true})).result;
  assert.equal(manual.ok,false);assert.match(manual.error,/登录已失效/);
  // 定时检查仍然只记录错误、返回成功，不打扰用户。
  const scheduled=(await b.send({type:'check'})).result;
  assert.equal(scheduled.ok,true);
});
test('manual check connects to the platform even when no monitor is running, scheduled check does not',async()=>{
  const b=await boot({automatic:false});b.local.app.configs[0].paused=true;
  await b.send({type:'check'});
  assert.equal(b.requests.length,0);
  const manual=(await b.send({type:'check',manual:true})).result;
  assert.equal(manual.ok,true);assert.match(manual.note,/没有运行中的监控/);
  assert.ok(b.requests.some(r=>r.path==='/api/v1/auth/me'));
  assert.equal(b.requests.filter(r=>r.method==='PUT').length,0);
  assert.equal(b.local.app.lastError,null);
});
test('expired cached credentials are replaced once and identity is rechecked',async()=>{
  const b=await boot({automatic:false}),original=globalThis.fetch;let rejected=false;
  globalThis.fetch=async(url,options)=>{if(new URL(url).pathname==='/api/v1/auth/me'&&!rejected){rejected=true;return {status:401,ok:false};}return original(url,options);};
  chrome.tabs.query=async()=>[{id:3}];chrome.scripting.executeScript=async()=>[{result:'RENEWED_TEST_SESSION'}];
  await b.send({type:'check'});assert.equal(b.local.app.lastError,null);assert.equal(b.session.auth,'Bearer RENEWED_TEST_SESSION');assert.equal(b.requests.filter(x=>x.method==='PUT').length,0);
});
test('catalog stops waiting and reports an error when browser tab lookup hangs',async()=>{
  const b=await boot({auth:false});
  globalThis.chrome.tabs={query:()=>new Promise(()=>{})};
  const r=await b.send({type:'catalog'});
  assert.match(r.error,/超时/);
  assert.equal(b.requests.length,0);
  assert.ok((await b.send({type:'state'})).result);
});

test('changing a key strategy keeps the last candidate list visible until the next check',async()=>{
  const b=await boot({automatic:false});await b.send({type:'check'});
  const before=b.local.app.states[7].choices.map(c=>c.id);assert.ok(before.length);
  const r=await b.send({type:'keyStrategy',keyId:7,strategy:{mode:'balanced'}});assert.equal(r.error,undefined);
  const s=b.local.app.states[7];
  assert.deepEqual(s.choices.map(c=>c.id),before);assert.equal(s.choicesOutdated,true);assert.equal(s.count,0);
  await b.send({type:'check'});
  assert.equal(b.local.app.states[7].choicesOutdated,undefined);assert.ok(b.local.app.states[7].choices);
});

test('opening the providers page on connection failure is opt-in, throttled and skipped when a tab exists',async()=>{
  const b=await boot({auth:false});
  await b.send({type:'check'});
  assert.deepEqual(b.created,[]);
  assert.equal((await b.send({type:'autoOpen',enabled:true})).error,undefined);
  assert.equal(b.local.app.autoOpenProviders,true);
  await b.send({type:'check'});
  assert.deepEqual(b.created,[{url:'https://aihub.top/providers',active:false}]);
  await b.send({type:'check'});
  assert.equal(b.created.length,1);
  b.local.app.lastAutoOpenAt=0;
  chrome.tabs.query=async()=>[{id:3}];
  await b.send({type:'check'});
  assert.equal(b.created.length,1);
  chrome.tabs.query=async()=>[];
  b.local.app.lastAutoOpenAt=0;
  assert.ok((await b.send({type:'catalog'})).error);
  assert.equal(b.created.length,2);
  b.local.app.lastAutoOpenAt=0;
  await b.send({type:'autoOpen',enabled:false});
  await b.send({type:'check'});
  assert.equal(b.created.length,2);
  assert.ok((await b.send({type:'autoOpen',enabled:'yes'})).error);
});

test('manual switch is refused without pausing while the candidate list is outdated',async()=>{
  const b=await boot({automatic:false});await b.send({type:'check'});
  await b.send({type:'keyStrategy',keyId:7,strategy:{mode:'balanced'}});
  const r=await b.send({type:'manualSwitch',keyId:7,target:2,expectedGroupId:1});
  assert.match(r.error,/重新检查/);
  assert.equal(b.local.app.configs[0].paused,false);
  assert.equal(b.requests.filter(x=>x.method==='PUT').length,0);
});

test('catalog opens the providers page when the key list rejects the session after identity',async()=>{
  const b=await boot();const original=globalThis.fetch;
  globalThis.fetch=async(url,options)=>new URL(url).pathname==='/api/v1/keys'?{status:401,ok:false}:original(url,options);
  await b.send({type:'autoOpen',enabled:true});
  assert.ok((await b.send({type:'catalog'})).error);
  assert.deepEqual(b.created,[{url:'https://aihub.top/providers',active:false}]);
});

test('an external group change keeps an outdated candidate list marked outdated',async()=>{
  const b=await boot({automatic:false});await b.send({type:'check'});
  await b.send({type:'keyStrategy',keyId:7,strategy:{mode:'balanced'}});
  b.setActual(3);await b.send({type:'check'});
  assert.equal(b.local.app.states[7].expectedGroupId,3);assert.equal(b.local.app.states[7].choicesOutdated,true);
  await b.send({type:'check'});assert.equal(b.local.app.states[7].choicesOutdated,undefined);
});

test('a rejected outdated manual switch does not pause the key on the next check',async()=>{
  const b=await boot({automatic:false});await b.send({type:'check'});
  await b.send({type:'keyStrategy',keyId:7,strategy:{mode:'balanced'}});
  assert.ok((await b.send({type:'manualSwitch',keyId:7,target:2,expectedGroupId:1})).error);
  await b.send({type:'check'});
  assert.equal(b.local.app.configs[0].paused,false);
  assert.equal(b.local.app.states[7].choicesOutdated,undefined);
});

test('a catalog 401 after identity does not record the session as recovered',async()=>{
  const b=await boot({auth:false,automatic:false});await b.send({type:'check'});
  assert.equal(b.local.app.notices['read-AUTH'],true);
  b.session.auth='Bearer TEST_SESSION_ONLY';const original=globalThis.fetch;
  globalThis.fetch=async(url,options)=>new URL(url).pathname==='/api/v1/keys'?{status:401,ok:false}:original(url,options);
  assert.ok((await b.send({type:'catalog'})).error);
  assert.equal(b.local.app.notices['read-AUTH'],true);
  assert.ok(!b.local.app.logs.some(l=>/会话已恢复/.test(l.text)));
});
