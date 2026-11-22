import { describe, expect, it } from 'vitest';
import { checkoutDifference, effectivePrice, hasPromo, priceFor, regularPrice } from './cost.ts';
import { parsePackageSize } from './units.ts';

describe('effectivePrice', () => {
  it('uses promo only when present (>0)', () => {
    expect(effectivePrice({ regular: 4.99, promo: 3.99 })).toEqual({ cents: 399, dollars: 3.99, type: 'promo' });
    expect(effectivePrice({ regular: 4.99, promo: 0 })).toEqual({ cents: 499, dollars: 4.99, type: 'regular' });
    expect(effectivePrice({ regular: 4.99, promo: null })?.type).toBe('regular');
  });
  it('no price -> null', () => {
    expect(effectivePrice({ regular: 0, promo: 0 })).toBeNull();
    expect(effectivePrice({ regular: undefined, promo: undefined })).toBeNull();
    expect(effectivePrice(null)).toBeNull();
  });
});

describe('checkoutDifference', () => {
  it('same size: one package, simple difference', () => {
    const r = checkoutDifference({
      originalSize: parsePackageSize('32 oz'),
      originalPrice: { regular: 3.49, promo: 0 },
      replacementSize: parsePackageSize('32 oz'),
      replacementPrice: { regular: 5.29, promo: 0 },
    })!;
    expect(r.packagesNeeded).toBe(1);
    expect(r.differenceCents).toBe(180);
    expect(r.differenceDollars).toBe(1.8);
  });
  it('smaller replacement: ceil whole packages', () => {
    const r = checkoutDifference({
      originalSize: parsePackageSize('32 oz'),
      originalPrice: { regular: 3.49, promo: 0 },
      replacementSize: parsePackageSize('24 oz'),
      replacementPrice: { regular: 2.0, promo: 0 },
    })!;
    expect(r.packagesNeeded).toBe(2);
    expect(r.replacementTotalCents).toBe(400);
    expect(r.differenceCents).toBe(51);
  });
  it('exact multiple does not over-round despite float conversion', () => {
    const r = checkoutDifference({
      originalSize: parsePackageSize('2 lb'),
      originalPrice: { regular: 5, promo: 0 },
      replacementSize: parsePackageSize('16 oz'),
      replacementPrice: { regular: 2.5, promo: 0 },
    })!;
    expect(r.packagesNeeded).toBe(2);
    expect(r.differenceCents).toBe(0);
  });
  it('larger replacement: still one package; promo line is separate and labelled', () => {
    const args = {
      originalSize: parsePackageSize('20 oz'),
      originalPrice: { regular: 2.99, promo: 0 },
      replacementSize: parsePackageSize('24 oz'),
      replacementPrice: { regular: 4.49, promo: 3.99 },
    };
    const r = checkoutDifference({ ...args, priceMode: 'with_promo' })!;
    expect(r.packagesNeeded).toBe(1);
    expect(r.priceMode).toBe('with_promo');
    expect(r.label).toBe('with current promo (may require Kroger card)');
    expect(r.replacementUnitPrice.type).toBe('promo');
    expect(r.originalCost.type).toBe('regular'); // no promo on original
    expect(r.differenceCents).toBe(100);
    const reg = checkoutDifference(args)!;
    expect(reg.replacementUnitPrice.type).toBe('regular');
    expect(reg.differenceCents).toBe(150);
  });
  it('null when size unknown, basis differs, or price missing', () => {
    const base = {
      originalSize: parsePackageSize('32 oz'),
      originalPrice: { regular: 3.49, promo: 0 },
      replacementSize: parsePackageSize('32 oz'),
      replacementPrice: { regular: 5.29, promo: 0 },
    };
    expect(checkoutDifference({ ...base, replacementSize: parsePackageSize('1 lb 4 oz') })).toBeNull();
    expect(checkoutDifference({ ...base, replacementSize: parsePackageSize('32 fl oz') })).toBeNull();
    expect(checkoutDifference({ ...base, replacementPrice: { regular: 0, promo: 0 } })).toBeNull();
  });
});

describe('price types', () => {
  it('regularPrice ignores promo', () => {
    expect(regularPrice({ regular: 4.99, promo: 3.99 })).toEqual({ cents: 499, dollars: 4.99, type: 'regular' });
    expect(regularPrice({ regular: 0, promo: 3.99 })).toBeNull();
  });
  it('hasPromo only when > 0', () => {
    expect(hasPromo({ regular: 4.99, promo: 3.99 })).toBe(true);
    expect(hasPromo({ regular: 4.99, promo: 0 })).toBe(false);
    expect(hasPromo(null)).toBe(false);
  });
  it('priceFor by mode', () => {
    const p = { regular: 4.99, promo: 3.99 };
    expect(priceFor(p, 'regular')!.type).toBe('regular');
    expect(priceFor(p, 'with_promo')!.type).toBe('promo');
  });
  it('default checkout uses REGULAR on both sides even when promos exist', () => {
    const base = {
      originalSize: parsePackageSize('32 oz'),
      originalPrice: { regular: 5.0, promo: 4.0 },
      replacementSize: parsePackageSize('32 oz'),
      replacementPrice: { regular: 6.0, promo: 3.5 },
    };
    const r = checkoutDifference(base)!;
    expect(r.priceMode).toBe('regular');
    expect(r.label).toBe('regular price');
    expect(r.originalCost.type).toBe('regular');
    expect(r.replacementUnitPrice.type).toBe('regular');
    expect(r.differenceCents).toBe(100);
    const promo = checkoutDifference({ ...base, priceMode: 'with_promo' })!;
    expect(promo.originalCost.type).toBe('promo');
    expect(promo.differenceCents).toBe(-50);
  });
  it('regular mode: null when regular is missing even if promo exists', () => {
    const r = checkoutDifference({
      originalSize: parsePackageSize('32 oz'),
      originalPrice: { regular: 0, promo: 4.0 },
      replacementSize: parsePackageSize('32 oz'),
      replacementPrice: { regular: 6.0, promo: 0 },
    });
    expect(r).toBeNull();
  });
  it('multipack inferred size works in checkout math', () => {
    const r = checkoutDifference({
      originalSize: parsePackageSize('32 oz'),
      originalPrice: { regular: 4.0, promo: 0 },
      replacementSize: parsePackageSize('4 ct / 5.3 oz'), // 21.2 oz
      replacementPrice: { regular: 3.0, promo: 0 },
    })!;
    expect(r.packagesNeeded).toBe(2);
    expect(r.differenceCents).toBe(200);
  });
});
