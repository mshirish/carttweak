/**
 * Receipt parsing. Pure: OCR lines in -> structured receipt out.
 * Chain-agnostic: parsers register in RECEIPT_PARSERS; Kroger is the only one today
 * (see docs/ADDING_A_CHAIN.md).
 *
 * Privacy: card digits, approval/reference codes, AID/TC, cashier names and
 * loyalty-card numbers are dropped and never returned (counts only).
 */
import { expandAbbrev } from './krogerAbbrev.ts';

export interface OcrLine {
  text: string;
  /** 0-100 from the OCR engine; null when unknown (e.g. typed text) */
  confidence: number | null;
}

export interface ReceiptHeader {
  chain: string;
  /** store street address as printed */
  store: string | null;
  /** ZIP if printed */
  zip: string | null;
  /** ISO date YYYY-MM-DD */
  date: string | null;
  time: string | null;
}

export interface ReceiptItem {
  id: string;
  /** name as printed, markers removed */
  name: string;
  /** search words with abbreviations expanded (original stays visible) */
  searchTerm: string;
  /** barcode-like code if the chain prints one (Kroger doesn't) */
  code: string | null;
  isPlu: boolean;
  quantity: number;
  /** line total in cents */
  priceCents: number | null;
  unitPriceCents: number | null;
  weightLb: number | null;
  pricePerLbCents: number | null;
  /** savings attached to this item (positive cents; subtracted) */
  savingsCents: number;
  wasPriceCents: number | null;
  snapEligible: boolean;
  /** tax flag printed after the price (Kroger: F, T, B) */
  taxFlag: string | null;
  confidence: number | null;
  lines: string[];
  issues: string[];
  needsLook: boolean;
}

export interface ParsedReceipt {
  parser: string;
  header: ReceiptHeader;
  items: ReceiptItem[];
  subtotalCents: number | null;
  taxCents: number | null;
  totalCents: number | null;
  unparsed: Array<{ text: string; confidence: number | null }>;
  dropped: Record<string, number>;
  skipped: number;
  check: { itemsCents: number; subtotalCents: number | null; matches: boolean | null };
  /** more than one receipt in the photo: each one separately (never merged); the top level is the first */
  receipts?: ParsedReceipt[];
}

export interface ReceiptParser {
  id: string;
  chain: string;
  /** 0..1: how likely these lines are this chain's receipt */
  detect(lines: OcrLine[]): number;
  parse(lines: OcrLine[]): ParsedReceipt;
}

export const LOW_CONFIDENCE = 80;

// ---------- OCR clean-up ----------
const DIGIT_FIX: Record<string, string> = { O: '0', o: '0', Q: '0', D: '0', I: '1', l: '1', '|': '1', S: '5', s: '5', B: '8', Z: '2' };
export function fixDigits(s: string): { value: string; fixed: boolean } {
  let fixed = false;
  const value = [...s].map((c) => (/\d/.test(c) ? c : DIGIT_FIX[c] != null ? ((fixed = true), DIGIT_FIX[c]) : c)).join('');
  return { value, fixed };
}
function cents(s: string | undefined | null): number | null {
  if (s == null) return null;
  const m = /^(\d+)[.,](\d{2})$/.exec(fixDigits(s.replace(/\s/g, '')).value);
  return m ? Number(m[1]) * 100 + Number(m[2]) : null;
}

