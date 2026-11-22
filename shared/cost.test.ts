import { describe, expect, it } from 'vitest';
import { checkoutDifference, effectivePrice } from './cost.ts';
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
  it('larger replacement: still one package; promo labelled', () => {
    const r = checkoutDifference({
      originalSize: parsePackageSize('20 oz'),
      originalPrice: { regular: 2.99, promo: 0 },
      replacementSize: parsePackageSize('24 oz'),
      replacementPrice: { regular: 4.49, promo: 3.99 },
    })!;
    expect(r.packagesNeeded).toBe(1);
    expect(r.replacementUnitPrice.type).toBe('promo');
    expect(r.differenceCents).toBe(100);
  });
  it('null when size unknown, basis differs, or price missing', () => {
    const base = {
      originalSize: parsePackageSize('32 oz'),
      originalPrice: { regular: 3.49, promo: 0 },
      replacementSize: parsePackageSize('32 oz'),
      replacementPrice: { regular: 5.29, promo: 0 },
    };
    expect(checkoutDifference({ ...base, replacementSize: parsePackageSize('6 ct / 5.3 oz') })).toBeNull();
    expect(checkoutDifference({ ...base, replacementSize: parsePackageSize('32 fl oz') })).toBeNull();
    expect(checkoutDifference({ ...base, replacementPrice: { regular: 0, promo: 0 } })).toBeNull();
  });
});
