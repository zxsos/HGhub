// Execute focused UI suites serially so their Vite servers and browsers do not compete.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const suites = [
  ['settings', ['scripts/test-settings-ux.mjs']],
  ['settings-disclosure', ['scripts/test-settings-disclosure.mjs']],
  ['visual-alignment', ['scripts/test-visual-alignment.mjs']],
  ['search', ['scripts/test-search-recovery.mjs']],
  ['discovery', ['scripts/test-discover-recovery.mjs']],
  ['posts', ['scripts/test-post-reading.mjs']],
  ['profile', ['scripts/test-account-recovery.mjs', 'profile']],
  ['authors', ['scripts/test-account-recovery.mjs', 'user']],
  ['login', ['scripts/test-account-recovery.mjs', 'login']],
  ['account-sync', ['scripts/test-account-sync.mjs']],
  ['home-desktop', ['scripts/test-home-scheduling.mjs']],
  ['home-mobile', ['scripts/test-home-scheduling.mjs'], { HOME_UI_MOBILE: '1' }],
  ['reading', ['scripts/test-reading-selection.mjs']],
  ['player-panels', ['scripts/test-player-panels.mjs']],
  ['content-preferences', ['scripts/test-content-preferences-core.mjs']],
  ['filtered-lists', ['scripts/test-content-filter-lists.mjs']],
  ['tag-feed', ['scripts/test-tag-feed.mjs']],
  ['tag-posts', ['scripts/test-post-tag-blocking.mjs']],
  ['preferences-journey', ['scripts/test-content-preferences-journey.mjs']],
];
const output = new URL(`../test-results/ui-recovery/${Date.now()}/`, import.meta.url);
mkdirSync(output, { recursive: true });
const results = [];
for (const [name, args, env = {}] of suites) {
  console.log(`Running UI recovery: ${name}`);
  const result = spawnSync(process.execPath, args, {
    cwd: root, env: { ...process.env, ...env }, stdio: 'inherit', timeout: 180_000,
  });
  results.push({ name, command: [process.execPath, ...args], env, status: result.status,
    signal: result.signal, error: result.error?.message ?? null });
}
const passed = results.every(result => result.status === 0 && !result.error);
writeFileSync(new URL('report.json', output), JSON.stringify({ passed, results }, null, 2));
console.log(`UI recovery suites: ${results.filter(result => result.status === 0).length}/${results.length} passed`);
if (!passed) process.exitCode = 1;
