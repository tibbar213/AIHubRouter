import {validateStrategy,validateUsage,strategyLabel,providerBadgeDetails,presetWeights} from './core.js';
const $=id=>document.getElementById(id);
let catalog={keys:[],models:[]},app,globalLoaded=false;
let appliedCatalogAt=0,connected=false;
const version=chrome.runtime.getManifest().version;
if(version)$('appVersion').textContent=version;
const defaultEditor=$('defaultStrategyForm');
function showView(view){
  for(const panel of document.querySelectorAll('[data-panel]'))panel.hidden=panel.dataset.panel!==view;
  for(const button of document.querySelectorAll('[data-view]'))button.setAttribute('aria-pressed',String(button.dataset.view===view));
  window.scrollTo({top:0,behavior:'instant'});
}
for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>showView(button.dataset.view);
document.querySelector('.brand').onclick=e=>{e.preventDefault();showView('monitors');};
$('connection').onclick=()=>showView('settings');
const viewSort=new Map();
const expandedCandidates=new Set();
const expandedExclusions=new Set();
const strategyEditors=new Map();
const expandStrategy=new Set();
let messageTimer;
const ruleInputs=['minSuccess','minCacheHit','minSamples','maxLatency','maxPrice','maxRate','confirmRounds','cooldownMinutes','minImprovement'];
const weightInputs=['price','latency','success','popularity','stars'];
async function send(message){let timer;const limit=message.type==='catalog'?35000:message.type==='state'?6000:0;const request=chrome.runtime.sendMessage(message);const reply=limit?await Promise.race([request,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('连接耗时过长，请检查 AIHub 登录状态和网络后重试。')),limit);})]).finally(()=>clearTimeout(timer)):await request;if(reply?.error)throw new Error(reply.error);if(!reply)throw new Error('插件后台未响应');return reply.result;}
function node(tag,text,cls){const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;}
function option(select,value,text){const o=node('option',text);o.value=value;select.append(o);}
function attachStrategyFields(form,strategy){
  form.prepend($('strategyFields').content.cloneNode(true));
  const fields=form.elements,s=validateStrategy(strategy);
  fields.mode.value=s.mode;
  for(const key of ruleInputs)fields[key].value=s.rules[key];
  for(const key of ['allowIds','denyIds'])fields[key].value=s.rules[key].join(', ');
  let custom={...s.weights};
  const fillWeights=mode=>{const w=presetWeights(mode,custom);for(const key of weightInputs)fields[key].value=w[key];};
  fillWeights(s.mode);
  form.addEventListener('change',event=>{if(event.target.name==='mode')fillWeights(event.target.value);});
  form.addEventListener('input',event=>{
    if(!weightInputs.includes(event.target.name))return;
    fields.mode.value='weighted';
    custom=Object.fromEntries(weightInputs.map(key=>[key,Number(fields[key].value)]));
  });
}
function readEditor(form,requireDetection,original){
  const fields=form.elements,mode=fields.mode.value;
  const rules=Object.fromEntries(ruleInputs.map(key=>[key,Number(fields[key].value)]));
  for(const key of ['allowIds','denyIds']){
    const value=fields[key].value.trim();
    rules[key]=value?value.split(/[\s,，]+/).map(Number):[];
  }
  const weights=mode==='weighted'?Object.fromEntries(weightInputs.map(key=>[key,Number(fields[key].value)])):original?.weights;
  return validateStrategy({mode,rules,requireDetection,weights});
}
function keyStrategyEditor(config){
  const form=node('form',null,'key-strategy-editor');
  form.setAttribute('aria-label',`Key ${config.keyId} 的策略`);
  attachStrategyFields(form,config.strategy);
  form.prepend(node('h4','权重与规则'));
  const actions=node('div',null,'actions'),save=node('button','保存策略'),cancel=node('button','取消','quiet');
  cancel.type='button';
  cancel.onclick=()=>{strategyEditors.delete(config.keyId);form.remove();refresh().catch(()=>{});};
  actions.append(save,cancel);form.append(actions);
  form.onsubmit=event=>{
    event.preventDefault();
    act(async()=>{
      await send({type:'keyStrategy',keyId:config.keyId,strategy:readEditor(form,config.strategy.requireDetection,config.strategy)});
      if(!config.paused)await send({type:'check'});
      strategyEditors.delete(config.keyId);
    });
  };
  return form;
}
function priceProfileText(usage){
  const u=validateUsage(usage);
  return `模型价格按输入:输出 ${u.inputRatio}:1 计算，缓存命中率${u.measuredCache?`优先用渠道实测值，无实测时按 ${u.cacheRate}%`:`固定按 ${u.cacheRate}%`}。`;
}
const format=(value,fn)=>value==null?'未知':fn(value);
const warningLabels={
  tool_errors:'工具调用错误',overloaded:'过载',interrupted:'连接中断',connection_failure:'连接失败',
  slow_response:'响应/连接缓慢',cyber:'策略拒绝',high_error:'高错误率',low_cache:'低缓存率',low_tps:'低 TPS'
};
const badgeNumber=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2});
const channelPriceNumber=new Intl.NumberFormat('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:8,useGrouping:false});
const minPriceNumber=new Intl.NumberFormat('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:6,useGrouping:false});
const channelPriceFields=[['input_per_million','输入'],['output_per_million','输出'],['cache_input_per_million','缓存输入'],['cache_write_per_million','缓存写入']];
function candidateBadgeCells(choice,now){
  const details=providerBadgeDetails(choice.hall,now),rank=details?.popularity;
  const popularity=node('td',rank?`${rank.rank} / ${rank.groups} · ${rank.window}`:'未知');
  popularity.dataset.label='消费名次';
  if(rank){
    popularity.title='平台同类分组的消费排名';
    if(rank.history_partial===true)popularity.append(node('div','历史不完整','muted'));
  }

  const warnings=node('td');
  warnings.dataset.label='平台告警';
  for(const {id,trigger} of details?.warnings??[]){
    const label=Object.hasOwn(warningLabels,id)?warningLabels[id]:id;
    const unit=id==='low_tps'?' t/s':'%';
    const operator=({'<=':'≤','>=':'≥'})[trigger.operator]??trigger.operator;
    const value=`${badgeNumber.format(trigger.value)}${unit} ${operator} ${badgeNumber.format(trigger.threshold)}${unit}`;
    const line=node('div',`${label} ${value} · ${trigger.window}`);
    if(id==='high_error')line.title='包含待完成的文本尝试';
    warnings.append(line);
  }
  if(details?.partial)warnings.append(node('div','历史不完整','muted'));
  if(!warnings.childNodes.length)warnings.textContent=!details || details.unknown?'未知':'—';
  return [popularity,warnings];
}
function channelPriceLines(price){
  const lines=[];
  for(const [field,label] of channelPriceFields){
    const value=price?.[field];
    if(Number.isFinite(value) && value>=0)lines.push(`${label} $${channelPriceNumber.format(value)}`);
  }
  const fallback=price?.fallback;
  if(lines.length && typeof fallback?.model==='string' && Array.isArray(fallback.fields) && fallback.fields.length){
    lines.push(`含 ${fallback.model} 兜底价`);
  }
  return lines;
}
function priceUnavailableTable(choices){
  const wrap=node('div',null,'table-wrap'),table=node('table'),head=node('thead'),header=node('tr'),body=node('tbody');
  const columns=['渠道','价格状态','渠道价（1×）','消费名次','平台告警'];
  header.append(...columns.map(label=>node('th',label)));
  head.append(header);
  const now=Date.now();
  for(const choice of choices){
    const row=node('tr');
    const channel=node('td',`${choice.code} [${choice.id}]`),status=node('td',choice.reason),price=node('td');
    channel.dataset.label=columns[0];
    status.dataset.label=columns[1];
    price.dataset.label=columns[2];
    const lines=channelPriceLines(choice.channelPrice);
    if(lines.length)price.append(...lines.map(line=>node('div',line)));
    else price.textContent='未知';
    row.append(channel,status,price,...candidateBadgeCells(choice,now));
    body.append(row);
  }
  table.append(head,body);
  wrap.append(table);
  return wrap;
}
function confirmAction(title,details,confirmLabel,message){
  const dialog=node('dialog');
  dialog.append(node('h2',title),...details.map(detail=>node('p',detail)));
  const actions=node('div',null,'actions'),cancel=node('button','取消','quiet'),confirm=node('button',confirmLabel);
  cancel.autofocus=true;
  cancel.onclick=()=>dialog.close();
  confirm.onclick=()=>{dialog.close();act(()=>send(message));};
  dialog.addEventListener('close',()=>dialog.remove());actions.append(cancel,confirm);dialog.append(actions);document.body.append(dialog);dialog.showModal();
}
function confirmSwitch(config,state,target){
  confirmAction('确认手动切换',[
    'Key '+config.keyId+' · '+config.model,'当前分组 '+state.expectedGroupId+' → '+target.code+' ['+target.id+']',
    '确认后会修改首选分组，并暂停此 key 的自动选择。平台故障转移设置保持原样。'
  ],'确认切换',{type:'manualSwitch',keyId:config.keyId,target:target.id,expectedGroupId:state.expectedGroupId});
}
function candidateTable(config,state){
  const wrap=node('div',null,'table-wrap'),table=node('table'),head=node('thead'),header=node('tr');
  const columns=[['code','渠道',v=>v],['rawMultiplier','原始倍率',v=>v+'×'],['accountMultiplier','账号倍率',v=>v+'×'],['stars','用户评分',v=>'★ '+v.toFixed(2)],['cost','模型价格',v=>'$'+v.toFixed(6)+'/M'],['latency','首响应延迟',v=>Math.round(v)+' ms'],['success','成功率',v=>(v*100).toFixed(2)+'%'],['cacheHit','缓存率',v=>(v*100).toFixed(2)+'%'],['detection','模型检测',v=>v],['popularityRank','消费名次',v=>String(v)]];
  const sort=viewSort.get(config.keyId)||{key:'score',direction:-1};
  const sortLabel=node('label','排序显示','compact-sort');const sortSelect=node('select');
  option(sortSelect,'score:-1',state.rankingBasis==='accountMultiplier'?'策略排序 · 账号倍率低优先':'策略排序');
  for(const [key,label] of columns){option(sortSelect,key+':1',label+' ↑');option(sortSelect,key+':-1',label+' ↓');}
  sortSelect.value=sort.key+':'+sort.direction;
  sortSelect.onchange=()=>{const [key,direction]=sortSelect.value.split(':');viewSort.set(config.keyId,{key,direction:Number(direction)});refresh().catch(e=>$('message').textContent=e.message);};
  sortLabel.append(sortSelect);wrap.append(sortLabel);
  if(state.choicesOutdated)wrap.append(node('p','策略已更改，列表仍是上次检查的结果，下次检查后按新策略重新排序。','muted'));
  if(state.rankingBasis==='accountMultiplier')wrap.append(node('p','全部合格渠道的模型价格缺失，本轮按账号倍率从低到高选择；同倍率保留当前渠道。','muted'));
  for(const [key,label] of columns){const th=node('th'),button=node('button',label+(sort.key===key?(sort.direction===1?' ↑':' ↓'):''),'column-sort');button.onclick=()=>{viewSort.set(config.keyId,{key,direction:sort.key===key?-sort.direction:['score','success','stars'].includes(key)?-1:1});refresh().catch(e=>$('message').textContent=e.message);};th.append(button);header.append(th);}
  header.append(node('th','平台告警'),node('th','操作'));head.append(header);table.append(head);const body=node('tbody');
  const choices=[...state.choices].sort((a,b)=>{const x=a[sort.key],y=b[sort.key];if(x==null)return y==null?0:1;if(y==null)return -1;return (typeof x==='number'?x-y:String(x).localeCompare(String(y)))*sort.direction;});
  const now=Date.now();
  for(const choice of choices){
    const row=node('tr');
    row.classList.toggle('current',choice.id===state.expectedGroupId);
    for(const [key,label,formatter] of columns){
      const value=key==='code'?`${choice.code} [${choice.id}]`:format(choice[key],formatter);
      const td=key==='popularityRank'?candidateBadgeCells(choice,now)[0]:node('td',value);

      if(key==='cost' && choice.cost==null && choice.priceReason){
        td.append(node('div',choice.priceReason,'muted'));
        const lines=channelPriceLines(choice.channelPrice);
        if(lines.length)td.append(node('div','渠道价 · 1× / 百万 Token','muted'),...lines.map(line=>node('div',line,'muted')));
      }
      td.dataset.label=label;
      row.append(td);
    }
    row.append(candidateBadgeCells(choice,now)[1]);
    const cell=node('td');cell.dataset.label='操作';if(choice.id===state.expectedGroupId)cell.append(node('span','当前','badge'));else{const button=node('button','切换','quiet');button.setAttribute('aria-label',`切换到 ${choice.code}`);button.disabled=!!state.pending||!!state.choicesOutdated;button.onclick=()=>confirmSwitch(config,state,choice);cell.append(button);}row.append(cell);body.append(row);
  }
  table.append(body);wrap.append(table);return wrap;
}
function modelSelect(keyId,config,pending){
  const prices=new Map(catalog.models.map(m=>[m.model,m.minPrice]));
  const models=[...prices.keys()];
  const select=node('select',null,'model-select');select.setAttribute('aria-label',`Key ${keyId} 的模型`);
  if(!config)option(select,'','未监控 · 选择模型');
  for(const model of models){const min=prices.get(model);option(select,model,Number.isFinite(min)?`${model} · 最低 $${minPriceNumber.format(min)}/M`:`${model} · 价格未知`);}
  if(config&&!models.includes(config.model))option(select,config.model,models.length?`${config.model}（本轮平台未列出）`:config.model);
  select.value=config?.model??'';
  select.disabled=!!pending;
  select.onchange=()=>{if(select.value&&select.value!==config?.model)act(()=>send({type:'configure',keyId,model:select.value,automatic:config?.automatic===true}));};
  return select;
}
function keyHeader(keyId,key,config,state){
  const top=node('div',null,'monitor-top'),info=node('div',null,'monitor-name');
  info.append(node('h3',key?.name??`Key ${keyId}`),node('span',`ID ${keyId}${key?` · 当前分组 ${key.groupId}`:''}`,'key-label'));
  const badge=config?node('span',config.paused?'已暂停':config.automatic?'自动运行':'仅预览',`badge ${config.paused?'paused':config.automatic?'auto':'preview'}`):node('span','未监控','badge');
  top.append(info,modelSelect(keyId,config,state?.pending),badge);
  return top;
}
async function refresh(){
  const data=await send({type:'state'});app=data.app;
  if(!globalLoaded){
    attachStrategyFields(defaultEditor,app.defaultStrategy);
    defaultEditor.elements.requireDetection.checked=app.defaultStrategy.requireDetection!==false;
    $('checkMinutes').value=app.checkMinutes||5;
    $('autoOpenProviders').checked=app.autoOpenProviders===true;
    const usage=$('usageForm').elements;
    usage.inputRatio.value=app.usage.inputRatio;usage.cacheRate.value=app.usage.cacheRate;usage.measuredCache.checked=app.usage.measuredCache;
    globalLoaded=true;
  }
  for(const keyId of strategyEditors.keys())if(!app.configs.some(c=>c.keyId===keyId))strategyEditors.delete(keyId);
  if(app.catalog && app.catalog.at!==appliedCatalogAt){catalog=app.catalog;appliedCatalogAt=catalog.at;}
  connected=data.connected;
  $('connection').textContent=data.connected?'平台已连接':'等待连接';
  $('connection').classList.toggle('connected',data.connected);
  $('monitorCount').textContent=app.configs.length;
  $('overview').replaceChildren(...[['自动运行',app.configs.filter(c=>!c.paused&&c.automatic).length,'auto'],['仅预览',app.configs.filter(c=>!c.paused&&!c.automatic).length,'preview'],['已暂停',app.configs.filter(c=>c.paused).length,'paused']].map(([label,value,tone])=>{const stat=node('div',null,'stat '+tone);stat.append(node('strong',String(value)),node('span',label));return stat;}));
  $('lastCheck').textContent=`每 ${app.checkMinutes||5} 分钟检查 · ${app.lastCheck?'上次完成 '+new Date(app.lastCheck).toLocaleString():'尚未完成检查'} · 模型目录${catalog.at?'更新于 '+new Date(catalog.at).toLocaleTimeString():'尚未读取'}${app.lastError?' · '+app.lastError:''}`;
  $('monitors').replaceChildren();
  const keyById=new Map(catalog.keys.map(k=>[k.id,k]));
  if(!app.configs.length&&!catalog.keys.length){const empty=node('div',null,'empty-state'),button=node('button','读取 key');button.onclick=()=>$('refreshCatalog').click();empty.append(node('strong','让每个模型找到合适的渠道'),node('p','还没有监控。先连接平台，再绑定 key 和模型。'),button);$('monitors').append(empty);}
  for(const c of app.configs){
    const s=app.states[c.keyId]||{},box=node('article',null,'monitor');
    const groupText=s.observedGroupId!=null?`原记录分组 ${s.expectedGroupId??'未知'} · 最近读取分组 ${s.observedGroupId}`:`最近确认分组 ${s.expectedGroupId??'未知'}`;
    box.append(keyHeader(c.keyId,keyById.get(c.keyId),c,s),node('p',`${c.paused?'已暂停':c.automatic?'自动切换':'仅预览'} · ${s.status||'等待检查'}`,'monitor-status'),node('p',`${groupText} · ${strategyLabel(c.strategy)}`,'monitor-meta'));
    const current=s.choices?.find(x=>x.id===s.expectedGroupId);
    if(current){const summary=node('div',null,'current-summary'),price=node('span',current.cost==null?'模型价格未知':'$'+current.cost.toFixed(6),'price');if(current.cost!=null)price.append(node('small',' /M'));summary.append(node('span','当前渠道','eyebrow'),node('span',current.code,'channel'),price);box.append(summary);}
    if(Array.isArray(s.choices)){const details=node('details',null,'candidate-details');details.open=expandedCandidates.has(c.keyId);details.addEventListener('toggle',()=>{if(details.open)expandedCandidates.add(c.keyId);else expandedCandidates.delete(c.keyId);});details.append(node('summary',`合格候选 · ${s.choices.length} 个`));if(s.choices.length)details.append(candidateTable(c,s),node('p',priceProfileText(app.usage)+' 显示排序不影响自动策略。手动切换会重新验证资格，并暂停此 key 的自动选择。','muted'));else details.append(node('p','当前没有符合筛选条件的渠道。展开下方“未参与比较”查看原因；下轮检查会重新评估。','muted'));box.append(details);}
    if(s.excluded&&Object.keys(s.excluded).length){
      const details=node('details',null,'exclusions'),list=node('div',null,'exclusion-list');
      details.open=expandedExclusions.has(c.keyId);
      details.ontoggle=()=>{if(details.open)expandedExclusions.add(c.keyId);else expandedExclusions.delete(c.keyId);};
      for(const [reason,count] of Object.entries(s.excluded)){
        const chip=node('span',null,'reason-chip');
        chip.append(node('span',reason),node('b',`${count} 个`));
        list.append(chip);
      }
      details.append(node('summary',`未参与比较 · ${Object.values(s.excluded).reduce((a,b)=>a+b,0)} 个渠道`),list);
      if(s.priceUnavailableChoices?.length){
        details.append(node('p','模型价格暂不可用的渠道 · 渠道价按 1×、每百万 Token 展示。','muted'),priceUnavailableTable(s.priceUnavailableChoices));
      }
      box.append(details);
    }
    const picker=node('div',null,'mode-switch');picker.setAttribute('role','group');picker.setAttribute('aria-label',`Key ${c.keyId} 的排序方式`);
    for(const [mode,label] of [['balanced','综合排序'],['price','模型价格'],['weighted','自定义']]){
      const button=node('button',label,'mode-switch-item');button.type='button';button.setAttribute('aria-pressed',String(c.strategy.mode===mode));button.disabled=!!s.pending;
      button.onclick=()=>{
        if(mode==='weighted')expandStrategy.add(c.keyId);
        if(c.strategy.mode===mode){if(mode==='weighted')refresh().catch(()=>{});return;}
        strategyEditors.delete(c.keyId);
        act(async()=>{await send({type:'keyStrategy',keyId:c.keyId,strategy:{...c.strategy,mode}});if(!c.paused)await send({type:'check'});});
      };
      picker.append(button);
    }
    box.querySelector('.monitor-meta').after(picker);
    if(expandStrategy.delete(c.keyId)&&!strategyEditors.has(c.keyId))strategyEditors.set(c.keyId,keyStrategyEditor(c));
    const controls=node('div',null,'monitor-controls');
    for(const [field,label,checked] of [['automatic','自动改组',c.automatic],['requireDetection','排除检测未通过',c.strategy.requireDetection!==false],['excludeWarnings','排除平台告警',c.excludeWarnings===true]]){
      const wrapper=node('label',null,'checkbox'),input=node('input');input.type='checkbox';input.checked=checked;input.disabled=!!s.pending;
      input.onchange=()=>act(()=>send({type:'toggleKey',keyId:c.keyId,field,enabled:input.checked}));
      wrapper.append(input,document.createTextNode(label));
      if(field==='automatic')wrapper.append(node('span','开启后会自动修改该 Key 的分组','muted'));
      controls.append(wrapper);
    }
    const footer=node('div',null,'monitor-footer');
    const actions=node('div',null,'actions');
    const adjust=node('button',strategyEditors.has(c.keyId)?'收起权重与规则':'权重与规则','quiet');
    adjust.setAttribute('aria-expanded',String(strategyEditors.has(c.keyId)));
    adjust.onclick=()=>{
      let editor=strategyEditors.get(c.keyId);
      if(editor){strategyEditors.delete(c.keyId);editor.remove();adjust.textContent='权重与规则';adjust.setAttribute('aria-expanded','false');return;}
      editor=keyStrategyEditor(c);strategyEditors.set(c.keyId,editor);box.append(editor);
      adjust.textContent='收起权重与规则';adjust.setAttribute('aria-expanded','true');
      editor.querySelector('[name=mode]:checked')?.focus();
    };
    actions.append(adjust);
    const pauseResume=node('button',c.paused?'恢复':'暂停','quiet');
    pauseResume.onclick=()=>act(()=>send({type:c.paused?'resume':'pause',keyId:c.keyId}));
    actions.append(pauseResume);
    const remove=node('button','移除监控','quiet danger');remove.onclick=()=>confirmAction('确认移除监控',['Key '+c.keyId+' · '+c.model,'移除后将停止此 Key 的检查和自动改组。'],'确认移除',{type:'remove',keyId:c.keyId});actions.append(remove);footer.append(controls,actions);box.append(footer);
    const editor=strategyEditors.get(c.keyId);if(editor)box.append(editor);
    $('monitors').append(box);
  }
  for(const k of catalog.keys){
    if(app.configs.some(c=>c.keyId===k.id))continue;
    const box=node('article',null,'monitor idle');box.append(keyHeader(k.id,k,null,null));$('monitors').append(box);
  }
  $('logs').replaceChildren(...app.logs.map(l=>{const item=node('li'),time=node('time',new Date(l.at).toLocaleString());time.dateTime=new Date(l.at).toISOString();item.append(time,node('span',l.text));return item;}));
  if(!app.logs.length)$('logs').append(node('li','暂无记录。连接平台并添加监控后，检查与切换动态会显示在这里。'));
}
async function act(fn){
  clearTimeout(messageTimer);
  $('message').textContent='正在处理…';$('message').dataset.tone='busy';const buttons=[...document.querySelectorAll('button')].map(b=>[b,b.disabled]);buttons.forEach(([b])=>b.disabled=true);
  try{await fn();if($('message').textContent==='正在处理…')$('message').textContent='已完成';$('message').dataset.tone='success';await refresh();if($('message').textContent==='已完成')messageTimer=setTimeout(()=>{$('message').textContent='';},4500);}catch(e){$('message').textContent=e.message;$('message').dataset.tone='error';}finally{buttons.forEach(([b,was])=>b.disabled=was);}
}
$('catalog').onclick=$('refreshCatalog').onclick=()=>act(async()=>{catalog=await send({type:'catalog'});appliedCatalogAt=catalog.at;});
$('disconnect').onclick=()=>confirmAction('确认断开并暂停',['将断开平台连接并暂停全部监控。'],'确认断开',{type:'disconnect'});
$('resetAccount').onclick=()=>confirmAction('确认清空账号绑定',['移除全部监控后，可清空保存的账号绑定并连接其他账号。'],'确认清空',{type:'resetAccount'});
$('autoOpenProviders').onchange=event=>act(()=>send({type:'autoOpen',enabled:event.target.checked}));
$('check').onclick=()=>act(async()=>{const r=await send({type:'check',manual:true});if(r&&r.ok===false)throw new Error(r.error||'检查失败');if(r&&r.note)$('message').textContent=r.note;});
$('usageForm').onsubmit=event=>{event.preventDefault();const f=event.target.elements;
  act(async()=>{await send({type:'strategy',strategy:app.defaultStrategy,usage:{inputRatio:Number(f.inputRatio.value),cacheRate:Number(f.cacheRate.value),measuredCache:f.measuredCache.checked}});
    globalLoaded=false;});};
defaultEditor.onsubmit=event=>{event.preventDefault();act(()=>send({type:'strategy',strategy:readEditor(defaultEditor,defaultEditor.elements.requireDetection.checked,app.defaultStrategy),checkMinutes:Number($('checkMinutes').value)}));};
refresh().then(()=>{if(connected&&!catalog.keys.length)$('refreshCatalog').click();}).catch(e=>$('message').textContent=e.message);
setInterval(()=>{if(!document.querySelector('dialog[open]')&&!document.activeElement?.matches('input,select'))refresh().catch(()=>{});},20000);
