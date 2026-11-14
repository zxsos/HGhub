import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
const root = fileURLToPath(new URL("../", import.meta.url));
const output = fileURLToPath(new URL(`../test-results/content-filter-lists/${Date.now()}/`, import.meta.url));
await mkdir(output, { recursive: true });
const preferenceKey = (await readFile(`${root}/src/contentPreferences.ts`, "utf8")).match(/CONTENT_PREFERENCES_KEY = "([^"]+)"/)[1];
const report = { environment: "Real list components, Chromium, controlled local IPC, no upstream requests", cases: [], errors: [] };
let vite, browser;
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } }); await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const page = await browser.newPage({ viewport: { width: 375, height: 812 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(4000); page.setDefaultNavigationTimeout(10000);
  page.on("pageerror", error => report.errors.push(error.message));
  await page.addInitScript(key => {
    const query = new URLSearchParams(location.search);
    localStorage.clear();
    localStorage.setItem(key, JSON.stringify({ blockedTags: query.get("rules") === "none" ? [] : ["foo"], paused: false, hideUntagged: false }));
    localStorage.setItem("hghubx_app_v1", JSON.stringify({ favs: [1, 2], history: [{ id: 1, ep: 2, t: 15, dur: 120, at: 123 }], follows: [7] }));
    localStorage.setItem("hghubx_swipe_ep_v2", "1");
    localStorage.setItem("hghubx_theme", query.get("theme") || "dark");
  }, preferenceKey);
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(origin).origin) return route.continue();
    return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="30"><rect width="20" height="30" fill="#6d8198"/></svg>' });
  });
  const open = async (screen, params = {}) => { await page.goto(`${origin}tests/content-filter-lists.html?${new URLSearchParams({ screen, ...params })}`); await page.waitForFunction(() => !!window.contentFilterFixture?.preferences?.blockReason); };
  const check = async (name, fn) => { try { await fn(); report.cases.push({ name, passed: true }); } catch (error) { report.cases.push({ name, passed: false, error: String(error) }); await page.screenshot({ path: `${output}/${name.replaceAll(/[^\w-]/g, "-")}-failed.png` }); } };
  const hidden = async (count = 1) => { await page.getByText(`已隐藏 ${count} 项`, { exact: true }).first().waitFor(); assert.equal(await page.getByText("精确屏蔽标题", { exact: true }).count(), 0); assert.equal(await page.locator('img[src*="blocked-cover"]').count(), 0); };
  const setAction = (action, value) => page.evaluate(({ action, value }) => window.contentFilterFixture.preferences[action](value), { action, value });
  const callCount = cmd => page.evaluate(cmd => window.contentFilterFixture.calls.filter(call => call.cmd === cmd).length, cmd);
  const settleFrame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  await check("exact matching reveal restore and settings revision", async () => {
    await open("masonry"); await hidden();
    assert.equal(await page.locator(".ios-poster").count(), 3);
    await page.getByRole("button", { name: "临时展开", exact: true }).click();
    assert.equal(await page.locator(".ios-poster").count(), 4);
    assert(await page.evaluate(() => !!window.contentFilterFixture.preferences.blockReason(["foo"])), "Reveal preserves blocking decisions");
    await page.getByRole("button", { name: "恢复隐藏", exact: true }).click(); await hidden();
    await page.getByRole("button", { name: "临时展开", exact: true }).click();
    await setAction("setHideUntagged", true); await hidden(2);
    await setAction("setPaused", true); await page.getByText("精确屏蔽标题", { exact: true }).waitFor();
    assert.equal(await page.locator("[data-content-filter]").count(), 0);
    await setAction("setPaused", false); await hidden(2);
  });
  await check("scope changes permanently collapse local reveal", async () => {
    await open("masonry"); await hidden();
    await page.getByRole("button", { name: "临时展开", exact: true }).click();
    await page.evaluate(() => window.contentFilterFixture.setScope("second")); await hidden();
    await page.evaluate(() => window.contentFilterFixture.setScope("first")); await hidden();
  });
  for (const screen of ["search", "inplace-video", "inplace-post"]) await check(`${screen} result and query reset`, async () => {
    await open(screen);
    if (screen === "search") { await page.getByText("热搜无标签", { exact: true }).waitFor(); assert.equal(await callCount("api_video"), 0); }
    const input = page.getByRole("textbox").first();
    await input.fill("first"); await input.press("Enter"); await hidden();
    await page.getByRole("button", { name: "临时展开", exact: true }).click();
    await page.evaluate(() => window.contentFilterFixture.held.add("api_search"));
    await input.fill("second"); await input.press("Enter"); await hidden();
    // The pending query still shows A; revealing A must not reveal the arriving B.
    await page.getByRole("button", { name: "临时展开", exact: true }).click();
    await page.getByText("精确屏蔽标题", { exact: true }).waitFor();
    await page.evaluate(() => window.contentFilterFixture.settle()); await hidden();
    if (screen === "search") {
      await page.evaluate(() => window.contentFilterFixture.held.delete("api_search"));
      await page.getByRole("button", { name: "帖子", exact: true }).click(); await hidden();
      assert.equal(await page.locator(".ios-poster").count(), 3);
    }
  });
  await check("rank tab and category row lists hide blocked metadata", async () => {
    await open("rank"); await hidden();
    assert.equal(await page.locator(".ios-rank-row").count(), 3);
    await page.getByRole("button", { name: "临时展开", exact: true }).click();
    await page.getByRole("button", { name: "推荐榜", exact: true }).click(); await hidden();
    await open("category"); await hidden();
    assert.equal(await page.locator("[data-content-filter]").count(), 4);
    assert.equal(await page.locator(".ios-poster").count(), 12);
  });
  await check("topic and author scope resets", async () => {
    for (const screen of ["topic", "user"]) {
      await open(screen); await hidden();
      await page.getByRole("button", { name: "临时展开", exact: true }).click();
      await page.evaluate(() => window.contentFilterFixture.setScope("second")); await hidden();
    }
  });
  await check("tag entry uses name and cancel restores content", async () => {
    await open("tag", { rules: "none" }); await page.getByText("精确屏蔽标题", { exact: true }).waitFor();
    const block = page.getByRole("button", { name: "屏蔽此标签", exact: true });
    assert((await block.boundingBox()).height >= 44);
    await block.click(); await hidden();
    assert.deepEqual(await page.evaluate(() => window.contentFilterFixture.preferences.preferences.blockedTags), ["foo"]);
    const cancel = page.getByRole("button", { name: "取消屏蔽此标签", exact: true }); assert.equal(await cancel.getAttribute("aria-pressed"), "true");
    await cancel.click(); await page.getByText("精确屏蔽标题", { exact: true }).waitFor();
    assert.equal(await page.locator("[data-content-filter]").count(), 0);
  });
  for (const [screen, cmd] of [["channel", "api_category"], ["tag", "api_tag_videos"], ["following", "api_following"], ["user", "api_user_videos"]]) await check(`${screen} hidden page requires manual pagination`, async () => {
    await open(screen, { data: "all", pages: "3" }); await hidden(2); await settleFrame();
    assert.equal(await callCount(cmd), 1, "Filtering cannot drain pages through IntersectionObserver");
    await page.getByRole("button", { name: "加载更多", exact: true }).click();
    await page.getByText("可见标题 12", { exact: true }).waitFor(); await settleFrame();
    assert.equal(await callCount(cmd), 2, "One click fetches one page");
    if (screen === "channel") {
      await page.getByRole("button", { name: "临时展开", exact: true }).click();
      await page.getByRole("button", { name: "当前热播", exact: true }).click(); await hidden(2);
    }
  });
  await check("favorites and history keep records and resume progress", async () => {
    await open("profile"); await page.getByRole("button", { name: "该内容命中屏蔽标签，查看提示", exact: true }).waitFor();
    assert.equal(await page.locator(".ios-poster").count(), 2);
    assert.equal(await page.getByText("精确屏蔽标题", { exact: true }).count(), 0);
    assert.equal(await page.locator('img[src*="blocked-cover"]').count(), 0);
    await page.getByRole("button", { name: "观看历史", exact: true }).click();
    await page.getByText("第 2 集 · 0:15", { exact: true }).waitFor();
    assert.equal(await page.locator(".ios-poster").count(), 1);
    const records = await page.evaluate(() => ({ favs: window.contentFilterFixture.state.favs, history: window.contentFilterFixture.state.history }));
    assert.deepEqual(records.favs, [1, 2]); assert.equal(records.history[0].t, 15);
    await page.getByRole("button", { name: "该内容命中屏蔽标签，查看提示", exact: true }).click();
    const target = await page.evaluate(() => window.contentFilterFixture.state.stack.at(-1));
    assert.equal(target.kind, "feed"); assert.equal(target.startEp, 2); assert.equal(target.startTime, 15);
  });
  for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }, { width: 1440, height: 900 }]) for (const theme of ["light", "dark"]) await check(`responsive ${viewport.width} ${theme}`, async () => {
    await page.setViewportSize(viewport); await open("masonry", { theme }); await hidden();
    await page.evaluate(() => { document.documentElement.style.fontSize = "20px"; });
    const button = page.getByRole("button", { name: "临时展开", exact: true });
    const box = await button.boundingBox(); assert(box.height >= 44, JSON.stringify({ box, computed: await button.evaluate(el => ({ minHeight: getComputedStyle(el).minHeight, height: getComputedStyle(el).height, transform: getComputedStyle(el).transform })) }));
    assert(await page.locator("body").evaluate(el => el.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${output}/filter-${viewport.width}-${theme}.png`, animations: "disabled" });
    await open("masonry", { rules: "none", theme });
    await page.getByText("精确屏蔽标题", { exact: true }).waitFor();
    assert.equal(await page.locator("[data-content-filter]").count(), 0); assert.equal(await page.locator(".ios-poster").count(), 4);
  });
} finally {
  await browser?.close(); await vite?.close();
  report.passed = report.cases.length > 0 && report.cases.every(item => item.passed) && !report.errors.length;
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); console.log(`Artifacts: ${output}`);
  if (!report.passed) process.exitCode = 1;
}
