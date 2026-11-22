/**
 * Milestone-1 data probe: Kroger (branch + prices) x USDA FDC (nutrition by barcode).
 * Produces ONE verified comparison or an exact per-product account of why not.
 *
 *   npm run probe:kroger-fdc
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import {
  checkoutDifference,
  compareAll,
  compareNutrient,
  crossCheckPackageWeight,
  effectivePrice,
  fromFdcLabelNutrients,
  hasPromo,
  regularPrice,
  type PackageWeightCheck,
  matchBarcodes,
  parsePackageSize,
  toPer100,
  upcCandidates,
  type CandidateForm,
  type CheckDigitInterpretation,
  type NutrientKey,
  type ParsedSize,
  type Per100,
} from '@carttweak/shared';
import { fdcDateToIso, latestFdcDate } from './lib/fdc-date.ts';
import { httpJson, initRawDir } from './lib/http.ts';
import { publicUrl, redact, registerSecret } from './lib/redact.ts';

// ---------- setup ----------
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env'), quiet: true } as any);

const env = {
  KROGER_CLIENT_ID: process.env.KROGER_CLIENT_ID?.trim() ?? '',
  KROGER_CLIENT_SECRET: process.env.KROGER_CLIENT_SECRET?.trim() ?? '',
  FDC_API_KEY: process.env.FDC_API_KEY?.trim() ?? '',
  DEMO_ZIP: process.env.DEMO_ZIP?.trim() ?? '',
  DEMO_LOCATION_ID: process.env.DEMO_LOCATION_ID?.trim() ?? '',
};
// Only real secrets are registered (ZIP / location ID are not secret and must stay visible).
[env.KROGER_CLIENT_ID, env.KROGER_CLIENT_SECRET, env.FDC_API_KEY].forEach(registerSecret);
const missing = (['KROGER_CLIENT_ID', 'KROGER_CLIENT_SECRET', 'FDC_API_KEY', 'DEMO_ZIP'] as const).filter((k) => !env[k]);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(', ')}`);
  process.exit(1);
}

const log = (...a: unknown[]) => console.log(...a.map((x) => (typeof x === 'string' ? redact(x) : x)));
const fail = (msg: string): never => {
  console.error(redact(msg));
  process.exit(1);
};

const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
initRawDir(path.join(root, 'data', 'raw', runStamp));

const KROGER = 'https://api.kroger.com/v1';
const FDC = 'https://api.nal.usda.gov/fdc/v1';
const round = (n: number | null, d = 2) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

// ---------- search plan ----------
type Side = 'original' | 'replacement';
interface PairSpec {
  id: string;
  goal: string;
  targets: Array<{ nutrient: NutrientKey; better: 'lower' | 'higher' }>; // priority order
  terms: Record<Side, string[]>;
  filters: Record<Side, (desc: string) => boolean>;
}
const has = (re: RegExp) => (d: string) => re.test(d);
const all =
  (...fs: Array<(d: string) => boolean>) =>
  (d: string) =>
    fs.every((f) => f(d));
const not = (f: (d: string) => boolean) => (d: string) => !f(d);

const PAIRS: PairSpec[] = [
  {
    id: 'yogurt',
    goal: 'less added sugar (fallback: more protein)',
    targets: [
      { nutrient: 'addedSugars', better: 'lower' },
      { nutrient: 'protein', better: 'higher' },
    ],
    terms: { original: ['vanilla yogurt'], replacement: ['plain greek yogurt'] },
    filters: {
      original: all(has(/yogurt/i), has(/vanilla/i)),
      replacement: all(has(/yogurt/i), has(/plain/i), has(/greek/i), not(has(/vanilla/i))),
    },
  },
  {
    id: 'bread',
    goal: 'more fiber',
    targets: [{ nutrient: 'fiber', better: 'higher' }],
    terms: { original: ['white bread'], replacement: ['whole grain bread'] },
    filters: {
      original: all(has(/bread/i), has(/white/i), not(has(/whole|wheat|grain|bun|crumb/i))),
      replacement: all(has(/bread/i), has(/whole\s*(grain|wheat)|100%\s*whole/i), not(has(/bun|crumb/i))),
    },
  },
  {
    id: 'pasta',
    goal: 'more fiber',
    targets: [{ nutrient: 'fiber', better: 'higher' }],
    terms: { original: [], replacement: [] }, // filled only by fallback terms
    filters: {
      original: all(has(/spaghetti/i), not(has(/whole|wheat|grain|protein|sauce|gluten/i))),
      replacement: all(has(/spaghetti/i), has(/whole\s*(grain|wheat)/i)),
    },
  },
];
// Up to 3 extra terms if no pair qualifies.
const FALLBACK_TERMS: Array<{ pairId: string; side: Side; term: string }> = [
  { pairId: 'yogurt', side: 'replacement', term: 'nonfat plain greek yogurt' },
  { pairId: 'pasta', side: 'original', term: 'spaghetti pasta' },
  { pairId: 'pasta', side: 'replacement', term: 'whole wheat spaghetti' },
];

// ---------- types ----------
type LookupMethod = 'barcode' | 'brand+description';
interface FdcMatch {
  fdcId: number;
  lookupMethod: LookupMethod;
  /** the search text that surfaced the record (UPC form, or brand + description) */
  query: string;
  candidateForm: CandidateForm | null; // null when found by brand + description
  candidateValue: string | null;
  interpretation: CheckDigitInterpretation;
  gtin14: string;
  matchingRecords: number;
  detail: {
    description: string | null;
    brandOwner: string | null;
    brandName: string | null;
    gtinUpc: string | null;
    servingSize: number | null;
    servingSizeUnit: string | null;
    householdServingFullText: string | null;
    packageWeight: string | null;
    publishedDate: string | null;
    modifiedDate: string | null;
    availableDate: string | null;
    dataSource: string | null;
    labelNutrients: Record<string, number | null>;
    foodNutrientsPer100: Record<string, number | null>;
  };
  per100: Per100;
  searchUrl: string;
  detailUrl: string;
  pageUrl: string;
  retrievedAt: string;
}

