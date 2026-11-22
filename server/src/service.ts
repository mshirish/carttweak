/**
 * Data service: Kroger (stores, prices, sizes) x FDC (nutrition by barcode)
 * -> CartTweak model -> swap engine.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  planSwaps,
  explainPlan,
  resolveQuery,
  splitSize,
  sameKind,
  swapGroupFor,
  SWAP_GROUPS,
  storedLabelProblems,
  type Branch,
  type Goal,
  type NutritionRecord,
  type PlanResult,
  type Product,
  type ResolvedItem,
  type Resolution,
  type TripItem,
} from '@carttweak/shared';
import { cacheStats, UpstreamError } from './cache.ts';
import { lookupByUpc } from './fdc.ts';
import * as kroger from './kroger.ts';
import { applyPackageWeight, normalizeFdcFood, normalizeKrogerProduct, storeCheck, toBranch, type KrogerNormalized } from './normalize.ts';

export class ServiceError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ServiceConfig {
  kroger: kroger.KrogerConfig;
  fdcApiKey: string;
  sampleDir: string;
  /** real hand-transcribed labels (npm run add-label); defaults to <sampleDir>/../labels */
  labelsDir?: string;
  now?: () => Date;
}

export interface EnrichedProduct extends ResolvedItem {
  upc: string | null;
  noBarcode: boolean;
  fdc: { fdcId: number | null; matched: boolean; lookup: 'barcode'; reason?: string; retrievedAt?: string; stale?: boolean };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]!);
      }
    }),
  );
  return out;
}

function snapshotStats() {
  return { ...cacheStats };
}
function diffStats(a: typeof cacheStats, b: typeof cacheStats) {
  return {
    hits: b.hits - a.hits,
    misses: b.misses - a.misses,
    liveCalls: b.liveCalls - a.liveCalls,
    staleServed: b.staleServed - a.staleServed,
    throttled: b.throttled - a.throttled,
  };
}

export const GOAL_VALUES: Goal[] = ['more_protein', 'more_fiber', 'less_added_sugar', 'less_sodium'];

/** Lookups run with this concurrency; the per-service AdaptiveLimiter (cache.ts) also caps live HTTP at 6 and backs off on 429. */
export const CONCURRENCY = 6;

/**
 * Kroger rejects search terms with more than 8 words (HTTP 400 PRODUCT-2019,
 * seen live 2026-11-22; "/" counts as a word). Short terms go as typed; longer
 * ones drop size expressions and lone punctuation, then keep the first 8 words.
 * The resolver still matches against the full query, size included.
 */
export function krogerTerm(query: string): string {
  const words = (q: string) => q.split(/\s+/).filter(Boolean);
  const q = query.trim();
  if (words(q).length <= 8) return q;
  const trimmed = words(splitSize(q).rest.replace(/(^|\s)[^\w\s]+(?=\s|$)/g, ' '));
  return (trimmed.length ? trimmed : words(q)).slice(0, 8).join(' ');
}

export interface PlanProgress {
  phase: 'store' | 'resolve' | 'candidates' | 'plan' | 'done';
  done: number;
  total: number;
  message: string;
}
export type ProgressFn = (p: PlanProgress) => void;

