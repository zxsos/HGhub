/** Account state regressions: real provider/components, isolated neutral IPC; no live account writes. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = fileURLToPath(new URL(`../test-results/account-sync/${Date.now()}/`, import.meta.url));
await mkdir(output, { recursive: true });
const report = { environment: "Real AppProvider/Profile/Feed in StrictMode Chromium; neutral deferred Tauri IPC, all external traffic blocked; no live account writes or native-device claim", passed: [], failed: [], errors: [] };
let server, browser;
const state = p => p.evaluate(() => window.accountSyncFixture.state);
const calls = (p, cmd) => p.evaluate(cmd => window.accountSyncFixture.calls.filter(call => call.cmd === cmd), cmd);
const idle = p => p.waitForFunction(() => window.accountSyncFixture.state.sync && !window.accountSyncFixture.state.sync.busy);
const login = async (p, id, origin) => {
  const before = (await calls(p, "api_me")).length;
  await p.evaluate(({ id, origin }) => window.accountSyncFixture.login(id, origin), { id, origin });
  await p.waitForFunction(({ id, before }) => window.accountSyncFixture.state.user?.id === id && window.accountSyncFixture.calls.filter(call => call.cmd === "api_me").length > before, { id, before });
  await idle(p);
};
const run = async (p, label, method, args = []) => {
  await p.evaluate(({ label, method, args }) => window.accountSyncFixture.run(label, method, args), { label, method, args });
  await p.waitForFunction(label => window.accountSyncFixture.outcomes[label]?.status !== "pending", label);
  return p.evaluate(label => window.accountSyncFixture.outcomes[label], label);
};
const hold = (p, command) => p.evaluate(cmd => window.accountSyncFixture.held.add(cmd), command);
const release = (p, cmd, ok = true, id) => p.evaluate(({ cmd, ok, id }) => { window.accountSyncFixture.held.delete(cmd); window.accountSyncFixture.settle(cmd, ok, id); }, { cmd, ok, id });
const waitPending = (p, cmd) => p.waitForFunction(cmd => window.accountSyncFixture.pending().some(item => item.cmd === cmd), cmd);
const turns = p => p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
try {
  server = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const test = async (name, body, query = "", desktop = false) => {
    if (process.env.ACCOUNT_SYNC_CASE && name !== process.env.ACCOUNT_SYNC_CASE) return;
    const context = await browser.newContext({ viewport: desktop ? { width: 1280, height: 900 } : { width: 375, height: 812 }, reducedMotion: "reduce",
      ...(desktop ? {} : { isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" }) });
    const page = await context.newPage();
    page.setDefaultTimeout(6500);
    page.on("pageerror", error => report.errors.push(`${name}: ${error.message}`));
    await page.route("**/*", route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort());
    try {
      await page.goto(`${origin}tests/account-sync.html?${query}`);
      await page.waitForFunction(() => window.accountSyncFixture?.ready);
      assert.equal(typeof (await state(page)).scope, "string", "Account scope API exists before sync");
      if (query.includes("boot=a") && !query.includes("holdBoot"))
        await page.waitForFunction(() => window.accountSyncFixture.state.user?.id === 11 && window.accountSyncFixture.state.sync?.lastSynced > 0);
      if (!query.includes("holdBoot")) await idle(page);
      await body(page);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "No horizontal overflow");
      await page.screenshot({ path: `${output}/${name}.png`, animations: "disabled" });
      report.passed.push(name);
      console.log(`PASS ${name}`);
    } catch (error) {
      report.failed.push({ name, error: String(error.stack || error) });
      console.error(`FAIL ${name}: ${error.message}`);
      await page.screenshot({ path: `${output}/${name}-failure.png`, animations: "disabled" }).catch(() => {});
    } finally { await context.close(); }
  };

  await test("boot-hydrates-account-and-all-history-pages", async p => {
    const s = await state(p);
    assert.equal(s.user.id, 11);
    assert.deepEqual(s.favs, [101, 102]);
    assert.deepEqual(s.follows, [701]);
    assert.deepEqual(s.history.map(row => row.id).sort(), [201, 202, 203]);
    assert.equal(s.history.find(row => row.id === 201).ep, 2);
    assert((await calls(p, "api_account_history")).some(call => call.args.page === 2), "Fetch complete history pagination");
    await p.getByRole("button", { name: "测试作品 101", exact: true }).waitFor();
    assert.equal(await p.getByRole("button", { name: "测试作品 901", exact: true }).count(), 0, "Guest favorite must not leak into logged account");
    assert((await calls(p, "api_me")).every(call => call.args.expectedUserId === 11 && call.args.expectedOrigin === "https://account-fixture.invalid"));
  }, "boot=a");

  await test("login-dialog-fetches-remote-account", async p => {
    await p.getByRole("button", { name: /未登录/ }).click();
    const dialog = p.getByRole("dialog", { name: "登录 HGhubX", exact: true });
    await dialog.getByRole("textbox", { name: "账号", exact: true }).fill("fixture");
    await dialog.getByLabel("密码", { exact: true }).fill("fixture-password");
    await dialog.getByRole("button", { name: "登录", exact: true }).last().click();
    await p.waitForFunction(() => window.accountSyncFixture.state.favs.includes(101));
    await idle(p);
    assert.equal((await state(p)).user.id, 11);
    assert((await calls(p, "api_me")).length > 0);
  });

  for (const mode of ["login", "register"]) await test(`late-${mode}-delivery-cannot-replace-line-account`, async p => {
    const command = mode === "login" ? "api_login" : "api_register";
    await hold(p, command);
    await p.getByRole("button", { name: /未登录/ }).click();
    const dialog = p.getByRole("dialog", { name: /HGhubX/ });
    if (mode === "register") await dialog.getByRole("button", { name: "注册", exact: true }).click();
    await dialog.getByRole("textbox", { name: "账号", exact: true }).fill("fixture");
    await dialog.getByLabel("密码", { exact: true }).fill("fixture-password");
    await dialog.getByRole("button", { name: mode === "login" ? "登录" : "创建账号", exact: true }).last().click();
    await waitPending(p, command);
    await p.evaluate(() => window.accountSyncFixture.changeLine(22, window.accountSyncFixture.originB));
    await p.waitForFunction(() => window.accountSyncFixture.state.user?.id === 22 && window.accountSyncFixture.state.sync.lastSynced > 0);
    const scope = (await state(p)).scope;
    await release(p, command);
    await dialog.getByRole("alert").filter({ hasText: "账号或线路已变化" }).waitFor();
    assert.equal((await state(p)).scope, scope);
    assert.equal((await state(p)).user.id, 22);
    assert.deepEqual((await state(p)).favs, [301]);
    assert.equal(await p.getByText(/欢迎回来|注册成功/).count(), 0);
  });

  await test("guest-account-and-origin-isolation", async p => {
    assert.deepEqual((await state(p)).favs, [901]);
    await login(p, 11); assert.deepEqual((await state(p)).favs, [101, 102]);
    await p.evaluate(() => window.accountSyncFixture.addHistory(211, 2, 1, 120));
    await turns(p);
    await login(p, 22); assert.deepEqual((await state(p)).favs, [301]);
    assert(!(await state(p)).history.some(row => row.id === 211));
    await login(p, 11, "https://second-fixture.invalid");
    assert(!(await state(p)).history.some(row => row.id === 211), "Same numeric user on another origin has another local bucket");
    await login(p, 11);
    assert((await state(p)).history.some(row => row.id === 211), "Returning to account restores its local progress");
    await p.evaluate(() => window.accountSyncFixture.guest()); await turns(p);
    assert.deepEqual((await state(p)).favs, [901]);
    assert.equal((await state(p)).history.find(row => row.id === 904).t, 17);
    const guest = await p.evaluate(() => JSON.parse(localStorage.getItem("hghubx_app_v1")));
    assert.deepEqual(guest.favs, [901], "Cloud hydration never overwrites guest storage");
  });

  await test("empty-arrays-clear-missing-fields-retain", async p => {
    await p.evaluate(() => { window.accountSyncFixture.accounts[11].interactions = { favorite_video_ids: [] }; });
    assert.equal((await run(p, "empty", "syncAccount")).status, "fulfilled");
    assert.deepEqual((await state(p)).favs, []);
    assert.deepEqual((await state(p)).follows, [701]);
    assert.deepEqual((await state(p)).likes, [101]);
  }, "boot=a");

  await test("guest-local-actions-never-upload-account-data", async p => {
    assert.equal((await run(p, "local-add", "setCollected", ["video", 905, true])).status, "fulfilled");
    assert((await state(p)).favs.includes(905));
    assert.equal((await calls(p, "api_collect")).length, 0);
    await p.evaluate(() => window.accountSyncFixture.addHistory(906, 1, 10, 100)); await turns(p);
    assert.equal((await calls(p, "api_account_history_record")).length, 0);
    await login(p, 11);
    assert(!(await state(p)).favs.includes(905));
    assert(!(await state(p)).history.some(row => row.id === 906));
    await p.evaluate(() => window.accountSyncFixture.guest()); await turns(p);
    assert((await state(p)).favs.includes(905));
    assert((await state(p)).history.some(row => row.id === 906));
  });

  await test("late-boot-cannot-revive-or-replace-account", async p => {
    await waitPending(p, "app_boot");
    await login(p, 22);
    await release(p, "app_boot"); await turns(p);
    assert.equal((await state(p)).user.id, 22);
    assert.deepEqual((await state(p)).favs, [301]);
    await p.evaluate(() => window.accountSyncFixture.guest()); await turns(p);
    assert.equal((await state(p)).user, null);
  }, "boot=a&holdBoot=1");

  await test("late-boot-after-logout-stays-guest", async p => {
    await waitPending(p, "app_boot");
    await login(p, 22);
    assert.equal((await run(p, "logout", "logout")).status, "fulfilled");
    await release(p, "app_boot"); await turns(p);
    assert.equal((await state(p)).user, null);
    assert.deepEqual((await state(p)).favs, [901]);
  }, "boot=a&holdBoot=1");

  await test("confirmed-actions-deduplicate-and-send-explicit-state", async p => {
    await hold(p, "api_collect");
    await p.evaluate(() => { const f = window.accountSyncFixture; f.run("one", "setCollected", ["video", 101, false]); f.run("two", "setCollected", ["video", 101, false]); });
    await waitPending(p, "api_collect");
    assert.equal((await calls(p, "api_collect")).length, 1);
    assert((await state(p)).favs.includes(101), "Pending mutation leaves confirmed favorite unchanged");
    assert.equal((await state(p)).pendingCollect, true);
    await release(p, "api_collect", false);
    await p.waitForFunction(() => window.accountSyncFixture.outcomes.one.status === "rejected");
    assert((await state(p)).favs.includes(101));
    assert.equal((await run(p, "retry", "setCollected", ["video", 101, false])).status, "fulfilled");
    assert(!(await state(p)).favs.includes(101));
    assert.equal((await run(p, "add", "setCollected", ["video", 101, true])).status, "fulfilled");
    const requests = await calls(p, "api_collect");
    assert.deepEqual(requests.map(call => call.args.on), [false, false, true]);
    assert(requests.every(call => call.args.expectedUserId === 11 && call.args.expectedOrigin === "https://account-fixture.invalid"));
  }, "boot=a", true);

  await test("late-sync-does-not-overwrite-confirmed-action", async p => {
    await hold(p, "api_me");
    await p.evaluate(() => window.accountSyncFixture.run("refresh", "syncAccount"));
    await waitPending(p, "api_me");
    assert.equal((await run(p, "remove", "setCollected", ["video", 101, false])).status, "fulfilled");
    await release(p, "api_me");
    await p.waitForFunction(() => window.accountSyncFixture.outcomes.refresh.status !== "pending");
    assert(!(await state(p)).favs.includes(101));
  }, "boot=a");

  await test("late-action-a-b-a-requires-new-generation", async p => {
    const oldScope = (await state(p)).scope;
    await hold(p, "api_collect");
    await p.evaluate(() => window.accountSyncFixture.run("old", "setCollected", ["video", 101, false]));
    await waitPending(p, "api_collect");
    await login(p, 22); await login(p, 11);
    assert.notEqual((await state(p)).scope, oldScope);
    await release(p, "api_collect"); await turns(p);
    assert((await state(p)).favs.includes(101), "Old generation action must not mutate re-entered account snapshot");
  }, "boot=a");

  await test("late-sync-does-not-leak-a-into-b", async p => {
    await hold(p, "api_me");
    await p.evaluate(() => window.accountSyncFixture.run("old", "syncAccount"));
    await waitPending(p, "api_me");
    await p.evaluate(() => { window.accountSyncFixture.held.delete("api_me"); window.accountSyncFixture.login(22); });
    await idle(p);
    await release(p, "api_me", true, 11); await turns(p);
    assert.equal((await state(p)).user.id, 22);
    assert.deepEqual((await state(p)).favs, [301]);
  }, "boot=a");

  await test("line-switch-invalidates-old-account-work", async p => {
    await hold(p, "api_collect");
    await p.evaluate(() => window.accountSyncFixture.run("old", "setCollected", ["video", 101, false]));
    await waitPending(p, "api_collect");
    await p.evaluate(() => window.accountSyncFixture.changeLine(22, window.accountSyncFixture.originB));
    await p.waitForFunction(() => window.accountSyncFixture.state.user?.id === 22 && window.accountSyncFixture.state.sync.lastSynced > 0);
    await release(p, "api_collect"); await turns(p);
    assert.deepEqual((await state(p)).favs, [301]);
    const requests = await calls(p, "api_me");
    assert(requests.some(call => call.args.expectedUserId === 22 && call.args.expectedOrigin === "https://second-fixture.invalid"));
  }, "boot=a");

  await test("post-video-ids-and-episode-likes-remain-independent", async p => {
    assert.equal(await p.evaluate(() => window.accountSyncFixture.inspect(101, 1).videoLike), false);
    assert.equal(await p.evaluate(() => window.accountSyncFixture.inspect(101, 2).videoLike), true);
    await run(p, "post-remove", "setCollected", ["post", 101, false]);
    assert.deepEqual(await p.evaluate(() => window.accountSyncFixture.inspect(101, 2)), { videoFav: true, postFav: false, videoLike: true, postLike: false });
    await run(p, "episode-one", "setLiked", ["video", 101, 1, true]);
    await run(p, "episode-two", "setLiked", ["video", 101, 2, false]);
    assert.equal(await p.evaluate(() => window.accountSyncFixture.inspect(101, 1).videoLike), true);
    assert.equal(await p.evaluate(() => window.accountSyncFixture.inspect(101, 2).videoLike), false);
    assert.deepEqual((await calls(p, "api_like")).map(call => [call.args.ep, call.args.on]), [[1, true], [2, false]]);
  }, "boot=a");

  await test("history-seconds-stay-local-and-cloud-writes-are-bounded", async p => {
    await p.evaluate(() => window.accountSyncFixture.addHistory(501, 2, 1, 100)); await turns(p);
    assert.equal((await calls(p, "api_account_history_record")).length, 0, "Under three seconds must not upload a watch");
    await p.evaluate(() => { window.accountSyncFixture.addHistory(501, 2, 8, 100); window.accountSyncFixture.addHistory(501, 2, 14, 100); });
    await p.waitForFunction(() => window.accountSyncFixture.calls.some(call => call.cmd === "api_account_history_record"));
    await turns(p);
    const requests = await calls(p, "api_account_history_record");
    assert.equal(requests.length, 1, "Repeated ticks do not upload every position");
    assert.equal(requests[0].args.videoId, 501); assert.equal(requests[0].args.ep, 2);
    assert(!("t" in requests[0].args) && !("dur" in requests[0].args), "Do not invent server second-level progress support");
    await run(p, "refresh", "syncAccount");
    const row = (await state(p)).history.find(row => row.id === 501);
    assert.equal(row.t, 14); assert.equal(row.dur, 100);
    await p.evaluate(() => window.accountSyncFixture.captureHistory()); await login(p, 22);
    await p.evaluate(() => window.accountSyncFixture.savedHistory(599)); await turns(p);
    assert(!(await state(p)).history.some(row => row.id === 599), "Old player's history callback cannot write into new account");
  }, "boot=a");

  await test("failed-history-upload-survives-for-retry", async p => {
    await p.evaluate(() => { const f = window.accountSyncFixture; f.faults.add("api_account_history_record"); f.addHistory(502, 3, 12, 100); });
    await p.waitForFunction(() => window.accountSyncFixture.calls.some(call => call.cmd === "api_account_history_record")); await turns(p);
    assert((await state(p)).history.some(row => row.id === 502));
    await p.evaluate(() => window.accountSyncFixture.faults.delete("api_account_history_record"));
    await run(p, "retry", "syncAccount");
    assert.equal((await calls(p, "api_account_history_record")).filter(call => call.args.videoId === 502).length, 2);
    assert.equal(await p.evaluate(() => window.accountSyncFixture.accounts[11].history.some(row => row.video_id === 502)), true);
  }, "boot=a");

  await test("clear-history-uses-cloud-row-ids-and-keeps-failed-data", async p => {
    await p.evaluate(() => window.accountSyncFixture.faults.add("api_account_history_delete"));
    assert.equal((await run(p, "fail", "clearHistory")).status, "rejected");
    assert.equal((await state(p)).history.length, 3);
    const failedRequest = (await calls(p, "api_account_history_delete"))[0];
    assert.deepEqual([...failedRequest.args.ids].sort(), [9001, 9002, 9003], "Delete historical row IDs, never video IDs");
    await p.evaluate(() => window.accountSyncFixture.faults.delete("api_account_history_delete"));
    assert.equal((await run(p, "retry", "clearHistory")).status, "fulfilled");
    assert.deepEqual((await state(p)).history, []);
    assert.equal(await p.evaluate(() => window.accountSyncFixture.accounts[11].history.length), 0);
  }, "boot=a");

  await test("history-pagination-failure-does-not-commit-partial-history", async p => {
    await p.evaluate(() => { const f = window.accountSyncFixture; f.accounts[11].history = [{ id: 9501, video_id: 601, last_ep: 1, updated_at: "2026-11-15T01:00:00Z", target_type: "video" }, ...f.accounts[11].history]; f.faults.add("api_account_history:2"); });
    assert.equal((await run(p, "failed-page", "syncAccount")).status, "rejected");
    assert.deepEqual((await state(p)).history.map(row => row.id).sort(), [201, 202, 203]);
    assert((await state(p)).sync.error);
    await p.evaluate(() => window.accountSyncFixture.faults.clear());
    assert.equal((await run(p, "retry-page", "syncAccount")).status, "fulfilled");
    assert((await state(p)).history.some(row => row.id === 601));
  }, "boot=a");

  await test("profile-clear-history-failure-and-retry-ui", async p => {
    await p.getByRole("button", { name: "观看历史", exact: true }).click();
    await p.getByRole("button", { name: "清空观看历史", exact: true }).waitFor();
    await p.evaluate(() => window.accountSyncFixture.faults.add("api_account_history_delete"));
    await p.getByRole("button", { name: "清空观看历史", exact: true }).click();
    await p.getByRole("alert").waitFor();
    assert.equal((await state(p)).history.length, 3);
    await p.evaluate(() => { window.accountSyncFixture.faults.clear(); window.accountSyncFixture.held.add("api_account_history_delete"); });
    await p.getByRole("button", { name: "清空观看历史", exact: true }).click();
    await waitPending(p, "api_account_history_delete");
    assert(await p.getByRole("button", { name: "正在清空…", exact: true }).isDisabled());
    await release(p, "api_account_history_delete");
    await p.getByText("还没有观看记录", { exact: true }).waitFor();
    assert.deepEqual((await state(p)).history, []);
  }, "boot=a");

  await test("history-cloud-deletion-preserves-only-unsent-local-progress", async p => {
    await p.evaluate(() => {
      const f = window.accountSyncFixture;
      f.addHistory(650, 2, 1, 100);
      f.accounts[11].history = f.accounts[11].history.filter(row => row.video_id !== 201);
    });
    await run(p, "delete-one", "syncAccount");
    assert.deepEqual((await state(p)).history.map(row => row.id).sort(), [202, 203, 650], "Deleted cloud entry must not return from stale local cache");
    await p.evaluate(() => { window.accountSyncFixture.accounts[11].history = []; });
    await run(p, "delete-all", "syncAccount");
    assert.deepEqual((await state(p)).history.map(row => row.id), [650], "Empty cloud history removes previously synced records, retaining new local-only progress");
    assert.equal((await state(p)).history[0].t, 1);
  }, "boot=a");

  await test("empty-filtered-history-page-still-fetches-later-pages", async p => {
    await p.evaluate(() => window.accountSyncFixture.emptyHistoryPages.add(1));
    const before = (await calls(p, "api_account_history")).length;
    assert.equal((await run(p, "empty-page", "syncAccount")).status, "fulfilled");
    const requests = (await calls(p, "api_account_history")).slice(before);
    assert(requests.some(call => call.args.page === 2), "A page containing only excluded post entries is not the last page");
    assert.equal((await state(p)).sync.error, "");
    assert((await state(p)).history.some(row => row.id === 203));
  }, "boot=a");

  await test("late-clear-cannot-erase-another-account-history", async p => {
    await hold(p, "api_account_history_delete");
    await p.evaluate(() => window.accountSyncFixture.run("old-clear", "clearHistory"));
    await waitPending(p, "api_account_history_delete");
    await login(p, 22);
    await release(p, "api_account_history_delete");
    await p.waitForFunction(() => window.accountSyncFixture.outcomes["old-clear"].status !== "pending");
    assert.equal((await state(p)).user.id, 22);
    assert.deepEqual((await state(p)).history.map(row => row.id), [302]);
    assert((await calls(p, "api_account_history_delete")).every(call => call.args.expectedUserId === 11));
  }, "boot=a");

  await test("late-refresh-cannot-resurrect-cleared-history", async p => {
    await hold(p, "api_me");
    const before = (await calls(p, "api_account_history")).length;
    await p.evaluate(() => window.accountSyncFixture.run("old-refresh", "syncAccount"));
    await waitPending(p, "api_me");
    await p.waitForFunction(before => window.accountSyncFixture.calls.filter(call => call.cmd === "api_account_history").length >= before + 2, before);
    assert.equal((await run(p, "clear", "clearHistory")).status, "fulfilled");
    await release(p, "api_me");
    await p.waitForFunction(() => window.accountSyncFixture.outcomes["old-refresh"].status !== "pending");
    assert.deepEqual((await state(p)).history, []);
  }, "boot=a");

  await test("old-playback-callback-cannot-resurrect-cleared-history", async p => {
    await p.evaluate(() => window.accountSyncFixture.captureHistory());
    assert.equal((await run(p, "clear", "clearHistory")).status, "fulfilled");
    const before = (await calls(p, "api_account_history_record")).length;
    await p.evaluate(() => window.accountSyncFixture.savedHistory(801));
    await turns(p);
    assert.deepEqual((await state(p)).history, [], "A pre-clear playback callback cannot restore deleted records");
    await p.waitForTimeout(1650);
    assert.equal((await calls(p, "api_account_history_record")).length, before, "Old playback is not uploaded again");
    await p.evaluate(() => window.accountSyncFixture.addHistory(802, 2, 12, 100));
    await p.waitForFunction(() => window.accountSyncFixture.calls.some(call => call.cmd === "api_account_history_record" && call.args.videoId === 802));
    assert.deepEqual((await state(p)).history.map(row => row.id), [802], "New playback after clear is recorded normally");
  }, "boot=a");

  await test("account-storage-quota-error-remains-visible-until-retry", async p => {
    await p.evaluate(() => window.accountSyncFixture.storageFault(true));
    await run(p, "quota", "syncAccount");
    assert.match((await state(p)).sync.error, /缓存|存储|保存/, "Sync completion must not erase a local cache write failure");
    assert.deepEqual((await state(p)).favs, [101, 102], "In-memory account remains usable");
    await p.getByRole("alert").filter({ hasText: /缓存|存储|保存/ }).waitFor();
    await p.evaluate(() => window.accountSyncFixture.storageFault(false));
    assert.equal((await run(p, "quota-retry", "syncAccount")).status, "fulfilled");
    assert.equal((await state(p)).sync.error, "");
  }, "boot=a");

  await test("offline-boot-prefers-confirmed-cache-over-stale-session-user", async p => {
    assert.equal((await run(p, "remove", "setCollected", ["video", 101, false])).status, "fulfilled");
    await p.evaluate(() => {
      const f = window.accountSyncFixture;
      f.accounts[11].user.interactions = { favorite_video_ids: [101, 102], like_video_ids: [101], follow_user_ids: [701], like_video_episodes: [{ video_id: 101, ep: 2 }] };
      f.faults.add("api_me");
      f.changeLine(11, f.originA);
    });
    await p.waitForFunction(() => window.accountSyncFixture.state.user?.id === 11 && !!window.accountSyncFixture.state.sync.error);
    assert.deepEqual((await state(p)).favs, [102], "Offline session restoration must not revive a confirmed uncollect from stale user.interactions");
  }, "boot=a");

  await test("playback-during-sync-keeps-local-tick-and-rest-of-remote-history", async p => {
    await p.evaluate(() => { const f = window.accountSyncFixture; f.accounts[11].history.push({ id: 9701, video_id: 710, last_ep: 4, updated_at: "2026-11-15T01:00:00Z", target_type: "video" }); f.held.add("api_me"); f.run("refresh", "syncAccount"); });
    await waitPending(p, "api_me");
    await p.evaluate(() => window.accountSyncFixture.addHistory(201, 2, 1, 100));
    await release(p, "api_me");
    await p.waitForFunction(() => window.accountSyncFixture.outcomes.refresh.status !== "pending");
    const s = await state(p);
    assert(s.history.some(row => row.id === 710), "A tick on one item must not discard all cloud history changes");
    assert.equal(s.history.find(row => row.id === 201).t, 1);
  }, "boot=a");

  await test("history-upload-drains-new-entry-arriving-during-slow-request", async p => {
    await hold(p, "api_account_history_record");
    await p.evaluate(() => window.accountSyncFixture.addHistory(720, 1, 12, 100));
    await waitPending(p, "api_account_history_record");
    await p.evaluate(() => window.accountSyncFixture.addHistory(721, 2, 13, 100));
    // Deliberately let the second debounce expire while the first upload is pending.
    await p.waitForTimeout(1650);
    assert.equal((await calls(p, "api_account_history_record")).length, 1);
    await release(p, "api_account_history_record");
    await p.waitForFunction(() => window.accountSyncFixture.calls.some(call => call.cmd === "api_account_history_record" && call.args.videoId === 721));
    assert.deepEqual((await calls(p, "api_account_history_record")).map(call => call.args.videoId), [720, 721]);
    assert.equal(await p.evaluate(() => window.accountSyncFixture.accounts[11].history.some(row => row.video_id === 721)), true);
  }, "boot=a");

  await test("slow-sync-followed-by-mutation-requests-a-fresh-snapshot", async p => {
    await hold(p, "api_me");
    await p.evaluate(() => window.accountSyncFixture.run("old-refresh", "syncAccount"));
    await waitPending(p, "api_me");
    assert.equal((await run(p, "remove", "setCollected", ["video", 101, false])).status, "fulfilled");
    await p.waitForTimeout(650);
    const before = (await calls(p, "api_me")).length;
    await p.evaluate(() => { window.accountSyncFixture.accounts[11].interactions.follow_user_ids = [777]; });
    await release(p, "api_me");
    await p.waitForFunction(before => window.accountSyncFixture.calls.filter(call => call.cmd === "api_me").length > before, before);
    await idle(p);
    assert(!(await state(p)).favs.includes(101));
    assert.deepEqual((await state(p)).follows, [777], "Refresh requested during the old snapshot must run again after it settles");
  }, "boot=a");

  await test("failed-snapshot-is-visible-and-retry-keeps-current-cards", async p => {
    await p.evaluate(() => window.accountSyncFixture.faults.add("api_me"));
    await run(p, "fail", "syncAccount");
    assert((await state(p)).sync.error);
    assert.deepEqual((await state(p)).favs, [101, 102]);
    await p.getByRole("button", { name: "测试作品 101", exact: true }).waitFor();
    await p.evaluate(() => window.accountSyncFixture.faults.clear());
    assert.equal((await run(p, "retry", "syncAccount")).status, "fulfilled");
    assert.equal((await state(p)).sync.error, "");
  }, "boot=a", true);

  await test("feed-failure-does-not-show-false-success", async p => {
    await p.getByRole("button", { name: "收藏", exact: true }).first().waitFor();
    await p.evaluate(() => window.accountSyncFixture.faults.add("api_collect"));
    await p.getByRole("button", { name: "收藏", exact: true }).first().click();
    await p.waitForFunction(() => window.accountSyncFixture.calls.some(call => call.cmd === "api_collect"));
    await turns(p);
    assert.equal(await p.getByRole("button", { name: "收藏", exact: true }).first().getAttribute("aria-pressed"), "true");
    assert.equal(await p.getByText("已取消收藏", { exact: true }).count(), 0);
    assert(await p.getByText(/失败/).count() > 0, "Mutation failure is visible");
  }, "boot=a&page=feed", true);

  assert.deepEqual(report.errors, [], "No browser errors");
  if (report.failed.length) process.exitCode = 1;
} catch (error) { report.failed.push({ name: "runner", error: String(error.stack || error) }); process.exitCode = 1; }
finally {
  await browser?.close(); await server?.close();
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(`Account sync checks: ${report.passed.length} passed, ${report.failed.length} failed. Artifacts: ${output}`);
}
