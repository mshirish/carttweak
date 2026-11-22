/**
 * CartTweak domain model. Pure TypeScript, no I/O.
 *
 * Unknown is null - never 0, never estimated.
 * Sample data is marked isSample: true on every record and is never mixed
 * into live results silently (see containsSample in engine results).
 */
import { crossCheckPackageWeight, type ParsedSize, type SizeBasis } from './units.ts';

export type Chain = 'kroger' | 'walmart' | 'target';
export type SizeUnit = 'g' | 'ml' | 'each';

/** `${chain}:${chainProductId}` */
export type ProductRef = string;

export function productRef(chain: Chain, chainProductId: string): ProductRef {
  return `${chain}:${chainProductId}`;
}

export interface Size {
  quantity: number;
  unit: SizeUnit;
  basis: SizeBasis; // 'explicit' | 'inferred_per_unit'
  /** the retailer's string, e.g. "20 oz", "8 ct / 6 oz" */
  label: string;
}

export type ProductFlagCode =
  | 'size_conflict' // retailer size vs FDC packageWeight differ by > 5%; retailer size kept
  | 'size_rejected' // inferred multipack total vs FDC packageWeight differ by > 10%; size set to null
  | 'size_inferred'; // multipack size inferred as N x per-unit, not confirmed by FDC packageWeight

export interface ProductFlag {
  code: ProductFlagCode;
  detail: string;
}

export interface Product {
  ref: ProductRef;
  chain: Chain;
  chainProductId: string;
  gtin14: string | null;
  brand: string | null;
  description: string;
  size: Size | null;
  categories: string[];
  flags: ProductFlag[];
  isSample: boolean;
  /** small product image on the retailer's site (display only) */
  imageUrl?: string | null;
}

export interface Branch {
  chain: Chain;
  locationId: string;
  name: string;
  address: string;
}

export type PriceSource = 'kroger_api' | 'walmart_api' | 'shelf_observation' | 'receipt';

export interface PriceObservation {
  productRef: ProductRef;
  branch: Branch;
  regularCents: number;
  promoCents: number | null;
  source: PriceSource;
  /** ISO timestamp the price was retrieved / observed */
  observedAt: string;
  /** API URL without secrets, or photo / receipt id */
  sourceRef: string;
  isSample: boolean;
  /** true when served from cache after a failed live call */
  stale?: boolean;
  /** receipt: number of units this price covers (merged duplicate lines) */
  quantity?: number;
}

/**
 * fdc:               USDA FoodData Central branded record
 * label_observation: Nutrition Facts read from a photo of the package
 * retailer_listing:  Nutrition Facts transcribed from the product's page on the chain's own website
 */
export type NutritionSource = 'fdc' | 'label_observation' | 'retailer_listing';
export type TranscribedBy = 'demo author' | 'shopper';

export interface Per100Values {
  calories: number | null;
  protein_g: number | null;
  fiber_g: number | null;
  addedSugars_g: number | null;
  totalSugars_g: number | null;
  sodium_mg: number | null;
}

export const PER100_KEYS = ['calories', 'protein_g', 'fiber_g', 'addedSugars_g', 'totalSugars_g', 'sodium_mg'] as const;
export type Per100Key = (typeof PER100_KEYS)[number];

export function emptyPer100(): Per100Values {
  return { calories: null, protein_g: null, fiber_g: null, addedSugars_g: null, totalSugars_g: null, sodium_mg: null };
}

export interface NutritionRecord {
  productRef: ProductRef;
  source: NutritionSource;
  per100: Per100Values;
  /** null = serving not convertible to g / mL, so per-100 values are unknown */
  basis: 'g' | 'ml' | null;
  servingSize: { quantity: number; unit: string } | null;
  /** ISO date: FDC publishedDate, or the photo date for a label observation */
  labelDate: string | null;
  /** FDC id, or photo id */
  sourceRef: string;
  isSample: boolean;
  /**
   * How per-100 values were obtained:
   *  label_scaled: label values per serving x 100 / serving size
   *  fdc_per100:   FDC foodNutrients (already per 100 g/mL), used only when the label block is empty
   *  label_per100: label observation already stated per 100 g/mL
   */
  method?: 'label_scaled' | 'fdc_per100' | 'label_per100';
  /** FDC packageWeight, kept for the size-conflict check */
  packageWeight?: string | null;
  /** non-empty = values are physically implausible; the engine treats them as unknown */
  qualityIssues?: string[];
  /** retailer_listing / label_observation: where and when it was transcribed, and by whom */
  sourceUrl?: string;
  transcribedAt?: string;
  transcribedBy?: TranscribedBy;
}

/**
 * Physical plausibility of per-100 g / 100 mL values. Catches source errors
 * such as a serving size off by 100x (seen live 2026-11-22: an FDC milk record
 * giving 96.7 g protein and 150 g sugars per 100 g).
 */
export function per100QualityIssues(v: Per100Values): string[] {
  const out: string[] = [];
  const grams: Array<[keyof Per100Values, string]> = [
    ['protein_g', 'protein'],
    ['fiber_g', 'fiber'],
    ['totalSugars_g', 'total sugars'],
    ['addedSugars_g', 'added sugar'],
  ];
  for (const [k, label] of grams) {
    const x = v[k];
    if (x != null && x > 100) out.push(`${label} ${x.toFixed(1)} g per 100 is over 100 g`);
  }
  const sum = (v.protein_g ?? 0) + (v.fiber_g ?? 0) + (v.totalSugars_g ?? 0);
  if (sum > 105) out.push(`protein + fiber + sugars = ${sum.toFixed(1)} g per 100 is over 100 g`);
  if (v.addedSugars_g != null && v.totalSugars_g != null && v.addedSugars_g > v.totalSugars_g + 1) {
    out.push(`added sugar ${v.addedSugars_g.toFixed(1)} g exceeds total sugars ${v.totalSugars_g.toFixed(1)} g`);
  }
  if (v.calories != null && v.calories > 950) out.push(`${v.calories.toFixed(0)} kcal per 100 is over the 900 kcal of pure fat`);
  if (v.sodium_mg != null && v.sodium_mg > 40000) out.push(`sodium ${v.sodium_mg.toFixed(0)} mg per 100 is more than pure salt`);
  return out;
}

