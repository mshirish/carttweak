import { describe, expect, it } from 'vitest';
import { parsePackageSize } from './units.ts';

describe('parsePackageSize', () => {
  it('oz is mass', () => {
    const r = parsePackageSize('32 oz')!;
    expect(r.basis).toBe('g');
    expect(r.amount).toBeCloseTo(907.18, 2);
  });
  it('fl oz is volume', () => {
    const r = parsePackageSize('64 fl oz')!;
    expect(r.basis).toBe('mL');
    expect(r.amount).toBeCloseTo(1892.71, 2);
  });
  it('lb, g, kg', () => {
    expect(parsePackageSize('1.5 lb')!.amount).toBeCloseTo(680.39, 2);
    expect(parsePackageSize('500 g')).toMatchObject({ basis: 'g', amount: 500 });
    expect(parsePackageSize('1 kg')).toMatchObject({ basis: 'g', amount: 1000 });
  });
  it('ct is count', () => {
    expect(parsePackageSize('12 ct')).toMatchObject({ basis: 'count', amount: 12 });
  });
  it('fractions and decimals', () => {
    expect(parsePackageSize('1/2 gal')!.amount).toBeCloseTo(1892.71, 2);
    expect(parsePackageSize('5.3 oz')!.amount).toBeCloseTo(150.25, 2);
    expect(parsePackageSize('.5 lb')!.amount).toBeCloseTo(226.8, 1);
  });
  it('tolerates case / spacing / punctuation', () => {
    expect(parsePackageSize('  24 OZ ')!.basis).toBe('g');
    expect(parsePackageSize('16oz')!.basis).toBe('g');
    expect(parsePackageSize('16 fl. oz.')!.basis).toBe('mL');
  });
  it('returns null for ambiguous or unparseable strings', () => {
    expect(parsePackageSize('6 ct / 5.3 oz')).toBeNull();
    expect(parsePackageSize('2 x 16 oz')).toBeNull();
    expect(parsePackageSize('1 lb 4 oz')).toBeNull();
    expect(parsePackageSize('family size')).toBeNull();
    expect(parsePackageSize('')).toBeNull();
    expect(parsePackageSize(null)).toBeNull();
    expect(parsePackageSize('0 oz')).toBeNull();
    expect(parsePackageSize('12 bananas')).toBeNull();
  });
});
