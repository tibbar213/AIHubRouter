import test from 'node:test';
import assert from 'node:assert/strict';
import {platformPrice,migrateApp,assess,decide,reconcilePending,INTERVAL,PLATFORMS,validateStrategy,DEFAULT_STRATEGY,providerBadgeDetails} from '../extension/core.js';
const now=Date.parse('2026-10-30T05:00:00Z');
const config={keyId:1,platform:'openai',model:'test-model'};
function group(id,cost=1,platform='openai'){return {group_id:id,code:`G${id}`,platform,rate_multiplier:1,bindable:true,available:true,probe_state:'enabled',probe_expires_at:new Date(now+INTERVAL*10).toISOString(),subscription_type:'standard',model_detection:{model:'test-model',status:'passed',applicable:true,execution_complete:true},group_models:[{model:'test-model'}],summary_models:{'test-model':{effective_input_price_per_million:cost,effective_multiplier:.1,effective_multiplier_ready:true,range_cache:{ready:true,stale:false}}},model_cards:[{model:'test-model',probe_state:'enabled',health:'healthy',health_expires_at:new Date(now+INTERVAL*10).toISOString()}]};}
function snapshot(items,time=now){return {items,stale:false,generated_at:new Date(time).toISOString()};}
function run(items,state={},time=now,extra={}){return decide({config,state,currentGroupId:1,snapshot:snapshot(items,time),now:time,globalStrategy:{mode:'price',rules:{confirmRounds:2}},...extra});}
test('Gemini models are eligible using the same model-specific rules',()=>{
  const candidate=group(2,.2,'gemini');
  assert.ok(PLATFORMS.includes('gemini'));
  assert.equal(assess(candidate,{...config,platform:'gemini'},snapshot([candidate]),now).cost,.2);
});
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
test('Hall spending rank and warnings are display data and leave routing unchanged',()=>{
  const a=group(1,.5),b=group(2,.2);
  const baseline=run([a,b],{},now,{globalStrategy:{mode:'price'}});
  const expires=new Date(now+60000).toISOString();
  a.badges_expires_at=b.badges_expires_at=expires;
  a.badges={popularity:{status:'measured',rank:1,groups:214,window:'24h',expires_at:expires},warnings:[]};
  const highError={value:32.47,threshold:20,operator:'>=',window:'7d',complete:false,available:true};
  b.badges={popularity:{status:'measured',rank:8,groups:214,window:'24h',expires_at:expires},warnings:[{
    id:'high_error',status:'active',triggers:[{...highError,value:25,window:'24h'},highError,
      {...highError,value:50,expires_at:new Date(now).toISOString()}]
  }]};
  const result=run([a,b],{},now,{globalStrategy:{mode:'price'}});
  assert.equal(result.target,baseline.target);
  assert.deepEqual(result.state.choices.map(x=>[x.id,x.score]),baseline.state.choices.map(x=>[x.id,x.score]));
  const hall=result.state.choices[0].hall;
  const details=providerBadgeDetails(hall,now);
  assert.equal(details.popularity.rank,8);
  assert.equal(details.popularity.window,'24h');
  assert.deepEqual(details.warnings,[{id:'high_error',trigger:highError}]);
  assert.equal(details.partial,true);
  assert.equal(providerBadgeDetails(hall,now+60000),null);
  assert.equal(providerBadgeDetails(undefined,now),null);
});
test('zero is a valid platform price; invalid or absent values do not fall back',()=>{
  assert.equal(platformPrice(group(1,0),'test-model').cost,0);
  for(const v of [null,undefined,NaN,Infinity,-1,'0.1']){const g=group(1);g.summary_models['test-model'].effective_input_price_per_million=v;assert.equal(platformPrice(g,'test-model'),null);}
});
test('optional Hall warning filter rejects active warnings and ignores expired or partial-only data',()=>{
  const warned=group(2,.1),expires=new Date(now+60000).toISOString();
  const warning={id:'high_error',status:'active',triggers:[{value:32,threshold:20,operator:'>=',window:'7d',expires_at:expires}]};
  warned.badges={warnings:[warning]};
  warned.badges_expires_at=expires;
  const scoped={config:{...config,excludeWarnings:true}};
  assert.equal(run([warned]).target,2);
  const filtered=run([warned],{},now,scoped);
  assert.equal(filtered.target,null);
  assert.deepEqual(filtered.state.excluded,{'平台告警':1});
  warning.status='partial';
  assert.equal(run([warned],{},now,scoped).target,2);
  warning.status='active';
  warning.triggers[0].expires_at=new Date(now).toISOString();
  assert.equal(run([warned],{},now,scoped).target,2);
  warning.triggers[0].expires_at=expires;
  warned.badges_expires_at=new Date(now).toISOString();
  assert.equal(run([warned],{},now,scoped).target,2);
});
test('an explicit price cap excludes missing prices until they can be checked',()=>{
  const blocked=group(1,.3),unhealthy=group(2,.1);
  const summary=blocked.summary_models['test-model'];
  summary.effective_input_price_per_million=null;
  blocked.group_models[0].price={input_per_million:2,output_per_million:8,cache_input_per_million:0};
  blocked.badges={warnings:[]};
  blocked.badges_expires_at=new Date(now+60000).toISOString();
  unhealthy.model_cards[0].health='unhealthy';
  const capped={globalStrategy:{mode:'price',rules:{maxPrice:.4}}};
  const first=run([blocked,unhealthy],{},now,capped);
  assert.equal(first.target,null);
  assert.deepEqual(first.state.choices,[]);
  assert.deepEqual(first.state.priceUnavailableChoices,[{
    id:1,code:'G1',hall:{badges:blocked.badges,expiresAt:blocked.badges_expires_at},
    reason:'指定模型真实价格缺失或未就绪',channelPrice:blocked.group_models[0].price
  }]);
  assert.equal(first.state.excluded['指定模型真实价格缺失或未就绪'],1);
  summary.effective_input_price_per_million=.3;
  const recovered=run([blocked,unhealthy],first.state,now,capped);
  assert.deepEqual(recovered.state.choices.map(choice=>choice.id),[1]);
  assert.deepEqual(recovered.state.priceUnavailableChoices,[]);
});
test('a usable unpriced current group stays eligible and is kept alongside priced alternatives',()=>{
  const current=group(1,null),priced=group(2,.1);
  current.group_models[0].price={input_per_million:2};
  const result=run([current,priced]);
  assert.equal(result.target,null);
  assert.equal(result.notice,undefined);
  assert.equal(result.state.status,'当前分组可用，真实价格暂不可比较');
  assert.deepEqual(result.state.choices.map(choice=>choice.id),[2,1]);
  assert.equal(result.state.choices[1].score,null);
  assert.equal(result.state.choices[1].cost,null);
  assert.deepEqual(result.state.choices[1].channelPrice,current.group_models[0].price);
});
test('price-based strategies can recover to eligible channels when no prices are available',()=>{
  const current=group(1,.1),slower=measured(2,null,3000,.95),faster=measured(3,null,1000,.98);
  current.available=false;
  const items=[current,faster,slower];
  const byPrice=run(items);
  assert.equal(byPrice.target,2);
  assert.deepEqual(byPrice.state.choices.map(choice=>choice.id),[2,3]);
  const weighted={globalStrategy:{mode:'weighted',weights:{price:80,latency:20,success:0}}};
  const byWeighted=run(items,{},now,weighted);
  assert.equal(byWeighted.target,3);
  slower.summary_models['test-model'].effective_input_price_per_million=.4;
  assert.equal(run(items,{},now,weighted).target,2);
});

