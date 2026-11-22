// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyPer100, parsePackageSize, planSwaps, sizeFromParsed, type Per100Values, type ResolvedItem } from '@carttweak/shared';
import type { PlanResponse } from '../types.ts';
import { TripTotal } from './ResultsScreen.tsx';

afterEach(cleanup);

// Synthetic products (not live data): a soda swap that saves money and a bread swap that costs more.
const BRANCH = { chain: 'kroger' as const, locationId: '01400513', name: 'Kroger On the Rhine', address: '100 E Court St' };
function r(id: string, desc: string, brand: string, size: string, cents: number, cats: string[], v: Partial<Per100Values>, basis: 'g' | 'ml' = 'g'): ResolvedItem {
  const product = { ref: `kroger:${id}`, chain: 'kroger' as const, chainProductId: id, gtin14: null, brand, description: desc, size: sizeFromParsed(parsePackageSize(size)), categories: cats, flags: [], isSample: false };
  return {
    product,
    price: { productRef: product.ref, branch: BRANCH, regularCents: cents, promoCents: null, source: 'kroger_api', observedAt: '2026-11-22T05:00:00Z', sourceRef: 'x', isSample: false },
    nutrition: [{ productRef: product.ref, source: 'fdc', per100: { ...emptyPer100(), ...v }, basis, servingSize: null, labelDate: '2025-01-01', sourceRef: `fdc:${id}`, isSample: false }],
  };
}

describe('TripTotal', () => {
  it('$0 budget: says plainly that a saving pays for the other swap', () => {
    const plan = planSwaps({
      items: [
        { id: 'coke', quantity: 1, resolved: r('c', 'Cola Soda Cans', 'Cola', '12 pk / 12 fl oz', 1199, ['Beverages'], { addedSugars_g: 11 }, 'ml') },
        { id: 'bread', quantity: 1, resolved: r('w', 'Classic White Bread', 'Wonder', '20 oz', 329, ['Bakery'], { addedSugars_g: 8.8 }) },
      ],
      candidates: {
        coke: [r('b', 'Bubly Lime Sparkling Water Cans', 'Bubly', '12 pk / 12 fl oz', 998, ['Beverages'], { addedSugars_g: 0 }, 'ml')],
        bread: [r('s', 'White Made With Whole Grain Bread', 'Sara Lee', '20 oz', 379, ['Bakery'], { addedSugars_g: 3.5 })],
      },
      primaryGoal: 'less_added_sugar',
      lockedItemIds: [],
      maxExtraSpendCents: 0,
      asOf: '2026-11-22',
    });
    const resp = { plan, branch: BRANCH } as unknown as PlanResponse;
    render(<TripTotal resp={resp} budgetCents={0} acceptedCount={0} onSave={() => {}} />);
    expect(screen.getByTestId('budget-sentence').textContent).toBe(
      'Your $0.00 budget covers the whole trip: the Bubly swap saves $2.01, which pays for the $0.50 bread swap.',
    );
    expect(screen.getByTestId('trip-total').textContent).toMatch(/Trip: saves \$1\.51 · budget \$0\.00/);
  });
});

describe('P3 projected haul score', () => {
  it('replacement score + spend adjusted by the price difference; accepted swaps only once any are accepted', async () => {
    const { projectedLine } = await import('./ResultsScreen.tsx');
    const res = (score100: number) => ({ scored: true as const, category: 'food' as const, points: 0, grade: 'C' as const, score100, components: { energy: 0, sugars: 0, satFat: 0, sodium: 0, fvl: 0, fiber: 0, protein: 0, proteinCounted: true }, energyKj: 0 });
    const haul = [
      { id: 'a', name: 'A', spendCents: 300, result: res(40) },
      { id: 'b', name: 'B', spendCents: 300, result: res(60) },
    ];
    const swap = (itemId: string, ref: string, diff: number) => ({ itemId, replacement: { ref }, cost: { regular: { differenceCents: diff } } });
    const resp = { plan: { swaps: [swap('a', 'k:x', 100), swap('b', 'k:y', 0)] }, replacementScores: { 'k:x': res(80), 'k:y': res(90) } } as any;
    // both suggested swaps: (80*400 + 90*300) / 700 = 84.3
    expect(projectedLine(haul, resp, {})!.text).toBe('Haul score: 50 → 84 if you make these swaps (projected)');
    // only the accepted one: (80*400 + 60*300) / 700 = 71.4
    expect(projectedLine(haul, resp, { a: 'k:x' })!.text).toBe('Haul score: 50 → 71 if you make the swap you accepted (projected)');
  });
});
