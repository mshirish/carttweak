import { describe, expect, it } from 'vitest';
import { isPlu, normalizeTokens, resolveQuery, splitSize } from '@carttweak/shared';
import { normalizeKrogerProduct } from '../src/normalize.ts';
import { fixture, RECORDED } from './fixtures.ts';

const BRANCH = { chain: 'kroger' as const, locationId: '01400513', name: 'Kroger On the Rhine', address: '100 E Court St, Cincinnati, OH 45202' };
const demo = fixture('kroger-search-demo-list.json');

function resolveDemo(query: string) {
  const results = demo.queries[query].map((raw: any) =>
    normalizeKrogerProduct(raw, BRANCH, { observedAt: '2026-11-22T05:40:00.000Z', sourceRef: 'fixture', stale: false }),
  );
  return resolveQuery(query, results, (x: any) => ({ product: x.product, upc: x.upc }));
}

describe(`resolveQuery on Kroger search results (${RECORDED})`, () => {
  it('[exact] Wonder Classic White Bread 20 oz -> resolved, only match', () => {
    const r = resolveDemo('Wonder Classic White Bread 20 oz');
    expect(r.status).toBe('resolved');
    expect(r.chosen!.product.chainProductId).toBe('0007225001137');
  });
  it('[exact] Jif Creamy Peanut Butter 16 oz -> closest name (not "Natural" / "Reduced Fat")', () => {
    const r = resolveDemo('Jif Creamy Peanut Butter 16 oz');
    expect(r).toMatchObject({ status: 'resolved', method: 'closest_name' });
    expect(r.chosen!.product.description).toBe('Jif Creamy Peanut Butter');
  });
  it('[exact] Coca-Cola 12 pk 12 fl oz cans -> size parsed as 12 x 12 fl oz, resolves to the plain Coke', () => {
    const r = resolveDemo('Coca-Cola 12 pk 12 fl oz cans');
    expect(r.querySize).toMatchObject({ unit: 'ml', basis: 'inferred_per_unit' });
    expect(r.chosen!.product.description).toBe('Coca-Cola® Soda Cans');
  });
  it('same product in several sizes is ambiguous, never size-guessed (RITZ: brands "Nabisco" and "Ritz")', () => {
    const r = resolveDemo('Ritz Original Crackers');
    expect(r.status).toBe('ambiguous');
    expect(r.candidates.length).toBeGreaterThan(1);
  });
  it('[vague] single-word queries are too_vague', () => {
    expect(resolveDemo('yogurt').status).toBe('too_vague');
    expect(resolveDemo('eggs').status).toBe('too_vague');
  });
  it('[nobar] bananas -> no_barcode (PLU)', () => {
    expect(resolveDemo('bananas').status).toBe('no_barcode');
    expect(isPlu('0000000004011')).toBe(true);
    expect(isPlu('0007225001137')).toBe(false);
  });
  it('words Kroger does not use -> not_found with options (Simple Truth "Organic" almondmilk)', () => {
    const r = resolveDemo('Simple Truth Organic Unsweetened Almondmilk');
    expect(r.status).toBe('not_found');
    expect(r.candidates.length).toBeGreaterThan(0);
  });
  it('zero results -> not_found', () => {
    expect(resolveDemo('Prego Traditional Italian Sauce').status).toBe('not_found');
  });
  it('gallon size in the query must match', () => {
    const r = resolveDemo('Kroger 2% Reduced Fat Milk 1 gal');
    expect(r.status).toBe('resolved');
    expect(r.chosen!.product.size!.label).toBe('1 gal');
  });
});

describe('tokens and sizes', () => {
  it('normalizes brand punctuation and plurals', () => {
    expect(normalizeTokens("Kellogg's® Frosted Flakes")).toEqual(['kellogg', 'frosted', 'flake']);
    expect(normalizeTokens("Oats 'n Honey Bars")).toEqual(['oat', 'honey', 'bar']);
  });
  it('splitSize', () => {
    expect(splitSize('Barilla Spaghetti 16 oz').size!.label).toBe('16 oz');
    expect(splitSize('Coca-Cola 12 pk 12 fl oz cans').size!.label).toBe('12 pk / 12 fl oz');
    expect(splitSize('Honey Nut Cheerios').size).toBeNull();
  });
});
