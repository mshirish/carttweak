/**
 * LOCAL: drive the haul flow end to end in Edge and print scores/coverage only
 * (no item names). Real receipts come from data/receipts/private/ (gitignored).
 *   npm run dev  (another terminal)
 *   npx tsx scripts/haul-e2e.ts [--width=375] [--receipts=kroger-2-handheld-28-items.jpg,kroger-3-three-items.jpg] [--list] [--shots=dir]
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.WEB_URL ?? 'http://localhost:5173';
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const width = Number(arg('width') ?? 1280);
const receipts = (arg('receipts') ?? '').split(',').filter(Boolean);
const doList = process.argv.includes('--list');
const shotsDir = arg('shots');
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

async function shot(page: Page, name: string) {
  if (!shotsDir) return;
  await page.addStyleTag({ content: '.total-bar{position:static !important}' });
  await page.screenshot({ path: path.join(shotsDir, `${width}-${name}.png`), fullPage: true });
}

async function overflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
}

async function login(page: Page) {
  await page.goto(`${BASE}/#/login`);
  await page.getByRole('heading', { name: "Who's shopping?" }).waitFor();
  await page.getByLabel(/Your name|Or add someone new/).fill('Demo');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.getByRole('heading', { name: /^Hi / }).waitFor();
}

async function overviewNumbers(page: Page) {
  await page.getByTestId('haul-score').waitFor({ timeout: 180_000 });
  return {
    score: (await page.getByTestId('haul-score').textContent())?.replace('/100', ''),
    coverage: (await page.getByTestId('coverage').textContent())?.trim(),
    overflow: await overflow(page),
  };
}

async function improveAndSave(page: Page, tag: string) {
  await page.getByRole('button', { name: 'Improve this haul' }).click();
  await page.getByRole('heading', { name: 'Goals and budget' }).waitFor();
  await page.locator('label.radio-card', { hasText: 'More fiber' }).first().click();
  const t0 = Date.now();
  await page.getByRole('button', { name: /Find swaps/ }).click();
  await page.waitForFunction(() => !!document.querySelector('article.swap, [data-testid=trip-total], .error'), null, { timeout: 180_000 });
  const planMs = Date.now() - t0;
  const swaps = await page.locator('article.swap').count();
  const label = await page.getByTestId('price-label').textContent().catch(() => null);
  const projected = await page.getByTestId('projected').textContent().catch(() => null);
  const cards = page.locator('article.swap');
  const totalBefore = await page.getByTestId('trip-total').textContent().catch(() => null);
  const acceptAll = page.getByRole('button', { name: /Accept all/ });
  let acceptAllWorks: boolean | null = null;
  let projectedAfterAccept: string | null = null;
  if (swaps > 0 && (await acceptAll.count())) {
    await acceptAll.click();
    projectedAfterAccept = await page.getByTestId('projected').textContent().catch(() => null);
    const totalAfter = await page.getByTestId('trip-total').textContent().catch(() => null);
    const undo = await page.getByRole('button', { name: 'Undo' }).count();
    acceptAllWorks = (await page.getByText('All accepted').count()) > 0 && undo > 0 && (totalAfter !== totalBefore || projectedAfterAccept !== projected);
  }
  await shot(page, `${tag}-results`);
  const ov = await overflow(page);
  await page.getByRole('button', { name: /Save revised list/ }).click();
  await page.getByRole('heading', { name: /Revised list/ }).waitFor();
  return { planMs, swaps, priceLabel: label?.trim(), projected, projectedAfterAccept, acceptAllWorks, resultsOverflow: ov };
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const out: any[] = [];
for (const file of receipts) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const r: any = { run: file, width };
  try {
    await login(page);
    await page.getByRole('button', { name: 'Upload a receipt' }).click();
    const p = path.join(root, 'data', 'receipts', 'private', file);
    const sample = path.join(root, 'docs', 'samples', 'sample-receipt.png');
    await page.getByTestId('receipt-file').setInputFiles(existsSync(p) ? p : sample);
    await page.getByRole('button', { name: 'Read receipt' }).click();
    await page.getByRole('heading', { name: 'Check what we read' }).waitFor({ timeout: 180_000 });
    r.linesRead = await page.getByTestId('receipt-row').count();
    r.needLook = (await page.getByTestId('need-look').textContent())?.trim();
    await page.getByRole('button', { name: 'Match products' }).click();
    await page.getByRole('heading', { name: 'Match your items' }).waitFor({ timeout: 180_000 });
    r.zipNote = (await page.getByTestId('zip-note').count()) > 0;
    await page.waitForTimeout(5000); // produce candidates load after the list
    r.offered = await page.$$eval('li.item', (els) => {
      const c = { rows: els.length, pickOne: 0, suggested: 0, produceAsk: 0, notFood: 0, unmatched: 0 };
      for (const e of els) {
        const chips = [...e.querySelectorAll('.chip')].map((x) => x.textContent ?? '').join('|');
        if (e.querySelector('[data-testid=produce-confirm]')) c.produceAsk++;
        else if (/Not food/.test(chips)) c.notFood++;
        else if (/Pick one/.test(chips)) c.pickOne++;
        else if (/Not matched/.test(chips)) c.unmatched++;
        if (e.querySelector('.badge')?.textContent?.includes('Suggested') || /Suggested/.test(e.querySelector('button.choice')?.textContent ?? '')) c.suggested++;
      }
      return c;
    });
    // shopper actions: confirm suggested (one tap), then pick the first candidate on the rest, confirm produce
    const cas = page.getByRole('button', { name: /Confirm all suggested/ });
    if (await cas.count()) await cas.click();
    r.pickedFirst = 0;
    for (let i = 0; i < 60; i++) {
      const row = page.locator('li.item', { hasText: 'Pick one' }).first();
      if (!(await row.count())) break;
      await row.locator('button.choice').first().click();
      r.pickedFirst++;
    }
    r.produceConfirmed = 0;
    for (let i = 0; i < 30; i++) {
      const c = page.locator('[data-testid=produce-confirm] button.choice').first();
      if (!(await c.count())) break;
      await c.click();
      r.produceConfirmed++;
    }
    r.youConfirmed = await page.locator('li.item', { hasText: 'You confirmed' }).count();
    const t0 = Date.now();
    await page.getByRole('button', { name: 'See your haul score' }).click();
    Object.assign(r, await overviewNumbers(page), { scoreMs: Date.now() - t0 });
    await shot(page, `receipt-overview`);
    Object.assign(r, await improveAndSave(page, 'receipt'));
  } catch (e: any) {
    r.error = String(e?.message ?? e).split('\n')[0];
  }
  out.push(r);
  await page.close();
}
if (doList) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const r: any = { run: 'demo list', width };
  try {
    await login(page);
    await page.getByRole('button', { name: 'Use demo list' }).click();
    await page.getByRole('button', { name: 'Check my list' }).click();
    await page.getByRole('heading', { name: 'Check your list' }).waitFor({ timeout: 120_000 });
    for (;;) {
      const o = page.locator('li.item[data-status=choose] .pick-list button').first();
      if (!(await o.count())) break;
      await o.click();
    }
    const t0 = Date.now();
    await page.getByRole('button', { name: 'Continue to goals' }).click();
    Object.assign(r, await overviewNumbers(page), { scoreMs: Date.now() - t0 });
    await shot(page, `list-overview`);
    Object.assign(r, await improveAndSave(page, 'list'));
  } catch (e: any) {
    r.error = String(e?.message ?? e).split('\n')[0];
  }
  out.push(r);
  await page.close();
}
await browser.close();
for (const r of out) console.log(JSON.stringify(r));
