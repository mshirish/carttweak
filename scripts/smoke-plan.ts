/**
 * Live smoke test: POST /api/plan with the 20-item list in docs/demo-list.txt.
 *   npm run smoke:plan
 * Goal more_fiber, secondary less_sodium, budget $2.00. Items tagged [lock] are
 * locked; [vague] items go in as typed (the server must not guess them).
 * Branch: DEMO_LOCATION_ID, else first store near DEMO_ZIP, else the list header's locationId.
 * Starts the server if it is not already running (and stops it afterwards).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env'), quiet: true } as any);
const SERVER = process.env.SMOKE_SERVER ?? `http://localhost:${process.env.PORT ?? 8787}`;
const TAGS = ['exact', 'vague', 'lock', 'store', 'nobar'] as const;

interface ListItem {
  id: string;
  quantity: number;
  query: string;
  tags: string[];
  why: string;
}

function parseList(file: string): { items: ListItem[]; headerLocationId: string | null } {
  const text = readFileSync(file, 'utf8');
  const headerLocationId = /locationId\s+(\w{8})/.exec(text)?.[1] ?? null;
  const items: ListItem[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#') || !line.includes('|')) continue;
    const [qty, query, tags, why] = line.split('|').map((s) => s.trim());
    const tagList = [...(tags ?? '').matchAll(/\[(\w+)\]/g)].map((m) => m[1]!);
    items.push({ id: `i${String(items.length + 1).padStart(2, '0')}`, quantity: Number(qty) || 1, query: query!, tags: tagList, why: why ?? '' });
  }
  return { items, headerLocationId };
}

async function up(): Promise<boolean> {
  try {
    return (await fetch(`${SERVER}/api/health`)).ok;
  } catch {
    return false;
  }
}

async function ensureServer(): Promise<ChildProcess | null> {
  if (await up()) return null;
  console.log(`(starting server at ${SERVER})`);
  const child = spawn(process.execPath, [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(root, 'server', 'src', 'index.ts')], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 40; i++) {
    if (await up()) return child;
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error('server did not start');
}

async function json(method: string, url: string, body?: unknown) {
  const r = await fetch(`${SERVER}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} -> HTTP ${r.status}: ${JSON.stringify(j.error ?? j)}`);
  return j;
}

const dollars = (c: number | null | undefined) => (c == null ? '-' : `${c < 0 ? '-' : '+'}$${(Math.abs(c) / 100).toFixed(2)}`);

async function main() {
  const { items, headerLocationId } = parseList(path.join(root, 'docs', 'demo-list.txt'));
  const child = await ensureServer();
  try {
    let locationId = process.env.DEMO_LOCATION_ID?.trim() || '';
    let how = 'DEMO_LOCATION_ID';
    if (!locationId && process.env.DEMO_ZIP?.trim()) {
      const loc = await json('GET', `/api/locations?zip=${encodeURIComponent(process.env.DEMO_ZIP.trim())}`);
      locationId = loc.stores[0]?.locationId ?? '';
      how = `first store near DEMO_ZIP (${loc.dropped.length} non-store locations dropped)`;
    }
    if (!locationId && headerLocationId) {
      locationId = headerLocationId;
      how = 'docs/demo-list.txt header (DEMO_LOCATION_ID and DEMO_ZIP are empty)';
    }
    if (!locationId) throw new Error('no location: set DEMO_LOCATION_ID or DEMO_ZIP');

    const locks = items.filter((i) => i.tags.includes('lock')).map((i) => i.id);
    const t0 = Date.now();
    const res = await json('POST', '/api/plan', {
      locationId,
      items: items.map((i) => ({ id: i.id, query: i.query, quantity: i.quantity })),
      goals: { primary: 'more_fiber', secondary: 'less_sodium' },
      locks,
      budget: { maxExtraSpendCents: 200 },
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const plan = res.plan;

    console.log(`\n=== CartTweak smoke plan ===`);
    console.log(`Branch: ${res.branch.name} (${res.branch.locationId}), ${res.branch.address}  [via ${how}]`);
    console.log(`Goal: more_fiber | secondary: less_sodium | budget: $2.00 | locked: ${locks.length} | items: ${items.length} | ${secs}s`);
    console.log(`Contains sample data: ${res.containsSample}`);

    console.log(`\n--- Swaps chosen (${plan.swaps.length}) ---`);
    if (!plan.swaps.length) console.log('  none');
    for (const s of plan.swaps) {
      const fiber = s.nutrients.find((n: any) => n.key === 'fiber_g');
      const sodium = s.nutrients.find((n: any) => n.key === 'sodium_mg');
      console.log(`  [${s.itemId}] ${s.original.description} (${s.original.sizeLabel}) -> ${s.replacement.description} (${s.replacement.sizeLabel})`);
      console.log(
        `      fiber/100${s.basis}: ${fiber.original?.toFixed(2)} -> ${fiber.replacement?.toFixed(2)} (+${s.goal.improvementPer100.toFixed(2)}), trip +${s.goal.tripImpact.toFixed(1)} g | ` +
          `sodium/100${s.basis}: ${sodium.original?.toFixed(0) ?? '?'} -> ${sodium.replacement?.toFixed(0) ?? '?'} | ` +
          `${s.packagesNeeded} pkg | regular ${dollars(s.cost.regular.differenceCents)}${s.cost.promo ? ` | promo line ${dollars(s.cost.promo.differenceCents)}` : ''}`,
      );
      for (const f of s.flags) console.log(`      flag ${f.code}: ${f.detail}`);
    }
    if (plan.combined) console.log(`  combined: ${dollars(plan.combined.differenceCents)} regular, +${plan.combined.tripImpact.toFixed(1)} g fiber across the trip`);

    console.log(`\n--- Plain English ---`);
    for (const l of res.explanations) console.log(`  * ${l}`);

    const outcome = (id: string) => plan.itemOutcomes.find((o: any) => o.itemId === id);
    const resol = (id: string) => res.resolution.find((r: any) => r.id === id);
    console.log(`\n--- Per tag group ---`);
    for (const tag of TAGS) {
      const group = items.filter((i) => i.tags.includes(tag));
      console.log(`\n[${tag}] ${group.length} items`);
      for (const i of group) {
        const r = resol(i.id);
        const o = outcome(i.id);
        const what =
          r.status === 'resolved'
            ? `resolved (${r.method}) -> ${r.description} [${r.size ?? 'size?'}]; FDC ${r.fdc?.matched ? r.fdc.fdcId : 'no match'}`
            : `${r.status}: ${r.detail}${r.candidates?.length ? ` (${r.candidates.length} options)` : ''}`;
        console.log(`  ${i.id} ${i.query}`);
        console.log(`      ${what}`);
        const cinfo = res.candidates[i.id];
        console.log(
          `      outcome: ${o.code}${o.code === 'swapped' ? '' : ` - ${o.detail}`}` +
            (cinfo?.group ? ` | group ${cinfo.group}: ${cinfo.found} candidates, ${cinfo.fdcMatched} with FDC` : ''),
        );
      }
    }

    const st = plan.stats;
    const resolvedByTag = Object.fromEntries(TAGS.map((t) => {
      const g = items.filter((i) => i.tags.includes(t));
      return [t, `${g.filter((i) => resol(i.id).status === 'resolved').length}/${g.length}`];
    }));
    console.log(`\n--- Stats ---`);
    console.log(`  resolved: ${st.resolved}/${st.items} (by tag: ${JSON.stringify(resolvedByTag)})`);
    console.log(`  candidates evaluated: ${st.candidatesEvaluated}, eligible options: ${st.eligibleOptions}`);
    console.log(`  candidate rejection reasons: ${JSON.stringify(st.candidateReasonCounts)}`);
    console.log(`  outcome codes: ${JSON.stringify(plan.itemOutcomes.reduce((m: any, o: any) => ((m[o.code] = (m[o.code] ?? 0) + 1), m), {}))}`);
    console.log(`  cache this request: ${JSON.stringify(res.cache)}`);
  } finally {
    child?.kill();
  }
}

main().catch((e) => {
  console.error(`smoke:plan failed: ${e?.message ?? e}`);
  process.exit(1);
});
