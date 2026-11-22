/**
 * CartTweak swap engine. Pure and deterministic: same input -> same output.
 *
 * Rules (see docs/DECISIONS.md):
 *  - locked / unresolved items are never swapped; unresolved items are returned with candidates, never guessed
 *  - candidates must share a specific Kroger category AND a curated swap group
 *  - nutrients compared per 100 g or per 100 mL; g vs mL never compared
 *  - unknown goal nutrient -> ineligible; added sugar never falls back to total sugars
 *  - cost: replace the ORIGINAL quantity with whole packages (ceil) at REGULAR price; promo is a separate line
 *  - ranking: per-100 delta x quantity bought (trip impact); best set of <= 2 swaps within the shared budget
 */
import {
  chooseNutrition,
  PER100_KEYS,
  type NutritionChoice,
  type NutritionRecord,
  type Per100Key,
  type PriceObservation,
  type Product,
} from './model.ts';
import { sameKind, swapGroupFor } from './swapGroups.ts';

// ---------- goals & thresholds ----------
export type Goal = 'more_protein' | 'more_fiber' | 'less_added_sugar' | 'less_sodium';

/** Minimum meaningful change per 100 g / 100 mL. Tune here. */
export const THRESHOLDS = {
  protein_g: 2,
  fiber_g: 2,
  addedSugars_g: 3,
  sodium_mg: 100,
} as const;

export type TrackedKey = keyof typeof THRESHOLDS;

export const GOALS: Record<Goal, { nutrient: TrackedKey; better: 'higher' | 'lower'; label: string }> = {
  more_protein: { nutrient: 'protein_g', better: 'higher', label: 'protein' },
  more_fiber: { nutrient: 'fiber_g', better: 'higher', label: 'fiber' },
  less_added_sugar: { nutrient: 'addedSugars_g', better: 'lower', label: 'added sugar' },
  less_sodium: { nutrient: 'sodium_mg', better: 'lower', label: 'sodium' },
};

const TRACKED: Array<{ key: TrackedKey; better: 'higher' | 'lower'; label: string }> = [
  { key: 'protein_g', better: 'higher', label: 'protein' },
  { key: 'fiber_g', better: 'higher', label: 'fiber' },
  { key: 'addedSugars_g', better: 'lower', label: 'added sugar' },
  { key: 'sodium_mg', better: 'lower', label: 'sodium' },
];

export const NUTRIENT_UNIT: Record<Per100Key, string> = {
  calories: 'kcal',
  protein_g: 'g',
  fiber_g: 'g',
  addedSugars_g: 'g',
  totalSugars_g: 'g',
  sodium_mg: 'mg',
};

export const NUTRIENT_LABEL: Record<Per100Key, string> = {
  calories: 'calories',
  protein_g: 'protein',
  fiber_g: 'fiber',
  addedSugars_g: 'added sugar',
  totalSugars_g: 'total sugars',
  sodium_mg: 'sodium',
};

export const LABEL_OUTDATED_YEARS = 2;
export const MAX_SWAPS = 2;
const EPS = 1e-9;

// ---------- input ----------
export interface ResolvedItem {
  product: Product;
  price: PriceObservation | null;
  /** all nutrition records for the product (FDC and/or label observations); precedence applied here */
  nutrition: NutritionRecord[];
}

export type UnresolvedReason = 'ambiguous' | 'not_found' | 'no_barcode' | 'too_vague';

export interface TripItem {
  id: string;
  /** packages bought */
  quantity: number;
  /** what the shopper typed */
  query?: string;
  resolved?: ResolvedItem;
  unresolved?: { reason: UnresolvedReason; detail?: string; candidates: Product[] };
}

export interface PlanInput {
  items: TripItem[];
  /** replacement candidates per trip item id */
  candidates: Record<string, ResolvedItem[]>;
  primaryGoal: Goal;
  secondaryGoal?: Goal | null;
  lockedItemIds: string[];
  /** max combined extra spend in cents; 0 allowed; savings (negative) always allowed */
  maxExtraSpendCents: number;
  /** ISO date used to flag outdated labels (keeps the engine deterministic) */
  asOf: string;
  maxSwaps?: number;
}

