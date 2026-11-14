import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { installFixture } from './fixtures/app-ui.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const key = (await readFile(new URL('../src/contentPreferences.ts', import.meta.url), 'utf8')).match(/CONTENT_PREFERENCES_KEY = "([^"]+)"/)[1];
const output = new URL(`../test-results/content-preferences-journey/${Date.now()}/`, import.meta.url);
await mkdir(output, { recursive: true });
const report = { environment: 'Real App navigation and components in Chromium, neutral simulated IPC; not native-device playback', checks: [], errors: [] };
let server, browser;
try {
  server = await createServer({ root, server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  for (const mobile of [false, true]) {
    const width = mobile ? 375 : 1280;
    const context = await browser.newContext({ viewport: { width, height: 850 }, reducedMotion: 'reduce',
      ...(mobile ? { userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36', isMobile: true, hasTouch: true } : {}) });
    await context.addInitScript(installFixture, { theme: mobile ? 'light' : 'dark', titles: ['中性故事', '日常记录'] });
    await context.addInitScript(() => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.preferenceJourney = { calls: [] };
      localStorage.setItem('hghubx_auto_line', 'off');
      localStorage.setItem('hghubx_app_v1', JSON.stringify({ favs: [1, 2], history: [{ id: 1, ep: 1, t: 20, dur: 120, at: 1 }] }));
      window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
        window.preferenceJourney.calls.push({ command, args });
        const result = await invoke(command, args);
        if (command === 'api_video') return { ...result, id: args.id, tags: args.id === 1 ? ['惊悚'] : ['日常'] };
        if (result?.items) return { ...result, items: result.items.map(item => ({ ...item, tags: (item.id || item.video_id) === 1 ? ['惊悚'] : ['日常'] })) };
        return result;
      };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => report.errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort());
    const calls = () => page.evaluate(() => window.preferenceJourney.calls.filter(call => call.command === 'api_play').length);
    const nav = () => page.getByRole('navigation', { name: '主导航' });
    await page.goto(origin);
    // Use the actual app navigation, not a harness exposing preference setters.
    if (mobile) await nav().getByRole('button', { name: '我的', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    if (await page.getByRole('button', { name: '内容偏好设置', exact: true }).getAttribute('aria-expanded') === 'false')
      await page.getByRole('button', { name: '内容偏好设置', exact: true }).click();
    await page.getByRole('textbox', { name: '添加屏蔽标签', exact: true }).fill('惊悚');
    await page.getByRole('button', { name: '屏蔽标签', exact: true }).click();
    assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).blockedTags, key), ['惊悚']);
    await page.screenshot({ path: fileURLToPath(new URL(`${width}-settings.png`, output)) });
    await page.getByRole('button', { name: '返回', exact: true }).click();
    if (!mobile) await nav().getByRole('button', { name: '我的', exact: true }).click();
    const placeholder = page.getByRole('button', { name: '该内容命中屏蔽标签，查看提示', exact: true });
    await placeholder.waitFor();
    assert.equal(await page.getByRole('button', { name: '中性故事', exact: true }).count(), 0);
    assert.equal(await placeholder.locator('img').count(), 0);
    await page.getByRole('button', { name: '观看历史', exact: true }).click();
    await placeholder.waitFor();
    assert.deepEqual(await page.evaluate(() => {
      const data = JSON.parse(localStorage.getItem('hghubx_app_v1'));
      return { favs: data.favs, ids: data.history.map(item => item.id) };
    }), { favs: [1, 2], ids: [1] });
    report.checks.push(`${width}: settings applies immediately, favorites/history retain private placeholders and records`);

    await placeholder.click();
    await page.getByRole('heading', { name: '内容已屏蔽', exact: true }).waitFor();
    assert.equal(await calls(), 0);
    assert.equal(await page.locator('[data-content-block-notice] img, [data-content-block-notice] video').count(), 0);
    await page.getByRole('button', { name: '本次查看', exact: true }).click();
    await page.waitForFunction(() => window.preferenceJourney.calls.some(call => call.command === 'api_play'));
    assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).blockedTags, key), ['惊悚']);
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await placeholder.click();
    await page.getByRole('heading', { name: '内容已屏蔽', exact: true }).waitFor();
    const afterOnce = await calls();
    await page.screenshot({ path: fileURLToPath(new URL(`${width}-blocked.png`, output)) });
    await page.getByRole('button', { name: '返回', exact: true }).click();
    report.checks.push(`${width}: history opens guarded playback, once stays local and reopening asks again`);

    await nav().getByRole('button', { name: '搜索', exact: true }).click();
    const input = page.getByRole('textbox').first();
    await input.fill('中性');
    await input.press('Enter');
    const results = page.getByRole('region', { name: '搜索结果', exact: true });
    await results.getByRole('button', { name: '临时展开', exact: true }).waitFor();
    assert.equal(await results.getByRole('button', { name: '中性故事', exact: true }).count(), 0);
    await results.getByRole('button', { name: '日常记录', exact: true }).waitFor();
    await results.getByRole('button', { name: '临时展开', exact: true }).click();
    await results.getByRole('button', { name: '中性故事', exact: true }).click();
    await page.getByRole('heading', { name: '内容已屏蔽', exact: true }).waitFor();
    assert.equal(await calls(), afterOnce, 'Revealing cards must not authorize playback');
    await page.getByRole('button', { name: '管理屏蔽标签', exact: true }).click();
    if (await page.getByRole('button', { name: '内容偏好设置', exact: true }).getAttribute('aria-expanded') === 'false')
      await page.getByRole('button', { name: '内容偏好设置', exact: true }).click();
    await page.getByRole('switch', { name: '暂停全部屏蔽', exact: true }).click();
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page.waitForFunction(previous => window.preferenceJourney.calls.filter(call => call.command === 'api_play').length > previous, afterOnce);
    report.checks.push(`${width}: search reveal does not bypass the player; preferences opened from guard apply to the underlying player`);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await context.close();
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = String(error.stack || error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server?.close();
  await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(fileURLToPath(output));
}
