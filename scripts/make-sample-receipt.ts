/**
 * Render a SYNTHETIC Walmart-style receipt image for screenshots and demos:
 * docs/samples/sample-receipt.png. Store, address, staff, card and prices are
 * made up; item codes are public UPC bodies of demo-list products so barcode
 * matching has something to match. Not a real purchase.
 *   npx tsx scripts/make-sample-receipt.ts
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs', 'samples', 'sample-receipt.png');
mkdirSync(path.dirname(out), { recursive: true });

export const SAMPLE_RECEIPT_TEXT = `SAMPLE RECEIPT - NOT A REAL PURCHASE
555-010-0100 Mgr:SAMPLE
100 SAMPLE AVE
CINCINNATI OH 45202
ST# 00000 OP# 000001 TE# 01 TR# 00001
WONDER BREAD   007225001137 F   3.18 N
JIF CRMY PB    005150025516 F   3.12 N
LAYS CLASSIC   002840019914 F   3.98 N
BARILLA SPAG   007680828008 F   1.84 N
COCA COLA 12   004900002890    11.48 X
BANANAS        000000004011 F
  2.10 lb @ 1.0 lb /0.52        1.09 N
SAMPLE ITEM    012345600011     2.00 X
              SUBTOTAL         26.69
      TAX 1  7.000 %            0.94
                 TOTAL         27.63
     VISA TEND                 27.63
VISA **** **** **** 0000 I 0
        # ITEMS SOLD 7
TC# 0000 0000 0000 0000 0000
11/20/26    18:05:00`;

const html = `<!doctype html><html><body style="margin:0;background:#fff">
<pre id="r" style="margin:0;padding:28px 34px;width:640px;font:700 22px/1.45 'Courier New',monospace;color:#111;background:#fff">${SAMPLE_RECEIPT_TEXT.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>
</body></html>`;

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 720, height: 1000 } });
await page.setContent(html);
await page.locator('#r').screenshot({ path: out });
await browser.close();
console.log(`wrote ${path.relative(root, out)}`);
