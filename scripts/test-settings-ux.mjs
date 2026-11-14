import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { installFixture } from './fixtures/app-ui.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = new URL(`../test-results/settings-ux/${Date.now()}/`, import.meta.url);
await mkdir(out, { recursive: true });
const report = { environment: 'Real App, Chromium, mocked IPC; no native device verification', checks: [], errors: [] };
let server, browser;
try {
  server = await createServer({ root, server: { host: '127.0.0.1', port: 5187, strictPort: false } }); await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 375, height: 812 } : { width: 1280, height: 900 }, reducedMotion: 'reduce',
      ...(mobile ? { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', isMobile: true, hasTouch: true } : {}) });
    await context.addInitScript(installFixture, { theme: mobile ? 'light' : 'dark', titles: ['界面测试'] });
    await context.addInitScript(() => {
      localStorage.setItem('hghubx_auto_line', 'off');
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.settingsUX = { failClear: true, calls: [], releaseUpdate: null };
      window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
        const f = window.settingsUX; f.calls.push(command);
        if (command === 'line_state') return { base: 'https://fixture.invalid', fixed: [], custom: false };
        if (command === 'proxy_state') return { mode: 'system', url: '', effective: null };
        if (command === 'check_update') { await new Promise(resolve => f.releaseUpdate = resolve); return { has_update: false, current: '2.0.0' }; }
        if (command === 'cache_clear') { if (f.failClear) throw '模拟清理失败'; return null; }
        return invoke(command, args);
      };
    });
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    page.on('pageerror', e => report.errors.push(e.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort());
    await page.goto(origin);
    if (mobile) await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const expand = async title => {
      const trigger = page.getByRole('button', { name: `${title}设置`, exact: true });
      if (await trigger.getAttribute('aria-expanded') === 'false') await trigger.click();
      await trigger.scrollIntoViewIfNeeded();
    };
    await expand('其他');
    await page.getByRole('button', { name: /检查更新/ }).click();
    await page.getByRole('status', { name: '正在检查更新' }).waitFor();
    assert(await page.getByRole('button', { name: /检查更新/ }).isDisabled());
    await page.evaluate(() => window.settingsUX.releaseUpdate());
    await page.getByText('已是最新版本 v2.0.0', { exact: true }).waitFor();
    report.checks.push(`${mobile ? 'mobile' : 'desktop'}: section expansion and update busy feedback`);
    await expand('本地数据');
    await page.getByRole('button', { name: /清理缓存/ }).click();
    const dialog = page.getByRole('dialog', { name: '清理缓存', exact: true });
    await dialog.getByRole('button', { name: '确定清理' }).click();
    await dialog.getByRole('alert').filter({ hasText: '模拟清理失败' }).waitFor();
    assert.equal(await page.getByText('缓存已清理', { exact: true }).count(), 0);
    await page.evaluate(() => window.settingsUX.failClear = false);
    await dialog.getByRole('button', { name: '确定清理' }).click();
    await page.getByText('缓存已清理', { exact: true }).waitFor();
    report.checks.push(`${mobile ? 'mobile' : 'desktop'}: cache failure retained, retry succeeds, no false success`);
    await expand('其他');
    await page.getByRole('button', { name: /关于 HGhubX/ }).click();
    await page.getByRole('dialog', { name: '关于 HGhubX' }).getByRole('button', { name: '打开项目仓库' }).waitFor();
    await page.screenshot({ path: fileURLToPath(new URL(`${mobile ? 'mobile' : 'desktop'}-about.png`, out)) });
    await page.keyboard.press('Escape');
    await expand('外观');
    await page.screenshot({ path: fileURLToPath(new URL(`${mobile ? 'mobile' : 'desktop'}-settings.png`, out)) });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    report.checks.push(`${mobile ? 'mobile' : 'desktop'}: named dialogs, truthful open action, no overflow`);
    await context.close();
  }
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.failure = String(error.stack || error); process.exitCode = 1; }
finally { await browser?.close(); await server?.close(); await writeFile(new URL('report.json', out), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); console.log(fileURLToPath(out)); }
