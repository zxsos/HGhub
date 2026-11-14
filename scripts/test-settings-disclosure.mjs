// Real App and Settings in Chromium; neutral IPC fixtures, no native/device claims.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { installFixture } from './fixtures/app-ui.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL(`../test-results/settings-disclosure/${Date.now()}/`, import.meta.url);
await mkdir(output, { recursive: true });
const report = { environment: 'Real App/Settings, Chromium, neutral mocked IPC; not native-device verification', checks: [], errors: [], measurements: [] };
const titles = ['外观', '播放', '内容偏好', '本地数据', '网络', '播放诊断', '其他'];
let server, browser, page;
try {
  server = await createServer({ root, server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  for (const [width, height] of [[320, 694], [375, 812], [812, 375], [1280, 900]]) {
    for (const theme of ['light', 'dark']) {
      const mobile = width < 1024;
      const label = `${width}x${height}-${theme}`;
      const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce',
        ...(mobile ? { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', isMobile: true, hasTouch: true } : {}) });
      await context.addInitScript(installFixture, { theme, titles: ['日常故事', '城市纪录'] });
      await context.addInitScript(() => {
        localStorage.setItem('hghubx_auto_line', 'off');
        const invoke = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
          if (command === 'line_state') return { base: 'https://fixture.invalid', fixed: [], custom: false };
          if (command === 'proxy_state') return { mode: 'system', url: '', effective: null };
          if (command === 'playback_log_status') return { enabled: false, path: '/fixture/logs/playback.log', error: null };
          return invoke(command, args);
        };
      });
      page = await context.newPage();
      page.setDefaultTimeout(7000);
      page.on('pageerror', error => report.errors.push(`${label}: ${error.message}`));
      await page.route('**/*', route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort());
      await page.goto(origin);
      if (mobile) await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的', exact: true }).click();
      await page.getByRole('button', { name: '设置', exact: true }).click();
      const trigger = title => page.getByRole('button', { name: `${title}设置`, exact: true });
      const expand = async title => {
        if (await trigger(title).getAttribute('aria-expanded') !== 'true') await trigger(title).click();
      };
      assert.equal(await page.getByRole('navigation', { name: '设置分组' }).count(), 0, 'No duplicate group shortcut navigation');
      await trigger('外观').waitFor();
      for (const title of titles) {
        const button = trigger(title);
        const expanded = false;
        assert.equal(await button.getAttribute('aria-expanded'), String(expanded), `${title}: default expanded state`);
        const panelId = await button.getAttribute('aria-controls');
        assert(panelId, `${title}: named controlled panel`);
        const panel = page.locator(`[id="${panelId}"]`);
        assert.equal(await panel.count(), 1);
        assert.equal(await panel.evaluate(el => el.hidden), !expanded);
        assert.equal(await button.locator('xpath=ancestor::h2').count(), 1, 'Disclosure is a button within a section heading');
        const bounds = await button.boundingBox();
        assert(bounds.height >= 44 && bounds.width >= 44, `${title}: touch target is ${bounds.width}x${bounds.height}`);
      }
      report.checks.push(`${label}: seven accessible disclosures, all-collapsed default, controlled hidden panels and 44px targets`);

      const geometry = await page.evaluate(() => {
        const box = el => { const r = el.getBoundingClientRect(); return { x: r.x, right: r.right, width: r.width }; };
        return {
          heading: box([...document.querySelectorAll('h1')].find(el => el.textContent === '设置')),
          back: box(document.querySelector('[aria-label="返回"]')),
          sections: [...document.querySelectorAll('[id^="settings-"]')].filter(el => el.tagName === 'SECTION').map(box),
          cards: [...document.querySelectorAll('.ios-setting-group')].filter(el => el.checkVisibility()).map(box),
          scrollContainers: document.querySelectorAll('[data-settings-scroll]').length,
        };
      });
      const reference = geometry.sections[0];
      assert(reference.width <= 720.5, 'Readable setting content width');
      for (const rect of [geometry.heading, ...geometry.sections, ...geometry.cards]) {
        assert(Math.abs(rect.x - reference.x) <= 1.5, `Left edge differs: ${JSON.stringify({ reference, rect })}`);
        assert(Math.abs(rect.right - reference.right) <= 1.5, `Right edge differs: ${JSON.stringify({ reference, rect })}`);
      }
      assert.equal(geometry.scrollContainers, 1);
      assert(Math.abs(geometry.back.x - reference.x) <= 1.5, 'Back control shares the content left edge');
      report.measurements.push({ label, ...geometry });
      report.checks.push(`${label}: page heading, fixed back control and all cards share a <=720px aligned column`);
      await page.screenshot({ path: fileURLToPath(new URL(`${label}-default.png`, output)), animations: 'disabled' });

      await trigger('外观').focus();
      await page.keyboard.press('Enter');
      assert.equal(await trigger('外观').getAttribute('aria-expanded'), 'true');
      await page.keyboard.press('Tab');
      assert(await page.getByRole('group', { name: '外观模式' }).evaluate(el => el.contains(document.activeElement)), 'Expanded appearance choices must be keyboard accessible');
      await trigger('外观').focus();
      await page.keyboard.press('Space');
      assert.equal(await trigger('外观').getAttribute('aria-expanded'), 'false');
      await page.keyboard.press('Tab');
      assert(await trigger('播放').evaluate(el => el === document.activeElement), 'Collapsed appearance choices must not be in the tab order');
      report.checks.push(`${label}: Enter/Space toggles, hidden descendants leave tab order and reopening restores keyboard access`);

      await expand('内容偏好');
      assert.equal(await trigger('内容偏好').getAttribute('aria-expanded'), 'true');
      assert.equal(await trigger('外观').getAttribute('aria-expanded'), 'false');
      assert.equal(await trigger('播放').getAttribute('aria-expanded'), 'false');
      assert.equal(await trigger('网络').getAttribute('aria-expanded'), 'false');
      const input = page.getByRole('textbox', { name: '添加屏蔽标签', exact: true });
      await input.fill('未提交的标签草稿');
      const toggle = page.getByRole('switch', { name: '隐藏无标签视频', exact: true });
      const before = await toggle.getAttribute('aria-checked');
      await trigger('内容偏好').click();
      assert.equal(await input.isVisible(), false);
      await trigger('内容偏好').click();
      assert.equal(await input.inputValue(), '未提交的标签草稿');
      assert.equal(await toggle.getAttribute('aria-checked'), before);
      report.checks.push(`${label}: closing retains drafts and switch values; section disclosure leaves other groups unchanged`);

      await expand('播放诊断');
      const diagnostic = page.locator('#settings-播放诊断');
      await diagnostic.getByText('查看日志保存位置', { exact: true }).click();
      await diagnostic.getByText('/fixture/logs/playback.log', { exact: true }).waitFor();
      await trigger('播放诊断').click();
      assert.equal(await page.getByText('/fixture/logs/playback.log', { exact: true }).isVisible(), false, 'Log location belongs to its collapsed diagnostic group');
      report.checks.push(`${label}: secondary log details collapse with their owning settings group`);

      await expand('内容偏好');
      await input.fill('长标签'.repeat(20));
      await page.getByRole('button', { name: '屏蔽标签', exact: true }).click();
      await page.getByRole('list', { name: '已屏蔽标签' }).getByText('长标签'.repeat(20), { exact: true }).waitFor();
      await page.addStyleTag({ content: '.ios-settings-content :is(h2, h3, p, label, span, button, input, summary) { font-size: 24px !important; }' });
      await input.scrollIntoViewIfNeeded();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Large text does not overflow the viewport');
      const overflowing = await page.locator('#settings-内容偏好 .ios-setting-group').evaluate(el => el.scrollWidth > el.clientWidth + 1);
      assert.equal(overflowing, false, 'Long tag and large text stay within the settings card');
      await page.screenshot({ path: fileURLToPath(new URL(`${label}-large-text.png`, output)), animations: 'disabled' });
      report.checks.push(`${label}: long labels and 24px text wrap without horizontal overflow`);

      if (label === '375x812-dark') {
        const satTop = await page.evaluate(async () => {
          const header = document.querySelector('.ios-settings-header');
          header.style.setProperty('--sat', '47px');
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return document.querySelector('[aria-label="返回"]').getBoundingClientRect().top;
        });
        assert(satTop >= 46.5, `Back control clears the simulated top safe area (top=${satTop})`);
        const appTrigger = trigger('外观');
        const appBox = await appTrigger.boundingBox();
        await page.mouse.move(appBox.x + appBox.width / 2, appBox.y + appBox.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(320);
        const pressScale = await appTrigger.evaluate(el => getComputedStyle(el).scale);
        await page.mouse.up();
        assert.equal(pressScale, '1', 'Section disclosure trigger stays full-size while pressed');
        report.checks.push(`${label}: safe-area clearance and press-stable disclosure trigger`);
      }

      await expand('网络');
      await page.getByRole('switch', { name: '严格安全模式', exact: true }).scrollIntoViewIfNeeded();
      assert(await page.locator('[data-settings-scroll]').evaluate(el => el.scrollTop > 0), 'Settings scroll reaches network controls');
      const back = page.getByRole('button', { name: '返回', exact: true });
      const backRect = await back.boundingBox();
      assert(backRect.y >= 0 && backRect.y + backRect.height <= height, 'Fixed back button stays inside viewport after scrolling');
      assert(await back.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), 'Back button is not obscured');
      await back.click();
      await page.getByRole('button', { name: '设置', exact: true }).waitFor();
      assert.equal(await trigger('外观').count(), 0, 'Back exits settings');
      report.checks.push(`${label}: back remains visible and actionable after scrolling to network settings`);
      await context.close();
      page = null;
    }
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = String(error.stack || error);
  await page?.screenshot({ path: fileURLToPath(new URL('failure.png', output)), animations: 'disabled' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server?.close();
  await writeFile(new URL('report.json', output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(fileURLToPath(output));
}
