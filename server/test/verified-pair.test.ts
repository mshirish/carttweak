// Reproduce the Milestone-0 verified bread pair through the engine, from recorded live responses.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { explainSwap, planSwaps, type ResolvedItem } from '@carttweak/shared';
import { applyPackageWeight, normalizeFdcFood, normalizeKrogerProduct } from '../src/normalize.ts';
import { fixture, RECORDED, ROOT } from './fixtures.ts';

const verified = JSON.parse(readFileSync(path.join(ROOT, 'data', 'verified', 'kroger-01400513-2026-11-22.json'), 'utf8'));
const BRANCH = { chain: 'kroger' as const, locationId: '01400513', name: 'Kroger On the Rhine', address: '100 E Court St, Cincinnati, OH 45202' };

function resolvedFrom(searchFixture: string, upc: string, fdcFixture: string | null): ResolvedItem {
  const f = fixture(searchFixture);
  const raw = f.body.data.find((p: any) => p.upc === upc);
  const n = normalizeKrogerProduct(raw, BRANCH, { observedAt: f.retrievedAt, sourceRef: f.url, stale: false });
  if (!fdcFixture) return { product: n.product, price: n.price, nutrition: [] };
  const rec = normalizeFdcFood(fixture(fdcFixture).body, n.product.ref);
  return { product: applyPackageWeight(n.product, rec.packageWeight), price: n.price, nutrition: [rec] };
}

describe(`verified bread pair (${RECORDED}) through the engine`, () => {
  const wonder = resolvedFrom('kroger-products-white-bread.json', '0007225001137', 'fdc-food-2569016.json');
  const aunt = resolvedFrom('kroger-products-whole-grain-bread.json', '0007131400185', 'fdc-food-2032747.json');
  // the other recorded whole-grain loaves, without FDC records in the fixtures (-> goal unknown, ineligible)
  const others = fixture('kroger-products-whole-grain-bread.json')
    .body.data.filter((p: any) => p.upc !== '0007131400185')
    .map((p: any) => resolvedFrom('kroger-products-whole-grain-bread.json', p.upc, null));

  const result = planSwaps({
    items: [{ id: 'bread', quantity: 1, query: 'Wonder Classic White Bread 20 oz', resolved: wonder }],
    candidates: { bread: [aunt, ...others] },
    primaryGoal: 'more_fiber',
    secondaryGoal: null,
    lockedItemIds: [],
    maxExtraSpendCents: 200,
    asOf: '2026-11-22',
  });
  const s = result.swaps[0]!;

  it('chooses Aunt Millie\'s Live Light! Whole Grain Bread', () => {
    expect(result.swaps).toHaveLength(1);
    expect(s.original.description).toBe(verified.original.description);
    expect(s.replacement.description).toBe(verified.replacement.description);
  });
  it('+9.30 g fiber per 100 g, matching data/verified exactly', () => {
    const v = verified.nutrientDeltasPer100.find((d: any) => d.nutrient === 'fiber');
    expect(Math.round(s.goal.deltaPer100 * 100) / 100).toBe(9.3);
    expect(Math.round(s.goal.deltaPer100 * 100) / 100).toBe(v.delta);
    const row = s.nutrients.find((n) => n.key === 'fiber_g')!;
    expect(Math.round(row.original! * 100) / 100).toBe(v.original);
    expect(Math.round(row.replacement! * 100) / 100).toBe(v.replacement);
  });
  it('+$0.50 at regular price, +$1.00 on the promo line', () => {
    expect(s.packagesNeeded).toBe(1);
    expect(s.cost.regular.differenceCents).toBe(50);
    expect(s.cost.regular.differenceCents / 100).toBe(verified.checkout.difference);
    expect(s.cost.promo!.differenceCents).toBe(100);
    expect(s.cost.promo!.differenceCents / 100).toBe(verified.checkoutWithPromo.difference);
    expect(s.cost.promo!.label).toMatch(/may require Kroger card/);
  });
  it('other per-100 deltas match the verified file', () => {
    const map: Record<string, string> = { calories: 'calories', protein: 'protein_g', sugars: 'totalSugars_g', sodium: 'sodium_mg' };
    for (const [vk, mk] of Object.entries(map)) {
      const v = verified.nutrientDeltasPer100.find((d: any) => d.nutrient === vk);
      const row = s.nutrients.find((n) => n.key === mk)!;
      expect(Math.round(row.delta! * 100) / 100).toBe(v.delta);
    }
    expect(s.nutrients.find((n) => n.key === 'addedSugars_g')!.delta).toBeNull();
  });
  it('trip impact = 9.30 x 567 g / 100 = 52.7 g fiber; both labels flagged outdated', () => {
    expect(s.goal.tripImpact).toBeCloseTo((s.goal.improvementPer100 * 566.9904625) / 100, 9);
    expect(Math.round(s.goal.tripImpact! * 10) / 10).toBe(52.7);
    expect(s.flags.filter((f) => f.code === 'label_outdated')).toHaveLength(2);
  });
  it('candidates without FDC data are ineligible for the stated reason', () => {
    const o = result.itemOutcomes[0]!;
    expect(o.code).toBe('swapped');
    expect(o.rejections!.filter((r) => r.reason === 'goal_nutrient_unknown').length).toBeGreaterThan(0);
  });
  it('plain-English explanation', () => {
    const text = explainSwap(s);
    expect(text).toContain(
      "Swapping Wonder Classic White Bread for Aunt Millie's Live Light! Whole Grain Bread adds 9.3 g fiber per 100 g (+52.7 g across the 20 oz you're buying) for $0.50 more at Kroger On the Rhine (regular price, checked Nov 22).",
    );
    expect(text).toContain('With current promo (may require Kroger card): $1.00 more.');
    expect(text).toContain('sodium rises 46 mg per 100 g');
    expect(text).toContain('Label data from Oct 2021 (Aunt Millie\'s) and Jun 2023 (Wonder); label may be outdated.');
  });
});
