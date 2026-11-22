/**
 * Display helpers shared by the server and the web UI. Pure.
 */
import type { ItemOutcome, PlanResult } from './engine.ts';
import type { Size } from './model.ts';
import { dollars, shortName } from './explain.ts';

const G_PER_OZ = 28.349523125;
const ML_PER_FL_OZ = 29.5735295625;

/** Shelf-style unit price: cents per oz (weight), per fl oz (volume) or per count. */
export function unitPrice(cents: number | null | undefined, size: Pick<Size, 'quantity' | 'unit'> | null | undefined): { cents: number; per: 'oz' | 'fl oz' | 'ct' } | null {
  if (cents == null || !size || !(size.quantity > 0)) return null;
  if (size.unit === 'g') return { cents: cents / (size.quantity / G_PER_OZ), per: 'oz' };
  if (size.unit === 'ml') return { cents: cents / (size.quantity / ML_PER_FL_OZ), per: 'fl oz' };
  return { cents: cents / size.quantity, per: 'ct' };
}

export function formatUnitPrice(u: ReturnType<typeof unitPrice>): string {
  if (!u) return 'unit price unknown';
  return u.cents < 100 ? `${u.cents.toFixed(1)}¢/${u.per}` : `$${(u.cents / 100).toFixed(2)}/${u.per}`;
}

export type ReasonGroupId = 'over_budget' | 'not_enough' | 'label_missing' | 'needs_choice' | 'kept' | 'other';

export interface ReasonGroup {
  id: ReasonGroupId;
  title: string;
  items: ItemOutcome[];
}

const GROUP_OF: Record<ItemOutcome['code'], ReasonGroupId | null> = {
  swapped: null,
  not_selected: null,
  over_budget: 'over_budget',
  below_threshold: 'not_enough',
  secondary_worse: 'not_enough',
  excluded: 'not_enough',
  goal_nutrient_unknown: 'label_missing',
  unresolved: 'needs_choice',
  locked: 'kept',
  price_unknown: 'other',
  size_unknown: 'other',
  basis_mismatch: 'other',
  package_dimension_mismatch: 'other',
  no_candidates: 'other',
};

const TITLES: Record<ReasonGroupId, string> = {
  over_budget: 'Over budget',
  not_enough: 'Not enough improvement',
  label_missing: 'Label missing that nutrient',
  needs_choice: 'Needs your choice',
  kept: 'Kept as favourite',
  other: "Couldn't compare",
};

/** Group item outcomes for the "no swaps" panel (order: most actionable first). */
export function groupOutcomes(r: PlanResult): ReasonGroup[] {
  const order: ReasonGroupId[] = ['over_budget', 'not_enough', 'label_missing', 'needs_choice', 'kept', 'other'];
  return order
    .map((id) => ({ id, title: TITLES[id], items: r.itemOutcomes.filter((o) => GROUP_OF[o.code] === id) }))
    .filter((g) => g.items.length > 0);
}

/**
 * One concrete change the shopper could make. Prefers raising the budget to
 * the cheapest over-budget swap (rounded up to the $0.25 budget step).
 */
export function suggestChange(r: PlanResult): string | null {
  const over = r.itemOutcomes
    .filter((o) => o.code === 'over_budget' && o.cheapestQualifying)
    .sort((a, b) => a.cheapestQualifying!.differenceCents - b.cheapestQualifying!.differenceCents)[0];
  if (over) {
    const need = Math.ceil(over.cheapestQualifying!.differenceCents / 25) * 25;
    const what = GROUP_LABEL[over.cheapestQualifying!.group] ?? 'swap';
    return `Raise your budget to ${dollars(need)} to unlock a ${what} swap (${shortName(over.cheapestQualifying!.description)}).`;
  }
  const unresolved = r.itemOutcomes.filter((o) => o.code === 'unresolved' && o.unresolved?.reason !== 'no_barcode');
  if (unresolved.length) return `Pick which product you meant for ${unresolved.length} item${unresolved.length === 1 ? '' : 's'}; they can't be compared until then.`;
  if (r.itemOutcomes.some((o) => o.code === 'below_threshold' || o.code === 'goal_nutrient_unknown')) {
    return 'Try a different goal: these products may have better options for another nutrient.';
  }
  if (r.itemOutcomes.some((o) => o.code === 'locked')) return 'Unlock a favourite to let it be compared.';
  return null;
}

const GROUP_LABEL: Record<string, string> = {
  bread: 'bread',
  yogurt: 'yogurt',
  cereal: 'cereal',
  pasta: 'pasta',
  pasta_sauce: 'pasta sauce',
  crackers: 'cracker',
  chips: 'chip',
  bars: 'granola bar',
  milk: 'milk',
  plant_milk: 'plant milk',
  juice: 'juice',
  soda: 'drink',
  peanut_butter: 'peanut butter',
  frozen_meal: 'frozen meal',
  soup: 'soup',
  cheese: 'cheese',
  eggs: 'egg',
};

/** "3 hours ago" style, relative to `now` (both ISO). */
export function relativeTime(iso: string | null | undefined, now: string): string {
  if (!iso) return 'at an unknown time';
  const ms = Date.parse(now) - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'at an unknown time';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
