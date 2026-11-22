/**
 * Walmart Affiliate API probe.
 *   npm run probe:walmart
 * Looks up 5 demo-list products by UPC (no ZIP, DEMO_ZIP, a far ZIP), runs 2
 * searches (with and without zipCode), and calls the store locator. Records
 * which fields come back and whether price changes with ZIP. Never prints
 * headers, the signature or the key. Raw (redacted) responses go to
 * data/raw/<stamp>-walmart/ (gitignored).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { upcCandidates } from '@carttweak/shared';
import { setCacheRoot } from '../server/src/cache.ts';
import { redact, registerSecret } from '../server/src/secrets.ts';
import * as wm from '../server/src/walmart.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env'), quiet: true } as any);
registerSecret(process.env.WALMART_CONSUMER_ID?.trim());
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const rawDir = path.join(root, 'data', 'raw', `${stamp}-walmart`);
mkdirSync(rawDir, { recursive: true });
// probe runs in its own cache dir so every call is live
setCacheRoot(path.join(rawDir, 'cache'));

const ZIP = process.env.DEMO_ZIP?.trim() || '45202';
const FAR_ZIP = '10001';
// Kroger 13-digit ids from docs/demo-list.txt -> UPC-A with check digit
const PRODUCTS: Array<[string, string]> = [
  ['Wonder Classic White Bread 20 oz', '0007225001137'],
  ['Jif Creamy Peanut Butter 16 oz', '0005150025516'],
  ['Coca-Cola Soda Cans 12 pk', '0004900002890'],
  ["Lay's Classic Potato Chips 8 oz", '0002840019914'],
  ['General Mills Honey Nut Cheerios 10.8 oz', '0001600012479'],
];
const upcA = (krogerId: string) => upcCandidates(krogerId).find((c) => c.form === 'upca12+check')!.value;

let n = 0;
function save(label: string, r: { status: number; body: unknown; retrievedAt: string; sourceUrl: string }) {
  writeFileSync(path.join(rawDir, `${String(++n).padStart(2, '0')}-${label.replace(/[^a-z0-9]+/gi, '-')}.json`), redact(JSON.stringify(r, null, 2)));
}
const fieldsOf = (o: any) => (o && typeof o === 'object' ? Object.keys(o).sort() : []);

async function main() {
  const { config, reason } = wm.loadWalmartConfig(process.env, path.join(root, 'secrets', 'walmart_private_key.pem'));
  if (!config) {
    console.log(`Walmart not configured: ${reason}`);
    process.exit(2);
  }
  console.log(`Walmart probe ${new Date().toISOString()} (key version ${config.keyVersion}); ZIPs: none / ${ZIP} / ${FAR_ZIP}`);
  const summary: any = { date: new Date().toISOString(), lookups: [], searches: [], stores: null, itemFields: new Set<string>(), auth: null };

  for (const [name, kid] of PRODUCTS) {
    const upc = upcA(kid);
    const row: any = { name, krogerId: kid, upc, byZip: {} };
    for (const zip of [null, ZIP, FAR_ZIP]) {
      try {
        const r = await wm.itemsByUpc(config, upc, zip);
        save(`items-${upc}-${zip ?? 'nozip'}`, r);
        if (!summary.auth) summary.auth = { status: r.status, ok: r.ok, body: r.ok ? null : redact(JSON.stringify(r.body)).slice(0, 600) };
        const it = r.body?.items?.[0];
        for (const k of fieldsOf(it)) summary.itemFields.add(k);
        row.byZip[zip ?? 'none'] = r.ok
          ? { status: r.status, items: r.body?.items?.length ?? 0, itemId: it?.itemId, upc: it?.upc, name: it?.name, size: it?.size ?? null, salePrice: it?.salePrice ?? null, msrp: it?.msrp ?? null, stock: it?.stock ?? null, availableOnline: it?.availableOnline ?? null, offerType: it?.offerType ?? null, marketplace: it?.marketplace ?? null, sellerInfo: it?.sellerInfo ?? null }
          : { status: r.status, error: redact(JSON.stringify(r.body)).slice(0, 300) };
      } catch (e: any) {
        row.byZip[zip ?? 'none'] = { error: redact(String(e?.message ?? e)) };
      }
    }
    const prices = Object.values(row.byZip).map((x: any) => x.salePrice).filter((p) => p != null);
    row.priceVariesWithZip = prices.length < 2 ? 'unknown (fewer than 2 prices returned)' : new Set(prices).size > 1;
    summary.lookups.push(row);
    console.log(`\n${name} (UPC ${upc})`);
    for (const [z, v] of Object.entries<any>(row.byZip)) console.log(`  zip ${z.padEnd(5)} -> ${v.status ?? ''} ${v.error ?? `${v.name ?? '(no item)'} | size ${v.size} | $${v.salePrice} | ${v.stock} | ${v.offerType}`}`.slice(0, 220));
  }

  for (const term of ['whole grain bread', 'greek yogurt']) {
    for (const zip of [null, ZIP]) {
      try {
        const r = await wm.search(config, term, { numItems: 10, zipCode: zip });
        save(`search-${term}-${zip ?? 'nozip'}`, r);
        const items: any[] = r.body?.items ?? [];
        summary.searches.push({ term, zip, status: r.status, total: r.body?.totalResults ?? null, returned: items.length, topFields: fieldsOf(items[0]), sample: items.slice(0, 3).map((i) => ({ name: i.name, upc: i.upc ?? null, size: i.size ?? null, salePrice: i.salePrice ?? null })), error: r.ok ? null : redact(JSON.stringify(r.body)).slice(0, 300) });
        console.log(`\nsearch "${term}" zip=${zip ?? 'none'} -> ${r.status}, ${items.length} items (total ${r.body?.totalResults ?? '?'})`);
        for (const i of items.slice(0, 3)) console.log(`  ${i.upc ?? 'no upc'} | ${i.name} | size ${i.size ?? '-'} | $${i.salePrice ?? '-'}`.slice(0, 200));
      } catch (e: any) {
        summary.searches.push({ term, zip, error: redact(String(e?.message ?? e)) });
      }
    }
  }

  try {
    const r = await wm.stores(config, ZIP);
    save(`stores-${ZIP}`, r);
    const list: any[] = Array.isArray(r.body) ? r.body : r.body?.stores ?? [];
    summary.stores = { status: r.status, count: list.length, fields: fieldsOf(list[0]), first: list.slice(0, 3).map((s) => ({ no: s.no, name: s.name, streetAddress: s.streetAddress, city: s.city, zip: s.zip })), error: r.ok ? null : redact(JSON.stringify(r.body)).slice(0, 300) };
    console.log(`\nstores zip=${ZIP} -> ${r.status}, ${list.length} stores`);
    for (const s of list.slice(0, 3)) console.log(`  #${s.no} ${s.name} ${s.streetAddress}, ${s.city} ${s.zip}`);
  } catch (e: any) {
    summary.stores = { error: redact(String(e?.message ?? e)) };
  }

  summary.itemFields = [...summary.itemFields].sort();
  writeFileSync(path.join(rawDir, 'summary.json'), redact(JSON.stringify(summary, null, 2)));
  console.log(`\nAuth: HTTP ${summary.auth?.status}${summary.auth?.body ? ` ${summary.auth.body}` : ''}`);
  console.log(`Item fields seen: ${summary.itemFields.join(', ') || '(none)'}`);
  console.log(`Price varies with ZIP: ${summary.lookups.map((l: any) => `${l.upc}=${l.priceVariesWithZip}`).join(', ')}`);
  console.log(`Raw: ${path.relative(root, rawDir)}`);
}

main().catch((e) => {
  console.error(`probe failed: ${redact(String(e?.message ?? e))}`);
  process.exit(1);
});
