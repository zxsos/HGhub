import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
const root = fileURLToPath(new URL('../', import.meta.url));
const key = (await readFile(new URL('../src/contentPreferences.ts', import.meta.url), 'utf8')).match(/CONTENT_PREFERENCES_KEY = "([^"]+)"/)[1];
const output = new URL(`../test-results/post-tag-blocking/${Date.now()}/`, import.meta.url);
await mkdir(output, { recursive: true });
const report = { environment: 'Real Posts components, Chromium and simulated IPC; no upstream requests or native playback', checks: [], errors: [] };
let server, browser;
try {
  server = await createServer({ root, server: { host: '127.0.0.1', port: 5191, strictPort: false } }); await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true });
  for (const width of [375, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 850 }, reducedMotion: 'reduce', ...(width === 375 ? {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1', isMobile: true, hasTouch: true,
    } : {}) });
    await context.addInitScript(({ key }) => {
      localStorage.setItem(key, JSON.stringify({ blockedTags: ['惊悚'], paused: false, hideUntagged: false }));
      localStorage.setItem('hghubx_theme', 'light');
      const fixture = window.tagPostFixture = { calls: [], held: false, release: null };
      const post = id => ({ id, title: `测试帖子 ${id}`, cover: `https://fixture.invalid/poster-${id}.jpg`, content: '中性正文。', tags: id === 1 ? ['惊悚'] : id === 2 ? [] : ['轻喜剧'], hot: 20 });
      window.__TAURI_INTERNALS__ = { async invoke(command, args = {}) {
        fixture.calls.push({ command, args });
        if (command === 'app_boot') return { user: null, strict_security: true };
        if (command === 'api_post') { if (fixture.held) await new Promise(resolve => fixture.release = resolve); return post(args.id); }
        if (command === 'api_post_playback') return { videos: [] };
        if (command === 'api_post_category') return { items: args.page === 1 ? [post(1)] : [post(3)], pagination: { page: args.page, pages: 2, total: 2 } };
        return null;
      } };
    }, { key });
    const page = await context.newPage(); page.setDefaultTimeout(6500);
    page.on('pageerror', error => report.errors.push(error.message));
    const requests = [];
    await page.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === new URL(origin).origin) return route.continue(); requests.push(url.href); return route.abort(); });
    const calls = command => page.evaluate(command => window.tagPostFixture.calls.filter(call => call.command === command).length, command);
    const update = preferences => page.evaluate(async ({ key, preferences }) => {
      localStorage.setItem(key, JSON.stringify(preferences)); window.dispatchEvent(new StorageEvent('storage', { key }));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, { key, preferences });
    await page.goto(`${origin}scripts/fixtures/post-reading.html`);
    await page.getByRole('heading', { name: '内容已屏蔽' }).waitFor();
    assert.equal(await calls('api_post_playback'), 0); assert.equal(requests.length, 0);
    assert.equal(await page.getByRole('heading', { name: '测试帖子 1' }).count(), 0);
    assert.equal(await page.locator('video,img').count(), 0);
    report.checks.push(`${width}: blocked post exposes no cover, body or playback request`);
    await page.getByRole('button', { name: '本次查看', exact: true }).click();
    await page.getByRole('heading', { name: '测试帖子 1' }).waitFor();
    await page.waitForFunction(() => window.tagPostFixture.calls.some(c => c.command === 'api_post_playback'));
    assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).blockedTags, key), ['惊悚']);
    await update({ blockedTags: ['惊悚', '悬疑'], paused: false, hideUntagged: false });
    await page.getByRole('heading', { name: '内容已屏蔽' }).waitFor(); assert.equal(await page.locator('video,img').count(), 0);
    await update({ blockedTags: ['惊悚'], paused: true, hideUntagged: false });
    await page.getByRole('heading', { name: '测试帖子 1' }).waitFor();
    await update({ blockedTags: ['惊悚'], paused: false, hideUntagged: false });
    await page.getByRole('heading', { name: '内容已屏蔽' }).waitFor();
    report.checks.push(`${width}: once is temporary, preference revision and resume reblock`);
    const before = await calls('api_post_playback');
    await page.evaluate(() => { window.tagPostFixture.held = true; window.postReading.setId(2); });
    await page.waitForFunction(() => typeof window.tagPostFixture.release === 'function');
    assert.equal(await calls('api_post_playback'), before); assert.equal(await page.locator('video,img').count(), 0);
    await page.evaluate(() => { window.tagPostFixture.held = false; window.tagPostFixture.release(); });
    await page.getByRole('heading', { name: '测试帖子 2' }).waitFor();
    await update({ blockedTags: ['惊悚'], paused: false, hideUntagged: true });
    await page.getByRole('heading', { name: '内容已屏蔽' }).waitFor();
    report.checks.push(`${width}: waits for current tags, unknown allowed by default then optional block`);
    await update({ blockedTags: [], paused: false, hideUntagged: false });
    await page.evaluate(() => window.postReading.setId(3));
    await page.getByRole('heading', { name: '测试帖子 3' }).waitFor();
    await page.getByRole('button', { name: '不感兴趣', exact: true }).click();
    const menu = page.getByRole('dialog', { name: '不感兴趣' });
    await menu.getByRole('button', { name: '轻喜剧', exact: true }).click();
    await menu.getByRole('button', { name: '屏蔽所选标签' }).click();
    await page.getByRole('heading', { name: '内容已屏蔽' }).waitFor();
    report.checks.push(`${width}: tag menu blocks the current content immediately`);
    await page.goto(`${origin}scripts/fixtures/post-reading.html?list`);
    await page.getByRole('button', { name: '临时展开', exact: true }).waitFor();
    assert.equal(await page.locator('.ios-poster').count(), 0);
    assert.equal(await calls('api_post_category'), 1, 'Filtered empty page must not drain all pages automatically');
    await page.getByRole('button', { name: '临时展开', exact: true }).click();
    await page.getByRole('button', { name: '测试帖子 1', exact: true }).waitFor();
    await page.getByRole('button', { name: '恢复隐藏', exact: true }).click();
    await page.getByRole('button', { name: '加载更多', exact: true }).click();
    await page.getByRole('button', { name: '测试帖子 3', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '测试帖子 1', exact: true }).count(), 0);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: fileURLToPath(new URL(`${width}-filtered-posts.png`, output)) });
    report.checks.push(`${width}: list hides, expands and manually fills without losing pagination`);
    await context.close();
  }
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.failure = String(error.stack || error); process.exitCode = 1; }
finally { await browser?.close(); await server?.close(); await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); console.log(fileURLToPath(output)); }