interface ProbedProduct {
  pairId: string;
  side: Side;
  term: string;
  onTarget: boolean;
  productId: string;
  upc: string | null;
  brand: string | null;
  description: string | null;
  size: string | null;
  sizeParsed: ParsedSize | null;
  sizeCheck: PackageWeightCheck | null;
  price: { regular: number | null; promo: number | null } | null;
  fulfillment: Record<string, boolean> | null;
  itemCount: number;
  productPageURI: string | null;
  krogerSearchUrl: string;
  krogerRetrievedAt: string;
  raw: unknown;
  fdc: FdcMatch | null;
  fdcTried: Array<{ method: LookupMethod; form: CandidateForm | null; value: string; status: number; results: number; hits: number }>;
  issues: string[];
}

// ---------- Kroger ----------
async function krogerToken(): Promise<string> {
  const basic = Buffer.from(`${env.KROGER_CLIENT_ID}:${env.KROGER_CLIENT_SECRET}`).toString('base64');
  const r = await httpJson<any>(`${KROGER}/connect/oauth2/token`, {
    label: 'kroger-token',
    save: false, // body contains the token
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'product.compact' }).toString(),
  });
  if (!r.ok || !r.body?.access_token) {
    fail(`Kroger auth failed: HTTP ${r.status}\n${redact(r.body)}`);
  }
  registerSecret(r.body.access_token);
  log(`Kroger auth OK (expires_in=${r.body.expires_in}s, scope=${r.body.scope ?? 'n/a'})`);
  return r.body.access_token as string;
}

