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
