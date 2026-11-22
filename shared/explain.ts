/**
 * Plain-English sentences from the engine's structured output.
 * Template-based only (no LLM): every number comes from the engine result.
 */
import { GOALS, NUTRIENT_LABEL, NUTRIENT_UNIT, type ItemOutcome, type PlanResult, type SwapOption } from './engine.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11-22T05:14:24Z" -> "Nov 22" (UTC) */
export function monthDay(iso: string | null | undefined): string {
  if (!iso) return 'unknown date';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

/** "2021-10-28" -> "Oct 2021" */
export function monthYear(iso: string | null | undefined): string {
  if (!iso) return 'an undated label';
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

export function dollars(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/** Display names: drop trademark symbols, collapse whitespace. */
export function shortName(description: string): string {
  return description.replace(/[®™©]/g, '').replace(/\s+/g, ' ').trim();
}

function num(n: number, digits = 1): string {
  const r = Math.round(Math.abs(n) * 10 ** digits) / 10 ** digits;
  return r.toFixed(digits).replace(/\.0+$/, '');
}

function costPhrase(cents: number): string {
  if (cents > 0) return `for ${dollars(cents)} more`;
  if (cents < 0) return `and saves ${dollars(-cents)}`;
  return 'at the same price';
}

export function explainSwap(s: SwapOption): string {
  const g = GOALS[s.goal.goal];
  const unit = NUTRIENT_UNIT[s.goal.nutrient];
  const verb = g.better === 'higher' ? 'adds' : 'cuts';
  const qtyLabel =
    s.originalPackages === 1 ? `the ${s.original.sizeLabel}` : `${s.originalPackages} x ${s.original.sizeLabel}`;
  const price = s.sources.find((x) => x.kind === 'price' && x.role === 'replacement');
  const branch = price?.branch ? ` at ${price.branch}` : '';
  const stale = s.sources.some((x) => x.kind === 'price' && x.stale) ? ', cached price' : '';
  const pkgs = s.packagesNeeded > 1 ? ` (${s.packagesNeeded} packages of the replacement)` : '';
  const parts: string[] = [];
  const trip =
    s.goal.tripImpact != null
      ? ` (${g.better === 'higher' ? '+' : '-'}${num(s.goal.tripImpact)} ${unit} across ${qtyLabel} you're buying)`
      : ` (total for the trip unknown: it's sold by ${s.goal.quantityUnit === 'ml' ? 'volume' : s.goal.quantityUnit === 'g' ? 'weight' : 'count'} but the label is per 100 ${s.basis})`;
  parts.push(
    `Swapping ${shortName(s.original.description)} for ${shortName(s.replacement.description)} ${verb} ` +
      `${num(s.goal.improvementPer100)} ${unit} ${g.label} per 100 ${s.basis}` +
      `${trip}${pkgs} ` +
      `${costPhrase(s.cost.regular.differenceCents)}${branch} (regular price, checked ${monthDay(price?.date)}${stale}).`,
  );
  if (s.cost.promo) {
    parts.push(`With current promo (may require loyalty card): ${costPhrase(s.cost.promo.differenceCents).replace(/^for |^and /, '')}.`);
  }
  // notes: any tracked nutrient that got worse (flagged ones say so)
  const notes: string[] = [];
  for (const row of s.nutrients) {
    if (row.delta == null || row.key === s.goal.nutrient || row.contextOnly || row.key === 'calories') continue;
    const t = row.key === 'protein_g' || row.key === 'fiber_g' ? 'higher' : 'lower';
    const worse = t === 'higher' ? row.delta < 0 : row.delta > 0;
    if (!worse || Math.abs(row.delta) < 0.05) continue;
    const flagged = s.flags.some((f) => f.code === 'nutrient_worse' && f.nutrient === row.key);
    notes.push(
      `${NUTRIENT_LABEL[row.key]} ${row.delta > 0 ? 'rises' : 'drops'} ${num(row.delta, row.unit === 'mg' ? 0 : 1)} ${row.unit} per 100 ${s.basis}${flagged ? ' (past the flag threshold)' : ''}`,
    );
  }
  if (s.secondary?.status === 'unknown') notes.push(`${GOALS[s.secondary.goal].label} is unknown for one of the products`);
  if (notes.length) parts.push(`Note: ${notes.join('; ')}.`);
  const sugar = s.nutrients.find((r) => r.key === 'addedSugars_g');
  if (s.goal.nutrient === 'addedSugars_g' || (sugar && (sugar.original == null || sugar.replacement == null))) {
    const tot = s.nutrients.find((r) => r.key === 'totalSugars_g');
    if (tot && tot.original != null && tot.replacement != null && s.goal.nutrient !== 'addedSugars_g') {
      parts.push(`Added sugar is not on both labels; total sugars (context only) go ${num(tot.original)} -> ${num(tot.replacement)} g per 100 ${s.basis}.`);
    }
  }
  const nut = s.sources.filter((x) => x.kind === 'nutrition');
  const label = (role: 'original' | 'replacement') => nut.find((x) => x.role === role);
  const lr = label('replacement');
  const lo = label('original');
  const outdated = nut.some((x) => x.outdated);
  parts.push(
    `Label data from ${monthYear(lr?.date)} (${s.replacement.brand ?? 'replacement'}) and ${monthYear(lo?.date)} (${s.original.brand ?? 'original'})` +
      `${outdated ? '; label may be outdated' : ''}.`,
  );
  if (s.flags.some((f) => f.code === 'size_conflict')) parts.push('Package size differs between Kroger and USDA; Kroger size used for cost.');
  if (s.flags.some((f) => f.code === 'size_inferred')) parts.push('Multipack size was inferred (count x per-item size).');
  if (s.flags.some((f) => f.code === 'sample_data')) parts.push('Uses SAMPLE data.');
  return parts.join(' ');
}

const OUTCOME_TEXT: Record<ItemOutcome['code'], (o: ItemOutcome) => string> = {
  swapped: (o) => `${name(o)}: swap suggested.`,
  locked: (o) => `${name(o)} is locked, so it was not changed.`,
  unresolved: (o) => {
    const u = o.unresolved;
    const n = u?.candidates.length ?? 0;
    if (u?.reason === 'no_barcode') return `${name(o)} has no barcode (loose produce), so it is out of scope for swaps.`;
    if (u?.reason === 'not_found') return `${name(o)} was not found at this store.`;
    return `Which ${name(o)} did you mean? ${n} option${n === 1 ? '' : 's'} found; nothing was guessed.`;
  },
  price_unknown: (o) => `${name(o)} has no regular price at this store.`,
  size_unknown: (o) => `${name(o)}: package size unknown, so cost can't be compared.`,
  basis_mismatch: (o) => `${name(o)}: alternatives list nutrition per 100 g vs per 100 mL, so they can't be compared.`,
  package_dimension_mismatch: (o) => `${name(o)}: alternatives are sold by a different measure (weight vs volume vs count), so cost can't be compared.`,
  goal_nutrient_unknown: (o) => `${name(o)}: the goal nutrient isn't known for this product (${o.detail.replace(/^original: /, '')}).`,
  no_candidates: (o) => `${name(o)}: ${o.detail}.`,
  below_threshold: (o) =>
    `${name(o)}: no alternative improves enough${o.bestImprovementPer100 != null && Number.isFinite(o.bestImprovementPer100) ? ` (best: ${num(o.bestImprovementPer100, 2)} per 100)` : ''}.`,
  secondary_worse: (o) => `${name(o)}: alternatives that help would make your secondary goal worse.`,
  over_budget: (o) =>
    `${name(o)}: the cheapest good swap (${shortName(o.cheapestQualifying!.description)}) costs ${dollars(o.cheapestQualifying!.differenceCents)} more, over your budget.`,
  not_selected: (o) => `${name(o)}: a good swap exists, but other swaps did more within the budget.`,
};

function name(o: ItemOutcome): string {
  return o.description ? shortName(o.description) : `"${o.query ?? o.itemId}"`;
}

export function explainOutcome(o: ItemOutcome): string {
  return OUTCOME_TEXT[o.code](o);
}

export function explainPlan(r: PlanResult): string[] {
  const lines = r.swaps.map(explainSwap);
  if (r.combined && r.swaps.length > 1) {
    lines.push(`Together: ${costPhrase(r.combined.differenceCents).replace(/^for |^and /, '')} (regular price), budget ${dollars(r.maxExtraSpendCents)}.`);
  }
  if (!r.swaps.length) lines.push('No swap fits your goals and budget:');
  for (const o of r.itemOutcomes) if (o.code !== 'swapped') lines.push(explainOutcome(o));
  if (r.containsSample) lines.push('This result includes SAMPLE data.');
  return lines;
}
