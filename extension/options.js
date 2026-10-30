import {DEFAULT_STRATEGY,validateStrategy,strategyLabel} from './core.js';
const $=id=>document.getElementById(id);
let catalog={keys:[],models:[]},app,globalLoaded=false;
let appliedCatalogAt=0;
const viewSort=new Map();
const expandedCandidates=new Set();
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
  $(prefix+'Detection').checked=s.requireDetection;
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
  return validateStrategy({mode,rules,requireDetection:$(prefix+'Detection').checked,weights:mode==='weighted'?{price:Number($(prefix+'Price').value),latency:Number($(prefix+'Latency').value),success:Number($(prefix+'Success').value)}:DEFAULT_STRATEGY.weights});
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
  for(const choice of choices){const row=node('tr');for(const [key,,formatter] of columns){const td=node('td',key==='code'?`${choice.code} [${choice.id}]`:format(choice[key],formatter));td.dataset.label=columns.find(col=>col[0]===key)[1];row.append(td);}
    const cell=node('td');cell.dataset.label='操作';if(choice.id===state.expectedGroupId)cell.append(node('span','当前','badge'));else{const button=node('button','切换','quiet');button.setAttribute('aria-label',`切换到 ${choice.code}`);button.disabled=!!state.pending;button.onclick=()=>confirmSwitch(config,state,choice);cell.append(button);}row.append(cell);body.append(row);
  }
  table.append(body);wrap.append(table);return wrap;
}
function fillCatalog(){
  const selectedKey=$('keyId').value,selectedModel=$('model').value;
  $('keyId').replaceChildren();option($('keyId'),'','选择已有 key');
  for(const k of catalog.keys)option($('keyId'),String(k.id),`${k.name} · ID ${k.id} · 当前分组 ${k.groupId}`);
  $('model').replaceChildren();option($('model'),'','选择此 key 固定使用的模型');
  for(const m of catalog.models)option($('model'),JSON.stringify(m),`${({openai:'OpenAI',kimi:'Kimi',zhipu:'智谱 GLM',grok:'Grok',deepseek:'DeepSeek'})[m.platform]} / ${m.model}`);
  if(selectedModel&&!Array.from($('model').options).some(x=>x.value===selectedModel))option($('model'),selectedModel,'此前选择的模型（本轮平台未列出）');
  $('keyId').value=selectedKey;$('model').value=selectedModel;
}
async function refresh(){
  const data=await send({type:'state'});app=data.app;
  if(!globalLoaded){setEditor('global',app.defaultStrategy);$('checkMinutes').value=app.checkMinutes||5;globalLoaded=true;}
  if(app.catalog && app.catalog.at!==appliedCatalogAt){catalog=app.catalog;fillCatalog();appliedCatalogAt=catalog.at;}
  $('connection').textContent=data.connected?'已捕获网站会话':'等待网站登录';
  $('lastCheck').textContent=`每 ${app.checkMinutes||5} 分钟检查 · ${app.lastCheck?'上次完成 '+new Date(app.lastCheck).toLocaleString():'尚未完成检查'} · 模型目录${catalog.at?'更新于 '+new Date(catalog.at).toLocaleTimeString():'尚未读取'}${app.lastError?' · '+app.lastError:''}`;
  $('monitors').replaceChildren();
  if(!app.configs.length)$('monitors').append(node('p','还没有监控。先连接平台，再绑定 key 和模型。','muted'));
  for(const c of app.configs){
    const s=app.states[c.keyId]||{},box=node('article',null,'monitor');
    box.append(node('h3',`${c.model} · Key ${c.keyId}`),node('p',`${c.paused?'已暂停':c.automatic?'自动切换':'仅预览'} · ${s.status||'等待检查'}`),node('p',`当前分组 ${s.expectedGroupId??'未知'} · ${c.strategy?'独立策略':'继承全局'} · ${strategyLabel(c.strategy||app.defaultStrategy)}`,'muted'));
    if(s.choices?.length){const details=node('details');details.open=expandedCandidates.has(c.keyId);details.addEventListener('toggle',()=>{if(details.open)expandedCandidates.add(c.keyId);else expandedCandidates.delete(c.keyId);});details.append(node('summary',`合格候选 · ${s.choices.length} 个`),candidateTable(c,s),node('p','使用排序控件调整显示顺序，不改变自动选择策略。手动切换前会重新检查资格，切换后暂停自动选择。','muted'));box.append(details);}
    if(s.excluded&&Object.keys(s.excluded).length)box.append(node('p','未参与比较：'+Object.entries(s.excluded).map(([reason,count])=>`${reason} ${count} 个`).join('；'),'muted'));
    const controls=node('div',null,'monitor-controls');
    for(const [field,label,checked] of [['override','使用独立策略',!!c.strategy],['automatic','自动改组',c.automatic]]){
      const wrapper=node('label',null,'checkbox'),input=node('input');input.type='checkbox';input.checked=checked;
      input.onchange=()=>act(()=>send({type:'toggleKey',keyId:c.keyId,field,enabled:input.checked}));
      wrapper.append(input,document.createTextNode(label));controls.append(wrapper);
    }
    box.append(controls);
    const actions=node('div',null,'actions');
    const edit=node('button','编辑','quiet');edit.addEventListener('click',()=>act(async()=>{
      if(!catalog.keys.length){catalog=await send({type:'catalog'});fillCatalog();}
      $('keyId').value=String(c.keyId);$('model').value=JSON.stringify({platform:c.platform,model:c.model});$('automatic').checked=c.automatic;
      $('keyOverride').checked=!!c.strategy;setEditor('key',c.strategy||app.defaultStrategy);
      $('configForm').scrollIntoView({behavior:'smooth',block:'center'});$('message').textContent='配置已载入。检查后点击“保存 key 配置”即可恢复监控。';
    }));actions.append(edit);
    if(!c.paused){const pause=node('button','暂停','quiet');pause.onclick=()=>act(()=>send({type:'pause',keyId:c.keyId}));actions.append(pause);}
    const remove=node('button','移除监控','quiet');remove.onclick=()=>act(()=>send({type:'remove',keyId:c.keyId}));actions.append(remove);box.append(actions);$('monitors').append(box);
  }
  $('logs').replaceChildren(...app.logs.map(l=>node('li',`${new Date(l.at).toLocaleString()} · ${l.text}`)));
}
async function act(fn){
  $('message').textContent='正在处理…';const buttons=[...document.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
  try{await fn();if($('message').textContent==='正在处理…')$('message').textContent='已完成';await refresh();}catch(e){$('message').textContent=e.message;}finally{buttons.forEach(b=>b.disabled=false);}
}
$('catalog').onclick=()=>act(async()=>{catalog=await send({type:'catalog'});fillCatalog();});
$('disconnect').onclick=()=>act(()=>send({type:'disconnect'}));
$('resetAccount').onclick=()=>act(()=>send({type:'resetAccount'}));
$('check').onclick=()=>act(()=>send({type:'check'}));
$('saveStrategy').onclick=()=>act(()=>send({type:'strategy',strategy:readEditor('global'),checkMinutes:Number($('checkMinutes').value)}));
for(const prefix of ['global','key'])$(prefix+'Mode').onchange=()=>toggleEditor(prefix);
$('keyOverride').onchange=()=>toggleEditor('key');
setEditor('key',DEFAULT_STRATEGY);
$('configForm').onsubmit=event=>{event.preventDefault();act(async()=>{const m=JSON.parse($('model').value);await send({type:'configure',keyId:Number($('keyId').value),...m,strategy:$('keyOverride').checked?readEditor('key'):null,automatic:$('automatic').checked});});};
refresh().catch(e=>$('message').textContent=e.message);
setInterval(()=>{if(!document.querySelector('dialog[open]'))refresh().catch(()=>{});},20000);
