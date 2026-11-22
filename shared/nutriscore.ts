/**
 * Nutri-Score, ORIGINAL algorithm (2017; Santé publique France, based on the
 * UK FSA/Ofcom nutrient profiling model, "Nutri-Score: règlement d'usage"
 * 2017 and FSA "Nutrient Profiling Technical Guidance" 2011). The 2023 update
 * is NOT implemented (its tables were not verified in time); see DECISIONS.md.
 *
 * Per 100 g (foods) or 100 mL (beverages):
 *   negative N = energy(kJ) + total sugars + saturated fat + sodium   (0-10 each)
 *   positive P = fruit/veg/legume % + fibre + protein                  (0-5 each; FVL 0-10 for beverages)
 *   score = N - P, except: if N >= 11 and FVL points < 5 (and not cheese), protein is not counted.
 * Grades: foods A <= -1, B 0..2, C 3..10, D 11..18, E >= 19
 *         beverages A = water, B <= 1, C 2..5, D 6..9, E >= 10
 * Fats/oils category is not handled (needs total fat, not stored): such products are scored as general foods.
 * Pure, table-driven.
 */
export type NutriCategory = 'food' | 'beverage' | 'cheese' | 'water';
export type Grade = 'A' | 'B' | 'C' | 'D' | 'E';

export interface NutriInput {
  energyKcal: number | null;
  totalSugars_g: number | null;
  satFat_g: number | null;
  sodium_mg: number | null;
  fiber_g: number | null;
  protein_g: number | null;
  /** fruit/vegetable/legume/nut %; US labels don't state it -> 0 (generic produce: 100) */
  fvlPercent: number;
}

export interface NutriResult {
  scored: true;
  category: NutriCategory;
  points: number;
  grade: Grade;
  /** 0-100, best 100 */
  score100: number;
  components: { energy: number; sugars: number; satFat: number; sodium: number; fvl: number; fiber: number; protein: number; proteinCounted: boolean };
  energyKj: number;
}
export interface NotScored {
  scored: false;
  reason: string;
  missing: string[];
}

/** Points = number of thresholds strictly exceeded. */
function pts(value: number, thresholds: number[]): number {
  let p = 0;
  for (const t of thresholds) if (value > t) p++;
  return p;
}

export const TABLES = {
  food: {
    energyKj: [335, 670, 1005, 1340, 1675, 2010, 2345, 2680, 3015, 3350],
    sugars: [4.5, 9, 13.5, 18, 22.5, 27, 31, 36, 40, 45],
    satFat: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    sodium: [90, 180, 270, 360, 450, 540, 630, 720, 810, 900],
    fiber: [0.9, 1.9, 2.8, 3.7, 4.7],
    protein: [1.6, 3.2, 4.8, 6.4, 8.0],
  },
  beverage: {
    energyKj: [0, 30, 60, 90, 120, 150, 180, 210, 240, 270],
    sugars: [0, 1.5, 3, 4.5, 6, 7.5, 9, 10.5, 12, 13.5],
  },
} as const;

function fvlPoints(pct: number, beverage: boolean): number {
  if (beverage) return pct > 80 ? 10 : pct > 60 ? 4 : pct > 40 ? 2 : 0;
  return pct > 80 ? 5 : pct > 60 ? 2 : pct > 40 ? 1 : 0;
}

export function gradeFor(points: number, category: NutriCategory): Grade {
  if (category === 'water') return 'A';
  if (category === 'beverage') return points <= 1 ? 'B' : points <= 5 ? 'C' : points <= 9 ? 'D' : 'E';
  return points <= -1 ? 'A' : points <= 2 ? 'B' : points <= 10 ? 'C' : points <= 18 ? 'D' : 'E';
}

/**
 * 0-100 product score: linear in points over the general-food range.
 * best possible points -15 -> 100, worst 40 -> 0:  score100 = round(100 * (40 - points) / 55), clamped.
 * Water scores 100.
 */
export const POINTS_BEST = -15;
export const POINTS_WORST = 40;
export function pointsTo100(points: number): number {
  return Math.max(0, Math.min(100, Math.round((100 * (POINTS_WORST - points)) / (POINTS_WORST - POINTS_BEST))));
}

export const KCAL_TO_KJ = 4.184;

