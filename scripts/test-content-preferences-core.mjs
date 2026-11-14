import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL(`../test-results/content-preferences-core/${Date.now()}/`, import.meta.url);
await mkdir(output, {recursive:true});
const report={environment:'Real Settings + AppProvider + external preference store, Chromium with mocked IPC; no upstream/native WebView', passed:[],failed:[],errors:[]};
let server,browser;
try {
 server=await createServer({root,server:{host:'127.0.0.1',port:0,strictPort:false}});await server.listen();const origin=server.resolvedUrls.local[0];
 browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 const context=await browser.newContext({viewport:{width:375,height:812},reducedMotion:'reduce',isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'});
 await context.addInitScript(()=>{
  localStorage.setItem('hghubx_app_v1',JSON.stringify({favs:[7],history:[{id:7,ep:1,t:12,dur:100,at:1}]}));
  localStorage.setItem('hghubx_auto_line','off');localStorage.setItem('hghubx_theme','light');
  window.__TAURI_INTERNALS__={async invoke(cmd){if(cmd==='app_boot')return {user:null,strict_security:true};if(cmd==='line_state')return {base:'https://fixture.invalid',fixed:[]};if(cmd==='proxy_state')return {mode:'system',url:'',effective:null};return null;}};
 });
 const page=await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',e=>report.errors.push(e.message));
 await page.route('**/*',r=>new URL(r.request().url()).origin===new URL(origin).origin?r.continue():r.abort());
 const open=()=>page.goto(`${origin}tests/content-preferences-core.html`);
 const ready=()=>page.waitForFunction(()=>!!window.preferenceFixture);
 const expandPreferences=async()=>{const trigger=page.getByRole('button',{name:'内容偏好设置',exact:true});if(await trigger.getAttribute('aria-expanded')==='false')await trigger.click();await trigger.scrollIntoViewIfNeeded();};
 const test=async(name,fn)=>{try{await fn();report.passed.push(name);}catch(e){report.failed.push({name,error:String(e.stack||e)});}};
 await open();await ready();
 await test('canonical-content-preferences-storage-key',async()=>{assert.equal(await page.evaluate(()=>window.preferenceFixture.key),'hghubx_content_preferences_v1');});
 await test('settings-section-entry',async()=>{await expandPreferences();await page.getByRole('heading',{name:'内容偏好',exact:true}).waitFor();});
 await test('empty-exact-normalized-rules',async()=>{
  const result=await page.evaluate(()=>{const f=window.preferenceFixture;const p={blockedTags:[' Horror ','科 幻'],paused:false,hideUntagged:false};return [f.normalizeTag('  科\t  幻 '),f.reason(['horror'],p),f.reason(['horror comedy'],p),f.reason([],p),f.reason(undefined,p),f.reason(['科  幻'],p),f.reason(['Horror'],{...p,paused:true}),f.reason([],{...p,hideUntagged:true}),f.reason([' '],{...p,hideUntagged:true})];});
  assert.deepEqual(result,['科 幻','屏蔽标签： Horror ',null,null,null,'屏蔽标签：科 幻',null,'未提供标签','未提供标签']);
 });
 await test('external-store-synchronizes-and-preserves-unrelated-data',async()=>{
  await page.evaluate(()=>window.preferenceFixture.blockTags(['  Horror ','horror','',null,123,' 科\t幻 ']));
  await page.waitForFunction(()=>JSON.parse(document.querySelector('[data-probe=first]').textContent).blockedTags.length===2);
  assert.equal(await page.locator('[data-probe=first]').textContent(),await page.locator('[data-probe=second]').textContent());
  assert.deepEqual(await page.evaluate(()=>window.preferenceFixture.preferences.blockedTags),['Horror','科 幻']);
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('hghubx_app_v1')).favs),[7]);
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('hghubx_app_v1')).history),[{id:7,ep:1,t:12,dur:100,at:1}]);
  assert(await page.evaluate(()=>window.preferenceFixture.isTagBlocked('hORROR')));
 });
 await test('preferences-persist-reload-and-pause-retains-tags',async()=>{
  await page.evaluate(()=>{window.preferenceFixture.setPaused(true);window.preferenceFixture.setHideUntagged(true);});
  await page.reload();await ready();
  assert.deepEqual(await page.evaluate(()=>window.preferenceFixture.preferences),{blockedTags:['Horror','科 幻'],paused:true,hideUntagged:true});
  assert.equal(await page.evaluate(()=>window.preferenceFixture.blockReason(['Horror'])),null);
  await page.evaluate(()=>window.preferenceFixture.setPaused(false));
  await page.waitForFunction(()=>window.preferenceFixture.blockReason(['Horror'])!==null);
 });
 await test('cross-window-storage-change',async()=>{
  const second=await context.newPage();await second.goto(origin);
  const key=await page.evaluate(()=>window.preferenceFixture.key);
  await second.evaluate(key=>localStorage.setItem(key,JSON.stringify({blockedTags:['校园'],paused:false,hideUntagged:false})),key);
  await page.waitForFunction(()=>window.preferenceFixture.preferences.blockedTags.join(',')==='校园');
  assert.equal(await page.locator('[data-probe=first]').textContent(),await page.locator('[data-probe=second]').textContent());await second.close();
 });
 await test('typed-storage-sanitization-and-limits',async()=>{
  await page.evaluate(()=>{const f=window.preferenceFixture;localStorage.setItem(f.key,JSON.stringify({blockedTags:['Good','good',null,42,'x'.repeat(65),''],paused:'yes',hideUntagged:1}));});
  await page.reload();await ready();assert.deepEqual(await page.evaluate(()=>window.preferenceFixture.preferences),{blockedTags:['Good'],paused:false,hideUntagged:false});
  await page.evaluate(()=>window.preferenceFixture.blockTags(Array.from({length:300},(_,i)=>`标签${i}`)));
  await page.waitForFunction(()=>window.preferenceFixture.preferences.blockedTags.length===200);
  await page.evaluate(()=>window.preferenceFixture.clearBlockedTags());
 });
 await test('settings-add-duplicate-search-and-confirm-removal',async()=>{
  await expandPreferences();
  const input=page.getByRole('textbox',{name:'添加屏蔽标签',exact:true});await input.fill('  Suspense  ');await page.getByRole('button',{name:'屏蔽标签',exact:true}).click();
  await page.getByRole('button',{name:'取消屏蔽 Suspense',exact:true}).waitFor();await input.fill('suspense');await page.getByRole('button',{name:'屏蔽标签',exact:true}).click();await page.getByRole('alert').filter({hasText:'已在屏蔽列表'}).waitFor();
  await input.fill('校园');await page.getByRole('button',{name:'屏蔽标签',exact:true}).click();
  const search=page.getByRole('textbox',{name:'搜索已屏蔽标签',exact:true});await search.fill('sUSP');assert.equal(await page.getByRole('button',{name:'取消屏蔽 校园',exact:true}).count(),0);
  await page.getByRole('button',{name:'取消屏蔽 Suspense',exact:true}).click();const modal=page.getByRole('dialog',{name:'取消屏蔽标签',exact:true});await modal.waitFor();assert(await page.evaluate(()=>window.preferenceFixture.isTagBlocked('Suspense')));
  await modal.getByRole('button',{name:'保留',exact:true}).click();await modal.waitFor({state:'hidden'});assert(await page.evaluate(()=>window.preferenceFixture.isTagBlocked('Suspense')));
  await page.getByRole('button',{name:'取消屏蔽 Suspense',exact:true}).click();await modal.getByRole('button',{name:'确认取消屏蔽',exact:true}).click();await modal.waitFor({state:'hidden'});assert(!(await page.evaluate(()=>window.preferenceFixture.isTagBlocked('Suspense'))));await search.fill('');
 });
 await test('settings-switches-and-clear-confirmation',async()=>{
  await page.getByRole('switch',{name:'隐藏无标签视频',exact:true}).click();assert.equal(await page.evaluate(()=>window.preferenceFixture.preferences.hideUntagged),true);
  await page.getByRole('switch',{name:'暂停全部屏蔽',exact:true}).click();assert.equal(await page.evaluate(()=>window.preferenceFixture.preferences.paused),true);
  await page.getByRole('button',{name:'清空标签',exact:true}).click();const modal=page.getByRole('dialog',{name:'清空屏蔽标签',exact:true});await modal.waitFor();await modal.getByRole('button',{name:'确认清空',exact:true}).click();await modal.waitFor({state:'hidden'});assert.deepEqual(await page.evaluate(()=>window.preferenceFixture.preferences),{blockedTags:[],paused:true,hideUntagged:true});
 });
 await test('storage-failure-visible-and-retry',async()=>{
  await page.evaluate(()=>{window.originalStorageSet=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key===window.preferenceFixture.key)throw new DOMException('Quota exceeded','QuotaExceededError');return window.originalStorageSet.call(this,key,value);};window.preferenceFixture.blockTags(['喜剧']);});
  await page.getByRole('alert').filter({hasText:'本机保存失败'}).waitFor();assert(await page.evaluate(()=>window.preferenceFixture.isTagBlocked('喜剧')));
  await page.evaluate(()=>Storage.prototype.setItem=window.originalStorageSet);await page.getByRole('button',{name:'重试保存',exact:true}).click();await page.waitForFunction(()=>window.preferenceFixture.storageError===null);assert(await page.evaluate(()=>JSON.parse(localStorage.getItem(window.preferenceFixture.key)).blockedTags.includes('喜剧')));
 });
 await test('corrupt-storage-defaults',async()=>{await page.evaluate(()=>localStorage.setItem(window.preferenceFixture.key,'{invalid'));await page.reload();await ready();assert.deepEqual(await page.evaluate(()=>window.preferenceFixture.preferences),{blockedTags:[],paused:false,hideUntagged:false});});
 await test('responsive-settings-long-tag',async()=>{
  await page.evaluate(()=>window.preferenceFixture.blockTags(['很长的标签'.repeat(10),'W'.repeat(64)]));
  for(const [width,height] of [[320,694],[375,812],[812,375],[1280,900]]) {await page.setViewportSize({width,height});await expandPreferences();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert(await page.locator('#settings-内容偏好').evaluate(el=>el.getBoundingClientRect().width<=720));await page.screenshot({path:fileURLToPath(new URL(`preferences-${width}.png`,output)),animations:'disabled'});}
 });
 await test('keyboard-submit-and-escape-keeps-tag',async()=>{
  const input=page.getByRole('textbox',{name:'添加屏蔽标签',exact:true});await input.fill('键盘操作');await input.press('Enter');
  const remove=page.getByRole('button',{name:'取消屏蔽 键盘操作',exact:true});await remove.focus();await remove.press('Enter');
  const modal=page.getByRole('dialog',{name:'取消屏蔽标签',exact:true});await modal.waitFor();await page.keyboard.press('Escape');await modal.waitFor({state:'hidden'});
  assert(await page.evaluate(()=>window.preferenceFixture.isTagBlocked('键盘操作')));
 });
 await test('dark-settings-and-large-text-layout',async()=>{
  await page.setViewportSize({width:375,height:812});await page.getByRole('button',{name:'深色',exact:true}).click();
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  await expandPreferences();
  await page.screenshot({path:fileURLToPath(new URL('preferences-dark.png',output)),animations:'disabled'});
  await page.addStyleTag({content:'#settings-内容偏好 :is(h3,p,label,span,button,input,summary) { font-size: 24px !important; }'});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  const section=page.locator('#settings-内容偏好');
  assert(await section.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
  await page.screenshot({path:fileURLToPath(new URL('preferences-large-text.png',output)),animations:'disabled'});
 });
 assert.deepEqual(report.errors,[]);if(report.failed.length)process.exitCode=1;
}catch(e){report.failed.push({name:'runner',error:String(e.stack||e)});process.exitCode=1;}
finally{await browser?.close();await server?.close();await writeFile(new URL('report.json',output),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));console.log(fileURLToPath(output));}
