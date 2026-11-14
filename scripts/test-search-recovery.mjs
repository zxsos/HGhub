import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = fileURLToPath(new URL(`../test-results/search-recovery/${new Date().toISOString().replace(/[:.]/g, "-")}/`, import.meta.url));
await mkdir(output, { recursive: true });
const report = { environment: "Real Search, RankPage and InplaceSearch; deterministic Tauri IPC. No upstream or native WebView.", passed: [], failed: [], pageErrors: [], external: [] };
let server, browser;
try {
  server = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1", isMobile: true, hasTouch: true });
  await context.addInitScript(installFixture, { theme: "light", titles: ["示例"] });
  await context.addInitScript(() => {
    const pending = [], history = [];
    const original = window.__TAURI_INTERNALS__.invoke;
    window.searchRecoveryFixture = { pending, history, finish(match, response, error) {
      const at = pending.findIndex(request => Object.entries(match).every(([key, value]) => (key === "cmd" ? request.cmd : request.args[key]) === value));
      if (at < 0) throw new Error(`No pending request: ${JSON.stringify(match)}`);
      const [request] = pending.splice(at, 1);
      if (error) request.reject(error); else request.resolve(response);
    } };
    window.__TAURI_INTERNALS__.invoke = (cmd, args = {}) => {
      if (!["api_search", "api_rank"].includes(cmd)) return original(cmd, args);
      history.push({ cmd, args });
      return new Promise((resolve, reject) => pending.push({ cmd, args, resolve, reject }));
    };
  });
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(origin).origin) return route.continue();
    report.external.push(url.href); return route.abort();
  });
  const card = (id, title, original = 1) => ({ id, video_id: id, rank: id, title, cover: "", tags: ["剧情"], score: 8, episode_count: 1, total_episodes: 1, hot: 100, like_count: 0, collect_count: 0, comment_count: 0, is_finished: true, is_original: original, metric_value: 100, metric_label: "热度" });
  const response = (items, page = 1, pages = 1, total = items.length) => ({ items, pagination: { page, pages, size: 20, total } });
  const finish = (page, match, value, error) => page.evaluate(args => window.searchRecoveryFixture.finish(...args), [match, value, error]);
  const waitPending = (page, match) => page.waitForFunction(match => window.searchRecoveryFixture.pending.some(request => Object.entries(match).every(([key, value]) => (key === "cmd" ? request.cmd : request.args[key]) === value)), match, { timeout: 2500 });
  const submit = async (page, q) => { await page.locator("input").fill(q); await page.locator("input").press("Enter"); await waitPending(page, { cmd: "api_search", q, page: 1 }); };
  const run = async (name, kind, fn) => {
    const page = await context.newPage(); page.setDefaultTimeout(3000);
    page.on("pageerror", e => report.pageErrors.push({ name, error: e.message }));
    try { await page.goto(`${origin}tests/search-recovery.html?page=${kind}`); await fn(page); await page.screenshot({ path: `${output}/${name}.png`, animations: "disabled" }); report.passed.push(name); }
    catch (e) { report.failed.push({ name, error: String(e) }); await page.screenshot({ path: `${output}/${name}-failure.png`, animations: "disabled" }).catch(() => {}); }
    finally { await page.close(); }
  };
  await run("rank-retry", "rank", async page => {
    await waitPending(page, { cmd: "api_rank", kind: "hot" });
    await finish(page, { kind: "hot" }, null, "HTTP 503 fixture");
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await waitPending(page, { kind: "hot" });
    await finish(page, { kind: "hot" }, response([card(1, "热播成功")]));
    await page.getByText("热播成功", { exact: true }).waitFor();
    assert.equal(await page.getByText("榜单加载失败", { exact: true }).count(), 0);
  });
  await run("rank-switch-cache-stale", "rank", async page => {
    await waitPending(page, { kind: "hot" }); await finish(page, { kind: "hot" }, response([card(1, "热播缓存")]));
    await page.getByText("热播缓存", { exact: true }).waitFor();
    await page.getByRole("button", { name: "推荐榜", exact: true }).click(); await waitPending(page, { kind: "recommend" });
    await page.getByRole("button", { name: "潜力榜", exact: true }).click(); await waitPending(page, { kind: "potential" });
    await finish(page, { kind: "potential" }, response([card(1, "潜力最新")]));
    await finish(page, { kind: "recommend" }, response([card(1, "过期推荐")]));
    await page.getByText("潜力最新", { exact: true }).waitFor(); assert.equal(await page.getByText("过期推荐", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "热播榜", exact: true }).click();
    await page.getByText("热播缓存", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.searchRecoveryFixture.history.filter(r => r.args.kind === "hot").length), 1, "Returning to a fresh cached rank must not re-fetch");
  });
  for (const kind of ["global", "inplace"]) {
    await run(`${kind}-search-retry`, kind, async page => {
      await submit(page, "失败"); await finish(page, { q: "失败" }, null, "HTTP 503 fixture");
      await page.getByRole("button", { name: "重试", exact: true }).click(); await waitPending(page, { q: "失败" });
      await finish(page, { q: "失败" }, response([card(1, "恢复结果")])); await page.getByRole("button", { name: "恢复结果", exact: true }).waitFor();
    });
    await run(`${kind}-retain-and-paginate`, kind, async page => {
      await submit(page, "甲"); await finish(page, { q: "甲" }, response([card(1, "甲内容")], 1, 2, 4));
      await page.getByRole("button", { name: "甲内容", exact: true }).waitFor();
      assert.match(await page.locator("body").innerText(), /已加载\s*1\s*\/\s*4/, "Loaded count must not claim the whole result count");
      await page.getByRole("button", { name: "加载更多", exact: true }).click(); await waitPending(page, { q: "甲", page: 2 });
      await finish(page, { q: "甲", page: 2 }, null, "HTTP 503 fixture");
      await page.getByRole("button", { name: "甲内容", exact: true }).waitFor();
      await page.getByRole("button", { name: "重试", exact: true }).click(); await waitPending(page, { q: "甲", page: 2 });
      await finish(page, { q: "甲", page: 2 }, response([card(2, "第二页")], 2, 2, 4));
      await page.getByRole("button", { name: "第二页", exact: true }).waitFor();
      await submit(page, "乙");
      assert(await page.getByRole("button", { name: "甲内容", exact: true }).isVisible(), "Previous same-kind content remains while new query is pending");
      assert.match(await page.locator("body").innerText(), /「甲」.*已加载/, "Retained cards must keep their original keyword label");
      await finish(page, { q: "乙" }, response([card(3, "乙内容")])); await page.getByRole("button", { name: "乙内容", exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "甲内容", exact: true }).count(), 0);
    });
    await run(`${kind}-clear-and-stale`, kind, async page => {
      await submit(page, "先"); await submit(page, "后");
      await finish(page, { q: "后" }, response([card(2, "新的结果")]));
      await finish(page, { q: "先" }, response([card(1, "过期结果")]));
      await page.getByRole("button", { name: "新的结果", exact: true }).waitFor(); assert.equal(await page.getByRole("button", { name: "过期结果", exact: true }).count(), 0);
      await submit(page, "清除前"); await page.getByRole("button", { name: "清空搜索", exact: true }).click();
      await finish(page, { q: "清除前" }, response([card(3, "清除后过期结果")]));
      assert.equal(await page.getByRole("button", { name: "清除后过期结果", exact: true }).count(), 0);
      assert.equal(await page.locator("input").inputValue(), "");
    });
  }
  await run("global-type-cache", "global", async page => {
    await submit(page, "题材"); await finish(page, { q: "题材", kind: "video" }, response([card(1, "视频内容")]));
    await page.getByRole("button", { name: "视频内容", exact: true }).waitFor();
    await page.getByRole("button", { name: "帖子", exact: true }).click(); await waitPending(page, { kind: "post" });
    assert.equal(await page.getByRole("button", { name: "视频内容", exact: true }).count(), 0, "Do not show videos under post selection");
    await finish(page, { kind: "post" }, response([card(2, "帖子内容")])); await page.getByRole("button", { name: "帖子内容", exact: true }).waitFor();
    await page.getByRole("button", { name: "视频", exact: true }).click(); await page.getByRole("button", { name: "视频内容", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.searchRecoveryFixture.history.filter(r => r.args.kind === "video").length), 1);
  });
  await run("rank-refresh-preserves-data", "rank", async page => {
    await waitPending(page, { kind: "hot" }); await finish(page, { kind: "hot" }, response([card(1, "已有榜单")]));
    await page.getByText("已有榜单", { exact: true }).waitFor();
    await page.getByRole("button", { name: "刷新榜单", exact: true }).click();
    await waitPending(page, { kind: "hot" });
    assert(await page.getByText("已有榜单", { exact: true }).isVisible());
    assert(await page.getByRole("button", { name: "刷新榜单", exact: true }).isDisabled());
    await finish(page, { kind: "hot" }, null, "HTTP 503 fixture");
    await page.getByRole("alert").waitFor();
    assert(await page.getByText("已有榜单", { exact: true }).isVisible());
    await page.getByRole("button", { name: "重试", exact: true }).click(); await waitPending(page, { kind: "hot" });
    await finish(page, { kind: "hot" }, response([card(2, "更新榜单")])); await page.getByText("更新榜单", { exact: true }).waitFor();
    assert.equal(await page.getByRole("alert").count(), 0);
  });
  await run("search-submit-dedup", "global", async page => {
    await submit(page, "去重"); await page.locator("input").press("Enter");
    assert.equal(await page.evaluate(() => window.searchRecoveryFixture.history.filter(r => r.cmd === "api_search").length), 1);
    await finish(page, { q: "去重" }, response([card(1, "去重结果")])); await page.getByRole("button", { name: "去重结果", exact: true }).waitFor();
  });
  await run("original-filter-count", "original", async page => {
    await submit(page, "原创"); await finish(page, { q: "原创" }, response([card(1, "原创片", 1), card(2, "普通片", 0)], 1, 2, 99));
    await page.getByRole("button", { name: "原创片", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "普通片", exact: true }).count(), 0);
    assert.match(await page.locator("body").innerText(), /已加载\s*1\s*条原创/);
    assert(!(/\/\s*99/.test(await page.locator("body").innerText())), "Do not show unfiltered total as original-only total");
  });
  await run("original-empty-page-continues", "original", async page => {
    await submit(page, "原创分页"); await finish(page, { q: "原创分页" }, response([card(1, "普通片", 0)], 1, 2, 2));
    await page.getByRole("button", { name: "加载更多", exact: true }).click(); await waitPending(page, { q: "原创分页", page: 2 });
    await finish(page, { q: "原创分页", page: 2 }, response([card(2, "后页原创", 1)], 2, 2, 2));
    await page.getByRole("button", { name: "后页原创", exact: true }).waitFor();
    assert.match(await page.locator("body").innerText(), /已加载\s*1\s*条原创/);
  });
  assert.deepEqual(report.external, []); assert.deepEqual(report.pageErrors, []);
  if (report.failed.length) process.exitCode = 1;
} catch (error) { report.failed.push({ name: "runner", error: String(error) }); process.exitCode = 1; }
finally {
  await browser?.close(); await server?.close();
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, pageErrors: report.pageErrors, output }, null, 2));
}
