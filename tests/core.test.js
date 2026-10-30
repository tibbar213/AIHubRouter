import test from 'node:test';
import assert from 'node:assert/strict';
import {platformPrice,migrateApp,assess,decide,reconcilePending,INTERVAL,PLATFORMS,validateStrategy,DEFAULT_STRATEGY} from '../extension/core.js';
const now=Date.parse('2026-10-30T05:00:00Z');
const config={keyId:1,platform:'openai',model:'test-model'};
function group(id,cost=1,platform='openai'){return {group_id:id,code:`G${id}`,platform,rate_multiplier:1,available:true,probe_state:'enabled',probe_expires_at:new Date(now+INTERVAL*10).toISOString(),subscription_type:'standard',model_detection:{model:'test-model',status:'passed',applicable:true,execution_complete:true},group_models:[{model:'test-model'}],summary_models:{'test-model':{effective_input_price_per_million:cost,effective_multiplier:.1,effective_multiplier_ready:true,range_cache:{ready:true,stale:false}}},model_cards:[{model:'test-model',probe_state:'enabled',health:'healthy',health_expires_at:new Date(now+INTERVAL*10).toISOString()}]};}
function snapshot(items,time=now){return {items,stale:false,generated_at:new Date(time).toISOString()};}
function run(items,state={},time=now,extra={}){return decide({config,state,currentGroupId:1,snapshot:snapshot(items,time),now:time,globalStrategy:{mode:'price',rules:{confirmRounds:2}},...extra});}
test('uses selected-model real price verbatim, never raw rates or group aggregate',()=>{
  const g=group(1,.27);g.rate_multiplier=.0001;g.effective_input_price_per_million=.001;
  assert.deepEqual(platformPrice(g,'test-model'),{cost:.27,predictedMultiplier:.1});
  assert.equal(platformPrice(g,'different-model'),null);
});
test('real price sorts ahead of conflicting predicted multiplier and raw rate',()=>{
  const a=group(1,.5),b=group(2,.2);a.rate_multiplier=.01;b.rate_multiplier=10;
  a.summary_models['test-model'].effective_multiplier=.01;b.summary_models['test-model'].effective_multiplier=2;
  assert.equal(run([a,b]).state.candidate,2);
});
test('zero is a valid platform price; invalid or absent values do not fall back',()=>{
  assert.equal(platformPrice(group(1,0),'test-model').cost,0);
  for(const v of [null,undefined,NaN,Infinity,-1,'0.1']){const g=group(1);g.summary_models['test-model'].effective_input_price_per_million=v;assert.equal(platformPrice(g,'test-model'),null);}
});
test('missing or unready prediction hides companion value without blocking real price',()=>{
  const g=group(1,.2);g.summary_models['test-model'].effective_multiplier_ready=false;
  assert.deepEqual(platformPrice(g,'test-model'),{cost:.2,predictedMultiplier:null});
});
test('price cache explicitly stale or not ready is excluded',()=>{
  for(const cache of [{stale:true,ready:true},{stale:false,ready:false}]){
    const g=group(1);g.summary_models['test-model'].range_cache=cache;
    assert.equal(platformPrice(g,'test-model'),null);
  }
});
test('migration removes old formula settings, resets observations and preserves pending writes and opt-in',()=>{
  const app={configs:[{keyId:1,profile:{ratio:15},automatic:true,paused:true}],pricing:{verified:true},states:{1:{expectedGroupId:3,pending:{from:3,to:4},candidate:4,count:2,choices:[{cost:99}]} }};
  assert.equal(migrateApp(app),true);assert.equal(app.schemaVersion,6);
  assert.equal(app.pricing,undefined);assert.equal(app.configs[0].profile,undefined);
  assert.equal(app.configs[0].automatic,true);assert.equal(app.configs[0].paused,true);
  assert.equal(app.states[1].count,0);assert.equal(app.states[1].choices,undefined);
  assert.deepEqual(app.states[1].pending,{from:3,to:4});assert.equal(migrateApp(app),false);
});
test('two timed consecutive observations switch to same lowest candidate',()=>{
  const gs=[group(1,1),group(2,.5)],a=run(gs);
  assert.equal(a.target,null);assert.equal(a.state.count,1);
  assert.equal(run(gs,a.state,now+INTERVAL).target,2);
});
test('immediate manual polls cannot satisfy two observations',()=>{
  const gs=[group(1),group(2,.5)],a=run(gs);
  for(const delta of [1,1000,INTERVAL-2000])assert.equal(run(gs,a.state,now+delta).target,null);
});
test('missed interval and changed winning candidate restart observation',()=>{
  const a=run([group(1),group(2,.5)]);
  assert.equal(run([group(1),group(2,.5)],a.state,now+INTERVAL*2).target,null);
  const b=run([group(1),group(2,.6),group(3,.4)],a.state,now+INTERVAL);assert.equal(b.target,null);assert.equal(b.state.candidate,3);
});
test('ties retain current even if another group has lower ID',()=>{assert.equal(run([group(0),group(1)]).target,null);});
test('unhealthy, expired or missing current immediately selects healthy cheapest',()=>{
  for(const kind of ['failed','expired','missing']){
    const g=group(1);if(kind==='failed')g.model_cards[0].health='failed';else if(kind==='expired')g.model_cards[0].health_expires_at=new Date(now).toISOString();
    assert.equal(run([...(kind==='missing'?[]:[g]),group(2,.5)]).target,2);
  }
});
test('no qualified candidate retains current and requests notification',()=>{const a=run([]);assert.equal(a.target,null);assert.equal(a.notice,'no-candidate');});
test('external edits pause and pending writes never produce another target',()=>{
  assert.equal(run([group(1),group(2,.5)],{expectedGroupId:3}).pause,true);
  assert.equal(run([group(2,.5)],{pending:{from:1,to:2}}).target,null);
});
test('failed, unknown, stale, unsupported model and unsupported groups are excluded',()=>{
  for(const mutate of [g=>g.available=false,g=>g.availability_unknown=true,g=>g.bindable=false,g=>g.key_max_rate_multiplier=.1,g=>g.probe_state='disabled',g=>g.model_cards[0].health='insufficient',g=>g.group_models=[],g=>g.subscription_type='subscription',g=>g.probe_expires_at=null]){
    const g=group(1);mutate(g);assert.ok(assess(g,config,snapshot([g]),now).reason);
  }
  assert.ok(assess(group(1),config,{...snapshot([]),stale:true},now).reason);
  assert.ok(assess(group(1),config,snapshot([],now-INTERVAL-1),now).reason);
});
test('platform price remains usable with special billing flags and no token prices',()=>{
  const g={...group(1),long_context_pricing_enabled:true,peak_rate_enabled:true};
  g.group_models[0].price=undefined;
  assert.equal(assess(g,config,snapshot([g]),now).cost,1);
});
test('each platform and key chooses only its bound model',()=>{
  for(const platform of PLATFORMS){const a=run([group(1,1,platform),group(2,.5,platform),group(3,.01,'other')],{},now,{config:{...config,platform}});assert.equal(a.state.candidate,2);}
});
test('pending journal readback confirms target; unchanged or third group pauses',()=>{
  const s={pending:{from:1,to:2}};
  assert.equal(reconcilePending(s,2).state.expectedGroupId,2);
  assert.equal(reconcilePending(s,2).state.pending,null);
  assert.equal(reconcilePending(s,1).pause,true);
  assert.equal(reconcilePending(s,3).pause,true);
});
function measured(id,price,latency,success){
  const g=group(id,price);Object.assign(g.summary_models['test-model'],{user_latency_ms:latency,success_rate:success,sample_count:100});return g;
}
test('global latency strategy picks fastest even if real price is missing',()=>{
  const gs=[measured(1,1,3000,.99),measured(2,null,500,.9)];
  const a=run(gs,{},now,{globalStrategy:{mode:'latency'}});
  assert.equal(a.state.candidate,2);assert.equal(a.state.choices[0].cost,null);
});
test('per-key success strategy overrides global latency strategy',()=>{
  const gs=[measured(1,1,500,.9),measured(2,1,3000,.99)];
  assert.equal(run(gs,{},now,{globalStrategy:{mode:'latency'},config:{...config,strategy:{mode:'success'}}}).state.candidate,2);
});
test('weighted tradeoff follows weights and is invariant to weight sum',()=>{
  const gs=[measured(1,.1,3000,.9),measured(2,.5,500,.99)];
  const weighted=weights=>({mode:'weighted',weights});
  assert.equal(run(gs,{},now,{globalStrategy:weighted({price:70,latency:20,success:10})}).target,null);
  assert.equal(run(gs,{},now,{globalStrategy:weighted({price:10,latency:70,success:20})}).state.candidate,2);
  const a=run(gs,{},now,{globalStrategy:weighted({price:1,latency:7,success:2})});
  assert.equal(a.state.candidate,2);assert.equal(a.state.choices[0].score,90);
});
test('zero-weight missing metrics ignored; positive-weight missing metrics excluded',()=>{
  const gs=[group(1,1),group(2,.1)];
  const a=run(gs,{},now,{globalStrategy:{mode:'weighted',weights:{price:100,latency:0,success:0}}});assert.equal(a.state.candidate,2);
  const b=run(gs,{},now,{globalStrategy:{mode:'weighted',weights:{price:50,latency:50,success:0}}});assert.equal(b.notice,'no-candidate');
});
test('missing model metrics do not borrow group latency or success; zero samples excluded',()=>{
  const g=group(2,.1);g.user_latency_ms=1;g.success_rates={'1h':1};
  assert.equal(run([g],{},now,{globalStrategy:{mode:'latency'}}).notice,'no-candidate');
  Object.assign(g.summary_models['test-model'],{sample_count:0,user_latency_ms:1,success_rate:1});
  assert.equal(run([g],{},now,{globalStrategy:{mode:'success'}}).notice,'no-candidate');
});
test('equal weighted scores keep current and constant metrics never divide by zero',()=>{
  const gs=[measured(1,.1,1000,.95),measured(2,.2,1000,.99)];
  const a=run(gs,{},now,{globalStrategy:{mode:'weighted',weights:{price:50,latency:0,success:50}}});assert.equal(a.target,null);assert.equal(a.state.choices[0].score,50);
  const b=run(gs,{},now,{globalStrategy:{mode:'latency'}});assert.equal(b.target,null);assert.equal(b.state.choices[0].score,100);
});
test('strategy change restarts confirmation even when the same group remains best',()=>{
  const gs=[measured(1,1,3000,.9),measured(2,.1,500,.99)],a=run(gs);
  const b=run(gs,a.state,now+INTERVAL,{globalStrategy:{mode:'latency',rules:{confirmRounds:2}}});
  assert.equal(b.target,null);assert.equal(b.state.count,1);
});
test('bad weights and unknown modes are rejected; omitted weights have valid defaults',()=>{
  for(const s of [{mode:'other'},{mode:'weighted',weights:{price:0,latency:0,success:0}},{mode:'weighted',weights:{price:-1}},{mode:'weighted',weights:{price:Infinity}},{mode:'weighted',weights:{price:101}}])assert.throws(()=>validateStrategy(s));
  assert.deepEqual(validateStrategy({mode:'price'}),DEFAULT_STRATEGY);
});
test('model detection defaults on, rejects other model and incomplete results; toggle is explicit',()=>{
  for(const change of [g=>delete g.model_detection,g=>g.model_detection.model='other',g=>g.model_detection.status='suspected',g=>g.model_detection.execution_complete=false]){
    const g=group(1);change(g);assert.ok(assess(g,config,snapshot([g]),now).reason);
    assert.equal(assess(g,config,snapshot([g]),now,{...DEFAULT_STRATEGY,requireDetection:false}).cost,1);
  }
});
test('white/black list, quality thresholds and user limits are applied before ranking',()=>{
  const g=measured(2,.5,1500,.95);
  for(const rules of [{allowIds:[1]},{allowIds:[2],denyIds:[2]},{minSuccess:96},{minSamples:101},{maxLatency:1000},{maxPrice:.4},{maxRate:.5}])assert.ok(assess(g,config,snapshot([g]),now,validateStrategy({mode:'price',rules})).reason);
  assert.equal(assess(g,config,snapshot([g]),now,validateStrategy({mode:'price',rules:{allowIds:[2],minSuccess:95,minSamples:100,maxLatency:1500,maxPrice:.5,maxRate:1}})).cost,.5);
});
test('minimum improvement and cooldown block normal optimization, not failed-current recovery',()=>{
  const gs=[measured(1,1,1000,.9),measured(2,.95,900,.99)];
  const strategy={mode:'price',rules:{minImprovement:10,cooldownMinutes:30}};
  assert.match(run(gs,{},now,{globalStrategy:strategy}).state.status,/改善/);
  assert.match(run(gs,{lastSwitchAt:now-1000},now,{globalStrategy:strategy}).state.status,/冷却/);
  gs[0].available=false;
  assert.equal(run(gs,{lastSwitchAt:now-1000},now,{globalStrategy:strategy}).target,2);
});
test('custom confirmation rounds and poll interval control observation counts',()=>{
  const gs=[group(1,1),group(2,.5)],strategy={mode:'price',rules:{confirmRounds:3}};
  const a=run(gs,{},now,{globalStrategy:strategy,intervalMs:60000});
  const b=run(gs,a.state,now+60000,{globalStrategy:strategy,intervalMs:60000});assert.equal(b.target,null);
  assert.equal(run(gs,b.state,now+120000,{globalStrategy:strategy,intervalMs:60000}).target,2);
  assert.equal(run(gs,{},now,{globalStrategy:{mode:'price',rules:{confirmRounds:1}}}).target,2);
});
test('invalid filter limits, intervals and channel lists cannot be saved',()=>{
  for(const rules of [{minSuccess:101},{minSamples:1.2},{confirmRounds:0},{confirmRounds:7},{allowIds:['1']},{denyIds:[-1]},{cooldownMinutes:1441},{maxPrice:NaN}])assert.throws(()=>validateStrategy({mode:'price',rules}));
});
