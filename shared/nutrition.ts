/**
 * Nutrient comparison on an equal portion (per 100 g or per 100 mL).
 * Pure functions. Unknown is null - never 0, never estimated.
 */
import type { Basis } from './units.ts';

export const NUTRIENT_KEYS = ['calories', 'protein', 'fiber', 'addedSugars', 'sugars', 'sodium'] as const;
export type NutrientKey = (typeof NUTRIENT_KEYS)[number];

export const NUTRIENT_UNITS: Record<NutrientKey, string> = {
  calories: 'kcal',
  protein: 'g',
  fiber: 'g',
  addedSugars: 'g',
  sugars: 'g',
  sodium: 'mg',
};

export type NutrientValues = Record<NutrientKey, number | null>;

export interface LabelFacts {
  servingSize: number | null | undefined;
  servingSizeUnit: string | null | undefined;
  perServing: Partial<Record<NutrientKey, number | null | undefined>>;
}

export interface Per100 {
  basis: Exclude<Basis, 'count'> | null; // null = serving not convertible
  values: NutrientValues;
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Convert an FDC serving size to grams or mL. Only unambiguous metric units
 * are accepted ("g", "GRM", "ml", "mL", "MLT"); anything else -> null.
 */
export function servingToBase(
  size: number | null | undefined,
  unit: string | null | undefined,
): { amount: number; basis: 'g' | 'mL' } | null {
  const amt = finiteOrNull(size);
  if (amt == null || amt === 0 || !unit) return null;
  const u = unit.trim().toLowerCase();
  if (u === 'g' || u === 'grm' || u === 'gram' || u === 'grams') return { amount: amt, basis: 'g' };
  if (u === 'ml' || u === 'mlt' || u === 'milliliter' || u === 'milliliters') return { amount: amt, basis: 'mL' };
  return null;
}

function emptyValues(): NutrientValues {
  return Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, null])) as NutrientValues;
}

/** Scale per-serving label values to per 100 g / 100 mL. */
export function toPer100(facts: LabelFacts): Per100 {
  const base = servingToBase(facts.servingSize, facts.servingSizeUnit);
  const values = emptyValues();
  if (!base) return { basis: null, values };
  for (const k of NUTRIENT_KEYS) {
    const v = finiteOrNull(facts.perServing[k]);
    values[k] = v == null ? null : (v * 100) / base.amount;
  }
  return { basis: base.basis, values };
}

/**
 * Map FDC `labelNutrients` (branded foods) to our keys. FDC uses
 * { protein: { value } }, and added sugar has appeared as `addedSugar` or
 * `addedSugars`. A missing key stays null.
 */
export function fromFdcLabelNutrients(
  ln: Record<string, { value?: unknown } | undefined> | null | undefined,
): Partial<Record<NutrientKey, number | null>> {
  const get = (...keys: string[]) => {
    for (const k of keys) {
      const v = finiteOrNull(ln?.[k]?.value);
      if (v != null) return v;
    }
    return null;
  };
  return {
    calories: get('calories'),
    protein: get('protein'),
    fiber: get('fiber'),
    addedSugars: get('addedSugar', 'addedSugars'),
    sugars: get('sugars'),
    sodium: get('sodium'),
  };
}

export interface NutrientComparison {
  nutrient: NutrientKey;
  unit: string;
  basis: 'g' | 'mL' | null;
  original: number | null;
  replacement: number | null;
  /** replacement - original, per 100 basis. null if either unknown or bases differ. */
  delta: number | null;
  reason?: string;
}

export function compareNutrient(original: Per100, replacement: Per100, nutrient: NutrientKey): NutrientComparison {
  const base: NutrientComparison = {
    nutrient,
    unit: NUTRIENT_UNITS[nutrient],
    basis: null,
    original: original.values[nutrient],
    replacement: replacement.values[nutrient],
    delta: null,
  };
  if (original.basis == null || replacement.basis == null) {
    return { ...base, original: null, replacement: null, reason: 'serving size not convertible to g/mL' };
  }
  if (original.basis !== replacement.basis) {
    return { ...base, reason: `basis mismatch (${original.basis} vs ${replacement.basis})` };
  }
  if (base.original == null || base.replacement == null) {
    return { ...base, basis: original.basis, reason: 'nutrient missing on label' };
  }
  return { ...base, basis: original.basis, delta: base.replacement - base.original };
}

export function compareAll(original: Per100, replacement: Per100): NutrientComparison[] {
  return NUTRIENT_KEYS.map((k) => compareNutrient(original, replacement, k));
}
