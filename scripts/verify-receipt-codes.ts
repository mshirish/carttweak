/**
 * What is the item code printed on a Walmart receipt? Local check against
 * USDA FDC (and Walmart, when its auth works). Reads the PRIVATE ground-truth
 * codes from data/receipts/private/truth.json (gitignored) and prints only
 * aggregate counts - never receipt text.
 *   npx tsx scripts/verify-receipt-codes.ts
 * For each unique non-produce code it tests both readings:
 *   A. check digit already included (code is a full UPC-A / EAN-13)
 *   B. no check digit (code = UPC body; compute and append the GS1 check digit)
 * and asks FDC with an OR query of each reading's forms, accepting a record only
 * if its gtinUpc normalizes to the same GTIN-14.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { gs1CheckDigit, hasValidCheckDigit, isPlu, padTo, stripLeadingZeros, toGtin14 } from '@carttweak/shared';
import { cachedJson, setCacheRoot, TTL } from '../server/src/cache.ts';
import { registerSecret } from '../server/src/secrets.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env'), quiet: true } as any);
const key = process.env.FDC_API_KEY?.trim() ?? '';
registerSecret(key);
setCacheRoot(path.join(root, 'data', 'cache'));
const truthPath = path.join(root, 'data', 'receipts', 'private', 'truth.json');
if (!existsSync(truthPath)) {
  console.log('No private ground truth; nothing to check.');
  process.exit(0);
}
const truth = JSON.parse(readFileSync(truthPath, 'utf8'));

function readings(code: string) {
  const s = stripLeadingZeros(code);
  const A = s.length >= 2 && hasValidCheckDigit(s) ? padTo(s, 14) : null; // as printed, check digit included
  const B = s.length <= 13 ? padTo(s + String(gs1CheckDigit(s)), 14) : null; // check digit appended
  return { A, B, aValidCheckDigit: A != null };
}

async function fdcHas(gtin14: string): Promise<boolean> {
  const forms = [...new Set([padTo(gtin14.replace(/^0+/, ''), 12), padTo(gtin14.replace(/^0+/, ''), 13), gtin14].filter(Boolean))] as string[];
  const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(forms.join(' '))}&dataType=Branded&pageSize=25`;
  const r = await cachedJson<any>('fdc-search', url, {}, TTL.fdc, { service: 'fdc' });
  return (r.body?.foods ?? []).some((f: any) => f.gtinUpc && toGtin14(String(f.gtinUpc)) === gtin14);
}

const per: Record<string, any> = {};
const totals = { codes: 0, plu: 0, short: 0, aValid: 0, matchA: 0, matchB: 0, matchBoth: 0, neither: 0 };
for (const [file, r] of Object.entries<any>(truth.receipts)) {
  const codes = [...new Set<string>(r.items.map((i: [string, number]) => i[0]))];
  const row = { codes: codes.length, plu: 0, short: 0, aValid: 0, matchA: 0, matchB: 0, neither: 0 };
  for (const code of codes) {
    totals.codes++;
    if (isPlu(code)) {
      row.plu++;
      totals.plu++;
      continue;
    }
    if (code.length !== 12) {
      row.short++;
      totals.short++;
    }
    const { A, B, aValidCheckDigit } = readings(code);
    if (aValidCheckDigit) (row.aValid++, totals.aValid++);
    const a = A ? await fdcHas(A) : false;
    const b = B ? await fdcHas(B) : false;
    if (a) (row.matchA++, totals.matchA++);
    if (b) (row.matchB++, totals.matchB++);
    if (a && b) totals.matchBoth++;
    if (!a && !b) (row.neither++, totals.neither++);
  }
  per[file] = row;
}
console.log('Per receipt (unique codes):');
for (const [f, r] of Object.entries(per)) console.log(`  ${f}: ${JSON.stringify(r)}`);
console.log(`Totals: ${JSON.stringify(totals)}`);
console.log('A = code already has a valid check digit; B = check digit appended to the code.');
