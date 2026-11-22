import { describe, expect, it } from 'vitest';
import { formatUnitPrice, groupOutcomes, relativeTime, suggestChange, unitPrice } from './display.ts';
import type { PlanResult } from './engine.ts';

describe('unitPrice', () => {
  it('per oz / fl oz / ct', () => {
    expect(formatUnitPrice(unitPrice(329, { quantity: 566.99, unit: 'g' }))).toBe('16.5¢/oz'); // $3.29 / 20 oz
    expect(formatUnitPrice(unitPrice(1199, { quantity: 144 * 29.5735295625, unit: 'ml' }))).toBe('8.3¢/fl oz');
    expect(formatUnitPrice(unitPrice(179, { quantity: 12, unit: 'each' }))).toBe('14.9¢/ct');
    expect(formatUnitPrice(unitPrice(899, { quantity: 1, unit: 'each' }))).toBe('$8.99/ct');
    expect(unitPrice(null, { quantity: 1, unit: 'g' })).toBeNull();
  });
});

const outcome = (o: any) => ({ itemId: o.itemId ?? 'x', description: o.description ?? 'Nature Valley Oats n Honey Bars', detail: '', ...o });
const result = (itemOutcomes: any[]): PlanResult =>
  ({ swaps: [], itemOutcomes: itemOutcomes.map(outcome), maxExtraSpendCents: 200 }) as unknown as PlanResult;

describe('no-swap panel helpers', () => {
  it('suggests raising the budget to the cheapest over-budget swap, rounded up to $0.25', () => {
    const r = result([
      { code: 'over_budget', cheapestQualifying: { differenceCents: 350, description: 'Fiber One Chewy Bars', group: 'bars', replacementRef: 'k:1', tripImpact: 10 } },
      { code: 'over_budget', cheapestQualifying: { differenceCents: 512, description: 'Healthy Choice Bowl', group: 'frozen_meal', replacementRef: 'k:2', tripImpact: 4 } },
    ]);
    expect(suggestChange(r)).toBe('Raise your budget to $3.50 to unlock a granola bar swap (Fiber One Chewy Bars).');
    r.itemOutcomes[0]!.cheapestQualifying!.differenceCents = 333;
    expect(suggestChange(r)).toMatch(/^Raise your budget to \$3\.50/);
  });
  it('falls back to choices, then goals', () => {
    expect(suggestChange(result([{ code: 'unresolved', unresolved: { reason: 'ambiguous', candidates: [] } }]))).toMatch(/Pick which product/);
    expect(suggestChange(result([{ code: 'below_threshold' }]))).toMatch(/different goal/);
    expect(suggestChange(result([{ code: 'unresolved', unresolved: { reason: 'no_barcode', candidates: [] } }]))).toBeNull();
  });
  it('groups reasons, most actionable first', () => {
    const g = groupOutcomes(result([{ code: 'locked' }, { code: 'below_threshold' }, { code: 'over_budget', cheapestQualifying: {} }, { code: 'goal_nutrient_unknown' }, { code: 'unresolved' }, { code: 'swapped' }]));
    expect(g.map((x) => x.id)).toEqual(['over_budget', 'not_enough', 'label_missing', 'needs_choice', 'kept']);
  });
});

describe('relativeTime', () => {
  it('formats', () => {
    const now = '2026-11-22T12:00:00Z';
    expect(relativeTime('2026-11-22T11:59:40Z', now)).toBe('just now');
    expect(relativeTime('2026-11-22T11:15:00Z', now)).toBe('45 min ago');
    expect(relativeTime('2026-11-22T09:00:00Z', now)).toBe('3 hours ago');
    expect(relativeTime('2026-11-20T12:00:00Z', now)).toBe('2 days ago');
    expect(relativeTime(null, now)).toBe('at an unknown time');
  });
});
