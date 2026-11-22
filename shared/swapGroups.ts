/**
 * Curated swap groups: a candidate is "the same kind of food" only if it
 * (1) shares a specific Kroger category with the original, and
 * (2) falls in the same swap group below.
 * Group membership is decided by the product description (Kroger categories
 * are too coarse: "Dairy" holds milk, yogurt, cheese and eggs).
 * Order matters: the first matching group wins (plant milk before milk,
 * pasta sauce before pasta, frozen meals before pasta/cheese).
 */
import type { Product } from './model.ts';

export interface SwapGroup {
  id: string;
  label: string;
  /** Kroger categories seen live (2026-11-22) for this group; informational + used by candidate search */
  krogerCategories: string[];
  include: RegExp;
  exclude?: RegExp;
  /** extra condition on categories, e.g. frozen meals must be in "Frozen" */
  categoryRequired?: RegExp;
  /** curated Kroger search terms used to find replacement candidates */
  searchTerms: string[];
}

export const SWAP_GROUPS: SwapGroup[] = [
  {
    id: 'frozen_meal',
    label: 'frozen meals',
    krogerCategories: ['Frozen'],
    include: /\b(frozen meal|frozen entree|bowl|dinner|meal|entree|mac(aroni)? (and|&) cheese|lasagna|pot pie)\b/i,
    exclude: /\b(dessert|ice cream|pizza(?! mac)|vegetables?|fruit|waffle)\b/i,
    categoryRequired: /^frozen$/i,
    searchTerms: ['frozen meal', 'healthy frozen meal', 'high protein frozen meal'],
  },
  {
    id: 'plant_milk',
    label: 'plant milk',
    krogerCategories: ['Dairy', 'Natural & Organic'],
    include: /\b(almond ?milk|oat ?milk|soy ?milk|cashew ?milk|coconut ?milk|rice ?milk|pea ?milk|plant based milk)\b/i,
    exclude: /\b(creamer|yogurt|cheese|ice cream|canned)\b/i,
    searchTerms: ['unsweetened almond milk', 'oat milk', 'soy milk'],
  },
  {
    id: 'milk',
    label: 'milk',
    krogerCategories: ['Dairy'],
    include: /\bmilk\b/i,
    exclude: /\b(almond|oat|soy|cashew|coconut|rice|plant|chocolate|strawberry|condensed|evaporated|powder|buttermilk|creamer|yogurt|cheese|whole milk yogurt|milkshake|milk chocolate)\b/i,
    searchTerms: ['milk gallon', 'fat free milk', 'ultra filtered milk'],
  },
  {
    id: 'yogurt',
    label: 'yogurt',
    krogerCategories: ['Dairy'],
    include: /\byogh?urt\b/i,
    exclude: /\b(drink|smoothie|bar|bars|frozen|covered|raisins|pretzels|dip)\b/i,
    searchTerms: ['plain greek yogurt', 'nonfat greek yogurt', 'high protein yogurt'],
  },
  {
    id: 'cheese',
    label: 'cheese',
    krogerCategories: ['Dairy', 'Deli'],
    include: /\bcheese\b/i,
    exclude: /\b(mac(aroni)?|cracker|crackers|cheesecake|pizza|cream cheese frosting|puffs|curls|dip|sauce|its|nips|goldfish)\b/i,
    searchTerms: ['reduced fat cheese slices', 'swiss cheese slices', 'part skim mozzarella'],
  },
  {
    id: 'eggs',
    label: 'eggs',
    krogerCategories: ['Dairy', 'Breakfast'],
    include: /\beggs?\b/i,
    exclude: /\b(noodles?|nog|roll|rolls|salad|bites)\b/i,
    searchTerms: ['large eggs', 'egg whites'],
  },
  {
    id: 'bread',
    label: 'bread',
    krogerCategories: ['Bakery'],
    include: /\bbread\b/i,
    exclude: /\b(crumbs?|sticks?|buns?|rolls?|naan|pita|stuffing|bowl|pudding|mix)\b/i,
    searchTerms: ['whole grain bread', '100% whole wheat bread', 'high fiber bread'],
  },
  {
    id: 'cereal',
    label: 'cereal',
    krogerCategories: ['Breakfast'],
    include: /\b(cereal|granola(?! bars?)|flakes|cheerios|bran|muesli|oats cereal)\b/i,
    exclude: /\b(bars?|cups?|oatmeal|milk)\b/i,
    searchTerms: ['high fiber cereal', 'bran flakes cereal', 'shredded wheat cereal'],
  },
  {
    id: 'pasta_sauce',
    label: 'pasta sauce',
    krogerCategories: ['Pasta, Sauces, Grain'],
    // Prego names its jars "Traditional Sauce", "Marinara Sauce" (seen live 2026-11-22): any sauce in the pasta aisle
    include: /\b(sauce|marinara)\b/i,
    exclude: /\b(alfredo|pesto|pizza|soy|bbq|barbecue|hot sauce|teriyaki|worcestershire|enchilada|taco|curry|stir fry|cooking sauces)\b/i,
    categoryRequired: /pasta/i,
    searchTerms: ['marinara sauce', 'no sugar added pasta sauce', 'low sodium pasta sauce'],
  },
  {
    id: 'pasta',
    label: 'pasta',
    krogerCategories: ['Pasta, Sauces, Grain'],
    include: /\b(spaghetti|penne|rotini|linguine|fettuccine|elbows?|macaroni|rigatoni|farfalle|angel hair|pasta)\b/i,
    exclude: /\b(sauce|salad|dinner|meal|frozen|cheese|kit|sides?|ready)\b/i,
    searchTerms: ['whole grain spaghetti', 'protein pasta', 'chickpea pasta'],
  },
  {
    id: 'crackers',
    label: 'crackers',
    krogerCategories: ['Snacks'],
    include: /\bcrackers?\b/i,
    exclude: /\b(sandwich crackers? with|cheese filled|peanut butter filled|graham)\b/i,
    searchTerms: ['whole grain crackers', 'reduced fat crackers', 'low sodium crackers'],
  },
  {
    id: 'chips',
    label: 'chips',
    krogerCategories: ['Snacks'],
    include: /\b(chips|crisps)\b/i,
    exclude: /\b(chocolate|cookie|baking|ritz|crackers?|dip)\b/i,
    searchTerms: ['lightly salted potato chips', 'baked potato chips', 'unsalted potato chips'],
  },
  {
    id: 'bars',
    label: 'granola / snack bars',
    krogerCategories: ['Snacks', 'Breakfast'],
    include: /\b(granola bars?|protein bars?|cereal bars?|snack bars?|nut bars?|chewy bars?|oat bars?|bars)\b/i,
    exclude: /\b(soap|ice cream|candy bars?|chocolate bars?|frozen)\b/i,
    searchTerms: ['high fiber granola bars', 'protein bars', 'low sugar granola bars'],
  },
  {
    id: 'peanut_butter',
    label: 'peanut butter',
    krogerCategories: ['Condiment & Sauces'],
    include: /\b(peanut butter|almond butter|nut butter)\b/i,
    exclude: /\b(cups?|cookies?|crackers?|bars?|filled|pretzels?|candy|chips)\b/i,
    searchTerms: ['natural peanut butter', 'no salt peanut butter', 'no sugar added peanut butter'],
  },
  {
    id: 'soup',
    label: 'soup',
    krogerCategories: ['Canned & Packaged'],
    include: /\bsoup\b/i,
    exclude: /\b(mix|bowls? only|spoon)\b/i,
    searchTerms: ['low sodium soup', 'reduced sodium chicken noodle soup', 'heart healthy soup'],
  },
  {
    id: 'soda',
    label: 'soda / sparkling drinks',
    krogerCategories: ['Beverages'],
    include: /\b(soda|cola|soft drink|sparkling water|seltzer|ginger ale|root beer|lemon lime)\b/i,
    exclude: /\b(baking soda|syrup|mixer)\b/i,
    searchTerms: ['zero sugar soda cans', 'sparkling water cans', 'diet soda cans'],
  },
  {
    id: 'juice',
    label: 'juice',
    krogerCategories: ['Beverages'],
    include: /\bjuice\b/i,
    exclude: /\b(concentrate|mixer|clam|pickle|lemon juice|lime juice)\b/i,
    searchTerms: ['100% orange juice', 'low sugar juice', 'vegetable juice'],
  },
];

