import { describe, expect, it } from 'vitest';
import { chooseBestSet, planSwaps, sameLine, THRESHOLDS, type PlanInput, type ResolvedItem, type TripItem } from './engine.ts';
import { explainOutcome, explainPlan, explainSwap } from './explain.ts';
import { emptyPer100, per100QualityIssues, reconcileSize, sizeFromParsed, type NutritionRecord, type Per100Values, type Product } from './model.ts';
import { parsePackageSize } from './units.ts';

// ---------- builders (synthetic data; not live) ----------
const BRANCH = { chain: 'kroger' as const, locationId: '01400513', name: 'Kroger On the Rhine', address: '100 E Court St, Cincinnati, OH 45202' };

function prod(id: string, description: string, size: string | null, opts: Partial<Product> & { packageWeight?: string } = {}): Product {
  const parsed = sizeFromParsed(parsePackageSize(size));
  const rec = reconcileSize(parsed, opts.packageWeight);
  return {
    ref: `kroger:${id}`,
    chain: 'kroger',
    chainProductId: id,
    gtin14: `000000000000${id}`.slice(-14),
    brand: opts.brand ?? description.split(' ')[0]!,
    description,
    size: rec.size,
    categories: opts.categories ?? ['Bakery'],
    flags: rec.flags,
    isSample: opts.isSample ?? false,
  };
}

function nut(p: Product, values: Partial<Per100Values>, over: Partial<NutritionRecord> = {}): NutritionRecord {
  return {
    productRef: p.ref,
    source: 'fdc',
    per100: { ...emptyPer100(), ...values },
    basis: 'g',
    servingSize: { quantity: 50, unit: 'g' },
    labelDate: '2025-06-01',
    sourceRef: `fdc:${p.chainProductId}`,
    isSample: false,
    method: 'label_scaled',
    ...over,
  };
}

function resolved(p: Product, regularCents: number, values: Partial<Per100Values>, extra: { promo?: number | null; nutr?: Partial<NutritionRecord>; more?: NutritionRecord[]; sample?: boolean } = {}): ResolvedItem {
  return {
    product: p,
    price: {
      productRef: p.ref,
      branch: BRANCH,
      regularCents,
      promoCents: extra.promo ?? null,
      source: 'kroger_api',
      observedAt: '2026-11-22T05:14:24.000Z',
      sourceRef: `https://api.kroger.com/v1/products?filter.term=x&filter.locationId=01400513`,
      isSample: extra.sample ?? false,
    },
    nutrition: [nut(p, values, extra.nutr), ...(extra.more ?? [])],
  };
}

const item = (id: string, r: ResolvedItem, quantity = 1): TripItem => ({ id, quantity, resolved: r, query: r.product.description });

function plan(over: Partial<PlanInput>): ReturnType<typeof planSwaps> {
  return planSwaps({
    items: [],
    candidates: {},
    primaryGoal: 'more_fiber',
    secondaryGoal: null,
    lockedItemIds: [],
    maxExtraSpendCents: 200,
    asOf: '2026-11-22',
    ...over,
  });
}

const whiteBread = (id = 'w1', cents = 329) => resolved(prod(id, 'Classic White Bread', '20 oz'), cents, { fiber_g: 3.5, protein_g: 7, sodium_mg: 315, addedSugars_g: 8.8, totalSugars_g: 8.8 });
const wgBread = (id: string, cents: number, fiber: number, extra: Partial<Per100Values> = {}, size = '20 oz') =>
  resolved(prod(id, `Whole Grain Bread ${id}`, size), cents, { fiber_g: fiber, protein_g: 8.5, sodium_mg: 360, addedSugars_g: null, totalSugars_g: 2, ...extra });

const yogurt = (id: string, cents: number, v: Partial<Per100Values>) => resolved(prod(id, `Plain Greek Yogurt ${id}`, '32 oz', { categories: ['Dairy'] }), cents, v);

