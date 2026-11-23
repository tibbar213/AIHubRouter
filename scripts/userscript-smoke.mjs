import {chromium} from 'playwright-core';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
const source=await readFile('userscript/AIHubRouter.user.js','utf8');
const profile=await mkdtemp(join(tmpdir(),'aihubrouter-userscript-smoke-'));
const browser=await chromium.launchPersistentContext(profile,{executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true,viewport:{width:1280,height:920}});
let current=1,user=999,writes=0,lost=false,fail=false,missingPrice=false;
const errors=[];
try{
  await browser.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname;
    assert.equal(url.origin,'https://aihub.top');
    if(!path.startsWith('/api/'))return route.fulfill({contentType:'text/html',body:'<!doctype html><title>模拟 AIHub</title><h1>模拟平台页面</h1>'});
    const expires=new Date(Date.now()+90000).toISOString();
    const group=id=>({group_id:id,code:'模拟渠道-'+id,platform:'openai',rate_multiplier:1,available:id!==1,probe_state:'enabled',probe_expires_at:expires,subscription_type:'standard',model_detection:{model:'实际检测模型',status:'passed'},group_models:[{model:'model-test',price:{input_per_million:id===1?1:.1,output_per_million:id===1?1:.1}}],summary_models:{'model-test':{sample_count:100,user_latency_ms:1000,success_rate:.99}},model_cards:[{model:'model-test',health:'healthy',probe_state:'enabled',health_expires_at:expires}]});
    let data;
    if(path==='/api/v1/auth/me')data={id:user};
    else if(path==='/api/v1/keys')data={pages:1,items:[{id:7,name:'模拟 Key',key:'SECRET_NEVER_STORE',status:'active',group_id:current,max_rate_multiplier:0}]};
    else if(path==='/api/v1/groups/available')data=[1,2].map(id=>({id,rate_multiplier:1,subscription_type:'standard'}));
    else if(path==='/api/v1/groups/rates')data=null;
    else if(path==='/api/v2/public/providers'){
      const ranked={...group(2),badges_expires_at:expires,badges:{
        popularity:{status:'measured',rank:8,groups:214,window:'24h',expires_at:expires},
        warnings:[{id:'high_error',status:'active',triggers:[{value:32.47,threshold:20,operator:'>=',window:'7d',complete:false,available:true}]}]
      }};
      if(missingPrice){
        ranked.group_models[0].price={input_per_million:2,cache_input_per_million:0};
      }
      data={stale:false,generated_at:new Date().toISOString(),items:[group(1),ranked]};
    }
    else if(path==='/api/v1/keys/7/group'){
      assert.equal(request.method(),'PUT');assert.deepEqual(request.postDataJSON(),{group_id:2});
      writes++;if(!fail)current=2;
      if(lost)return route.abort();data={group_id:current};
    }else throw new Error('Unexpected API '+path);
    await route.fulfill({json:{code:0,data}});
  });
  // Test-only synchronous GM storage substitute, shared by pages of this isolated origin.
  await browser.addInitScript(()=>{
    window.GM_getValue=(k,d)=>JSON.parse(localStorage.getItem('TEST_GM:'+k)||JSON.stringify(d));
    window.GM_setValue=(k,v)=>localStorage.setItem('TEST_GM:'+k,JSON.stringify(v));
    window.TEST_STORE_FAIL=false;
    window.GM={getValue:async(k,d)=>GM_getValue(k,d),setValue:async(k,v)=>{
      // Deliberately asynchronous: mutations must wait for the intent journal.
      await new Promise(resolve=>setTimeout(resolve,5));
      if(window.TEST_STORE_FAIL&&k==='aihubrouter:app:v1'&&Object.values(JSON.parse(v).states||{}).some(s=>s.pending))throw new Error('模拟存储失败');
      GM_setValue(k,v);
    }};
    window.GM_registerMenuCommand=()=>{};
    localStorage.setItem('auth_token','FAKE_SESSION');
  });
  const script=source.replace('startScheduler();','globalThis.TEST_ROUTER={send:chrome.runtime.sendMessage};startScheduler();');
  async function page(){const p=await browser.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto('https://aihub.top/providers');await p.evaluate(script);return p;}
  const a=await page(),b=await page();
  const send=(p,m)=>p.evaluate(m=>TEST_ROUTER.send(m),m);
  const state=async()=> (await send(a,{type:'state'})).result.app;
  await a.getByRole('button',{name:'↗ AIHubRouter',exact:true}).click();
  await a.getByRole('button',{name:'配置',exact:true}).click();
  await a.getByRole('button',{name:'读取 key 与模型',exact:true}).click();
  await a.getByText('已完成',{exact:true}).waitFor();
  await a.locator('[data-view=monitors]').click();
  await a.getByLabel('Key 7 的模型',{exact:true}).selectOption('model-test');
  assert.equal(await a.locator('#appVersion').textContent(),source.match(/^\/\/ @version\s+(.+)$/m)[1]);
  await a.getByText('已完成',{exact:true}).waitFor();
  await a.getByRole('button',{name:'权重与规则',exact:true}).click();
  const strategyEditor=a.getByRole('form',{name:'Key 7 的策略'});
  await strategyEditor.locator('details summary').click();
  await strategyEditor.locator('[name=confirmRounds]').fill('2');
  await strategyEditor.getByRole('button',{name:'保存策略',exact:true}).click();
  await strategyEditor.waitFor({state:'detached'});
  assert.equal((await state()).configs[0].strategy.rules.confirmRounds,2);
  await a.getByRole('button',{name:'立即检查',exact:true}).click();
  await a.getByText('合格候选 · 1 个',{exact:true}).click();
  await a.getByRole('cell',{name:'8 / 214 · 24h',exact:true}).waitFor();
  await a.getByText('高错误率 32.47% ≥ 20% · 7d',{exact:true}).waitFor();
  await a.getByText('历史不完整',{exact:true}).waitFor();
  await a.getByLabel('排除平台告警',{exact:true}).check();
  await a.getByRole('button',{name:'立即检查',exact:true}).click();
  await a.getByText('合格候选 · 0 个',{exact:true}).waitFor();
  await a.locator('.exclusions summary').click();
  await a.locator('.exclusions').getByText('平台告警',{exact:true}).waitFor();
  await a.getByLabel('排除平台告警',{exact:true}).uncheck();
  await a.getByRole('button',{name:'暂停',exact:true}).click();
  await a.getByRole('button',{name:'恢复',exact:true}).click();
  await a.getByText('仅预览 · 已恢复，等待检查',{exact:true}).waitFor();
  missingPrice=true;
  await a.getByRole('button',{name:'立即检查',exact:true}).click();
  await a.getByText('合格候选 · 1 个',{exact:true}).waitFor();
  const unavailable=a.locator('.candidate-details tbody');
  await unavailable.getByText('指定模型标价缺失或无效',{exact:true}).waitFor();
  await unavailable.getByText('输入 $2.00',{exact:true}).waitFor();
  await unavailable.getByText('缓存输入 $0.00',{exact:true}).waitFor();
  await unavailable.getByText('8 / 214 · 24h',{exact:true}).waitFor();
  await unavailable.getByText('高错误率 32.47% ≥ 20% · 7d',{exact:true}).waitFor();
  await unavailable.getByRole('button',{name:'切换到 模拟渠道-2',exact:true}).waitFor();
  assert.equal(writes,0);assert.equal((await state()).configs[0].automatic,false);
  await send(a,{type:'toggleKey',keyId:7,field:'automatic',enabled:true});
  await Promise.all([send(a,{type:'check'}),send(b,{type:'check'})]);assert.equal(writes,1);
  assert.equal((await state()).states[7].pending,null);
  missingPrice=false;
  // Journal persistence failure must prevent any network mutation.
  current=1;await send(a,{type:'check'});
  await a.evaluate(()=>window.TEST_STORE_FAIL=true);
  const failedJournal=await send(a,{type:'check'});
  assert.ok(failedJournal.error);assert.equal(writes,1);
  await a.evaluate(()=>window.TEST_STORE_FAIL=false);
  lost=true;await send(a,{type:'check'});assert.equal(writes,2);assert.equal((await state()).states[7].pending.to,2);
  await send(b,{type:'check'});assert.equal(writes,2);assert.equal((await state()).states[7].pending,null);
  current=1;await send(a,{type:'check'});fail=true;await send(a,{type:'check'});await send(b,{type:'check'});
  assert.equal((await state()).configs[0].paused,true);assert.equal(writes,3);
  const configured=await send(a,{type:'configure',keyId:7,model:'model-test',automatic:true});assert.equal(configured.error,undefined);
  user=123;await send(b,{type:'check'});assert.equal((await state()).accountMismatch,true);assert.equal(writes,3);
  const stored=await a.evaluate(()=>localStorage.getItem('TEST_GM:aihubrouter:app:v1'));
  assert.ok(!stored.includes('SECRET_NEVER_STORE'));assert.ok(!stored.includes('FAKE_SESSION'));
  await a.getByRole('button',{name:'配置',exact:true}).click();
  await a.locator('#disconnect').click();
  const disconnectDialog=a.locator('dialog[open]');
  const cancelDisconnect=disconnectDialog.getByRole('button',{name:'取消',exact:true});
  assert.equal(await cancelDisconnect.evaluate(button=>button.matches(':focus')),true);
  await cancelDisconnect.click();
  assert.equal(await a.evaluate(()=>localStorage.getItem('TEST_GM:aihubrouter:disconnected:v1')),'false');
  await a.locator('#disconnect').click();
  await disconnectDialog.getByRole('button',{name:'确认断开',exact:true}).click();
  await a.getByText('已完成',{exact:true}).waitFor();
  await b.reload();await b.evaluate(script);
  assert.equal((await send(b,{type:'state'})).result.connected,false);
  await a.screenshot({path:join(profile,'userscript-desktop.png')});
  await a.setViewportSize({width:390,height:844});
  assert.equal(await a.locator('.panel').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
  await a.screenshot({path:join(profile,'userscript-mobile.png')});
  // The host reset must not override the shadow theme's inherited text color.
  for(const colorScheme of ['dark','light']){
    await a.emulateMedia({colorScheme});
    const theme=await a.locator('#monitorPanel h1').evaluate(e=>{
      const host=e.getRootNode().host;
      return {actual:getComputedStyle(e).color,expected:getComputedStyle(host).getPropertyValue('--ink').trim()};
    });
    const expected=theme.expected.match(/\w\w/g).map(v=>parseInt(v,16));
    assert.equal(theme.actual,`rgb(${expected.join(', ')})`);
  }
  await a.emulateMedia({colorScheme:'dark'});
  await a.waitForTimeout(250); // Let existing button theme transitions finish before the screenshot.
  await a.screenshot({path:join(profile,'userscript-mobile-dark.png')});
  // Two new tabs start their schedulers together with an overdue automatic key.
  await a.close();await b.close();current=1;user=999;lost=false;fail=false;
  const seed=await browser.newPage();await seed.goto('https://aihub.top/providers');
  await seed.evaluate(()=>{
    GM_setValue('aihubrouter:disconnected:v1',false);
    GM_setValue('aihubrouter:app:v1',JSON.stringify({schemaVersion:7,account:999,checkMinutes:5,configs:[{keyId:7,model:'model-test',automatic:true,paused:false}],states:{7:{expectedGroupId:1}},logs:[],notices:{},defaultStrategy:{mode:'price'}}));
  });
  const scheduled=await Promise.all([page(),page()]);
  await scheduled[0].waitForFunction(()=>{
    const app=JSON.parse(GM_getValue('aihubrouter:app:v1','null'));
    return app.states[7].expectedGroupId===2&&app.states[7].pending===null;
  });
  assert.equal(writes,4);
  const attempt=await scheduled[0].evaluate(()=>JSON.parse(GM_getValue('aihubrouter:app:v1','null')).lastAttempt);
  assert.ok(Date.now()-attempt<60000);
  assert.deepEqual(errors,[]);
  console.log('Userscript offline smoke passed: UI binding, preview, two-tab serialization, unknown writes, no replay, account guard, persistent disconnect, narrow layout, credential minimization.');
}finally{
  await browser.close();
  if(dirname(resolve(profile))!==resolve(tmpdir()))throw new Error('Unexpected smoke-test profile path');
  await rm(profile,{recursive:true,force:true,maxRetries:3});
}