/** Map a parsed retailer size string to the model Size. */
export function sizeFromParsed(p: ParsedSize | null): Size | null {
  if (!p) return null;
  const unit: SizeUnit = p.basis === 'g' ? 'g' : p.basis === 'mL' ? 'ml' : 'each';
  return { quantity: p.amount, unit, basis: p.sizeBasis, label: p.original };
}

export const SIZE_CONFLICT_TOLERANCE = 0.05;
export const INFERRED_SIZE_REJECT_TOLERANCE = 0.1;

/**
 * Compare the retailer size with an FDC packageWeight and return the size to
 * use for cost math plus any flags.
 *  - inferred multipack total off by > 10%  -> size null, 'size_rejected'
 *  - any size off by > 5%                   -> keep retailer size, 'size_conflict'
 *  - inferred and not confirmed (no comparable packageWeight) -> 'size_inferred'
 */
export function reconcileSize(
  size: Size | null,
  packageWeight: string | null | undefined,
): { size: Size | null; flags: ProductFlag[] } {
  if (!size) return { size, flags: [] };
  if (size.unit === 'each') return { size, flags: [] };
  const parsedLike: ParsedSize = {
    original: size.label,
    amount: size.quantity,
    basis: size.unit === 'g' ? 'g' : 'mL',
    unit: size.unit,
    sizeBasis: size.basis,
  };
  const check = crossCheckPackageWeight(parsedLike, packageWeight, SIZE_CONFLICT_TOLERANCE);
  const flags: ProductFlag[] = [];
  if (check.status === 'disagree') {
    if (size.basis === 'inferred_per_unit' && (check.relativeDifference ?? 0) > INFERRED_SIZE_REJECT_TOLERANCE) {
      return { size: null, flags: [{ code: 'size_rejected', detail: check.reason }] };
    }
    flags.push({ code: 'size_conflict', detail: check.reason });
  }
  if (size.basis === 'inferred_per_unit' && check.status === 'not_comparable') {
    flags.push({ code: 'size_inferred', detail: `"${size.label}" read as N x per-unit; ${check.reason}` });
  }
  return { size, flags };
}

export type NutritionChoiceReason =
  | 'only_record'
  | 'label_newer_than_fdc'
  | 'listing_newer_than_fdc'
  | 'fdc_newer_or_equal'
  | 'fdc_label_undated'
  | 'newest_label_observation'
  | 'newest_retailer_listing';

export interface NutritionChoice {
  used: NutritionRecord;
  reason: NutritionChoiceReason;
  alternatives: Array<{ source: NutritionSource; sourceRef: string; labelDate: string | null }>;
}

/** Higher wins among usable manual records. */
const MANUAL_PRIORITY: Record<NutritionSource, number> = { label_observation: 2, retailer_listing: 1, fdc: 0 };

/**
 * Nutrition precedence: label_observation (photo) > retailer_listing > fdc,
 * newest first within each source.
 * A manual record (photo or listing) is usable only if it is dated and newer
 * than the newest dated FDC label (if FDC has a newer label, the package may
 * have changed). An undated FDC record loses to any dated manual record.
 * All records are kept as alternatives and the reason is recorded.
 */
export function chooseNutrition(records: NutritionRecord[]): NutritionChoice | null {
  if (!records.length) return null;
  const byDateDesc = (a: NutritionRecord, b: NutritionRecord) => String(b.labelDate ?? '').localeCompare(String(a.labelDate ?? ''));
  const alt = (used: NutritionRecord) =>
    records.filter((r) => r !== used).map((r) => ({ source: r.source, sourceRef: r.sourceRef, labelDate: r.labelDate }));
  if (records.length === 1) return { used: records[0]!, reason: 'only_record', alternatives: [] };
  const fdcs = records.filter((r) => r.source === 'fdc').sort(byDateDesc);
  const newestFdcDate = fdcs.find((r) => r.labelDate)?.labelDate ?? null;
  const manual = records
    .filter((r) => r.source !== 'fdc')
    .filter((r) => !!r.labelDate && (newestFdcDate == null || r.labelDate > newestFdcDate))
    .sort((a, b) => MANUAL_PRIORITY[b.source] - MANUAL_PRIORITY[a.source] || byDateDesc(a, b));
  const m = manual[0];
  if (m) {
    const isPhoto = m.source === 'label_observation';
    const reason: NutritionChoiceReason = !fdcs.length
      ? isPhoto
        ? 'newest_label_observation'
        : 'newest_retailer_listing'
      : newestFdcDate == null
        ? 'fdc_label_undated'
        : isPhoto
          ? 'label_newer_than_fdc'
          : 'listing_newer_than_fdc';
    return { used: m, reason, alternatives: alt(m) };
  }
  if (fdcs[0]) return { used: fdcs[0], reason: 'fdc_newer_or_equal', alternatives: alt(fdcs[0]) };
  // only undated manual records
  const any = [...records].sort((a, b) => MANUAL_PRIORITY[b.source] - MANUAL_PRIORITY[a.source])[0]!;
  return { used: any, reason: any.source === 'label_observation' ? 'newest_label_observation' : 'newest_retailer_listing', alternatives: alt(any) };
}
