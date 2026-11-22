/**
 * LOCAL ONLY: run the receipt flow end to end in a real browser on the private
 * receipt photos (data/receipts/private/, gitignored) and print COUNTS only.
 * Screenshots of real receipts are written only inside the private folder.
 *   npm run dev   (another terminal)
 *   npx tsx scripts/receipt-e2e.ts [--bw]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'data', 'receipts', 'private');
const BASE = process.env.WEB_URL ?? 'http://localhost:5173';
const bw = process.argv.includes('--bw');
if (!existsSync(path.join(dir, 'truth.json'))) {
  console.log('No private receipts; nothing to run.');
  process.exit(0);
}
const truth = JSON.parse(readFileSync(path.join(dir, 'truth.json'), 'utf8')).receipts as Record<string, { items: Array<[string, number]> }>;
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);

const results: any[] = [];
const browser = await chromium.launch({ channel: 'msedge', headless: true });
for (const file of readdirSync(dir).filter((f) => truth[f] && (!only || f === only))) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const r: any = { file, bw };
  try {
    await page.goto(`${BASE}/#/receipt`);
    await page.getByTestId('receipt-file').setInputFiles(path.join(dir, file));
    await page.getByRole('button', { name: 'Read receipt' }).waitFor({ timeout: 90_000 });
    if (bw) await page.getByLabel(/Black & white/).check();
    let t0 = Date.now();
    await page.getByRole('button', { name: 'Read receipt' }).click();
    await page.getByRole('heading', { name: 'Check what we read' }).waitFor({ timeout: 180_000 });
    r.ocrMs = Date.now() - t0;
    r.needLook = (await page.getByTestId('need-look').textContent())?.trim();
    r.header = {
      store: await page.getByLabel(/Walmart store #/).inputValue(),
      zip: await page.getByLabel(/ZIP/).inputValue(),
      date: await page.getByLabel('Date').inputValue(),
    };
    // no helper functions inside evaluate: tsx would inject a __name() helper the page doesn't have
    const rows = await page.$$eval('[data-testid=receipt-row]', (els) =>
      els.map((e) => ({
        code: (e.querySelector('label.rcode input') as HTMLInputElement | null)?.value ?? '',
        price: (e.querySelector('label.rprice input') as HTMLInputElement | null)?.value ?? '',
      })),
    );
    // lines read correctly: truth items whose code AND price appear in the editable rows (each row used once)
    const pool = rows.map((x) => ({ ...x, used: false }));
    let correct = 0;
    for (const [code, cents] of truth[file]!.items) {
      const hit = pool.find((p) => !p.used && p.code === code && Math.round(Number(p.price) * 100) === cents);
      if (hit) {
        hit.used = true;
        correct++;
      }
    }
    r.linesCorrect = `${correct}/${truth[file]!.items.length}`;
    r.rows = rows.length;
    await page.screenshot({ path: path.join(dir, `e2e-${file}-check.png`), fullPage: true });
    t0 = Date.now();
    await page.getByRole('button', { name: 'Match products' }).click();
    await page.getByRole('heading', { name: 'Match your items' }).waitFor({ timeout: 180_000 });
    r.matchMs = Date.now() - t0;
    const chips = await page.$$eval('li.item .chip', (els) => els.map((e) => e.textContent?.trim()));
    r.match = chips.reduce((m: any, c) => ((m[c!] = (m[c!] ?? 0) + 1), m), {});
    r.walmartDown = await page.getByText("We can't check Walmart's current prices right now.").isVisible().catch(() => false);
    const fb = page.getByRole('button', { name: /Plan at .* instead/ });
    if (await fb.isEnabled().catch(() => false)) {
      await fb.click();
      await page.getByRole('heading', { name: 'Goals and budget' }).waitFor();
      await page.locator('label.radio-card', { hasText: 'More fiber' }).first().click();
      t0 = Date.now();
      await page.getByRole('button', { name: /Find swaps/ }).click();
      await page.waitForFunction(() => !!document.querySelector('article.swap, [data-testid=trip-total], .error'), null, { timeout: 180_000 });
      r.planMs = Date.now() - t0;
      r.swaps = await page.$$eval('article.swap', (els) => els.map((e) => ({ swap: e.getAttribute('aria-label'), cost: e.querySelector('[data-testid=regular-diff]')?.textContent, paid: e.querySelector('[data-testid=paid-line]')?.textContent ?? null })));
      r.suggestion = await page.locator('[data-testid=suggestion]').textContent().catch(() => null);
      r.differentStoreBanner = await page.getByText(/Different store:/).first().isVisible().catch(() => false);
      await page.screenshot({ path: path.join(dir, `e2e-${file}-results.png`), fullPage: true });
    } else r.plan = 'no items usable at the fallback store';
  } catch (e: any) {
    r.error = String(e?.message ?? e).slice(0, 300);
  }
  results.push(r);
  await page.close();
}
await browser.close();
writeFileSync(path.join(dir, `e2e-results${bw ? '-bw' : ''}.json`), JSON.stringify(results, null, 2));
for (const r of results) console.log(JSON.stringify({ ...r, swaps: r.swaps?.length, suggestion: r.suggestion ? 'yes' : null }));
