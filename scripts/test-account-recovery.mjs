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
  const test = async (name, scenario, body, viewport = { width: 375, height: 812 }, userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148") => {
    const page = await browser.newPage({ viewport, reducedMotion: "reduce", userAgent });
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
  if (group === "user") {
    await test("following-auth-gate", "following-guest", async p => {
      await p.getByText("登录后查看关注流", { exact: true }).waitFor();
      await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await p.evaluate(() => window.accountRecoveryFixture.calls.filter(c => c.cmd === "api_following").length), 0, "Guest must not fetch the authenticated feed");
      await p.evaluate(() => window.accountRecoveryFixture.login());
      await p.waitForFunction(() => document.querySelectorAll(".ios-poster").length === 20);
      await p.getByText("已加载 20 / 40 部", { exact: true }).waitFor();
    });
    await test("following-pagination-retry", "following-paging", async p => {
      await p.waitForFunction(() => document.querySelectorAll(".ios-poster").length === 20);
      await p.evaluate(() => window.accountRecoveryFixture.faults.add("api_following"));
      await p.locator(".scroll-y").first().evaluate(el => { el.scrollTop = el.scrollHeight; });
      await p.getByText("加载更多失败", { exact: true }).waitFor();
      assert.equal(await p.locator(".ios-poster").count(), 20);
      await p.evaluate(() => window.accountRecoveryFixture.faults.clear());
      await p.getByRole("button", { name: "重试", exact: true }).click();
      await p.waitForFunction(() => document.querySelectorAll(".ios-poster").length === 40);
      await p.getByText("已加载 40 / 40 部", { exact: true }).waitFor();
    });
    await test("user-info-retry", "user-errors", async p => {
      await p.getByText("资料信息未完整加载", { exact: true }).waitFor();
      assert.equal(await p.locator(".ios-poster").count(), 20);
      await p.evaluate(() => window.accountRecoveryFixture.faults.clear());
      await p.getByRole("button", { name: "重试资料", exact: true }).click();
      await p.getByRole("heading", { name: "作者 7", exact: true }).waitFor();
      await p.getByRole("button", { name: "+ 关注", exact: true }).waitFor();
      assert.equal(await p.getByText("资料信息未完整加载", { exact: true }).count(), 0);
      await p.getByText("作者简介", { exact: true }).click();
    });
    await test("follow-confirmed-state", "user-follow", async p => {
      await p.getByRole("button", { name: "+ 关注", exact: true }).waitFor();
      await p.evaluate(() => window.accountRecoveryFixture.held.add("api_follow"));
      await p.getByRole("button", { name: "+ 关注", exact: true }).evaluate(el => { el.click(); el.click(); });
      assert.equal(await p.evaluate(() => window.accountRecoveryFixture.calls.filter(c => c.cmd === "api_follow").length), 1);
      assert.deepEqual(await p.evaluate(() => window.accountRecoveryFixture.state.follows), [], "Do not persist unconfirmed follow");
      assert(await p.getByRole("button", { name: "处理中…", exact: true }).isDisabled());
      await p.evaluate(() => window.accountRecoveryFixture.settle("api_follow", false));
      await p.getByRole("button", { name: "+ 关注", exact: true }).waitFor();
      await p.getByRole("button", { name: "+ 关注", exact: true }).click();
      await p.evaluate(() => window.accountRecoveryFixture.settle("api_follow"));
      await p.getByRole("button", { name: "已关注", exact: true }).waitFor();
      assert.deepEqual(await p.evaluate(() => window.accountRecoveryFixture.state.follows), [7]);
      const args = await p.evaluate(() => window.accountRecoveryFixture.calls.filter(c => c.cmd === "api_follow").map(c => c.args.on));
      assert.deepEqual(args, [true, true]);
    });
    await test("user-stale-response", "user-follow", async p => {
      await p.getByRole("button", { name: "+ 关注", exact: true }).waitFor();
      await p.evaluate(() => { window.accountRecoveryFixture.held.add("api_follow"); });
      await p.getByRole("button", { name: "+ 关注", exact: true }).click();
      await p.evaluate(() => { window.accountRecoveryFixture.navigate("user", 8); });
      await p.getByRole("heading", { name: "作者 8", exact: true }).waitFor();
      await p.evaluate(() => window.accountRecoveryFixture.settle("api_follow"));
      assert.deepEqual(await p.evaluate(() => window.accountRecoveryFixture.state.follows), [], "Late request must not mutate a new user page");
    });
    await test("user-unmounted-response", "user-follow", async p => {
      await p.getByRole("button", { name: "+ 关注", exact: true }).waitFor();
      await p.evaluate(() => window.accountRecoveryFixture.held.add("api_follow"));
      await p.getByRole("button", { name: "+ 关注", exact: true }).click();
      await p.getByRole("button", { name: "返回", exact: true }).click();
      await p.getByRole("heading", { name: "我的", exact: true }).waitFor();
      await p.evaluate(() => window.accountRecoveryFixture.settle("api_follow"));
      assert.deepEqual(await p.evaluate(() => window.accountRecoveryFixture.state.follows), [], "An unmounted page must not persist a late follow response");
    });
    await test("user-responsive-dark", "user-follow&theme=dark", async p => {
      await p.getByRole("heading", { name: "作者 7", exact: true }).waitFor();
      const button = await p.getByRole("button", { name: "+ 关注", exact: true }).boundingBox();
      assert(button && button.x >= 0 && button.x + button.width <= 320, "Follow action stays inside narrow page");
    }, { width: 320, height: 694 });
  }
  if (group === "login") {
    const open = async p => {
      await p.evaluate(() => window.accountRecoveryFixture.openLogin());
      return p.getByRole("dialog", { name: "登录 HGhubX", exact: true });
    };
    const enter = async modal => {
      await modal.getByRole("textbox", { name: "账号", exact: true }).fill("fixture-user");
      await modal.getByLabel("密码", { exact: true }).fill("fixture-password");
    };
    await test("login-double-submit", "login", async p => {
      const modal = await open(p); await enter(modal);
      await p.evaluate(() => window.accountRecoveryFixture.held.add("api_login"));
      await modal.locator("form").evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
      assert.equal(await p.evaluate(() => window.accountRecoveryFixture.calls.filter(c => c.cmd === "api_login").length), 1, "Synchronous submits send one login request");
      await p.evaluate(() => window.accountRecoveryFixture.settle("api_login"));
      await modal.waitFor({ state: "hidden" });
      assert(await p.evaluate(() => !!window.accountRecoveryFixture.state.user));
    });
    await test("login-busy-mode-close-guard", "login", async p => {
      const modal = await open(p); await enter(modal);
      await p.evaluate(() => window.accountRecoveryFixture.held.add("api_login"));
      await modal.locator("button[type=submit]").click();
      assert(await modal.getByRole("button", { name: "注册", exact: true }).isDisabled(), "Do not switch request type while signing in");
      assert(await modal.getByRole("button", { name: "关闭登录", exact: true }).isDisabled(), "Busy close is visibly disabled");
      assert.equal(await modal.getByLabel("账号", { exact: true }).getAttribute("readonly"), "");
      await p.keyboard.press("Escape");
      await modal.waitFor();
      await p.evaluate(() => window.accountRecoveryFixture.settle("api_login", false));
      await modal.getByRole("alert").waitFor();
      assert.equal(await modal.getByLabel("账号", { exact: true }).inputValue(), "fixture-user");
      assert.equal(await modal.getByLabel("密码", { exact: true }).inputValue(), "fixture-password");
      await modal.locator("button[type=submit]").click();
      await p.evaluate(() => window.accountRecoveryFixture.settle("api_login"));
      await modal.waitFor({ state: "hidden" });
    });
    await test("login-password-visibility-close", "login&theme=dark", async p => {
      let modal = await open(p); await enter(modal);
      await modal.getByRole("button", { name: "显示密码", exact: true }).click();
      assert.equal(await modal.getByLabel("密码", { exact: true }).getAttribute("type"), "text");
      const toggle = modal.getByRole("button", { name: "隐藏密码", exact: true });
      assert.equal(await toggle.getAttribute("aria-pressed"), "true");
      const box = await toggle.boundingBox(); assert(box && box.width >= 44 && box.height >= 44, "Password toggle is touch-sized");
      await modal.getByRole("button", { name: "关闭登录", exact: true }).click();
      await modal.waitFor({ state: "hidden" });
      modal = await open(p);
      assert.equal(await modal.getByLabel("密码", { exact: true }).inputValue(), "", "Dismissed password is cleared");
      assert.equal(await modal.getByLabel("密码", { exact: true }).getAttribute("type"), "password");
    }, { width: 320, height: 694 });
    await test("login-register-desktop", "login", async p => {
      let modal = await open(p);
      await modal.getByRole("button", { name: "注册", exact: true }).click();
      modal = p.getByRole("dialog", { name: "注册 HGhubX", exact: true });
      await enter(modal);
      await modal.getByRole("textbox", { name: "邮箱", exact: true }).fill("fixture@example.invalid");
      await modal.getByRole("button", { name: "显示密码", exact: true }).click();
      await p.screenshot({ path: `${output}/login-register-desktop-form.png`, animations: "disabled" });
      await modal.getByRole("button", { name: "创建账号", exact: true }).click();
      await modal.waitFor({ state: "hidden" });
      const request = await p.evaluate(() => window.accountRecoveryFixture.calls.find(c => c.cmd === "api_register"));
      assert.deepEqual(request?.args, { username: "fixture-user", password: "fixture-password", email: "fixture@example.invalid" });
    }, { width: 1100, height: 850 }, "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36");
    await test("login-landscape-layout", "login", async p => {
      const modal = await open(p); await enter(modal);
      await modal.getByRole("button", { name: "显示密码", exact: true }).scrollIntoViewIfNeeded();
      const toggle = await modal.getByRole("button", { name: "显示密码", exact: true }).boundingBox();
      assert(toggle && toggle.y >= 0 && toggle.y + toggle.height <= 375, "Password control remains reachable in landscape");
      await modal.locator("button[type=submit]").scrollIntoViewIfNeeded();
      const submit = await modal.locator("button[type=submit]").boundingBox();
      assert(submit && submit.y >= 0 && submit.y + submit.height <= 375, "Submit remains reachable in landscape");
    }, { width: 812, height: 375 });
  }
  assert.deepEqual(report.errors, [], "No browser errors");
  if (report.failed.length) process.exitCode = 1;
} catch (e) { report.failed.push({ name: "harness", error: String(e.stack || e) }); process.exitCode = 1; }
finally {
  await browser?.close(); await vite?.close();
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); console.log(`Artifacts: ${output}`);
}
