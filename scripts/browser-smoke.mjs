import {chromium} from 'playwright-core';
import {resolve} from 'node:path';
import {mkdir,mkdtemp} from 'node:fs/promises';
import assert from 'node:assert/strict';
await mkdir('work',{recursive:true});
const profile=await mkdtemp(resolve('work/browser-smoke-'));
await mkdir('outputs',{recursive:true});
await mkdir('release-prep',{recursive:true});
const extension=resolve('extension');
console.log('Starting isolated Edge extension smoke test');
const context=await chromium.launchPersistentContext(profile,{
  executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  timeout:15000,headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],
  viewport:{width:1200,height:1000}
});
try{
  let [worker]=context.serviceWorkers();
  if(!worker)worker=await context.waitForEvent('serviceworker',{timeout:15000});
  const id=new URL(worker.url()).host;
  const popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);await popup.getByRole('button',{name:'在侧栏打开'}).waitFor();assert.equal(await popup.locator('iframe').count(),1);await popup.close();
  const errors=[];const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`chrome-extension://${id}/options.html`);
  await page.getByText('还没有监控。先连接平台，再绑定 key 和模型。').waitFor();
  assert.equal(await page.title(),'AIHubRouter');
  assert.equal(await page.locator('#ratio,#read,#write,#basis,#verified').count(),0);
  await page.getByText('2 · 全局默认策略',{exact:true}).waitFor();
  assert.equal(await page.locator('#globalMode').inputValue(),'price');
  await page.locator('#globalMode').selectOption('weighted');
  assert.equal(await page.locator('#globalWeights').isVisible(),true);
  await page.locator('#globalPrice').fill('60');await page.locator('#globalLatency').fill('30');await page.locator('#globalSuccess').fill('10');
  await page.locator('#globalAdvanced summary').click();
  assert.equal(await page.locator('#globalDetection').isChecked(),true);
  await page.locator('#globalMinSuccess').fill('90');
  await page.locator('#globalMinSamples').fill('10');
  await page.locator('#globalConfirmRounds').fill('3');
  await page.getByRole('button',{name:'保存全局策略',exact:true}).click();
  await page.getByText('已完成',{exact:true}).waitFor();
  assert.equal((await worker.evaluate(async()=>(await chrome.storage.local.get('app')).app)).defaultStrategy.weights.price,60);
  await page.getByRole('button',{name:'立即检查',exact:true}).click();
  await page.getByText('已完成',{exact:true}).waitFor();
  await page.screenshot({path:'outputs/settings-preview.png',fullPage:true});
  // Synthetic test data and requests are injected only into this isolated browser profile.
  await worker.evaluate(async()=>{
    await chrome.storage.session.set({auth:'Bearer TEST_ONLY_FAKE_SESSION'});
    let current=12;
    globalThis.testWrites=[];
    globalThis.testAllHealthy=false;
    globalThis.fetch=async(url,options)=>{
      const path=new URL(url).pathname, expires=new Date(Date.now()+90000).toISOString();
      const price={input_per_million:2,cache_input_per_million:.1,cache_write_per_million:2.5,output_per_million:10};
      let data;
      if(path==='/api/v1/auth/me')data={id:999};
      else if(path==='/api/v1/keys')data={pages:1,items:[{id:101,name:'测试用 key',status:'active',group_id:current,max_rate_multiplier:0,key:'MUST_NOT_LEAVE_TEST'}]};
      else if(path==='/api/v1/groups/available')data=[12,24].map(id=>({id,rate_multiplier:1,peak_rate_enabled:false,subscription_type:'standard'}));
      else if(path==='/api/v1/groups/rates')data={24:.1};
      else if(path==='/api/v2/public/providers')data={stale:false,generated_at:new Date().toISOString(),items:[12,24].map(id=>({group_id:id,code:'示例-'+id,platform:'openai',rate_multiplier:1,available:id===24||globalThis.testAllHealthy,probe_state:'enabled',probe_expires_at:expires,long_context_pricing_enabled:false,subscription_type:'standard',model_detection:{model:'gpt-example',status:'passed',applicable:true,execution_complete:true},group_models:[{model:'gpt-example',price}],summary_models:{'gpt-example':{effective_input_price_per_million:id===12?1:.1,effective_multiplier:.05,effective_multiplier_ready:true,sample_count:100,user_latency_ms:id===12?1000:2000,success_rate:id===12?.95:.99}},model_cards:[{model:'gpt-example',health:'healthy',probe_state:'enabled',health_expires_at:expires}]}))};
      else if(path==='/api/v1/keys/101/group'){globalThis.testWrites.push(JSON.parse(options.body));current=JSON.parse(options.body).group_id;data={group_id:current};}
      else throw new Error('Unexpected test request');
      return {ok:true,status:200,json:async()=>({code:0,data})};
    };
  });
  await page.getByRole('button',{name:'读取 key 与模型',exact:true}).click();
  await page.locator('#keyId option[value="101"]').waitFor({state:'attached'});
  await page.locator('#keyId').selectOption('101');
  await page.locator('#model').selectOption({label:'OpenAI / gpt-example'});
  await page.getByRole('button',{name:'保存 key 配置',exact:true}).click();
  try { await page.getByRole('heading',{name:'gpt-example · Key 101',exact:true}).waitFor({timeout:5000}); } catch(e) { console.log('UI status:', await page.locator('#message').innerText()); console.log('Page errors:', errors); throw e; }
  await page.getByLabel('使用独立策略').check();
  await page.getByText('当前分组 12 · 独立策略', {exact:false}).waitFor();
  await page.getByRole('button',{name:'立即检查',exact:true}).click();
  await page.getByText('仅预览 · 预览：建议分组 24',{exact:true}).waitFor();
  assert.equal(await page.locator('.monitor details').first().evaluate(e=>e.open),false);
  await page.locator('.monitor details summary').first().click();
  assert.equal(await page.locator('table thead th').count(),9);
  await page.getByRole('button',{name:'用户评分',exact:true}).click();
  await page.setViewportSize({width:420,height:700});
  assert.equal(await page.locator('.monitor thead').isVisible(),false);
  assert.equal(await page.locator('.compact-sort select').isVisible(),true);
  await page.locator('.compact-sort select').selectOption('cost:1');
  await page.setViewportSize({width:1200,height:1000});
  assert.deepEqual(await worker.evaluate(()=>globalThis.testWrites),[]);
  await page.getByLabel('使用独立策略').uncheck();
  await page.getByLabel('自动改组').check();
  await page.getByText('当前分组 12 · 继承全局', {exact:false}).waitFor();
  await page.getByRole('button',{name:'立即检查',exact:true}).click();
  await page.getByText('自动切换 · 已确认切换成功',{exact:true}).waitFor();
  assert.deepEqual(await worker.evaluate(()=>globalThis.testWrites),[{group_id:24}]);
  await worker.evaluate(()=>{globalThis.testAllHealthy=true;});
  await page.getByRole('button',{name:'立即检查',exact:true}).click();
  await page.getByRole('button',{name:'切换到 示例-12',exact:true}).waitFor();
  await page.screenshot({path:'outputs/monitor-preview.png',fullPage:true});
  await page.setViewportSize({width:1280,height:800});
  await page.locator('.monitor').first().scrollIntoViewIfNeeded();
  await page.screenshot({path:'release-prep/store-screenshot.png'});
  await page.getByRole('button',{name:'切换到 示例-12',exact:true}).click();
  await page.getByRole('button',{name:'取消',exact:true}).click();
  assert.deepEqual(await worker.evaluate(()=>globalThis.testWrites),[{group_id:24}]);
  await page.getByRole('button',{name:'切换到 示例-12',exact:true}).click();
  await page.getByRole('button',{name:'确认切换',exact:true}).click();
  await page.getByText('已暂停 · 手动切换成功，自动选择已暂停',{exact:true}).waitFor();
  assert.deepEqual(await worker.evaluate(()=>globalThis.testWrites),[{group_id:24},{group_id:12}]);
  await page.getByRole('button',{name:'移除监控',exact:true}).click();
  await page.getByText('还没有监控。先连接平台，再绑定 key 和模型。').waitFor();
  assert.deepEqual(errors,[]);
  console.log('Edge loaded; advanced filters, global/key strategies, candidate columns/sort, manual cancel/confirm/revalidation/pause and simulated auto-switch verified; no page errors.');
}finally{await context.close();}