// ---------- output ----------
export type CandidateReason =
  | 'same_product'
  | 'not_same_kind'
  | 'price_unknown'
  | 'size_unknown'
  | 'basis_mismatch'
  | 'goal_nutrient_unknown'
  | 'below_threshold'
  | 'secondary_worse';

export interface CandidateRejection {
  candidateRef: string;
  description: string;
  reason: CandidateReason;
  detail: string;
  /** goal improvement per 100 (positive = better) when computable */
  improvementPer100?: number | null;
}

export interface NutrientRow {
  key: Per100Key;
  label: string;
  unit: string;
  original: number | null;
  replacement: number | null;
  /** replacement - original; null = unknown */
  delta: number | null;
  /** total sugars are context only, never a stand-in for added sugars */
  contextOnly?: boolean;
}

export interface CostLine {
  label: string;
  originalCents: number;
  replacementCents: number;
  /** replacement - original; positive = costs more, negative = saves */
  differenceCents: number;
  priceTypes: { original: 'regular' | 'promo'; replacement: 'regular' | 'promo' };
}

export type SwapFlagCode =
  | 'secondary_unknown'
  | 'nutrient_worse'
  | 'label_outdated'
  | 'size_conflict'
  | 'size_inferred'
  | 'stale_price'
  | 'sample_data';

export interface SwapFlag {
  code: SwapFlagCode;
  detail: string;
  nutrient?: Per100Key;
  delta?: number;
}

export interface ProductSummary {
  ref: string;
  brand: string | null;
  description: string;
  sizeLabel: string | null;
  quantity: number | null;
  unit: string | null;
  gtin14: string | null;
  isSample: boolean;
}

export interface SourceInfo {
  role: 'original' | 'replacement';
  kind: 'price' | 'nutrition';
  source: string;
  sourceRef: string;
  /** price: observedAt; nutrition: labelDate */
  date: string | null;
  branch?: string;
  stale?: boolean;
  outdated?: boolean;
  choice?: NutritionChoice['reason'];
  method?: NutritionRecord['method'];
  alternatives?: NutritionChoice['alternatives'];
}

export interface SwapOption {
  itemId: string;
  group: string;
  original: ProductSummary;
  replacement: ProductSummary;
  basis: 'g' | 'ml';
  nutrients: NutrientRow[];
  goal: {
    goal: Goal;
    nutrient: TrackedKey;
    deltaPer100: number;
    improvementPer100: number;
    /** quantity of the original actually bought (g or mL) = packages x package size */
    quantityBought: number;
    /** improvement x quantityBought / 100, in the nutrient's unit */
    tripImpact: number;
  };
  secondary: { goal: Goal; nutrient: TrackedKey; deltaPer100: number | null; status: 'ok' | 'unknown' } | null;
  packagesNeeded: number;
  originalPackages: number;
  cost: { regular: CostLine; promo: CostLine | null };
  sources: SourceInfo[];
  flags: SwapFlag[];
  why: { codes: string[]; numbers: Record<string, number | string | null> };
  /** oldest label date among the two products (display) */
  oldestLabelDate: string | null;
  /** replacement's label date (tie-break: newer wins) */
  replacementLabelDate: string | null;
}

export type ItemOutcomeCode =
  | 'swapped'
  | 'locked'
  | 'unresolved'
  | 'price_unknown'
  | 'size_unknown'
  | 'basis_mismatch'
  | 'goal_nutrient_unknown'
  | 'no_candidates'
  | 'below_threshold'
  | 'secondary_worse'
  | 'over_budget'
  | 'not_selected';

export interface ItemOutcome {
  itemId: string;
  query?: string;
  description?: string;
  code: ItemOutcomeCode;
  detail: string;
  unresolved?: TripItem['unresolved'];
  /** over_budget: cheapest qualifying option */
  cheapestQualifying?: { replacementRef: string; description: string; differenceCents: number; tripImpact: number };
  /** below_threshold: best improvement seen */
  bestImprovementPer100?: number;
  candidateReasonCounts?: Partial<Record<CandidateReason, number>>;
  rejections?: CandidateRejection[];
  eligibleCount?: number;
}

