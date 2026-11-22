/**
 * Guesses for receipt lines that did not match a barcode. Pure.
 *  - produceGuess: fresh produce (PLU code or a produce word in the name) ->
 *    a USDA generic-food search term. The shopper must confirm; never automatic.
 *  - nonFoodGuess: obvious non-food keywords -> pre-marked "Not food?" (undoable).
 */
const PLU: Record<string, string> = {
  '4011': 'bananas', '94011': 'bananas', '4072': 'potatoes russet', '4073': 'potatoes red', '4959': 'mangos', '4051': 'mangos',
  '3283': 'apples', '4131': 'apples', '4016': 'apples', '4017': 'apples', '4020': 'apples', '4133': 'apples',
  '4022': 'grapes', '4023': 'grapes', '4046': 'avocados', '4225': 'avocados', '4048': 'limes', '4053': 'lemons',
  '4062': 'cucumber', '4064': 'tomatoes', '4087': 'tomatoes', '4664': 'tomatoes', '4065': 'peppers sweet green', '4088': 'peppers sweet red',
  '4082': 'onions', '4093': 'onions', '4166': 'onions', '4060': 'broccoli', '4061': 'lettuce iceberg', '4069': 'cabbage',
  '4078': 'corn sweet yellow', '4562': 'carrots', '4030': 'kiwifruit', '4012': 'oranges', '4013': 'oranges', '4409': 'pears', '4044': 'peaches',
  '4040': 'plums', '4608': 'garlic', '4070': 'celery', '4090': 'spinach',
};

const WORDS: Array<[RegExp, string]> = [
  [/\bBANANA/i, 'bananas'], [/\bAPPLE|HCRISP|FUJI|GALA\b/i, 'apples'], [/\bONION/i, 'onions'], [/\bPOTATO/i, 'potatoes'],
  [/\bTOMATO/i, 'tomatoes'], [/\bORANGE(S)?\b/i, 'oranges'], [/\bLEMON/i, 'lemons'], [/\bLIME(S)?\b/i, 'limes'], [/\bAVOCADO/i, 'avocados'],
  [/\bGRAPE(S)?\b/i, 'grapes'], [/\bCUCUMBER/i, 'cucumber'], [/\bCARROT/i, 'carrots'], [/\bBROCCOLI/i, 'broccoli'], [/\bLETTUCE/i, 'lettuce'],
  [/\bMANGO/i, 'mangos'], [/\bPEAR(S)?\b/i, 'pears'], [/\bCELERY\b/i, 'celery'], [/\bCABBAGE/i, 'cabbage'], [/\bSPINACH/i, 'spinach'],
  [/\bKIWI/i, 'kiwifruit'], [/\bPEACH/i, 'peaches'], [/\bPLUM(S)?\b/i, 'plums'], [/\bGARLIC/i, 'garlic'], [/\bSTRAWBERR/i, 'strawberries'],
  [/\bBLUEBERR/i, 'blueberries'], [/\bBLACKBERR/i, 'blackberries'], [/\bRASPBERR/i, 'raspberries'], [/\bPEPPERS?\b/i, 'peppers sweet'],
];

/** Fresh-produce guess for an unmatched line, or null. */
export function produceGuess(name: string, code: string | null | undefined): { term: string; label: string } | null {
  const plu = String(code ?? '').replace(/\D/g, '').replace(/^0+/, '');
  let term: string | null = plu && PLU[plu] ? PLU[plu]! : null;
  if (!term) {
    // processed foods with a produce word are not fresh produce
    if (/\b(CHIP|JUICE|SAUCE|PIE|JAM|JELLY|SOUP|BREAD|CAKE|CEREAL|SNAC|BAR|SALAD DRESS|FROZEN|DRIED|CANNED|PASTE)/i.test(name)) return null;
    term = WORDS.find(([re]) => re.test(name))?.[1] ?? null;
  }
  if (!term) return null;
  return { term: `${term} raw`, label: term.charAt(0).toUpperCase() + term.slice(1) };
}

export const NON_FOOD_WORDS = [
  'detergent', 'paper towel', 'towel', 'tissue', 'toilet', 'shampoo', 'conditioner', 'soap', 'foil', 'trash bag', 'garbage bag', 'battery', 'batteries',
  'bleach', 'cleaner', 'wipes', 'diaper', 'toothpaste', 'toothbrush', 'deodorant', 'razor', 'lotion', 'sponge', 'napkin', 'plastic wrap', 'ziploc',
  'light bulb', 'candle', 'hair color', 'wax', 'bath bomb', 'old spice', 'charger', 'cable', 'pet food', 'cat litter', 'litter', 'knee', 'brace', 'vitamin',
  // toys and pet food (Kroger general merchandise)
  'toy', 'mega bloks', 'bloks', 'lego', 'crayola', 'hot wheels', 'barbie', 'play doh', 'puzzle', 'cat food', 'dog food', 'meow mix', 'friskies', 'purina', 'fancy feast', 'pedigree', 'kibbles',
  'greeting card', 'gift card', 'magazine', 'balloon', 'motor oil', 'propane',
];

export function nonFoodGuess(name: string): boolean {
  const n = ` ${name.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ')} `;
  // whole words only (optional plural): "wax" must not match "waxed", "bag" must not flag "tea bags"
  return NON_FOOD_WORDS.some((w) => n.includes(` ${w} `) || n.includes(` ${w}s `));
}
