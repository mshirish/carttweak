import { describe, expect, it } from 'vitest';
import { crossCheckPackageWeight, parsePackageSize, parsePackageWeight } from './units.ts';

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
    expect(parsePackageSize('1 lb 4 oz')).toBeNull();
    expect(parsePackageSize('family size')).toBeNull();
    expect(parsePackageSize('')).toBeNull();
    expect(parsePackageSize(null)).toBeNull();
    expect(parsePackageSize('0 oz')).toBeNull();
    expect(parsePackageSize('12 bananas')).toBeNull();
  });
});

describe('sizeBasis', () => {
  it('single totals are explicit', () => {
    expect(parsePackageSize('32 oz')!.sizeBasis).toBe('explicit');
    expect(parsePackageSize('12 ct')!.sizeBasis).toBe('explicit');
  });
});

describe('multipack sizes (N x per-unit, inferred)', () => {
  it('"N ct / X oz" = N x X, inferred_per_unit', () => {
    const r = parsePackageSize('6 ct / 5.3 oz')!;
    expect(r).toMatchObject({ basis: 'g', sizeBasis: 'inferred_per_unit', units: 6, unit: 'oz' });
    expect(r.amount).toBeCloseTo(6 * 5.3 * 28.349523125, 6);
    expect(r.perUnitAmount).toBeCloseTo(150.25, 2);
  });
  it('variants: pk, count, no spaces, x, fl oz', () => {
    expect(parsePackageSize('4 pk/6 fl oz')).toMatchObject({ basis: 'mL', units: 4, sizeBasis: 'inferred_per_unit' });
    expect(parsePackageSize('4 pk/6 fl oz')!.amount).toBeCloseTo(4 * 6 * 29.5735295625, 6);
    expect(parsePackageSize('8 count / 1 oz')!.units).toBe(8);
    expect(parsePackageSize('6ct/5.3oz')!.amount).toBeCloseTo(6 * 150.25, 1);
    expect(parsePackageSize('2 x 16 oz')!.amount).toBeCloseTo(907.18, 2);
    expect(parsePackageSize('12 \u00d7 12 fl oz')!.basis).toBe('mL');
  });
  it('live formats (2026-11-22): "5.3 oz., 4 pack", "12 pk / 12 fl oz", "1 ea"', () => {
    expect(parsePackageSize('5.3 oz., 4 pack')).toMatchObject({ units: 4, basis: 'g', sizeBasis: 'inferred_per_unit' });
    expect(parsePackageSize('5.3 oz., 4 pack')!.amount).toBeCloseTo(4 * 150.25, 1);
    expect(parsePackageSize('12 pk / 12 fl oz')!.amount).toBeCloseTo(144 * 29.5735295625, 6);
    expect(parsePackageSize('1 ea')).toMatchObject({ basis: 'count', amount: 1, sizeBasis: 'explicit' });
  });
  it('still rejects mixed units and nonsense', () => {
    expect(parsePackageSize('1 lb 4 oz')).toBeNull();
    expect(parsePackageSize('6 ct / 12 ct')).toBeNull();
    expect(parsePackageSize('0 ct / 5 oz')).toBeNull();
    expect(parsePackageSize('6 ct / family size')).toBeNull();
    expect(parsePackageSize('2.5 x 16 oz')).toBeNull();
  });
});

describe('parsePackageWeight (FDC)', () => {
  it('reads both halves', () => {
    const q = parsePackageWeight('32 oz/907 g');
    expect(q).toHaveLength(2);
    expect(q[0]!.amount).toBeCloseTo(907.18, 2);
    expect(q[1]!.amount).toBe(907);
  });
  it('GS1 unit codes seen live in FDC (ONZ, GRM, MLT)', () => {
    expect(parsePackageWeight('48 ONZ')[0]!.amount).toBeCloseTo(48 * 28.349523125, 6);
    expect(parsePackageWeight('24.0 ONZ')[0]).toMatchObject({ basis: 'g' });
    expect(parsePackageWeight('680 GRM')[0]).toEqual({ amount: 680, basis: 'g' });
    expect(parsePackageWeight('946 MLT')[0]).toEqual({ amount: 946, basis: 'mL' });
    expect(parsePackageWeight('16 oz/1 lbs/454 g')).toHaveLength(3);
  });
  it('GS1 codes are NOT accepted in retailer size strings', () => {
    expect(parsePackageSize('48 ONZ')).toBeNull();
  });
  it('empty / junk', () => {
    expect(parsePackageWeight(null)).toEqual([]);
    expect(parsePackageWeight('n/a')).toEqual([]);
  });
});

describe('crossCheckPackageWeight', () => {
  const six = parsePackageSize('6 ct / 5.3 oz')!; // ~901.5 g
  it('agrees within 10%', () => {
    const c = crossCheckPackageWeight(six, '31.8 oz/901 g');
    expect(c.status).toBe('agree');
    expect(c.relativeDifference!).toBeLessThan(0.01);
  });
  it('disagrees beyond 10% (e.g. FDC lists one cup)', () => {
    const c = crossCheckPackageWeight(six, '5.3 oz/150 g');
    expect(c.status).toBe('disagree');
    expect(c.reason).toMatch(/apart/);
  });
  it('boundary: exactly 10% agrees, 10.5% disagrees', () => {
    const s = parsePackageSize('2 x 50 g')!; // 100 g
    expect(crossCheckPackageWeight(s, '110 g').status).toBe('agree');
    expect(crossCheckPackageWeight(s, '110.5 g').status).toBe('disagree');
  });
  it('live case: Yoplait "8 ct / 6 oz" vs FDC "48 ONZ" agrees exactly', () => {
    const c = crossCheckPackageWeight(parsePackageSize('8 ct / 6 oz')!, '48 ONZ');
    expect(c.status).toBe('agree');
    expect(c.relativeDifference!).toBeCloseTo(0, 9);
  });
  it('not comparable when missing or different basis', () => {
    expect(crossCheckPackageWeight(six, null).status).toBe('not_comparable');
    const fl = parsePackageSize('4 pk/6 fl oz')!;
    expect(crossCheckPackageWeight(fl, '680 g').status).toBe('not_comparable');
  });
});