export function nutriScore(input: NutriInput, category: NutriCategory): NutriResult | NotScored {
  const required: Array<[keyof NutriInput, string]> = [
    ['energyKcal', 'energy'],
    ['totalSugars_g', 'total sugars'],
    ['satFat_g', 'saturated fat'],
    ['sodium_mg', 'sodium'],
    ['fiber_g', 'fiber'],
    ['protein_g', 'protein'],
  ];
  const missing = required.filter(([k]) => input[k] == null).map(([, l]) => l);
  if (missing.length && category !== 'water') return { scored: false, reason: `label data missing: ${missing.join(', ')}`, missing };
  if (category === 'water') {
    return { scored: true, category, points: 0, grade: 'A', score100: 100, components: { energy: 0, sugars: 0, satFat: 0, sodium: 0, fvl: 0, fiber: 0, protein: 0, proteinCounted: false }, energyKj: 0 };
  }
  const bev = category === 'beverage';
  const energyKj = input.energyKcal! * KCAL_TO_KJ;
  const t = TABLES.food;
  const energy = pts(energyKj, [...(bev ? TABLES.beverage.energyKj : t.energyKj)]);
  const sugars = pts(input.totalSugars_g!, [...(bev ? TABLES.beverage.sugars : t.sugars)]);
  const satFat = pts(input.satFat_g!, [...t.satFat]);
  const sodium = pts(input.sodium_mg!, [...t.sodium]);
  const fvl = fvlPoints(input.fvlPercent, bev);
  const fiber = pts(input.fiber_g!, [...t.fiber]);
  const protein = pts(input.protein_g!, [...t.protein]);
  const N = energy + sugars + satFat + sodium;
  const fvlMax = bev ? 10 : 5;
  const proteinCounted = category === 'cheese' || N < 11 || fvl >= fvlMax;
  const points = N - (fvl + fiber + (proteinCounted ? protein : 0));
  return {
    scored: true,
    category,
    points,
    grade: gradeFor(points, category),
    score100: pointsTo100(points),
    components: { energy, sugars, satFat, sodium, fvl, fiber, protein, proteinCounted },
    energyKj,
  };
}

/** One-line reason for a product helping or hurting: its biggest negative or positive component. */
export function scoreReason(r: NutriResult, direction: 'helps' | 'hurts'): string {
  const c = r.components;
  if (direction === 'hurts') {
    const neg: Array<[number, string]> = [
      [c.sugars, 'high sugar'],
      [c.satFat, 'high saturated fat'],
      [c.sodium, 'high sodium'],
      [c.energy, 'high calories'],
    ];
    const top = neg.sort((a, b) => b[0] - a[0])[0]!;
    return top[0] > 0 ? top[1] : 'few positives';
  }
  const pos: Array<[number, string]> = [
    [c.fiber, 'high fiber'],
    [c.proteinCounted ? c.protein : 0, 'good protein'],
    [c.fvl, 'fruit & vegetables'],
  ];
  const top = pos.sort((a, b) => b[0] - a[0])[0]!;
  if (top[0] > 0) return top[1];
  const neg = c.sugars + c.satFat + c.sodium;
  return neg <= 2 ? 'low sugar, fat and sodium' : 'moderate';
}

/** Category for Nutri-Score from what we know about a product. Milk is a general food, not a beverage. */
export function nutriCategory(p: { description: string; swapGroup?: string | null; categories?: string[]; basis?: 'g' | 'ml' | null; energyKcal?: number | null; totalSugars_g?: number | null }): NutriCategory {
  const d = p.description.toLowerCase();
  if (/\bwater\b/.test(d) && !/\b(coconut|flavored|tonic)\b/.test(d) && (p.energyKcal ?? 1) === 0 && (p.totalSugars_g ?? 1) === 0) return 'water';
  if (p.swapGroup === 'cheese' || /\bcheese\b/.test(d) && !/\b(mac|macaroni|cracker|pizza)\b/.test(d)) return 'cheese';
  if (['soda', 'juice', 'plant_milk'].includes(p.swapGroup ?? '')) return 'beverage';
  if (p.basis === 'ml' && (p.categories ?? []).some((c) => /beverage/i.test(c)) && p.swapGroup !== 'milk') return 'beverage';
  return 'food';
}
