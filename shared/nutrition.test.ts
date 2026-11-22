import { describe, expect, it } from 'vitest';
import { compareNutrient, fromFdcLabelNutrients, servingToBase, toPer100 } from './nutrition.ts';

describe('servingToBase', () => {
  it('accepts g / GRM / ml / MLT', () => {
    expect(servingToBase(170, 'g')).toEqual({ amount: 170, basis: 'g' });
    expect(servingToBase(170, 'GRM')).toEqual({ amount: 170, basis: 'g' });
    expect(servingToBase(240, 'MLT')).toEqual({ amount: 240, basis: 'mL' });
    expect(servingToBase(240, 'ml')).toEqual({ amount: 240, basis: 'mL' });
  });
  it('rejects unknown units and bad sizes', () => {
    expect(servingToBase(1, 'cup')).toBeNull();
    expect(servingToBase(1, 'ONZ')).toBeNull();
    expect(servingToBase(0, 'g')).toBeNull();
    expect(servingToBase(null, 'g')).toBeNull();
    expect(servingToBase(100, null)).toBeNull();
  });
});

describe('toPer100', () => {
  it('scales per-serving values to per 100 g', () => {
    const r = toPer100({ servingSize: 170, servingSizeUnit: 'g', perServing: { protein: 17, sugars: 6 } });
    expect(r.basis).toBe('g');
    expect(r.values.protein).toBeCloseTo(10, 5);
    expect(r.values.sugars).toBeCloseTo(3.529, 3);
  });
  it('missing nutrient stays null, not 0', () => {
    const r = toPer100({ servingSize: 170, servingSizeUnit: 'g', perServing: { protein: 17 } });
    expect(r.values.addedSugars).toBeNull();
    expect(r.values.fiber).toBeNull();
  });
  it('a reported 0 stays 0 (known zero)', () => {
    const r = toPer100({ servingSize: 50, servingSizeUnit: 'g', perServing: { addedSugars: 0 } });
    expect(r.values.addedSugars).toBe(0);
  });
  it('unconvertible serving -> all null and basis null', () => {
    const r = toPer100({ servingSize: 1, servingSizeUnit: 'cup', perServing: { protein: 8 } });
    expect(r.basis).toBeNull();
    expect(Object.values(r.values).every((v) => v === null)).toBe(true);
  });
});

describe('fromFdcLabelNutrients', () => {
  it('maps FDC keys including addedSugar variants', () => {
    expect(fromFdcLabelNutrients({ protein: { value: 15 }, addedSugar: { value: 0 } })).toMatchObject({
      protein: 15,
      addedSugars: 0,
      fiber: null,
    });
    expect(fromFdcLabelNutrients({ addedSugars: { value: 9 } }).addedSugars).toBe(9);
  });
  it('null/garbage -> null', () => {
    expect(fromFdcLabelNutrients(null).protein).toBeNull();
    expect(fromFdcLabelNutrients({ protein: { value: 'x' } }).protein).toBeNull();
  });
});

describe('compareNutrient', () => {
  const vanilla = toPer100({ servingSize: 150, servingSizeUnit: 'g', perServing: { protein: 6, addedSugars: 12 } });
  const plain = toPer100({ servingSize: 170, servingSizeUnit: 'g', perServing: { protein: 17, addedSugars: 0 } });
  it('computes delta per 100 g', () => {
    const c = compareNutrient(vanilla, plain, 'addedSugars');
    expect(c.basis).toBe('g');
    expect(c.original).toBeCloseTo(8, 5);
    expect(c.replacement).toBe(0);
    expect(c.delta).toBeCloseTo(-8, 5);
  });
  it('unknown on either side -> delta null', () => {
    const c = compareNutrient(vanilla, plain, 'fiber');
    expect(c.delta).toBeNull();
    expect(c.reason).toMatch(/missing/);
  });
  it('g vs mL -> delta null', () => {
    const milk = toPer100({ servingSize: 240, servingSizeUnit: 'ml', perServing: { protein: 8 } });
    const c = compareNutrient(vanilla, milk, 'protein');
    expect(c.delta).toBeNull();
    expect(c.reason).toMatch(/basis/);
  });
  it('unconvertible serving -> null', () => {
    const cup = toPer100({ servingSize: 1, servingSizeUnit: 'cup', perServing: { protein: 8 } });
    expect(compareNutrient(vanilla, cup, 'protein').delta).toBeNull();
  });
});
