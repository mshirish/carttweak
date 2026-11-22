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

/**
 * explicit: the string states one total ("32 oz").
 * inferred_per_unit: a multipack ("6 ct / 5.3 oz", "2 x 16 oz") read as
 * N x per-unit size. The total is an inference and should be cross-checked.
 */
export type SizeBasis = 'explicit' | 'inferred_per_unit';

export interface ParsedSize extends Quantity {
  original: string;
  unit: string; // the unit as recognized, e.g. "oz", "fl oz"
  sizeBasis: SizeBasis;
  /** multipack only: number of units and size of one unit (canonical basis) */
  units?: number;
  perUnitAmount?: number;
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

const NUM = String.raw`(?:\d+\s+)?\d+\/\d+|\d+(?:\.\d+)?|\.\d+`;

// GS1 / UN-ECE Rec 20 unit codes, as FDC packageWeight uses them ("48 ONZ", "680 GRM").
// Only used for FDC packageWeight, never for retailer size strings.
const GS1_UNIT_TABLE: typeof UNIT_TABLE = [
  { re: /^onz$/i, unit: 'oz', basis: 'g', factor: G_PER_OZ },
  { re: /^oza$/i, unit: 'fl oz', basis: 'mL', factor: ML_PER_FL_OZ },
  { re: /^grm$/i, unit: 'g', basis: 'g', factor: 1 },
  { re: /^kgm$/i, unit: 'kg', basis: 'g', factor: 1000 },
  { re: /^lbr$/i, unit: 'lb', basis: 'g', factor: G_PER_LB },
  { re: /^mlt$/i, unit: 'mL', basis: 'mL', factor: 1 },
  { re: /^ltr$/i, unit: 'L', basis: 'mL', factor: 1000 },
  { re: /^gll$/i, unit: 'gal', basis: 'mL', factor: ML_PER_GAL },
];

/** Strict single "<number> <unit>" -> canonical quantity, or null. */
function parseSingle(s: string, table = UNIT_TABLE): { amount: number; basis: Basis; unit: string } | null {
  const m = new RegExp(String.raw`^(${NUM})\s*-?\s*([a-z][a-z.\s]*)$`, 'i').exec(s.trim());
  if (!m) return null;
  const num = parseNumber(m[1]!);
  if (num == null || !(num > 0) || !Number.isFinite(num)) return null;
  const unitStr = m[2]!.trim();
  const entry = table.find((u) => u.re.test(unitStr));
  if (!entry) return null;
  return { amount: num * entry.factor, basis: entry.basis, unit: entry.unit };
}

/**
 * Parse a retailer size string.
 *  - Single total: "32 oz", "1.5 lb", "64 fl oz", "500 g", "1/2 gal", "12 ct"
 *    -> sizeBasis 'explicit'.
 *  - Multipack: "6 ct / 5.3 oz", "4 pk/6 fl oz", "2 x 16 oz", "12 - 1 oz"
 *    -> N x per-unit, sizeBasis 'inferred_per_unit'. The per-unit reading is
 *    a guess (some retailers put the total after the slash); callers should
 *    cross-check with an independent package weight (crossCheckPackageWeight).
 * Anything else (e.g. "1 lb 4 oz") -> null.
 */
export function parsePackageSize(input: string | null | undefined): ParsedSize | null {
  if (input == null) return null;
  const original = String(input);
  const s = original.trim().replace(/\s+/g, ' ');
  if (!s) return null;

  const single = parseSingle(s);
  if (single) return { original, ...single, sizeBasis: 'explicit' };

  // "N ct / X unit", "N pk / X unit", "N count / X unit"
  let m = /^(\d+)\s*(?:ct\.?|count|pk\.?|pack)\s*(?:\/|-|,)\s*(.+)$/i.exec(s);
  // "N x X unit", "N × X unit"
  if (!m) m = /^(\d+)\s*[x×]\s*(.+)$/i.exec(s);
  if (!m) return null;
  const units = Number(m[1]);
  if (!Number.isInteger(units) || units < 1) return null;
  const per = parseSingle(m[2]!);
  if (!per || per.basis === 'count') return null; // "6 ct / 12 ct" is meaningless
  return {
    original,
    unit: per.unit,
    basis: per.basis,
    amount: units * per.amount,
    sizeBasis: 'inferred_per_unit',
    units,
    perUnitAmount: per.amount,
  };
}

/**
 * Parse an FDC `packageWeight` such as "32 oz/907 g", "5.3 OZ/150 g",
 * "16 oz/1 lbs/454 g", "48 ONZ", "24.0 ONZ" (GS1 unit codes appear in
 * GDSN-sourced records). Returns every quantity it can read.
 */
export function parsePackageWeight(input: string | null | undefined): Quantity[] {
  if (!input) return [];
  return String(input)
    .split(/[\/,;|]/)
    .map((part) => parseSingle(part, [...UNIT_TABLE, ...GS1_UNIT_TABLE]))
    .filter((q): q is NonNullable<typeof q> => q != null && q.basis !== 'count')
    .map((q) => ({ amount: q.amount, basis: q.basis }));
}

export interface PackageWeightCheck {
  status: 'agree' | 'disagree' | 'not_comparable';
  packageWeight: string | null;
  packageAmount: number | null; // canonical, same basis as size
  relativeDifference: number | null; // |pkg - size| / size
  reason: string;
}

/**
 * Compare a parsed retailer size against FDC packageWeight. 'disagree' when
 * they differ by more than `tolerance` (default 10%) on the same basis.
 * If FDC lists only another basis (e.g. g for a fl oz product), the check is
 * 'not_comparable' - never converted across g/mL.
 */
export function crossCheckPackageWeight(
  size: ParsedSize,
  packageWeight: string | null | undefined,
  tolerance = 0.1,
): PackageWeightCheck {
  const pw = packageWeight ?? null;
  const qs = parsePackageWeight(pw).filter((q) => q.basis === size.basis);
  if (!pw) return { status: 'not_comparable', packageWeight: null, packageAmount: null, relativeDifference: null, reason: 'FDC has no packageWeight' };
  if (!qs.length) {
    return { status: 'not_comparable', packageWeight: pw, packageAmount: null, relativeDifference: null, reason: `packageWeight "${pw}" has no ${size.basis} quantity` };
  }
  // closest stated quantity (both halves of "oz/g" should agree anyway)
  const best = qs
    .map((q) => ({ q, rel: Math.abs(q.amount - size.amount) / size.amount }))
    .sort((a, b) => a.rel - b.rel)[0]!;
  const status = best.rel > tolerance ? 'disagree' : 'agree';
  return {
    status,
    packageWeight: pw,
    packageAmount: best.q.amount,
    relativeDifference: best.rel,
    reason:
      `size "${size.original}" = ${size.amount.toFixed(1)} ${size.basis} vs FDC packageWeight "${pw}" = ` +
      `${best.q.amount.toFixed(1)} ${size.basis} (${(best.rel * 100).toFixed(1)}% apart, limit ${tolerance * 100}%)`,
  };
}
