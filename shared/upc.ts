/**
 * UPC / EAN / GTIN normalization. Pure functions, no I/O.
 *
 * Retailer and FDC barcodes are stored inconsistently: leading zeros may be
 * dropped and the GS1 check digit may or may not be present. We never assume
 * which form a source uses. Instead we generate candidate forms for search,
 * and accept a match only when both sides normalize to the same GTIN-14.
 */

export function digitsOnly(code: string): string {
  return (code ?? '').replace(/\D/g, '');
}

export function stripLeadingZeros(code: string): string {
  const s = digitsOnly(code).replace(/^0+/, '');
  return s;
}

/** GS1 check digit for a digit string WITHOUT its check digit. */
export function gs1CheckDigit(body: string): number {
  const d = digitsOnly(body);
  if (d.length === 0) throw new Error('gs1CheckDigit: empty body');
  let sum = 0;
  // Weights alternate 3,1,3,1... starting from the rightmost digit of the body.
  for (let i = 0; i < d.length; i++) {
    const digit = d.charCodeAt(d.length - 1 - i) - 48;
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/** True if the last digit of `code` is a valid GS1 check digit for the rest. */
export function hasValidCheckDigit(code: string): boolean {
  const d = digitsOnly(code);
  if (d.length < 2) return false;
  return gs1CheckDigit(d.slice(0, -1)) === Number(d[d.length - 1]);
}

export function padTo(code: string, len: number): string | null {
  const d = digitsOnly(code);
  if (d.length > len) return null;
  return d.padStart(len, '0');
}

/**
 * Normalize a barcode that is believed to INCLUDE its check digit (e.g. FDC
 * gtinUpc) to GTIN-14. Returns null if empty, too long, all zeros, or the
 * check digit does not validate.
 */
export function toGtin14(code: string): string | null {
  const s = stripLeadingZeros(code);
  if (s.length < 2 || s.length > 14) return null;
  if (!hasValidCheckDigit(s)) return null;
  return padTo(s, 14);
}

export type CheckDigitInterpretation = 'check-digit-present' | 'check-digit-appended';

export interface Gtin14Interpretation {
  gtin14: string;
  interpretation: CheckDigitInterpretation;
}

/**
 * A retailer code may or may not already carry its check digit. Return every
 * self-consistent GTIN-14 reading of it:
 *  - 'check-digit-present': the last digit validates as a check digit
 *  - 'check-digit-appended': treat all digits as the body, compute and append
 */
export function gtin14Interpretations(code: string): Gtin14Interpretation[] {
  const s = stripLeadingZeros(code);
  const out: Gtin14Interpretation[] = [];
  if (s.length === 0) return out;
  if (s.length >= 2 && s.length <= 14 && hasValidCheckDigit(s)) {
    out.push({ gtin14: padTo(s, 14)!, interpretation: 'check-digit-present' });
  }
  if (s.length <= 13) {
    const withCheck = s + String(gs1CheckDigit(s));
    const g = padTo(withCheck, 14)!;
    if (!out.some((o) => o.gtin14 === g)) {
      out.push({ gtin14: g, interpretation: 'check-digit-appended' });
    }
  }
  return out;
}

export type CandidateForm =
  | 'raw'
  | 'stripped'
  | 'stripped+check'
  | 'upca12'
  | 'ean13'
  | 'gtin14'
  | 'upca12+check'
  | 'ean13+check'
  | 'gtin14+check';

export interface UpcCandidate {
  form: CandidateForm;
  value: string;
}

/**
 * Candidate textual forms of a barcode to try against a search index whose
 * storage format is unknown. Deduplicated by value; first label wins.
 * Order: forms that append a computed check digit first (most retailer
 * feeds omit it), then as-is forms.
 */
export function upcCandidates(code: string): UpcCandidate[] {
  const raw = digitsOnly(code);
  const s = stripLeadingZeros(code);
  const list: UpcCandidate[] = [];
  const push = (form: CandidateForm, value: string | null) => {
    if (!value) return;
    if (list.some((c) => c.value === value)) return;
    list.push({ form, value });
  };
  if (s.length === 0) return list;

  if (s.length <= 13) {
    const wc = s + String(gs1CheckDigit(s));
    push('upca12+check', padTo(wc, 12));
    push('ean13+check', padTo(wc, 13));
    push('gtin14+check', padTo(wc, 14));
    push('stripped+check', wc);
  }
  push('upca12', padTo(s, 12));
  push('ean13', padTo(s, 13));
  push('gtin14', padTo(s, 14));
  push('stripped', s);
  push('raw', raw);
  return list;
}

export interface BarcodeMatch {
  gtin14: string;
  interpretation: CheckDigitInterpretation;
}

/**
 * Strict match: the retailer code (any interpretation) and the reference
 * code (assumed to include its check digit) must yield the same GTIN-14.
 */
export function matchBarcodes(retailerCode: string, referenceCode: string): BarcodeMatch | null {
  const ref = toGtin14(referenceCode);
  if (!ref) return null;
  const hit = gtin14Interpretations(retailerCode).find((i) => i.gtin14 === ref);
  return hit ? { gtin14: hit.gtin14, interpretation: hit.interpretation } : null;
}
