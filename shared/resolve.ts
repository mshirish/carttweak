/**
 * Resolve what a shopper typed ("Jif Creamy Peanut Butter 16 oz") to one
 * retailer product, or explain why not. Pure; the caller supplies the
 * retailer's search results in the retailer's order.
 *
 * Rules (never guess):
 *  1. A product COVERS the query when every query word appears in its
 *     brand + description (after normalization), and, if the query names a
 *     size, the product size matches it within 2% on the same unit.
 *  2. Produce: if the first covering result is a PLU item (no real barcode),
 *     the item is out of scope -> no_barcode.
 *  3. Fewer than 2 query words ("yogurt", "eggs") -> too_vague, with candidates.
 *  4. No covering product -> not_found, with the search results as candidates.
 *  5. Exactly one covering product -> resolved (only_match).
 *  6. Several: the one with the fewest extra words wins ONLY if strictly fewer
 *     than every other (closest_name) AND no other match has the same
 *     description at a different size. Otherwise ambiguous, with candidates.
 *     (Same name in several sizes = ambiguous; the size is never assumed. Seen
 *     live: "RITZ Original Crackers" in 3 sizes under brands "Nabisco" and "Ritz".)
 */
import { parsePackageSize } from './units.ts';
import { sizeFromParsed, type Product, type Size } from './model.ts';

export type ResolutionStatus = 'resolved' | 'ambiguous' | 'not_found' | 'no_barcode' | 'too_vague';

export interface Resolution<T> {
  status: ResolutionStatus;
  method?: 'only_match' | 'closest_name';
  chosen?: T;
  candidates: T[];
  detail: string;
  querySize: Size | null;
}

const STOP = new Set(['the', 'and', 'with', 'of', 'a', 'an', 'n', 'for', 'in']);
const SIZE_RE = /(\d+(?:\.\d+)?|\d+\/\d+)\s*(fl\.?\s*oz|oz|lbs?|gal(?:lon)?|ct|pk|pack|count|g|ml|l|qt)\b\.?/gi;

export function normalizeTokens(text: string): string[] {
  const t = text
    .toLowerCase()
    .replace(/[®™©]/g, '')
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/%/g, ' ')
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ');
  return t
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w) && !(w.length === 1 && /[a-z]/.test(w)))
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

/** Remove size expressions; return the size they describe (if parseable) and the rest. */
export function splitSize(text: string): { rest: string; size: Size | null } {
  const found: string[] = [];
  const rest = text.replace(SIZE_RE, (m) => {
    found.push(m.trim().replace(/\.$/, ''));
    return ' ';
  });
  let size: Size | null = null;
  if (found.length >= 2 && /\b(ct|pk|pack|count)$/i.test(found[0]!)) {
    size = sizeFromParsed(parsePackageSize(`${found[0]} / ${found[1]}`));
  } else if (found.length >= 1) {
    size = sizeFromParsed(parsePackageSize(found[0]!));
  }
  return { rest, size };
}

/** Produce PLU codes are 4-5 digits; with leading zeros stripped, a real UPC is longer. */
export function isPlu(upc: string | null | undefined): boolean {
  const s = String(upc ?? '').replace(/\D/g, '').replace(/^0+/, '');
  return s.length > 0 && s.length <= 5;
}

function sizeMatches(want: Size | null, have: Size | null): boolean {
  if (!want) return true;
  if (!have || have.unit !== want.unit) return false;
  return Math.abs(have.quantity - want.quantity) / want.quantity <= 0.02;
}

export function resolveQuery<T>(
  query: string,
  results: T[],
  view: (r: T) => { product: Pick<Product, 'brand' | 'description' | 'size'>; upc: string | null },
  maxCandidates = 8,
): Resolution<T> {
  const { rest, size: querySize } = splitSize(query);
  const qTokens = [...new Set(normalizeTokens(rest))];
  const scored = results.map((r) => {
    const v = view(r);
    const text = splitSize(`${v.product.brand ?? ''} ${v.product.description}`).rest;
    const pTokens = new Set(normalizeTokens(text));
    const covers = qTokens.every((t) => pTokens.has(t)) && sizeMatches(querySize, v.product.size);
    const extras = [...pTokens].filter((t) => !qTokens.includes(t)).length;
    const descKey = [...new Set(normalizeTokens(splitSize(v.product.description).rest))].sort().join(' ');
    return { r, v, covers, extras, descKey };
  });
  const covering = scored.filter((s) => s.covers);
  const top = (list: typeof scored) => list.slice(0, maxCandidates).map((s) => s.r);

  const firstCover = covering[0];
  if (firstCover && isPlu(firstCover.v.upc)) {
    return { status: 'no_barcode', candidates: [], detail: 'loose produce (PLU code, no barcode); out of scope for barcode swaps', querySize };
  }
  if (qTokens.length < 2) {
    return {
      status: 'too_vague',
      candidates: top(covering.length ? covering : scored),
      detail: `"${query}" is too general; pick one of the options`,
      querySize,
    };
  }
  if (!covering.length) {
    return {
      status: 'not_found',
      candidates: top(scored),
      detail: results.length
        ? `no result contains every word of "${query}"${querySize ? ` at size ${querySize.label}` : ''}`
        : `no results for "${query}" at this store`,
      querySize,
    };
  }
  if (covering.length === 1) {
    return { status: 'resolved', method: 'only_match', chosen: covering[0]!.r, candidates: [], detail: 'only matching product', querySize };
  }
  const sorted = [...covering].sort((a, b) => a.extras - b.extras);
  const sameNameOtherSize = sorted
    .slice(1)
    .some((x) => x.descKey === sorted[0]!.descKey && x.v.product.size?.label !== sorted[0]!.v.product.size?.label);
  if (sorted[0]!.extras < sorted[1]!.extras && !sameNameOtherSize) {
    return {
      status: 'resolved',
      method: 'closest_name',
      chosen: sorted[0]!.r,
      candidates: top(sorted.slice(1)),
      detail: `closest name match among ${covering.length} matching products`,
      querySize,
    };
  }
  const tied = sorted.filter((s) => s.extras === sorted[0]!.extras).length;
  return {
    status: 'ambiguous',
    candidates: top(sorted),
    detail: sameNameOtherSize && tied === 1
      ? `"${sorted[0]!.v.product.description}" comes in several sizes; which one did you mean?`
      : `${tied} products match equally well (often the same product in different sizes); which one did you mean?`,
    querySize,
  };
}
