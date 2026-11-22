// Receipt flow state shared by the receipt screens and App.
import { expandAbbrev, nonFoodGuess, parseReceipt, produceGuess, type OcrLine, type ParsedReceipt } from '@carttweak/shared';

export type MatchMethod = 'barcode' | 'shopper_confirmed' | 'unmatched';

export interface ReceiptHeaderEdit {
  /** store address line as printed */
  store: string;
  zip: string;
  date: string;
}

/** One editable line on "Check what we read". */
export interface ReceiptRow {
  id: string;
  name: string;
  code: string;
  quantity: string;
  price: string;
  confidence: number | null;
  /** flagged by OCR confidence or parser issues */
  needsLook: boolean;
  /** the shopper edited or confirmed it */
  reviewed: boolean;
  issues: string[];
  /** came from a line the parser could not read */
  fromUnparsed: boolean;
  /** weighed at the register ("lb @ /lb") */
  weighted?: boolean;
}

export interface MatchCard {
  source: 'kroger' | 'fdc';
  ref?: string;
  gtin14: string | null;
  upcA: string | null;
  krogerProductId: string | null;
  description: string;
  brand: string | null;
  sizeLabel: string | null;
  fdcId: number | null;
  regularCents: number | null;
  imageUrl: string | null;
}

export interface MatchRow {
  id: string;
  name: string;
  code: string | null;
  quantity: number;
  priceCents: number | null;
  status: 'matched' | 'needs_confirm' | 'unmatched';
  matchMethod: MatchMethod;
  via?: 'fdc' | 'shopper';
  /** one strong match preselected by the server; still needs a tap */
  suggestedRef?: string | null;
  product?: MatchCard;
  candidates: MatchCard[];
  reason?: string;
  locked: boolean;
  /** P2: fresh-produce guess for an unmatched line ("Is this Bananas?") */
  produceGuess?: { term: string; label: string } | null;
  produceCandidates?: Array<{ fdcId: number; description: string }>;
  /** set only when the shopper taps a candidate; never automatic */
  produceConfirmed?: { fdcId: number; description: string } | null;
  produceDismissed?: boolean;
  /** P2: excluded from the score; nonFoodGuess = pre-marked by keyword (undoable) */
  nonFood?: boolean;
  nonFoodGuess?: boolean;
}

export interface ReceiptState {
  header: ReceiptHeaderEdit;
  rows: ReceiptRow[];
  /** sensitive lines removed while parsing (counts only) */
  dropped: number;
  subtotalCents: number | null;
}

const dollarsText = (c: number | null) => (c == null ? '' : (c / 100).toFixed(2));

/** Key identifying the matched product of a row (null if not matched). */
export function productKey(r: MatchRow): string | null {
  if (r.status !== 'matched' || !r.product) return null;
  return r.product.krogerProductId ? `k:${r.product.krogerProductId}` : r.product.gtin14 ? `g:${r.product.gtin14}` : null;
}

/**
 * Receipts often print the same product on several lines (one per unit).
 * Merge matched rows of the same product into one plan item: quantities add
 * up, paid prices add up, and a lock on any of them locks the merged item.
 */
export function mergeMatchedRows(rows: MatchRow[]): Array<MatchRow & { mergedIds: string[] }> {
  const out: Array<MatchRow & { mergedIds: string[] }> = [];
  const byKey = new Map<string, MatchRow & { mergedIds: string[] }>();
  for (const r of rows) {
    const k = productKey(r);
    if (!k) continue;
    const prev = byKey.get(k);
    if (prev) {
      prev.quantity += r.quantity;
      prev.priceCents = prev.priceCents == null || r.priceCents == null ? null : prev.priceCents + r.priceCents;
      prev.locked = prev.locked || r.locked;
      prev.mergedIds.push(r.id);
      continue;
    }
    const m = { ...r, mergedIds: [r.id] };
    byKey.set(k, m);
    out.push(m);
  }
  return out;
}

export function receiptFromOcr(lines: OcrLine[]): { state: ReceiptState; parsed: ParsedReceipt } {
  const parsed = parseReceipt(lines);
  const rows: ReceiptRow[] = parsed.items.map((i) => ({
    id: i.id,
    name: i.name,
    code: i.code ?? '',
    quantity: String(i.quantity),
    price: dollarsText(i.priceCents == null ? null : i.priceCents - i.savingsCents),
    confidence: i.confidence,
    needsLook: i.needsLook,
    reviewed: false,
    issues: i.issues,
    fromUnparsed: false,
    weighted: i.weightLb != null,
  }));
  parsed.unparsed.forEach((u, k) =>
    rows.push({
      id: `u${String(k + 1).padStart(2, '0')}`,
      name: u.text.trim(),
      code: '',
      quantity: '1',
      price: '',
      confidence: u.confidence,
      needsLook: true,
      reviewed: false,
      issues: ['we could not read this line; fix it or remove it'],
      fromUnparsed: true,
    }),
  );
  const h = parsed.header;
  return {
    parsed,
    state: {
      header: { store: h.store ?? '', zip: h.zip ?? '', date: h.date ?? '' },
      rows,
      dropped: Object.values(parsed.dropped).reduce((a, b) => a + b, 0),
      subtotalCents: parsed.subtotalCents,
    },
  };
}

export function rowNeedsLook(r: ReceiptRow): boolean {
  return !r.reviewed && (r.needsLook || !r.name.trim() || !/^\d+(\.\d{1,2})?$/.test(r.price.trim()));
}

export function priceCents(s: string): number | null {
  const m = /^\s*\$?(\d+)(?:\.(\d{1,2}))?\s*$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
}

/** Receipt rows -> the item lines sent to the server (no image, no raw OCR text of dropped lines). */
export function matchRequest(state: ReceiptState) {
  return {
    zip: state.header.zip.trim(),
    store: state.header.store.trim() || null,
    date: state.header.date.trim() || null,
    items: state.rows
      .filter((r) => r.name.trim())
      .map((r) => ({
        id: r.id,
        name: r.name.trim(),
        code: r.code.replace(/\D/g, '') || null,
        quantity: Math.max(1, Math.round(Number(r.quantity) || 1)),
        priceCents: priceCents(r.price),
        searchTerm: expandAbbrev(r.name.trim()),
        // produce/weighted lines go to the USDA produce step; obvious non-food is pre-marked: no store search
        skipSearch: r.weighted || !!produceGuess(r.name, null) || nonFoodGuess(r.name),
      })),
  };
}
