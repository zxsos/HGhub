import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = fileURLToPath(new URL(`../test-results/home-scheduling/${new Date().toISOString().replace(/[:.]/g, "-")}/`, import.meta.url));
await mkdir(output, { recursive: true });
const report = { environment: "Real App in Chromium with deterministic IPC; no upstream/native media. Request counts measure scheduling, not native frame latency. Dev StrictMode may duplicate mount effects.", passed: [], failed: [], pageErrors: [] };
let server, browser;
try {
  server = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } }); await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const mobile = process.env.HOME_UI_MOBILE === "1";
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 }, reducedMotion: "reduce",
    ...(mobile ? { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1", isMobile: true, hasTouch: true } : {}) });
  report.environment += mobile ? " Mobile 390×844." : " Desktop 1440×960.";
  await context.addInitScript(installFixture, { theme: "light", titles: ["示例一", "示例二", "示例三"] });
  await context.addInitScript(() => {
    const calls = [], pending = [];
    window.homeSchedulingFixture = { calls, finishFeed(items = [], error = "") {
      const request = pending.shift();
      if (!request) throw new Error("No pending feed");
      if (error) request.reject(error); else request.resolve({ items, pagination: { page: 1, pages: 1, total: items.length, size: 30 } });
    } };
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args = {}) => {
      calls.push({ command, args });
      if (command === "api_feed") return new Promise((resolve, reject) => pending.push({ resolve, reject }));
      return original(command, args);
    };
  });
  const nextPaint = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const finish = (page, items = [], error = "") => page.evaluate(([items, error]) => window.homeSchedulingFixture.finishFeed(items, error), [items, error]);
  const calls = (page, command) => page.evaluate(command => window.homeSchedulingFixture.calls.filter(call => call.command === command), command);
  const card = id => ({ id, title: `首页 ${id}`, cover: "", tags: [], score: 0, episode_count: 3, total_episodes: 3, hot: 10 });
  const run = async (name, test) => {
    const page = await context.newPage(); page.setDefaultTimeout(3500);
    page.on("pageerror", e => report.pageErrors.push({ name, error: e.message }));
    await page.route("**/*", route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort());
    try {
      await page.goto(origin);
      const nav = page.getByRole("navigation", { name: "主导航" });
      await nav.getByRole("button", { name: "首页", exact: true }).waitFor(); await nextPaint(page);
      await test(page, nav); await page.screenshot({ path: `${output}/${name}.png`, animations: "disabled" }); report.passed.push(name);
    } catch (e) { report.failed.push({ name, error: String(e) }); }
    finally { await page.close(); }
  };
  await run("startup-defers-unvisited-tabs", async page => {
    assert.equal((await calls(page, "api_feed")).length, 1);
    for (const command of ["api_video", "api_category", "api_original_videos", "api_post_category", "api_search_hot"]) assert.equal((await calls(page, command)).length, 0, `${command} should wait for its tab`);
    assert.equal(await page.locator('input[placeholder="搜索短剧、帖子、题材…"]').count(), 0, "Search DOM waits for first visit");
  });
  await run("late-home-response-defers-player", async (page, nav) => {
    await nav.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByRole("region", { name: "热搜榜" }).waitFor();
    await finish(page, [card(101), card(102), card(103)]); await nextPaint(page);
    for (const command of ["api_video", "api_play", "api_related"]) assert.equal((await calls(page, command)).filter(call => call.args.id >= 100).length, 0, `Hidden home must not start ${command}`);
    await nav.getByRole("button", { name: "首页", exact: true }).click();
    await page.waitForFunction(() => window.homeSchedulingFixture.calls.some(c => c.command === "api_play" && c.args.id >= 100));
    assert.equal((await calls(page, "api_feed")).length, 1, "Returned home consumes already loaded feed");
  });
  await run("visited-tabs-keep-state-and-data", async (page, nav) => {
    await nav.getByRole("button", { name: "搜索", exact: true }).click();
    const input = page.getByRole("textbox", { name: "搜索短剧、帖子、题材…" });
    await input.fill("保留查询"); await input.press("Enter");
    await page.getByRole("button", { name: "示例一", exact: true }).waitFor();
    await nav.getByRole("button", { name: "分类", exact: true }).click();
    await page.getByRole("button", { name: "示例一", exact: true }).first().waitFor();
    const category = (await calls(page, "api_category")).length;
    await nav.getByRole("button", { name: "我的", exact: true }).click();
    await page.getByRole("button", { name: "观看历史", exact: true }).click(); await nextPaint(page);
    await nav.getByRole("button", { name: "首页", exact: true }).click();
    await nav.getByRole("button", { name: "搜索", exact: true }).click(); assert.equal(await input.inputValue(), "保留查询");
    assert.equal((await calls(page, "api_search")).length, 1);
    await nav.getByRole("button", { name: "分类", exact: true }).click(); await nextPaint(page); assert.equal((await calls(page, "api_category")).length, category);
    await nav.getByRole("button", { name: "我的", exact: true }).click(); assert.equal(await page.getByRole("button", { name: "观看历史", exact: true }).getAttribute("aria-pressed"), "true");
  });
  await run("mounted-player-is-retained", async (page, nav) => {
    await finish(page, [card(101), card(102)]);
    await page.waitForFunction(() => window.homeSchedulingFixture.calls.some(c => c.command === "api_play" && c.args.id >= 100)); await nextPaint(page);
    const count = (await calls(page, "api_play")).length;
    await nav.getByRole("button", { name: "搜索", exact: true }).click(); await nav.getByRole("button", { name: "首页", exact: true }).click(); await nextPaint(page);
    assert.equal((await calls(page, "api_play")).length, count, "Visiting another tab must not remount player");
    assert.equal((await calls(page, "api_feed")).length, 1);
  });
  await run("home-error-retry", async page => {
    await finish(page, [], "HTTP 503 fixture"); await page.getByText("首页加载失败", { exact: true }).waitFor();
    await page.getByRole("button", { name: "重试", exact: true }).click(); await nextPaint(page); assert.equal((await calls(page, "api_feed")).length, 2);
    await finish(page); await page.getByText("暂无视频", { exact: true }).waitFor(); assert.equal(await page.getByText("首页加载失败", { exact: true }).count(), 0);
  });
  await run("home-empty-retry", async page => {
    await finish(page); await page.getByText("暂无视频", { exact: true }).waitFor();
    await page.getByRole("button", { name: "刷新", exact: true }).click(); await nextPaint(page); assert.equal((await calls(page, "api_feed")).length, 2);
    await finish(page, [card(101)]); await page.waitForFunction(() => window.homeSchedulingFixture.calls.some(c => c.command === "api_play"));
  });
  await run("line-change-waits-for-visible-home", async (page, nav) => {
    await finish(page, [], "HTTP 503 fixture"); await page.getByText("首页加载失败", { exact: true }).waitFor();
    await nav.getByRole("button", { name: "搜索", exact: true }).click();
    await page.evaluate(() => window.dispatchEvent(new Event("hg:line-changed"))); await nextPaint(page);
    assert.equal((await calls(page, "api_feed")).length, 1, "Inactive home defers retry on a new line");
    await nav.getByRole("button", { name: "首页", exact: true }).click(); await nextPaint(page);
    assert.equal((await calls(page, "api_feed")).length, 2, "Retry resumes on return");
  });
  await run("stale-line-result-does-not-start-player", async (page, nav) => {
    await nav.getByRole("button", { name: "搜索", exact: true }).click();
    await page.evaluate(() => window.dispatchEvent(new Event("hg:line-changed"))); await nextPaint(page);
    await finish(page, [card(901)]); await nextPaint(page);
    assert.equal((await calls(page, "api_feed")).length, 1);
    await nav.getByRole("button", { name: "首页", exact: true }).click(); await nextPaint(page);
    assert.equal((await calls(page, "api_feed")).length, 2);
    assert.equal((await calls(page, "api_play")).filter(call => call.args.id === 901).length, 0);
    await finish(page, [card(101)]); await page.waitForFunction(() => window.homeSchedulingFixture.calls.some(c => c.command === "api_play" && c.args.id === 101));
  });
  assert.deepEqual(report.pageErrors, []);
  if (report.failed.length) process.exitCode = 1;
} catch (error) { report.failed.push({ name: "runner", error: String(error) }); process.exitCode = 1; }
finally { await browser?.close(); await server?.close(); await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ...report, output }, null, 2)); }
