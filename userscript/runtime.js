// Tampermonkey platform adapter. Included in the generated bundle, not loaded remotely.
const STORE='aihubrouter:app:v1', DISCONNECTED='aihubrouter:disconnected:v1';
const LOCK='aihubrouter:operations:v1';
let disconnected=false;
async function currentAuth(){
  disconnected=await GM.getValue(DISCONNECTED,false);
  if(disconnected)return null;
  const token=localStorage.getItem('auth_token');
  return typeof token==='string'&&token.length>0&&token.length<16000?'Bearer '+token:null;
}
const chrome={
  storage:{
    local:{get:async key=>({[key]:JSON.parse(await GM.getValue(STORE,'null'))}),set:async value=>{await GM.setValue(STORE,JSON.stringify(value.app));}},
    session:{get:async()=>({auth:await currentAuth()}),remove:async()=>{}}
  },
  notifications:{create:async()=>{}},
  runtime:{sendMessage:message=>{
    if(!navigator.locks)return Promise.resolve({error:'当前浏览器不支持跨标签页锁，已禁止运行。请使用新版 Chrome 或 Edge。'});
    return dispatch(message).then(result=>({result}),e=>({error:errorText(e)==='检查未完成，本轮停止'?e.message:errorText(e)}));
  }}
};
async function ensureAlarm(){} // Scheduling is page-based below.
function startScheduler(){
  if(!navigator.locks)return;
  const tick=()=>navigator.locks.request(LOCK,{ifAvailable:true},async lock=>{
    if(!lock)return;
    const app=await load();
    if(disconnected=await GM.getValue(DISCONNECTED,false))return;
    const minutes=app.checkMinutes||5;
    if(Date.now()-(app.lastAttempt||0)<minutes*60000)return;
    // Persist the attempt before fetching: failures also respect the polling interval.
    app.lastAttempt=Date.now();await save(app);await check();
  }).catch(()=>{});
  tick();setInterval(tick,15000);
}
function mountPanel(html,css,initialize){
  const host=document.createElement('div');
  host.id='aihubrouter-userscript';
  host.style.cssText='all:initial;font:14px/1.5 Segoe UI,Microsoft YaHei,sans-serif;color:var(--ink);color-scheme:light dark;position:fixed;inset:0;pointer-events:none;z-index:2147483646';
  const root=host.attachShadow({mode:'open'});
  const style=document.createElement('style');
  style.textContent=css+`\n:host{background:transparent} .launch{position:fixed;right:18px;bottom:22px;pointer-events:auto;box-shadow:0 4px 20px #0003}.panel{position:fixed;inset:16px 16px 16px auto;width:min(1100px,calc(100vw - 32px));overflow:auto;overscroll-behavior:contain;background:var(--bg);border:1px solid var(--line);border-radius:16px;box-shadow:0 10px 60px #0004;pointer-events:auto}.tools{position:sticky;top:0;z-index:4;display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 16px;background:var(--panel);border-bottom:1px solid var(--line)}.tools span{font-size:12px;color:var(--muted)}@media(max-width:600px){.panel{inset:0;width:100%;border-radius:0}main{padding:0 14px 20px}}`;
  const launch=document.createElement('button');launch.className='launch';launch.textContent='↗ AIHubRouter';launch.setAttribute('aria-expanded','false');
  const panel=document.createElement('div');panel.className='panel';panel.hidden=true;panel.setAttribute('role','region');panel.setAttribute('aria-label','AIHubRouter 渠道优选');
  panel.innerHTML=html;
  const tools=document.createElement('div');tools.className='tools';
  const note=document.createElement('span');note.textContent='油猴版 · 保留网站标签页 · 多标签串行检查';
  const close=document.createElement('button');close.textContent='收起';close.className='quiet';
  tools.append(note,close);panel.prepend(tools);root.append(style,launch,panel);document.documentElement.append(host);
  const open=()=>{panel.hidden=false;launch.hidden=true;launch.setAttribute('aria-expanded','true');close.focus();};
  close.onclick=()=>{panel.hidden=true;launch.hidden=false;launch.setAttribute('aria-expanded','false');launch.focus();};launch.onclick=open;
  panel.addEventListener('keydown',event=>{if(event.key==='Escape'&&!root.querySelector('dialog[open]'))close.click();});
  GM_registerMenuCommand('打开 AIHubRouter',open);
  const facade={getElementById:id=>root.getElementById(id),querySelector:s=>panel.querySelector(s),querySelectorAll:s=>panel.querySelectorAll(s),createElement:tag=>document.createElement(tag),createTextNode:text=>document.createTextNode(text),body:panel,get activeElement(){return root.activeElement;}};
  initialize(facade);
}
