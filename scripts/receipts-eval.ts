/**
 * LOCAL: receipt reading accuracy against hand-typed ground truth.
 *   npm run receipts:eval [-- --only=kroger-3] [--save]
 * Starts Vite in-process, opens headless Edge, and runs web/src/receiptPipeline.ts
 * (the same code the upload screen uses) on every image listed in
 * data/receipts/private/truth-kroger.json. Prints COUNTS ONLY: never item names.
 * --save writes the raw results to data/receipts/private/eval-last.json (gitignored).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { scoreReceipt, type TruthReceipt } from './receipt-score.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const priv = path.join(root, 'data', 'receipts', 'private');
const truthPath = path.join(priv, 'truth-kroger.json');
if (!existsSync(truthPath)) {
  console.error('No ground truth at data/receipts/private/truth-kroger.json');
  process.exit(1);
}
const truth = JSON.parse(readFileSync(truthPath, 'utf8')).receipts as Record<string, { kind: string; generatedSample?: boolean; receipts: TruthReceipt[] }>;
const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1];
const save = process.argv.includes('--save');

const webDir = path.join(root, 'web');
const server = await createServer({ root: webDir, configFile: path.join(webDir, 'vite.config.ts'), logLevel: 'error', server: { port: 5190, strictPort: false } });
await server.listen();
const base = server.resolvedUrls!.local[0]!;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage();
await page.goto(base);

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
const raw: Record<string, unknown> = {};
const rows: string[] = [];
for (const [file, t] of Object.entries(truth)) {
  if (only && !file.includes(only)) continue;
  const p = path.join(priv, file);
  if (!existsSync(p)) {
    rows.push(`${file}: missing`);
    continue;
  }
  const b64 = readFileSync(p).toString('base64');
  const t0 = Date.now();
  const res: any = await page.evaluate(
    async ({ save, b64, mime }) => {
      const blob = await (await fetch(`data:${mime};base64,${b64}`)).blob();
      const img = await createImageBitmap(blob);
      const url = '/src/receiptPipeline.ts';
      const m = await import(/* @vite-ignore */ url);
      return m.readReceiptImage(img, { keepOcr: save });
    },
    { save, b64, mime: MIME[path.extname(file).toLowerCase()] ?? 'image/png' },
  );
  const ms = Date.now() - t0;
  raw[file] = res;
  const segs: any[] = res.parsed.receipts?.length ? res.parsed.receipts : [res.parsed];
  // more truth receipts than parsed ones: compare the single parse against all truth items together
  const pairs: Array<[any, TruthReceipt]> =
    segs.length >= t.receipts.length ? t.receipts.map((tr, i) => [segs[i], tr]) : [[segs[0], { ...t.receipts[0]!, items: t.receipts.flatMap((r) => r.items) }]];
  const label = `${file}${t.generatedSample ? ' (generated sample)' : ''}`;
  rows.push(`${label}  [${t.kind}] path=${res.path} rotation=${res.rotation * 90}deg receipts=${segs.length}/${t.receipts.length} ${(ms / 1000).toFixed(1)}s`);
  pairs.forEach(([pr, tr], i) => {
    const s = scoreReceipt(pr, tr);
    const chk = pr.check ? (pr.check.matches == null ? 'no target' : pr.check.matches ? 'pass' : `off by $${(Math.abs(pr.check.gapCents ?? 0) / 100).toFixed(2)}`) : 'n/a';
    rows.push(`  #${i + 1}: items ${s.itemsCorrect}/${s.items}, prices ${s.pricesCorrect}/${s.items}, header ${s.headerCorrect}/${s.header}, false items ${s.falseItems}, self-check ${chk}`);
  });
}
await browser.close();
await server.close();
if (save) writeFileSync(path.join(priv, 'eval-last.json'), JSON.stringify(raw, null, 1));
console.log(rows.join('\n'));
