/**
 * LOCAL ONLY: measure OCR + parser accuracy on the private receipt photos in
 * data/receipts/private/ against the hand-typed ground truth there
 * (truth.json, gitignored). Prints counts only - never receipt text, unless
 * --show is passed (then it prints to this terminal only; never commit it).
 *   npx tsx scripts/receipt-accuracy.ts [--show]
 * Reads results produced by the browser flow when given --from-browser <json>.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Tesseract from 'tesseract.js';
import { parseWalmartReceipt, rowsFromWords, type OcrLine, type ParsedReceipt } from '@carttweak/shared';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'data', 'receipts', 'private');
const show = process.argv.includes('--show');
if (!existsSync(path.join(dir, 'truth.json'))) {
  console.log('No private receipts / truth.json; nothing to measure.');
  process.exit(0);
}
const truth = JSON.parse(readFileSync(path.join(dir, 'truth.json'), 'utf8')).receipts as Record<string, { items: Array<[string, number]>; zip: string | null; store: string; date: string }>;

/** Lines read correctly = truth items whose code AND price were both read, matched in order without reuse. */
export function score(parsed: ParsedReceipt, items: Array<[string, number]>) {
  const pool = parsed.items.map((i) => ({ code: i.code, price: i.priceCents, used: false }));
  let correct = 0;
  let codeOnly = 0;
  for (const [code, price] of items) {
    const hit = pool.find((p) => !p.used && p.code === code && p.price === price);
    if (hit) {
      hit.used = true;
      correct++;
      continue;
    }
    const c = pool.find((p) => !p.used && p.code === code);
    if (c) {
      c.used = true;
      codeOnly++;
    }
  }
  return { correct, codeOnly, total: items.length, parsedItems: parsed.items.length, unparsed: parsed.unparsed.length };
}

async function main() {
  const worker = await Tesseract.createWorker('eng');
  const psm = process.argv.includes('--psm6') ? Tesseract.PSM.SINGLE_BLOCK : Tesseract.PSM.AUTO;
  await worker.setParameters({ tessedit_pageseg_mode: psm, preserve_interword_spaces: '1' } as any);
  const mode = process.argv.includes('--lines') ? 'lines' : 'rows';
  console.log(`mode: ${mode}, psm ${psm}`);
  for (const file of readdirSync(dir).filter((f) => truth[f])) {
    const t0 = Date.now();
    const { data } = await worker.recognize(path.join(dir, file));
    const lines: OcrLine[] =
      mode === 'lines'
        ? (data.lines ?? []).map((l: any) => ({ text: l.text.replace(/\n$/, ''), confidence: Math.round(l.confidence) }))
        : rowsFromWords((data.words ?? []).map((w: any) => ({ text: w.text, confidence: w.confidence, bbox: w.bbox })));
    const parsed = parseWalmartReceipt(lines);
    const s = score(parsed, truth[file]!.items);
    const h = parsed.header;
    console.log(
      `${file}: ${s.correct}/${s.total} item lines read correctly (code+price), ${s.codeOnly} code-only; parser rows ${s.parsedItems}, unparsed ${s.unparsed}; ` +
        `header store ${h.storeNumber === truth[file]!.store ? 'ok' : 'wrong'}, zip ${h.zip === truth[file]!.zip ? 'ok' : 'wrong'}, date ${h.date === truth[file]!.date ? 'ok' : 'wrong'}; ` +
        `dropped ${JSON.stringify(parsed.dropped)}; ${((Date.now() - t0) / 1000).toFixed(1)} s`,
    );
    if (show) {
      for (const l of lines) console.log(`   [${String(l.confidence).padStart(3)}] ${l.text}`);
      for (const i of parsed.items) console.log(`   -> ${i.code} ${i.priceCents} ${i.issues.join('; ')}`);
    }
  }
  await worker.terminate();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
