import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDemoList, parseShoppingList } from './demoList.ts';

describe('parseDemoList', () => {
  it('parses docs/demo-list.txt: 20 items, tags, header locationId', () => {
    const d = parseDemoList(readFileSync(path.join(__dirname, '..', 'docs', 'demo-list.txt'), 'utf8'));
    expect(d.items).toHaveLength(20);
    expect(d.headerLocationId).toBe('01400513');
    expect(d.items.filter((i) => i.tags.includes('lock'))).toHaveLength(1);
    expect(d.items.filter((i) => i.tags.includes('vague')).map((i) => i.query)).toEqual(['yogurt', 'eggs']);
    expect(d.items.find((i) => i.tags.includes('nobar'))!.quantity).toBe(6);
  });
});

describe('parseShoppingList', () => {
  it('optional quantity prefix', () => {
    expect(parseShoppingList('2 bananas\n3x yogurt\n4 x eggs\nmilk')).toEqual([
      { quantity: 2, query: 'bananas' },
      { quantity: 3, query: 'yogurt' },
      { quantity: 4, query: 'eggs' },
      { quantity: 1, query: 'milk' },
    ]);
  });
  it('a leading size is not a quantity; bullets and blank lines ignored', () => {
    expect(parseShoppingList('16 oz peanut butter\n\n- 2% milk\n• 12 ct eggs')).toEqual([
      { quantity: 1, query: '16 oz peanut butter' },
      { quantity: 1, query: '2% milk' },
      { quantity: 1, query: '12 ct eggs' },
    ]);
  });
});
