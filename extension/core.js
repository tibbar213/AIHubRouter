export const PLATFORMS = ['openai','kimi','zhipu','grok','deepseek'];
export const INTERVAL = 300000;
export const PRICE_SOURCE = 'platform-effective-price-v1';
export const DEFAULT_RULES=Object.freeze({minSuccess:0,minSamples:0,maxLatency:0,maxPrice:0,maxRate:0,allowIds:Object.freeze([]),denyIds:Object.freeze([]),confirmRounds:1,cooldownMinutes:0,minImprovement:0});
export const DEFAULT_STRATEGY = Object.freeze({mode:'price',weights:Object.freeze({price:70,latency:20,success:10}),requireDetection:true,rules:DEFAULT_RULES});
export function validateStrategy(strategy) {
  if (!strategy || !['price','latency','success','weighted'].includes(strategy.mode)) throw new Error('排序方式无效');
  const weights={...DEFAULT_STRATEGY.weights,...strategy.weights};
  if (!['price','latency','success'].every(k=>typeof weights[k]==='number' && Number.isFinite(weights[k]) && weights[k]>=0 && weights[k]<=100)) throw new Error('权重必须为 0 至 100 的数字');
  if (strategy.mode==='weighted' && weights.price+weights.latency+weights.success<=0) throw new Error('请至少给一个因素设置正权重');
  if(strategy.requireDetection!=null && typeof strategy.requireDetection!=='boolean')throw new Error('模型检测筛选设置无效');
  const rules={...DEFAULT_RULES,...strategy.rules};
  for(const k of ['minSuccess','minSamples','maxLatency','maxPrice','maxRate','confirmRounds','cooldownMinutes','minImprovement'])if(typeof rules[k]!=='number'||!Number.isFinite(rules[k])||rules[k]<0)throw new Error('筛选和切换数值必须为非负数字');
  if(rules.minSuccess>100||rules.minImprovement>100||!Number.isInteger(rules.confirmRounds)||rules.confirmRounds<1||rules.confirmRounds>6||!Number.isInteger(rules.minSamples)||rules.cooldownMinutes>1440)throw new Error('成功率/改善幅度应为0–100，确认轮数1–6，样本数为整数，冷却不超过1440分钟');
  for(const k of ['allowIds','denyIds']){if(!Array.isArray(rules[k])||rules[k].length>1000||!rules[k].every(x=>Number.isSafeInteger(x)&&x>0))throw new Error('渠道名单请填写正整数分组 ID');rules[k]=[...new Set(rules[k])];}
  return {mode:strategy.mode,weights:{price:weights.price,latency:weights.latency,success:weights.success},requireDetection:strategy.requireDetection!==false,rules};
}
export function detectionInfo(group,model){
  const d=group.model_detection;
  if(!d || d.model!==model)return {passed:false,label:d?.model?'检测的是其他模型':'未检测绑定模型'};
  const matchingStages=['detection','text'].every(k=>!d.stages?.[k]?.model || d.stages[k].model===model);
  const passed=d.status==='passed' && d.applicable===true && d.execution_complete===true && matchingStages;
  return {passed,label:passed?'检测通过':({suspected:'存疑',detection_failed:'检测失败',not_tested:'未检测'})[d.status]||'检测未通过或未完成'};
}
export function strategyLabel(strategy) {
  const s=validateStrategy(strategy);
  if(s.mode!=='weighted')return {price:'真实价格优先',latency:'首响应更快优先',success:'成功率更高优先'}[s.mode];
  const total=Object.values(s.weights).reduce((a,b)=>a+b,0);
  return `加权：价格 ${(s.weights.price/total*100).toFixed(1)}% · 延迟 ${(s.weights.latency/total*100).toFixed(1)}% · 成功率 ${(s.weights.success/total*100).toFixed(1)}%`;
}
const validPrice = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
export function platformPrice(group, model) {
  // Match ProviderHall's selected-model projection and effectivePrice sort.
  // The predicted multiplier is a companion display value, never another price unit.
  const summary = group.summary_models?.[model];
  if (!summary || !validPrice(summary.effective_input_price_per_million)) return null;
  if (summary.range_cache?.stale === true || summary.range_cache?.ready === false) return null;
  return {
    cost: summary.effective_input_price_per_million,
    predictedMultiplier: summary.effective_multiplier_ready === true && validPrice(summary.effective_multiplier) ? summary.effective_multiplier : null
  };
}
export function migrateApp(app) {
  if (app.schemaVersion === 6) return false;
  const previousVersion=app.schemaVersion;
  delete app.pricing;
  for (const c of app.configs) delete c.profile;
  app.defaultStrategy=validateStrategy(app.defaultStrategy||DEFAULT_STRATEGY);
  app.checkMinutes=app.checkMinutes||5;
  for (const c of app.configs) c.strategy=c.strategy ? validateStrategy(c.strategy) : null;
  if(previousVersion===5){app.defaultStrategy.rules.confirmRounds=1;for(const c of app.configs)if(c.strategy)c.strategy.rules.confirmRounds=1;}
  for (const s of Object.values(app.states)) {
    s.candidate=null; s.count=0;
    delete s.observedAt; delete s.choices; delete s.excluded;
    s.status=s.pending?'等待核实上次切换':'排序策略已更新，等待重新检查';
  }
  app.schemaVersion=6;
  return true;
}
export function assess(group, config, snapshot, now, strategy=DEFAULT_STRATEGY) {
  strategy=validateStrategy(strategy);
  const rules=strategy.rules;
  if (!group || !PLATFORMS.includes(group.platform) || group.platform!==config.platform) return {reason:'模型系列不匹配'};
  if (snapshot.stale!==false || !Number.isFinite(Date.parse(snapshot.generated_at)) || now-Date.parse(snapshot.generated_at)>INTERVAL || Date.parse(snapshot.generated_at)>now+60000) return {reason:'价格快照未知或过期'};
  if (group.available!==true || group.availability_unknown===true || group.probe_state!=='enabled' || group.probe_skipped===true) return {reason:'分组不可用或未探测'};
  if (group.bindable===false) return {reason:'当前账号不可绑定'};
  if(rules.denyIds.includes(group.group_id))return {reason:'已在渠道黑名单'};
  if(rules.allowIds.length&&!rules.allowIds.includes(group.group_id))return {reason:'不在渠道白名单'};
  if(rules.maxRate>0 && (!validPrice(group.rate_multiplier)||group.rate_multiplier>rules.maxRate))return {reason:'超过自定义倍率上限'};
  if (group.key_max_rate_multiplier>0 && group.rate_multiplier>group.key_max_rate_multiplier) return {reason:'超过此 key 的倍率上限'};
  const expires=Date.parse(group.probe_expires_at);
  if (!Number.isFinite(expires) || expires<=now) return {reason:'分组探测过期'};
  const model=group.group_models?.find(x=>x.model===config.model);
  const card=group.model_cards?.find(x=>x.model===config.model);
  if (!model || !card || card.probe_state!=='enabled' || card.health!=='healthy') return {reason:'指定模型未列出或不健康'};
  if (!(Date.parse(card.health_expires_at)>now)) return {reason:'模型健康状态过期'};
  const detection=detectionInfo(group,config.model);
  if(strategy.requireDetection!==false && !detection.passed)return {reason:detection.label};
  if (group.subscription_type!=='standard') return {reason:'非按量分组'};
  const metric=platformPrice(group,config.model);
  const summary=group.summary_models?.[config.model];
  const samples=validPrice(summary?.sample_count)&&Number.isInteger(summary.sample_count)?summary.sample_count:null;
  const latency=samples>0 && validPrice(summary.user_latency_ms) ? summary.user_latency_ms : null;
  const success=samples>0 && validPrice(summary.success_rate) && summary.success_rate<=1 ? summary.success_rate : null;
  const metrics={price:metric?.cost??null,latency,success};
  if(rules.minSamples>0 && (samples===null||samples<rules.minSamples))return {reason:'样本数低于下限'};
  if(rules.minSuccess>0 && (success===null || success*100<rules.minSuccess))return {reason:'成功率低于下限或未知'};
  if(rules.maxLatency>0 && (latency===null || latency>rules.maxLatency))return {reason:'延迟超过上限或未知'};
  if(rules.maxPrice>0 && (metrics.price===null || metrics.price>rules.maxPrice))return {reason:'真实价格超过上限或未知'};
  const required=strategy.mode==='weighted' ? Object.keys(strategy.weights).filter(k=>strategy.weights[k]>0) : [strategy.mode];
  const missing=required.find(k=>metrics[k]===null);
  if(missing)return {reason:{price:'指定模型真实价格缺失或未就绪',latency:'指定模型首响应延迟缺失或无样本',success:'指定模型成功率缺失或无样本'}[missing]};
  return {cost:metrics.price,predictedMultiplier:metric?.predictedMultiplier??null,latency,success,metrics,detection:detection.label};
}
export function rankChoices(choices,strategy) {
  const s=validateStrategy(strategy);
  const weights=s.mode==='weighted'?s.weights:{[s.mode]:1};
  const keys=Object.keys(weights).filter(k=>weights[k]>0),total=keys.reduce((v,k)=>v+weights[k],0);
  const bounds=Object.fromEntries(keys.map(k=>[k,{min:Math.min(...choices.map(c=>c.metrics[k])),max:Math.max(...choices.map(c=>c.metrics[k]))}]));
  return choices.map(c=>{
    let score=0;
    for(const k of keys){const {min,max}=bounds[k];const normalized=max===min?1:k==='success'?(c.metrics[k]-min)/(max-min):(max-c.metrics[k])/(max-min);score+=normalized*weights[k]/total*100;}
    return {...c,score};
  }).sort((a,b)=>b.score-a.score || a.group.group_id-b.group.group_id);
}
export function decide({config,state={},currentGroupId,snapshot,now=Date.now(),globalStrategy=DEFAULT_STRATEGY,intervalMs=INTERVAL}) {
  const strategy=validateStrategy(config.strategy||globalStrategy),signature=JSON.stringify(strategy);
  if(state.strategySignature && state.strategySignature!==signature)state={...state,candidate:null,count:0,observedAt:undefined};
  const next={...state,lastChecked:now,strategySignature:signature,strategyLabel:strategyLabel(strategy)};
  const reset=(status)=>({state:{...next,candidate:null,count:0,status},target:null});
  if (config.paused) return reset('已暂停');
  if (state.pending) return reset('等待核实上次切换');
  if (state.expectedGroupId!=null && state.expectedGroupId!==currentGroupId) return {target:null,pause:true,state:{...next,candidate:null,count:0,status:'检测到外部改组，已暂停'}};
  next.expectedGroupId=currentGroupId;
  const assessed=(snapshot.items||[]).filter(g=>g.platform===config.platform).map(g=>({group:g,...assess(g,config,snapshot,now,strategy)}));
  next.excluded=Object.fromEntries([...new Set(assessed.filter(x=>x.reason).map(x=>x.reason))].map(reason=>[reason,assessed.filter(x=>x.reason===reason).length]));
  const choices=rankChoices(assessed.filter(x=>!x.reason),strategy);
  next.choices=choices.map(x=>({id:x.group.group_id,code:x.group.code||String(x.group.group_id),cost:x.cost,predictedMultiplier:x.predictedMultiplier,rawMultiplier:x.group.public_rate_multiplier??x.group.rate_multiplier,accountMultiplier:x.group.rate_multiplier,latency:x.latency,success:x.success,score:x.score,stars:validPrice(x.group.reputation?.stars)?x.group.reputation.stars:null,detection:x.detection}));
  if (!choices.length) return {...reset('没有合格分组，保留当前'),notice:'no-candidate'};
  const current=choices.find(x=>x.group.group_id===currentGroupId), best=choices[0];
  if (current && current.score>=best.score-1e-9) return reset('当前分组已是策略最优（同分不切）');
  if (!current) return {state:{...next,candidate:null,count:0,status:'当前分组不合格，准备切换'},target:best.group.group_id};
  if(state.lastSwitchAt && now-state.lastSwitchAt<strategy.rules.cooldownMinutes*60000)return reset('切换冷却中');
  const improvement=strategy.mode==='weighted'?best.score-current.score:strategy.mode==='success'?(best.success-current.success)/Math.max(current.success,1e-12)*100:(current.metrics[strategy.mode]-best.metrics[strategy.mode])/Math.max(current.metrics[strategy.mode],1e-12)*100;
  if(improvement+1e-9<strategy.rules.minImprovement)return reset('改善幅度未达到要求');
  // Manual checks cannot turn one observation into two consecutive 5-minute observations.
  const consecutive=state.candidate===best.group.group_id && now-state.observedAt>=intervalMs-1000 && now-state.observedAt<=intervalMs*1.6;
  const tooSoon=state.candidate===best.group.group_id && now-state.observedAt<intervalMs-1000;
  const count=tooSoon ? state.count : consecutive ? (state.count||0)+1 : 1;
  const observedAt=tooSoon?state.observedAt:now;
  const ready=count>=strategy.rules.confirmRounds;
  return {state:{...next,candidate:best.group.group_id,count,observedAt,status:ready?`连续 ${count} 轮策略最优，准备切换`:`等待确认策略最优（${count}/${strategy.rules.confirmRounds}）`},target:ready?best.group.group_id:null};
}
export function reconcilePending(state,actual) {
  if (!state.pending) return {state};
  const {from,to}=state.pending;
  if (actual===to) return {state:{...state,pending:null,expectedGroupId:to,candidate:null,count:0,lastSwitchAt:Date.now(),status:'已确认切换成功'}};
  if (actual===from) return {pause:true,state:{...state,pending:null,expectedGroupId:from,candidate:null,count:0,status:'切换未生效，已暂停，请检查后恢复'}};
  return {pause:true,state:{...state,pending:null,expectedGroupId:actual,candidate:null,count:0,status:'切换期间发生外部改组，已暂停'}};
}
