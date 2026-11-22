/**
 * LOCAL: re-parse the OCR saved by `npm run receipts:eval -- --save` with the
 * current parser, without running OCR again (fast parser iteration).
 *   npx tsx scripts/receipts-replay.ts [--only=kroger-2] [--rows]
 * Counts only. --rows prints row SHAPES (letters -> a, digits -> 9) with the
 * row kind, never the text itself.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReceiptBlocks, parseScore, rowsFromWords, type OcrLine } from '@carttweak/shared';
import { scoreReceipt, type TruthReceipt } from './receipt-score.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const priv = path.join(root, 'data', 'receipts', 'private');
const evalPath = path.join(priv, 'eval-last.json');
if (!existsSync(evalPath)) {
  console.error('Run `npm run receipts:eval -- --save` first.');
  process.exit(1);
}
const saved = JSON.parse(readFileSync(evalPath, 'utf8')) as Record<string, any>;
const truth = JSON.parse(readFileSync(path.join(priv, 'truth-kroger.json'), 'utf8')).receipts as Record<string, { receipts: TruthReceipt[] }>;
const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1];
const showRows = process.argv.includes('--rows');
export const mask = (t: string) => t.replace(/[A-Za-z]/g, 'a').replace(/\d/g, '9').replace(/a{2,}/g, (m) => `a${m.length}`);

for (const [file, res] of Object.entries(saved)) {
  if (only && !file.includes(only)) continue;
  const t = truth[file];
  if (!t || !res.ocr) continue;
  console.log(file);
  for (const o of res.ocr as Array<{ rotation: number; lines: OcrLine[]; boxes: any[] }>) {
    const rows = rowsFromWords(o.boxes);
    for (const [pathName, blocks] of [['lines', [o.lines]], ['rows', rows.blocks]] as const) {
      const parsed = parseReceiptBlocks(blocks as OcrLine[][]);
      const segs = parsed.receipts?.length ? parsed.receipts : [parsed];
      const pairs: Array<[any, TruthReceipt]> =
        segs.length >= t.receipts.length ? t.receipts.map((tr, i) => [segs[i], tr]) : [[segs[0], { ...t.receipts[0]!, items: t.receipts.flatMap((r) => r.items) }]];
      const scores = pairs.map(([p, tr]) => scoreReceipt(p, tr));
      const fmt = scores.map((s, i) => {
        const p = pairs[i]![0];
        const chk = p.check?.matches == null ? 'none' : p.check.matches ? 'pass' : `gap ${p.check.gapCents ?? '?'}`;
        return `#${i + 1} items ${s.itemsCorrect}/${s.items} prices ${s.pricesCorrect}/${s.items} header ${s.headerCorrect}/3 false ${s.falseItems} check ${chk}`;
      });
      console.log(`  rot ${o.rotation * 90} ${pathName.padEnd(5)} skew ${pathName === 'rows' ? rows.angle.toFixed(1) : '-'} score ${Math.round(parseScore(parsed))} receipts ${segs.length}: ${fmt.join(' | ')}`);
      if (showRows) {
        for (const [bi, b] of (blocks as OcrLine[][]).entries()) {
          console.log(`    block ${bi}`);
          for (const r of b) console.log(`      ${String(r.confidence).padStart(3)} ${mask(r.text).slice(0, 90)}`);
        }
      }
    }
  }
}
