import { describe, expect, it } from 'vitest';
import {
  gs1CheckDigit,
  gtin14Interpretations,
  hasValidCheckDigit,
  matchBarcodes,
  toGtin14,
  upcCandidates,
} from './upc.ts';

// Reference codes with published check digits:
//   UPC-A 036000291452 (GS1/Wikipedia UPC-A example, check digit 2)
//   EAN-13 4006381333931 (Wikipedia EAN-13 example, check digit 1)

describe('gs1CheckDigit', () => {
  it('computes UPC-A check digit', () => {
    expect(gs1CheckDigit('03600029145')).toBe(2);
  });
  it('computes EAN-13 check digit', () => {
    expect(gs1CheckDigit('400638133393')).toBe(1);
  });
  it('is invariant to leading-zero padding', () => {
    expect(gs1CheckDigit('0003600029145')).toBe(2);
    expect(gs1CheckDigit('3600029145')).toBe(2);
  });
  it('validates', () => {
    expect(hasValidCheckDigit('036000291452')).toBe(true);
    expect(hasValidCheckDigit('036000291453')).toBe(false);
    expect(hasValidCheckDigit('4006381333931')).toBe(true);
  });
});

describe('toGtin14', () => {
  it('pads valid codes to 14 digits', () => {
    expect(toGtin14('036000291452')).toBe('00036000291452');
    expect(toGtin14('36000291452')).toBe('00036000291452'); // leading zero dropped
    expect(toGtin14('0036000291452')).toBe('00036000291452');
    expect(toGtin14('4006381333931')).toBe('04006381333931');
  });
  it('rejects invalid check digit, empty, too long', () => {
    expect(toGtin14('036000291453')).toBeNull();
    expect(toGtin14('')).toBeNull();
    expect(toGtin14('0000')).toBeNull();
    expect(toGtin14('123456789012345')).toBeNull();
  });
  it('ignores non-digits', () => {
    expect(toGtin14('0 36000 29145 2')).toBe('00036000291452');
  });
});

describe('gtin14Interpretations', () => {
  it('Kroger-style 13 digits without check digit -> appended', () => {
    const r = gtin14Interpretations('0003600029145');
    expect(r).toContainEqual({ gtin14: '00036000291452', interpretation: 'check-digit-appended' });
  });
  it('code already carrying a valid check digit -> present (and appended reading too)', () => {
    const r = gtin14Interpretations('036000291452');
    expect(r[0]).toEqual({ gtin14: '00036000291452', interpretation: 'check-digit-present' });
    expect(r.some((x) => x.interpretation === 'check-digit-appended')).toBe(true);
  });
  it('empty yields nothing', () => {
    expect(gtin14Interpretations('000')).toEqual([]);
  });
});

describe('upcCandidates', () => {
  const c = upcCandidates('0003600029145');
  const values = c.map((x) => x.value);
  it('includes UPC-A / EAN-13 / GTIN-14 with computed check digit', () => {
    expect(c).toContainEqual({ form: 'upca12+check', value: '036000291452' });
    expect(c).toContainEqual({ form: 'ean13+check', value: '0036000291452' });
    expect(c).toContainEqual({ form: 'gtin14+check', value: '00036000291452' });
    expect(c).toContainEqual({ form: 'stripped+check', value: '36000291452' });
  });
  it('includes as-is forms and stripped/raw', () => {
    expect(values).toContain('3600029145');
    expect(values).toContain('0003600029145');
    expect(values).toContain('00003600029145');
  });
  it('has no duplicates', () => {
    expect(new Set(values).size).toBe(values.length);
  });
  it('empty input -> no candidates', () => {
    expect(upcCandidates('')).toEqual([]);
  });
});

describe('matchBarcodes', () => {
  it('matches Kroger 13-digit (no check) to FDC 12-digit UPC-A', () => {
    expect(matchBarcodes('0003600029145', '036000291452')).toEqual({
      gtin14: '00036000291452',
      interpretation: 'check-digit-appended',
    });
  });
  it('matches when FDC dropped the leading zero', () => {
    expect(matchBarcodes('0003600029145', '36000291452')?.gtin14).toBe('00036000291452');
  });
  it('rejects a different product', () => {
    expect(matchBarcodes('0003600029145', '036000291469')).toBeNull();
  });
  it('rejects FDC code with invalid check digit', () => {
    expect(matchBarcodes('0003600029145', '036000291453')).toBeNull();
  });
});