async function krogerLocations(token: string) {
  const url = `${KROGER}/locations?filter.zipCode.near=${encodeURIComponent(env.DEMO_ZIP)}&filter.limit=5`;
  const r = await httpJson<any>(url, {
    label: 'kroger-locations',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!r.ok) fail(`Kroger locations failed: HTTP ${r.status}\n${redact(r.body)}`);
  const locs: any[] = r.body?.data ?? [];
  if (!locs.length) fail(`No Kroger-family locations near ZIP ${env.DEMO_ZIP}`);
  log(`\nLocations near ${env.DEMO_ZIP}:`);
  for (const l of locs) {
    const a = l.address ?? {};
    log(`  ${l.locationId}  ${l.chain}  ${l.name}  — ${a.addressLine1}, ${a.city}, ${a.state} ${a.zipCode}`);
  }
  let chosen = locs[0];
  if (env.DEMO_LOCATION_ID) {
    chosen = locs.find((l) => l.locationId === env.DEMO_LOCATION_ID);
    if (!chosen) {
      // fetch directly
      const d = await httpJson<any>(`${KROGER}/locations/${encodeURIComponent(env.DEMO_LOCATION_ID)}`, {
        label: 'kroger-location-pinned',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (!d.ok || !d.body?.data) fail(`DEMO_LOCATION_ID ${env.DEMO_LOCATION_ID} not found: HTTP ${d.status}`);
      chosen = d.body.data;
    }
  }
  log(`Demo branch: ${chosen.locationId} (${chosen.chain} ${chosen.name})`);
  return { chosen, url: url, retrievedAt: r.retrievedAt };
}

async function krogerSearch(token: string, locationId: string, term: string) {
  const url =
    `${KROGER}/products?filter.term=${encodeURIComponent(term)}` +
    `&filter.locationId=${encodeURIComponent(locationId)}&filter.limit=10`;
  const r = await httpJson<any>(url, {
    label: `kroger-products-${term}`,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!r.ok) {
    log(`  ! Kroger product search "${term}" failed: HTTP ${r.status} ${redact(r.body).slice(0, 300)}`);
    return { products: [] as any[], url, retrievedAt: r.retrievedAt };
  }
  return { products: (r.body?.data ?? []) as any[], url, retrievedAt: r.retrievedAt };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ---------- FDC ----------
// FDC nutrient numbers for the per-100 g cross-check (foodNutrients is reported per 100 g/mL for Branded).
const FDC_NUTRIENT_NUMBERS: Record<NutrientKey, string> = {
  calories: '208',
  protein: '203',
  fiber: '291',
  addedSugars: '539',
  sugars: '269',
  sodium: '307',
};

const fdcSearchCache = new Map<string, { status: number; foods: any[]; url: string }>();

async function fdcSearch(query: string) {
  const cached = fdcSearchCache.get(query);
  if (cached) return cached;
  const url =
    `${FDC}/foods/search?api_key=${encodeURIComponent(env.FDC_API_KEY)}` +
    `&query=${encodeURIComponent(query)}&dataType=Branded&pageSize=50`;
  const r = await httpJson<any>(url, { label: `fdc-search-${query}` });
  const out = { status: r.status, foods: (r.ok ? r.body?.foods : []) ?? [], url };
  fdcSearchCache.set(query, out);
  return out;
}

/** Brand + description query; strips size text and punctuation FDC search chokes on. */
function brandDescQuery(p: ProbedProduct): string | null {
  const desc = (p.description ?? '').replace(/\b\d+(\.\d+)?\s*(oz|fl oz|lb|ct|g|ml|pk)\b/gi, ' ');
  const brand = p.brand ?? '';
  const q = `${brand} ${desc.replace(new RegExp(`^${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '')}`
    .replace(/[®™©"'’]/g, '')
    .replace(/[^\p{L}\p{N}%&\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return q.length >= 3 ? q : null;
}

async function fdcLookup(p: ProbedProduct): Promise<void> {
  if (!p.upc) {
    p.issues.push('no UPC on Kroger product');
    return;
  }
  const attempts: Array<{ method: LookupMethod; form: CandidateForm | null; value: string }> = upcCandidates(p.upc).map((c) => ({
    method: 'barcode' as const,
    form: c.form,
    value: c.value,
  }));
  const bd = brandDescQuery(p);
  if (bd) attempts.push({ method: 'brand+description', form: null, value: bd });

  for (const att of attempts) {
    const s = await fdcSearch(att.value);
    if (s.status === 403 || s.status === 401) fail(`FDC rejected API key: HTTP ${s.status}`);
    // A record counts ONLY if its gtinUpc normalizes to the Kroger UPC's GTIN-14, whichever search found it.
    const matches = s.foods
      .map((f: any) => ({ f, m: f.gtinUpc ? matchBarcodes(p.upc!, String(f.gtinUpc)) : null }))
      .filter((x: any) => x.m);
    p.fdcTried.push({ method: att.method, form: att.form, value: att.value, status: s.status, results: s.foods.length, hits: matches.length });
    if (!matches.length) continue;
    // most recently published/modified record wins (dates normalized to ISO; FDC mixes M/D/YYYY and YYYY-MM-DD)
    const recency = (f: any) => latestFdcDate(f.modifiedDate, f.publishedDate) ?? '';
    matches.sort((a: any, b: any) => recency(b.f).localeCompare(recency(a.f)));
    const best = matches[0]!;
    const fdcId = best.f.fdcId as number;
    const detailUrl = `${FDC}/food/${fdcId}?api_key=${encodeURIComponent(env.FDC_API_KEY)}`;
    const d = await httpJson<any>(detailUrl, { label: `fdc-food-${fdcId}` });
    if (!d.ok) {
      p.issues.push(`FDC detail ${fdcId} failed: HTTP ${d.status}`);
      return;
    }
    const food = d.body;
    // re-verify the barcode on the detail record itself
    const verify = food.gtinUpc ? matchBarcodes(p.upc, String(food.gtinUpc)) : null;
    if (!verify) {
      p.issues.push(`FDC detail ${fdcId} gtinUpc ${food.gtinUpc} does not match on re-check`);
      return;
    }
    const ln = food.labelNutrients ?? {};
    const perServing = fromFdcLabelNutrients(ln);
    const per100 = toPer100({
      servingSize: num(food.servingSize),
      servingSizeUnit: food.servingSizeUnit ?? null,
      perServing,
    });
    const foodNutrientsPer100: Record<string, number | null> = {};
    for (const [k, number] of Object.entries(FDC_NUTRIENT_NUMBERS)) {
      const fn = (food.foodNutrients ?? []).find((x: any) => String(x?.nutrient?.number) === number);
      foodNutrientsPer100[k] = fn ? num(fn.amount) : null;
    }
    p.fdc = {
      fdcId,
      lookupMethod: att.method,
      query: att.value,
      candidateForm: att.form,
      candidateValue: att.method === 'barcode' ? att.value : null,
      interpretation: verify.interpretation,
      gtin14: verify.gtin14,
      matchingRecords: matches.length,
      detail: {
        description: food.description ?? null,
        brandOwner: food.brandOwner ?? null,
        brandName: food.brandName ?? null,
        gtinUpc: food.gtinUpc ?? null,
        servingSize: num(food.servingSize),
        servingSizeUnit: food.servingSizeUnit ?? null,
        householdServingFullText: food.householdServingFullText ?? null,
        packageWeight: food.packageWeight ?? best.f.packageWeight ?? null,
        publishedDate: fdcDateToIso(food.publicationDate ?? food.publishedDate ?? best.f.publishedDate),
        modifiedDate: fdcDateToIso(food.modifiedDate ?? best.f.modifiedDate),
        availableDate: fdcDateToIso(food.availableDate),
        dataSource: food.dataSource ?? null,
        labelNutrients: perServing as Record<string, number | null>,
        foodNutrientsPer100,
      },
      per100,
      searchUrl: publicUrl(s.url),
      detailUrl: publicUrl(detailUrl),
      pageUrl: `https://fdc.nal.usda.gov/food-details/${fdcId}/nutrients`,
      retrievedAt: d.retrievedAt,
    };
    if (per100.basis == null) {
      p.issues.push(`FDC serving size not convertible to g/mL (${food.servingSize} ${food.servingSizeUnit})`);
    }
    return;
  }
  p.issues.push(
    `no FDC Branded record with matching GTIN-14 (tried ${p.fdcTried.length} searches: ` +
      `${p.fdcTried.filter((t) => t.method === 'barcode').length} barcode forms` +
      `${bd ? ' + brand/description' : ''}; ${p.fdcTried.reduce((n, t) => n + t.results, 0)} records returned, none with this GTIN)`,
  );
}

/**
 * Multipack sizes are inferred (N x per-unit). If FDC states a packageWeight
 * that disagrees by >10%, the size is treated as unparseable.
 */
function applySizeCheck(p: ProbedProduct): void {
  if (!p.sizeParsed || p.sizeParsed.sizeBasis !== 'inferred_per_unit') return;
  const check = crossCheckPackageWeight(p.sizeParsed, p.fdc?.detail.packageWeight ?? null);
  p.sizeCheck = check;
  if (check.status === 'disagree') {
    log(`    ! size rejected for ${p.productId}: ${check.reason}`);
    p.issues.push(`unparseable size: inferred multipack total disagrees with FDC packageWeight — ${check.reason}`);
    p.sizeParsed = null;
  }
}

// ---------- main ----------
async function main() {
  const token = await krogerToken();
  const { chosen: branch, url: locationsUrl, retrievedAt: branchRetrievedAt } = await krogerLocations(token);
  const locationId: string = branch.locationId;

  const probed = new Map<string, ProbedProduct>(); // key: pairId|side|productId
  const uniqueProducts = new Map<string, ProbedProduct>(); // productId -> first seen
  const termsSearched: string[] = [];

  async function runTerm(pair: PairSpec, side: Side, term: string) {
    termsSearched.push(term);
    log(`\nSearch [${pair.id}/${side}] "${term}"`);
    const { products, url, retrievedAt } = await krogerSearch(token, locationId, term);
    log(`  ${products.length} results`);
    for (const raw of products) {
      const key = `${pair.id}|${side}|${raw.productId}`;
      if (probed.has(key)) continue;
      const item = (raw.items ?? [])[0] ?? null;
      const desc: string = raw.description ?? '';
      const p: ProbedProduct = {
        pairId: pair.id,
        side,
        term,
        onTarget: pair.filters[side](desc),
        productId: raw.productId,
        upc: raw.upc ?? null,
        brand: raw.brand ?? null,
        description: raw.description ?? null,
        size: item?.size ?? null,
        sizeParsed: parsePackageSize(item?.size ?? null),
        sizeCheck: null,
        price: item?.price ? { regular: num(item.price.regular), promo: num(item.price.promo) } : null,
        fulfillment: item?.fulfillment ?? null,
        itemCount: (raw.items ?? []).length,
        productPageURI: raw.productPageURI ?? null,
        krogerSearchUrl: url,
        krogerRetrievedAt: retrievedAt,
        raw,
        fdc: null,
        fdcTried: [],
        issues: [],
      };
      if (!p.onTarget) p.issues.push(`off-target search result for ${pair.id}/${side}`);
      if (!regularPrice(p.price)) p.issues.push(effectivePrice(p.price) ? 'no regular price (promo only)' : 'no price at this branch');
      if (!p.sizeParsed) p.issues.push(`unparseable size "${p.size}"`);
      const prior = uniqueProducts.get(p.productId);
      if (prior) {
        p.fdc = prior.fdc;
        p.fdcTried = prior.fdcTried;
        p.issues.push(...prior.issues.filter((i) => /FDC|UPC/.test(i)));
      } else {
        await fdcLookup(p);
        uniqueProducts.set(p.productId, p);
      }
      applySizeCheck(p);
      probed.set(key, p);
      const f = p.fdc;
      log(
        `  - ${p.productId} upc=${p.upc} ${p.brand ?? '?'} | ${p.description} | ${p.size ?? '?'} | ` +
          `$${p.price?.regular ?? '?'}${p.price?.promo ? ` promo $${p.price.promo}` : ''}` +
          (p.sizeParsed?.sizeBasis === 'inferred_per_unit' ? ' (inferred size)' : '') +
          (f ? ` | FDC ${f.fdcId} via ${f.lookupMethod}${f.candidateForm ? `:${f.candidateForm}` : ''}` : ' | FDC: none') +
          (p.issues.length ? `  [${p.issues.join('; ')}]` : ''),
      );
    }
  }

  for (const pair of PAIRS) {
    for (const side of ['original', 'replacement'] as Side[]) {
      for (const term of pair.terms[side]) await runTerm(pair, side, term);
    }
  }

  function findBest() {
    type Candidate = {
      pair: PairSpec;
      original: ProbedProduct;
      replacement: ProbedProduct;
      target: { nutrient: NutrientKey; better: 'lower' | 'higher' };
      improvement: number;
      checkout: NonNullable<ReturnType<typeof checkoutDifference>>;
      checkoutPromo: ReturnType<typeof checkoutDifference>;
      bothExplicit: boolean;
    };
    const cands: Candidate[] = [];
    const rejections: string[] = [];
    for (const pair of PAIRS) {
      const sideList = (side: Side) => [...probed.values()].filter((p) => p.pairId === pair.id && p.side === side);
      const qualifies = (p: ProbedProduct) => p.onTarget && regularPrice(p.price) && p.sizeParsed && p.fdc && p.fdc.per100.basis;
      const origs = sideList('original').filter(qualifies);
      const repls = sideList('replacement').filter(qualifies);
      for (const o of origs) {
        for (const r of repls) {
          if (o.productId === r.productId) continue;
          if (o.sizeParsed!.basis !== r.sizeParsed!.basis) continue;
          for (const t of pair.targets) {
            const c = compareNutrient(o.fdc!.per100, r.fdc!.per100, t.nutrient);
            if (c.delta == null) {
              rejections.push(`${pair.id}: ${o.productId} vs ${r.productId} — ${t.nutrient} unknown (${c.reason})`);
              continue;
            }
            const improvement = t.better === 'lower' ? -c.delta : c.delta;
            if (!(improvement > 0)) {
              rejections.push(`${pair.id}: ${o.productId} vs ${r.productId} — ${t.nutrient} not improved`);
              continue;
            }
            const checkout = checkoutDifference({
              originalSize: o.sizeParsed,
              originalPrice: o.price,
              replacementSize: r.sizeParsed,
              replacementPrice: r.price,
            });
            if (!checkout) continue;
            const checkoutPromo =
              hasPromo(o.price) || hasPromo(r.price)
                ? checkoutDifference({
                    originalSize: o.sizeParsed,
                    originalPrice: o.price,
                    replacementSize: r.sizeParsed,
                    replacementPrice: r.price,
                    priceMode: 'with_promo',
                  })
                : null;
            const bothExplicit = o.sizeParsed!.sizeBasis === 'explicit' && r.sizeParsed!.sizeBasis === 'explicit';
            cands.push({ pair, original: o, replacement: r, target: t, improvement, checkout, checkoutPromo, bothExplicit });
            break; // use the highest-priority target that is known
          }
        }
      }
    }
    // Prefer both sizes explicit, then primary target, then cheapest checkout difference, then biggest improvement.
    cands.sort(
      (a, b) =>
        Number(b.bothExplicit) - Number(a.bothExplicit) ||
        a.pair.targets.indexOf(a.target) - b.pair.targets.indexOf(b.target) ||
        a.checkout.differenceCents - b.checkout.differenceCents ||
        b.improvement - a.improvement,
    );
    return { best: cands[0] ?? null, count: cands.length, rejections };
  }

  let { best, count, rejections } = findBest();
  let fallbacksUsed = 0;
  while (!best && fallbacksUsed < FALLBACK_TERMS.length) {
    const fb = FALLBACK_TERMS[fallbacksUsed++]!;
    log(`\nNo qualifying pair yet — fallback term ${fallbacksUsed}/3`);
    await runTerm(PAIRS.find((p) => p.id === fb.pairId)!, fb.side, fb.term);
    ({ best, count, rejections } = findBest());
  }

  // ---------- stats ----------
  const uniq = [...uniqueProducts.values()];
  const withUpc = uniq.filter((p) => p.upc);
  const matched = uniq.filter((p) => p.fdc);
  const formCounts: Record<string, number> = {};
  const interpCounts: Record<string, number> = {};
  const methodCounts: Record<string, number> = {};
  for (const p of matched) {
    methodCounts[p.fdc!.lookupMethod] = (methodCounts[p.fdc!.lookupMethod] ?? 0) + 1;
    const form = p.fdc!.candidateForm ?? '(brand+description)';
    formCounts[form] = (formCounts[form] ?? 0) + 1;
    interpCounts[p.fdc!.interpretation] = (interpCounts[p.fdc!.interpretation] ?? 0) + 1;
  }
  const krogerUpcLengths: Record<string, number> = {};
  for (const p of withUpc) krogerUpcLengths[String(p.upc!.length)] = (krogerUpcLengths[String(p.upc!.length)] ?? 0) + 1;
  const nutrientKnown = (k: NutrientKey) => matched.filter((p) => p.fdc!.per100.values[k] != null).length;
  const stats = {
    uniqueProducts: uniq.length,
    withUpc: withUpc.length,
    fdcMatched: matched.length,
    matchRate: uniq.length ? round(matched.length / uniq.length, 3) : null,
    matchedByLookupMethod: methodCounts,
    matchedByCandidateForm: formCounts,
    matchedByInterpretation: interpCounts,
    krogerUpcLengths,
    pricedRegular: uniq.filter((p) => regularPrice(p.price)).length,
    withPromo: uniq.filter((p) => hasPromo(p.price)).length,
    sizeParsed: uniq.filter((p) => p.sizeParsed).length,
    sizeExplicit: uniq.filter((p) => p.sizeParsed?.sizeBasis === 'explicit').length,
    sizeInferredKept: uniq.filter((p) => p.sizeParsed?.sizeBasis === 'inferred_per_unit').length,
    sizeInferredRejectedByPackageWeight: uniq.filter((p) => p.sizeCheck?.status === 'disagree').length,
    servingConvertible: matched.filter((p) => p.fdc!.per100.basis).length,
    nutrientKnownAmongMatched: {
      addedSugars: nutrientKnown('addedSugars'),
      sugars: nutrientKnown('sugars'),
      protein: nutrientKnown('protein'),
      fiber: nutrientKnown('fiber'),
      sodium: nutrientKnown('sodium'),
      calories: nutrientKnown('calories'),
    },
    failuresByReason: (() => {
      const out: Record<string, number> = {};
      for (const p of uniq) {
        for (const i of p.issues) {
          const k = i.replace(/\(.*$|—.*$|".*$|\d{5,}.*$/, '').trim();
          out[k] = (out[k] ?? 0) + 1;
        }
      }
      return out;
    })(),
    fdcRecordDates: matched.map((p) => ({
      upc: p.upc,
      fdcId: p.fdc!.fdcId,
      lookupMethod: p.fdc!.lookupMethod,
      publishedDate: p.fdc!.detail.publishedDate,
      modifiedDate: p.fdc!.detail.modifiedDate,
      dataSource: p.fdc!.detail.dataSource,
    })),
    // per record: latest of modified/published = when the label data was last touched
    oldestFdcRecord: matched.map((p) => latestFdcDate(p.fdc!.detail.modifiedDate, p.fdc!.detail.publishedDate)).filter(Boolean).sort()[0] ?? null,
    newestFdcRecord: matched.map((p) => latestFdcDate(p.fdc!.detail.modifiedDate, p.fdc!.detail.publishedDate)).filter(Boolean).sort().at(-1) ?? null,
    termsSearched,
    fallbacksUsed,
  };

  const date = new Date().toISOString().slice(0, 10);
  const summaryPath = path.join(root, 'data', 'raw', runStamp, 'probe-summary.json');
  const productRows = [...probed.values()].map((p) => ({
    pairId: p.pairId,
    side: p.side,
    term: p.term,
    productId: p.productId,
    upc: p.upc,
    brand: p.brand,
    description: p.description,
    size: p.size,
    sizeParsed: p.sizeParsed,
    sizeCheck: p.sizeCheck,
    price: p.price,
    fdcId: p.fdc?.fdcId ?? null,
    fdcLookupMethod: p.fdc?.lookupMethod ?? null,
    fdcMatchForm: p.fdc?.candidateForm ?? null,
    fdcPublishedDate: p.fdc?.detail.publishedDate ?? null,
    fdcModifiedDate: p.fdc?.detail.modifiedDate ?? null,
    fdcPackageWeight: p.fdc?.detail.packageWeight ?? null,
    fdcTried: p.fdcTried,
    per100: p.fdc?.per100 ?? null,
    issues: p.issues,
  }));
  writeFileSync(summaryPath, redact(JSON.stringify({ runStamp, locationId, stats, products: productRows, rejections }, null, 2)));

  log('\n=== Stats ===');
  log(JSON.stringify(stats, null, 2));

  if (!best) {
    log('\nNO qualifying pair. Per-product reasons:');
    for (const p of probed.values()) log(`  [${p.pairId}/${p.side}] ${p.productId} ${p.description}: ${p.issues.join('; ') || 'ok'}`);
    for (const r of rejections.slice(0, 40)) log(`  pair: ${r}`);
    log(`\nFull detail: ${summaryPath}`);
    process.exit(2);
  }

  const { pair, original: o, replacement: r, target, checkout, checkoutPromo, bothExplicit } = best;
  const deltas = compareAll(o.fdc!.per100, r.fdc!.per100).map((c) => ({
    ...c,
    original: round(c.original),
    replacement: round(c.replacement),
    delta: round(c.delta),
  }));
  const productOut = (p: ProbedProduct) => ({
    productId: p.productId,
    upc: p.upc,
    brand: p.brand,
    description: p.description,
    size: p.size,
    sizeParsed: p.sizeParsed,
    sizeBasis: p.sizeParsed!.sizeBasis,
    sizeCheck: p.sizeCheck,
    price: p.price,
    priceUsed: regularPrice(p.price),
    priceTypeUsed: 'regular',
    promoAvailable: hasPromo(p.price),
    fulfillment: p.fulfillment,
    krogerRetrievedAt: p.krogerRetrievedAt,
    fdc: {
      fdcId: p.fdc!.fdcId,
      matchMethod: {
        rule: 'Kroger UPC and FDC gtinUpc normalize to the same GTIN-14',
        lookupMethod: p.fdc!.lookupMethod,
        query: p.fdc!.query,
        candidateForm: p.fdc!.candidateForm,
        candidateValue: p.fdc!.candidateValue,
        krogerUpcInterpretation: p.fdc!.interpretation,
        gtin14: p.fdc!.gtin14,
        matchingFdcRecords: p.fdc!.matchingRecords,
      },
      ...p.fdc!.detail,
      per100: { basis: p.fdc!.per100.basis, values: Object.fromEntries(Object.entries(p.fdc!.per100.values).map(([k, v]) => [k, round(v)])) },
      retrievedAt: p.fdc!.retrievedAt,
    },
    sources: {
      krogerProductSearch: p.krogerSearchUrl,
      krogerProductPage: p.productPageURI ? `https://www.kroger.com${p.productPageURI}` : null,
      fdcSearch: p.fdc!.searchUrl,
      fdcFood: p.fdc!.detailUrl,
      fdcPage: p.fdc!.pageUrl,
    },
  });
  const a = branch.address ?? {};
  const verified = {
    schema: 'carttweak.verified-comparison.v1',
    retrievedAt: new Date().toISOString(),
    goal: pair.goal,
    pairId: pair.id,
    targetNutrient: target,
    branch: {
      locationId: branch.locationId,
      chain: branch.chain,
      name: branch.name,
      address: a,
      phone: branch.phone ?? null,
      retrievedAt: branchRetrievedAt,
      source: locationsUrl,
    },
    original: productOut(o),
    replacement: productOut(r),
    nutrientDeltasPer100: deltas,
    sizes: {
      bothExplicit,
      warning: bothExplicit ? null : 'At least one size is INFERRED from a multipack string (N x per-unit); no explicit-size pair qualified.',
    },
    checkout: {
      rule: 'target = 1 package of original; buy ceil(target / replacement package) packages at current branch price',
      priceType: 'regular',
      label: checkout.label,
      targetQuantity: checkout.targetQuantity,
      replacementPackageQuantity: checkout.replacementPackageQuantity,
      packagesNeeded: checkout.packagesNeeded,
      originalPrice: checkout.originalCost,
      replacementUnitPrice: checkout.replacementUnitPrice,
      replacementTotal: checkout.replacementTotalCents / 100,
      difference: checkout.differenceDollars,
    },
    checkoutWithPromo: checkoutPromo
      ? {
          label: checkoutPromo.label,
          originalPriceType: checkoutPromo.originalCost.type,
          replacementPriceType: checkoutPromo.replacementUnitPrice.type,
          packagesNeeded: checkoutPromo.packagesNeeded,
          originalPrice: checkoutPromo.originalCost,
          replacementUnitPrice: checkoutPromo.replacementUnitPrice,
          replacementTotal: checkoutPromo.replacementTotalCents / 100,
          difference: checkoutPromo.differenceDollars,
        }
      : null,
    alternativesQualified: count,
    probeStats: stats,
    rawDir: path.relative(root, path.join(root, 'data', 'raw', runStamp)).replace(/\\/g, '/'),
  };
  mkdirSync(path.join(root, 'data', 'verified'), { recursive: true });
  const outPath = path.join(root, 'data', 'verified', `kroger-${locationId}-${date}.json`);
  writeFileSync(outPath, redact(JSON.stringify(verified, null, 2)));

  log('\n=== VERIFIED COMPARISON ===');
  log(`Branch: ${branch.chain} ${branch.name} (${locationId}) — ${a.addressLine1}, ${a.city}, ${a.state} ${a.zipCode}`);
  log(`Goal: ${pair.goal}  target=${target.nutrient} (${target.better} is better)`);
  if (!bothExplicit) log('!! WARNING: at least one size is INFERRED from a multipack string; no explicit-size pair qualified.');
  for (const [lbl, p] of [['Original', o], ['Replacement', r]] as const) {
    const rp = regularPrice(p.price)!;
    log(
      `${lbl}: ${p.brand} — ${p.description} (${p.size}, ${p.sizeParsed!.sizeBasis}) $${rp.dollars.toFixed(2)} [regular]` +
        `${hasPromo(p.price) ? ` (promo $${p.price!.promo})` : ''}  UPC ${p.upc} → FDC ${p.fdc!.fdcId} via ${p.fdc!.lookupMethod}` +
        `${p.fdc!.candidateForm ? `:${p.fdc!.candidateForm}` : ''}  [FDC published ${p.fdc!.detail.publishedDate ?? '?'}, modified ${p.fdc!.detail.modifiedDate ?? '?'}]`,
    );
  }
  for (const d of deltas) {
    log(`  ${d.nutrient.padEnd(12)} per 100 ${d.basis ?? '?'}: ${d.original ?? 'unknown'} → ${d.replacement ?? 'unknown'} ${d.unit}  Δ ${d.delta ?? 'unknown'}`);
  }
  log(`Checkout (${checkout.label}): ${checkout.packagesNeeded} × $${checkout.replacementUnitPrice.dollars.toFixed(2)} vs $${checkout.originalCost.dollars.toFixed(2)} → difference $${checkout.differenceDollars.toFixed(2)}`);
  if (checkoutPromo) {
    log(
      `Checkout (${checkoutPromo.label}): ${checkoutPromo.packagesNeeded} × $${checkoutPromo.replacementUnitPrice.dollars.toFixed(2)} [${checkoutPromo.replacementUnitPrice.type}] ` +
        `vs $${checkoutPromo.originalCost.dollars.toFixed(2)} [${checkoutPromo.originalCost.type}] → difference $${checkoutPromo.differenceDollars.toFixed(2)}`,
    );
  }
  log(`\nSaved: ${outPath}\nRaw:   ${path.dirname(summaryPath)}`);
}

main().catch((e) => fail(`Probe crashed: ${e?.stack ?? e}`));