/** Categories too generic to prove two products are the same kind of food. */
export const GENERIC_CATEGORIES = new Set(['natural & organic', 'international', 'kitchen', 'grocery', 'food', 'home page', 'walmart']);

export function swapGroupFor(p: Pick<Product, 'description' | 'categories'>): SwapGroup | null {
  for (const g of SWAP_GROUPS) {
    if (!g.include.test(p.description)) continue;
    if (g.exclude?.test(p.description)) continue;
    if (g.categoryRequired && !p.categories.some((c) => g.categoryRequired!.test(c))) continue;
    return g;
  }
  return null;
}

export function specificCategories(p: Pick<Product, 'categories'>): string[] {
  return [...new Set(p.categories.map((c) => c.trim()).filter((c) => c && !GENERIC_CATEGORIES.has(c.toLowerCase())))];
}

/** Same kind of food: shares a specific Kroger category AND the same swap group. */
export function sameKind(
  a: Pick<Product, 'description' | 'categories'>,
  b: Pick<Product, 'description' | 'categories'>,
): { ok: true; group: SwapGroup } | { ok: false; reason: 'no_shared_category' | 'different_swap_group' | 'no_swap_group' } {
  const ga = swapGroupFor(a);
  if (!ga) return { ok: false, reason: 'no_swap_group' };
  const ca = new Set(specificCategories(a).map((c) => c.toLowerCase()));
  if (!specificCategories(b).some((c) => ca.has(c.toLowerCase()))) return { ok: false, reason: 'no_shared_category' };
  const gb = swapGroupFor(b);
  if (!gb || gb.id !== ga.id) return { ok: false, reason: 'different_swap_group' };
  return { ok: true, group: ga };
}

