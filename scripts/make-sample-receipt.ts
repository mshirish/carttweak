/**
 * Render a SYNTHETIC Kroger-style receipt image for screenshots and demos:
 * docs/samples/sample-receipt.png. Store, address, cashier, card and prices are
 * made up; item names are common grocery abbreviations so name matching has
 * something to search for. Not a real purchase.
 *   npx tsx scripts/make-sample-receipt.ts
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs', 'samples', 'sample-receipt.png');
mkdirSync(path.dirname(out), { recursive: true });

export const SAMPLE_RECEIPT_TEXT = `Kroger
SAMPLE RECEIPT - NOT A REAL PURCHASE
100 SAMPLE AVE
Your cashier was SAMPLE
KRO WHT BREAD          2.49 F
JIF CRMY PB            3.12 F
LAYS CLASSIC CHIPS     3.98 F
BARILLA SPAGHETTI      1.84 F
2 @ 2.69
COCA COLA 12PK         5.38 B
BANANAS
2.10 lb @ 0.59 /lb
WT      BANANAS        1.24 F
KROGER SAVINGS         0.50-
**** BALANCE          18.05
VISA ************0000
CINCINNATI, OH 45202
11/20/26 6:05pm`;

const html = `<!doctype html><html><body style="margin:0;background:#fff">
<pre id="r" style="margin:0;padding:28px 34px;width:640px;font:700 22px/1.45 'Courier New',monospace;color:#111;background:#fff">${SAMPLE_RECEIPT_TEXT.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>
</body></html>`;

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 720, height: 1000 } });
await page.setContent(html);
await page.locator('#r').screenshot({ path: out });
await browser.close();
console.log(`wrote ${path.relative(root, out)}`);
