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

/** Regular shelf price only; null if missing/0. */
export function regularPrice(p: ShelfPrice | null | undefined): EffectivePrice | null {
  if (!p || !positive(p.regular)) return null;
  return { cents: toCents(p.regular), dollars: toCents(p.regular) / 100, type: 'regular' };
}

/** True when a promo price (> 0) is present. */
export function hasPromo(p: ShelfPrice | null | undefined): boolean {
  return !!p && positive(p.promo);
}

/**
 * 'regular': both products at regular price (the headline number).
 * 'with_promo': each product at its promo price when it has one, else regular.
 *   Always shown as a separate, labelled line ("with current promo").
 */
export type PriceMode = 'regular' | 'with_promo';

export const PRICE_MODE_LABEL: Record<PriceMode, string> = {
  regular: 'regular price',
  with_promo: 'with current promo (may require Kroger card)',
};

export function priceFor(p: ShelfPrice | null | undefined, mode: PriceMode): EffectivePrice | null {
  return mode === 'regular' ? regularPrice(p) : effectivePrice(p);
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
  priceMode: PriceMode;
  label: string;
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
 * replacement (ceil) to reach it, at the current branch price. By default
 * both sides use REGULAR price, so the headline number never mixes price types.
 * Returns null if sizes are missing, bases differ, or a price is missing.
 */
export function checkoutDifference(args: {
  originalSize: Quantity | null;
  originalPrice: ShelfPrice | null;
  replacementSize: Quantity | null;
  replacementPrice: ShelfPrice | null;
  /** default 'regular' */
  priceMode?: PriceMode;
}): CheckoutComparison | null {
  const priceMode = args.priceMode ?? 'regular';
  const { originalSize, replacementSize } = args;
  if (!originalSize || !replacementSize) return null;
  if (originalSize.basis !== replacementSize.basis) return null;
  if (!(originalSize.amount > 0) || !(replacementSize.amount > 0)) return null;
  const orig = priceFor(args.originalPrice, priceMode);
  const repl = priceFor(args.replacementPrice, priceMode);
  if (!orig || !repl) return null;
  // tolerance so e.g. 32 oz vs 2 x 16 oz (float conversions) isn't rounded to 3
  const ratio = originalSize.amount / replacementSize.amount;
  const packagesNeeded = Math.max(1, Math.ceil(ratio - 1e-9));
  const replacementTotalCents = packagesNeeded * repl.cents;
  const differenceCents = replacementTotalCents - orig.cents;
  return {
    priceMode,
    label: PRICE_MODE_LABEL[priceMode],
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
