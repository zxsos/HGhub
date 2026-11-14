import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = fileURLToPath(new URL(`../test-results/reading-selection/${new Date().toISOString().replace(/[:.]/g, "-")}/`, import.meta.url));
await mkdir(output, { recursive: true });
const report = { environment: "Real App global event handlers/CSS in Chromium; representative reading DOM and deterministic IPC. Checks emitted iOS commands, not native WKWebView selection handles.", passed: [], failed: [] };
let server, browser;
try {
  server = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } }); await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1", isMobile: true, hasTouch: true });
  await context.addInitScript(installFixture, { theme: "light", titles: ["示例"] });
  await context.addInitScript(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.readingSelectionCalls = [];
    window.__TAURI_INTERNALS__.invoke = (command, args = {}) => { if (command === "set_text_interaction") window.readingSelectionCalls.push(args.enabled); return original(command, args); };
  });
  const page = await context.newPage();
  await page.route("**/*", route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort());
  await page.goto(origin); await page.getByRole("navigation", { name: "主导航" }).waitFor();
  await page.evaluate(() => {
    const fixture = document.createElement("section"); fixture.id = "reading-fixture";
    fixture.innerHTML = '<input id="input"><textarea id="textarea"></textarea><div id="editable" contenteditable="true">编辑</div><div class="select-text"><span id="reading">资料简介</span></div><article class="article-body"><p id="article">正文内容</p></article><button id="control">控件</button><video id="video"></video>';
    document.body.append(fixture);
  });
  const run = async (name, test) => { try { await test(); report.passed.push(name); } catch (error) { report.failed.push({ name, error: String(error) }); } };
  await run("reading-context-menu-allowed", async () => {
    for (const id of ["input", "textarea", "editable", "reading", "article"]) {
      const prevented = await page.evaluate(id => { const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true }); document.getElementById(id).dispatchEvent(e); return e.defaultPrevented; }, id);
      assert.equal(prevented, false, `${id} must allow copy/paste context menu`);
    }
  });
  await run("controls-context-menu-blocked", async () => {
    for (const id of ["control", "video"]) assert.equal(await page.evaluate(id => { const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true }); document.getElementById(id).dispatchEvent(e); return e.defaultPrevented; }, id), true);
  });
  await run("reading-css-selectable", async () => {
    for (const id of ["input", "textarea", "editable", "reading", "article"]) assert.equal(await page.locator(`#${id}`).evaluate(el => getComputedStyle(el).webkitUserSelect), "text", `${id} must allow text selection`);
    assert.equal(await page.locator("#control").evaluate(el => getComputedStyle(el).webkitUserSelect), "none");
  });
  await run("ios-native-interaction-follows-target", async () => {
    for (const id of ["input", "textarea", "editable", "reading", "article"]) {
      await page.evaluate(id => {
        document.getElementById("control").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        window.readingSelectionCalls.length = 0;
        document.getElementById(id).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        document.getElementById("control").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      }, id);
      assert.deepEqual(await page.evaluate(() => window.readingSelectionCalls), [true, false], `${id} enables native selection, controls disable it`);
    }
  });
  await run("ios-input-blur-keeps-article-selection", async () => {
    await page.evaluate(() => {
      document.getElementById("control").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      window.readingSelectionCalls.length = 0;
      document.getElementById("article").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      document.getElementById("input").dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    });
    assert.deepEqual(await page.evaluate(() => window.readingSelectionCalls), [true]);
  });
  await run("ios-keyboard-focus-updates-selection", async () => {
    await page.evaluate(() => {
      document.getElementById("control").dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      window.readingSelectionCalls.length = 0;
      document.getElementById("editable").dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      document.getElementById("editable").dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.getElementById("control") }));
    });
    assert.deepEqual(await page.evaluate(() => window.readingSelectionCalls), [true, false]);
  });
  if (report.failed.length) process.exitCode = 1;
} catch (error) { report.failed.push({ name: "runner", error: String(error) }); process.exitCode = 1; }
finally { await browser?.close(); await server?.close(); await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ...report, output }, null, 2)); }
