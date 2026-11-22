import { describe, expect, it } from 'vitest';
import { applyPackageWeight, krogerGtin14, normalizeFdcFood, normalizeKrogerProduct, storeCheck, toBranch } from '../src/normalize.ts';
import { fixture, RECORDED } from './fixtures.ts';

const BRANCH = { chain: 'kroger' as const, locationId: '01400513', name: 'Kroger On the Rhine', address: '100 E Court St, Cincinnati, OH 45202' };
const meta = { observedAt: '2026-11-22T05:14:24.000Z', sourceRef: 'https://api.kroger.com/v1/products?filter.term=white%20bread', stale: false };

describe(`store filter (${RECORDED}, ZIP 45202)`, () => {
  const locs = fixture('kroger-locations-45202.json').body.data as any[];
  it('keeps the real store, drops all four fulfillment sites', () => {
    const stores = locs.filter((l) => storeCheck(l).isStore);
    expect(stores.map((l) => l.locationId)).toEqual(['01400513']);
    const dropped = locs.filter((l) => !storeCheck(l).isStore);
    expect(dropped).toHaveLength(4);
    for (const d of dropped) expect(storeCheck(d).reasons.length).toBeGreaterThanOrEqual(3);
  });
  it('branch normalization', () => {
    expect(toBranch(locs[0])).toEqual(BRANCH);
  });
  it('a site with a phone but no departments is still dropped', () => {
    expect(storeCheck({ ...locs[1], phone: '5550000000' }).isStore).toBe(false);
  });
});

describe(`Kroger product normalization (${RECORDED})`, () => {
  const raw = fixture('kroger-products-white-bread.json').body.data.find((p: any) => p.upc === '0007225001137');
  const n = normalizeKrogerProduct(raw, BRANCH, meta);
  it('Wonder: gtin14 with check digit appended, size, categories, regular + promo cents', () => {
    expect(n.product).toMatchObject({ ref: 'kroger:0007225001137', gtin14: '00072250011372', brand: 'Wonder', categories: ['Bakery'] });
    expect(n.product.size).toMatchObject({ unit: 'g', basis: 'explicit', label: '20 oz' });
    expect(n.price).toMatchObject({ regularCents: 329, promoCents: 279, source: 'kroger_api', observedAt: meta.observedAt });
  });
  it('a price is never returned without its date', () => {
    expect(n.price!.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  it('no promo -> promoCents null (Kroger reports 0)', () => {
    const aunt = fixture('kroger-products-whole-grain-bread.json').body.data.find((p: any) => p.upc === '0007131400185');
    expect(normalizeKrogerProduct(aunt, BRANCH, meta).price!.promoCents).toBeNull();
  });
  it('PLU produce codes have no gtin14', () => {
    expect(krogerGtin14('0000000004011')).toBeNull();
  });
});

describe(`FDC normalization (${RECORDED})`, () => {
  it('Aunt Millie\'s 2032747: label-scaled per 100 g matches the verified proof', () => {
    const r = normalizeFdcFood(fixture('fdc-food-2032747.json').body, 'kroger:0007131400185');
    expect(r).toMatchObject({ basis: 'g', method: 'label_scaled', labelDate: '2021-10-28', sourceRef: 'fdc:2032747', packageWeight: '20 oz/567 g' });
    expect(r.per100.fiber_g!).toBeCloseTo(12.81, 2);
    expect(r.per100.sodium_mg!).toBeCloseTo(361.7, 1);
    expect(r.per100.addedSugars_g).toBeNull(); // not on label; NOT filled from total sugars
    expect(r.per100.totalSugars_g!).toBeCloseTo(2.13, 2);
  });
  it('Euromonitor 2756001: empty label block -> FDC per-100 values, method recorded', () => {
    const food = fixture('fdc-food-2756001.json').body;
    expect(food.labelNutrients ?? {}).toEqual({});
    const r = normalizeFdcFood(food, 'kroger:0007047000439');
    expect(r.method).toBe('fdc_per100');
    expect(r.basis).toBe('g');
    expect(r.servingSize).toBeNull();
    expect(r.labelDate).toBe('2026-04-23');
  });
  it('multipack 8 ct / 6 oz vs FDC "48 ONZ" -> confirmed, no flag', () => {
    const raw = { productId: '0007047018388', upc: '0007047018388', description: 'Yoplait 8 pack', items: [{ size: '8 ct / 6 oz', price: { regular: 5.79, promo: 0 } }] };
    const n = normalizeKrogerProduct(raw, BRANCH, meta);
    const rec = normalizeFdcFood(fixture('fdc-food-2740284.json').body, n.product.ref);
    expect(rec.packageWeight).toBe('48 ONZ');
    expect(applyPackageWeight(n.product, rec.packageWeight).flags).toEqual([]);
  });
  it('Sunbeam size conflict (22 oz vs "24 oz/680 g")', () => {
    const raw = fixture('kroger-products-white-bread.json').body.data.find((p: any) => p.upc === '0007130104737');
    const p = applyPackageWeight(normalizeKrogerProduct(raw, BRANCH, meta).product, '24 oz/680 g');
    expect(p.flags.map((f) => f.code)).toEqual(['size_conflict']);
    expect(p.size!.label).toBe('22 oz');
  });
});

describe('krogerTerm (Kroger allows at most 8 words per search, recorded live 2026-11-22)', () => {
  it('short terms unchanged; long ones drop sizes and "/", capped at 8 words', async () => {
    const { krogerTerm } = await import('../src/service.ts');
    expect(krogerTerm('Coca-Cola Soda Cans 12 pk')).toBe('Coca-Cola Soda Cans 12 pk');
    expect(krogerTerm('Coca-Cola Soda Cans 12 pk / 12 fl oz')).toBe('Coca-Cola Soda Cans');
    expect(krogerTerm('Simple Truth Plant Based Non Dairy Unsweetened Almondmilk Half Gallon')).toBe('Simple Truth Plant Based Non Dairy Unsweetened Almondmilk');
    for (const t of ['Nature Valley Oats n Honey Crunchy Granola Bars 6 ct / 1.49 oz', 'a b c d e f g h i j k']) {
      expect(krogerTerm(t).split(' ').length).toBeLessThanOrEqual(8);
    }
  });
});
