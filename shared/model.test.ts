import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chooseNutrition, emptyPer100, reconcileSize, sizeFromParsed, type NutritionRecord } from './model.ts';
import { parsePackageSize } from './units.ts';

const rec = (over: Partial<NutritionRecord>): NutritionRecord => ({
  productRef: 'kroger:1',
  source: 'fdc',
  per100: emptyPer100(),
  basis: 'g',
  servingSize: { quantity: 57, unit: 'g' },
  labelDate: '2021-10-28',
  sourceRef: 'fdc:1',
  isSample: false,
  ...over,
});

describe('sizeFromParsed', () => {
  it('maps units and keeps basis + label', () => {
    expect(sizeFromParsed(parsePackageSize('20 oz'))).toMatchObject({ unit: 'g', basis: 'explicit', label: '20 oz' });
    expect(sizeFromParsed(parsePackageSize('1 gal'))).toMatchObject({ unit: 'ml', basis: 'explicit' });
    expect(sizeFromParsed(parsePackageSize('12 ct'))).toMatchObject({ unit: 'each', quantity: 12 });
    expect(sizeFromParsed(parsePackageSize('8 ct / 6 oz'))).toMatchObject({ unit: 'g', basis: 'inferred_per_unit' });
    expect(sizeFromParsed(null)).toBeNull();
  });
});

describe('reconcileSize (size_conflict)', () => {
  it('Sunbeam case (recorded live 2026-11-22): Kroger 22 oz vs FDC "24 oz/680 g" -> keep 22 oz, flag size_conflict', () => {
    const r = reconcileSize(sizeFromParsed(parsePackageSize('22 oz')), '24 oz/680 g');
    expect(r.size!.label).toBe('22 oz');
    expect(r.flags.map((f) => f.code)).toEqual(['size_conflict']);
  });
  it('within 5%: no flag', () => {
    expect(reconcileSize(sizeFromParsed(parsePackageSize('20 oz')), '20 oz/567 g').flags).toEqual([]);
    expect(reconcileSize(sizeFromParsed(parsePackageSize('20 oz')), '20.9 oz').flags).toEqual([]);
  });
  it('just over 5% flags', () => {
    expect(reconcileSize(sizeFromParsed(parsePackageSize('20 oz')), '21.1 oz').flags[0]!.code).toBe('size_conflict');
  });
  it('inferred multipack > 10% off -> size rejected (null)', () => {
    // Lay's "10 ct / 10 oz" is a 10 oz TOTAL; reading it as 10 x 10 oz is wrong
    const r = reconcileSize(sizeFromParsed(parsePackageSize('10 ct / 10 oz')), '10 oz/283 g');
    expect(r.size).toBeNull();
    expect(r.flags[0]!.code).toBe('size_rejected');
  });
  it('inferred multipack confirmed -> no flag; unconfirmed -> size_inferred', () => {
    expect(reconcileSize(sizeFromParsed(parsePackageSize('8 ct / 6 oz')), '48 ONZ').flags).toEqual([]);
    expect(reconcileSize(sizeFromParsed(parsePackageSize('8 ct / 6 oz')), null).flags[0]!.code).toBe('size_inferred');
  });
  it('no packageWeight on explicit size: nothing to flag', () => {
    expect(reconcileSize(sizeFromParsed(parsePackageSize('32 oz')), null).flags).toEqual([]);
  });
});

describe('chooseNutrition (label precedence)', () => {
  const fdc = rec({ source: 'fdc', labelDate: '2021-10-28', sourceRef: 'fdc:2032747' });
  it('label observation newer than FDC wins; both kept', () => {
    const label = rec({ source: 'label_observation', labelDate: '2026-11-20', sourceRef: 'photo-1' });
    const c = chooseNutrition([fdc, label])!;
    expect(c.used).toBe(label);
    expect(c.reason).toBe('label_newer_than_fdc');
    expect(c.alternatives).toEqual([{ source: 'fdc', sourceRef: 'fdc:2032747', labelDate: '2021-10-28' }]);
  });
  it('label observation older than (or same as) FDC loses', () => {
    const old = rec({ source: 'label_observation', labelDate: '2020-01-01', sourceRef: 'photo-0' });
    expect(chooseNutrition([fdc, old])!.used).toBe(fdc);
    const same = rec({ source: 'label_observation', labelDate: '2021-10-28', sourceRef: 'photo-s' });
    expect(chooseNutrition([fdc, same])!.used).toBe(fdc);
  });
  it('undated FDC loses to a dated label', () => {
    const undated = rec({ source: 'fdc', labelDate: null });
    const label = rec({ source: 'label_observation', labelDate: '2025-01-01' });
    expect(chooseNutrition([undated, label])!.reason).toBe('fdc_label_undated');
  });
  it('single record / none', () => {
    expect(chooseNutrition([fdc])!.reason).toBe('only_record');
    expect(chooseNutrition([])).toBeNull();
  });
});

describe('sample data file', () => {
  it('every record in data/sample/ is marked isSample: true', () => {
    const file = path.join(__dirname, '..', 'data', 'sample', 'label-observations.json');
    const j = JSON.parse(readFileSync(file, 'utf8'));
    expect(j.records.length).toBeGreaterThan(0);
    for (const r of j.records) expect(r.isSample).toBe(true);
  });
});