/**
 * Walmart.com search terms per swap group (Walmart's catalogue search is
 * online-wide, so terms name the healthier option and Great Value equivalents).
 */
export const WALMART_SEARCH_TERMS: Record<string, string[]> = {
  frozen_meal: ['high protein frozen meal', 'healthy choice frozen meal', 'lean cuisine'],
  plant_milk: ['unsweetened almond milk', 'unsweetened oat milk', 'unsweetened soy milk'],
  milk: ['fat free milk gallon', 'ultra filtered milk', '1% milk gallon'],
  yogurt: ['plain greek yogurt', 'nonfat greek yogurt', 'great value greek yogurt'],
  cheese: ['reduced fat cheese slices', 'part skim mozzarella', 'swiss cheese slices'],
  eggs: ['large eggs', 'egg whites'],
  bread: ['whole wheat bread', 'whole grain bread', 'high fiber bread'],
  cereal: ['high fiber cereal', 'bran flakes', 'shredded wheat'],
  pasta_sauce: ['no sugar added pasta sauce', 'low sodium marinara', 'marinara sauce'],
  pasta: ['whole wheat spaghetti', 'protein pasta', 'chickpea pasta'],
  crackers: ['whole grain crackers', 'reduced fat crackers', 'low sodium crackers'],
  chips: ['baked potato chips', 'lightly salted potato chips', 'unsalted chips'],
  bars: ['high fiber granola bars', 'protein bars', 'low sugar granola bars'],
  peanut_butter: ['natural peanut butter', 'no salt added peanut butter', 'no sugar added peanut butter'],
  soup: ['low sodium soup', 'reduced sodium soup', 'heart healthy soup'],
  soda: ['zero sugar soda', 'sparkling water', 'diet soda'],
  juice: ['100% orange juice', 'no sugar added juice', 'vegetable juice'],
};

export function searchTermsFor(group: SwapGroup, chain: 'kroger' | 'walmart' | 'target'): string[] {
  return chain === 'walmart' ? WALMART_SEARCH_TERMS[group.id] ?? group.searchTerms : group.searchTerms;
}
