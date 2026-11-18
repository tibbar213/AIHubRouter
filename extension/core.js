export const PLATFORMS = ['openai','kimi','zhipu','grok','deepseek','gemini'];
export const INTERVAL = 300000;
export const PRICE_SOURCE = 'platform-effective-price-v1';
export const DEFAULT_RULES=Object.freeze({minSuccess:0,minCacheHit:0,minSamples:0,maxLatency:0,maxPrice:0,maxRate:0,allowIds:Object.freeze([]),denyIds:Object.freeze([]),confirmRounds:1,cooldownMinutes:0,minImprovement:0});
export const DEFAULT_STRATEGY = Object.freeze({mode:'price',weights:Object.freeze({price:70,latency:20,success:10}),requireDetection:true,rules:DEFAULT_RULES});
export function validateStrategy(strategy) {
  if (!strategy || !['price','rate','cacheHit','latency','success','weighted'].includes(strategy.mode)) throw new Error('排序方式无效');
  const weights={...DEFAULT_STRATEGY.weights,...strategy.weights};
  if (!['price','latency','success'].every(k=>typeof weights[k]==='number' && Number.isFinite(weights[k]) && weights[k]>=0 && weights[k]<=100)) throw new Error('权重必须为 0 至 100 的数字');
  if (strategy.mode==='weighted' && weights.price+weights.latency+weights.success<=0) throw new Error('请至少给一个因素设置正权重');
  if(strategy.requireDetection!=null && typeof strategy.requireDetection!=='boolean')throw new Error('模型检测筛选设置无效');
  const rules={...DEFAULT_RULES,...strategy.rules};
  for(const k of ['minSuccess','minCacheHit','minSamples','maxLatency','maxPrice','maxRate','confirmRounds','cooldownMinutes','minImprovement'])if(typeof rules[k]!=='number'||!Number.isFinite(rules[k])||rules[k]<0)throw new Error('筛选和切换数值必须为非负数字');
  if(rules.minSuccess>100||rules.minCacheHit>100||rules.minImprovement>100||!Number.isInteger(rules.confirmRounds)||rules.confirmRounds<1||rules.confirmRounds>6||!Number.isInteger(rules.minSamples)||rules.cooldownMinutes>1440)throw new Error('成功率/缓存率/改善幅度应为0–100，确认轮数1–6，样本数为整数，冷却不超过1440分钟');
  for(const k of ['allowIds','denyIds']){if(!Array.isArray(rules[k])||rules[k].length>1000||!rules[k].every(x=>Number.isSafeInteger(x)&&x>0))throw new Error('渠道名单请填写正整数分组 ID');rules[k]=[...new Set(rules[k])];}
  return {mode:strategy.mode,weights:{price:weights.price,latency:weights.latency,success:weights.success},requireDetection:strategy.requireDetection!==false,rules};
}
export function detectionInfo(group,model){
  const d=group.model_detection;
  if(!d)return {passed:false,label:'未检测'};
  const textResult=d.presentation?.text;
  const isCandyQuestion=typeof textResult?.question==='string' && textResult.question.includes('糖果');
  const answer=textResult?.answer;
  const correctAnswer=answer===21 || (typeof answer==='string' && answer.trim()==='21');
  const candyFailed=isCandyQuestion && (!correctAnswer || textResult.result===false);
  const passed=d.status==='passed' && d.applicable!==false && d.execution_complete!==false && !candyFailed;
  const label=candyFailed?'糖果题未通过（答案应为 21）':passed?'检测通过':({suspected:'存疑',detection_failed:'检测失败',not_tested:'未检测'})[d.status]||'检测未通过或未完成';
  return {passed,label:label+(d.model&&d.model!==model?`（检测 ${d.model}）`:'')};
}
export function strategyLabel(strategy) {
  const s=validateStrategy(strategy);
  if(s.mode!=='weighted')return {price:'真实价格优先',rate:'账号倍率优先',cacheHit:'缓存率更高优先',latency:'首响应更快优先',success:'成功率更高优先'}[s.mode];
  const total=Object.values(s.weights).reduce((a,b)=>a+b,0);
  return `加权：价格 ${(s.weights.price/total*100).toFixed(1)}% · 延迟 ${(s.weights.latency/total*100).toFixed(1)}% · 成功率 ${(s.weights.success/total*100).toFixed(1)}%`;
}
const validPrice = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
function modelCacheHit(summary,now){
  const cache=summary?.range_cache,refreshed=Date.parse(cache?.refreshed_at);
  return cache?.ready===true && cache.coverage_complete===true && cache.stale===false &&
    Number.isSafeInteger(cache.usage_records) && cache.usage_records>0 &&
    Number.isFinite(refreshed) && now-refreshed<=INTERVAL && refreshed<=now+60000 &&
    validPrice(cache.cache_hit_rate) && cache.cache_hit_rate<=1 ? cache.cache_hit_rate : null;
}
function cacheRateEstimate(group,model,summary,now){
  const cacheHit=modelCacheHit(summary,now);
  if(cacheHit===null)return {reason:'指定模型缓存率未知或数据未就绪'};
  if(!validPrice(group.rate_multiplier))return {reason:'账号倍率无效，无法估算价格'};
  // The platform's effective price is SOL-equivalent, not the public USD model price.
  // Recover its cache-read basis from the exact model's normalized sample cost.
  const sample=summary.range_cache.pricing_models?.[model];
  if(!sample || !validPrice(sample.baseline_input_per_million) || !validPrice(sample.sol_equivalent_unit_price) ||
    !Number.isSafeInteger(sample.usage_records) || sample.usage_records<=0 ||
    !['input_tokens','cache_read_tokens','cache_creation_tokens'].every(k=>Number.isSafeInteger(sample[k])&&sample[k]>=0))return {reason:'指定模型等效计价基准或样本缺失'};
  if(sample.cache_creation_tokens!==0 || sample.unknown_context_records!==0 || sample.long_input_tokens!==0 || sample.long_cache_read_tokens!==0 || sample.long_cache_creation_tokens!==0)return {reason:'缓存率估算样本含缓存写入、长上下文或上下文不明确'};
  const baseline=sample.baseline_input_per_million,total=sample.input_tokens+sample.cache_read_tokens;
  if(!Number.isSafeInteger(total)||total<=0 || (sample.cache_read_tokens===0&&cacheHit>0))return {reason:'指定模型缓存读取计价基准缺失'};
  const recovered=sample.cache_read_tokens>0?(sample.sol_equivalent_unit_price*total-baseline*sample.input_tokens)/sample.cache_read_tokens:baseline;
  if(!Number.isFinite(recovered)||recovered< -1e-9)return {reason:'指定模型等效计价基准不一致'};
  const cachePrice=Math.max(0,recovered);
  const cost=group.rate_multiplier*(baseline*(1-cacheHit)+cachePrice*cacheHit);
  return validPrice(cost)?{cost,predictedMultiplier:null,estimated:true,estimateKind:'cache-rate',sampleCount:summary.range_cache.usage_records,
    estimateBasis:{inputPrice:baseline,cacheInputPrice:cachePrice,cacheHit,accountMultiplier:group.rate_multiplier}
  }:{reason:'缓存率估算价格无效'};
}
function priceAssessment(group, model, now) {
  // Match ProviderHall's selected-model projection and effectivePrice sort.
  // The predicted multiplier is a companion display value, never another price unit.
  const summary = group.summary_models?.[model];
  if (!summary) return {reason:'平台未返回指定模型的计价数据'};
  const cache = summary.range_cache;
  if (cache?.stale === true) return {reason:'指定模型计价数据已过期'};
  if (!validPrice(summary.effective_input_price_per_million)) {
    const estimated=cacheRateEstimate(group,model,summary,now);
    if(!estimated.reason)return estimated;
    const reason = summary.effective_multiplier_reason;
    if (reason === 'no_qualifying_requests' || reason === 'no_samples') return {reason:'指定模型没有可计价样本'};
    if (reason !== 'insufficient_samples') return {reason:modelCacheHit(summary,now)===null?'指定模型真实价格缺失或未就绪':estimated.reason};
    if (cache?.ready !== true || cache.coverage_complete !== true || cache.stale !== false) return {reason:'指定模型估算数据未就绪或不完整'};
    const refreshed = Date.parse(cache.refreshed_at);
    if (!Number.isFinite(refreshed) || now - refreshed > INTERVAL || refreshed > now + 60000) return {reason:'指定模型估算数据过期或时间异常'};
    const sample = cache.pricing_models?.[model];
    if (!sample || !Number.isSafeInteger(sample.usage_records) || sample.usage_records <= 0 || !validPrice(sample.sol_equivalent_unit_price)) return {reason:'指定模型估算样本或等效单价缺失'};
    const publicRate = group.public_rate_multiplier ?? group.rate_multiplier;
    if (!validPrice(publicRate) || !validPrice(group.rate_multiplier)) return {reason:'渠道倍率无效，无法估算价格'};
    if (publicRate !== group.rate_multiplier) return {reason:'账号倍率与公开倍率不同，无法估算价格'};
    if (sample.unknown_context_records !== 0 || sample.long_input_tokens !== 0 || sample.long_cache_read_tokens !== 0 || sample.long_cache_creation_tokens !== 0) return {reason:'估算样本含长上下文或上下文不明确'};
    const cost = sample.sol_equivalent_unit_price * publicRate;
    return validPrice(cost) ? {cost,predictedMultiplier:null,estimated:true,sampleCount:sample.usage_records} : {reason:'估算价格无效'};
  }
  if (cache?.ready === false) return {reason:'指定模型计价数据未就绪'};
  return {
    cost: summary.effective_input_price_per_million,
    predictedMultiplier: summary.effective_multiplier_ready === true && validPrice(summary.effective_multiplier) ? summary.effective_multiplier : null
  };
}
export function platformPrice(group, model, now=Date.now()) {
  const result = priceAssessment(group, model, now);
  return result.reason ? null : result;
}
export function migrateApp(app) {
  if (app.schemaVersion === 8) return false;
  const previousVersion=app.schemaVersion;
  app.defaultStrategy=validateStrategy(app.defaultStrategy||DEFAULT_STRATEGY);
  app.checkMinutes=app.checkMinutes||5;
  if(previousVersion===5)app.defaultStrategy.rules.confirmRounds=1;
  for(const c of app.configs){
    c.strategy=validateStrategy(c.strategy||app.defaultStrategy);
    if(previousVersion===5)c.strategy.rules.confirmRounds=1;
  }
  if(previousVersion!==7){
    delete app.pricing;
    for(const c of app.configs){
      delete c.profile;
      const s=app.states[c.keyId];
      if(previousVersion===6&&s&&!s.pending&&c.paused&&/^(检测到外部改组|切换前发现外部改组|检测到页面改组操作|切换期间发生外部改组)，已暂停$/.test(s.status||''))c.paused=false;
    }
    for(const s of Object.values(app.states))resetStrategyCheck(s,'排序策略已更新，等待重新检查');
  }
  app.schemaVersion=8;
  return true;
}
export function resetStrategyCheck(state,status){
  state.candidate=null;
  state.count=0;
  delete state.observedAt; delete state.choices; delete state.priceUnavailableChoices;
  delete state.rateLimitedChoices; delete state.excludedChoices; delete state.excluded;
  delete state.rankingBasis;
  state.status=state.pending?'等待核实上次切换':status;
}
export function assess(group, config, snapshot, now, strategy=DEFAULT_STRATEGY) {
  strategy=validateStrategy(strategy);
  const rules=strategy.rules;
  if (!group || typeof group.platform!=='string' || group.platform!==config.platform) return {reason:'模型系列不匹配'};
  if (snapshot.stale!==false || !Number.isFinite(Date.parse(snapshot.generated_at)) || now-Date.parse(snapshot.generated_at)>INTERVAL || Date.parse(snapshot.generated_at)>now+60000) return {reason:'价格快照未知或过期'};
  if (group.bindable!==true) return {reason:'当前账号不可绑定'};
  if (group.detections_enabled===false || group.probe_skipped===true) return {reason:'分组未启用探测'};
  // The Hall listing can hide a bindable group with a healthy model.
  const requiresGroupProbe=group.detections_enabled!==true && group.probe_state!==undefined;
  if (requiresGroupProbe && (group.available!==true || group.availability_unknown===true || group.probe_state!=='enabled')) {
    return {reason:'分组不可用或未探测'};
  }
  if(rules.denyIds.includes(group.group_id))return {reason:'已在渠道黑名单'};
  if(rules.allowIds.length&&!rules.allowIds.includes(group.group_id))return {reason:'不在渠道白名单'};
  if(rules.maxRate>0 && (!validPrice(group.rate_multiplier)||group.rate_multiplier>rules.maxRate))return {reason:'超过自定义倍率上限'};
  if (group.key_max_rate_multiplier>0 && group.rate_multiplier>group.key_max_rate_multiplier) return {reason:'超过此 key 的倍率上限'};
  if (requiresGroupProbe && !(Date.parse(group.probe_expires_at)>now)) return {reason:'分组探测过期'};
  const model=group.group_models?.find(x=>x.model===config.model);
  const card=group.model_cards?.find(x=>x.model===config.model);
  if (!model || !card || card.health!=='healthy') return {reason:'指定模型未列出或不健康'};
  if (card.probe_state!=='enabled' && (requiresGroupProbe || card.probe_state!==undefined)) return {reason:'指定模型未启用探测'};
  if (!(Date.parse(card.health_expires_at)>now)) return {reason:'模型健康状态过期'};
  const detection=detectionInfo(group,config.model);
  if(strategy.requireDetection!==false && !detection.passed)return {reason:'检测未通过'};
  if(config.excludeWarnings===true && providerBadgeDetails(channelSummary(group).hall,now)?.warnings.length)return {reason:'平台告警'};
  if (group.subscription_type!=='standard') return {reason:'非按量分组'};
  const metric=priceAssessment(group,config.model,now);
  const summary=group.summary_models?.[config.model];
  const cacheHit=modelCacheHit(summary,now);
  const samples=validPrice(summary?.sample_count)&&Number.isInteger(summary.sample_count)?summary.sample_count:null;
  const latency=samples>0 && validPrice(summary.user_latency_ms) ? summary.user_latency_ms : null;
  const success=samples>0 && validPrice(summary.success_rate) && summary.success_rate<=1 ? summary.success_rate : null;
  const metrics={price:metric?.cost??null,rate:validPrice(group.rate_multiplier)?group.rate_multiplier:null,cacheHit,latency,success};
  const missingPrice={reason:metric.reason,priceUnavailable:true,channelPrice:model.price};
  if(rules.minSamples>0 && (samples===null||samples<rules.minSamples))return {reason:'样本数低于下限'};
  if(rules.minSuccess>0 && (success===null || success*100<rules.minSuccess))return {reason:'成功率低于下限或未知'};
  if(rules.minCacheHit>0 && (cacheHit===null || cacheHit*100<rules.minCacheHit))return {reason:cacheHit===null?'指定模型缓存率未知或数据未就绪':'缓存率低于下限'};
  if(rules.maxLatency>0 && (latency===null || latency>rules.maxLatency))return {reason:'延迟超过上限或未知'};
  if(rules.maxPrice>0 && metrics.price===null)return missingPrice;
  if(rules.maxPrice>0 && metrics.price>rules.maxPrice)return {reason:'真实价格超过上限'};
  const required=strategy.mode==='weighted' ? Object.keys(strategy.weights).filter(k=>strategy.weights[k]>0) : [strategy.mode];
  const missing=required.find(k=>k!=='price' && metrics[k]===null);
  if(missing)return {reason:{rate:'账号倍率无效或未知',cacheHit:'指定模型缓存率未知或数据未就绪',latency:'指定模型首响应延迟缺失或无样本',success:'指定模型成功率缺失或无样本'}[missing]};
  return {cost:metrics.price,predictedMultiplier:metric?.predictedMultiplier??null,estimated:metric?.estimated===true,priceSamples:metric?.sampleCount??null,latency,success,cacheHit,metrics,detection:detection.label,
    estimateKind:metric.estimateKind,estimateBasis:metric.estimateBasis,priceReason:metric.reason,channelPrice:metric.reason?model.price:undefined
  };
}
export function rankChoices(choices,strategy) {
  const s=validateStrategy(strategy);
  if(s.mode==='price' && choices.length && choices.every(c=>c.metrics.price===null)){
    const rates=choices.map(c=>c.group.rate_multiplier).filter(validPrice);
    const min=Math.min(...rates),max=Math.max(...rates);
    return choices.map(c=>({...c,score:validPrice(c.group.rate_multiplier)?(max===min?100:(max-c.group.rate_multiplier)/(max-min)*100):null}))
      .sort((a,b)=>(b.score??-1)-(a.score??-1) || a.group.group_id-b.group.group_id);
  }
  const weights=s.mode==='weighted'?s.weights:{[s.mode]:1};
  const priced=weights.price>0?choices.filter(c=>c.metrics.price!==null):[];
  const comparable=priced.length?priced:choices;
  const keys=Object.keys(weights).filter(k=>weights[k]>0 && (k!=='price' || priced.length));
  const total=keys.reduce((v,k)=>v+weights[k],0);
  const bounds=Object.fromEntries(keys.map(k=>[k,{min:Math.min(...comparable.map(c=>c.metrics[k])),max:Math.max(...comparable.map(c=>c.metrics[k]))}]));
  return choices.map(c=>{
    if(priced.length && c.metrics.price===null)return {...c,score:null};
    let score=0;
    for(const k of keys){const {min,max}=bounds[k];const normalized=max===min?1:['success','cacheHit'].includes(k)?(c.metrics[k]-min)/(max-min):(max-c.metrics[k])/(max-min);score+=normalized*weights[k]/total*100;}
    return {...c,score};
  }).sort((a,b)=>(b.score??-1)-(a.score??-1) || a.group.group_id-b.group.group_id);
}
export function providerBadgeDetails(hall,now=Date.now()) {
  const badges=hall?.badges;
  const fresh=expiresAt=>typeof expiresAt==='string' && Date.parse(expiresAt)>now;
  if(!badges || !fresh(hall.expiresAt))return null;

  const popularity=badges.popularity;
  const ranked=popularity?.status==='measured' && fresh(popularity.expires_at) &&
    Number.isSafeInteger(popularity.rank) && popularity.rank>0 &&
    Number.isSafeInteger(popularity.groups) && popularity.groups>=popularity.rank &&
    typeof popularity.window==='string' && popularity.window.length>0;
  const warnings=[];
  let partial=false,unknown=!Array.isArray(badges.warnings);
  for(const warning of Array.isArray(badges.warnings)?badges.warnings:[]){
    if(typeof warning?.id!=='string' || !Array.isArray(warning.triggers)){
      unknown=true;
      continue;
    }
    const triggers=warning.triggers.filter(trigger=>trigger && (trigger.expires_at==null || fresh(trigger.expires_at)));
    partial ||= warning.status==='partial' || warning.partial===true ||
      triggers.some(trigger=>trigger.complete===false && trigger.available===true);
    unknown ||= warning.status==='unknown';
    if(warning.status!=='active')continue;
    let worst=null;
    for(const trigger of triggers){
      if(!validPrice(trigger.value) || !validPrice(trigger.threshold) ||
        !['<','<=','>','>='].includes(trigger.operator) || typeof trigger.window!=='string' || !trigger.window)continue;
      if(!worst || (trigger.operator.startsWith('<')?trigger.value<worst.value:trigger.value>worst.value))worst=trigger;
    }
    if(worst)warnings.push({id:warning.id,trigger:worst});
    else unknown=true;
  }
  return {popularity:ranked?popularity:null,warnings,partial,unknown};
}
function channelSummary(group) {
  return {
    id:group.group_id,
    code:group.code||String(group.group_id),
    hall:group.badges?{badges:group.badges,expiresAt:group.badges_expires_at}:null
  };
}
export function decide({config,state={},currentGroupId,snapshot,now=Date.now(),globalStrategy=DEFAULT_STRATEGY,intervalMs=INTERVAL}) {
  const strategy=validateStrategy(config.strategy||globalStrategy),signature=JSON.stringify(strategy);
  if(state.strategySignature && state.strategySignature!==signature)state={...state,candidate:null,count:0,observedAt:undefined};
  const next={...state,lastChecked:now,strategySignature:signature,strategyLabel:strategyLabel(strategy)};
  const reset=(status)=>({state:{...next,candidate:null,count:0,status},target:null});
  if (config.paused) return reset('已暂停');
  if (state.pending) return reset('等待核实上次切换');
  if (state.expectedGroupId!=null && state.expectedGroupId!==currentGroupId) return {target:null,externalChange:true,state:{...next,expectedGroupId:currentGroupId,observedGroupId:undefined,candidate:null,count:0,observedAt:undefined,status:'检测到分组变化，已更新并等待下轮检查'}};
  next.expectedGroupId=currentGroupId;
  const assessed=(snapshot.items||[]).filter(g=>g.platform===config.platform).map(g=>({group:g,...assess(g,config,snapshot,now,strategy)}));
  next.excluded=Object.fromEntries([...new Set(assessed.filter(x=>x.reason).map(x=>x.reason))].map(reason=>[reason,assessed.filter(x=>x.reason===reason).length]));
  next.priceUnavailableChoices=assessed.filter(x=>x.priceUnavailable).map(x=>({
    ...channelSummary(x.group),reason:x.reason,channelPrice:x.channelPrice
  }));
  const choices=rankChoices(assessed.filter(x=>!x.reason),strategy);
  const rateFallback=strategy.mode==='price' && choices.length>0 && choices.every(x=>x.cost===null);
  next.rankingBasis=rateFallback?'accountMultiplier':strategy.mode;
  if(state.rankingBasis!==next.rankingBasis)state={...state,candidate:null,count:0,observedAt:undefined};
  next.choices=choices.map(x=>({...channelSummary(x.group),cost:x.cost,predictedMultiplier:x.predictedMultiplier,estimated:x.estimated,priceSamples:x.priceSamples,rawMultiplier:x.group.public_rate_multiplier??x.group.rate_multiplier,accountMultiplier:x.group.rate_multiplier,latency:x.latency,success:x.success,score:x.score,stars:validPrice(x.group.reputation?.stars)?x.group.reputation.stars:null,detection:x.detection,
    cacheHit:x.cacheHit,estimateKind:x.estimateKind,estimateBasis:x.estimateBasis,priceReason:x.priceReason,channelPrice:x.channelPrice
  }));
  if (!choices.length) return {...reset('没有合格分组，保留当前'),notice:'no-candidate'};
  const current=choices.find(x=>x.group.group_id===currentGroupId), best=choices[0];
  const usesPrice=strategy.mode==='price' || (strategy.mode==='weighted' && strategy.weights.price>0);
  const basis=rateFallback?'全部真实价格缺失，按账号倍率：':'';
  if(rateFallback && best.score===null)return reset('全部真实价格缺失，账号倍率也不可比较，保留当前');
  if (current?.cost===null && usesPrice && !rateFallback) return reset('当前分组可用，真实价格暂不可比较');
  if(rateFallback && current && current.score===null)return reset('全部真实价格缺失，当前账号倍率未知，保留当前');
  if (current && current.score>=best.score-1e-9) return reset(rateFallback?'全部真实价格缺失，当前账号倍率最低（同倍率不切）':strategy.mode==='rate'?'当前账号倍率最低（同倍率不切）':'当前分组已是策略最优（同分不切）');
  if (!current) return {state:{...next,candidate:null,count:0,status:basis+'当前分组不合格，准备切换'},target:best.group.group_id};
  if(state.lastSwitchAt && now-state.lastSwitchAt<strategy.rules.cooldownMinutes*60000)return reset('切换冷却中');
  const improvement=rateFallback?(current.group.rate_multiplier-best.group.rate_multiplier)/Math.max(current.group.rate_multiplier,1e-12)*100:strategy.mode==='weighted'?best.score-current.score:['success','cacheHit'].includes(strategy.mode)?(best.metrics[strategy.mode]-current.metrics[strategy.mode])/Math.max(current.metrics[strategy.mode],1e-12)*100:(current.metrics[strategy.mode]-best.metrics[strategy.mode])/Math.max(current.metrics[strategy.mode],1e-12)*100;
  if(improvement+1e-9<strategy.rules.minImprovement)return reset('改善幅度未达到要求');
  // Manual checks cannot turn one observation into two consecutive 5-minute observations.
  const consecutive=state.candidate===best.group.group_id && now-state.observedAt>=intervalMs-1000 && now-state.observedAt<=intervalMs*1.6;
  const tooSoon=state.candidate===best.group.group_id && now-state.observedAt<intervalMs-1000;
  const count=tooSoon ? state.count : consecutive ? (state.count||0)+1 : 1;
  const observedAt=tooSoon?state.observedAt:now;
  const ready=count>=strategy.rules.confirmRounds;
  return {state:{...next,candidate:best.group.group_id,count,observedAt,status:basis+(ready?`连续 ${count} 轮策略最优，准备切换`:`等待确认策略最优（${count}/${strategy.rules.confirmRounds}）`)},target:ready?best.group.group_id:null};
}
export function reconcilePending(state,actual) {
  if (!state.pending) return {state};
  const {from,to}=state.pending;
  if (actual===to) return {state:{...state,pending:null,expectedGroupId:to,candidate:null,count:0,lastSwitchAt:Date.now(),status:'已确认切换成功'}};
  if (actual===from) return {pause:true,state:{...state,pending:null,expectedGroupId:from,candidate:null,count:0,status:'切换未生效，已暂停，请检查后恢复'}};
  return {state:{...state,pending:null,expectedGroupId:actual,candidate:null,count:0,status:'切换期间分组发生变化，等待下轮检查'}};
}
