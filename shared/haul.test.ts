import { describe, expect, it } from 'vitest';
import { coverageLine, haulScore, projectHaul, verdictFor, type HaulItem } from './haul.ts';
import type { NutriResult } from './nutriscore.ts';

const r = (score100: number, grade: NutriResult['grade'] = 'C'): NutriResult => ({
  scored: true,
  category: 'food',
  points: 0,
  grade,
  score100,
  components: { energy: 2, sugars: 3, satFat: 0, sodium: 1, fvl: 0, fiber: 4, protein: 1, proteinCounted: true },
  energyKj: 0,
});

describe('haul score', () => {
  it('spend-weighted average over scored items only', () => {
    const items: HaulItem[] = [
      { id: 'a', name: 'A', spendCents: 300, result: r(80, 'A') },
      { id: 'b', name: 'B', spendCents: 100, result: r(40, 'D') },
      { id: 'c', name: 'C', spendCents: 500, result: { scored: false, reason: 'label data missing: fiber', missing: ['fiber'] } },
    ];
    const h = haulScore(items);
    expect(h.score).toBe(70); // (80*300 + 40*100) / 400
    expect(h.verdict).toBe('Solid');
    expect(h.coverage).toEqual({ scoredItems: 2, foodItems: 3, scoredSpendCents: 400, foodSpendCents: 900, spendShare: 400 / 900 });
    expect(h.lowConfidence).toBe(true); // 44% < 50%
    expect(coverageLine(h)).toBe('Score covers 2 of 3 items (44% of what you spent)');
    expect(h.distribution).toEqual({ A: 300, B: 0, C: 0, D: 100, E: 0 });
    expect(h.unscored.label_missing).toEqual([{ id: 'c', name: 'C', reason: 'label data missing: fiber' }]);
  });
  it('non-food is excluded from score and coverage spend; unmatched counts against coverage', () => {
    const h = haulScore([
      { id: 'a', name: 'A', spendCents: 200, result: r(60) },
      { id: 'soap', name: 'SOAP', spendCents: 500, nonFood: true, result: null },
      { id: 'x', name: 'X', spendCents: 100, result: null },
    ]);
    expect(h.score).toBe(60);
    expect(h.coverage).toMatchObject({ foodItems: 2, foodSpendCents: 300, scoredSpendCents: 200 });
    expect(h.lowConfidence).toBe(false); // 67%
    expect(h.totalSpendCents).toBe(800);
    expect(h.unscored.not_food.map((u) => u.id)).toEqual(['soap']);
    expect(h.unscored.not_matched.map((u) => u.id)).toEqual(['x']);
  });
  it('low-confidence threshold at exactly 50% is not low', () => {
    const h = haulScore([
      { id: 'a', name: 'A', spendCents: 100, result: r(50) },
      { id: 'b', name: 'B', spendCents: 100, result: null },
    ]);
    expect(h.coverage.spendShare).toBe(0.5);
    expect(h.lowConfidence).toBe(false);
  });
  it('helpers and hurters by spend-weighted contribution', () => {
    const h = haulScore([
      { id: 'g', name: 'Good', spendCents: 400, result: r(90, 'A') },
      { id: 'm', name: 'Mid', spendCents: 100, result: r(55, 'C') },
      { id: 'b', name: 'Bad', spendCents: 300, result: r(20, 'E') },
    ]);
    expect(h.helpers.map((x) => x.id)).toEqual(['g']);
    expect(h.hurters.map((x) => x.id)).toEqual(['b', 'm']);
  });
  it('nothing scored -> no score, low confidence', () => {
    const h = haulScore([{ id: 'x', name: 'X', spendCents: 100, result: null }]);
    expect([h.score, h.verdict, h.lowConfidence]).toEqual([null, null, true]);
  });
  it('verdict bands', () => {
    expect([80, 79, 60, 59, 40, 39].map(verdictFor)).toEqual(['Great haul', 'Solid', 'Solid', 'Room to improve', 'Room to improve', 'Lots of easy wins']);
  });
  it('projected: swap replaces the result and adjusts spend by the price difference', () => {
    const items: HaulItem[] = [
      { id: 'a', name: 'A', spendCents: 300, result: r(40) },
      { id: 'b', name: 'B', spendCents: 300, result: r(60) },
    ];
    expect(haulScore(items).score).toBe(50);
    const p = projectHaul(items, [{ itemId: 'a', result: r(80), differenceCents: 100 }]);
    expect(p.score).toBe(71); // (80*400 + 60*300) / 700 = 71.4
  });
});
