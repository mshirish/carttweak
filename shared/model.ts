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
}

export type NutritionSource = 'fdc' | 'label_observation';

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

export interface NutritionChoice {
  used: NutritionRecord;
  reason: 'only_record' | 'label_newer_than_fdc' | 'fdc_newer_or_equal' | 'fdc_label_undated' | 'newest_label_observation';
  alternatives: Array<{ source: NutritionSource; sourceRef: string; labelDate: string | null }>;
}

/**
 * Nutrition precedence: a label_observation newer than the FDC labelDate wins;
 * otherwise FDC. Both are kept (alternatives) and the reason recorded.
 * An undated FDC record loses to any dated label observation.
 */
export function chooseNutrition(records: NutritionRecord[]): NutritionChoice | null {
  if (!records.length) return null;
  const byDateDesc = (a: NutritionRecord, b: NutritionRecord) => String(b.labelDate ?? '').localeCompare(String(a.labelDate ?? ''));
  const labels = records.filter((r) => r.source === 'label_observation').sort(byDateDesc);
  const fdcs = records.filter((r) => r.source === 'fdc').sort(byDateDesc);
  const alt = (used: NutritionRecord) =>
    records.filter((r) => r !== used).map((r) => ({ source: r.source, sourceRef: r.sourceRef, labelDate: r.labelDate }));
  if (records.length === 1) return { used: records[0]!, reason: 'only_record', alternatives: [] };
  const label = labels[0];
  const fdc = fdcs[0];
  if (label && !fdc) return { used: label, reason: 'newest_label_observation', alternatives: alt(label) };
  if (fdc && !label) return { used: fdc, reason: 'fdc_newer_or_equal', alternatives: alt(fdc) };
  if (label!.labelDate && !fdc!.labelDate) return { used: label!, reason: 'fdc_label_undated', alternatives: alt(label!) };
  if (label!.labelDate && fdc!.labelDate && label!.labelDate > fdc!.labelDate) {
    return { used: label!, reason: 'label_newer_than_fdc', alternatives: alt(label!) };
  }
  return { used: fdc!, reason: 'fdc_newer_or_equal', alternatives: alt(fdc!) };
}