test('all unpriced channels use account rates with confirmation, ties and improvement rules',()=>{
  const current=group(1,null),a=group(2,null),b=group(3,null);
  current.rate_multiplier=.2;a.rate_multiplier=.13;b.rate_multiplier=.12;
  a.public_rate_multiplier=.01;b.public_rate_multiplier=2;
  const items=[current,a,b],first=run(items);
  assert.equal(first.target,null);
  assert.equal(first.state.rankingBasis,'accountMultiplier');
  assert.deepEqual(first.state.choices.map(x=>x.id),[3,2,1]);
  assert.ok(first.state.choices.every(x=>x.cost===null));
  const next=run(items,first.state,now+INTERVAL);
  assert.equal(next.target,3);assert.match(next.state.status,/按账号倍率/);
  assert.equal(run(items,first.state,now+1000).state.count,1);
  current.rate_multiplier=.12;
  assert.equal(run(items).target,null);
  assert.match(run(items).state.status,/同倍率不切/);
  current.rate_multiplier=.2;
  assert.equal(run(items,{},now,{globalStrategy:{mode:'price',rules:{minImprovement:41}}}).target,null);
  assert.equal(run(items,{lastSwitchAt:now},now,{globalStrategy:{mode:'price',rules:{cooldownMinutes:1}}}).target,null);
});

