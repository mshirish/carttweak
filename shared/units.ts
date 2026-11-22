/**
 * Package-size parsing. Pure functions, no I/O.
 * Canonical units: grams (mass), millilitres (volume), count.
 * Anything ambiguous or unrecognized returns null - never guessed.
 */

export type Basis = 'g' | 'mL' | 'count';

export interface Quantity {
  amount: number;
  basis: Basis;
}

export interface ParsedSize extends Quantity {
  original: string;
  unit: string; // the unit as recognized, e.g. "oz", "fl oz"
}

const G_PER_OZ = 28.349523125;
const G_PER_LB = 453.59237;
const ML_PER_FL_OZ = 29.5735295625;
const ML_PER_GAL = 3785.411784;
const ML_PER_QT = 946.352946;
const ML_PER_PT = 473.176473;

// Order matters: multi-word / longer tokens first.
const UNIT_TABLE: Array<{ re: RegExp; unit: string; basis: Basis; factor: number }> = [
  { re: /^(fl\.?\s*oz\.?|fluid\s+ounces?)$/i, unit: 'fl oz', basis: 'mL', factor: ML_PER_FL_OZ },
  { re: /^(oz\.?|ounces?)$/i, unit: 'oz', basis: 'g', factor: G_PER_OZ },
  { re: /^(lbs?\.?|pounds?)$/i, unit: 'lb', basis: 'g', factor: G_PER_LB },
  { re: /^(kg|kilograms?)$/i, unit: 'kg', basis: 'g', factor: 1000 },
  { re: /^(g|gm|grams?)$/i, unit: 'g', basis: 'g', factor: 1 },
  { re: /^(ml|milliliters?|millilitres?)$/i, unit: 'mL', basis: 'mL', factor: 1 },
  { re: /^(l|liters?|litres?|ltr)$/i, unit: 'L', basis: 'mL', factor: 1000 },
  { re: /^(gal\.?|gallons?)$/i, unit: 'gal', basis: 'mL', factor: ML_PER_GAL },
  { re: /^(qt\.?|quarts?)$/i, unit: 'qt', basis: 'mL', factor: ML_PER_QT },
  { re: /^(pt\.?|pints?)$/i, unit: 'pt', basis: 'mL', factor: ML_PER_PT },
  { re: /^(ct\.?|count|pk|pack)$/i, unit: 'ct', basis: 'count', factor: 1 },
];

function parseNumber(s: string): number | null {
  const t = s.trim();
  // mixed fraction "1 1/2"
  let m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(t);
  if (m) {
    const den = Number(m[3]);
    return den === 0 ? null : Number(m[1]) + Number(m[2]) / den;
  }
  m = /^(\d+)\/(\d+)$/.exec(t);
  if (m) {
    const den = Number(m[2]);
    return den === 0 ? null : Number(m[1]) / den;
  }
  m = /^(\d+(?:\.\d+)?|\.\d+)$/.exec(t);
  if (m) return Number(m[1]);
  return null;
}

/**
 * Parse a retailer size string like "32 oz", "1.5 lb", "64 fl oz", "500 g",
 * "1/2 gal", "12 ct". Multi-quantity strings ("6 ct / 5.3 oz", "2 x 16 oz")
 * are ambiguous (per-item vs total) and return null.
 */
export function parsePackageSize(input: string | null | undefined): ParsedSize | null {
  if (input == null) return null;
  const original = String(input);
  const s = original.trim().replace(/\s+/g, ' ');
  if (!s) return null;
  // Strict single "<number> <unit>" form. Multi-quantity strings fail here
  // because the unit part may not contain digits, '/', ',' or '+'.
  const m = /^((?:\d+\s+)?\d+\/\d+|\d+(?:\.\d+)?|\.\d+)\s*-?\s*([a-z][a-z.\s]*)$/i.exec(s);
  if (!m) return null;
  const num = parseNumber(m[1]!);
  if (num == null || !(num > 0) || !Number.isFinite(num)) return null;
  const unitStr = m[2]!.trim();
  const entry = UNIT_TABLE.find((u) => u.re.test(unitStr));
  if (!entry) return null;
  return { original, unit: entry.unit, basis: entry.basis, amount: num * entry.factor };
}
