// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyPer100, parsePackageSize, planSwaps, reconcileSize, sizeFromParsed, type NutritionRecord, type Per100Values, type Product, type ResolvedItem } from '@carttweak/shared';
import { SwapCard } from './SwapCard.tsx';

afterEach(cleanup);

// Synthetic products for component tests (not live data).
const BRANCH = { chain: 'kroger' as const, locationId: '01400513', name: 'Kroger On the Rhine', address: '100 E Court St' };
function resolved(id: string, desc: string, size: string, cents: number, v: Partial<Per100Values>, o: { promo?: number; stale?: boolean; sample?: boolean; labelDate?: string; basis?: 'g' | 'ml'; pkg?: string } = {}): ResolvedItem {
  const r = reconcileSize(sizeFromParsed(parsePackageSize(size)), o.pkg);
  const product: Product = { ref: `kroger:${id}`, chain: 'kroger', chainProductId: id, gtin14: null, brand: desc.split(' ')[0]!, description: desc, size: r.size, categories: ['Bakery'], flags: r.flags, isSample: false, imageUrl: null };
  const n: NutritionRecord = { productRef: product.ref, source: 'fdc', per100: { ...emptyPer100(), ...v }, basis: o.basis ?? 'g', servingSize: null, labelDate: o.labelDate ?? '2025-06-01', sourceRef: `fdc:${id}`, isSample: !!o.sample };
  return {
    product,
    price: { productRef: product.ref, branch: BRANCH, regularCents: cents, promoCents: o.promo ?? null, source: 'kroger_api', observedAt: '2026-11-22T05:00:00Z', sourceRef: 'x', isSample: false, ...(o.stale ? { stale: true } : {}) },
    nutrition: [n],
  };
}

function swapFor(orig: ResolvedItem, cand: ResolvedItem, secondary: 'less_sodium' | null = null) {
  const r = planSwaps({ items: [{ id: 'b', quantity: 1, resolved: orig }], candidates: { b: [cand] }, primaryGoal: 'more_fiber', secondaryGoal: secondary, lockedItemIds: [], maxExtraSpendCents: 500, asOf: '2026-11-22' });
  expect(r.swaps).toHaveLength(1);
  return r.swaps[0]!;
}

const NOW = '2026-11-22T08:00:00Z';

describe('SwapCard', () => {
  it('writes "unknown" for missing values (never blank or 0) and highlights the goal row', () => {
    const s = swapFor(
      resolved('w', 'Classic White Bread', '20 oz', 329, { fiber_g: 3.5, addedSugars_g: 8.8, sodium_mg: 315 }),
      resolved('g', 'Whole Grain Bread', '20 oz', 379, { fiber_g: 12.8, addedSugars_g: null, sodium_mg: 361 }),
    );
    render(<SwapCard swap={s} now={NOW} />);
    const row = screen.getByText('Added sugar').closest('tr')!;
    const cells = within(row).getAllByRole('cell').map((c) => c.textContent);
    expect(cells).toEqual(['Added sugar', '8.8 g', 'unknown', 'unknown']);
    expect(screen.getByText('Fiber').closest('tr')!.className).toBe('goal');
    expect(within(screen.getByText('Fiber').closest('tr')!).getByText('+9.3 g')).toBeTruthy();
    expect(screen.getByText(/context only, not added sugar/)).toBeTruthy();
    expect(screen.getByText(/\+52\.7 g fiber across what you buy/)).toBeTruthy();
    expect(screen.getByTestId('regular-diff').textContent).toBe('$0.50 more');
  });

  it('shows the promo line labelled "may require Kroger card" only when there is a promo', () => {
    const noPromo = swapFor(resolved('w', 'Classic White Bread', '20 oz', 329, { fiber_g: 3 }), resolved('g', 'Whole Grain Bread', '20 oz', 379, { fiber_g: 12 }));
    const { unmount } = render(<SwapCard swap={noPromo} now={NOW} />);
    expect(screen.queryByTestId('promo-line')).toBeNull();
    unmount();
    const promo = swapFor(resolved('w', 'Classic White Bread', '20 oz', 329, { fiber_g: 3 }, { promo: 279 }), resolved('g', 'Whole Grain Bread', '20 oz', 379, { fiber_g: 12 }));
    render(<SwapCard swap={promo} now={NOW} />);
    expect(screen.getByTestId('promo-line').textContent).toBe('With current promo, may require Kroger card: $1.00 more');
  });

  it('shows flags as labelled badges (deduplicated)', () => {
    const s = swapFor(
      resolved('w', 'Sunbeam White Bread', '22 oz', 259, { fiber_g: 3, sodium_mg: 300 }, { labelDate: '2020-04-08', pkg: '24 oz/680 g', stale: true }),
      resolved('g', 'Whole Grain Bread', '22 oz', 379, { fiber_g: 12, sodium_mg: null }, { labelDate: '2021-10-28', sample: true }),
      'less_sodium',
    );
    render(<SwapCard swap={s} now={NOW} />);
    const badges = within(screen.getByLabelText('Notes'))
      .getAllByText(/.+/)
      .map((b) => b.textContent);
    expect(badges).toEqual(expect.arrayContaining(['Label may be outdated', 'Size conflict', 'Secondary goal unknown', 'Stale price', 'Sample data']));
    expect(badges.filter((b) => b === 'Label may be outdated')).toHaveLength(1);
  });

  it('per-100 only when the trip impact is unknown (sold by volume, label per 100 g)', () => {
    const s = swapFor(resolved('m', 'Milk Gallon', '1 gal', 329, { fiber_g: 0 }), resolved('f', 'Fiber Milk Gallon', '1 gal', 349, { fiber_g: 5 }));
    render(<SwapCard swap={s} now={NOW} />);
    expect(screen.getByText(/Trip total unknown/)).toBeTruthy();
    expect(screen.getByText('Per-100 only')).toBeTruthy();
  });

  it('sources list price branch + relative time and an FDC link', () => {
    const s = swapFor(resolved('w', 'Classic White Bread', '20 oz', 329, { fiber_g: 3 }), resolved('2032747', 'Whole Grain Bread', '20 oz', 379, { fiber_g: 12 }));
    render(<SwapCard swap={s} now={NOW} />);
    expect(screen.getAllByText(/Prices from Kroger On the Rhine \(checked 3 hours ago\)/)).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'USDA FoodData Central #2032747' }).getAttribute('href')).toBe('https://fdc.nal.usda.gov/food-details/2032747/nutrients');
  });
});
