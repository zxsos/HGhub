import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
const root = fileURLToPath(new URL("../", import.meta.url));
const out = `${root}test-results/player-panels/${new Date().toISOString().replace(/[:.]/g, "-")}`;
await mkdir(out, {recursive:true});
const report = { environment:"real Feed/Panels, local neutral deferred API fixture; no upstream/media traffic", cases:[], errors:[] };
const comments = (ep, items = [{ id: ep, user_id:7, nickname:"测试用户", text:`第 ${ep} 集评论`, time:"刚刚",like_count:0,reply_count:0 }], page = 1, pages = 1) => ({ ep, items, pagination: { page, pages, size:20, total:40 } });
let vite, browser;
try {
  vite=await createServer({root,server:{host:"127.0.0.1",port:0,strictPort:false}}); await vite.listen();
  const origin=vite.resolvedUrls.local[0]; browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1000,height:900},reducedMotion:"reduce"}); page.setDefaultTimeout(4000);
  page.on("pageerror",e=>report.errors.push(e.message));
  await page.route("**/*", r=>new URL(r.request().url()).origin===new URL(origin).origin?r.continue():r.abort());
  const open=async(name="comments")=>page.goto(`${origin}tests/player-panels.html?page=${name}`);
  const ready=(cmd,match={})=>page.waitForFunction(({cmd,match})=>window.playerPanelFixture?.calls.some(c=>c.cmd===cmd&&Object.entries(match).every(([k,v])=>c.args[k]===v)),{cmd,match});
  const complete=(cmd,value,error=false,match={})=>page.evaluate(args=>window.playerPanelFixture.complete(...args),[cmd,value,error,match]);
  const check=async(name,fn)=>{try{await fn();report.cases.push({name,passed:true});}catch(e){report.cases.push({name,passed:false,error:String(e)});await page.screenshot({path:`${out}/${name.replaceAll(" ","-")}.png`});}};
  await check("comment initial error retries",async()=>{
    await open();await ready("comments");await complete("comments","HTTP 503",true);
    await page.getByText("评论加载失败",{exact:true}).waitFor();
    assert.equal(await page.getByText("还没有评论",{exact:true}).count(),0);
    await page.getByRole("button",{name:"重试",exact:true}).click();await complete("comments",comments(1));
    await page.getByText("第 1 集评论",{exact:true}).waitFor();
  });
  await check("late comment replies cannot cross episodes",async()=>{
    await open();await ready("comments",{ep:1});await page.evaluate(()=>window.playerPanelFixture.setEp(2));
    await ready("comments",{ep:2});await complete("comments",comments(2),false,{ep:2});await complete("comments",comments(1),false,{ep:1});
    await page.getByText("第 2 集评论",{exact:true}).waitFor();assert.equal(await page.getByText("第 1 集评论",{exact:true}).count(),0);
  });
  await check("comment paging retains content on error",async()=>{
    await open();await ready("comments");await complete("comments",comments(1,undefined,1,2));
    await page.getByRole("button",{name:"查看更多",exact:true}).click();await complete("comments","HTTP 503",true,{page:2});
    assert(await page.getByText("第 1 集评论",{exact:true}).isVisible());
    await page.getByRole("button",{name:"重试",exact:true}).click();await complete("comments",comments(1,[{id:2,user_id:7,nickname:"测试用户",text:"后续评论",time:"刚刚"}],2,2),false,{page:2});
    await page.getByText("后续评论",{exact:true}).waitFor();
  });
  await check("comment submission is guarded and draft survives failure",async()=>{
    await open();await ready("comments");await complete("comments",comments(1));
    const input=page.getByPlaceholder("说点什么…");await input.fill("测试评论");
    await page.locator("form").evaluate(form=>{form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));});
    await ready("send");assert.equal(await page.evaluate(()=>window.playerPanelFixture.calls.filter(c=>c.cmd==="send").length),1);
    await complete("send","提交失败",true);assert.equal(await input.inputValue(),"测试评论");
    await page.getByRole("button",{name:"发送评论",exact:true}).click();await complete("send",{});await complete("comments",comments(1));
    await page.waitForFunction(() => document.querySelector('input[placeholder="说点什么…"]').value === "");
  });
  await check("late submission cannot erase another episode draft",async()=>{
    await open();await ready("comments");await complete("comments",comments(1));
    await page.getByPlaceholder("说点什么…").fill("第一集待提交");await page.getByRole("button",{name:"发送评论",exact:true}).click();await ready("send");
    await page.evaluate(()=>window.playerPanelFixture.setEp(2));await ready("comments",{ep:2});await complete("comments",comments(2),false,{ep:2});
    await page.getByPlaceholder("说点什么…").fill("第二集草稿");await complete("send",{});
    assert.equal(await page.getByPlaceholder("说点什么…").inputValue(),"第二集草稿");
    assert.equal(await page.evaluate(()=>window.playerPanelFixture.calls.filter(c=>c.cmd==="comments").length),2);
  });
  await check("feed chapter selection uses selected episode",async()=>{
    await open("feed");await ready("play",{ep:1});await page.keyboard.press("e");
    await page.getByRole("button",{name:"2",exact:true}).click();await ready("play",{ep:2});
    await page.getByText("第 2/30 集",{exact:true}).waitFor();
  });
  await check("episodes remain selected after sorting",async()=>{
    await open("episodes");await page.getByRole("button",{name:"2",exact:true}).click();
    assert.equal(await page.getByRole("button",{name:"2",exact:true}).getAttribute("aria-current"),"true");
    await page.getByRole("button",{name:"倒序",exact:true}).click();assert.equal(await page.locator(".grid button").first().innerText(),"30");
    assert.equal(await page.getByRole("button",{name:"2",exact:true}).getAttribute("aria-current"),"true");
  });
  await check("article scroll and link copy fallback",async()=>{
    await open("article");await page.getByRole("link",{name:"正文链接"}).click();
    assert.deepEqual(await page.evaluate(()=>window.playerPanelFixture.copied),["https://example.com/article"]);
    assert(await page.locator(".scroll-y").evaluate(el=>el.scrollTop>0 && el.scrollHeight>el.clientHeight));
    assert(await page.getByRole("button",{name:"关闭",exact:true}).isVisible());
  });
  await check("inactive feed cannot retain keyboard focus",async()=>{
    await open("feed");await ready("play");await page.getByRole("button",{name:"倍速",exact:true}).focus();
    await page.evaluate(()=>window.playerPanelFixture.setActive(false));
    assert(await page.locator(".player-root").evaluate(el=>el.inert),"Inactive feed is inert");
    await page.getByRole("button",{name:"播放器外部按钮",exact:true}).focus();await page.keyboard.press("Shift+Tab");
    assert(!await page.locator(".player-root").evaluate(el=>el.contains(document.activeElement)),"Hidden player controls skipped by keyboard");
  });
  await check("keyboard focus wakes idle controls",async()=>{
    await open("feed");await ready("play");await page.locator(".player-root.is-idle").waitFor();
    await page.getByRole("button",{name:"倍速",exact:true}).focus();
    await page.waitForFunction(()=>!document.querySelector(".player-root").classList.contains("is-idle"));
    await page.keyboard.press("Enter");await page.getByRole("menu",{name:"播放速度"}).waitFor();
    await page.waitForFunction(()=>document.activeElement?.getAttribute("aria-checked")==="true");
    await page.keyboard.press("End");await page.keyboard.press("Enter");
    await page.waitForFunction(()=>document.querySelector(".player-speed").textContent==="2.0x");
  });
  for (const viewport of [{width:375,height:812},{width:812,height:375}]) {
    await page.setViewportSize(viewport);
    for (const theme of ["light","dark"]) {
      await page.emulateMedia({colorScheme:theme});
      await open();await ready("comments");await complete("comments",comments(1,[{id:1,user_id:7,nickname:"测试用户",text:"连续长评论文本".repeat(24),time:"刚刚",like_count:0,reply_count:0}]));
      await page.getByPlaceholder("说点什么…").waitFor();
      await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);
      await page.screenshot({path:`${out}/comments-${viewport.width}-${theme}.png`});
      assert(await page.locator(".scroll-y").evaluate(el=>el.scrollWidth<=el.clientWidth+1),"Long comments wrap inside panel");
    }
  }
  await page.close();
} finally {
  await browser?.close();await vite?.close();report.passed=report.cases.every(c=>c.passed)&&!report.errors.length;
  await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));console.log(`Artifacts: ${out}`);if(!report.passed)process.exitCode=1;
}