test('explicit rate mode uses account rates regardless of real prices and retains equal rates',()=>{
  const current=group(1,.01),other=group(2,10);
  current.rate_multiplier=.2;other.rate_multiplier=.12;
  current.public_rate_multiplier=.01;other.public_rate_multiplier=10;
  const extra={globalStrategy:{mode:'rate',rules:{confirmRounds:2}}};
  const first=run([current,other],{},now,extra);
  assert.equal(first.state.candidate,2);assert.equal(first.target,null);
  assert.equal(first.state.rankingBasis,'rate');
  assert.equal(run([current,other],first.state,now+INTERVAL,extra).target,2);
  other.summary_models['test-model'].effective_input_price_per_million=null;
  assert.equal(run([current,other],{},now,{globalStrategy:{mode:'rate'}}).target,2);
  assert.equal(run([current,other],{},now,{globalStrategy:{mode:'rate',rules:{minImprovement:41}}}).target,null);
  assert.equal(run([current,other],{lastSwitchAt:now},now,{globalStrategy:{mode:'rate',rules:{cooldownMinutes:1}}}).target,null);
  other.rate_multiplier=.2;
  assert.equal(run([current,other],{},now,extra).target,null);
  assert.match(run([current,other],{},now,extra).state.status,/同倍率不切/);
  for(const rate of [undefined,null,-1,NaN,Infinity,'0.1']){
    other.rate_multiplier=rate;
    assert.deepEqual(run([current,other],{},now,extra).state.excluded,{'账号倍率无效或未知':1});
  }
  other.rate_multiplier=0;
  assert.equal(run([current,other],{},now,{globalStrategy:{mode:'rate'}}).target,2);
});

