/** Focused alignment checks against the real App and neutral, offline IPC fixtures. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL(`../test-results/visual-alignment/${Date.now()}/`, import.meta.url);
await mkdir(output, { recursive: true });
const report = { environment: "Real React App, Chromium with neutral simulated IPC and cover artwork; no upstream traffic or native-device playback", checks: [], measurements: [], errors: [] };
const titles = ["城市与晚风", "重逢在夏日以后", "星河旅人", "无声的答案", "我的奇妙假期", "晴天来信"];
let server, browser, page;
const rect = locator => locator.evaluate(el => { const { left, right, top, bottom, width, height } = el.getBoundingClientRect(); return { left, right, top, bottom, width, height }; });
const near = (a, b, message) => assert(Math.abs(a - b) < 1.1, `${message}: ${a} vs ${b}`);
const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
try {
  server = await createServer({ root, server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  for (const width of [320, 375, 1280]) {
    const mobile = width < 500;
    const context = await browser.newContext({ viewport: { width, height: 850 }, reducedMotion: "reduce",
      ...(mobile ? { userAgent: "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36", isMobile: true, hasTouch: true } : {}) });
    await context.addInitScript(installFixture, { theme: width === 320 ? "light" : "dark", titles });
    page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on("pageerror", error => report.errors.push(error.message));
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(origin).origin) return route.continue();
      if (url.pathname === "/img") return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="480"><rect width="360" height="480" fill="#3d6780"/><circle cx="180" cy="150" r="60" fill="#8ca8b5"/></svg>' });
      return route.abort();
    });
    const check = name => report.checks.push(`${width}: ${name}`);
    const shot = async name => {
      await page.screenshot({ path: fileURLToPath(new URL(`${width}-${name}.png`, output)), animations: "disabled" });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width} ${name}: no horizontal viewport overflow`);
    };
    const nav = () => page.getByRole("navigation", { name: "主导航" });
    await page.goto(origin);
    await nav().getByRole("button", { name: "首页", exact: true }).waitFor();
    await shot("home");

    await nav().getByRole("button", { name: "分类", exact: true }).click();
    const category = page.locator(".ios-page").filter({ has: page.getByRole("heading", { name: "分类", exact: true }) });
    const shortcuts = category.locator(".ios-category-links");
    const preview = category.getByRole("group", { name: "AI成人短剧影片预览", exact: true });
    await preview.locator(".ios-poster").first().waitFor();
    const titleBox = await rect(category.getByRole("heading", { name: "分类", exact: true }));
    const linksBox = await rect(shortcuts);
    const posterBox = await rect(preview.locator(".ios-poster").first());
    const channelBox = await rect(category.getByRole("button").filter({ has: page.getByRole("heading", { name: "AI成人短剧", exact: true }) }).locator("span").first());
    const contentBox = await category.locator(":scope > .scroll-y").evaluate(el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return { left: r.left + parseFloat(s.paddingLeft), right: r.right - parseFloat(s.paddingRight) }; });
    for (const [name, box] of [["标题", titleBox], ["专题标签", linksBox], ["频道图标", channelBox], ["首张封面", posterBox]]) near(box.left, contentBox.left, `${width} 分类 ${name} 左边界`);
    near(linksBox.right, contentBox.right, `${width} 分类快捷入口右边界`);
    const shortcutBoxes = await shortcuts.getByRole("button").evaluateAll(items => items.map(el => { const r = el.getBoundingClientRect(); return { top: r.top, width: r.width, height: r.height }; }));
    near(shortcutBoxes[0].width, shortcutBoxes[1].width, "专题/标签等宽");
    near(shortcutBoxes[0].top, shortcutBoxes[1].top, "专题/标签顶对齐");
    near(shortcutBoxes[0].height, shortcutBoxes[1].height, "专题/标签等高");
    if (mobile) {
      const rankShortcut = await rect(category.getByRole("button").filter({ has: page.getByText("排行榜", { exact: true }) }));
      near(rankShortcut.left, contentBox.left, "排行榜入口左边界"); near(rankShortcut.right, contentBox.right, "排行榜入口右边界");
    }
    report.measurements.push({ width, page: "category", contentBox, linksBox, titleBox, posterBox, channelBox });
    await shot("category"); check("category title, shortcuts, channel icon and cover share page gutters; shortcut columns align");

    await shortcuts.getByRole("button").filter({ hasText: "专题" }).click();
    const topic = page.getByRole("button").filter({ has: page.getByText("本周精选", { exact: true }) });
    await topic.waitFor();
    const topicBox = await rect(topic), backBox = await rect(page.getByRole("button", { name: "返回", exact: true }));
    near(backBox.left, topicBox.left, `${width} 专题返回按钮与内容左边界`);
    await shot("topics"); check("discovery toolbar and topic cards share page gutters");
    await page.keyboard.press("Escape"); await shortcuts.waitFor();

    await nav().getByRole("button", { name: "搜索", exact: true }).click();
    const input = page.getByRole("textbox", { name: "搜索短剧、帖子、题材…", exact: true });
    const searchPage = page.locator(".ios-page").filter({ has: input });
    const form = searchPage.locator(".ios-search-form");
    const rankButton = searchPage.getByRole("button", { name: "排行榜", exact: true });
    const hot = searchPage.getByRole("region", { name: "热搜榜", exact: true });
    await hot.waitFor();
    for (const query of ["", "城市与晚风"]) {
      await input.fill(query);
      const f = await rect(form), b = await rect(rankButton), h = await rect(hot);
      near(f.left, h.left, `${width} 搜索框左边界`); near(b.right, h.right, `${width} 搜索快捷按钮右边界 query=${query}`);
      near(f.top, b.top, "搜索控件顶边"); near(f.height, b.height, "搜索控件等高"); assert(!overlap(f, b), "Search form and shortcut must not overlap");
      report.measurements.push({ width, page: "search", query, form: f, shortcut: b, results: h });
    }
    await shot("search"); check("search form and shortcut fit aligned content edges with and without clear button");
    await rankButton.click();
    const segment = page.getByRole("group", { name: "榜单类型", exact: true });
    await page.locator(".ios-rank-row").first().waitFor();
    const segmentBox = await rect(segment), rowBox = await rect(page.locator(".ios-rank-row").first());
    near(segmentBox.left, rowBox.left, `${width} 榜单切换条左边界`); near(segmentBox.right, rowBox.right, `${width} 榜单切换条右边界`);
    const rankHeading = await rect(page.getByRole("heading", { name: "HGhubX 热榜", exact: true }));
    const refreshBox = await rect(page.getByRole("button", { name: "刷新榜单", exact: true }));
    assert(!overlap(rankHeading, refreshBox), "Rank title and refresh button must not overlap");
    for (const name of ["热播榜", "推荐榜", "潜力榜"]) {
      const button = segment.getByRole("button", { name, exact: true });
      await button.click();
      await page.waitForFunction(name => {
        const items = [...document.querySelectorAll('[aria-label="榜单类型"] .ios-button')];
        return items.find(item => item.textContent.trim() === name)?.getAttribute("aria-pressed") === "true";
      }, name);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const selected = await rect(button), indicator = await rect(segment.locator(".ios-segmented-indicator"));
      for (const edge of ["left", "top", "width", "height"]) near(selected[edge], indicator[edge], `${width} ${name} indicator ${edge}`);
    }
    report.measurements.push({ width, page: "ranks", segmentBox, rowBox, rankHeading, refreshBox });
    await shot("ranks"); check("rank selector aligns with cards, every indicator aligns, heading clears refresh");
    await page.keyboard.press("Escape"); await input.waitFor(); await input.press("Enter");
    await page.getByRole("button", { name: titles[0], exact: true }).click();
    await page.getByRole("button", { name: "不感兴趣", exact: true }).waitFor();
    if (mobile) {
      const position = await rect(page.locator(".feed-position-pill").first());
      const mute = await rect(page.getByRole("button", { name: /^(静音|取消静音)$/ }).first());
      assert(!overlap(position, mute), "Playback index and mute must not overlap");
      for (const name of ["不感兴趣", "返回"]) {
        const target = page.getByRole("button", { name, exact: true }).filter({ visible: true });
        const r = await rect(target.first());
        assert(r.width >= 44 && r.height >= 44, `${name} has a 44px touch target`);
      }
    }
    await shot("player"); check("playback position, mute, and preference action stay separated with mobile touch targets");
    await page.keyboard.press("Escape");

    await nav().getByRole("button", { name: "我的", exact: true }).click();
    const profileGroup = page.getByRole("group", { name: "我的内容", exact: true });
    await page.getByRole("button", { name: titles[0], exact: true }).waitFor();
    const account = await rect(page.locator(".ios-account-card").filter({ hasText: "未登录" }));
    const before = await rect(profileGroup);
    const grid = await rect(page.locator(".ios-page").filter({ has: page.getByRole("heading", { name: "我的", exact: true }) }).locator(".ios-media-grid"));
    near(account.left, before.left, "个人页账户/切换条左对齐"); near(account.right, before.right, "个人页账户/切换条右对齐");
    near(grid.left, before.left, "个人页封面网格左对齐"); near(grid.right, before.right, "个人页封面网格右对齐");
    await profileGroup.getByRole("button", { name: "观看历史", exact: true }).click();
    await page.getByText("第 3 集 · 0:55", { exact: true }).waitFor();
    const after = await rect(profileGroup); for (const edge of ["left", "top", "width", "height"]) near(after[edge], before[edge], `收藏/历史切换不移动 ${edge}`);
    await shot("profile"); check("profile account, selector and cover grid align; switching to history preserves geometry");
    await context.close();
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = String(error.stack || error);
  await page?.screenshot({ path: fileURLToPath(new URL("failure.png", output)), animations: "disabled" }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close(); await server?.close();
  await writeFile(new URL("report.json", output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); console.log(fileURLToPath(output));
}
