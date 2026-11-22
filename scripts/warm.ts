/**
 * Pre-fetch everything docs/demo-list.txt needs at the demo branch into the
 * cache, so a live demo plan is fast.
 *   npm run warm
 * Fetches, per list item: the Kroger search, every product the shopper might
 * pick (the match and all "which one?" options) by id, their FDC records, and
 * the candidate searches + FDC records for every swap group involved.
 * Prices are cached for 12 h: re-run within 12 h of a demo.
 * Uses the server's cache directory (CARTTWEAK_CACHE_DIR overrides it).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { parseDemoList, swapGroupFor, type Product } from '@carttweak/shared';
import { cacheStats, limiters, setCacheRoot } from '../server/src/cache.ts';
import { registerSecret } from '../server/src/secrets.ts';
import { CONCURRENCY, createService } from '../server/src/service.ts';
import { lookupByUpc } from '../server/src/fdc.ts';
import { isPlu, nonFoodGuess, parseReceipt, produceGuess } from '@carttweak/shared';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env'), quiet: true } as any);
const env = {
  id: process.env.KROGER_CLIENT_ID?.trim() ?? '',
  secret: process.env.KROGER_CLIENT_SECRET?.trim() ?? '',
  fdc: process.env.FDC_API_KEY?.trim() ?? '',
};
if (!env.id || !env.secret || !env.fdc) {
  console.error('Missing KROGER_CLIENT_ID / KROGER_CLIENT_SECRET / FDC_API_KEY in .env');
  process.exit(1);
}
[env.id, env.secret, env.fdc].forEach(registerSecret);
const cacheDir = process.env.CARTTWEAK_CACHE_DIR ? path.resolve(process.env.CARTTWEAK_CACHE_DIR) : path.join(root, 'data', 'cache');
setCacheRoot(cacheDir);
const svc = createService({ kroger: { clientId: env.id, clientSecret: env.secret }, fdcApiKey: env.fdc, sampleDir: path.join(root, 'data', 'sample') });

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  }));
}

async function main() {
  const t0 = Date.now();
  const list = parseDemoList(readFileSync(path.join(root, 'docs', 'demo-list.txt'), 'utf8'));
  const locationId = process.env.DEMO_LOCATION_ID?.trim() || list.headerLocationId;
  if (!locationId) throw new Error('no demo branch: set DEMO_LOCATION_ID or add "(locationId XXXXXXXX)" to the list header');
  const b = await svc.branch(locationId);
  console.log(`Warming ${list.items.length} demo items at ${b.name} (${locationId}) into ${path.relative(root, cacheDir) || cacheDir}`);

  // 1. searches + every product the shopper could pick
  const products = new Map<string, Product>();
  const statuses: Record<string, number> = {};
  await pool(list.items, CONCURRENCY, async (it) => {
    const s = await svc.search(it.query, locationId);
    statuses[s.resolution.status] = (statuses[s.resolution.status] ?? 0) + 1;
    const picks = s.resolution.chosen ? [s.resolution.chosen] : s.resolution.candidates;
    for (const n of picks) if (!n.noBarcode) products.set(n.product.ref, n.product);
    console.log(`  ${s.resolution.status.padEnd(10)} ${it.query}${s.resolution.chosen ? ` -> ${s.resolution.chosen.product.description} [${s.resolution.chosen.product.size?.label}]` : ` (${picks.length} options)`}`);
  });
  const t1 = Date.now();

  // 2. by-id lookups (the UI plans with product ids) + FDC for each
  let fdcMatched = 0;
  await pool([...products.values()], CONCURRENCY, async (p) => {
    try {
      const e = await svc.byUpc(p.chainProductId, locationId);
      if (e.fdc.matched) fdcMatched++;
    } catch (e: any) {
      console.log(`  ! ${p.description}: ${e?.message ?? e}`);
    }
  });
  const t2 = Date.now();

  // 3. candidates for every swap group involved
  const groups = new Map<string, Product>();
  for (const p of products.values()) {
    const g = swapGroupFor(p);
    if (g && !groups.has(g.id)) groups.set(g.id, p);
  }
  let candidates = 0;
  await Promise.all(
    [...groups.entries()].map(async ([id, p]) => {
      const c = await svc.candidatesFor(p, locationId);
      candidates += c.candidates.length;
      console.log(`  group ${id}: ${c.candidates.length} candidates (${c.candidates.filter((x) => x.fdc.matched).length} with FDC)`);
    }),
  );
  // 4. LOCAL ONLY: barcodes from the private receipt ground truth (data/receipts/private/truth.json, gitignored).
  //    Counts only: item names and codes are never printed.
  const truthPath = path.join(root, "data", "receipts", "private", "truth.json");
  if (existsSync(truthPath)) {
    const truth = JSON.parse(readFileSync(truthPath, "utf8"));
    const codes = [...new Set<string>(Object.values<any>(truth.receipts ?? {}).flatMap((r: any) => (r.items ?? []).map((i: [string, number]) => i[0])))].filter((c) => !isPlu(c) && c.length === 12);
    let atKroger = 0;
    let fdcOnly = 0;
    const rGroups = new Map<string, Product>();
    await pool(codes, CONCURRENCY, async (code) => {
      try {
        const e = await svc.byUpc(`0${code}`, locationId);
        atKroger++;
        const g = swapGroupFor(e.product);
        if (g && !groups.has(g.id) && !rGroups.has(g.id)) rGroups.set(g.id, e.product);
        await svc.scoreHaul({ locationId, items: [{ id: "w", krogerProductId: `0${code}` }] });
      } catch {
        const f = await lookupByUpc(env.fdc, `0${code}`).catch(() => null);
        if (f?.match) fdcOnly++;
      }
    });
    await Promise.all([...rGroups.values()].map((p) => svc.candidatesFor(p, locationId).catch(() => null)));
    console.log(`  private receipts: ${codes.length} barcodes warmed (${atKroger} carried at this Kroger, ${fdcOnly} USDA-only), ${rGroups.size} more swap groups`);
  }
  // 5. LOCAL ONLY: Kroger receipt name searches from saved OCR lines (data/receipts/private/ocr-*.json, gitignored).
  //    Warms the search for every parsed line and the label of every offered candidate. Counts only.
  const privDir = path.join(root, 'data', 'receipts', 'private');
  const ocrFiles = existsSync(privDir) ? readdirSync(privDir).filter((f) => /^ocr-.*\.json$/.test(f)) : [];
  for (const f of ocrFiles) {
    const parsed = parseReceipt(JSON.parse(readFileSync(path.join(privDir, f), 'utf8')));
    const items = parsed.items.map((i) => ({ id: i.id, name: i.name, searchTerm: i.searchTerm, quantity: i.quantity, priceCents: i.priceCents, skipSearch: i.weightLb != null || !!produceGuess(i.name, null) || nonFoodGuess(i.name) }));
    if (!items.length) continue;
    const m: any = await svc.matchReceipt({ locationId, items }).catch(() => null);
    const cands: string[] = [...new Set<string>((m?.items ?? []).flatMap((x: any) => (x.candidates ?? []).map((c: any) => c.krogerProductId)).filter(Boolean))];
    await pool(cands, CONCURRENCY, async (id) => void (await svc.scoreHaul({ locationId, items: [{ id: 'k', krogerProductId: id }] }).catch(() => null)));
    console.log(`  kroger receipt ${parsed.items.length} lines: ${items.filter((i) => !i.skipSearch).length} searched, ${cands.length} candidates warmed`);
  }
  const t3 = Date.now();
  const fdc = limiters['fdc'];
  console.log(`\nWarm done in ${((t3 - t0) / 1000).toFixed(1)} s (search ${((t1 - t0) / 1000).toFixed(1)} s, products ${((t2 - t1) / 1000).toFixed(1)} s, candidates ${((t3 - t2) / 1000).toFixed(1)} s)`);
  console.log(`  list: ${JSON.stringify(statuses)}`);
  console.log(`  ${products.size} pickable products (${fdcMatched} with FDC), ${groups.size} swap groups, ${candidates} candidates`);
  console.log(`  cache: ${cacheStats.hits} hits, ${cacheStats.liveCalls} live calls, ${cacheStats.throttled} throttled (429)` + (fdc?.remaining != null ? `, FDC rate limit remaining ${fdc.remaining}` : ''));
  console.log('  Prices stay fresh for 12 h; FDC records for 7 days.');
}

main().catch((e) => {
  console.error(`warm failed: ${e?.message ?? e}`);
  process.exit(1);
});