export interface PlanResult {
  primaryGoal: Goal;
  secondaryGoal: Goal | null;
  maxExtraSpendCents: number;
  swaps: SwapOption[];
  combined: { differenceCents: number; promoDifferenceCents: number | null; tripImpact: number; unit: string } | null;
  itemOutcomes: ItemOutcome[];
  noSwapReason: { items: ItemOutcome[] } | null;
  stats: {
    items: number;
    resolved: number;
    unresolved: number;
    locked: number;
    candidatesEvaluated: number;
    eligibleOptions: number;
    candidateReasonCounts: Partial<Record<CandidateReason, number>>;
  };
  containsSample: boolean;
}

// ---------- helpers ----------
function summarize(p: Product): ProductSummary {
  return {
    ref: p.ref,
    brand: p.brand,
    description: p.description,
    sizeLabel: p.size?.label ?? null,
    quantity: p.size?.quantity ?? null,
    unit: p.size?.unit ?? null,
    gtin14: p.gtin14,
    isSample: p.isSample,
  };
}

function improvement(delta: number, better: 'higher' | 'lower'): number {
  return better === 'higher' ? delta : -delta;
}

function yearsBefore(asOf: string, years: number): string {
  const d = new Date(`${asOf.slice(0, 10)}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

function fmt(n: number, d = 1): string {
  return (Math.round(n * 10 ** d) / 10 ** d).toString();
}

function itemSample(r: ResolvedItem | undefined): boolean {
  if (!r) return false;
  return r.product.isSample || !!r.price?.isSample || r.nutrition.some((n) => n.isSample);
}

interface Prepared {
  ok: true;
  r: ResolvedItem;
  choice: NutritionChoice;
  basis: 'g' | 'ml';
  qty: number; // package size in basis units
}

type PrepareFail = { ok: false; code: 'price_unknown' | 'size_unknown' | 'basis_mismatch' | 'goal_nutrient_unknown'; detail: string };

function prepare(r: ResolvedItem, goalKey: TrackedKey): Prepared | PrepareFail {
  if (!r.price) return { ok: false, code: 'price_unknown', detail: 'no regular price at this branch' };
  if (!r.product.size) {
    const rej = r.product.flags.find((f) => f.code === 'size_rejected');
    return { ok: false, code: 'size_unknown', detail: rej ? `size rejected: ${rej.detail}` : 'package size unknown' };
  }
  const choice = chooseNutrition(r.nutrition);
  if (!choice) return { ok: false, code: 'goal_nutrient_unknown', detail: 'no nutrition record' };
  const basis = choice.used.basis;
  if (!basis) return { ok: false, code: 'goal_nutrient_unknown', detail: 'serving size not convertible to g/mL' };
  if (r.product.size.unit !== basis) {
    return {
      ok: false,
      code: 'basis_mismatch',
      detail: `package size is in ${r.product.size.unit} ("${r.product.size.label}") but nutrition is per 100 ${basis}; g and mL are never converted`,
    };
  }
  if (choice.used.per100[goalKey] == null) {
    return { ok: false, code: 'goal_nutrient_unknown', detail: `${NUTRIENT_LABEL[goalKey]} not on label (${choice.used.source} ${choice.used.sourceRef})` };
  }
  return { ok: true, r, choice, basis, qty: r.product.size.quantity };
}

// ---------- evaluate one candidate ----------
function evaluate(
  item: TripItem,
  orig: Prepared,
  cand: ResolvedItem,
  input: PlanInput,
): { option: SwapOption } | { rejection: CandidateRejection } {
  const goal = GOALS[input.primaryGoal];
  const sec = input.secondaryGoal ? GOALS[input.secondaryGoal] : null;
  const c = cand.product;
  const reject = (reason: CandidateReason, detail: string, improvementPer100?: number | null) => ({
    rejection: { candidateRef: c.ref, description: c.description, reason, detail, improvementPer100 },
  });

  if (c.ref === orig.r.product.ref || (c.gtin14 && c.gtin14 === orig.r.product.gtin14)) return reject('same_product', 'same product');
  const kind = sameKind(orig.r.product, c);
  if (!kind.ok) return reject('not_same_kind', kind.reason);
  // reuse prepare for the candidate but with candidate-specific mapping
  const cp = prepare(cand, goal.nutrient);
  if (!cp.ok) {
    if (cp.code === 'price_unknown') return reject('price_unknown', cp.detail);
    if (cp.code === 'size_unknown') return reject('size_unknown', cp.detail);
    if (cp.code === 'basis_mismatch') return reject('basis_mismatch', cp.detail);
    return reject('goal_nutrient_unknown', cp.detail);
  }
  if (cp.basis !== orig.basis) {
    return reject('basis_mismatch', `original is per 100 ${orig.basis}, candidate per 100 ${cp.basis}; g and mL are never compared`);
  }
  const on = orig.choice.used.per100;
  const cn = cp.choice.used.per100;
  // goal nutrient: never substitute total sugars for added sugars
  const gO = on[goal.nutrient];
  const gC = cn[goal.nutrient];
  if (gO == null || gC == null) return reject('goal_nutrient_unknown', `${goal.label} unknown`);
  const gDelta = gC - gO;
  const gImp = improvement(gDelta, goal.better);
  const threshold = THRESHOLDS[goal.nutrient];
  if (gImp < threshold - EPS) {
    return reject(
      'below_threshold',
      `${goal.label} ${gImp >= 0 ? 'improves' : 'worsens'} by ${fmt(Math.abs(gImp), 2)} ${NUTRIENT_UNIT[goal.nutrient]}/100 ${orig.basis} (minimum ${threshold})`,
      gImp,
    );
  }
  const flags: SwapFlag[] = [];
  let secondary: SwapOption['secondary'] = null;
  if (sec && input.secondaryGoal) {
    const sO = on[sec.nutrient];
    const sC = cn[sec.nutrient];
    if (sO == null || sC == null) {
      secondary = { goal: input.secondaryGoal, nutrient: sec.nutrient, deltaPer100: null, status: 'unknown' };
      flags.push({ code: 'secondary_unknown', detail: `${sec.label} unknown for ${sO == null ? 'original' : 'replacement'}`, nutrient: sec.nutrient });
    } else {
      const sDelta = sC - sO;
      const worse = -improvement(sDelta, sec.better);
      if (worse > THRESHOLDS[sec.nutrient] + EPS) {
        return reject(
          'secondary_worse',
          `${sec.label} worsens by ${fmt(worse, 1)} ${NUTRIENT_UNIT[sec.nutrient]}/100 ${orig.basis} (limit ${THRESHOLDS[sec.nutrient]})`,
          gImp,
        );
      }
      secondary = { goal: input.secondaryGoal, nutrient: sec.nutrient, deltaPer100: sDelta, status: 'ok' };
    }
  }
  // other tracked nutrients: flag (don't block) when worse past threshold
  for (const t of TRACKED) {
    if (t.key === goal.nutrient || t.key === sec?.nutrient) continue;
    const o = on[t.key];
    const n = cn[t.key];
    if (o == null || n == null) continue;
    const worse = -improvement(n - o, t.better);
    if (worse > THRESHOLDS[t.key] + EPS) {
      flags.push({
        code: 'nutrient_worse',
        nutrient: t.key,
        delta: n - o,
        detail: `${t.label} ${n - o > 0 ? '+' : ''}${fmt(n - o, 1)} ${NUTRIENT_UNIT[t.key]}/100 ${orig.basis}`,
      });
    }
  }

  // ---- cost: replace the ORIGINAL quantity with whole packages ----
  const origTotal = item.quantity * orig.qty;
  const packagesNeeded = Math.max(1, Math.ceil(origTotal / cp.qty - EPS));
  const op = orig.r.price!;
  const rp = cand.price!;
  const regular: CostLine = {
    label: 'regular price',
    originalCents: item.quantity * op.regularCents,
    replacementCents: packagesNeeded * rp.regularCents,
    differenceCents: packagesNeeded * rp.regularCents - item.quantity * op.regularCents,
    priceTypes: { original: 'regular', replacement: 'regular' },
  };
  let promo: CostLine | null = null;
  if (op.promoCents != null || rp.promoCents != null) {
    const oc = op.promoCents ?? op.regularCents;
    const rc = rp.promoCents ?? rp.regularCents;
    promo = {
      label: 'with current promo (may require loyalty card)',
      originalCents: item.quantity * oc,
      replacementCents: packagesNeeded * rc,
      differenceCents: packagesNeeded * rc - item.quantity * oc,
      priceTypes: { original: op.promoCents != null ? 'promo' : 'regular', replacement: rp.promoCents != null ? 'promo' : 'regular' },
    };
  }

  // ---- sources & flags ----
  const outdatedBefore = yearsBefore(input.asOf, LABEL_OUTDATED_YEARS);
  const sources: SourceInfo[] = [];
  for (const [role, pr, pp] of [
    ['original', op, orig],
    ['replacement', rp, cp],
  ] as const) {
    sources.push({ role, kind: 'price', source: pr.source, sourceRef: pr.sourceRef, date: pr.observedAt, branch: pr.branch.name, stale: !!pr.stale });
    if (pr.stale) flags.push({ code: 'stale_price', detail: `${role} price served from cache, retrieved ${pr.observedAt}` });
    const u = pp.choice.used;
    const outdated = !u.labelDate || u.labelDate < outdatedBefore;
    sources.push({
      role,
      kind: 'nutrition',
      source: u.source,
      sourceRef: u.sourceRef,
      date: u.labelDate,
      outdated,
      choice: pp.choice.reason,
      method: u.method,
      alternatives: pp.choice.alternatives,
    });
    if (outdated) flags.push({ code: 'label_outdated', detail: `${role} label ${u.labelDate ?? 'undated'}: label may be outdated` });
    for (const f of pp.r.product.flags) {
      if (f.code === 'size_conflict' || f.code === 'size_inferred') flags.push({ code: f.code, detail: `${role}: ${f.detail}` });
    }
    if (itemSample(pp.r)) flags.push({ code: 'sample_data', detail: `${role} uses sample data` });
  }

  const nutrients: NutrientRow[] = PER100_KEYS.map((k) => {
    const o = on[k];
    const n = cn[k];
    return {
      key: k,
      label: NUTRIENT_LABEL[k],
      unit: NUTRIENT_UNIT[k],
      original: o,
      replacement: n,
      delta: o == null || n == null ? null : n - o,
      ...(k === 'totalSugars_g' ? { contextOnly: true } : {}),
    };
  });
  const tripImpact = (gImp * origTotal) / 100;
  const dates = [orig.choice.used.labelDate, cp.choice.used.labelDate].filter((d): d is string => !!d).sort();
  const why = {
    codes: [
      `goal_${input.primaryGoal}`,
      'meets_threshold',
      ...(secondary?.status === 'ok' ? ['secondary_ok'] : secondary?.status === 'unknown' ? ['secondary_unknown'] : []),
      regular.differenceCents < 0 ? 'saves_money' : regular.differenceCents === 0 ? 'same_cost' : 'costs_more',
      ...flags.map((f) => f.code),
    ],
    numbers: {
      deltaPer100: gDelta,
      improvementPer100: gImp,
      threshold,
      quantityBought: origTotal,
      tripImpact,
      packagesNeeded,
      regularDifferenceCents: regular.differenceCents,
      promoDifferenceCents: promo?.differenceCents ?? null,
    },
  };
  return {
    option: {
      itemId: item.id,
      group: kind.group.id,
      original: summarize(orig.r.product),
      replacement: summarize(c),
      basis: orig.basis,
      nutrients,
      goal: { goal: input.primaryGoal, nutrient: goal.nutrient, deltaPer100: gDelta, improvementPer100: gImp, quantityBought: origTotal, tripImpact },
      secondary,
      packagesNeeded,
      originalPackages: item.quantity,
      cost: { regular, promo },
      sources,
      flags,
      why,
      oldestLabelDate: dates[0] ?? null,
      replacementLabelDate: cp.choice.used.labelDate,
    },
  };
}

// ---------- set selection ----------
interface SetChoice {
  options: SwapOption[];
  cost: number;
  impact: number;
  oldest: string;
  key: string;
}

function better(a: SetChoice, b: SetChoice): boolean {
  if (Math.abs(a.impact - b.impact) > EPS) return a.impact > b.impact;
  if (a.cost !== b.cost) return a.cost < b.cost;
  if (a.oldest !== b.oldest) return a.oldest > b.oldest; // newer label dates win
  return a.key < b.key;
}

function makeSet(options: SwapOption[]): SetChoice {
  return {
    options,
    cost: options.reduce((s, o) => s + o.cost.regular.differenceCents, 0),
    impact: options.reduce((s, o) => s + o.goal.tripImpact, 0),
    // oldest replacement label in the set; newer is better
    oldest: options.map((o) => o.replacementLabelDate ?? '0000-00-00').sort()[0] ?? '',
    key: options.map((o) => `${o.itemId}>${o.replacement.ref}`).sort().join('|'),
  };
}

/** Exhaustive: every single option and every pair on different items. */
export function chooseBestSet(options: SwapOption[], budgetCents: number, maxSwaps = MAX_SWAPS): SwapOption[] {
  let best: SetChoice | null = null;
  const consider = (opts: SwapOption[]) => {
    const s = makeSet(opts);
    if (s.cost > budgetCents) return;
    if (!best || better(s, best)) best = s;
  };
  for (let i = 0; i < options.length; i++) {
    consider([options[i]!]);
    if (maxSwaps < 2) continue;
    for (let j = i + 1; j < options.length; j++) {
      if (options[i]!.itemId === options[j]!.itemId) continue;
      consider([options[i]!, options[j]!]);
    }
  }
  const chosen = best as SetChoice | null;
  return chosen ? [...chosen.options].sort((a, b) => b.goal.tripImpact - a.goal.tripImpact) : [];
}

const REASON_PRIORITY: CandidateReason[] = [
  'secondary_worse',
  'below_threshold',
  'goal_nutrient_unknown',
  'size_unknown',
  'basis_mismatch',
  'price_unknown',
];

// ---------- main ----------
export function planSwaps(input: PlanInput): PlanResult {
  const goal = GOALS[input.primaryGoal];
  const locked = new Set(input.lockedItemIds);
  const outcomes = new Map<string, ItemOutcome>();
  const allOptions: SwapOption[] = [];
  const optionsByItem = new Map<string, SwapOption[]>();
  const reasonTotals: Partial<Record<CandidateReason, number>> = {};
  let candidatesEvaluated = 0;
  let containsSample = false;

  for (const item of input.items) {
    const base = { itemId: item.id, query: item.query, description: item.resolved?.product.description };
    if (itemSample(item.resolved)) containsSample = true;
    if (locked.has(item.id)) {
      outcomes.set(item.id, { ...base, code: 'locked', detail: 'locked by shopper; never swapped' });
      continue;
    }
    if (!item.resolved) {
      outcomes.set(item.id, {
        ...base,
        code: 'unresolved',
        detail: item.unresolved?.detail ?? `needs resolution (${item.unresolved?.reason ?? 'unknown'})`,
        unresolved: item.unresolved ?? { reason: 'not_found', candidates: [] },
      });
      continue;
    }
    const orig = prepare(item.resolved, goal.nutrient);
    if (!orig.ok) {
      outcomes.set(item.id, { ...base, code: orig.code, detail: `original: ${orig.detail}` });
      continue;
    }
    const cands = input.candidates[item.id] ?? [];
    const rejections: CandidateRejection[] = [];
    const opts: SwapOption[] = [];
    for (const cand of cands) {
      if (itemSample(cand)) containsSample = true;
      const res = evaluate(item, orig, cand, input);
      if ('option' in res) opts.push(res.option);
      else rejections.push(res.rejection);
    }
    const relevant = rejections.filter((r) => r.reason !== 'same_product' && r.reason !== 'not_same_kind');
    candidatesEvaluated += relevant.length + opts.length;
    const counts: Partial<Record<CandidateReason, number>> = {};
    for (const r of rejections) {
      counts[r.reason] = (counts[r.reason] ?? 0) + 1;
      if (r.reason !== 'same_product' && r.reason !== 'not_same_kind') reasonTotals[r.reason] = (reasonTotals[r.reason] ?? 0) + 1;
    }
    optionsByItem.set(item.id, opts);
    allOptions.push(...opts);
    const common = { ...base, candidateReasonCounts: counts, rejections, eligibleCount: opts.length };
    if (!opts.length) {
      if (!relevant.length) {
        const group = swapGroupFor(item.resolved.product);
        outcomes.set(item.id, {
          ...common,
          code: 'no_candidates',
          detail: group
            ? `no candidates of the same kind (${group.label}) were found`
            : 'product is not in any curated swap group',
        });
        continue;
      }
      const code = REASON_PRIORITY.find((r) => counts[r]) ?? 'goal_nutrient_unknown';
      const best = Math.max(...relevant.map((r) => r.improvementPer100 ?? -Infinity));
      outcomes.set(item.id, {
        ...common,
        code: code as ItemOutcomeCode,
        detail: `${counts[code]} of ${relevant.length} same-kind candidates: ${relevant.find((r) => r.reason === code)!.detail}`,
        ...(Number.isFinite(best) ? { bestImprovementPer100: best } : {}),
      });
      continue;
    }
    outcomes.set(item.id, { ...common, code: 'not_selected', detail: 'qualifying swaps exist' });
  }

  const swaps = chooseBestSet(allOptions, input.maxExtraSpendCents, input.maxSwaps ?? MAX_SWAPS);
  const chosenItems = new Set(swaps.map((s) => s.itemId));
  for (const [itemId, opts] of optionsByItem) {
    if (!opts.length) continue;
    const o = outcomes.get(itemId)!;
    if (chosenItems.has(itemId)) {
      outcomes.set(itemId, { ...o, code: 'swapped', detail: 'swap chosen' });
      continue;
    }
    const cheapest = [...opts].sort((a, b) => a.cost.regular.differenceCents - b.cost.regular.differenceCents || b.goal.tripImpact - a.goal.tripImpact)[0]!;
    const cq = {
      replacementRef: cheapest.replacement.ref,
      description: cheapest.replacement.description,
      differenceCents: cheapest.cost.regular.differenceCents,
      tripImpact: cheapest.goal.tripImpact,
    };
    if (cheapest.cost.regular.differenceCents > input.maxExtraSpendCents) {
      outcomes.set(itemId, {
        ...o,
        code: 'over_budget',
        detail: `cheapest qualifying swap costs ${cq.differenceCents} cents more; budget ${input.maxExtraSpendCents}`,
        cheapestQualifying: cq,
      });
    } else {
      outcomes.set(itemId, {
        ...o,
        code: 'not_selected',
        detail: `fits the budget alone, but a better set of up to ${input.maxSwaps ?? MAX_SWAPS} swaps within the combined budget was chosen`,
        cheapestQualifying: cq,
      });
    }
  }

  const itemOutcomes = input.items.map((i) => outcomes.get(i.id)!);
  const promoParts = swaps.map((s) => s.cost.promo?.differenceCents ?? s.cost.regular.differenceCents);
  return {
    primaryGoal: input.primaryGoal,
    secondaryGoal: input.secondaryGoal ?? null,
    maxExtraSpendCents: input.maxExtraSpendCents,
    swaps,
    combined: swaps.length
      ? {
          differenceCents: swaps.reduce((s, o) => s + o.cost.regular.differenceCents, 0),
          promoDifferenceCents: swaps.some((s) => s.cost.promo) ? promoParts.reduce((a, b) => a + b, 0) : null,
          tripImpact: swaps.reduce((s, o) => s + o.goal.tripImpact, 0),
          unit: NUTRIENT_UNIT[goal.nutrient],
        }
      : null,
    itemOutcomes,
    noSwapReason: swaps.length ? null : { items: itemOutcomes },
    stats: {
      items: input.items.length,
      resolved: input.items.filter((i) => i.resolved).length,
      unresolved: input.items.filter((i) => !i.resolved).length,
      locked: input.items.filter((i) => locked.has(i.id)).length,
      candidatesEvaluated,
      eligibleOptions: allOptions.length,
      candidateReasonCounts: reasonTotals,
    },
    containsSample,
  };
}

