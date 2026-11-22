import { describe, expect, it } from 'vitest';
import { nonFoodGuess, produceGuess } from './produce.ts';

describe('produceGuess', () => {
  it('PLU codes and produce words', () => {
    expect(produceGuess('BANANAS', '000000004011')).toEqual({ term: 'bananas raw', label: 'Bananas' });
    expect(produceGuess('HCRISP APPL', '000000003283')).toEqual({ term: 'apples raw', label: 'Apples' });
    expect(produceGuess('YELLOW ONIONS', null)).toEqual({ term: 'onions raw', label: 'Onions' });
  });
  it('processed foods with produce words are not fresh produce', () => {
    expect(produceGuess('APPLE JUICE', '012345600011')).toBeNull();
    expect(produceGuess('BANANA CHIPS', null)).toBeNull();
    expect(produceGuess('SAMPLE CRACKERS', null)).toBeNull();
  });
});

describe('nonFoodGuess', () => {
  it('obvious non-food keywords', () => {
    for (const n of ['TIDE DETERGENT', 'BOUNTY PAPER TOWEL', 'DOVE SOAP', 'ALUM FOIL', 'GLAD TRASH BAG', 'AA BATTERY', 'HAIR COLOR', 'ZIPLOC BAGS']) expect(nonFoodGuess(n)).toBe(true);
  });
  it('food stays food', () => {
    for (const n of ['GV TEA BAGS', 'SHARP CHED', 'BANANAS', 'WAXED BEANS']) expect(nonFoodGuess(n)).toBe(false);
  });
});