// ---------- tests ----------
describe('budget across swaps', () => {
  const items = [item('bread', whiteBread()), item('yog', yogurt('y0', 300, { fiber_g: 0, protein_g: 4 }))];
  const candidates = {
    bread: [wgBread('b1', 429, 12)], // +$1.00, +8.5 g fiber/100 g
    yog: [yogurt('y1', 400, { fiber_g: 4, protein_g: 9 })], // +$1.00, +4 g fiber/100 g
  };
  it('each fits alone, together they do not -> best single (higher trip impact) only', () => {
    const r = plan({ items, candidates, maxExtraSpendCents: 150 });
    expect(r.swaps).toHaveLength(1);
    // bread: 8.5 x 567 g /100 = 48.2 g; yogurt: 4 x 907 g / 100 = 36.3 g
    expect(r.swaps[0]!.itemId).toBe('bread');
    const yog = r.itemOutcomes.find((o) => o.itemId === 'yog')!;
    expect(yog.code).toBe('not_selected');
    expect(yog.cheapestQualifying!.differenceCents).toBe(100);
  });
  it('budget covers both -> both chosen, combined cost reported', () => {
    const r = plan({ items, candidates, maxExtraSpendCents: 200 });
    expect(r.swaps.map((s) => s.itemId).sort()).toEqual(['bread', 'yog']);
    expect(r.combined!.differenceCents).toBe(200);
  });
  it('never more than 2 swaps', () => {
    const many = [0, 1, 2].map((i) => item(`b${i}`, whiteBread(`w${i}`)));
    const c = Object.fromEntries([0, 1, 2].map((i) => [`b${i}`, [wgBread(`g${i}`, 329, 10)]]));
    expect(plan({ items: many, candidates: c, maxExtraSpendCents: 1000 }).swaps).toHaveLength(2);
  });
});

describe('$0 budget', () => {
  it('allows a savings swap', () => {
    const r = plan({ items: [item('bread', whiteBread())], candidates: { bread: [wgBread('b1', 309, 10)] }, maxExtraSpendCents: 0 });
    expect(r.swaps).toHaveLength(1);
    expect(r.swaps[0]!.cost.regular.differenceCents).toBe(-20);
  });
  it('blocks a +$0.01 swap -> over_budget with the cheapest qualifying option', () => {
    const r = plan({ items: [item('bread', whiteBread())], candidates: { bread: [wgBread('b1', 330, 10), wgBread('b2', 500, 12)] }, maxExtraSpendCents: 0 });
    expect(r.swaps).toHaveLength(0);
    const o = r.noSwapReason!.items[0]!;
    expect(o.code).toBe('over_budget');
    expect(o.cheapestQualifying).toMatchObject({ replacementRef: 'kroger:b1', differenceCents: 1 });
    expect(explainOutcome(o)).toContain('$0.01 more');
  });
});

describe('locked and unresolved items', () => {
  it('locked item is never swapped, even with a great free candidate', () => {
    const r = plan({ items: [item('bread', whiteBread())], candidates: { bread: [wgBread('b1', 100, 20)] }, lockedItemIds: ['bread'] });
    expect(r.swaps).toHaveLength(0);
    expect(r.itemOutcomes[0]!.code).toBe('locked');
  });
  it('unresolved item returned with candidates, never guessed', () => {
    const cands = [prod('y1', 'Yogurt A', '6 oz', { categories: ['Dairy'] }), prod('y2', 'Yogurt B', '32 oz', { categories: ['Dairy'] })];
    const r = plan({ items: [{ id: 'v', quantity: 1, query: 'yogurt', unresolved: { reason: 'ambiguous', candidates: cands } }] });
    const o = r.itemOutcomes[0]!;
    expect(o.code).toBe('unresolved');
    expect(o.unresolved!.candidates).toHaveLength(2);
    expect(explainOutcome(o)).toMatch(/Which "yogurt" did you mean\? 2 options/);
  });
});

