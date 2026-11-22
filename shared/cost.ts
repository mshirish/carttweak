/**
 * Checkout cost math. Pure functions. Money handled in integer cents.
 */
import type { Quantity } from './units.ts';

export type PriceType = 'promo' | 'regular';

export interface ShelfPrice {
  regular: number | null | undefined;
  promo: number | null | undefined;
}

export interface EffectivePrice {
  cents: number;
  dollars: number;
  type: PriceType;
}

export function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

function positive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * Promo price only when present (Kroger reports 0 for "no promo").
 * Returns null if no usable price exists.
 */
export function effectivePrice(p: ShelfPrice | null | undefined): EffectivePrice | null {
  if (!p) return null;
  if (positive(p.promo)) return { cents: toCents(p.promo), dollars: toCents(p.promo) / 100, type: 'promo' };
  if (positive(p.regular)) return { cents: toCents(p.regular), dollars: toCents(p.regular) / 100, type: 'regular' };
  return null;
}

export interface CheckoutComparison {
  targetQuantity: Quantity;
  replacementPackageQuantity: Quantity;
  packagesNeeded: number;
  originalCost: EffectivePrice;
  replacementUnitPrice: EffectivePrice;
  replacementTotalCents: number;
  /** replacement total - original, in cents (positive = costs more) */
  differenceCents: number;
  differenceDollars: number;
}

/**
 * Target quantity = one package of the original. Buy whole packages of the
 * replacement (ceil) to reach it, at the current branch price.
 * Returns null if sizes are missing, bases differ, or a price is missing.
 */
export function checkoutDifference(args: {
  originalSize: Quantity | null;
  originalPrice: ShelfPrice | null;
  replacementSize: Quantity | null;
  replacementPrice: ShelfPrice | null;
}): CheckoutComparison | null {
  const { originalSize, replacementSize } = args;
  if (!originalSize || !replacementSize) return null;
  if (originalSize.basis !== replacementSize.basis) return null;
  if (!(originalSize.amount > 0) || !(replacementSize.amount > 0)) return null;
  const orig = effectivePrice(args.originalPrice);
  const repl = effectivePrice(args.replacementPrice);
  if (!orig || !repl) return null;
  // tolerance so e.g. 32 oz vs 2 x 16 oz (float conversions) isn't rounded to 3
  const ratio = originalSize.amount / replacementSize.amount;
  const packagesNeeded = Math.max(1, Math.ceil(ratio - 1e-9));
  const replacementTotalCents = packagesNeeded * repl.cents;
  const differenceCents = replacementTotalCents - orig.cents;
  return {
    targetQuantity: originalSize,
    replacementPackageQuantity: replacementSize,
    packagesNeeded,
    originalCost: orig,
    replacementUnitPrice: repl,
    replacementTotalCents,
    differenceCents,
    differenceDollars: differenceCents / 100,
  };
}
