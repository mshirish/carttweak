/**
 * Haul score: spend-weighted average of product scores (0-100) over SCORED
 * food items. Weight = price paid on the receipt (typed lists: the Kroger
 * demo-branch regular price). Non-food lines are excluded from the score and
 * from coverage spend. Coverage < 50% of food spend -> low confidence.
 */
import { scoreReason, type Grade, type NotScored, type NutriResult } from './nutriscore.ts';

export interface HaulItem {
  id: string;
  name: string;
  /** what was spent on this line (cents) */
  spendCents: number | null;
  nonFood?: boolean;
  /** null = not matched to a product */
  result: NutriResult | NotScored | null;
}

export type UnscoredGroup = 'label_missing' | 'not_matched' | 'not_food';

export interface HaulScore {
  score: number | null;
  verdict: string | null;
  itemCount: number;
  totalSpendCents: number;
  coverage: { scoredItems: number; foodItems: number; scoredSpendCents: number; foodSpendCents: number; spendShare: number | null };
  lowConfidence: boolean;
  distribution: Record<Grade, number>;
  helpers: Array<{ id: string; name: string; grade: Grade; score100: number; reason: string }>;
  hurters: Array<{ id: string; name: string; grade: Grade; score100: number; reason: string }>;
  unscored: Record<UnscoredGroup, Array<{ id: string; name: string; reason: string }>>;
}

export const LOW_CONFIDENCE_SHARE = 0.5;

export function verdictFor(score: number): string {
  if (score >= 80) return 'Great haul';
  if (score >= 60) return 'Solid';
  if (score >= 40) return 'Room to improve';
  return 'Lots of easy wins';
}

export function haulScore(items: HaulItem[]): HaulScore {
  const spend = (i: HaulItem) => Math.max(0, i.spendCents ?? 0);
  const food = items.filter((i) => !i.nonFood);
  const scored = food.filter((i): i is HaulItem & { result: NutriResult } => !!i.result && i.result.scored && spend(i) > 0);
  const scoredSpend = scored.reduce((s, i) => s + spend(i), 0);
  const foodSpend = food.reduce((s, i) => s + spend(i), 0);
  const score = scoredSpend > 0 ? Math.round(scored.reduce((s, i) => s + i.result.score100 * spend(i), 0) / scoredSpend) : null;
  const distribution: Record<Grade, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  for (const i of scored) distribution[i.result.grade] += spend(i);
  // helping / hurting: contribution relative to the haul average, weighted by spend
  const contrib = scored.map((i) => ({ i, c: (i.result.score100 - (score ?? 0)) * spend(i) }));
  const row = (x: { i: HaulItem & { result: NutriResult } }, dir: 'helps' | 'hurts') => ({ id: x.i.id, name: x.i.name, grade: x.i.result.grade, score100: x.i.result.score100, reason: scoreReason(x.i.result, dir) });
  const helpers = contrib.filter((x) => x.c > 0).sort((a, b) => b.c - a.c).slice(0, 3).map((x) => row(x, 'helps'));
  const hurters = contrib.filter((x) => x.c < 0).sort((a, b) => a.c - b.c).slice(0, 3).map((x) => row(x, 'hurts'));
  const unscored: HaulScore['unscored'] = { label_missing: [], not_matched: [], not_food: [] };
  for (const i of items) {
    if (i.nonFood) unscored.not_food.push({ id: i.id, name: i.name, reason: 'not food' });
    else if (!i.result) unscored.not_matched.push({ id: i.id, name: i.name, reason: 'not matched to a product' });
    else if (!i.result.scored) unscored.label_missing.push({ id: i.id, name: i.name, reason: i.result.reason });
    else if (spend(i) === 0) unscored.label_missing.push({ id: i.id, name: i.name, reason: 'no price, so it cannot be weighted' });
  }
  const spendShare = foodSpend > 0 ? scoredSpend / foodSpend : null;
  return {
    score,
    verdict: score == null ? null : verdictFor(score),
    itemCount: items.length,
    totalSpendCents: items.reduce((s, i) => s + spend(i), 0),
    coverage: { scoredItems: scored.length, foodItems: food.length, scoredSpendCents: scoredSpend, foodSpendCents: foodSpend, spendShare },
    lowConfidence: spendShare == null || spendShare < LOW_CONFIDENCE_SHARE,
    distribution,
    helpers,
    hurters,
    unscored,
  };
}

/** "Score covers 19 of 28 items (74% of what you spent)" */
export function coverageLine(h: HaulScore): string {
  const pct = h.coverage.spendShare == null ? 0 : Math.round(h.coverage.spendShare * 100);
  return `Score covers ${h.coverage.scoredItems} of ${h.coverage.foodItems} items (${pct}% of what you spent)`;
}

/**
 * Projected haul if swaps are made: each swapped item takes the replacement's
 * result, and its spend changes by the swap's price difference.
 */
export function projectHaul(items: HaulItem[], swaps: Array<{ itemId: string; result: NutriResult | NotScored | null; differenceCents: number }>): HaulScore {
  const byId = new Map(swaps.map((s) => [s.itemId, s]));
  return haulScore(
    items.map((i) => {
      const s = byId.get(i.id);
      if (!s) return i;
      return { ...i, result: s.result, spendCents: Math.max(0, (i.spendCents ?? 0) + s.differenceCents) };
    }),
  );
}
