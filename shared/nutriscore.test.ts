import { describe, expect, it } from 'vitest';
import { gradeFor, nutriCategory, nutriScore, pointsTo100, scoreReason, type NutriInput } from './nutriscore.ts';

// Worked examples computed by hand from the original (2017) Nutri-Score tables.
const base: NutriInput = { energyKcal: 0, totalSugars_g: 0, satFat_g: 0, sodium_mg: 0, fiber_g: 0, protein_g: 0, fvlPercent: 0 };

describe('Nutri-Score (original 2017 algorithm)', () => {
  it('white bread-like: 246 kcal, sugars 8.8, sat fat 0.5, sodium 316 mg, fiber 3.5, protein 7.0 -> 1 point, B', () => {
    // energy 1029 kJ -> 3; sugars 8.8 -> 1; sat fat 0.5 -> 0; sodium 316 -> 3 => N = 7
    // fiber 3.5 -> 3; protein 7.0 -> 4 (N < 11 so counted); FVL 0 => P = 7  -> 0 points... (7 - 7)
    const r = nutriScore({ ...base, energyKcal: 246, totalSugars_g: 8.8, satFat_g: 0.5, sodium_mg: 316, fiber_g: 3.5, protein_g: 7.0 }, 'food');
    expect(r.scored && r.components).toMatchObject({ energy: 3, sugars: 1, satFat: 0, sodium: 3, fiber: 3, protein: 4, fvl: 0, proteinCounted: true });
    expect(r.scored && [r.points, r.grade]).toEqual([0, 'B']);
  });
  it('protein not counted when N >= 11 and FVL < 5 (chocolate-cookie-like)', () => {
    // 480 kcal (2008 kJ -> 5), sugars 35 (-> 7), sat fat 9 (-> 8), sodium 300 (-> 3) => N = 23
    // fiber 3 (-> 3), protein 6 (-> 3 but NOT counted) => points 20 -> E
    const r = nutriScore({ ...base, energyKcal: 480, totalSugars_g: 35, satFat_g: 9, sodium_mg: 300, fiber_g: 3, protein_g: 6 }, 'food');
    expect(r.scored && r.components.proteinCounted).toBe(false);
    expect(r.scored && [r.points, r.grade]).toEqual([20, 'E']);
  });
  it('cheese: protein always counted', () => {
    // 400 kcal (1674 kJ -> 4), sugars 0.5 (0), sat fat 20 (10), sodium 650 (7) => N = 21; protein 25 (5) counted
    const r = nutriScore({ ...base, energyKcal: 400, totalSugars_g: 0.5, satFat_g: 20, sodium_mg: 650, fiber_g: 0, protein_g: 25 }, 'cheese');
    expect(r.scored && [r.points, r.grade, r.components.proteinCounted]).toEqual([16, 'D', true]);
  });
  it('beverage: cola-like 42 kcal / 10.6 g sugars per 100 mL -> E', () => {
    // 175.7 kJ -> 6 (>150); sugars 10.6 -> 8 (>10.5); sodium 4 -> 0 => 14 -> E
    const r = nutriScore({ ...base, energyKcal: 42, totalSugars_g: 10.6, sodium_mg: 4 }, 'beverage');
    expect(r.scored && [r.components.energy, r.components.sugars, r.points, r.grade]).toEqual([6, 8, 14, 'E']);
  });
  it('generic produce (FVL 100%): banana-like 89 kcal, sugars 12.2, fiber 2.6, protein 1.1 -> A', () => {
    // energy 372 kJ -> 1; sugars 12.2 -> 2 => N 3; FVL 5, fiber 2 (>1.9), protein 0 => P 7 -> -4, A
    const r = nutriScore({ ...base, energyKcal: 89, totalSugars_g: 12.2, satFat_g: 0.1, sodium_mg: 1, fiber_g: 2.6, protein_g: 1.1, fvlPercent: 100 }, 'food');
    expect(r.scored && [r.points, r.grade]).toEqual([-4, 'A']);
  });
  it('threshold edges: equal to a threshold does not score the point', () => {
    const at = nutriScore({ ...base, energyKcal: 335 / 4.184, sodium_mg: 90, totalSugars_g: 4.5, satFat_g: 1 }, 'food');
    expect(at.scored && at.components).toMatchObject({ energy: 0, sodium: 0, sugars: 0, satFat: 0 });
  });
  it('any required input null -> not scored (never guessed)', () => {
    const r = nutriScore({ ...base, satFat_g: null, fiber_g: null }, 'food');
    expect(r).toEqual({ scored: false, reason: 'label data missing: saturated fat, fiber', missing: ['saturated fat', 'fiber'] });
  });
  it('grades and water', () => {
    expect([-1, 0, 2, 3, 10, 11, 18, 19].map((p) => gradeFor(p, 'food'))).toEqual(['A', 'B', 'B', 'C', 'C', 'D', 'D', 'E']);
    expect([1, 2, 5, 6, 9, 10].map((p) => gradeFor(p, 'beverage'))).toEqual(['B', 'C', 'C', 'D', 'D', 'E']);
    const w = nutriScore({ ...base, energyKcal: null }, 'water');
    expect(w.scored && [w.grade, w.score100]).toEqual(['A', 100]);
  });
});

describe('0-100 mapping', () => {
  it('best -15 -> 100, worst 40 -> 0, linear, clamped', () => {
    expect(pointsTo100(-15)).toBe(100);
    expect(pointsTo100(40)).toBe(0);
    expect(pointsTo100(12.5)).toBe(50);
    expect(pointsTo100(-20)).toBe(100);
    expect(pointsTo100(55)).toBe(0);
  });
});

describe('category and reasons', () => {
  it('milk is food; soda/juice/plant milk are beverages; cheese is cheese', () => {
    expect(nutriCategory({ description: 'Kroger 2% Milk Gallon', swapGroup: 'milk', basis: 'ml', categories: ['Dairy'] })).toBe('food');
    expect(nutriCategory({ description: 'Coca-Cola Soda Cans', swapGroup: 'soda', basis: 'ml' })).toBe('beverage');
    expect(nutriCategory({ description: 'Kraft Singles American Cheese Slices', swapGroup: 'cheese' })).toBe('cheese');
    expect(nutriCategory({ description: 'Bubly Sparkling Water Lime', swapGroup: 'soda', energyKcal: 0, totalSugars_g: 0 })).toBe('water');
  });
  it('reasons name the biggest component', () => {
    const bad = nutriScore({ ...base, energyKcal: 480, totalSugars_g: 35, satFat_g: 9, sodium_mg: 300, fiber_g: 3, protein_g: 6 }, 'food');
    expect(bad.scored && scoreReason(bad, 'hurts')).toBe('high saturated fat');
    const good = nutriScore({ ...base, energyKcal: 150, totalSugars_g: 2, satFat_g: 0.2, sodium_mg: 300, fiber_g: 12, protein_g: 8 }, 'food');
    expect(good.scored && scoreReason(good, 'helps')).toBe('high fiber');
  });
});
