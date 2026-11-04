import {DEFAULT_STRATEGY,validateStrategy,strategyLabel} from './core.js';
const $=id=>document.getElementById(id);
let catalog={keys:[],models:[]},app,globalLoaded=false;
let appliedCatalogAt=0;
const editorDetection={global:true,key:true};
function showView(view){
  for(const panel of document.querySelectorAll('[data-panel]'))panel.hidden=panel.dataset.panel!==view;
  for(const button of document.querySelectorAll('[data-view]'))button.setAttribute('aria-pressed',String(button.dataset.view===view));
  window.scrollTo({top:0,behavior:'instant'});
}
for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>showView(button.dataset.view);
document.querySelector('.brand').onclick=e=>{e.preventDefault();showView('monitors');};
function addMonitor(){
  $('keyId').value='';$('model').value='';$('automatic').checked=false;$('keyOverride').checked=false;setEditor('key',app?.defaultStrategy||DEFAULT_STRATEGY);
  showView('settings');$('configForm').scrollIntoView({behavior:'smooth',block:'center'});
}
$('addKey').onclick=addMonitor;
$('connection').onclick=()=>showView('settings');
const viewSort=new Map();
const expandedCandidates=new Set();
const expandedExclusions=new Set();
let messageTimer;
const ruleInputs={MinSuccess:'minSuccess',MinSamples:'minSamples',MaxLatency:'maxLatency',MaxPrice:'maxPrice',MaxRate:'maxRate',ConfirmRounds:'confirmRounds',CooldownMinutes:'cooldownMinutes',MinImprovement:'minImprovement'};
async function send(message){let timer;const limit=message.type==='catalog'?35000:message.type==='state'?6000:0;const request=chrome.runtime.sendMessage(message);const reply=limit?await Promise.race([request,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('连接耗时过长，请检查 AIHub 登录状态和网络后重试。')),limit);})]).finally(()=>clearTimeout(timer)):await request;if(reply?.error)throw new Error(reply.error);if(!reply)throw new Error('插件后台未响应');return reply.result;}
function node(tag,text,cls){const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;}
function option(select,value,text){const o=node('option',text);o.value=value;select.append(o);}
function toggleEditor(prefix){
  const enabled=prefix!=='key'||$('keyOverride').checked;
  const weighted=$(prefix+'Mode').value==='weighted';
  $(prefix+'Weights').hidden=!weighted;
  for(const name of ['Price','Latency','Success'])$(prefix+name).disabled=!enabled||!weighted;
  if(prefix==='key'){$('keyStrategy').hidden=!enabled;$('keyMode').disabled=!enabled;}
  if(prefix==='key')for(const input of $('keyAdvanced').querySelectorAll('input'))input.disabled=!enabled;
}
function setEditor(prefix,strategy){
  const s=validateStrategy(strategy||DEFAULT_STRATEGY);$(prefix+'Mode').value=s.mode;
  editorDetection[prefix]=s.requireDetection;
  for(const [id,key] of Object.entries(ruleInputs))$(prefix+id).value=s.rules[key];
  for(const id of ['AllowIds','DenyIds'])$(prefix+id).value=s.rules[id==='AllowIds'?'allowIds':'denyIds'].join(', ');
  for(const [name,key] of [['Price','price'],['Latency','latency'],['Success','success']])$(prefix+name).value=s.weights[key];
  toggleEditor(prefix);
}
function readEditor(prefix){
  const mode=$(prefix+'Mode').value;
  const rules=Object.fromEntries(Object.entries(ruleInputs).map(([id,key])=>[key,Number($(prefix+id).value)]));
  const ids=id=>$(prefix+id).value.trim()?$(prefix+id).value.trim().split(/[\s,，]+/).map(Number):[];
  rules.allowIds=ids('AllowIds');rules.denyIds=ids('DenyIds');
  return validateStrategy({mode,rules,requireDetection:editorDetection[prefix],weights:mode==='weighted'?{price:Number($(prefix+'Price').value),latency:Number($(prefix+'Latency').value),success:Number($(prefix+'Success').value)}:DEFAULT_STRATEGY.weights});
}
const format=(value,fn)=>value==null?'未知':fn(value);
function confirmSwitch(config,state,target){
  const dialog=node('dialog');dialog.append(node('h2','确认手动切换'),node('p',`Key ${config.keyId} · ${config.model}`),node('p',`当前分组 ${state.expectedGroupId} → ${target.code} [${target.id}]`),node('p','确认后会真实修改首选分组，并暂停此 key 的自动选择。平台故障转移设置保持原样。'));
  const actions=node('div',null,'actions'),cancel=node('button','取消','quiet'),confirm=node('button','确认切换');
  cancel.onclick=()=>dialog.close();confirm.onclick=()=>{dialog.close();act(()=>send({type:'manualSwitch',keyId:config.keyId,target:target.id,expectedGroupId:state.expectedGroupId}));};
  dialog.addEventListener('close',()=>dialog.remove());actions.append(cancel,confirm);dialog.append(actions);document.body.append(dialog);dialog.showModal();
}
function candidateTable(config,state){
  const wrap=node('div',null,'table-wrap'),table=node('table'),head=node('thead'),header=node('tr');
  const columns=[['code','渠道',v=>v],['rawMultiplier','原始倍率',v=>v+'×'],['accountMultiplier','账号倍率',v=>v+'×'],['stars','用户评分',v=>'★ '+v.toFixed(2)],['cost','真实价格',v=>'￥'+v.toFixed(6)+'/M'],['latency','首响应延迟',v=>Math.round(v)+' ms'],['success','成功率',v=>(v*100).toFixed(2)+'%'],['detection','模型检测',v=>v]];
  const sort=viewSort.get(config.keyId)||{key:'score',direction:-1};
  const sortLabel=node('label','排序显示','compact-sort');const sortSelect=node('select');
  option(sortSelect,'score:-1','策略最优');
  for(const [key,label] of columns){option(sortSelect,key+':1',label+' ↑');option(sortSelect,key+':-1',label+' ↓');}
  sortSelect.value=sort.key+':'+sort.direction;
  sortSelect.onchange=()=>{const [key,direction]=sortSelect.value.split(':');viewSort.set(config.keyId,{key,direction:Number(direction)});refresh().catch(e=>$('message').textContent=e.message);};
  sortLabel.append(sortSelect);wrap.append(sortLabel);
  for(const [key,label] of columns){const th=node('th'),button=node('button',label+(sort.key===key?(sort.direction===1?' ↑':' ↓'):''),'column-sort');button.onclick=()=>{viewSort.set(config.keyId,{key,direction:sort.key===key?-sort.direction:['score','success','stars'].includes(key)?-1:1});refresh().catch(e=>$('message').textContent=e.message);};th.append(button);header.append(th);}
  header.append(node('th','操作'));head.append(header);table.append(head);const body=node('tbody');
  const choices=[...state.choices].sort((a,b)=>{const x=a[sort.key],y=b[sort.key];if(x==null)return y==null?0:1;if(y==null)return -1;return (typeof x==='number'?x-y:String(x).localeCompare(String(y)))*sort.direction;});
  for(const choice of choices){const row=node('tr');row.classList.toggle('current',choice.id===state.expectedGroupId);for(const [key,,formatter] of columns){const value=key==='code'?`${choice.code} [${choice.id}]`:format(choice[key],formatter);const td=node('td',value);if(key==='cost'&&choice.estimated)td.append(node('small',`估算 · ${choice.priceSamples} 条样本`,'price-estimate'));td.dataset.label=columns.find(col=>col[0]===key)[1];row.append(td);}
    const cell=node('td');cell.dataset.label='操作';if(choice.id===state.expectedGroupId)cell.append(node('span','当前','badge'));else{const button=node('button','切换','quiet');button.setAttribute('aria-label',`切换到 ${choice.code}`);button.disabled=!!state.pending;button.onclick=()=>confirmSwitch(config,state,choice);cell.append(button);}row.append(cell);body.append(row);
  }
  table.append(body);wrap.append(table);return wrap;
}
function fillCatalog(){
  const selectedKey=$('keyId').value,selectedModel=$('model').value;
  $('keyId').replaceChildren();option($('keyId'),'','选择已有 key');
  for(const k of catalog.keys)option($('keyId'),String(k.id),`${k.name} · ID ${k.id} · 当前分组 ${k.groupId}`);
  $('model').replaceChildren();option($('model'),'','选择此 key 固定使用的模型');
  for(const m of catalog.models)option($('model'),JSON.stringify(m),`${({openai:'OpenAI',kimi:'Kimi',zhipu:'智谱 GLM',grok:'Grok',deepseek:'DeepSeek',gemini:'Gemini'})[m.platform]||m.platform} / ${m.model}`);
  if(selectedModel&&!Array.from($('model').options).some(x=>x.value===selectedModel))option($('model'),selectedModel,'此前选择的模型（本轮平台未列出）');
  $('keyId').value=selectedKey;$('model').value=selectedModel;
}
async function refresh(){
  const data=await send({type:'state'});app=data.app;
  if(!globalLoaded){setEditor('global',app.defaultStrategy);$('checkMinutes').value=app.checkMinutes||5;globalLoaded=true;}
  if(app.catalog && app.catalog.at!==appliedCatalogAt){catalog=app.catalog;fillCatalog();appliedCatalogAt=catalog.at;}
  $('connection').textContent=data.connected?'平台已连接':'等待连接';
  $('connection').classList.toggle('connected',data.connected);
  $('monitorCount').textContent=app.configs.length;
  $('overview').replaceChildren(...[['自动运行',app.configs.filter(c=>!c.paused&&c.automatic).length],['仅预览',app.configs.filter(c=>!c.paused&&!c.automatic).length],['已暂停',app.configs.filter(c=>c.paused).length]].map(([label,value])=>{const stat=node('div',null,'stat');stat.append(node('strong',String(value)),node('span',label));return stat;}));
  $('lastCheck').textContent=`每 ${app.checkMinutes||5} 分钟检查 · ${app.lastCheck?'上次完成 '+new Date(app.lastCheck).toLocaleString():'尚未完成检查'} · 模型目录${catalog.at?'更新于 '+new Date(catalog.at).toLocaleTimeString():'尚未读取'}${app.lastError?' · '+app.lastError:''}`;
  $('monitors').replaceChildren();
  if(!app.configs.length){const empty=node('div',null,'empty-state'),button=node('button','添加第一个监控');button.onclick=addMonitor;empty.append(node('strong','让每个模型找到合适的渠道'),node('p','还没有监控。先连接平台，再绑定 key 和模型。'),button);$('monitors').append(empty);}
  for(const c of app.configs){
    const s=app.states[c.keyId]||{},box=node('article',null,'monitor');
    const groupText=s.observedGroupId!=null?`原记录分组 ${s.expectedGroupId??'未知'} · 最近读取分组 ${s.observedGroupId}`:`最近确认分组 ${s.expectedGroupId??'未知'}`;
    const top=node('div',null,'monitor-top'),name=node('div',null,'monitor-name');name.append(node('h3',`${c.model} · Key ${c.keyId}`));top.append(name,node('span',c.paused?'已暂停':c.automatic?'自动运行':'仅预览',`badge ${c.paused?'paused':c.automatic?'auto':'preview'}`));
    box.append(top,node('p',`${c.paused?'已暂停':c.automatic?'自动切换':'仅预览'} · ${s.status||'等待检查'}`,'monitor-status'),node('p',`${groupText} · ${c.strategy?'独立策略':'继承全局'} · ${strategyLabel(c.strategy||app.defaultStrategy)}`,'monitor-meta'));
    const current=s.choices?.find(x=>x.id===s.expectedGroupId);
    if(current){const summary=node('div',null,'current-summary'),price=node('span',format(current.cost,v=>'￥'+v.toFixed(6)),'price');price.append(node('small',' /M'));summary.append(node('span','当前渠道','eyebrow'),node('span',current.code,'channel'),price);if(current.estimated)summary.append(node('span','估算','badge preview'));box.append(summary);}
    if(Array.isArray(s.choices)){const details=node('details',null,'candidate-details');details.open=expandedCandidates.has(c.keyId);details.addEventListener('toggle',()=>{if(details.open)expandedCandidates.add(c.keyId);else expandedCandidates.delete(c.keyId);});details.append(node('summary',`合格候选 · ${s.choices.length} 个`));if(s.choices.length)details.append(candidateTable(c,s),node('p','显示排序不影响自动策略。手动切换会重新验证资格，并暂停此 key 的自动选择。','muted'));else details.append(node('p','当前没有符合筛选条件的渠道。展开下方“未参与比较”查看原因；下轮检查会重新评估。','muted'));box.append(details);}
    if(s.excluded&&Object.keys(s.excluded).length){const details=node('details',null,'exclusions'),list=node('div',null,'exclusion-list');details.open=expandedExclusions.has(c.keyId);details.ontoggle=()=>{if(details.open)expandedExclusions.add(c.keyId);else expandedExclusions.delete(c.keyId);};for(const [reason,count] of Object.entries(s.excluded)){const chip=node('span',null,'reason-chip');chip.append(node('span',reason),node('b',`${count} 个`));list.append(chip);}details.append(node('summary',`未参与比较 · ${Object.values(s.excluded).reduce((a,b)=>a+b,0)} 个渠道`),list);box.append(details);}
    const controls=node('div',null,'monitor-controls');
    for(const [field,label,checked] of [['override','使用独立策略',!!c.strategy],['automatic','自动改组',c.automatic],['requireDetection','排除检测未通过', (c.strategy||app.defaultStrategy).requireDetection!==false]]){
      const wrapper=node('label',null,'checkbox'),input=node('input');input.type='checkbox';input.checked=checked;
      input.onchange=()=>act(()=>send({type:'toggleKey',keyId:c.keyId,field,enabled:input.checked}));
      wrapper.append(input,document.createTextNode(label));controls.append(wrapper);
    }
    box.append(controls);
    if(!c.strategy)box.append(node('p','更改此 key 的检测筛选后，将为它启用独立策略。','muted'));
    const actions=node('div',null,'actions');
    const edit=node('button','编辑','quiet');edit.addEventListener('click',()=>act(async()=>{
      if(!catalog.keys.length){catalog=await send({type:'catalog'});fillCatalog();}
      $('keyId').value=String(c.keyId);$('model').value=JSON.stringify({platform:c.platform,model:c.model});$('automatic').checked=c.automatic;
      $('keyOverride').checked=!!c.strategy;setEditor('key',c.strategy||app.defaultStrategy);
      showView('settings');$('configForm').scrollIntoView({behavior:'smooth',block:'center'});$('message').textContent='配置已载入。检查后点击“保存 key 配置”即可恢复监控。';
    }));actions.append(edit);
    if(!c.paused){const pause=node('button','暂停','quiet');pause.onclick=()=>act(()=>send({type:'pause',keyId:c.keyId}));actions.append(pause);}
    const remove=node('button','移除监控','quiet danger');remove.onclick=()=>act(()=>send({type:'remove',keyId:c.keyId}));actions.append(remove);box.append(actions);$('monitors').append(box);
  }
  $('logs').replaceChildren(...app.logs.map(l=>node('li',`${new Date(l.at).toLocaleString()} · ${l.text}`)));
  if(!app.logs.length)$('logs').append(node('li','暂无记录。连接平台并添加监控后，检查与切换动态会显示在这里。'));
}
async function act(fn){
  clearTimeout(messageTimer);
  $('message').textContent='正在处理…';$('message').dataset.tone='busy';const buttons=[...document.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
  try{await fn();if($('message').textContent==='正在处理…')$('message').textContent='已完成';$('message').dataset.tone='success';await refresh();if($('message').textContent==='已完成')messageTimer=setTimeout(()=>{$('message').textContent='';},4500);}catch(e){$('message').textContent=e.message;$('message').dataset.tone='error';}finally{buttons.forEach(b=>b.disabled=false);}
}
$('catalog').onclick=()=>act(async()=>{catalog=await send({type:'catalog'});fillCatalog();});
$('disconnect').onclick=()=>act(()=>send({type:'disconnect'}));
$('resetAccount').onclick=()=>act(()=>send({type:'resetAccount'}));
$('check').onclick=()=>act(()=>send({type:'check'}));
$('saveStrategy').onclick=()=>act(()=>send({type:'strategy',strategy:readEditor('global'),checkMinutes:Number($('checkMinutes').value)}));
for(const prefix of ['global','key'])$(prefix+'Mode').onchange=()=>toggleEditor(prefix);
$('keyOverride').onchange=()=>toggleEditor('key');
$('keyId').onchange=()=>{const c=app?.configs.find(c=>c.keyId===Number($('keyId').value));$('automatic').checked=c?.automatic===true;$('keyOverride').checked=!!c?.strategy;setEditor('key',c?.strategy||app?.defaultStrategy||DEFAULT_STRATEGY);if(c)$('model').value=JSON.stringify({platform:c.platform,model:c.model});};
setEditor('key',DEFAULT_STRATEGY);
$('configForm').onsubmit=event=>{event.preventDefault();act(async()=>{const m=JSON.parse($('model').value);await send({type:'configure',keyId:Number($('keyId').value),...m,strategy:$('keyOverride').checked?readEditor('key'):null,automatic:$('automatic').checked});showView('monitors');});};
refresh().catch(e=>$('message').textContent=e.message);
setInterval(()=>{if(!document.querySelector('dialog[open]')&&!document.activeElement?.matches('input,select'))refresh().catch(()=>{});},20000);
