import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
const root = fileURLToPath(new URL("../", import.meta.url));
const output = fileURLToPath(new URL(`../test-results/account-recovery/${new Date().toISOString().replace(/[:.]/g, "-")}/`, import.meta.url));
const group = process.argv[2] || "profile";
const report = { environment: "Real React pages + AppProvider in Chromium; controlled Tauri IPC; not a native-device or upstream test", group, passed: [], failed: [], errors: [] };
await mkdir(output, { recursive: true });
let vite, browser;
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { allow: [root, fileURLToPath(new URL("../../HGhubX", import.meta.url))] } } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const test = async (name, scenario, body, viewport = { width: 375, height: 812 }) => {
    const page = await browser.newPage({ viewport, reducedMotion: "reduce", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" });
    page.setDefaultTimeout(4000);
    page.on("pageerror", error => report.errors.push(`${name}: ${error.message}`));
    await page.route("**/*", route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort());
    try {
      await page.goto(`${origin}tests/account-recovery.html?scenario=${scenario}`);
      await page.waitForFunction(() => window.accountRecoveryFixture?.state.history);
      await body(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      assert(!overflow, "No horizontal document overflow");
      await page.screenshot({ path: `${output}/${name}.png`, animations: "disabled" });
      report.passed.push(name);
    } catch (e) {
      report.failed.push({ name, error: String(e.message) });
      await page.screenshot({ path: `${output}/${name}-failure.png` }).catch(() => {});
    } finally { await page.close(); }
  };
  if (group === "profile") {
    await test("failed-records-retry", "profile-error", async p => {
      await p.getByText("收藏加载失败", { exact: true }).waitFor();
      assert.equal(await p.getByText("还没有收藏", { exact: true }).count(), 0);
      await p.evaluate(() => window.accountRecoveryFixture.faults.clear());
      await p.getByRole("button", { name: "重试", exact: true }).click();
      await p.waitForFunction(() => document.querySelectorAll(".ios-poster").length === 3);
    });
    await test("partial-records-retry", "profile-partial", async p => {
      await p.getByText("1 项内容加载失败，已加载内容仍可浏览。", { exact: true }).waitFor();
      assert.equal(await p.locator(".ios-poster").count(), 2);
      await p.evaluate(() => window.accountRecoveryFixture.faults.clear());
      await p.getByRole("button", { name: "重试失败内容" }).click();
      await p.waitForFunction(() => document.querySelectorAll(".ios-poster").length === 3);
      const ids = await p.evaluate(() => window.accountRecoveryFixture.calls.filter(c => c.cmd === "api_video").map(c => c.args.id));
      assert.deepEqual(ids, [1, 2, 3, 2], "Retry only failed IDs");
    });
    await test("records-load-more", "profile-many", async p => {
      await p.waitForFunction(() => document.querySelectorAll(".ios-poster").length === 12);
      await p.getByRole("button", { name: "加载更多" }).click();
      await p.waitForFunction(() => document.querySelectorAll(".ios-poster").length === 17);
      const count = await p.evaluate(() => window.accountRecoveryFixture.calls.filter(c => c.cmd === "api_video").length);
      assert.equal(count, 17, "Do not refetch the successful first page");
    }, { width: 1100, height: 900 });
    await test("clear-pending-history", "profile-pending", async p => {
      await p.getByRole("button", { name: "观看历史", exact: true }).click();
      await p.getByRole("button", { name: "清空观看历史" }).click();
      await p.getByText("还没有观看记录", { exact: true }).waitFor();
      assert.equal(await p.getByRole("status", { name: "加载中", exact: true }).count(), 0);
      await p.evaluate(() => window.accountRecoveryFixture.settle("api_video"));
      assert.equal(await p.locator(".ios-poster").count(), 0);
    });
    await test("logout-confirm-retry", "profile-logout", async p => {
      await p.getByRole("button", { name: "退出登录", exact: true }).click();
      const modal = p.getByRole("dialog", { name: "退出登录", exact: true });
      await modal.waitFor();
      assert.equal(await p.evaluate(() => window.accountRecoveryFixture.calls.filter(c => c.cmd === "api_logout").length), 0);
      await p.evaluate(() => window.accountRecoveryFixture.faults.add("api_logout"));
      await modal.getByRole("button", { name: "确认退出", exact: true }).click();
      await modal.getByRole("alert").waitFor();
      assert(await p.evaluate(() => !!window.accountRecoveryFixture.state.user), "Failed logout retains account");
      await p.evaluate(() => { window.accountRecoveryFixture.faults.clear(); window.accountRecoveryFixture.held.add("api_logout"); });
      await modal.getByRole("button", { name: "确认退出", exact: true }).click();
      assert(await modal.getByRole("button", { name: "正在退出…", exact: true }).isDisabled());
      await p.evaluate(() => window.accountRecoveryFixture.settle("api_logout"));
      await modal.waitFor({ state: "hidden" });
      await p.getByText("未登录", { exact: true }).waitFor();
    });
  }
  assert.deepEqual(report.errors, [], "No browser errors");
  if (report.failed.length) process.exitCode = 1;
} catch (e) { report.failed.push({ name: "harness", error: String(e.stack || e) }); process.exitCode = 1; }
finally {
  await browser?.close(); await vite?.close();
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); console.log(`Artifacts: ${output}`);
}
