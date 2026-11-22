/**
 * Pure normalization: raw Kroger / FDC JSON -> CartTweak model. No I/O.
 */
import {
  emptyPer100,
  fdcDateToIso,
  fromFdcLabelNutrients,
  gs1CheckDigit,
  isPlu,
  padTo,
  parsePackageSize,
  productRef,
  reconcileSize,
  sizeFromParsed,
  stripLeadingZeros,
  toPer100,
  type Branch,
  type NutritionRecord,
  type Per100Values,
  type PriceObservation,
  type Product,
} from '@carttweak/shared';

// ---------- locations ----------
/**
 * Store rule (Kroger returns warehouses / "spoke" fulfillment sites near a ZIP).
 * A location is a store only if ALL hold:
 *   - it has a phone number
 *   - it lists at least one department
 *   - storeNumber is all digits (fulfillment sites use e.g. "FC807")
 *   - its name has none of: spoke, forecast, shed, unused, fulfillment, warehouse, distribution
 * Seen live 2026-11-22 near 45202: 4 of 5 results failed every check.
 */
const NON_STORE_NAME = /\b(spoke|forecast|shed|unused|fulfillment|warehouse|distribution)\b/i;

export function storeCheck(loc: any): { isStore: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!loc?.phone) reasons.push('no phone');
  if (!Array.isArray(loc?.departments) || loc.departments.length === 0) reasons.push('no departments');
  if (!/^\d+$/.test(String(loc?.storeNumber ?? ''))) reasons.push(`storeNumber "${loc?.storeNumber}" is not numeric`);
  if (NON_STORE_NAME.test(String(loc?.name ?? ''))) reasons.push(`name "${loc?.name}" looks like a non-store site`);
  return { isStore: reasons.length === 0, reasons };
}

export function toBranch(loc: any): Branch {
  const a = loc?.address ?? {};
  return {
    chain: 'kroger',
    locationId: String(loc.locationId),
    name: String(loc.name ?? '').replace(/^Kroger - /, '').trim() || String(loc.name),
    address: [a.addressLine1, a.city, [a.state, a.zipCode].filter(Boolean).join(' ')].filter(Boolean).join(', '),
  };
}

// ---------- Kroger products ----------
export interface KrogerNormalized {
  product: Product;
  price: PriceObservation | null;
  upc: string | null;
  noBarcode: boolean;
  packageSizeRaw: string | null;
}

/** Kroger UPCs are 13 digits WITHOUT a check digit (verified live): GTIN-14 = body + computed check digit. */
export function krogerGtin14(upc: string | null | undefined): string | null {
  if (!upc || isPlu(upc)) return null;
  const s = stripLeadingZeros(upc);
  if (!s || s.length > 13) return null;
  return padTo(s + String(gs1CheckDigit(s)), 14);
}

function positiveCents(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null;
}

export function normalizeKrogerProduct(
  raw: any,
  branch: Branch,
  meta: { observedAt: string; sourceRef: string; stale: boolean },
): KrogerNormalized {
  const item = (raw?.items ?? [])[0] ?? null;
  const upc: string | null = raw?.upc ?? null;
  const ref = productRef('kroger', String(raw.productId));
  const product: Product = {
    ref,
    chain: 'kroger',
    chainProductId: String(raw.productId),
    gtin14: krogerGtin14(upc),
    brand: raw?.brand ?? null,
    description: String(raw?.description ?? ''),
    size: sizeFromParsed(parsePackageSize(item?.size ?? null)),
    categories: [...new Set<string>((raw?.categories ?? []).map((c: string) => String(c)))],
    flags: [],
    isSample: false,
  };
  const regular = positiveCents(item?.price?.regular);
  const price: PriceObservation | null =
    regular == null
      ? null
      : {
          productRef: ref,
          branch,
          regularCents: regular,
          promoCents: positiveCents(item?.price?.promo),
          source: 'kroger_api',
          observedAt: meta.observedAt,
          sourceRef: meta.sourceRef,
          isSample: false,
          ...(meta.stale ? { stale: true } : {}),
        };
  return { product, price, upc, noBarcode: isPlu(upc), packageSizeRaw: item?.size ?? null };
}

// ---------- FDC ----------
const FDC_NUMBERS: Record<keyof Per100Values, string> = {
  calories: '208',
  protein_g: '203',
  fiber_g: '291',
  addedSugars_g: '539',
  totalSugars_g: '269',
  sodium_mg: '307',
};

function basisOf(unit: unknown): 'g' | 'ml' | null {
  const u = String(unit ?? '').trim().toLowerCase();
  if (['g', 'grm', 'gram', 'grams'].includes(u)) return 'g';
  if (['ml', 'mlt', 'milliliter', 'milliliters'].includes(u)) return 'ml';
  return null;
}

/**
 * FDC Branded food -> NutritionRecord.
 *  - label_scaled (default): labelNutrients per serving x 100 / servingSize (g or mL only)
 *  - fdc_per100 (fallback): when labelNutrients is empty, FDC foodNutrients
 *    (reported per 100 g / 100 mL of the serving unit) - seen on Euromonitor records
 * labelDate = publicationDate (ISO).
 */
export function normalizeFdcFood(food: any, ref: string): NutritionRecord {
  const per = fromFdcLabelNutrients(food?.labelNutrients ?? {});
  const hasLabel = Object.values(per).some((v) => v != null);
  const basis = basisOf(food?.servingSizeUnit);
  const per100: Per100Values = emptyPer100();
  let method: NutritionRecord['method'] = 'label_scaled';
  let outBasis: 'g' | 'ml' | null = null;
  if (hasLabel) {
    const p = toPer100({ servingSize: food?.servingSize, servingSizeUnit: food?.servingSizeUnit, perServing: per });
    outBasis = p.basis === 'mL' ? 'ml' : p.basis;
    if (p.basis) {
      per100.calories = p.values.calories;
      per100.protein_g = p.values.protein;
      per100.fiber_g = p.values.fiber;
      per100.addedSugars_g = p.values.addedSugars;
      per100.totalSugars_g = p.values.sugars;
      per100.sodium_mg = p.values.sodium;
    }
  } else if (basis) {
    method = 'fdc_per100';
    outBasis = basis;
    for (const [k, number] of Object.entries(FDC_NUMBERS) as Array<[keyof Per100Values, string]>) {
      const fn = (food?.foodNutrients ?? []).find((x: any) => String(x?.nutrient?.number ?? x?.nutrientNumber) === number);
      const amt = fn?.amount ?? fn?.value;
      per100[k] = typeof amt === 'number' && Number.isFinite(amt) && amt >= 0 ? amt : null;
    }
  }
  const servingQty = typeof food?.servingSize === 'number' && food.servingSize > 0 ? food.servingSize : null;
  return {
    productRef: ref,
    source: 'fdc',
    per100,
    basis: outBasis,
    servingSize: servingQty != null ? { quantity: servingQty, unit: String(food?.servingSizeUnit ?? '') } : null,
    labelDate: fdcDateToIso(food?.publicationDate ?? food?.publishedDate),
    sourceRef: `fdc:${food?.fdcId}`,
    isSample: false,
    method,
    packageWeight: food?.packageWeight ?? null,
  };
}

/** Apply FDC packageWeight to the product size (size_conflict / size_rejected / size_inferred flags). */
export function applyPackageWeight(product: Product, packageWeight: string | null | undefined): Product {
  const r = reconcileSize(product.size, packageWeight);
  return { ...product, size: r.size, flags: [...product.flags.filter((f) => !['size_conflict', 'size_rejected', 'size_inferred'].includes(f.code)), ...r.flags] };
}
