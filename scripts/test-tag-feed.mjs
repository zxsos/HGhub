import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = `${root}test-results/tag-feed/${new Date().toISOString().replace(/[:.]/g, "-")}`;
await mkdir(out, { recursive: true });
const preferencesKey = (await readFile(`${root}src/contentPreferences.ts`, "utf8")).match(/CONTENT_PREFERENCES_KEY\s*=\s*"([^"]+)"/)[1];
const report = { environment: "Real Feed/Home + neutral deferred fixture; all media/cover requests intercepted locally. Chromium desktop and iPhone layouts.", passed: [], failed: [], errors: [] };
let server, browser;
try {
  server = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } }); await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const paint = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const complete = (page, id, tags, error = "", empty = false) => page.evaluate(args => window.tagFeedFixture.complete(...args), [id, tags, error, empty]);
  const count = (page, cmd, id) => page.evaluate(({ cmd, id }) => window.tagFeedFixture.calls.filter(call => call.cmd === cmd && (id === undefined || call.id === id)).length, { cmd, id });
  const ready = (page, cmd, id) => page.waitForFunction(({ cmd, id }) => window.tagFeedFixture?.calls.some(call => call.cmd === cmd && (id === undefined || call.id === id)), { cmd, id });
  const run = async (name, query, test, preferences = { blockedTags: ["Science"], paused: false, hideUntagged: false }, mobile = false, viewport) => {
    const context = await browser.newContext({ viewport: viewport || (mobile ? { width: 375, height: 812 } : { width: 1100, height: 900 }), reducedMotion: "reduce",
      ...(mobile ? { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1", isMobile: true, hasTouch: true } : {}) });
    await context.addInitScript(({ preferences, preferencesKey }) => {
      localStorage.clear(); localStorage.setItem(preferencesKey, JSON.stringify(preferences)); Math.random = () => .999;
    }, { preferences, preferencesKey });
    const page = await context.newPage(), requests = [];
    page.setDefaultTimeout(4500); page.on("pageerror", error => report.errors.push({ name, error: error.message }));
    await page.route("**/*", route => {
      if (new URL(route.request().url()).origin === new URL(origin).origin) return route.continue();
      requests.push(route.request().url());
      return route.fulfill({ status: 200, contentType: route.request().url().includes("/img?") ? "image/svg+xml" : "video/mp4",
        body: route.request().url().includes("/img?") ? '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><path fill="#426b65" d="M0 0h100v100H0z"/></svg>' : "" });
    });
    try {
      await page.goto(`${origin}tests/tag-feed.html?${query}`); await page.waitForFunction(() => !!window.tagFeedFixture?.preferences); await paint(page);
      await test(page, requests); report.passed.push(name); await page.screenshot({ path: `${out}/${name}.png` });
    } catch (error) { report.failed.push({ name, error: String(error) }); await page.screenshot({ path: `${out}/${name}-failed.png` }); }
    finally { await context.close(); }
  };
  const noMedia = async (page, requests) => { assert.equal(await page.locator("video,img").count(), 0); assert.equal(await count(page, "play"), 0); assert.deepEqual(await page.evaluate(() => window.tagFeedFixture.history), []); assert.deepEqual(requests, []); };
  await run("pending-block-once-revision", "", async (page, requests) => {
    await ready(page, "detail", 1); await noMedia(page, requests);
    await complete(page, 1, ["science"]); await page.getByRole("button", { name: "本次查看", exact: true }).waitFor(); await noMedia(page, requests);
    await page.getByRole("button", { name: "本次查看", exact: true }).click(); await ready(page, "play", 1); await page.locator("video").waitFor();
    assert.deepEqual(await page.evaluate(() => window.tagFeedFixture.preferences.preferences.blockedTags), ["Science"]);
    await page.evaluate(() => window.tagFeedFixture.preferences.blockTags(["Travel"])); await page.locator("[data-content-block-notice]").waitFor();
    assert.equal(await page.locator("video,img").count(), 0, "Revision synchronously removes media and cover");
    const history = await page.evaluate(() => window.tagFeedFixture.history);
    await page.evaluate(() => window.tagFeedFixture.setMounted(false)); await paint(page);
    assert.deepEqual(await page.evaluate(() => window.tagFeedFixture.history), history);
  });
  await run("pause-and-resume-revokes-once", "", async page => {
    await complete(page, 1, ["Science"]); await page.getByRole("button", { name: "本次查看", exact: true }).click(); await page.locator("video").waitFor();
    await page.evaluate(() => window.tagFeedFixture.preferences.setPaused(true)); await paint(page); assert.equal(await page.locator("video").count(), 1);
    await page.evaluate(() => window.tagFeedFixture.preferences.setPaused(false)); await page.getByRole("button", { name: "本次查看", exact: true }).waitFor(); assert.equal(await page.locator("video").count(), 0);
  });
  await run("detail-null-error-and-retry", "", async (page, requests) => {
    await complete(page, 1, undefined, "", true); await page.getByRole("button", { name: "重试标签", exact: true }).waitFor(); await noMedia(page, requests);
    await page.getByRole("button", { name: "重试标签", exact: true }).click(); await paint(page); await complete(page, 1, undefined, "标签服务暂时离线");
    await page.getByText("标签服务暂时离线", { exact: true }).waitFor(); await noMedia(page, requests);
    await page.getByRole("button", { name: "重试标签", exact: true }).click(); await paint(page); await complete(page, 1, ["Travel"]); await ready(page, "play", 1);
  });
  await run("unknown-tags-retained", "", async page => { await complete(page, 1); await ready(page, "play", 1); await page.locator("video").waitFor(); });
  await run("untagged-opt-in", "", async (page, requests) => { await complete(page, 1, []); await page.getByText("未提供标签", { exact: true }).waitFor(); await noMedia(page, requests); }, { blockedTags: [], paused: false, hideUntagged: true });
  await run("no-rules-preserves-eager-playback", "", async page => { await ready(page, "play", 1); await page.locator("video").waitFor(); assert.equal(await page.locator("[data-content-block-notice]").count(), 0); }, { blockedTags: [], paused: false, hideUntagged: false });
  await run("new-rule-removes-current-media", "auto=allow", async page => {
    await page.locator("video").waitFor(); await page.evaluate(() => window.tagFeedFixture.preferences.blockTags(["Science"])); await page.getByRole("button", { name: "本次查看", exact: true }).waitFor(); assert.equal(await page.locator("video,img").count(), 0);
  }, { blockedTags: [], paused: false, hideUntagged: false });
  await run("home-skips-detail-match", "home=mixed", async (page, requests) => {
    await ready(page, "detail", 1); await noMedia(page, requests); await complete(page, 2, ["Travel"]); await complete(page, 1, ["Science"]);
    await ready(page, "play", 2); assert.equal(await count(page, "play", 1), 0); assert(requests.every(url => !decodeURIComponent(url).includes("/cover/1") && !decodeURIComponent(url).includes("/media/1/")));
    assert.deepEqual(await page.evaluate(() => window.tagFeedFixture.history.map(item => item.id)), [2]);
  });
  for (const home of ["listed", "detail"]) await run(`home-bounded-${home}`, `home=${home}&auto=block`, async (page, requests) => {
    await page.getByText("已达到本次自动补充上限，可继续加载。", { exact: true }).waitFor(); assert.equal(await count(page, "feed"), 3); await noMedia(page, requests);
    await paint(page); assert.equal(await count(page, "feed"), 3);
    await page.getByRole("button", { name: "继续加载", exact: true }).click(); await page.waitForFunction(() => window.tagFeedFixture.calls.filter(call => call.cmd === "feed").length === 6);
    await page.getByText("已达到本次自动补充上限，可继续加载。", { exact: true }).waitFor(); await paint(page); assert.equal(await count(page, "feed"), 6); await noMedia(page, requests);
  });
  await run("id-anchor-and-once-leave", "ids=1,2,3&start=1", async page => {
    await complete(page, 1, ["Travel"]); await complete(page, 3, ["Travel"]); await complete(page, 2, ["Science"]);
    await page.getByRole("button", { name: "本次查看", exact: true }).click(); await page.locator("video").waitFor();
    const anchored = () => page.locator("video").evaluate(video => Math.abs(video.closest("section").getBoundingClientRect().top - document.querySelector(".player-root").getBoundingClientRect().top) < 1);
    assert(await anchored()); await page.evaluate(() => window.tagFeedFixture.setIds([3, 2])); await paint(page); assert(await anchored()); assert.equal(await count(page, "play", 3), 0);
    assert.equal(await page.evaluate(() => window.tagFeedFixture.nearEnd), 0, "Nonzero automatic anchoring never requests another page");
    await page.evaluate(() => window.tagFeedFixture.setIds([3])); await ready(page, "play", 3);
    await page.evaluate(() => window.tagFeedFixture.setIds([2])); await page.getByRole("button", { name: "本次查看", exact: true }).waitFor(); assert.equal(await page.locator("video").count(), 0);
  });
  await run("inactive-notice-is-inert", "", async page => {
    await complete(page, 1, ["Science"]); await page.evaluate(() => window.tagFeedFixture.setActive(false)); await paint(page);
    assert(await page.locator("[data-content-block-notice]").evaluate(element => !!element.closest("[inert]")));
    assert.equal(await page.getByRole("button", { name: "本次查看", exact: true }).count(), 0);
  });
  await run("menu-full-capacity", "auto=allow", async page => {
    await page.getByRole("button", { name: "不感兴趣", exact: true }).click();
    await page.getByText("已达到 200 个屏蔽标签上限，请到设置中清理后再添加。", { exact: true }).waitFor();
    assert(await page.getByRole("button", { name: "屏蔽所选标签", exact: true }).isDisabled());
    assert(await page.getByRole("button", { name: "Science", exact: true }).isDisabled());
    assert.equal(await page.evaluate(() => window.tagFeedFixture.preferences.preferences.blockedTags.length), 200);
  }, { blockedTags: Array.from({ length: 200 }, (_, i) => `Saved ${i}`), paused: false, hideUntagged: false });
  await run("menu-long-tag", "auto=long", async page => {
    await page.getByRole("button", { name: "不感兴趣", exact: true }).click();
    assert(await page.getByRole("button", { name: `${"L".repeat(65)} · 标签过长`, exact: true }).isDisabled());
    assert(await page.getByRole("button", { name: "屏蔽所选标签", exact: true }).isDisabled());
  }, { blockedTags: [], paused: false, hideUntagged: false });
  await run("menu-final-capacity-slot", "auto=allow", async page => {
    await page.getByRole("button", { name: "不感兴趣", exact: true }).click(); await page.getByRole("button", { name: "Science", exact: true }).click();
    assert(await page.getByRole("button", { name: "Travel", exact: true }).isDisabled()); await page.getByRole("button", { name: "屏蔽所选标签", exact: true }).click();
    await page.getByRole("button", { name: "本次查看", exact: true }).waitFor(); assert.equal(await page.evaluate(() => window.tagFeedFixture.preferences.preferences.blockedTags.length), 200);
  }, { blockedTags: Array.from({ length: 199 }, (_, i) => `Saved ${i}`), paused: false, hideUntagged: false });
  for (const mobile of [false, true]) for (const landscape of mobile ? [false, true] : [false]) {
    await run(`menu-geometry-${mobile ? "mobile" : "desktop"}-${landscape ? "landscape" : "portrait"}`, "auto=allow", async page => {
      const trigger = page.getByRole("button", { name: "不感兴趣", exact: true }); await trigger.waitFor();
      const geometry = await trigger.evaluate(button => {
        const box = button.getBoundingClientRect(); const header = document.querySelector(".desktop-context-header"); const h = header?.getBoundingClientRect();
        return { width: box.width, height: box.height, onScreen: box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth,
          overlapsHeader: !!h && box.left < h.right && box.right > h.left && box.top < h.bottom && box.bottom > h.top };
      });
      assert(geometry.width >= 44 && geometry.height >= 44 && geometry.onScreen); assert(!geometry.overlapsHeader);
      await trigger.click(); const dialog = page.getByRole("dialog", { name: "不感兴趣" }); await dialog.waitFor();
      assert.equal(await dialog.getByRole("button", { name: "science", exact: true }).count(), 0);
      await dialog.getByRole("button", { name: "Science", exact: true }).click(); await dialog.getByRole("button", { name: "屏蔽所选标签", exact: true }).click();
      await page.getByRole("button", { name: "本次查看", exact: true }).waitFor(); assert.equal(await page.locator("video").count(), 0);
    }, { blockedTags: [], paused: false, hideUntagged: false }, mobile, landscape ? { width: 812, height: 375 } : undefined);
  }
} catch (error) { report.failed.push({ name: "runner", error: String(error) }); }
finally {
  await browser?.close(); await server?.close();
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, output: out }, null, 2));
  if (report.failed.length || report.errors.length) process.exitCode = 1;
}
