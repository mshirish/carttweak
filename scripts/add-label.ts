/**
 * Add a manually transcribed Nutrition Facts label.
 *   npm run add-label
 * Prompts for the product, where the label came from (the product's page on
 * the chain's own website = retailer_listing, or a package photo =
 * label_observation), who transcribed it and when, the serving size (g or mL)
 * and the per-serving values. Blank = not on the label (stays unknown, never 0).
 * Shows the per-100 result and asks before appending to data/labels/labels.json
 * (LABELS_FILE overrides the path).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildLabelRecord, PER100_KEYS, type LabelEntryInput, type Per100Key } from '@carttweak/shared';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.env.LABELS_FILE ? path.resolve(process.env.LABELS_FILE) : path.join(root, 'data', 'labels', 'labels.json');

// line-queue prompt that also works when input is piped
const rl = readline.createInterface({ input: process.stdin, terminal: process.stdin.isTTY ?? false });
const lines: string[] = [];
const waiters: Array<(s: string | null) => void> = [];
let closed = false;
rl.on('line', (l) => (waiters.length ? waiters.shift()!(l) : lines.push(l)));
rl.on('close', () => {
  closed = true;
  while (waiters.length) waiters.shift()!(null);
});
function ask(q: string, def?: string): Promise<string> {
  process.stdout.write(`${q}${def ? ` [${def}]` : ''}: `);
  return new Promise((resolve) => {
    const done = (s: string | null) => {
      if (s == null) {
        console.log('\n(input ended)');
        process.exit(1);
      }
      if (!process.stdin.isTTY) console.log(s);
      resolve(s.trim() === '' && def != null ? def : s.trim());
    };
    if (lines.length) done(lines.shift()!);
    else if (closed) done(null);
    else waiters.push(done);
  });
}

const LABEL: Record<Per100Key, string> = {
  calories: 'Calories (kcal)',
  protein_g: 'Protein (g)',
  fiber_g: 'Dietary fiber (g)',
  addedSugars_g: 'Added sugars (g)',
  totalSugars_g: 'Total sugars (g)',
  sodium_mg: 'Sodium (mg)',
};

async function main() {
  console.log('Add a Nutrition Facts label. Blank value = not on the label (stays unknown).\n');
  const product = await ask('Kroger product id (13 digits, e.g. 0007225001137)');
  const kind = await ask('Source: 1 = product page on kroger.com (retailer_listing), 2 = package photo (label_observation)', '1');
  const source = kind === '2' ? 'label_observation' : 'retailer_listing';
  const sourceUrl = source === 'retailer_listing' ? await ask('Product page URL (https://www.kroger.com/p/...)') : undefined;
  const photoId = source === 'label_observation' ? await ask('Photo id / file name') : undefined;
  const today = new Date().toISOString().slice(0, 10);
  const transcribedAt = await ask('Transcribed on (YYYY-MM-DD)', today);
  const by = await ask('Transcribed by: 1 = demo author, 2 = shopper', '1');
  const servingSize = Number(await ask('Serving size (number)'));
  const servingUnit = (await ask('Serving unit (g or ml)', 'g')).toLowerCase();
  const perServing: Partial<Record<Per100Key, number | null>> = {};
  for (const k of PER100_KEYS) {
    const v = await ask(`${LABEL[k]} per serving`);
    perServing[k] = v === '' ? null : Number(v);
  }
  const input: LabelEntryInput = {
    product,
    source,
    sourceUrl,
    photoId,
    transcribedAt,
    transcribedBy: by === '2' ? 'shopper' : 'demo author',
    servingSize,
    servingUnit,
    perServing,
  };
  const { record, errors } = buildLabelRecord(input, today);
  if (!record) {
    console.error(`\nNot saved:\n  - ${errors.join('\n  - ')}`);
    process.exit(1);
  }
  console.log(`\nPer 100 ${record.basis} (from ${servingSize} ${servingUnit} serving):`);
  for (const k of PER100_KEYS) {
    const v = record.per100[k];
    console.log(`  ${LABEL[k].padEnd(18)} ${v == null ? 'unknown' : (Math.round(v * 100) / 100).toString()}`);
  }
  const ok = (await ask('\nSave this record? (y/n)', 'n')).toLowerCase();
  if (ok !== 'y' && ok !== 'yes') {
    console.log('Not saved.');
    process.exit(0);
  }
  const doc = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8'))
    : { _comment: 'Real Nutrition Facts transcribed by hand (npm run add-label). Not sample data.', records: [] };
  doc.records.push(record);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  console.log(`Saved to ${path.relative(root, file)} (${doc.records.length} record${doc.records.length === 1 ? '' : 's'}).`);
  rl.close();
}

main().catch((e) => {
  console.error(`add-label failed: ${e?.message ?? e}`);
  process.exit(1);
});
