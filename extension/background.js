import {decide,reconcilePending,migrateApp,validateStrategy,DEFAULT_STRATEGY,PLATFORMS,INTERVAL} from './core.js';
const ORIGIN='https://aihub.top', ALARM='aihub-check';
const initial=()=>({configs:[],states:{},logs:[],notices:{},schemaVersion:6,checkMinutes:5,defaultStrategy:validateStrategy(DEFAULT_STRATEGY),account:null});
let queue=Promise.resolve();
const urgentPause=new Set();
let disconnectRequested=false;
function serial(fn) { const p=queue.then(fn,fn); queue=p.catch(()=>{}); return p; }
async function load(){ const app=(await chrome.storage.local.get('app')).app||initial(); if(migrateApp(app)){log(app,'已升级为可配置排序策略，观察计数已重置');await save(app);} return app; }
async function save(app){await chrome.storage.local.set({app});}
function log(app,text){app.logs.unshift({at:Date.now(),text});app.logs=app.logs.slice(0,150);}
async function notice(app,id,text){
  if(app.notices[id])return;
  app.notices[id]=true; log(app,text);
  try{await chrome.notifications.create(id,{type:'basic',iconUrl:'icon.png',title:'AIHubRouter',message:text});}catch{log(app,'浏览器通知未送达，请检查通知权限');}
}
async function api(path,{method='GET',body}={}){
  const {auth}=await chrome.storage.session.get('auth');
  if(!auth)throw new Error('AUTH');
  let response;
  try{response=await fetch(ORIGIN+path,{method,credentials:'include',cache:'no-store',redirect:'error',headers:{Authorization:auth,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(8000)});}catch{throw new Error('NETWORK');}
  if(response.status===401) {await chrome.storage.session.remove('auth');throw new Error('AUTH');}
  if(!response.ok)throw new Error(response.status===403?'FORBIDDEN':'HTTP');
  let json;try{json=await response.json();}catch{throw new Error('FORMAT');}
  if(json.code!==0 || !Object.hasOwn(json,'data'))throw new Error('BUSINESS');
  return json.data;
}
async function bounded(promise,ms,message){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms);})]);}finally{clearTimeout(timer);}}
async function connectOpenTab(){
  if((await chrome.storage.session.get('auth')).auth)return;
  const tabs=await bounded(chrome.tabs.query({url:'https://aihub.top/*'}),4000,'TAB_TIMEOUT');
  for(const tab of tabs.slice(0,3)){
    if(!tab.id)continue;
    try{
      const result=await bounded(chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:()=>localStorage.getItem('auth_token')}),4000,'TAB_TIMEOUT');
      const token=result[0]?.result;
      if(typeof token==='string' && token.length>0 && token.length<16000){await chrome.storage.session.set({auth:'Bearer '+token});return;}
    }catch{}
  }
}
async function identity(app){
  const me=await api('/api/v1/auth/me');
  if(!Number.isSafeInteger(me.id))throw new Error('FORMAT');
  if(app.account!=null && app.account!==me.id){
    for(const c of app.configs)c.paused=true;
    app.accountMismatch=true;
    await notice(app,'account','网站账号发生变化，所有监控已暂停。请移除旧配置，再连接新账号。');
    await save(app);throw new Error('ACCOUNT');
  }
  app.account=me.id;return me;
}
function safeKey(k){return {id:k.id,name:k.name||`Key ${k.id}`,groupId:k.group_id,status:k.status,maxRate:k.max_rate_multiplier};}
async function keys(){
  const result=[], deadline=Date.now()+12000;
  for(let page=1;page<=100;page++){
    if(Date.now()>deadline)throw new Error('NETWORK');
    const data=await api(`/api/v1/keys?page=${page}&page_size=100`);
    if(!Array.isArray(data.items))throw new Error('FORMAT');
    result.push(...data.items.map(safeKey));
    if(page>=(data.pages||1))return result;
  }throw new Error('FORMAT');
}
async function providers(){
  const d=await api('/api/v2/public/providers?range=1h&include_media=false&timezone=Asia%2FShanghai');
  if(!Array.isArray(d.items) || d.items.some(g=>!Number.isSafeInteger(g.group_id)) || new Set(d.items.map(g=>g.group_id)).size!==d.items.length)throw new Error('FORMAT');
  return d;
}
async function authorizedSnapshot(){
  const [snapshot,available,rates]=await Promise.all([providers(),api('/api/v1/groups/available'),api('/api/v1/groups/rates')]);
  if(!Array.isArray(available) || (rates!==null && (typeof rates!=='object'||Array.isArray(rates))))throw new Error('FORMAT');
  const groups=new Map(available.map(g=>[g.id,g]));
  snapshot.items=snapshot.items.map(g=>{
    const a=groups.get(g.group_id);
    return {...g,public_rate_multiplier:g.rate_multiplier,bindable:!!a,rate_multiplier:rates?.[g.group_id]??a?.rate_multiplier??g.rate_multiplier,peak_rate_enabled:a?.peak_rate_enabled,subscription_type:a?.subscription_type??g.subscription_type};
  });
  return snapshot;
}
function catalogData(all,snapshot){
  const models=[...new Map(snapshot.items.filter(g=>PLATFORMS.includes(g.platform)).flatMap(g=>(g.group_models||[]).map(m=>[g.platform+':'+m.model,{platform:g.platform,model:m.model}]))).values()].sort((a,b)=>a.platform.localeCompare(b.platform)||a.model.localeCompare(b.model));
  return {keys:all,models,at:Date.now()};
}
function errorText(e){return ({AUTH:'网站登录已失效，请打开平台并重新登录或刷新页面',NETWORK:'平台连接失败，将在下轮重试',FORBIDDEN:'平台拒绝请求，请检查登录状态或分组权限',FORMAT:'平台数据格式发生变化，本轮未切换',BUSINESS:'平台未确认操作成功，请检查后重试',HTTP:'平台服务异常，本轮停止',ACCOUNT:'当前账号与监控配置不一致',TAB_TIMEOUT:'读取已打开的 AIHub 页面超时，请刷新该页面后重试'})[e.message]||'检查未完成，本轮停止';}
async function check(){
  const app=await load();
  if(!app.configs.some(c=>!c.paused) && !Object.values(app.states).some(s=>s.pending))return;
  try{
    await identity(app);
    const all=await keys();
    // Readback pending writes before fetching prices or attempting another write.
    const waiting=new Set();
    for(const c of app.configs){
      const s=app.states[c.keyId]||{}, k=all.find(k=>k.id===c.keyId);
      if(s.pending && k){
        const r=reconcilePending(s,k.groupId);app.states[c.keyId]=r.state;
        if(r.pause)c.paused=true;
        waiting.add(c.keyId);log(app,`Key ${c.keyId}：${r.state.status}`);
        if(r.pause)await notice(app,`pending-${c.keyId}`,`Key ${c.keyId} 切换结果需要处理，已暂停。`);
        else delete app.notices[`pending-${c.keyId}`];
      }
    }
    await save(app);
    const snapshot=await authorizedSnapshot();
    app.catalog=catalogData(all,snapshot);
    if(snapshot.stale!==false || !(Date.now()-Date.parse(snapshot.generated_at)<=INTERVAL) || Date.parse(snapshot.generated_at)>Date.now()+60000)throw new Error('FORMAT');
    for(const c of app.configs){
      if(c.paused || waiting.has(c.keyId))continue;
      if(urgentPause.has(c.keyId)||disconnectRequested){c.paused=true;continue;}
      const k=all.find(k=>k.id===c.keyId);
      if(!k || k.status!=='active') {c.paused=true;await notice(app,`missing-${c.keyId}`,`Key ${c.keyId} 不存在或不可用，已暂停`);continue;}
      const previous=app.states[c.keyId]||{};
      const scoped={...snapshot,items:snapshot.items.map(g=>({...g,key_max_rate_multiplier:k.maxRate}))};
      const plan=decide({config:c,state:previous,currentGroupId:k.groupId,snapshot:scoped,globalStrategy:app.defaultStrategy,intervalMs:(app.checkMinutes||5)*60000});
      app.states[c.keyId]=plan.state;
      if(plan.pause){c.paused=true;await notice(app,`external-${c.keyId}`,`Key ${c.keyId} 检测到外部改组，已暂停`);}
      if(plan.notice)await notice(app,`${plan.notice}-${c.keyId}`,`Key ${c.keyId} 没有合格分组，保留当前分组`);
      else delete app.notices[`no-candidate-${c.keyId}`];
      if(plan.target!=null){
        // All writes require explicit per-key UI opt-in.
        if(!c.automatic){plan.state.status='预览：建议分组 '+plan.target;continue;}
        const fresh=(await keys()).find(x=>x.id===c.keyId);
        if(!fresh || fresh.groupId!==k.groupId){c.paused=true;plan.state.status='切换前发现外部改组，已暂停';await notice(app,`external-${c.keyId}`,`Key ${c.keyId} 检测到外部改组，已暂停`);continue;}
        // Health expires quickly (about 90 seconds in this HAR); re-evaluate before mutation.
        if(fresh.maxRate>0 && scoped.items.find(g=>g.group_id===plan.target)?.rate_multiplier>fresh.maxRate){plan.state.status='倍率上限发生变化，等待下轮';continue;}
        const again=decide({config:c,state:previous,currentGroupId:fresh.groupId,snapshot:scoped,globalStrategy:app.defaultStrategy,intervalMs:(app.checkMinutes||5)*60000});
        if(again.target!==plan.target){plan.state.status='切换前条件已变化，等下轮检查';continue;}
        plan.state.pending={from:k.groupId,to:plan.target,at:Date.now()};
        await save(app);
        if(urgentPause.has(c.keyId)||disconnectRequested){c.paused=true;plan.state.pending=null;plan.state.status='操作已暂停';await save(app);continue;}
        try{
          await api(`/api/v1/keys/${c.keyId}/group`,{method:'PUT',body:{group_id:plan.target}});
          const actual=(await keys()).find(x=>x.id===c.keyId);
          if(!actual)throw new Error('FORMAT');
          const r=reconcilePending(plan.state,actual.groupId);app.states[c.keyId]=r.state;if(r.pause)c.paused=true;
          log(app,`Key ${c.keyId}：${r.state.status}（${k.groupId} → ${plan.target}）`);
          if(r.pause)await notice(app,`pending-${c.keyId}`,`Key ${c.keyId} 切换未确认，已暂停`);
          else delete app.notices[`pending-${c.keyId}`];
        }catch(e){
          // Keep journal even on a definite HTTP error; read back before deciding to retry.
          plan.state.status='切换结果待核实';await notice(app,`pending-${c.keyId}`,`Key ${c.keyId} 切换结果待核实，后续先读回检查`);
        }
      }
    }
    for(const id of Object.keys(app.notices))if(id.startsWith('read-'))delete app.notices[id];
    app.lastCheck=Date.now();app.lastError=null;
    await save(app);
  }catch(e){
    app.lastError=errorText(e);
    // An interrupted/failed poll breaks consecutiveness.
    for(const s of Object.values(app.states)){s.candidate=null;s.count=0;}
    await notice(app,`read-${e.message}`,app.lastError);await save(app);
  }
}
async function handle(message){
  const app=await load();
  if(message.type==='state')return {app,connected:!!(await chrome.storage.session.get('auth')).auth};
  if(message.type==='check'){await check();return {ok:true};}
  if(message.type==='manualSwitch'){
    if(!Number.isSafeInteger(message.keyId)||!Number.isSafeInteger(message.target)||(message.expectedGroupId!==null&&!Number.isSafeInteger(message.expectedGroupId)))throw new Error('FORMAT');
    const c=app.configs.find(x=>x.keyId===message.keyId);if(!c)throw new Error('FORMAT');
    if(app.states[c.keyId]?.pending)throw new Error('请先核实上次切换结果');
    c.paused=true;
    app.states[c.keyId]={...app.states[c.keyId],candidate:null,count:0,status:'手动操作中，自动选择已暂停'};
    await save(app);
    await identity(app);
    const current=(await keys()).find(x=>x.id===c.keyId);
    if(!current||current.status!=='active')throw new Error('Key 不可用');
    if(current.groupId!==message.expectedGroupId)throw new Error('当前分组已变化，请重新检查后再切换');
    const snapshot=await authorizedSnapshot();
    snapshot.items=snapshot.items.map(g=>({...g,key_max_rate_multiplier:current.maxRate}));
    const plan=decide({config:{...c,paused:false},currentGroupId:current.groupId,snapshot,globalStrategy:app.defaultStrategy});
    if(!plan.state.choices?.some(x=>x.id===message.target))throw new Error('目标已不符合筛选条件，请重新检查');
    if(current.groupId===message.target)return {ok:true};
    const latest=(await keys()).find(x=>x.id===c.keyId);
    if(!latest||latest.groupId!==current.groupId)throw new Error('当前分组已变化，请重新检查');
    const confirmed=decide({config:{...c,paused:false},currentGroupId:latest.groupId,snapshot:{...snapshot,items:snapshot.items.map(g=>({...g,key_max_rate_multiplier:latest.maxRate}))},globalStrategy:app.defaultStrategy});
    if(!confirmed.state.choices?.some(x=>x.id===message.target))throw new Error('切换前条件已变化，请重新检查');
    if(disconnectRequested)throw new Error('已断开连接，手动切换已取消');
    c.paused=true;
    const state={...confirmed.state,candidate:null,count:0,pending:{from:current.groupId,to:message.target,manual:true,at:Date.now()},status:'手动切换结果待核实'};
    app.states[c.keyId]=state;await save(app);
    try{
      await api(`/api/v1/keys/${c.keyId}/group`,{method:'PUT',body:{group_id:message.target}});
      const actual=(await keys()).find(x=>x.id===c.keyId);if(!actual)throw new Error('FORMAT');
      const r=reconcilePending(state,actual.groupId);app.states[c.keyId]=r.state;
      r.state.status=r.pause?r.state.status:'手动切换成功，自动选择已暂停';
      log(app,`Key ${c.keyId}：${r.state.status}（${current.groupId} → ${message.target}）`);
    }catch{await notice(app,`pending-${c.keyId}`,`Key ${c.keyId} 手动切换结果待核实，请点击立即检查`);}
    await save(app);return {ok:true};
  }
  if(message.type==='catalog'){
    await connectOpenTab();
    try{await identity(app);}catch(e){if(e.message!=='AUTH')throw e;await connectOpenTab();await identity(app);}
    const [all,snapshot]=await Promise.all([keys(),providers()]);app.catalog=catalogData(all,snapshot);await save(app);
    return app.catalog;
  }
  if(message.type==='configure'){
    if(app.accountMismatch)throw new Error('ACCOUNT');
    const strategy=message.strategy==null?null:validateStrategy(message.strategy);
    if(!Number.isSafeInteger(message.keyId)||!PLATFORMS.includes(message.platform)||typeof message.model!=='string'||message.model.length>200)throw new Error('FORMAT');
    await identity(app);
    const k=(await keys()).find(k=>k.id===message.keyId);if(!k)throw new Error('FORMAT');
    const snapshot=await providers();
    if(!snapshot.items.some(g=>g.platform===message.platform && g.group_models?.some(m=>m.model===message.model)))throw new Error('FORMAT');
    const old=app.configs.find(c=>c.keyId===message.keyId);
    if(app.states[message.keyId]?.pending)throw new Error('请先检查并核实上次切换结果');
    const config={keyId:message.keyId,model:message.model,platform:message.platform,strategy,automatic:message.automatic===true,paused:false};
    urgentPause.delete(message.keyId);disconnectRequested=false;
    if(old)Object.assign(old,config);else app.configs.push(config);
    app.states[message.keyId]={expectedGroupId:k.groupId,status:'已保存，等待检查',count:0,lastSwitchAt:app.states[message.keyId]?.lastSwitchAt};
    for(const id of Object.keys(app.notices))if(id.endsWith('-'+message.keyId))delete app.notices[id];
    log(app,`Key ${message.keyId} 已配置为 ${message.model}（${config.automatic?'自动切换':'仅预览'}）`);await save(app);return {ok:true};
  }
  if(message.type==='strategy'){
    app.defaultStrategy=validateStrategy(message.strategy);
    const intervalChanged=message.checkMinutes!=null && message.checkMinutes!==(app.checkMinutes||5);
    if(message.checkMinutes!=null){if(!Number.isInteger(message.checkMinutes)||message.checkMinutes<1||message.checkMinutes>60)throw new Error('检查间隔须为1–60分钟的整数');app.checkMinutes=message.checkMinutes;}
    for(const c of app.configs){
      if(c.strategy&&!intervalChanged)continue;
      const s=app.states[c.keyId];
      if(s){s.candidate=null;s.count=0;delete s.observedAt;delete s.choices;delete s.excluded;s.status=s.pending?'等待核实上次切换':'全局策略已更新，等待重新检查';}
    }
    log(app,'已更新全局排序策略及检查间隔');await save(app);await ensureAlarm();return {ok:true};
  }
  if(message.type==='toggleKey'){
    const c=app.configs.find(x=>x.keyId===message.keyId);if(!c)throw new Error('FORMAT');
    if(app.states[c.keyId]?.pending)throw new Error('请先核实上次切换结果');
    if(message.field==='automatic' && typeof message.enabled==='boolean')c.automatic=message.enabled;
    else if(message.field==='override' && typeof message.enabled==='boolean')c.strategy=message.enabled?validateStrategy(app.defaultStrategy):null;
    else throw new Error('FORMAT');
    const state=app.states[c.keyId]||{};state.candidate=null;state.count=0;delete state.observedAt;delete state.choices;state.status=c.paused?'已暂停，编辑后恢复':'设置已更新，等待检查';app.states[c.keyId]=state;
    log(app,`Key ${c.keyId} 设置已更新`);await save(app);return {ok:true};
  }
  if(message.type==='pause'||message.type==='remove'){
    const c=app.configs.find(c=>c.keyId===message.keyId);if(!c)throw new Error('FORMAT');
    if(message.type==='pause'){c.paused=true;app.states[c.keyId]={...app.states[c.keyId],candidate:null,count:0,status:'已手动暂停'};}
    else{app.configs=app.configs.filter(x=>x!==c);delete app.states[c.keyId];}
    await save(app);return {ok:true};
  }
  if(message.type==='disconnect'){
    await chrome.storage.session.remove('auth');for(const c of app.configs)c.paused=true;
    log(app,'已断开连接并暂停全部监控');await save(app);return {ok:true};
  }
  if(message.type==='resetAccount' && !app.configs.length){app.account=null;app.accountMismatch=false;await save(app);return {ok:true};}
  throw new Error('FORMAT');
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id || sender.url!==chrome.runtime.getURL('options.html'))return;
  if(message.type==='pause'||message.type==='remove'||message.type==='manualSwitch')urgentPause.add(message.keyId);
  if(message.type==='disconnect')disconnectRequested=true;
  serial(()=>handle(message)).then(result=>respond({result}),e=>respond({error:['AUTH','ACCOUNT','FORMAT','NETWORK','FORBIDDEN','HTTP','BUSINESS','TAB_TIMEOUT'].includes(e.message)?errorText(e):e.message}));return true;
});
// Observe only first-party platform requests; never read storage belonging to the website.
chrome.webRequest.onBeforeSendHeaders.addListener(details=>{
  if(details.tabId<0 || details.initiator!==ORIGIN)return;
  const header=details.requestHeaders?.find(h=>h.name.toLowerCase()==='authorization');
  if(header?.value?.startsWith('Bearer ') && header.value.length<16000){
    const auth=header.value;serial(()=>chrome.storage.session.set({auth}));
  }
},{urls:[ORIGIN+'/api/v1/auth/me',ORIGIN+'/api/v1/keys*']},['requestHeaders','extraHeaders']);
chrome.webRequest.onBeforeRequest.addListener(details=>{
  if(details.tabId<0 || details.method!=='PUT')return;
  const match=new URL(details.url).pathname.match(/^\/api\/v1\/keys\/(\d+)\/group$/);if(!match)return;
  urgentPause.add(Number(match[1]));
  serial(async()=>{const app=await load(),id=Number(match[1]),c=app.configs.find(c=>c.keyId===id);if(!c)return;c.paused=true;app.states[id]={...app.states[id],candidate:null,count:0,status:'检测到页面改组操作，已暂停'};await notice(app,`external-${id}`,`Key ${id} 检测到页面改组操作，已暂停`);await save(app);});
},{urls:[ORIGIN+'/api/v1/keys/*/group']});
async function ensureAlarm(){const app=await load(),minutes=app.checkMinutes||5,alarm=await chrome.alarms.get(ALARM);if(!alarm||alarm.periodInMinutes!==minutes)await chrome.alarms.create(ALARM,{periodInMinutes:minutes});}
chrome.runtime.onInstalled.addListener(()=>{ensureAlarm();chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});});
chrome.runtime.onStartup.addListener(()=>{ensureAlarm();serial(check);});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===ALARM)serial(check);});
chrome.action.onClicked.addListener(()=>chrome.runtime.openOptionsPage());
ensureAlarm();