export function createService(cfg: ServiceConfig) {
  const branchCache = new Map<string, Branch>();
  const now = cfg.now ?? (() => new Date());

  async function stores(zip: string) {
    if (!/^\d{5}$/.test(zip)) throw new ServiceError(400, 'bad_zip', 'zip must be 5 digits');
    const r = await kroger.locationsNear(cfg.kroger, zip, 10);
    if (!r.ok) throw new ServiceError(502, 'kroger_error', `Kroger locations failed: HTTP ${r.status}`);
    const all: any[] = r.body?.data ?? [];
    const stores = [];
    const dropped = [];
    for (const loc of all) {
      const c = storeCheck(loc);
      if (c.isStore) {
        const b = toBranch(loc);
        branchCache.set(b.locationId, b);
        stores.push({ ...b, storeNumber: loc.storeNumber, phone: loc.phone, chainName: loc.chain });
      } else dropped.push({ locationId: loc.locationId, name: loc.name, reasons: c.reasons });
    }
    return { zip, stores, dropped, retrievedAt: r.retrievedAt, stale: r.stale, rule: 'store = phone + departments + numeric storeNumber + no spoke/forecast/shed/warehouse name' };
  }

  async function branch(locationId: string): Promise<Branch> {
    if (!/^[A-Za-z0-9]{8}$/.test(locationId)) throw new ServiceError(400, 'bad_location', 'locationId must be 8 characters');
    const hit = branchCache.get(locationId);
    if (hit) return hit;
    const r = await kroger.location(cfg.kroger, locationId);
    if (!r.ok || !r.body?.data) throw new ServiceError(404, 'location_not_found', `Kroger location ${locationId} not found`);
    const c = storeCheck(r.body.data);
    if (!c.isStore) throw new ServiceError(400, 'not_a_store', `location ${locationId} is not a store: ${c.reasons.join('; ')}`);
    const b = toBranch(r.body.data);
    branchCache.set(locationId, b);
    return b;
  }

  function normalizeAll(body: any, b: Branch, meta: { retrievedAt: string; sourceUrl: string; stale: boolean }): KrogerNormalized[] {
    const data = Array.isArray(body?.data) ? body.data : body?.data ? [body.data] : [];
    return data.map((raw: any) => normalizeKrogerProduct(raw, b, { observedAt: meta.retrievedAt, sourceRef: meta.sourceUrl, stale: meta.stale }));
  }

  const labelsDir = cfg.labelsDir ?? path.join(path.dirname(cfg.sampleDir), 'labels');
  /** Read fresh on each call (files are tiny) so labels added with the CLI apply without a restart. */
  function loadLabels(): NutritionRecord[] {
    if (!existsSync(labelsDir)) return [];
    const out: NutritionRecord[] = [];
    for (const f of readdirSync(labelsDir).filter((x) => x.endsWith('.json'))) {
      const j = JSON.parse(readFileSync(path.join(labelsDir, f), 'utf8'));
      for (const r of j.records ?? []) {
        const problems = storedLabelProblems(r);
        if (problems.length) throw new ServiceError(500, 'bad_label_record', `${f}: ${problems.join('; ')}`);
        out.push(r as NutritionRecord);
      }
    }
    return out;
  }

  async function enrich(n: KrogerNormalized, sample: NutritionRecord[] = []): Promise<EnrichedProduct> {
    const extra = [...loadLabels(), ...sample].filter((s) => s.productRef === n.product.ref);
    const base = { product: n.product, price: n.price, upc: n.upc, noBarcode: n.noBarcode };
    if (n.noBarcode || !n.upc) {
      return { ...base, nutrition: extra, fdc: { fdcId: null, matched: false, lookup: 'barcode', reason: 'no barcode (PLU)' } };
    }
    const f = await lookupByUpc(cfg.fdcApiKey, n.upc);
    if (!f.match || !f.detail) {
      return {
        ...base,
        nutrition: extra,
        fdc: { fdcId: null, matched: false, lookup: 'barcode', reason: 'no FDC Branded record with the same GTIN-14', retrievedAt: f.search.retrievedAt, stale: f.search.stale },
      };
    }
    const rec = normalizeFdcFood(f.detail.body, n.product.ref);
    const product = { ...applyPackageWeight(n.product, rec.packageWeight), gtin14: f.match.gtin14 };
    return {
      ...base,
      product,
      nutrition: [rec, ...extra],
      fdc: { fdcId: f.match.fdcId, matched: true, lookup: 'barcode', retrievedAt: f.detail.retrievedAt, stale: f.detail.stale },
    };
  }

  async function search(term: string, locationId: string, opts: { enrich?: boolean; limit?: number } = {}) {
    if (!term.trim()) throw new ServiceError(400, 'bad_term', 'term is required');
    const b = await branch(locationId);
    let r = await kroger.productSearch(cfg.kroger, krogerTerm(term), locationId, opts.limit ?? 10);
    if (!r.ok) throw new ServiceError(502, 'kroger_error', `Kroger product search failed: HTTP ${r.status}`);
    let usedTerm = term;
    // zero results: retry once with the first three words (seen live: "Prego Traditional Italian Sauce" -> 0)
    if (!(r.body?.data ?? []).length) {
      const shorter = term.split(/\s+/).slice(0, 3).join(' ');
      if (shorter !== term) {
        const r2 = await kroger.productSearch(cfg.kroger, shorter, locationId, opts.limit ?? 10);
        if (r2.ok && (r2.body?.data ?? []).length) {
          r = r2;
          usedTerm = shorter;
        }
      }
    }
    const normalized = normalizeAll(r.body, b, r);
    const resolution: Resolution<KrogerNormalized> = resolveQuery(term, normalized, (x) => ({ product: x.product, upc: x.upc }));
    return { branch: b, term, usedTerm, normalized, resolution, retrievedAt: r.retrievedAt, stale: r.stale, sourceUrl: r.sourceUrl };
  }

  async function byUpc(upc: string, locationId: string, sample: NutritionRecord[] = []): Promise<EnrichedProduct> {
    const digits = upc.replace(/\D/g, '');
    if (!digits || digits.length > 14) throw new ServiceError(400, 'bad_upc', 'upc must be up to 14 digits');
    const b = await branch(locationId);
    const productId = digits.padStart(13, '0').slice(-13);
    const r = await kroger.productById(cfg.kroger, productId, locationId);
    if (r.status === 404 || (r.ok && !r.body?.data)) throw new ServiceError(404, 'product_not_found', `product ${productId} not found at ${locationId}`);
    if (!r.ok) throw new ServiceError(502, 'kroger_error', `Kroger product lookup failed: HTTP ${r.status}`);
    const [n] = normalizeAll(r.body, b, r);
    return enrich(n!, sample);
  }

  async function candidatesFor(product: Product, locationId: string, sample: NutritionRecord[] = [], perTerm = 10) {
    const group = swapGroupFor(product);
    if (!group) return { group: null, candidates: [] as EnrichedProduct[], searched: [] as string[], skipped: { notSameKind: 0, noPrice: 0, noSize: 0 } };
    const b = await branch(locationId);
    const seen = new Map<string, KrogerNormalized>();
    const searches = await Promise.all(group.searchTerms.map((term) => kroger.productSearch(cfg.kroger, term, locationId, perTerm)));
    for (const r of searches) {
      if (!r.ok) continue;
      for (const n of normalizeAll(r.body, b, r)) if (!seen.has(n.product.ref)) seen.set(n.product.ref, n);
    }
    seen.delete(product.ref);
    const skipped = { notSameKind: 0, noPrice: 0, noSize: 0 };
    // cheap filters before spending FDC calls
    const keep = [...seen.values()].filter((n) => {
      if (!sameKind(product, n.product).ok) return (skipped.notSameKind++, false);
      if (!n.price) return (skipped.noPrice++, false);
      if (!n.product.size) return (skipped.noSize++, false);
      return true;
    });
    const candidates = await mapLimit(keep, CONCURRENCY, (n) => enrich(n, sample));
    return { group: group.id, candidates, searched: group.searchTerms, skipped };
  }

  function loadSample(): NutritionRecord[] {
    if (!existsSync(cfg.sampleDir)) return [];
    const out: NutritionRecord[] = [];
    for (const f of readdirSync(cfg.sampleDir).filter((x) => x.endsWith('.json'))) {
      const j = JSON.parse(readFileSync(path.join(cfg.sampleDir, f), 'utf8'));
      for (const r of j.records ?? []) {
        if (r.isSample !== true) throw new ServiceError(500, 'bad_sample', `${f}: record without isSample: true`);
        out.push(r as NutritionRecord);
      }
    }
    return out;
  }

  interface PlanItemIn {
    id?: string;
    query?: string;
    upc?: string;
    productId?: string;
    quantity?: number;
    tags?: string[];
  }

  /** Synchronous validation, so job submission can fail fast with a 400. */
  function validatePlan(body: any) {
    const items: PlanItemIn[] = Array.isArray(body?.items) ? body.items : [];
    if (!items.length) throw new ServiceError(400, 'bad_items', 'items must be a non-empty array');
    if (items.length > 40) throw new ServiceError(400, 'too_many_items', 'at most 40 items');
    const locationId = String(body?.locationId ?? '');
    const primary = body?.goals?.primary as Goal;
    const secondary = (body?.goals?.secondary ?? null) as Goal | null;
    if (!GOAL_VALUES.includes(primary)) throw new ServiceError(400, 'bad_goal', `goals.primary must be one of ${GOAL_VALUES.join(', ')}`);
    if (secondary != null && (!GOAL_VALUES.includes(secondary) || secondary === primary)) {
      throw new ServiceError(400, 'bad_goal', 'goals.secondary must be a different valid goal');
    }
    const budget = Number(body?.budget?.maxExtraSpendCents ?? body?.budget);
    if (!Number.isInteger(budget) || budget < 0) throw new ServiceError(400, 'bad_budget', 'budget.maxExtraSpendCents must be a non-negative integer (cents)');
    const locks: string[] = Array.isArray(body?.locks) ? body.locks.map(String) : [];
    const excluded: string[] = Array.isArray(body?.excludedCandidateIds) ? body.excludedCandidateIds.map(String) : [];
    if (excluded.length > 200) throw new ServiceError(400, 'bad_excluded', 'at most 200 excludedCandidateIds');
    const includeSample = body?.includeSample === true;
    const ids = items.map((it, i) => String(it.id ?? `item${i + 1}`));
    if (new Set(ids).size !== ids.length) throw new ServiceError(400, 'bad_items', 'item ids must be unique');
    if (!/^[A-Za-z0-9]{8}$/.test(locationId)) throw new ServiceError(400, 'bad_location', 'locationId must be 8 characters');
    return { items, locationId, primary, secondary, budget, locks, excluded, includeSample, ids };
  }

  async function plan(body: any, onProgress: ProgressFn = () => {}) {
    const t0 = Date.now();
    const { items, locationId, primary, secondary, budget, locks, excluded, includeSample, ids } = validatePlan(body);
    const sample = includeSample ? loadSample() : [];
    const before = snapshotStats();
    onProgress({ phase: 'store', done: 0, total: 1, message: 'Checking your store…' });
    const b = await branch(locationId);
    let resolvedCount = 0;
    onProgress({ phase: 'resolve', done: 0, total: items.length, message: `Checking prices 0/${items.length}…` });

    const resolution: any[] = [];
    const trip: TripItem[] = await mapLimit(items.map((it, i) => ({ it, id: ids[i]! })), CONCURRENCY, async ({ it, id }) => {
      try {
        return await resolveOne(it, id);
      } finally {
        resolvedCount++;
        onProgress({ phase: 'resolve', done: resolvedCount, total: items.length, message: `Checking prices ${resolvedCount}/${items.length}…` });
      }
    });
    async function resolveOne(it: PlanItemIn, id: string): Promise<TripItem> {
      const quantity = Number.isInteger(it.quantity) && it.quantity! > 0 ? it.quantity! : 1;
      const query = it.query ?? it.upc ?? it.productId ?? '';
      try {
        if (it.upc || it.productId) {
          const e = await byUpc(String(it.upc ?? it.productId), locationId, sample);
          resolution.push({ id, query, status: 'resolved', method: 'barcode', productRef: e.product.ref, fdc: e.fdc });
          return { id, quantity, query, resolved: e };
        }
        const s = await search(query, locationId);
        const res = s.resolution;
        if (res.status === 'resolved') {
          const e = await enrich(res.chosen!, sample);
          resolution.push({
            id,
            query,
            status: 'resolved',
            method: res.method,
            productRef: e.product.ref,
            description: e.product.description,
            size: e.product.size?.label ?? null,
            otherMatches: res.candidates.length,
            fdc: e.fdc,
            searchRetrievedAt: s.retrievedAt,
            stale: s.stale,
          });
          return { id, quantity, query, resolved: e };
        }
        const reason = res.status === 'not_found' ? 'not_found' : res.status === 'no_barcode' ? 'no_barcode' : res.status === 'too_vague' ? 'too_vague' : 'ambiguous';
        resolution.push({ id, query, status: res.status, detail: res.detail, candidates: res.candidates.map((c) => ({ ref: c.product.ref, description: c.product.description, size: c.product.size?.label ?? null })) });
        return { id, quantity, query, unresolved: { reason, detail: res.detail, candidates: res.candidates.map((c) => c.product) } };
      } catch (e: any) {
        if (e instanceof ServiceError && e.status === 404) {
          resolution.push({ id, query, status: 'not_found', detail: e.message, candidates: [] });
          return { id, quantity, query, unresolved: { reason: 'not_found', detail: e.message, candidates: [] } };
        }
        throw e;
      }
    }
    const t1 = Date.now();

    const candidates: Record<string, ResolvedItem[]> = {};
    const candidateInfo: Record<string, any> = {};
    const lockSet = new Set(locks);
    const excludedSet = new Set(excluded);
    // candidate searches are per swap group, all groups in parallel, reused across items of the same group
    const groupCache = new Map<string, Promise<Awaited<ReturnType<typeof candidatesFor>>>>();
    const wanted = trip.filter((t) => t.resolved && !lockSet.has(t.id));
    for (const t of wanted) {
      const g = swapGroupFor(t.resolved!.product);
      if (g && !groupCache.has(g.id)) groupCache.set(g.id, candidatesFor(t.resolved!.product, locationId, sample));
    }
    let groupsDone = 0;
    const groupTotal = groupCache.size;
    onProgress({ phase: 'candidates', done: 0, total: groupTotal, message: `Finding alternatives 0/${groupTotal}…` });
    for (const p of groupCache.values()) {
      p.then(
        () => onProgress({ phase: 'candidates', done: ++groupsDone, total: groupTotal, message: `Finding alternatives ${groupsDone}/${groupTotal}…` }),
        () => {},
      );
    }
    await Promise.all(groupCache.values());
    for (const t of wanted) {
      const g = swapGroupFor(t.resolved!.product);
      if (!g) {
        candidates[t.id] = [];
        candidateInfo[t.id] = { group: null };
        continue;
      }
      const c = await groupCache.get(g.id)!;
      // excluded candidates stay in the list; the engine rejects them with reason 'excluded'
      const mine = c.candidates.filter((x) => x.product.ref !== t.resolved!.product.ref);
      candidates[t.id] = mine;
      candidateInfo[t.id] = {
        group: c.group,
        searched: c.searched,
        found: mine.length,
        excluded: mine.filter((x) => excludedSet.has(x.product.ref)).length,
        fdcMatched: mine.filter((x) => x.fdc.matched).length,
        skipped: c.skipped,
      };
    }

    const t2 = Date.now();
    onProgress({ phase: 'plan', done: 0, total: 1, message: 'Comparing labels and prices…' });
    const result: PlanResult = planSwaps({
      items: trip,
      candidates,
      primaryGoal: primary,
      secondaryGoal: secondary,
      lockedItemIds: locks,
      maxExtraSpendCents: budget,
      asOf: now().toISOString().slice(0, 10),
      excludedCandidateIds: excluded,
    });
    const after = snapshotStats();
    const t3 = Date.now();
    onProgress({ phase: 'done', done: 1, total: 1, message: 'Done' });
    return {
      branch: b,
      generatedAt: now().toISOString(),
      plan: result,
      explanations: explainPlan(result),
      resolution: ids.map((id) => resolution.find((r) => r.id === id)),
      candidates: candidateInfo,
      containsSample: result.containsSample,
      cache: diffStats(before, after),
      excludedCandidateIds: excluded,
      timingsMs: { resolve: t1 - t0, candidates: t2 - t1, engine: t3 - t2, total: t3 - t0 },
      groups: SWAP_GROUPS.map((g) => g.id),
    };
  }

  return { stores, branch, search, byUpc, enrich, candidatesFor, plan, validatePlan };
}

export type Service = ReturnType<typeof createService>;
export { UpstreamError };
