import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
const root = fileURLToPath(new URL("../", import.meta.url));
const output = fileURLToPath(new URL(`../test-results/discover-recovery/${new Date().toISOString().replace(/[:.]/g, "-")}/`, import.meta.url));
await mkdir(output, { recursive: true });
const report = { environment: "real Discover/Channel components in Chromium; controlled Tauri IPC; no upstream traffic", cases: [], errors: [] };
const cards = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, title: `影片 ${i + 1}`, cover: "", tags: [], score: 8, hot: 200, is_finished: true, episode_count: 2 }));
const paged = (items, page = 1, pages = 1) => ({ items, pagination: { page, pages, size: 20, total: 20 * pages } });
const topics = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, slug: `topic-${i}`, title: `专题 ${i + 1}`, intro: "精选故事", cover: "", video_count: 20 }));
const topic = (title, items = cards) => ({ topic: { ...topics[0], title, intro: "这是需要完整阅读的专题介绍。".repeat(20) }, related: [], videos: paged(items) });
const groups = { categories: [{ name: "题材", tags: [{ id: 1, name: "很长的标签文本没有空格也应换行而不超出页面".repeat(4), hot_score: 20000 }, { id: 2, name: "都市", hot_score: 8000 }] }] };
let vite, browser;
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } }); await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const page = await browser.newPage({ viewport: { width: 375, height: 812 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(4000); page.setDefaultNavigationTimeout(10000);
  page.on("pageerror", e => report.errors.push(e.message));
  await page.route("**/*", r => new URL(r.request().url()).origin === new URL(origin).origin ? r.continue() : r.abort());
  const ready = (cmd, match = {}) => page.waitForFunction(({ cmd, match }) => window.discoverFixture?.calls.some(c => c.cmd === cmd && Object.entries(match).every(([k, v]) => c.args[k] === v)), { cmd, match });
  const complete = (cmd, data, error = false, match = {}) => page.evaluate(args => window.discoverFixture.complete(...args), [cmd, data, error, match]);
  const open = async name => { await page.goto(`${origin}tests/discover-recovery.html?page=${name}`); };
  const check = async (name, fn) => { try { await fn(); report.cases.push({ name, passed: true }); } catch (e) { report.cases.push({ name, passed: false, error: String(e) }); await page.screenshot({ path: `${output}/${name.replaceAll(" ", "-")}-failed.png` }); } };
  await check("topics refresh preserves cards and recovers", async () => {
    await open("topics"); await ready("api_topics"); await complete("api_topics", { items: topics });
    await page.getByText("专题 1", { exact: true }).waitFor();
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    assert(await page.getByRole("button", { name: "刷新", exact: true }).isDisabled(), "Refresh is disabled while pending");
    assert(await page.getByText("专题 1", { exact: true }).isVisible(), "Refresh retains cards");
    await complete("api_topics", "HTTP 503", true);
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await complete("api_topics", { items: topics });
    await page.getByText("专题 1", { exact: true }).waitFor();
  });
  await check("tags refresh and long labels", async () => {
    await open("tags"); await ready("api_tags"); await complete("api_tags", groups);
    await page.getByRole("button", { name: /都市/ }).waitFor();
    assert(await page.locator(".scroll-y").evaluate(e => e.scrollWidth <= e.clientWidth + 1), "Long tags stay inside the scroller");
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    assert(await page.getByRole("button", { name: /都市/ }).isVisible(), "Refresh retains tags");
    await complete("api_tags", "刷新失败", true);
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await complete("api_tags", groups);
  });
  await check("topic changes ignore late replies", async () => {
    await open("topic"); await ready("api_topic", { slug: "first" });
    await page.evaluate(() => window.discoverFixture.setKey("second"));
    await ready("api_topic", { slug: "second" });
    await complete("api_topic", topic("第二专题"), false, { slug: "second" });
    await complete("api_topic", topic("旧专题"), false, { slug: "first" });
    await page.getByRole("heading", { name: "第二专题", exact: true }).waitFor();
    assert.equal(await page.getByText("旧专题", { exact: true }).count(), 0);
    const more = page.getByRole("button", { name: "展开简介", exact: true }); await more.click();
    assert.equal(await page.getByRole("button", { name: "收起简介", exact: true }).getAttribute("aria-expanded"), "true");
  });
  await check("tag pagination failure is recoverable", async () => {
    await open("tag"); await ready("api_tag_videos", { page: 1 }); await complete("api_tag_videos", paged(cards, 1, 2));
    await page.getByText("影片 1", { exact: true }).waitFor();
    await page.locator(".scroll-y").evaluate(e => { e.scrollTop = e.scrollHeight; });
    await ready("api_tag_videos", { page: 2 }); await complete("api_tag_videos", "分页失败", true, { page: 2 });
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await complete("api_tag_videos", paged([{ ...cards[0], id: 21, title: "后续影片" }], 2, 2), false, { page: 2 });
    await page.getByText("后续影片", { exact: true }).waitFor();
    assert.equal(await page.locator(".ios-poster-title").count(), 21);
  });
  await check("tag changes ignore late replies", async () => {
    await open("tag"); await ready("api_tag_videos", { tag: "first" });
    await page.evaluate(() => window.discoverFixture.setKey("second"));
    await ready("api_tag_videos", { tag: "second" });
    await complete("api_tag_videos", paged([{ ...cards[0], title: "新标签影片" }]), false, { tag: "second" });
    await complete("api_tag_videos", paged([{ ...cards[0], title: "旧标签影片" }]), false, { tag: "first" });
    await page.getByText("新标签影片", { exact: true }).waitFor();
    assert.equal(await page.getByText("旧标签影片", { exact: true }).count(), 0);
  });
  if (process.env.INCLUDE_CHANNEL === "1") await check("channel retains prior results during sort", async () => {
    await open("channel"); await ready("api_category", { sort: "latest" }); await complete("api_category", paged(cards));
    await page.getByText("影片 1", { exact: true }).waitFor();
    await page.getByRole("button", { name: "当前热播", exact: true }).click(); await ready("api_category", { sort: "hot_window" });
    assert(await page.getByText("影片 1", { exact: true }).isVisible(), "Sort keeps prior cards until replacement arrives");
    assert(await page.locator(".ios-media-grid").evaluate(e => !!e.closest("[inert]")), "Stale cards cannot be opened");
    await complete("api_category", "排序失败", true, { sort: "hot_window" });
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await complete("api_category", paged([{ ...cards[0], title: "热播结果" }]), false, { sort: "hot_window" });
    await page.getByText("热播结果", { exact: true }).waitFor();
  });
  for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    for (const theme of ["light", "dark"]) {
      await open("topics"); await ready("api_topics"); await complete("api_topics", { items: topics });
      await page.getByText("专题 1", { exact: true }).waitFor();
      await page.evaluate(theme => { document.documentElement.classList.toggle("theme-light", theme === "light"); document.documentElement.dataset.theme = theme; }, theme);
      await page.screenshot({ path: `${output}/topics-${viewport.width}-${theme}.png`, animations: "disabled" });
      if (viewport.width === 1440) await check(`desktop columns ${theme}`, async () => {
        const ys = await page.locator(".ios-topic-card").evaluateAll(elements => elements.map(e => Math.round(e.getBoundingClientRect().y)));
        assert(ys.filter(y => y === ys[0]).length >= 3, "Desktop uses more than two columns");
      });
      await open("tags"); await ready("api_tags"); await complete("api_tags", groups);
      await page.getByRole("button", { name: /都市/ }).waitFor();
      await page.evaluate(theme => { document.documentElement.classList.toggle("theme-light", theme === "light"); document.documentElement.dataset.theme = theme; }, theme);
      await page.screenshot({ path: `${output}/tags-${viewport.width}-${theme}.png`, animations: "disabled" });
      await open("topic"); await ready("api_topic"); await complete("api_topic", topic("专题详情"));
      await page.getByRole("heading", { name: "专题详情", exact: true }).waitFor();
      await page.evaluate(theme => { document.documentElement.classList.toggle("theme-light", theme === "light"); document.documentElement.dataset.theme = theme; }, theme);
      await page.screenshot({ path: `${output}/topic-detail-${viewport.width}-${theme}.png`, animations: "disabled" });
    }
  }
  await page.close();
} finally {
  await browser?.close(); await vite?.close();
  report.passed = report.cases.every(c => c.passed) && !report.errors.length;
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); console.log(`Artifacts: ${output}`);
  if (!report.passed) process.exitCode = 1;
}