test('rate fallback never invents rates or bypasses price caps and resets when prices recover',()=>{
  const current=group(1,null),other=group(2,null);current.rate_multiplier=.2;other.rate_multiplier=0;
  assert.equal(run([current,other],{},now,{globalStrategy:{mode:'price'}}).target,2);
  other.rate_multiplier=undefined;
  assert.equal(run([current,other]).target,null);
  current.available=false;
  const recovery=run([current,other]);assert.equal(recovery.target,null);
  assert.match(recovery.state.status,/账号倍率也不可比较/);
  current.available=true;other.rate_multiplier=.1;
  assert.deepEqual(run([current,other],{},now,{globalStrategy:{mode:'price',rules:{maxPrice:1}}}).state.choices,[]);
  const first=run([current,other]);
  current.summary_models['test-model'].effective_input_price_per_million=.5;
  other.summary_models['test-model'].effective_input_price_per_million=.1;
  const priced=run([current,other],first.state,now+INTERVAL);
  assert.equal(priced.state.rankingBasis,'price');assert.equal(priced.state.count,1);assert.equal(priced.target,null);
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
test('sample-limited grok price estimate participates in selection and uses the verified public rate',()=>{
  const g=group(2,1,'grok');g.rate_multiplier=.13;g.public_rate_multiplier=.13;g.group_models[0].model='grok-4.7';g.model_cards[0].model='grok-4.7';g.model_detection.model='grok-4.7';
  g.summary_models={'grok-4.7':{effective_input_price_per_million:null,effective_multiplier_reason:'insufficient_samples',range_cache:{ready:true,coverage_complete:true,stale:false,refreshed_at:new Date(now).toISOString(),pricing_models:{'grok-4.7':{usage_records:71,sol_equivalent_unit_price:.6847290640394089,unknown_context_records:0,long_input_tokens:0,long_cache_read_tokens:0,long_cache_creation_tokens:0}}}}};
  const c={...config,platform:'grok',model:'grok-4.7'},result=decide({config:c,currentGroupId:1,snapshot:snapshot([g]),now});
  assert.ok(Math.abs(result.state.choices[0].cost-.08901477832512317)<1e-14);assert.equal(result.state.choices[0].estimated,true);assert.equal(result.state.choices[0].priceSamples,71);assert.equal(result.target,2);
  for(const [platform,model] of [['gemini','gemini-4-argon'],['kimi','future-model'],['new-provider','new-model']]){const other=structuredClone(g),summary=other.summary_models['grok-4.7'];other.platform=platform;other.group_models[0].model=model;other.model_cards[0].model=model;other.model_detection.model=model;summary.range_cache.pricing_models[model]=summary.range_cache.pricing_models['grok-4.7'];other.summary_models={[model]:summary};const estimate=assess(other,{...config,platform,model},snapshot([other]),now);assert.equal(estimate.estimated,true);assert.ok(Math.abs(estimate.cost-.08901477832512317)<1e-14);}
  for(const change of [x=>x.rate_multiplier=.2,x=>x.summary_models['grok-4.7'].range_cache.stale=true,x=>x.summary_models['grok-4.7'].range_cache.coverage_complete=false,x=>x.summary_models['grok-4.7'].range_cache.pricing_models['grok-4.7'].unknown_context_records=1,x=>x.summary_models['grok-4.7'].range_cache.refreshed_at=new Date(now-INTERVAL-1).toISOString()]){const altered=structuredClone(g);change(altered);assert.equal(platformPrice(altered,'grok-4.7',now),null);}
  const accountRateDiffers=structuredClone(g);
  accountRateDiffers.rate_multiplier=.2;
  const noSamples=structuredClone(g);
  noSamples.summary_models[c.model].effective_multiplier_reason='no_qualifying_requests';
  noSamples.summary_models[c.model].range_cache.ready=false;
  assert.equal(assess(accountRateDiffers,c,snapshot([accountRateDiffers]),now).priceReason,'账号倍率与公开倍率不同，无法估算价格');
  assert.equal(assess(noSamples,c,snapshot([noSamples]),now).priceReason,'指定模型没有可计价样本');
});

function cachePricedGroup(id,hit,rate){
  const g=group(id,null),read=Math.round(hit*1000),input=1000-read;
  g.rate_multiplier=rate;g.public_rate_multiplier=.045;
  g.group_models[0].price={input_per_million:1,cache_input_per_million:.02};
  g.summary_models[config.model].range_cache={ready:true,coverage_complete:true,stale:false,usage_records:10,refreshed_at:new Date(now).toISOString(),cache_hit_rate:hit,
    pricing_models:{[config.model]:{usage_records:10,input_tokens:input,cache_read_tokens:read,cache_creation_tokens:0,baseline_input_per_million:5,sol_equivalent_unit_price:(5*input+.5*read)/1000,unknown_context_records:0,long_input_tokens:0,long_cache_read_tokens:0,long_cache_creation_tokens:0}}};
  return g;
}

test('missing prices use cache rate and account rate in the platform equivalent-price unit',()=>{
  const current=cachePricedGroup(1,.8,.12),other=cachePricedGroup(2,.95,.2);
  const result=run([current,other],{},now,{globalStrategy:{mode:'price'}});
  assert.equal(result.target,2);
  assert.deepEqual(result.state.choices.map(x=>x.id),[2,1]);
  assert.ok(Math.abs(result.state.choices[0].cost-.145)<1e-12);
  assert.ok(Math.abs(result.state.choices[1].cost-.168)<1e-12);
  assert.equal(result.state.choices[0].estimateKind,'cache-rate');
  assert.equal(result.state.choices[0].estimated,true);
  assert.deepEqual(result.state.choices[0].estimateBasis,{inputPrice:5,cacheInputPrice:.5,cacheHit:.95,accountMultiplier:.2});
  current.summary_models[config.model].effective_input_price_per_million=.14;
  const mixed=run([current,other],{},now,{globalStrategy:{mode:'price'}});
  assert.equal(mixed.target,null);assert.equal(mixed.state.choices[0].estimated,false);
  assert.equal(mixed.state.choices[0].cost,.14);
  current.summary_models[config.model].effective_input_price_per_million=0;
  assert.equal(platformPrice(current,config.model,now).cost,0);
  current.summary_models[config.model].effective_input_price_per_million=null;
  const capped=run([current,other],{},now,{globalStrategy:{mode:'price',rules:{maxPrice:.15,minCacheHit:90}}});
  assert.deepEqual(capped.state.choices.map(x=>x.id),[2]);assert.equal(capped.state.excluded['缓存率低于下限'],1);
  other.rate_multiplier=0;assert.equal(platformPrice(other,config.model,now).cost,0);
});

test('cache-price estimates require fresh model data and a valid comparable pricing basis',()=>{
  for(const change of [g=>g.rate_multiplier=undefined,g=>g.summary_models[config.model].range_cache.stale=true,g=>g.summary_models[config.model].range_cache.refreshed_at=new Date(now-INTERVAL-1).toISOString(),g=>delete g.summary_models[config.model].range_cache.pricing_models,
    g=>g.summary_models[config.model].range_cache.pricing_models[config.model].cache_creation_tokens=1,g=>g.summary_models[config.model].range_cache.pricing_models[config.model].long_input_tokens=1,
    g=>g.summary_models[config.model].range_cache.pricing_models[config.model].baseline_input_per_million=null]){
    const g=cachePricedGroup(2,.8,.12);change(g);assert.equal(platformPrice(g,config.model,now),null);
  }
  for(const hit of [0,1]){
    const g=cachePricedGroup(2,hit,.12),price=platformPrice(g,config.model,now);
    assert.ok(Math.abs(price.cost-(hit===0?.6:.06))<1e-12);
  }
  const current=cachePricedGroup(1,.8,.12),other=cachePricedGroup(2,.95,.2);
  const first=run([current,other]);assert.equal(first.target,null);
  assert.equal(run([current,other],first.state,now+INTERVAL).target,2);
});
test('migration removes old formula settings, resets observations and preserves pending writes and opt-in',()=>{
  const app={configs:[{keyId:1,profile:{ratio:15},automatic:true,paused:true}],pricing:{verified:true},states:{1:{expectedGroupId:3,pending:{from:3,to:4},candidate:4,count:2,choices:[{cost:99}]} }};
  assert.equal(migrateApp(app),true);assert.equal(app.schemaVersion,8);
  assert.equal(app.pricing,undefined);assert.equal(app.configs[0].profile,undefined);
  assert.equal(app.configs[0].automatic,true);assert.equal(app.configs[0].paused,true);
  assert.equal(app.states[1].count,0);assert.equal(app.states[1].choices,undefined);
  assert.deepEqual(app.states[1].pending,{from:3,to:4});assert.equal(migrateApp(app),false);
});
test('schema 7 copies each effective strategy without clearing observations or pending writes',()=>{
  const pending={from:1,to:2};
  const app={schemaVersion:7,defaultStrategy:{mode:'weighted',rules:{allowIds:[2]}},
    configs:[{keyId:1,strategy:null,automatic:true,paused:true,excludeWarnings:true},{keyId:2,strategy:{mode:'success'}}],
    states:{1:{pending,candidate:2,count:1,observedAt:now}}
  };
  assert.equal(migrateApp(app),true);
  assert.deepEqual(app.configs[0].strategy,app.defaultStrategy);
  assert.equal(app.configs[1].strategy.mode,'success');
  assert.equal(app.configs[0].paused,true);
  assert.equal(app.configs[0].excludeWarnings,true);
  assert.deepEqual(app.states[1],{pending,candidate:2,count:1,observedAt:now});
  app.defaultStrategy.rules.allowIds.push(3);
  assert.deepEqual(app.configs[0].strategy.rules.allowIds,[2]);
  assert.equal(migrateApp(app),false);
});
test('migration resumes only keys paused due to external group changes',()=>{
  const app={schemaVersion:6,configs:[{keyId:1,paused:true},{keyId:2,paused:true},{keyId:3,paused:true}],states:{1:{status:'检测到外部改组，已暂停'},2:{status:'已手动暂停'},3:{status:'检测到外部改组，已暂停',pending:{from:1,to:2}}}};
  migrateApp(app);assert.equal(app.configs[0].paused,false);assert.equal(app.configs[1].paused,true);assert.equal(app.configs[2].paused,true);
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
test('external edits reset baseline and pending writes never produce another target',()=>{
  const result=run([group(1),group(2,.5)],{expectedGroupId:3});assert.equal(result.externalChange,true);assert.equal(result.state.expectedGroupId,1);assert.equal(result.target,null);
  assert.equal(run([group(2,.5)],{pending:{from:1,to:2}}).target,null);
});
test('failed, unknown, stale, unsupported model and unsupported groups are excluded',()=>{
  for(const mutate of [g=>g.available=false,g=>g.availability_unknown=true,g=>g.bindable=false,g=>g.key_max_rate_multiplier=.1,g=>g.probe_state='disabled',g=>g.model_cards[0].health='insufficient',g=>g.group_models=[],g=>g.subscription_type='subscription',g=>g.probe_expires_at=null]){
    const g=group(1);mutate(g);assert.ok(assess(g,config,snapshot([g]),now).reason);
  }
  assert.ok(assess(group(1),config,{...snapshot([]),stale:true},now).reason);
  assert.ok(assess(group(1),config,snapshot([],now-INTERVAL-1),now).reason);
});
test('Hall detects availability from a fresh card for the exact configured model',()=>{
  const g={...group(1),visible_in_hall:true,detections_enabled:true,available:false,availability_unknown:true};
  delete g.probe_state;
  delete g.probe_expires_at;
  delete g.model_cards[0].probe_state;
  const check=()=>assess(g,config,snapshot([g]),now);
  assert.equal(check().cost,1);

  g.model_cards.push({...g.model_cards[0],model:'other-model'});
  g.model_cards[0].health='failed';
  assert.match(check().reason,/指定模型.*不健康/);
  g.model_cards[0].health='healthy';
  g.model_cards[0].probe_state='disabled';
  assert.match(check().reason,/指定模型未启用探测/);
  delete g.model_cards[0].probe_state;
  g.model_cards[0].health_expires_at=new Date(now).toISOString();
  assert.match(check().reason,/模型健康状态过期/);
});
test('authenticated Hall fields do not veto a fresh card for a bindable group',()=>{
  const g={...group(1),visible_in_hall:false,available:false,detections_enabled:true,probe_skipped:false};
  const check=(overrides={})=>{
    const candidate={...g,...overrides};
    return assess(candidate,config,snapshot([candidate]),now);
  };
  assert.equal(check().cost,1);
  assert.equal(check({visible_in_hall:true}).cost,1);
  assert.equal(check({visible_in_hall:undefined,available:undefined}).cost,1);
  assert.match(check({detections_enabled:false}).reason,/未启用探测/);
  assert.match(check({probe_state:undefined,probe_skipped:true}).reason,/未启用探测/);
  assert.match(check({bindable:false}).reason,/账号不可绑定/);
  assert.match(check({bindable:undefined}).reason,/账号不可绑定/);
  assert.match(check({model_detection:{status:'detection_failed'}}).reason,/检测未通过/);
});
test('platform price remains usable with special billing flags and no token prices',()=>{
  const g={...group(1),long_context_pricing_enabled:true,peak_rate_enabled:true};
  g.group_models[0].price=undefined;
  assert.equal(assess(g,config,snapshot([g]),now).cost,1);
});
test('each platform and key chooses only its bound model',()=>{
  for(const platform of PLATFORMS){const a=run([group(1,1,platform),group(2,.5,platform),group(3,.01,'other')],{},now,{config:{...config,platform}});assert.equal(a.state.candidate,2);}
});
test('pending readback pauses if unchanged and accepts a third group without retrying',()=>{
  const s={pending:{from:1,to:2}};
  assert.equal(reconcilePending(s,2).state.expectedGroupId,2);
  assert.equal(reconcilePending(s,2).state.pending,null);
  assert.equal(reconcilePending(s,1).pause,true);
  assert.equal(reconcilePending(s,3).state.expectedGroupId,3);assert.equal(reconcilePending(s,3).state.pending,null);
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
test('channel detection rejects failed or incomplete results; toggle is explicit',()=>{
  for(const change of [g=>delete g.model_detection,g=>g.model_detection.status='suspected',g=>g.model_detection.status='detection_failed',g=>g.model_detection.execution_complete=false]){
    const g=group(1);change(g);assert.equal(assess(g,config,snapshot([g]),now).reason,'检测未通过');
    assert.equal(assess(g,config,snapshot([g]),now,{...DEFAULT_STRATEGY,requireDetection:false}).cost,1);
  }
});
test('passed channel detection accepts a different detection model',()=>{
  const g=group(1);g.model_detection.model='different-model';g.model_detection.stages={text:{model:'another-model'}};
  const result=assess(g,config,snapshot([g]),now);assert.equal(result.cost,1);assert.match(result.detection,/检测 different-model/);
});
test('a wrong candy answer overrides a platform pass and excludes the cheaper channel',()=>{
  const current=group(1,1), cheaper=group(2,.1), suspected=group(3,.2);
  const text={question:'最少取出多少个糖果才能满足要求？',answer:'34',result:true};
  cheaper.model_detection.presentation={text};
  suspected.model_detection.status='suspected';
  const rejected=run([current,cheaper,suspected]);
  assert.deepEqual(rejected.state.choices.map(choice=>choice.id),[1]);
  assert.deepEqual(rejected.state.excluded,{'检测未通过':2});
  assert.equal(rejected.target,null);
  text.answer='\n 21 ';
  assert.equal(assess(cheaper,config,snapshot([cheaper]),now).cost,.1);
  text.result=false;
  assert.equal(assess(cheaper,config,snapshot([cheaper]),now).reason,'检测未通过');
});
test('over-limit channels are excluded from choices and counted by reason',()=>{
  const current=group(1,1),blocked=group(2,.01);blocked.key_max_rate_multiplier=.5;
  const result=run([current,blocked]);assert.equal(result.target,null);assert.deepEqual(result.state.choices.map(x=>x.id),[1]);assert.equal(result.state.excluded['超过此 key 的倍率上限'],1);
});
test('passed detection may omit optional completion fields but explicit false rejects',()=>{
  const g=group(1);delete g.model_detection.execution_complete;delete g.model_detection.applicable;assert.equal(assess(g,config,snapshot([g]),now).cost,1);
  g.model_detection.applicable=false;assert.ok(assess(g,config,snapshot([g]),now).reason);
});
test('white/black list, quality thresholds and user limits are applied before ranking',()=>{
  const g=measured(2,.5,1500,.95);
  for(const rules of [{allowIds:[1]},{allowIds:[2],denyIds:[2]},{minSuccess:96},{minSamples:101},{maxLatency:1000},{maxPrice:.4},{maxRate:.5}])assert.ok(assess(g,config,snapshot([g]),now,validateStrategy({mode:'price',rules})).reason);
  assert.equal(assess(g,config,snapshot([g]),now,validateStrategy({mode:'price',rules:{allowIds:[2],minSuccess:95,minSamples:100,maxLatency:1500,maxPrice:.5,maxRate:1}})).cost,.5);
});

test('cache rate priority ranks descending, confirms switches and respects improvement and cooldown',()=>{
  const current=group(1,.01),other=group(2,null);
  const cache=rate=>({ready:true,coverage_complete:true,stale:false,usage_records:10,refreshed_at:new Date(now).toISOString(),cache_hit_rate:rate});
  current.summary_models[config.model].range_cache=cache(.8);
  other.summary_models[config.model].range_cache=cache(.9);
  const extra={globalStrategy:{mode:'cacheHit',rules:{confirmRounds:2}}};
  const first=run([current,other],{},now,extra);
  assert.deepEqual(first.state.choices.map(x=>x.id),[2,1]);
  assert.equal(first.state.rankingBasis,'cacheHit');assert.equal(first.target,null);
  assert.equal(run([current,other],first.state,now+INTERVAL,extra).target,2);
  assert.equal(run([current,other],first.state,now+1000,extra).state.count,1);
  for(const rules of [{minImprovement:13},{cooldownMinutes:1}])assert.equal(run([current,other],{lastSwitchAt:now},now,{globalStrategy:{mode:'cacheHit',rules}}).target,null);
  assert.equal(run([current,other],{},now,{globalStrategy:{mode:'cacheHit',rules:{minImprovement:12.5}}}).target,2);
  other.summary_models[config.model].range_cache=cache(.8);
  assert.equal(run([current,other],{},now,extra).target,null);
  current.summary_models[config.model].range_cache=cache(0);other.summary_models[config.model].range_cache=cache(1);
  assert.equal(run([current,other],{},now,{globalStrategy:{mode:'cacheHit'}}).target,2);
  for(const mutate of [c=>c.cache_hit_rate=null,c=>c.stale=true,c=>c.ready=false,c=>c.refreshed_at=new Date(now-INTERVAL-1).toISOString()]){
    other.summary_models[config.model].range_cache=cache(.9);mutate(other.summary_models[config.model].range_cache);
    const result=run([current,other],{},now,extra);
    assert.deepEqual(result.state.choices.map(x=>x.id),[1]);assert.equal(result.state.excluded['指定模型缓存率未知或数据未就绪'],1);
  }
});

test('minimum model cache hit rate filters before ranking across strategies',()=>{
  const current=group(1,1),other=group(2,.1);
  const cache=rate=>({ready:true,coverage_complete:true,stale:false,usage_records:10,refreshed_at:new Date(now).toISOString(),cache_hit_rate:rate});
  current.summary_models[config.model].range_cache=cache(.8);
  other.summary_models[config.model].range_cache=cache(.79);
  for(const mode of ['price','rate','cacheHit','latency','success','weighted']){
    for(const g of [current,other])Object.assign(g.summary_models[config.model],{sample_count:10,user_latency_ms:1000,success_rate:1});
    const result=run([current,other],{},now,{globalStrategy:{mode,rules:{minCacheHit:80}}});
    assert.equal(result.target,null);assert.deepEqual(result.state.choices.map(x=>x.id),[1]);
    assert.equal(result.state.choices[0].cacheHit,.8);assert.equal(result.state.excluded['缓存率低于下限'],1);
  }
  other.summary_models[config.model].range_cache=cache(.9);
  current.summary_models[config.model].range_cache=cache(.79);
  assert.equal(run([current,other],{},now,{globalStrategy:{mode:'price',rules:{minCacheHit:80,cooldownMinutes:60}}}).target,2);
  for(const mutate of [c=>c.cache_hit_rate=null,c=>c.cache_hit_rate=1.1,c=>c.cache_hit_rate='0.9',c=>c.ready=false,c=>c.stale=true,c=>c.coverage_complete=false,c=>c.usage_records=0,c=>c.refreshed_at=new Date(now-INTERVAL-1).toISOString(),c=>c.refreshed_at=new Date(now+60001).toISOString()]){
    const g=group(2,.1);g.cache_hit_rate=1;g.summary_models[config.model].range_cache=cache(.9);
    mutate(g.summary_models[config.model].range_cache);
    assert.equal(run([g],{},now,{globalStrategy:{mode:'price',rules:{minCacheHit:80}}}).target,null);
    assert.equal(run([g],{},now,{globalStrategy:{mode:'price'}}).target,2);
  }
  for(const value of [-1,101,NaN,Infinity,'80'])assert.throws(()=>validateStrategy({mode:'price',rules:{minCacheHit:value}}));
  assert.equal(validateStrategy({mode:'price'}).rules.minCacheHit,0);
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