// ---------- Kroger ----------
const N = String.raw`[0-9OoIl|SB]`;
const PRICE = String.raw`(${N}{1,4}[.,]${N}{2})`;
const K_ITEM = new RegExp(String.raw`^(?:WT\s+)?(?<name>.*?[A-Za-z]{2}.*?)\s+(?<price>${N}{1,4}[.,]${N}{2})\s*-?\s*(?:(?<tax>[FTB])|[|§\[\]{}()/\\:;'"~«»*a-z])?\s*$`);
const K_WEIGHT = /^\s*(?:WT\s+)?(?<w>\d*[.,]?\d+)\s*[l1I|]b\s*@\s*(?<rate>\d+[.,]\d{2})\s*\/\s*[l1I|]b\s*$/i;
/** OCR-mangled weight line ("2.13 1b ¢ 1,99 /1b"): a number, a short unit, maybe an @-ish mark, a rate, "/" + a short unit. */
const K_WEIGHT_LOOSE = /^\s*(?:\S{1,2}\s+){0,2}(?<w>\d*[.,]?\d+)\s*\S{0,3}\s*[@¢©9]?\s*(?<rate>\d+[.,]\d{2})\s*\/\s*\S{1,3}\s*$/;
/** Item whose price lost its decimal point ("SAMPLE JAM 399 F"): only with a real word and a tax flag. */
const K_ITEM_NODOT = /^(?:WT\s+)?(?<name>.*?[A-Za-z]{3}.*?)\s+(?<price>\d{3,4})\s+(?<tax>[FTB])\s*$/;
const K_MULTI = /^\s*(?<qty>\d+)\s*@\s*(?:(?<n>\d+)\s*\/\s*)?(?<price>\d+[.,]\d{2})\s*$/;
const K_SAVINGS = new RegExp(String.raw`^\s*(?:KROGER\s+SAVINGS|SC|SAVINGS)\b.*?${PRICE}\s*-?\s*[A-Z]?\s*$`, 'i');
const K_SENSITIVE: Array<[string, RegExp]> = [
  ['card', /\*{4,}|X{4,}\d|\bACCOUNT\b|KROGER\s+PLUS\s+CUSTOMER|\b(?:VISA|MASTERCARD|AMEX|AMERICAN EXPRESS|DISCOVER|US DEBIT|DEBIT|CREDIT)\b.*(?:Purchase|\d{4})/i],
  ['approval_or_reference', /\b(?:REF\s*#|AID\s*:|TC\s*:|APPR|AUTH|VERIFIED BY PIN|PURCHASE\s*:|CASHBACK)/i],
  ['cashier', /your\s+cashier\s+was/i],
];
const K_SKIP = /^\s*(?:\*+\s*)?(TAX|BALANCE|CHANGE|TOTAL|AMEX|DEBIT|CREDIT|VISA|CASH)\b|ITEMS\s+SOLD|FUEL|POINTS|YOU\s+(?:COULD\s+HAVE\s+)?SAVED|TOTAL\s+SAVINGS|JOIN\b|QUESTIONS|OPPORTUNITY|TEAM\s+TODAY|jobs\.kroger|www\.|Check\s+Cart|THANK\s+YOU|FRESH\s+FOR|EVERYONE|#ER#|^kroger$/i;
const K_STREET = /^\s*\d{2,6}\s+[A-Za-z][A-Za-z0-9 .'-]*$/;
const K_CITY = /^\s*([A-Za-z][A-Za-z .'-]+?)\s*,?\s+([A-Za-z]{2})\s*,?\s+(\d{5})(?:-\d{4})?\s*$/;
const K_DATE = /\b(\d{2})\/(\d{2})\/(\d{2}|\d{4})\s+(\d{1,2}:\d{2})\s*(am|pm)?/i;
const MARKERS = /\s+(?:PC|SC|<\+|<|\+)(?=\s|$)|<\+/g;

/**
 * Handheld photos pick up junk past the receipt edges: stray marks before the
 * name and after the tax flag, separated from the real text by wide gaps.
 * Keep the gap-separated segment holding the price, the name segment(s) before
 * it, and at most one short tax-flag token after it.
 */
export function trimEdgeNoise(text: string): string {
  const segs = text.split(/\s{4,}/).map((x) => x.trim()).filter(Boolean);
  if (segs.length < 2) return text;
  const pi = segs.findIndex((x) => /\d+[.,]\d{2}/.test(x));
  if (pi < 0) return text;
  const priceSeg = segs[pi]!;
  const lettersBefore = (/^(.*?)\d+[.,]\d{2}/.exec(priceSeg)?.[1] ?? '').replace(/[^A-Za-z]/g, '').length;
  const keep: string[] = [];
  let haveName = lettersBefore >= 2;
  for (let i = pi - 1; i >= 0; i--) {
    const x = segs[i]!;
    if (/^(?:PC|SC|<\+|<|\+)$/.test(x)) {
      keep.unshift(x); // price markers between name and price
      continue;
    }
    if ((!haveName && /[A-Za-z]{2}/.test(x)) || /[A-Za-z]{3}/.test(x)) {
      keep.unshift(x);
      haveName = true;
    } else break;
  }
  let tail = '';
  const next = segs[pi + 1];
  if (next && /^[FTB]$/.test(next)) tail = next;
  return [...keep, priceSeg, tail].filter(Boolean).join(' ');
}

function newItem(n: number, raw: OcrLine, name: string): ReceiptItem {
  const clean = name.replace(MARKERS, ' ').replace(/^WT\s+/i, '').replace(/\s+/g, ' ').trim();
  return {
    id: `r${String(n).padStart(2, '0')}`,
    name: clean,
    searchTerm: expandAbbrev(clean),
    code: null,
    isPlu: false,
    quantity: 1,
    priceCents: null,
    unitPriceCents: null,
    weightLb: null,
    pricePerLbCents: null,
    savingsCents: 0,
    wasPriceCents: null,
    snapEligible: false,
    taxFlag: null,
    confidence: raw.confidence,
    lines: [raw.text],
    issues: [],
    needsLook: false,
  };
}

export function parseKrogerReceipt(input: OcrLine[] | string): ParsedReceipt {
  const lines: OcrLine[] = typeof input === 'string' ? input.split(/\r?\n/).map((text) => ({ text, confidence: null })) : input;
  const header: ReceiptHeader = { chain: 'kroger', store: null, zip: null, date: null, time: null };
  const items: ReceiptItem[] = [];
  const unparsed: ParsedReceipt['unparsed'] = [];
  const dropped: Record<string, number> = {};
  let skipped = 0;
  let tax: number | null = null;
  let total: number | null = null;
  // weight / multi-buy lines print BEFORE their item on Kroger receipts
  let pending: { raw: OcrLine; weightLb?: number; perLb?: number; qty?: number; unit?: number } | null = null;
  let n = 0;
  for (const raw of lines) {
    const text = trimEdgeNoise(raw.text).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const d = K_DATE.exec(text);
    if (d) {
      header.date = `${d[3]!.length === 2 ? `20${d[3]}` : d[3]}-${d[1]}-${d[2]}`;
      header.time = `${d[4]}${d[5] ? d[5].toLowerCase() : ''}`;
      continue;
    }
    // before the card rule: "**** BALANCE" starts with asterisks
    if (/BALANCE/i.test(text)) {
      const t = /(\d+[.,]\d{2})/.exec(text);
      if (t) total = cents(t[1]);
      skipped++;
      continue;
    }
    const sens = K_SENSITIVE.find(([, re]) => re.test(text));
    if (sens) {
      dropped[sens[0]] = (dropped[sens[0]] ?? 0) + 1;
      continue;
    }
    const city = K_CITY.exec(text);
    if (city) {
      header.zip = city[3]!;
      continue;
    }
    if (/^\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\s*$/.test(text)) {
      skipped++; // store phone
      continue;
    }
    if (!items.length && !header.store && K_STREET.test(text)) {
      header.store = text;
      continue;
    }
    const w = K_WEIGHT.exec(text) ?? (/[A-Za-z]{3}/.test(text) ? null : K_WEIGHT_LOOSE.exec(text));
    if (w) {
      pending = { raw, weightLb: Number(w.groups!.w!.replace(',', '.')), perLb: cents(w.groups!.rate) ?? undefined };
      continue;
    }
    const m = K_MULTI.exec(text);
    if (m) {
      const price = cents(m.groups!.price)!;
      const each = m.groups!.n ? Math.round(price / Number(m.groups!.n)) : price;
      pending = { raw, qty: Number(m.groups!.qty), unit: each };
      continue;
    }
    const sv = K_SAVINGS.exec(text);
    if (sv && items.length) {
      const prev = items[items.length - 1]!;
      prev.savingsCents += cents(sv[1]) ?? 0;
      prev.lines.push(raw.text);
      continue;
    }
    if (/^\s*TAX\b/i.test(text)) {
      const t = /(\d+[.,]\d{2})/.exec(text);
      if (t) tax = (tax ?? 0) + (cents(t[1]) ?? 0);
      skipped++;
      continue;
    }
    if (K_SKIP.test(text)) {
      skipped++;
      continue;
    }
    const nodot = K_ITEM.exec(text) ? null : K_ITEM_NODOT.exec(text);
    const it = K_ITEM.exec(text) ?? nodot;
    if (it) {
      const item = newItem(++n, raw, it.groups!.name!);
      item.priceCents = nodot ? Number(nodot.groups!.price) : cents(it.groups!.price);
      if (nodot) item.issues.push('price decimal point not read; please check it');
      else if (fixDigits(it.groups!.price!).fixed) item.issues.push('price had letters that look like digits; please check it');
      item.taxFlag = it.groups!.tax ?? null;
      item.snapEligible = item.taxFlag === 'F';
      if (pending) {
        item.lines.unshift(pending.raw.text);
        if (pending.weightLb != null) {
          item.weightLb = pending.weightLb;
          item.pricePerLbCents = pending.perLb ?? null;
          // OCR often mangles the weight; the price and the rate are more reliable
          if (item.priceCents && pending.perLb && Math.abs(pending.weightLb * pending.perLb - item.priceCents) > item.priceCents * 0.05) {
            item.weightLb = Math.round((item.priceCents / pending.perLb) * 100) / 100;
            item.issues.push('weight re-read from price and rate; please check it');
          }
        }
        if (pending.qty != null) {
          item.quantity = pending.qty;
          item.unitPriceCents = pending.unit ?? null;
        }
        pending = null;
      }
      if (!item.name || item.name.length < 2) item.issues.push('name not read');
      items.push(item);
      continue;
    }
    // looks like data but not understood: show it to the shopper
    if (/\d+[.,]\d{2}\b/.test(fixDigits(text).value) && /[A-Za-z]{2,}/.test(text)) unparsed.push({ text: raw.text, confidence: raw.confidence });
    else skipped++;
  }
  for (const i of items) {
    if (i.priceCents == null) i.issues.push('no price read');
    i.needsLook = i.issues.length > 0 || (i.confidence != null && i.confidence < LOW_CONFIDENCE);
  }
  const itemsCents = items.reduce((s, i) => s + (i.priceCents ?? 0) - i.savingsCents, 0);
  const subtotal = total != null && tax != null ? total - tax : null;
  return {
    parser: 'kroger',
    header,
    items,
    subtotalCents: subtotal,
    taxCents: tax,
    totalCents: total,
    unparsed,
    dropped,
    skipped,
    check: { itemsCents, subtotalCents: subtotal, matches: subtotal == null ? null : Math.abs(itemsCents - subtotal) <= 1 },
  };
}

export const krogerParser: ReceiptParser = {
  id: 'kroger',
  chain: 'kroger',
  detect: (lines) => (lines.some((l) => /kroger|your cashier was/i.test(l.text)) ? 1 : 0.5),
  parse: parseKrogerReceipt,
};

/** Registered receipt parsers. Add a chain by appending its parser (docs/ADDING_A_CHAIN.md). */
export const RECEIPT_PARSERS: ReceiptParser[] = [krogerParser];

/** Parse with the best-matching registered parser. */
export function parseReceipt(input: OcrLine[] | string): ParsedReceipt {
  const lines: OcrLine[] = typeof input === 'string' ? input.split(/\r?\n/).map((text) => ({ text, confidence: null })) : input;
  const best = [...RECEIPT_PARSERS].sort((a, b) => b.detect(lines) - a.detect(lines))[0]!;
  return best.parse(lines);
}

/** Count rows that need the shopper's attention ("x of y lines need a look"). */
export function needsLookCount(r: Pick<ParsedReceipt, 'items' | 'unparsed'>): { need: number; total: number } {
  return { need: r.items.filter((i) => i.needsLook).length + r.unparsed.length, total: r.items.length + r.unparsed.length };
}

/**
 * Parse separately reconstructed blocks (e.g. two receipts side by side).
 * Blocks without items are dropped; with more than one receipt left, the
 * result lists them all in `receipts` and the top level is the first.
 */
export function parseReceiptBlocks(blocks: OcrLine[][]): ParsedReceipt {
  const parsed = blocks.map((b) => parseReceipt(b)).filter((r) => r.items.length || r.totalCents != null);
  if (!parsed.length) return parseReceipt(blocks.flat());
  if (parsed.length === 1) return parsed[0]!;
  return { ...parsed[0]!, receipts: parsed };
}

/** Higher is better: used to pick between reconstructions and rotations. */
export function parseScore(r: ParsedReceipt): number {
  const all = r.receipts ?? [r];
  let s = 0;
  for (const x of all) {
    const conf = x.items.length ? x.items.reduce((a, i) => a + (i.confidence ?? 60), 0) / x.items.length : 0;
    const suspect = x.items.filter((i) => !/[A-Za-z]{3}/.test(i.name)).length;
    s += (x.check.matches ? 100 : 0) + Math.min(x.items.length, 40) * 2 + conf * 0.3 - suspect * 5 - x.unparsed.length;
  }
  return s;
}