describe('nutrient rules', () => {
  it('unknown goal nutrient on the candidate -> ineligible with reason goal_nutrient_unknown', () => {
    const r = plan({ items: [item('bread', whiteBread())], candidates: { bread: [wgBread('b1', 329, null as unknown as number)] } });
    expect(r.swaps).toHaveLength(0);
    const o = r.itemOutcomes[0]!;
    expect(o.code).toBe('goal_nutrient_unknown');
    expect(o.rejections![0]!.reason).toBe('goal_nutrient_unknown');
  });
  it('unknown goal nutrient on the original -> item-level reason', () => {
    const orig = resolved(prod('w', 'Classic White Bread', '20 oz'), 329, { fiber_g: null });
    expect(plan({ items: [item('bread', orig)], candidates: { bread: [wgBread('b1', 329, 10)] } }).itemOutcomes[0]!.code).toBe('goal_nutrient_unknown');
  });
  it('added sugar NEVER falls back to total sugars', () => {
    const orig = yogurt('y0', 349, { addedSugars_g: 10, totalSugars_g: 13 });
    // candidate: added sugar unknown, total sugars much lower -> still ineligible
    const cand = yogurt('y1', 349, { addedSugars_g: null, totalSugars_g: 4 });
    const r = plan({ items: [item('y', orig)], candidates: { y: [cand] }, primaryGoal: 'less_added_sugar' });
    expect(r.swaps).toHaveLength(0);
    expect(r.itemOutcomes[0]!.code).toBe('goal_nutrient_unknown');
    expect(r.itemOutcomes[0]!.rejections![0]!.detail).toMatch(/added sugar/);
  });
  it('total sugars appear only as labelled context', () => {
    const r = plan({ items: [item('bread', whiteBread())], candidates: { bread: [wgBread('b1', 329, 10)] } });
    const row = r.swaps[0]!.nutrients.find((n) => n.key === 'totalSugars_g')!;
    expect(row.contextOnly).toBe(true);
    expect(r.swaps[0]!.nutrients.find((n) => n.key === 'addedSugars_g')!.replacement).toBeNull();
  });
  it('below threshold: +1.9 g fiber is not enough, +2.0 is', () => {
    const r1 = plan({ items: [item('bread', whiteBread())], candidates: { bread: [wgBread('b1', 329, 3.5 + 1.9)] } });
    expect(r1.itemOutcomes[0]!.code).toBe('below_threshold');
    expect(r1.itemOutcomes[0]!.bestImprovementPer100).toBeCloseTo(1.9, 6);
    const r2 = plan({ items: [item('bread', whiteBread())], candidates: { bread: [wgBread('b1', 329, 3.5 + THRESHOLDS.fiber_g)] } });
    expect(r2.swaps).toHaveLength(1);
  });
  it('g vs mL are never compared', () => {
    const orig = whiteBread();
    const mlCand = wgBread('b1', 329, 12);
    mlCand.nutrition[0]!.basis = 'ml';
    const r = plan({ items: [item('bread', orig)], candidates: { bread: [mlCand] } });
    expect(r.swaps).toHaveLength(0);
    expect(r.itemOutcomes[0]!.code).toBe('basis_mismatch');
  });
});

describe('live data guards (found re-running milk, 2026-11-22)', () => {
  it('implausible per-100 values (serving off by 100x) are treated as unknown, reason kept', () => {
    const p = prod('m2', 'Reduced Fat Milk Half Gallon B', '1/2 gal', { categories: ['Dairy'] });
    const bad = resolved(p, 239, { protein_g: 96.7, totalSugars_g: 150 }, { nutr: { qualityIssues: per100QualityIssues({ ...emptyPer100(), protein_g: 96.7, totalSugars_g: 150 }) } });
    const orig = resolved(prod('m1', 'Whole Milk Gallon', '1 gal', { categories: ['Dairy'] }), 329, { protein_g: 3.3 });
    const r = plan({ items: [item('milk', orig)], candidates: { milk: [bad] }, primaryGoal: 'more_protein' });
    expect(r.swaps).toHaveLength(0);
    expect(r.itemOutcomes[0]!.rejections![0]!).toMatchObject({ reason: 'goal_nutrient_unknown' });
    expect(r.itemOutcomes[0]!.rejections![0]!.detail).toMatch(/implausible/);
  });
  it('per100QualityIssues', () => {
    expect(per100QualityIssues({ ...emptyPer100(), protein_g: 3.3, totalSugars_g: 5, sodium_mg: 50, calories: 50 })).toEqual([]);
    expect(per100QualityIssues({ ...emptyPer100(), protein_g: 96.7, totalSugars_g: 150 }).length).toBeGreaterThanOrEqual(2);
    expect(per100QualityIssues({ ...emptyPer100(), addedSugars_g: 8.81, totalSugars_g: 8.77 })).toEqual([]); // label rounding (Wonder)
    expect(per100QualityIssues({ ...emptyPer100(), addedSugars_g: 12, totalSugars_g: 5 })).toHaveLength(1);
  });
  it('same brand + same name in another size is not a swap ("Gallon" vs "Half Gallon", "Cup" vs "Tub")', () => {
    expect(sameLine({ brand: 'Kroger', description: 'Kroger® 2% Reduced Fat Milk Gallon' }, { brand: 'Kroger', description: 'Kroger® 2% Reduced Fat Milk Half Gallon' })).toBe(true);
    expect(sameLine({ brand: 'Kroger', description: 'Kroger® Plain Nonfat Greek Yogurt Cup' }, { brand: 'Kroger', description: 'Kroger® Plain Nonfat Greek Yogurt Tub' })).toBe(true);
    expect(sameLine({ brand: 'Kroger', description: 'Kroger® 2% Reduced Fat Milk Gallon' }, { brand: 'Kroger', description: 'Kroger® 1% Lowfat Milk Gallon' })).toBe(false);
    expect(sameLine({ brand: 'Lay\'s', description: 'Lay\'s Classic Potato Chips' }, { brand: 'Ruffles', description: 'Lay\'s Classic Potato Chips' })).toBe(false);
    const orig = resolved(prod('g', 'Kroger 2% Reduced Fat Milk Gallon', '1 gal', { categories: ['Dairy'], brand: 'Kroger' }), 329, { protein_g: 3.3 });
    const half = resolved(prod('h', 'Kroger 2% Reduced Fat Milk Half Gallon', '1/2 gal', { categories: ['Dairy'], brand: 'Kroger' }), 239, { protein_g: 9 });
    const r = plan({ items: [item('milk', orig)], candidates: { milk: [half] }, primaryGoal: 'more_protein' });
    expect(r.itemOutcomes[0]!.rejections![0]!.reason).toBe('same_product');
  });
});

