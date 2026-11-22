/**
 * Drive the full "Plan my next trip" flow in a real browser (installed Edge or
 * Chrome via playwright-core) at 375 px and 1280 px, save screenshots to
 * docs/screenshots/, and report layout problems (horizontal overflow).
 *   npm run dev   (in another terminal; run npm run warm first)
 *   npx tsx scripts/screenshots.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs', 'screenshots');
const BASE = process.env.WEB_URL ?? 'http://localhost:5173';
mkdirSync(outDir, { recursive: true });

const report: any = { problems: [] as string[], runs: {} as Record<string, any> };

async function overflow(page: Page, label: string, width: number) {
  const o = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    wide: [...document.querySelectorAll('body *')]
      .filter((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.right > document.documentElement.clientWidth + 1 && r.width > 0 && getComputedStyle(el).position !== 'fixed';
      })
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${(el as HTMLElement).className}`),
  }));
  if (o.scroll > o.client + 1) report.problems.push(`${width}px ${label}: horizontal overflow ${o.scroll} > ${o.client} (${o.wide.join(', ')})`);
}

async function shot(page: Page, width: number, n: number, name: string, full = true) {
  await overflow(page, name, width);
  // a sticky bar would be painted mid-page in a full-page capture; pin it to the end instead
  if (full) await page.addStyleTag({ content: '.total-bar{position:static !important}' });
  const file = path.join(outDir, `${width}-${String(n).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: full });
  return path.relative(root, file).replace(/\\/g, '/');
}

async function swapsOnPage(page: Page) {
  return page.$$eval('article.swap', (cards) =>
    cards.map((c) => ({
      label: c.getAttribute('aria-label'),
      impact: c.querySelector('.impact')?.textContent?.trim(),
      regular: c.querySelector('[data-testid=regular-diff]')?.textContent?.trim(),
      promo: c.querySelector('[data-testid=promo-line]')?.textContent?.trim() ?? null,
      badges: [...c.querySelectorAll('.badge')].map((b) => b.textContent?.trim()),
    })),
  );
}

async function waitResults(page: Page) {
  try {
    await page.waitForFunction(() => !!document.querySelector('article.swap, [data-testid=trip-total]') || !!document.querySelector('.error'), null, { timeout: 60_000 });
  } catch (e) {
    await page.screenshot({ path: path.join(outDir, 'debug-timeout.png'), fullPage: true });
    console.error('TIMEOUT. url:', page.url(), 'body:', (await page.textContent('main'))?.slice(0, 800));
    throw e;
  }
}

async function run(width: number, height: number) {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: width < 500 ? 2 : 1 });
  const errors: string[] = [];
  page.on('pageerror', (e) => (errors.push(String(e)), console.error('PAGEERROR', String(e))));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const shots: string[] = [];
  let n = 0;
  const t: Record<string, number> = {};

  await page.goto(`${BASE}/#/start`);
  await page.getByText('Kroger On the Rhine').first().waitFor();
  shots.push(await shot(page, width, ++n, 'start'));

  await page.getByRole('button', { name: 'Use demo list' }).click();
  await page.getByRole('heading', { name: 'Your shopping list' }).waitFor();
  shots.push(await shot(page, width, ++n, 'list'));

  let t0 = Date.now();
  await page.getByRole('button', { name: 'Check my list' }).click();
  await page.getByRole('heading', { name: 'Check your list' }).waitFor({ timeout: 60_000 });
  t.resolveMs = Date.now() - t0;
  const statuses = await page.$$eval('li.item', (els) => els.map((e) => e.getAttribute('data-status')));
  report.runs[width] = { statuses: statuses.reduce((m: any, s) => ((m[s!] = (m[s!] ?? 0) + 1), m), {}) };
  shots.push(await shot(page, width, ++n, 'check'));

  // "Which one?" rows: the shopper must choose; pick the first option for each
  for (;;) {
    const opts = page.locator('li.item[data-status=choose] .pick-list button').first();
    if (!(await opts.count())) break;
    await opts.click();
  }
  shots.push(await shot(page, width, ++n, 'check-chosen'));

  await page.getByRole('button', { name: 'Continue to goals' }).click();
  await page.getByRole('heading', { name: 'Goals and budget' }).waitFor();
  await page.locator('label.radio-card', { hasText: 'More fiber' }).first().click();
  await page.locator('[aria-label="Secondary goal"] label.radio-card', { hasText: 'Less sodium' }).click();
  shots.push(await shot(page, width, ++n, 'goals'));

  t0 = Date.now();
  await page.getByRole('button', { name: /Find swaps/ }).click();
  await page.waitForTimeout(150);
  shots.push(await shot(page, width, ++n, 'progress', false));
  await waitResults(page);
  t.planMs = Date.now() - t0;
  report.runs[width].fiber = await swapsOnPage(page);
  shots.push(await shot(page, width, ++n, 'results-fiber'));

  // Accept the first swap, reject the second -> re-plan with excludedCandidateIds
  const cards = page.locator('article.swap');
  if ((await cards.count()) > 0) await cards.nth(0).getByRole('button', { name: 'Accept' }).click();
  if ((await cards.count()) > 1) {
    t0 = Date.now();
    await cards.nth(1).getByRole('button', { name: 'Reject' }).click();
    await page.waitForTimeout(100);
    await waitResults(page);
    t.replanMs = Date.now() - t0;
    report.runs[width].afterReject = await swapsOnPage(page);
  }
  // open sources on the first card for the screenshot
  await page.locator('article.swap details.sources summary').first().click().catch(() => {});
  shots.push(await shot(page, width, ++n, 'results-after-reject'));

  await page.getByRole('button', { name: /Save revised list/ }).click();
  await page.getByRole('heading', { name: 'Revised list' }).waitFor();
  report.runs[width].revisedSwapped = await page.$$eval('.revised li', (els) => els.filter((e) => e.querySelector('.badge.accent')).map((e) => e.textContent?.trim()));
  shots.push(await shot(page, width, ++n, 'saved-trip'));

  await page.goto(`${BASE}/#/saved`);
  await page.getByRole('heading', { name: 'Saved trips' }).waitFor();
  shots.push(await shot(page, width, ++n, 'saved-list'));

  // Second scenario: less added sugar, $0 budget
  await page.goto(`${BASE}/#/goals`);
  await page.getByRole('heading', { name: 'Goals and budget' }).waitFor();
  await page.locator('label.radio-card', { hasText: 'Less added sugar' }).first().click();
  await page.locator('[aria-label="Secondary goal"] label.radio-card', { hasText: 'None' }).click();
  await page.getByLabel('Maximum extra spend in dollars').fill('0');
  await page.getByLabel('Maximum extra spend in dollars').press('Enter');
  await page.getByLabel('Maximum extra spend in dollars').blur();
  await page.getByText('$0 means only swaps').click(); // move focus away so the budget commits before the click
  shots.push(await shot(page, width, ++n, 'goals-sugar'));
  const find = page.getByRole('button', { name: /Find swaps/ });
  await find.scrollIntoViewIfNeeded();
  await find.click();
  await page.waitForURL(/#\/results$/, { timeout: 10_000 }).catch(async () => console.error('still at', page.url()));
  await page.waitForTimeout(100);
  await waitResults(page);
  report.runs[width].sugar = await swapsOnPage(page);
  report.runs[width].sugarNoSwap = await page.locator('[data-testid=suggestion]').textContent().catch(() => null);
  shots.push(await shot(page, width, ++n, 'results-sugar'));

  // Receipt flow with the SYNTHETIC sample receipt (docs/samples/sample-receipt.png) - never a real receipt
  await page.goto(`${BASE}/#/receipt`);
  await page.getByRole('heading', { name: 'Upload a receipt' }).waitFor();
  shots.push(await shot(page, width, ++n, 'receipt'));
  await page.getByTestId('receipt-file').setInputFiles(path.join(root, 'docs', 'samples', 'sample-receipt.png'));
  await page.getByRole('button', { name: 'Read receipt' }).waitFor({ timeout: 60_000 });
  shots.push(await shot(page, width, ++n, 'receipt-prepare'));
  t0 = Date.now();
  await page.getByRole('button', { name: 'Read receipt' }).click();
  await page.waitForTimeout(400);
  shots.push(await shot(page, width, ++n, 'receipt-reading', false));
  await page.getByRole('heading', { name: 'Check what we read' }).waitFor({ timeout: 180_000 });
  t.receiptOcrMs = Date.now() - t0;
  report.runs[width].receiptNeedLook = await page.getByTestId('need-look').textContent();
  shots.push(await shot(page, width, ++n, 'receipt-check'));
  await page.getByRole('button', { name: 'Match products' }).click();
  await page.getByRole('heading', { name: 'Match your items' }).waitFor({ timeout: 120_000 });
  report.runs[width].receiptMatch = await page.$$eval('li.item .chip', (els) => els.map((e) => e.textContent?.trim()));
  shots.push(await shot(page, width, ++n, 'receipt-match'));
  const fallback = page.getByRole('button', { name: /Plan at .* instead/ });
  const toWalmart = page.getByRole('button', { name: /Continue at Walmart\.com/ });
  if (await fallback.isVisible().catch(() => false)) await fallback.click();
  else await toWalmart.click();
  await page.getByRole('heading', { name: 'Goals and budget' }).waitFor();
  await page.locator('label.radio-card', { hasText: 'Less sodium' }).first().click();
  await page.getByLabel('Maximum extra spend in dollars').fill('2');
  await page.getByText('$0 means only swaps').click();
  await page.getByRole('button', { name: /Find swaps/ }).click();
  await waitResults(page);
  report.runs[width].receiptSwaps = await swapsOnPage(page);
  shots.push(await shot(page, width, ++n, 'receipt-results'));
  await page.goto(`${BASE}/#/store`);
  await page.getByRole('textbox', { name: /ZIP/ }).fill('45202');
  await page.getByRole('button', { name: 'Find stores' }).click();
  await page.getByRole('list', { name: 'Stores' }).waitFor();
  shots.push(await shot(page, width, ++n, 'store'));
  await page.goto(`${BASE}/#/about`);
  await page.getByRole('heading', { name: 'About the data' }).waitFor();
  shots.push(await shot(page, width, ++n, 'about'));

  report.runs[width].timingsMs = t;
  report.runs[width].shots = shots;
  report.runs[width].consoleErrors = errors;
  await browser.close();
}

await run(375, 812);
await run(1280, 900);
writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
