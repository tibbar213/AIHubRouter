export const INTERVAL = 300000;
// Usage profile for comparing prices: input tokens per output token, and the cache-read share of input.
export const DEFAULT_USAGE=Object.freeze({inputRatio:3,cacheRate:0,measuredCache:true});
export const DEFAULT_RULES=Object.freeze({minSuccess:0,minCacheHit:0,minSamples:0,maxLatency:0,maxPrice:0,maxRate:0,allowIds:Object.freeze([]),denyIds:Object.freeze([]),confirmRounds:1,cooldownMinutes:0,minImprovement:0});
export const DEFAULT_STRATEGY = Object.freeze({mode:'balanced',weights:Object.freeze({price:70,latency:20,success:10,popularity:0,stars:0}),requireDetection:true,rules:DEFAULT_RULES});
// Balanced preset: success and latency are required; rating and spending rank count only when every candidate has them.
export const BALANCED_WEIGHTS=Object.freeze({price:40,latency:15,success:25,popularity:10,stars:10});
const PRICE_WEIGHTS=Object.freeze({price:100,latency:0,success:0,popularity:0,stars:0});
const OPTIONAL_BALANCED=['stars','popularity'];
export const STRATEGY_MODES=Object.freeze(['price','balanced','weighted']);
// Weights shown in the editor for a mode; custom mode shows the key's own weights.
export function presetWeights(mode,custom=DEFAULT_STRATEGY.weights){return {...(mode==='price'?PRICE_WEIGHTS:mode==='balanced'?BALANCED_WEIGHTS:custom)};}
// Modes removed in schema 9 map to the closest remaining strategy.
function upgradeLegacyMode(strategy){
  if(!strategy)return strategy;
  if(['rate','cacheHit'].includes(strategy.mode))return {...strategy,mode:'price'};
  if(strategy.mode==='experience')return {...strategy,mode:'balanced'};
  if(['latency','success'].includes(strategy.mode))return {...strategy,mode:'weighted',weights:{price:0,latency:0,success:0,popularity:0,stars:0,[strategy.mode]:100}};
  return strategy;
}
export function validateUsage(usage){
  usage={...DEFAULT_USAGE,...usage};
  if(typeof usage.inputRatio!=='number'||!Number.isFinite(usage.inputRatio)||usage.inputRatio<=0||usage.inputRatio>1000)throw new Error('输入输出比例须为大于 0、不超过 1000 的数字');
  if(typeof usage.cacheRate!=='number'||!Number.isFinite(usage.cacheRate)||usage.cacheRate<0||usage.cacheRate>100)throw new Error('缓存命中率假设须为 0–100');
  if(typeof usage.measuredCache!=='boolean')throw new Error('实测缓存率设置无效');
  return {inputRatio:usage.inputRatio,cacheRate:usage.cacheRate,measuredCache:usage.measuredCache};
}
export function validateStrategy(strategy) {
  if (!strategy || !STRATEGY_MODES.includes(strategy.mode)) throw new Error('排序方式无效');
  const weights={...DEFAULT_STRATEGY.weights,...strategy.weights};
  if (!['price','latency','success','popularity','stars'].every(k=>typeof weights[k]==='number' && Number.isFinite(weights[k]) && weights[k]>=0 && weights[k]<=100)) throw new Error('权重必须为 0 至 100 的数字');
  if (strategy.mode==='weighted' && weights.price+weights.latency+weights.success+weights.popularity+weights.stars<=0) throw new Error('请至少给一个因素设置正权重');
  if(strategy.requireDetection!=null && typeof strategy.requireDetection!=='boolean')throw new Error('模型检测筛选设置无效');
  const rules={...DEFAULT_RULES,...strategy.rules};
  for(const k of ['minSuccess','minCacheHit','minSamples','maxLatency','maxPrice','maxRate','confirmRounds','cooldownMinutes','minImprovement'])if(typeof rules[k]!=='number'||!Number.isFinite(rules[k])||rules[k]<0)throw new Error('筛选和切换数值必须为非负数字');
  if(rules.minSuccess>100||rules.minCacheHit>100||rules.minImprovement>100||!Number.isInteger(rules.confirmRounds)||rules.confirmRounds<1||rules.confirmRounds>6||!Number.isInteger(rules.minSamples)||rules.cooldownMinutes>1440)throw new Error('成功率/缓存率/改善幅度应为0–100，确认轮数1–6，样本数为整数，冷却不超过1440分钟');
  for(const k of ['allowIds','denyIds']){if(!Array.isArray(rules[k])||rules[k].length>1000||!rules[k].every(x=>Number.isSafeInteger(x)&&x>0))throw new Error('渠道名单请填写正整数分组 ID');rules[k]=[...new Set(rules[k])];}
  return {mode:strategy.mode,weights:{price:weights.price,latency:weights.latency,success:weights.success,popularity:weights.popularity,stars:weights.stars},requireDetection:strategy.requireDetection!==false,rules};
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
  if(s.mode==='price')return '模型价格优先';
  if(s.mode==='balanced')return '综合排序';
  const total=Object.values(s.weights).reduce((a,b)=>a+b,0);
  const parts=[['price','模型价格'],['latency','延迟'],['success','成功率'],['popularity','消费排名'],['stars','用户评分']].filter(([k])=>s.weights[k]>0).map(([k,label])=>`${label} ${(s.weights[k]/total*100).toFixed(1)}%`);
  return '自定义：'+parts.join(' · ');
}
const validPrice = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
function modelCacheHit(summary,now){
  const cache=summary?.range_cache,refreshed=Date.parse(cache?.refreshed_at);
  // 与供应商大厅单模型视图一致：只要求 ready、未过期且命中率有效。
  // coverage_complete 只表示历史覆盖不完整（大厅仅在悬停提示里说明），不再作为必要条件。
  return cache?.ready===true && cache.stale===false &&
    Number.isFinite(refreshed) && now-refreshed<=INTERVAL && refreshed<=now+60000 &&
    validPrice(cache.cache_hit_rate) && cache.cache_hit_rate<=1 ? cache.cache_hit_rate : null;
}
// Blended price per million tokens: cache reads are billed at the cache-input price
// (input price when the channel lists none), weighted by the key's input:output ratio.
function priceAssessment(price, rateMultiplier, usage=DEFAULT_USAGE, measuredHit=null) {
  const input = price?.input_per_million, output = price?.output_per_million;
  if (!validPrice(input) || !validPrice(output)) return {reason:'指定模型标价缺失或无效'};
  if (!validPrice(rateMultiplier)) return {reason:'账号倍率无效，无法计算模型价格'};
  const cached = validPrice(price.cache_input_per_million) ? price.cache_input_per_million : input;
  const measured = usage.measuredCache && measuredHit!=null;
  const hit = measured ? measuredHit : usage.cacheRate/100;
  const inputCost = (1-hit)*input + hit*cached;
  const cost = (usage.inputRatio*inputCost + output) / (usage.inputRatio+1) * rateMultiplier;
  return validPrice(cost) ? {cost,costCacheHit:hit,costCacheMeasured:measured} : {reason:'模型价格无效'};
}
export function platformPrice(group, model, usage=DEFAULT_USAGE, now=Date.now()) {
  const price = group?.group_models?.find(entry=>entry.model===model)?.price;
  const result = priceAssessment(price, group?.rate_multiplier, validateUsage(usage), modelCacheHit(group?.summary_models?.[model],now));
  return result.reason ? null : result;
}
export function migrateApp(app) {
  if (app.schemaVersion === 10) return false;
  const previousVersion=app.schemaVersion;
  const previous=upgradeLegacyMode(app.defaultStrategy);
  app.usage=validateUsage(app.usage||previous?.usage||app.configs.find(c=>c.strategy?.usage)?.strategy.usage);
  app.defaultStrategy=validateStrategy(previous||DEFAULT_STRATEGY);
  app.checkMinutes=app.checkMinutes||5;
  for(const c of app.configs){
    // Percent thresholds become score gaps for weighted mode; stop auto switching until the user reviews it.
    const thresholdChanged=['latency','success'].includes(c.strategy?.mode)&&c.strategy.rules?.minImprovement>0;
    c.strategy=validateStrategy(upgradeLegacyMode(c.strategy)||app.defaultStrategy);
    if(thresholdChanged&&c.automatic){
      c.automatic=false;
      if(Array.isArray(app.logs))app.logs.unshift({at:Date.now(),text:`Key ${c.keyId}：策略已改为自定义，最小改善幅度改按分差计算，已转为只预览，请确认策略后重新开启自动切换`});
    }
  }
  if(!(previousVersion>=7)){
    delete app.pricing;
    for(const c of app.configs){
      delete c.profile;
      const s=app.states[c.keyId];
      if(previousVersion===6&&s&&!s.pending&&c.paused&&/^(检测到外部改组|切换前发现外部改组|检测到页面改组操作|切换期间发生外部改组)，已暂停$/.test(s.status||''))c.paused=false;
    }
    for(const s of Object.values(app.states))resetStrategyCheck(s,'排序策略已更新，等待重新检查');
  }
  app.schemaVersion=10;
  return true;
}
export function resetStrategyCheck(state,status){
  state.candidate=null;
  state.count=0;
  delete state.observedAt; delete state.choices; delete state.priceUnavailableChoices;
  delete state.excluded; delete state.rankingBasis;
  state.status=state.pending?'等待核实上次切换':status;
}
export function assess(group, config, snapshot, now, strategy=DEFAULT_STRATEGY, usage=DEFAULT_USAGE) {
  strategy=validateStrategy(strategy);
  usage=validateUsage(usage);
  const rules=strategy.rules;
  const model=group?.group_models?.find(x=>x.model===config.model);
  if (!model) return {reason:'指定模型未列出'};
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
  const card=group.model_cards?.find(x=>x.model===config.model);
  if (!card || card.health!=='healthy') return {reason:'指定模型未列出或不健康'};
  if (card.probe_state!=='enabled' && (requiresGroupProbe || card.probe_state!==undefined)) return {reason:'指定模型未启用探测'};
  if (!(Date.parse(card.health_expires_at)>now)) return {reason:'模型健康状态过期'};
  const detection=detectionInfo(group,config.model);
  if(strategy.requireDetection!==false && !detection.passed)return {reason:'检测未通过'};
  if(config.excludeWarnings===true && providerBadgeDetails(channelSummary(group).hall,now)?.warnings.length)return {reason:'平台告警'};
  if (group.subscription_type!=='standard') return {reason:'非按量分组'};
  const summary=group.summary_models?.[config.model];
  const cacheHit=modelCacheHit(summary,now);
  const metric=priceAssessment(model.price,group.rate_multiplier,usage,cacheHit);
  const samples=validPrice(summary?.sample_count)&&Number.isInteger(summary.sample_count)?summary.sample_count:null;
  const latency=samples>0 && validPrice(summary.user_latency_ms) ? summary.user_latency_ms : null;
  const success=samples>0 && validPrice(summary.success_rate) && summary.success_rate<=1 ? summary.success_rate : null;
  const pop=providerBadgeDetails(channelSummary(group).hall,now)?.popularity,popularity=pop?pop.rank/pop.groups:null,stars=validPrice(group.reputation?.stars)?group.reputation.stars:null;
  const metrics={price:metric?.cost??null,rate:validPrice(group.rate_multiplier)?group.rate_multiplier:null,cacheHit,latency,success,popularity,popularityRank:pop?pop.rank:null,stars};
  const missingPrice={reason:metric.reason,priceUnavailable:true,channelPrice:model.price};
  if(rules.minSamples>0 && (samples===null||samples<rules.minSamples))return {reason:'样本数低于下限'};
  if(rules.minSuccess>0 && (success===null || success*100<rules.minSuccess))return {reason:'成功率低于下限或未知'};
  if(rules.minCacheHit>0 && (cacheHit===null || cacheHit*100<rules.minCacheHit))return {reason:cacheHit===null?'指定模型缓存率未知或数据未就绪':'缓存率低于下限'};
  if(rules.maxLatency>0 && (latency===null || latency>rules.maxLatency))return {reason:'延迟超过上限或未知'};
  if(rules.maxPrice>0 && metrics.price===null)return missingPrice;
  if(rules.maxPrice>0 && metrics.price>rules.maxPrice)return {reason:'模型价格超过上限'};
  const required=strategy.mode==='weighted' ? Object.keys(strategy.weights).filter(k=>strategy.weights[k]>0) : strategy.mode==='balanced' ? ['success','latency'] : ['price'];
  const missing=required.find(k=>k!=='price' && metrics[k]===null);
  if(missing)return {reason:{rate:'账号倍率无效或未知',cacheHit:'指定模型缓存率未知或数据未就绪',latency:'指定模型首响应延迟缺失或无样本',success:'指定模型成功率缺失或无样本',popularity:'消费排名未知或已过期',stars:'用户评分缺失'}[missing]};
  return {cost:metrics.price,latency,success,cacheHit,metrics,detection:detection.label,
    costCacheHit:metric.costCacheHit,costCacheMeasured:metric.costCacheMeasured,
    priceReason:metric.reason,channelPrice:metric.reason?model.price:undefined
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
  const weights=s.mode==='weighted'?s.weights:s.mode==='balanced'?BALANCED_WEIGHTS:{price:1};
  const priced=weights.price>0?choices.filter(c=>c.metrics.price!==null):[];
  const comparable=priced.length?priced:choices;
  const keys=Object.keys(weights).filter(k=>weights[k]>0 && (k!=='price' || priced.length) && !(s.mode==='balanced' && OPTIONAL_BALANCED.includes(k) && comparable.some(c=>c.metrics[k]===null)));
  const total=keys.reduce((v,k)=>v+weights[k],0);
  const bounds=Object.fromEntries(keys.map(k=>[k,{min:Math.min(...comparable.map(c=>c.metrics[k])),max:Math.max(...comparable.map(c=>c.metrics[k]))}]));
  return choices.map(c=>{
    if(priced.length && c.metrics.price===null)return {...c,score:null};
    let score=0;
    for(const k of keys){const {min,max}=bounds[k];const normalized=max===min?1:['success','cacheHit','stars'].includes(k)?(c.metrics[k]-min)/(max-min):(max-c.metrics[k])/(max-min);score+=normalized*weights[k]/total*100;}
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
export function decide({config,state={},currentGroupId,snapshot,now=Date.now(),globalStrategy=DEFAULT_STRATEGY,usage=DEFAULT_USAGE,intervalMs=INTERVAL}) {
  const strategy=validateStrategy(config.strategy||globalStrategy),signature=JSON.stringify([strategy,validateUsage(usage)]);
  if(state.strategySignature && state.strategySignature!==signature)state={...state,candidate:null,count:0,observedAt:undefined};
  const next={...state,strategySignature:signature};
  delete next.choicesOutdated;
  const reset=(status)=>({state:{...next,candidate:null,count:0,status},target:null});
  if (config.paused) return reset('已暂停');
  if (state.pending) return reset('等待核实上次切换');
  if (state.expectedGroupId!=null && state.expectedGroupId!==currentGroupId) return {target:null,externalChange:true,state:{...next,...(state.choicesOutdated?{choicesOutdated:true}:{}),expectedGroupId:currentGroupId,observedGroupId:undefined,candidate:null,count:0,observedAt:undefined,status:'检测到分组变化，已更新并等待下轮检查'}};
  next.expectedGroupId=currentGroupId;
  const assessed=(snapshot.items||[]).filter(g=>g?.group_models?.some(m=>m.model===config.model)).map(g=>({group:g,...assess(g,config,snapshot,now,strategy,usage)}));
  next.excluded=Object.fromEntries([...new Set(assessed.filter(x=>x.reason).map(x=>x.reason))].map(reason=>[reason,assessed.filter(x=>x.reason===reason).length]));
  next.priceUnavailableChoices=assessed.filter(x=>x.priceUnavailable).map(x=>({
    ...channelSummary(x.group),reason:x.reason,channelPrice:x.channelPrice
  }));
  const choices=rankChoices(assessed.filter(x=>!x.reason),strategy);
  const rateFallback=strategy.mode==='price' && choices.length>0 && choices.every(x=>x.cost===null);
  next.rankingBasis=rateFallback?'accountMultiplier':strategy.mode;
  if(state.rankingBasis!==next.rankingBasis)state={...state,candidate:null,count:0,observedAt:undefined};
  next.choices=choices.map(x=>({...channelSummary(x.group),cost:x.cost,rawMultiplier:x.group.public_rate_multiplier??x.group.rate_multiplier,accountMultiplier:x.group.rate_multiplier,latency:x.latency,success:x.success,score:x.score,popularityRank:x.metrics.popularityRank,stars:validPrice(x.group.reputation?.stars)?x.group.reputation.stars:null,detection:x.detection,
    cacheHit:x.cacheHit,costCacheHit:x.costCacheHit,costCacheMeasured:x.costCacheMeasured,priceReason:x.priceReason,channelPrice:x.channelPrice
  }));
  if (!choices.length) return {...reset('没有合格分组，保留当前'),notice:'no-candidate'};
  const current=choices.find(x=>x.group.group_id===currentGroupId), best=choices[0];
  const usesPrice=strategy.mode!=='weighted' || strategy.weights.price>0;
  const basis=rateFallback?'全部模型价格缺失，按账号倍率：':'';
  if(rateFallback && best.score===null)return reset('全部模型价格缺失，账号倍率也不可比较，保留当前');
  if (current?.cost===null && usesPrice && !rateFallback) return reset('当前分组可用，模型价格暂不可比较');
  if(rateFallback && current && current.score===null)return reset('全部模型价格缺失，当前账号倍率未知，保留当前');
  if (current && current.score>=best.score-1e-9) return reset(rateFallback?'全部模型价格缺失，当前账号倍率最低（同倍率不切）':'当前分组已是策略最优（同分不切）');
  if (!current) return {state:{...next,candidate:null,count:0,status:basis+'当前分组不合格，准备切换'},target:best.group.group_id};
  if(state.lastSwitchAt && now-state.lastSwitchAt<strategy.rules.cooldownMinutes*60000)return reset('切换冷却中');
  const improvement=rateFallback?(current.group.rate_multiplier-best.group.rate_multiplier)/Math.max(current.group.rate_multiplier,1e-12)*100:strategy.mode!=='price'?best.score-current.score:(current.metrics.price-best.metrics.price)/Math.max(current.metrics.price,1e-12)*100;
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
