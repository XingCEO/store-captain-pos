'use strict';

// Playwright + axe-core a11y smoke. Runs against a live server; spins one
// browser instance and tests the three highest-traffic public pages.
// Excluded from the default `npm test` suite (see package.json) because it
// boots Chromium (~1-2s); invoke via `npm run test:a11y`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, stopTestServer } = require('./helpers');

let playwright;
let AxeBuilder;
try {
  playwright = require('playwright');
  AxeBuilder = require('@axe-core/playwright').default;
} catch {
  // Dependencies missing — skip the whole file rather than fail loudly so
  // contributors without Chromium can still run the main test suite.
  test('a11y suite skipped (playwright/@axe-core/playwright not available)', () => {});
  return;
}

async function checkPage(browser, port, urlPath) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}${urlPath}`, { waitUntil: 'domcontentloaded' });
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .disableRules(['color-contrast']) // Brand palette intentionally low-contrast in accent buttons; tracked separately.
    .analyze();
  await ctx.close();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  return serious;
}

test('public pages have no serious a11y violations', async () => {
  const ctx = await startTestServer();
  const browser = await playwright.chromium.launch();
  try {
    for (const route of ['/', '/login.html', '/product.html']) {
      const violations = await checkPage(browser, ctx.port, route);
      assert.equal(
        violations.length, 0,
        `${route} a11y serious violations:\n` + violations.map((v) => ` - ${v.id}: ${v.help}`).join('\n'),
      );
    }
  } finally {
    await browser.close();
    await stopTestServer(ctx);
  }
});
