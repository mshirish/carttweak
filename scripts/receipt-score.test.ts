import { describe, expect, it } from 'vitest';
import { scoreReceipt, similarity } from './receipt-score.ts';

describe('receipt accuracy scoring (synthetic)', () => {
  it('fuzzy names, prices on matched pairs, false items and header fields', () => {
    const truth = { store: '100 SAMPLE AVE', zip: '45000', date: '2026-01-02', items: [{ name: 'SAMPLE OATS', priceCents: 348 }, { name: 'SAMPLE JAM', priceCents: 218 }, { name: 'SAMPLE TEA', priceCents: 299 }] };
    const parsed = { header: { store: '100 SAMPLE AVE', zip: null, date: '2026-01-02' }, items: [{ name: 'SAMPLE 0ATS', priceCents: 348 }, { name: 'SAMPLE JAM', priceCents: 211 }, { name: 'TOTAL', priceCents: 900 }] };
    expect(scoreReceipt(parsed, truth)).toEqual({ items: 3, itemsCorrect: 2, pricesCorrect: 1, falseItems: 1, header: 3, headerCorrect: 2 });
    expect(similarity('SAMPLE OATS', 'sample oats')).toBe(1);
  });
});