describe('A1: units decoupled (nutrition basis / package dimension / trip impact)', () => {
  const milkP = (id: string, desc: string, size: string) => prod(id, desc, size, { categories: ['Dairy'] });
  // Milk case (recorded live 2026-11-22): Kroger sells by the gallon (mL), FDC labels milk per 100 g.
  const milk = resolved(milkP('m', 'Kroger 2% Reduced Fat Milk Gallon', '1 gal'), 329, { protein_g: 3.3, sodium_mg: 50 });
  const ufMilk = resolved(milkP('uf', 'Ultra Filtered Reduced Fat Milk', '52 fl oz'), 449, { protein_g: 5.8, sodium_mg: 50 });

  it('milk: same nutrition basis (both per 100 g) + same package dimension (both mL) -> eligible, trip impact null', () => {
    const r = plan({ items: [item('milk', milk)], candidates: { milk: [ufMilk] }, primaryGoal: 'more_protein', maxExtraSpendCents: 2000 });
    expect(r.swaps).toHaveLength(1);
    const s = r.swaps[0]!;
    expect(s.basis).toBe('g');
    expect(s.goal.improvementPer100).toBeCloseTo(2.5, 9);
    expect(s.goal.tripImpact).toBeNull();
    expect(s.goal.quantityUnit).toBe('ml');
    expect(s.goal.tripImpactNote).toMatch(/sold by volume.*per 100 g/);
    // cost still works: 1 gal (3785 mL) / 52 fl oz (1538 mL) -> 3 packages
    expect(s.packagesNeeded).toBe(3);
    expect(s.cost.regular.differenceCents).toBe(3 * 449 - 329);
    expect(s.why.codes).toContain('trip_impact_unknown');
    expect(explainSwap(s)).toMatch(/total for the trip unknown: it's sold by volume but the label is per 100 g/);
    expect(r.combined).toMatchObject({ tripImpact: 0, tripImpactUnknown: 1 });
  });
  it("Campbell's case (recorded live): sold by weight (10.75 oz) but labelled per 100 mL -> comparable with another per-100 mL soup, trip null", () => {
    const soupP = (id: string, desc: string) => prod(id, desc, '10.75 oz', { categories: ['Canned & Packaged'] });
    const orig = resolved(soupP('cs', "Campbell's Condensed Chicken Noodle Soup"), 167, { sodium_mg: 740, fiber_g: 0.4 }, { nutr: { basis: 'ml' } });
    const cand = resolved(soupP('ls', "Campbell's 25% Less Sodium Chicken Noodle Soup"), 199, { sodium_mg: 540, fiber_g: 0.4 }, { nutr: { basis: 'ml' } });
    const r = plan({ items: [item('soup', orig)], candidates: { soup: [cand] }, primaryGoal: 'less_sodium' });
    expect(r.swaps).toHaveLength(1);
    expect(r.swaps[0]!.basis).toBe('ml');
    expect(r.swaps[0]!.goal.tripImpact).toBeNull();
    expect(r.swaps[0]!.cost.regular.differenceCents).toBe(32);
  });
  it('nutrition per 100 g vs per 100 mL -> basis_mismatch (never converted)', () => {
    const mlLabel = resolved(milkP('x', 'Fat Free Milk Gallon', '1 gal'), 329, { protein_g: 9 }, { nutr: { basis: 'ml' } });
    const r = plan({ items: [item('milk', milk)], candidates: { milk: [mlLabel] }, primaryGoal: 'more_protein' });
    expect(r.swaps).toHaveLength(0);
    expect(r.itemOutcomes[0]!.code).toBe('basis_mismatch');
  });
  it('same nutrition basis but packages by volume vs weight -> package_dimension_mismatch', () => {
    const byWeight = resolved(milkP('w', 'Powdered Style Milk', '25.6 oz'), 329, { protein_g: 9 });
    const r = plan({ items: [item('milk', milk)], candidates: { milk: [byWeight] }, primaryGoal: 'more_protein' });
    expect(r.swaps).toHaveLength(0);
    expect(r.itemOutcomes[0]!.code).toBe('package_dimension_mismatch');
    expect(r.itemOutcomes[0]!.rejections![0]!.detail).toMatch(/sold by volume.*by weight/);
  });
  it('count packages (eggs "12 ct") with per-100 g labels compare per 100 g; trip null', () => {
    const egg = (id: string, desc: string, cents: number, prot: number) =>
      resolved(prod(id, desc, '12 ct', { categories: ['Dairy'] }), cents, { protein_g: prot });
    const r = plan({ items: [item('e', egg('e1', 'Large White Eggs', 179, 12.5))], candidates: { e: [egg('e2', 'Large Brown Eggs High Protein', 299, 15)] }, primaryGoal: 'more_protein' });
    expect(r.swaps[0]!.goal.quantityUnit).toBe('each');
    expect(r.swaps[0]!.goal.tripImpact).toBeNull();
  });
  it('ranking: swaps with known trip impact come before unknown ones, then by per-100 delta', () => {
    const items = [item('bread', whiteBread()), item('milk', milk)];
    const candidates = {
      bread: [wgBread('b1', 329, 6)], // +2.5 g fiber/100 g, known trip impact
      milk: [resolved(milkP('mf', 'Fiber Milk Gallon', '1 gal'), 329, { fiber_g: 9 })], // +9/100 g but trip unknown
    };
    const milkFiber = { ...milk, nutrition: [nut(milk.product, { fiber_g: 0, protein_g: 3.3 })] };
    const one = plan({ items: [items[0]!, item('milk', milkFiber)], candidates, maxSwaps: 1 });
    expect(one.swaps[0]!.itemId).toBe('bread'); // known beats a bigger per-100 delta with unknown trip impact
    const two = plan({ items: [items[0]!, item('milk', milkFiber)], candidates });
    expect(two.swaps.map((s) => s.itemId)).toEqual(['bread', 'milk']); // a second (unknown) swap still adds value
    // among unknowns: larger per-100 improvement first
    const u1 = resolved(milkP('u1', 'Fiber Milk A Gallon', '1 gal'), 329, { fiber_g: 4 });
    const u2 = resolved(milkP('u2', 'Fiber Milk B Gallon', '1 gal'), 329, { fiber_g: 7 });
    const r = plan({ items: [item('milk', milkFiber)], candidates: { milk: [u1, u2] } });
    expect(r.swaps[0]!.replacement.ref).toBe('kroger:u2');
  });
});

describe('secondary goal and flags', () => {
  it('secondary goal blocks when it worsens past its threshold', () => {
    const r = plan({ items: [item('bread', whiteBread())], candidates: { bread: [wgBread('b1', 329, 12, { sodium_mg: 315 + 101 })] }, secondaryGoal: 'less_sodium' });
    expect(r.swaps).toHaveLength(0);
    expect(r.itemOutcomes[0]!.code).toBe('secondary_worse');
  });
  it('secondary within threshold passes; unknown secondary is allowed but flagged', () => {
    const ok = plan({ items: [item('bread', whiteBread())], candidates: { bread: [wgBread('b1', 329, 12, { sodium_mg: 315 + 46 })] }, secondaryGoal: 'less_sodium' });
    expect(ok.swaps[0]!.secondary).toMatchObject({ status: 'ok' });
    const unk = plan({ items: [item('bread', whiteBread())], candidates: { bread: [wgBread('b1', 329, 12, { sodium_mg: null })] }, secondaryGoal: 'less_sodium' });
    expect(unk.swaps[0]!.flags.map((f) => f.code)).toContain('secondary_unknown');
  });
  it('other worsened nutrient past threshold is flagged, not blocked', () => {
    const r = plan({ items: [item('bread', whiteBread())], candidates: { bread: [wgBread('b1', 329, 12, { sodium_mg: 315 + 150 })] } });
    expect(r.swaps).toHaveLength(1);
    const f = r.swaps[0]!.flags.find((x) => x.code === 'nutrient_worse')!;
    expect(f.detail).toBe('sodium +150 mg/100 g');
    expect(explainSwap(r.swaps[0]!)).toMatch(/sodium rises 150 mg per 100 g \(past the flag threshold\)/);
  });
  it('small worsening is mentioned but not flagged', () => {
    const r = plan({ items: [item('bread', whiteBread())], candidates: { bread: [wgBread('b1', 329, 12, { sodium_mg: 315 + 46 })] } });
    expect(r.swaps[0]!.flags.some((x) => x.code === 'nutrient_worse')).toBe(false);
    expect(explainSwap(r.swaps[0]!)).toMatch(/sodium rises 46 mg per 100 g\./);
  });
  it('labels older than 2 years are flagged "label may be outdated"', () => {
    const cand = wgBread('b1', 329, 12);
    cand.nutrition[0]!.labelDate = '2021-10-28';
    const s = plan({ items: [item('bread', whiteBread())], candidates: { bread: [cand] } }).swaps[0]!;
    expect(s.flags.find((f) => f.code === 'label_outdated')!.detail).toMatch(/label may be outdated/);
    expect(s.sources.find((x) => x.kind === 'nutrition' && x.role === 'replacement')!.outdated).toBe(true);
  });
});

describe('cost math', () => {
  it('12 oz replacing 20 oz -> 2 whole packages', () => {
    const r = plan({ items: [item('bread', whiteBread('w', 329))], candidates: { bread: [wgBread('b1', 250, 12, {}, '12 oz')] }, maxExtraSpendCents: 1000 });
    const s = r.swaps[0]!;
    expect(s.packagesNeeded).toBe(2);
    expect(s.cost.regular.differenceCents).toBe(2 * 250 - 329);
  });
  it('item quantity > 1 multiplies the original quantity', () => {
    const r = plan({ items: [item('bread', whiteBread('w', 329), 2)], candidates: { bread: [wgBread('b1', 400, 12, {}, '24 oz')] }, maxExtraSpendCents: 1000 });
    const s = r.swaps[0]!;
    expect(s.packagesNeeded).toBe(2); // 40 oz / 24 oz -> 2
    expect(s.cost.regular.differenceCents).toBe(800 - 658);
    expect(s.goal.quantityBought).toBeCloseTo(2 * 20 * 28.349523125, 6);
  });
  it('promo line only when a promo exists, labelled; main line uses regular', () => {
    const noPromo = plan({ items: [item('bread', whiteBread())], candidates: { bread: [wgBread('b1', 379, 12)] } }).swaps[0]!;
    expect(noPromo.cost.promo).toBeNull();
    const orig = resolved(prod('w', 'Classic White Bread', '20 oz'), 329, { fiber_g: 3.5 }, { promo: 279 });
    const s = plan({ items: [item('bread', orig)], candidates: { bread: [wgBread('b1', 379, 12)] } }).swaps[0]!;
    expect(s.cost.regular).toMatchObject({ differenceCents: 50, priceTypes: { original: 'regular', replacement: 'regular' } });
    expect(s.cost.promo).toMatchObject({ differenceCents: 100, label: 'with current promo (may require loyalty card)', priceTypes: { original: 'promo', replacement: 'regular' } });
  });
});

describe('same kind of food', () => {
  it('different swap group or no shared category -> not eligible -> no_candidates', () => {
    const notBread = yogurt('y1', 329, { fiber_g: 20 }); // Dairy, yogurt group
    const sameGroupOtherCat = resolved(prod('b9', 'Whole Grain Bread X', '20 oz', { categories: ['Frozen'] }), 329, { fiber_g: 20 });
    const r = plan({ items: [item('bread', whiteBread())], candidates: { bread: [notBread, sameGroupOtherCat] } });
    expect(r.itemOutcomes[0]!.code).toBe('no_candidates');
    expect(r.itemOutcomes[0]!.candidateReasonCounts).toEqual({ not_same_kind: 2 });
  });
  it('"Natural & Organic" alone does not count as a shared category', () => {
    const orig = resolved(prod('w', 'Classic White Bread', '20 oz', { categories: ['Natural & Organic', 'Bakery'] }), 329, { fiber_g: 3 });
    const cand = resolved(prod('c', 'Whole Grain Bread', '20 oz', { categories: ['Natural & Organic', 'Frozen'] }), 329, { fiber_g: 12 });
    expect(plan({ items: [item('b', orig)], candidates: { b: [cand] } }).swaps).toHaveLength(0);
  });
});

describe('no-swap reasons', () => {
  it('reports a structured code per item', () => {
    const items: TripItem[] = [
      item('locked', whiteBread('w1')),
      { id: 'vague', quantity: 1, query: 'eggs', unresolved: { reason: 'too_vague', candidates: [] } },
      { id: 'banana', quantity: 6, query: 'bananas', unresolved: { reason: 'no_barcode', candidates: [] } },
      item('nocands', whiteBread('w2')),
      item('below', whiteBread('w3')),
      item('nosize', resolved(prod('ns', 'Mystery Bread', null), 300, { fiber_g: 3 })),
      item('over', whiteBread('w4')),
    ];
    const r = plan({
      items,
      lockedItemIds: ['locked'],
      candidates: { nocands: [], below: [wgBread('x1', 329, 4)], over: [wgBread('x2', 999, 12)] },
      maxExtraSpendCents: 100,
    });
    expect(r.swaps).toHaveLength(0);
    expect(Object.fromEntries(r.noSwapReason!.items.map((o) => [o.itemId, o.code]))).toEqual({
      locked: 'locked',
      vague: 'unresolved',
      banana: 'unresolved',
      nocands: 'no_candidates',
      below: 'below_threshold',
      nosize: 'size_unknown',
      over: 'over_budget',
    });
    const text = explainPlan(r).join('\n');
    expect(text).toMatch(/No swap fits/);
    expect(text).toMatch(/no barcode/);
  });
  it('candidate with unknown size -> size_unknown', () => {
    const r = plan({ items: [item('b', whiteBread())], candidates: { b: [resolved(prod('c', 'Whole Grain Bread', 'family size'), 329, { fiber_g: 12 })] } });
    expect(r.itemOutcomes[0]!.code).toBe('size_unknown');
  });
});

describe('label precedence, size conflict, sample data', () => {
  it('newer label observation wins over FDC; source choice recorded', () => {
    const p = prod('b1', 'Whole Grain Bread B1', '20 oz');
    const cand = resolved(p, 329, { fiber_g: 4 }, {
      nutr: { labelDate: '2021-10-28' },
      more: [nut(p, { fiber_g: 12 }, { source: 'label_observation', labelDate: '2026-11-20', sourceRef: 'photo-77' })],
    });
    const s = plan({ items: [item('b', whiteBread())], candidates: { b: [cand] } }).swaps[0]!;
    expect(s.nutrients.find((n) => n.key === 'fiber_g')!.replacement).toBe(12);
    const src = s.sources.find((x) => x.kind === 'nutrition' && x.role === 'replacement')!;
    expect(src).toMatchObject({ source: 'label_observation', sourceRef: 'photo-77', choice: 'label_newer_than_fdc' });
    expect(src.alternatives).toEqual([{ source: 'fdc', sourceRef: 'fdc:b1', labelDate: '2021-10-28' }]);
  });
  it('size_conflict on the product is carried into the swap flags; Kroger size used for cost', () => {
    const p = prod('s', 'Sunbeam Giant White Bread', '22 oz', { packageWeight: '24 oz/680 g' });
    expect(p.flags[0]!.code).toBe('size_conflict');
    const r = plan({ items: [item('b', resolved(p, 259, { fiber_g: 3 }))], candidates: { b: [wgBread('x', 379, 12, {}, '22 oz')] } });
    expect(r.swaps[0]!.flags.map((f) => f.code)).toContain('size_conflict');
    expect(r.swaps[0]!.packagesNeeded).toBe(1);
  });
  it('sample data anywhere sets containsSample: true; live-only does not', () => {
    const live = plan({ items: [item('b', whiteBread())], candidates: { b: [wgBread('x', 379, 12)] } });
    expect(live.containsSample).toBe(false);
    const sampleCand = wgBread('x', 379, 12);
    sampleCand.nutrition[0]!.isSample = true;
    const r = plan({ items: [item('b', whiteBread())], candidates: { b: [sampleCand] } });
    expect(r.containsSample).toBe(true);
    expect(r.swaps[0]!.flags.map((f) => f.code)).toContain('sample_data');
    expect(explainPlan(r).join(' ')).toMatch(/SAMPLE/);
  });
});

describe('ranking & determinism', () => {
  it('ranks by trip impact (per-100 x quantity), not per-100 alone', () => {
    // A: +9 g/100 g on a 12 oz loaf replacing 12 oz; B: +6 g/100 g replacing a 40 oz item
    const items = [item('small', resolved(prod('s', 'White Bread Small', '12 oz'), 300, { fiber_g: 3 })), item('big', resolved(prod('b', 'White Bread Big', '40 oz'), 500, { fiber_g: 3 }))];
    const candidates = { small: [wgBread('s2', 300, 12, {}, '12 oz')], big: [wgBread('b2', 500, 9, {}, '40 oz')] };
    const r = plan({ items, candidates, maxSwaps: 1 });
    expect(r.swaps[0]!.itemId).toBe('big');
  });
  it('ties: lower cost, then newer label dates', () => {
    const a = wgBread('a', 379, 12);
    const b = wgBread('b', 349, 12);
    expect(plan({ items: [item('x', whiteBread())], candidates: { x: [a, b] } }).swaps[0]!.replacement.ref).toBe('kroger:b');
    const c = wgBread('c', 349, 12);
    c.nutrition[0]!.labelDate = '2026-01-01';
    expect(plan({ items: [item('x', whiteBread())], candidates: { x: [b, c] } }).swaps[0]!.replacement.ref).toBe('kroger:c');
  });
  it('same input -> identical output', () => {
    const mk = () => plan({ items: [item('x', whiteBread())], candidates: { x: [wgBread('a', 379, 12), wgBread('b', 379, 12)] } });
    expect(JSON.stringify(mk())).toBe(JSON.stringify(mk()));
  });
  it('chooseBestSet with no options -> []', () => {
    expect(chooseBestSet([], 100)).toEqual([]);
  });
});

describe('A5: excludedCandidateIds', () => {
  const items = [item('bread', whiteBread())];
  const candidates = { bread: [wgBread('best', 379, 14), wgBread('next', 379, 10), wgBread('third', 379, 6)] };
  it('a rejected swap is re-planned without it: the next best is chosen', () => {
    const first = plan({ items, candidates });
    expect(first.swaps[0]!.replacement.ref).toBe('kroger:best');
    const again = plan({ items, candidates, excludedCandidateIds: ['kroger:best'] });
    expect(again.swaps[0]!.replacement.ref).toBe('kroger:next');
    const rej = again.itemOutcomes[0]!.rejections!.find((r) => r.candidateRef === 'kroger:best')!;
    expect(rej).toMatchObject({ reason: 'excluded', detail: 'you rejected this swap' });
  });
  it('all qualifying options rejected -> outcome excluded with an explanation', () => {
    const r = plan({ items, candidates, excludedCandidateIds: ['kroger:best', 'kroger:next', 'kroger:third'] });
    expect(r.swaps).toHaveLength(0);
    expect(r.noSwapReason!.items[0]!.code).toBe('excluded');
    expect(explainOutcome(r.noSwapReason!.items[0]!)).toMatch(/you rejected/);
  });
  it('excluding one item\'s swap frees budget for another item', () => {
    const two = [item('bread', whiteBread()), item('yog', yogurt('y0', 300, { fiber_g: 0 }))];
    const c = { bread: [wgBread('b1', 429, 12)], yog: [yogurt('y1', 400, { fiber_g: 4 })] };
    expect(plan({ items: two, candidates: c, maxExtraSpendCents: 100 }).swaps[0]!.itemId).toBe('bread');
    expect(plan({ items: two, candidates: c, maxExtraSpendCents: 100, excludedCandidateIds: ['kroger:b1'] }).swaps[0]!.itemId).toBe('yog');
  });
});
