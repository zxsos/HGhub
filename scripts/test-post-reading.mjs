import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = new URL(`../test-results/post-reading/${Date.now()}/`, import.meta.url); await mkdir(out,{recursive:true});
const report={checks:[],errors:[],environment:'Real PostDetail/PostsPage, simulated IPC and media; not native playback'};
let vite,browser;
try {
 vite=await createServer({root,server:{host:'127.0.0.1',port:5189,strictPort:false}});await vite.listen();const origin=vite.resolvedUrls.local[0];
 browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||undefined});
 for (const width of [375,1280]) {
 const context=await browser.newContext({viewport:{width,height:850},reducedMotion:'reduce',...(width===375?{userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',isMobile:true,hasTouch:true}:{})});
 await context.addInitScript(()=>{
   localStorage.setItem('hghubx_theme','light');
   const f=window.postFixture={fail:true,resolve:null,playResolve:null,calls:[]};
   window.__TAURI_INTERNALS__={async invoke(cmd,args={}){
     f.calls.push({cmd,args});
     if(cmd==='app_boot')return {user:null,strict_security:true};
     if(cmd==='api_post'){
       if(f.fail) throw '模拟详情失败';
       if(args.id===2) await new Promise(r=>f.resolve=r);
       return {id:args.id,title:`帖子 ${args.id}`,cover:'',content:Array(100).fill('可阅读的长篇内容。').join('\n'),tags:[],hot:42};
     }
     if(cmd==='api_post_playback') { await new Promise(r=>f.playResolve=r);return {videos:[{url:'https://fixture.invalid/a.mp4'},{url:'https://fixture.invalid/b.mp4'}]}; }
     if(cmd==='api_post_category') {if(f.fail)throw '模拟列表失败';return {items:[],pagination:{page:1,pages:1,total:0}};}
     return null;
   }};
 });
 const page=await context.newPage();page.setDefaultTimeout(7000);page.on('pageerror',e=>report.errors.push(e.message));
 await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(origin).origin?route.continue():route.abort());
 await page.goto(`${origin}scripts/fixtures/post-reading.html`);
 await page.getByText('加载失败',{exact:true}).waitFor();
 await page.evaluate(()=>window.postFixture.fail=false);
 await page.getByRole('button',{name:'重试',exact:true}).click();
 await page.getByRole('heading',{name:'帖子 1',exact:true}).waitFor();
 await page.getByRole('status',{name:'正在解析视频'}).waitFor();
 report.checks.push(`${width}: detail retry and visible resolving state`);
 await page.evaluate(()=>window.postFixture.playResolve());
 const segments=page.getByRole('group',{name:'视频分段'});await segments.waitFor();
 const layout=await page.evaluate(()=>({media:document.querySelector('[data-post-media]').getBoundingClientRect().bottom,segments:document.querySelector('[aria-label="视频分段"]').getBoundingClientRect().top}));
 assert(layout.segments>=layout.media,'Segments must sit below media, not above mute control');
 await segments.getByRole('button',{name:'第 2 段'}).click();assert.equal(await segments.getByRole('button',{name:'第 2 段'}).getAttribute('aria-pressed'),'true');
 await page.screenshot({path:fileURLToPath(new URL(`${width}-post.png`,out))});
 report.checks.push(`${width}: segment controls are outside video and expose state`);
 await page.evaluate(()=>window.postReading.setId(2));
 await page.getByRole('status',{name:'加载中'}).waitFor();assert.equal(await page.getByRole('heading',{name:'帖子 1',exact:true}).count(),0);
 await page.evaluate(()=>window.postFixture.resolve());await page.getByRole('heading',{name:'帖子 2',exact:true}).waitFor();
 await page.locator('[data-post-scroll]').evaluate(el=>{el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll'));});
 await page.getByRole('progressbar',{name:'阅读进度'}).waitFor();assert.equal(await page.getByRole('progressbar',{name:'阅读进度'}).getAttribute('aria-valuenow'),'100');
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 report.checks.push(`${width}: stale detail cleared, reading progress and no page overflow`);
 await page.goto(`${origin}scripts/fixtures/post-reading.html?list`);await page.getByText('吃瓜内容加载失败',{exact:true}).waitFor();await page.evaluate(()=>window.postFixture.fail=false);await page.getByRole('button',{name:'重试',exact:true}).click();await page.getByText('暂无吃瓜内容',{exact:true}).waitFor();
 report.checks.push(`${width}: list failure and successful empty retry`);
 await context.close();
 }
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(e){report.failure=String(e.stack||e);process.exitCode=1;}
finally{await browser?.close();await vite?.close();await writeFile(new URL('report.json',out),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));console.log(fileURLToPath(out));}
