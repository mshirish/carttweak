/**
 * Receipt parsing. Pure: OCR rows (or pasted text) in -> structured receipt out.
 * Chain-agnostic: parsers register in RECEIPT_PARSERS; Kroger is the only one
 * today (see docs/ADDING_A_CHAIN.md). The Kroger parser reads two formats:
 *   kroger_paper   NAME [PC|<+] PRICE TAXFLAG, weight/multi-buy line ABOVE its item,
 *                  footer date "07/14/21 11:56am"
 *   kroger_digital NAME | QTY | $PRICE columns, qty "1" or "2.41 lb", detail line
 *                  BELOW the name, header date "Jan 14, 2025, 2:37 PM"
 * Every row is classified first (classifyRow); only "item" rows become products.
 *
 * Privacy: card digits, approval/reference/order codes, AID/TC, cashier names
 * and loyalty-card numbers are dropped and never returned (counts only).
 */
import { expandAbbrev } from './krogerAbbrev.ts';
import { rightmostMoney } from './receiptRows.ts';

export interface OcrLine {
  text: string;
  /** 0-100 from the OCR engine; null when unknown (e.g. typed or pasted text) */
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
  storeNumber?: string | null;
  city?: string | null;
  state?: string | null;
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
  /** line total in cents as printed */
  priceCents: number | null;
  /** what the shopper paid for the line: price minus attached savings when the receipt's own numbers say so */
  paidCents: number | null;
  unitPriceCents: number | null;
  weightLb: number | null;
  pricePerLbCents: number | null;
  /** savings printed for this item (positive cents) */
  savingsCents: number;
  wasPriceCents: number | null;
  snapEligible: boolean;
  /** tax flag printed after the price (Kroger paper: F, T, B) */
  taxFlag: string | null;
  confidence: number | null;
  lines: string[];
  issues: string[];
  needsLook: boolean;
}

export type RowKind = 'header' | 'item' | 'item_detail' | 'savings' | 'total' | 'payment' | 'marketing' | 'unknown';
export type ReceiptFormat = 'kroger_paper' | 'kroger_digital';

/** A classified row (sensitive rows are never included). */
export interface ReceiptRowOut {
  text: string;
  kind: RowKind;
  confidence: number | null;
  amountCents: number | null;
  /** item rows: the item id */
  itemId?: string;
}

/** The receipt's own numbers vs what we read. */
export interface ReceiptCheck {
  /** items as read, minus the savings that count */
  itemsCents: number;
  /** what the items should add up to, from the receipt */
  targetCents: number | null;
  targetLabel: 'subtotal' | 'total minus tax' | 'total' | null;
  matches: boolean | null;
  /** target - items (positive: something is missing) */
  gapCents: number | null;
  /** item savings lines reduce the line price (false: printed prices are already what was paid) */
  savingsApplied: boolean;
  /** legacy name for targetCents */
  subtotalCents: number | null;
  /** "TOTAL NUMBER OF ITEMS SOLD = N" vs the parsed count */
  itemsSold: number | null;
  itemsCounted: number;
  countMatches: boolean | null;
}

export interface ParsedReceipt {
  parser: string;
  format: ReceiptFormat;
  header: ReceiptHeader;
  items: ReceiptItem[];
  rows: ReceiptRowOut[];
  subtotalCents: number | null;
  taxCents: number | null;
  totalCents: number | null;
  /** savings with no clear item (digital "Kroger Savings -$2.00") */
  tripSavingsCents: number;
  unparsed: Array<{ text: string; confidence: number | null }>;
  dropped: Record<string, number>;
  skipped: number;
  check: ReceiptCheck;
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
  const m = /^(\d+)[.,](\d{2})$/.exec(fixDigits(s.replace(/[\s$]/g, '')).value);
  return m ? Number(m[1]) * 100 + Number(m[2]) : null;
}

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

// ---------- dates ----------
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** "07/14/21 11:56am", "10/06/16 02:03pm", "Jan 14, 2025, 2:37 PM", "January 14, 2025", "2025-01-14" -> ISO date + time. */
export function parseReceiptDate(text: string): { date: string; time: string | null } | null {
  const pad = (n: string | number) => String(n).padStart(2, '0');
  const yr = (y: string) => (y.length === 2 ? `20${y}` : y);
  const tm = (h?: string, ap?: string) => (h ? `${h}${ap ? ap.toLowerCase().replace(/[\s.]/g, '') : ''}` : null);
  let m = /\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b(?:\s+(\d{1,2}:\d{2})\s*([ap]\.?\s?m\.?)?)?/i.exec(text);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12 && Number(m[2]) >= 1 && Number(m[2]) <= 31) return { date: `${yr(m[3]!)}-${pad(m[1]!)}-${pad(m[2]!)}`, time: tm(m[4], m[5]) };
  m = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})(?:,?\s+(\d{1,2}:\d{2})\s*([AP]\.?\s?M\.?)?)?/i.exec(text);
  if (m) return { date: `${m[3]}-${pad(MONTHS.indexOf(m[1]!.toLowerCase().slice(0, 3)) + 1)}-${pad(m[2]!)}`, time: tm(m[4], m[5]) };
  m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: null };
  return null;
}

// ---------- row rules ----------
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length]!;
}
/** A word close to KEY despite OCR errors ("BALANGE", "8ALANCE"). */
function fuzzyWord(t: string, key: string, maxDist: number): boolean {
  return (t.toUpperCase().match(/[A-Z0-9]{3,}/g) ?? []).some((w) => Math.abs(w.length - key.length) <= 1 && editDistance(w, key) <= maxDist);
}
const isBalance = (t: string) => /\bBALANCE\b/i.test(t) || fuzzyWord(t, 'BALANCE', 2);
const isSubtotal = (t: string) => /^\W*SUB\s*-?\s*TOTAL/i.test(t) || fuzzyWord(t, 'SUBTOTAL', 2);
const SENSITIVE: Array<[string, RegExp]> = [
  ['card', /\*{4,}|X{4,}\d|[•●·]{3,}|\bACCOUNT\b|KROGER\s+PLUS\s+CUSTOMER|\b(?:VISA|MASTERCARD|AMEX|AMERICAN EXPRESS|DISCOVER|US DEBIT|DEBIT|CREDIT)\b.*(?:Purchase|\d{4})/i],
  ['approval_or_reference', /\b(?:REF\s*#|AID\s*:|TC\s*:|APPR|AUTH|VERIFIED BY PIN|PURCHASE\s*:|CASHBACK|ORDER\s*(?:#|NO\b|NUMBER))/i],
  ['cashier', /your\s+cashier\s+was/i],
];
const MARKETING = /FUEL|POINTS|YOU\s+(?:COULD\s+HAVE\s+)?SAVED|THANK\s*YOU|JOIN\b|QUESTIONS|OPPORTUNITY|TEAM\s+TODAY|HIRING|jobs\.|www\.|\.com\b|Check\s+Cart|FRESH\s+FOR|EVERYONE|GREAT\s+FOOD|LOW\s+PRICES|#ER#|ANNUAL\s+CARD|COMMUNITY|REWARDS|REDEEM|SAVE\s+UP\s+TO|PER\s+GAL|EXPIRE|VISIT\b|View\s+this\s+receipt|APPLY\s+TODAY/i;
const PAYMENT = /^\W*(?:CASH|CHANGE|AMEX|VISA|DEBIT|CREDIT|EBT|MASTERCARD|DISCOVER|TENDER|PAYMENT)\b/i;
const STREET = /^\W*\d{2,6}\s+[A-Za-z][A-Za-z0-9 .'-]*$/;
const CITY = /(?:^|\s)([A-Za-z][A-Za-z .'-]*?),?\s+([A-Za-z]{2}),?\s+(\d{5})(?:-\d{4})?\W{0,3}$/;
const PHONE = /^\W*\(?\d{3}\)?[-. ]?\d{3}[-. ]\d{4}\b/;
const STORE_NO = /\bStore\s*#\s*(\d{1,5})\b/i;
const WEIGHT = /^\W*(?:WT\s+)?(?<w>\d*[.,]?\d+)\s*(?:lbs?|[l1I|]b)\s*@\s*\$?(?<rate>\d+[.,]\d{2})\s*\/\s*(?:lbs?|[l1I|]b)\W*$/i;
/** OCR-mangled weight line ("2.13 1b ¢ 1,99 /1b"): a number, a short unit, maybe an @-ish mark, a rate, "/" + a short unit. */
const WEIGHT_LOOSE = /^\s*(?:\S{1,2}\s+){0,2}(?<w>\d*[.,]?\d+)\s*\S{0,3}\s*[@¢©9]?\s*\$?(?<rate>\d+[.,]\d{2})\s*\/\s*\S{1,3}\s*$/;
/** a weight expression at the start of a row (a price may follow it on the same row) */
const WEIGHT_PREFIX = /^\W*(?:WT\s+)?(?<w>\d*[.,]?\d+)\s*(?:lbs?|[l1I|]b)\s*@\s*\$?(?<rate>\d+[.,]\d{2})\s*\/\s*(?:lbs?|[l1I|]b)/i;
const MULTI = /^\W*(?<qty>\d+)\s*@\s*(?:(?<n>\d+)\s*\/\s*)?\$?(?<price>\d+[.,]\d{2})\W*$/;
/** Item whose price lost its decimal point ("SAMPLE JAM 399 F"): only with a real word and a tax flag. */
const ITEM_NODOT = /^(?:WT\s+)?(?<name>.*?[A-Za-z]{3}.*?)\s+(?<price>\d{3,4})\s+(?<tax>[FTB])\s*$/;
/** Item whose price OCR bent ("3-14 F", "0.400 F"): only with a real word and a tax flag. */
const ITEM_BENT = /^(?:WT\s+)?(?<name>.*?[A-Za-z]{3}.*?)\s+(?<int>\d{1,3})[.,\-](?<dec>\d{2})\d?\s*(?<tax>[FTB])\W*$/;
const MARKERS = /\s+(?:PC|SC|<\+|<|\+)(?=\s|$)|<\+/g;
const SAVINGS = /SAVINGS|COUPON|\bSC\b|DISCOUNT|PROMO/i;

/** What kind of row is this? Order matters: totals and sensitive rows are recognised before anything item-like. */
export function classifyRow(text: string, format: ReceiptFormat = 'kroger_paper'): RowKind | 'sensitive' {
  const t = text.trim();
  if (!t) return 'unknown';
  if (/ITEMS\s+SOLD/i.test(t)) return 'total';
  if (isBalance(t) || isSubtotal(t) || /^\W*(?:TAX\b|TOTAL\W*(?:DUE)?\W*[$\d(-]|TOTAL\s*$)/i.test(t)) return 'total';
  if (SENSITIVE.some(([, re]) => re.test(t))) return 'sensitive';
  if (/^\W*TOTAL\s+SAVINGS/i.test(t)) return 'savings';
  if (MARKETING.test(t)) return 'marketing';
  if (PAYMENT.test(t)) return 'payment';
  if (parseReceiptDate(t) || CITY.test(t) || PHONE.test(t) || STORE_NO.test(t) || /^\W*kroger\W*$|DIGITAL\s+RECEIPT|^\W*Item\b.*\b(?:Qty|Price)\b/i.test(t)) return 'header';
  if (WEIGHT.test(t) || WEIGHT_PREFIX.test(t) || MULTI.test(t) || (!/[A-Za-z]{3}/.test(t) && WEIGHT_LOOSE.test(t))) return 'item_detail';
  const money = rightmostMoney(t);
  if (money && (money.negative || SAVINGS.test(t.slice(0, money.index)))) return 'savings';
  if (money && /[A-Za-z]{2}/.test(t.slice(0, money.index))) return 'item';
  if (format === 'kroger_paper' && (ITEM_NODOT.test(t) || ITEM_BENT.test(t))) return 'item';
  if (STREET.test(t)) return 'header';
  return 'unknown';
}

/** Digital receipt cues: a "Digital Receipt" title, Item/Qty/Price headers, $-prefixed prices. */
export function detectFormat(lines: OcrLine[]): ReceiptFormat {
  const txt = lines.map((l) => l.text);
  if (txt.some((t) => /DIGITAL\s+RECEIPT/i.test(t) || /\bItem\b.*\bQty\b/i.test(t) || /^\W*Qty\W*$/i.test(t))) return 'kroger_digital';
  const dollar = txt.filter((t) => /\$\s?\d+[.,]\d{2}/.test(t)).length;
  const flagged = txt.filter((t) => /\d[.,]\d{2}\s*[FTB]\W*$/.test(t)).length;
  return dollar >= 3 && dollar > flagged * 2 ? 'kroger_digital' : 'kroger_paper';
}

/** A row that starts a receipt (used to split several receipts printed in one photo). */
const STARTS_RECEIPT = (t: string) => /your\s+cashier\s+was|DIGITAL\s+RECEIPT|^\W*kroger\W*$/i.test(t) || STREET.test(t.trim());

function newItem(n: number, raw: OcrLine, name: string): ReceiptItem {
  const clean = name
    .replace(MARKERS, ' ')
    .replace(/^\W*WT\s+/i, '')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    id: `r${String(n).padStart(2, '0')}`,
    name: clean,
    searchTerm: expandAbbrev(clean),
    code: null,
    isPlu: false,
    quantity: 1,
    priceCents: null,
    paidCents: null,
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

type Detail = { raw: OcrLine; weightLb?: number; perLb?: number; qty?: number; unit?: number };
function detailOf(raw: OcrLine, t: string): Detail | null {
  const w = WEIGHT.exec(t) ?? (/[A-Za-z]{3}/.test(t) ? null : WEIGHT_LOOSE.exec(t));
  if (w) return { raw, weightLb: Number(w.groups!.w!.replace(',', '.')), perLb: cents(w.groups!.rate) ?? undefined };
  const wp = WEIGHT_PREFIX.exec(t);
  if (wp) return { raw, weightLb: Number(wp.groups!.w!.replace(',', '.')), perLb: cents(wp.groups!.rate) ?? undefined };
  const m = MULTI.exec(t);
  if (m) {
    const price = cents(m.groups!.price)!;
    return { raw, qty: Number(m.groups!.qty), unit: m.groups!.n ? Math.round(price / Number(m.groups!.n)) : price };
  }
  return null;
}
function applyDetail(item: ReceiptItem, d: Detail, before: boolean) {
  if (before) item.lines.unshift(d.raw.text);
  else item.lines.push(d.raw.text);
  if (d.weightLb != null) {
    item.weightLb = d.weightLb;
    item.pricePerLbCents = d.perLb ?? null;
    // OCR often mangles the weight; the price and the rate are more reliable
    if (item.priceCents && d.perLb && Math.abs(d.weightLb * d.perLb - item.priceCents) > item.priceCents * 0.05) {
      item.weightLb = Math.round((item.priceCents / d.perLb) * 100) / 100;
      item.issues.push('weight re-read from price and rate; please check it');
    }
  }
  if (d.qty != null) {
    item.quantity = d.qty;
    item.unitPriceCents = d.unit ?? null;
  }
}

/** Digital item: NAME | QTY | $PRICE. Qty is "1" or "2.41 lb"; columns may survive as wide gaps. */
function digitalItem(text: string, priceIndex: number): { name: string; qty: number; weightLb: number | null } {
  let left = text.slice(0, priceIndex).trim();
  let qty = 1;
  let weightLb: number | null = null;
  const q =
    /(?:\s{2,}|^)(\d+(?:[.,]\d+)?)\s*(lbs?|[l1I|]?b)?\s*$/i.exec(left) ?? /\s(\d+(?:[.,]\d+)?)\s*(lbs?|[l1I|]?b)\s*$/i.exec(left) ?? /\s(\d{1,2})\s*$/.exec(left);
  if (q && /[A-Za-z]{2}/.test(left.slice(0, q.index))) {
    const n = Number(q[1]!.replace(',', '.'));
    if (q[2]) weightLb = n;
    else if (Number.isInteger(n) && n > 0 && n < 50) qty = n;
    left = left.slice(0, q.index);
  }
  return { name: left.replace(/\s+/g, ' ').trim(), qty, weightLb };
}

/** Split rows into separate receipts: a new one starts at a header row after a balance/total. */
export function splitReceipts(lines: OcrLine[]): OcrLine[][] {
  const out: OcrLine[][] = [[]];
  let closed = false;
  let sawItem = false;
  for (const l of lines) {
    const t = l.text.trim();
    if (closed && sawItem && STARTS_RECEIPT(t)) {
      out.push([]);
      closed = false;
      sawItem = false;
    }
    out[out.length - 1]!.push(l);
    if (classifyRow(trimEdgeNoise(t).replace(/\s+/g, ' ')) === 'item') sawItem = true;
    if (isBalance(t) || /^\W*TOTAL\W*(?:DUE)?\W*[$\d]/i.test(t)) closed = true;
  }
  return out.filter((s) => s.length);
}

function assemble(lines: OcrLine[], format: ReceiptFormat): ParsedReceipt {
  const header: ReceiptHeader = { chain: 'kroger', store: null, zip: null, date: null, time: null, storeNumber: null, city: null, state: null };
  const items: ReceiptItem[] = [];
  const rows: ReceiptRowOut[] = [];
  const unparsed: ParsedReceipt['unparsed'] = [];
  const dropped: Record<string, number> = {};
  let skipped = 0;
  let tax: number | null = null;
  let total: number | null = null;
  let subtotal: number | null = null;
  let tripSavings = 0;
  let itemsSold: number | null = null;
  let afterTotals = false;
  // paper: weight / multi-buy lines print BEFORE their item; digital: the line BELOW the name
  let pending: Detail | null = null;
  let lastWasItem = false;
  /** digital: a name-only row waiting for its qty/price row */
  let nameOnly: OcrLine | null = null;
  let n = 0;
  for (const raw of lines) {
    const text = (format === 'kroger_paper' ? trimEdgeNoise(raw.text) : raw.text).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const kind = classifyRow(text, format);
    const money = rightmostMoney(text);
    if (kind !== 'unknown' && kind !== 'item_detail') nameOnly = null;
    const headerFields = (t: string) => {
      const d = parseReceiptDate(t);
      if (d && !header.date) Object.assign(header, d);
      const sn = STORE_NO.exec(t);
      if (sn) header.storeNumber = sn[1]!;
      const c = CITY.exec(t);
      if (c && !d) {
        header.city = c[1]!.trim();
        header.state = c[2]!.toUpperCase();
        header.zip = c[3]!;
      }
      if (!header.store && !items.length && STREET.test(t)) header.store = t.trim().replace(/^\W+/, '');
    };
    if (kind === 'sensitive') {
      const which = SENSITIVE.find(([, re]) => re.test(text))![0];
      dropped[which] = (dropped[which] ?? 0) + 1;
      // digital receipts print the address or date in the column next to the card: keep only those columns
      for (const seg of raw.text.split(/\s{2,}/)) if (!SENSITIVE.some(([, re]) => re.test(seg))) headerFields(seg);
      lastWasItem = false;
      continue;
    }
    const row: ReceiptRowOut = { text, kind, confidence: raw.confidence, amountCents: money ? money.cents * (money.negative ? -1 : 1) : null };
    if (kind === 'header') {
      const segs = raw.text.split(/\s{2,}/).filter((x) => x.trim());
      for (const seg of segs.length > 1 ? segs : [text]) headerFields(seg);
      rows.push(row);
      lastWasItem = false;
      continue;
    }
    if (kind === 'total') {
      const sold = /ITEMS\s+SOLD\W*(\d+)/i.exec(text);
      if (sold) itemsSold = Number(sold[1]);
      else if (money) {
        if (isBalance(text)) total = money.cents;
        else if (isSubtotal(text)) subtotal = money.cents;
        else if (/^\W*TAX/i.test(text)) tax = (tax ?? 0) + money.cents;
        else total = money.cents;
      }
      afterTotals = true;
      rows.push(row);
      lastWasItem = false;
      continue;
    }
    if (kind === 'payment' || kind === 'marketing') {
      rows.push(row);
      lastWasItem = false;
      skipped++;
      continue;
    }
    if (kind === 'item_detail') {
      const d = detailOf(raw, text)!;
      const rate = WEIGHT_PREFIX.exec(text);
      if (format === 'kroger_digital' && nameOnly && rate && money && money.index >= rate[0].length) {
        // "Bananas" on one row, "2.41 lb @ $0.59/lb   $1.42" on the next
        const item = newItem(++n, nameOnly, nameOnly.text);
        item.priceCents = money.cents;
        applyDetail(item, d, false);
        items.push(item);
        rows.push({ ...row, kind: 'item', itemId: item.id });
        nameOnly = null;
        lastWasItem = true;
        continue;
      }
      const prev = items[items.length - 1];
      if (format === 'kroger_digital' && prev && lastWasItem) applyDetail(prev, d, false);
      else pending = d;
      rows.push(row);
      continue;
    }
    if (kind === 'savings') {
      const amt = money?.cents ?? 0;
      const prev = items[items.length - 1];
      // paper: a savings line right under an item belongs to it; everything else is trip-level
      if (format === 'kroger_paper' && prev && lastWasItem && !afterTotals) {
        prev.savingsCents += amt;
        prev.lines.push(raw.text);
        row.itemId = prev.id;
      } else if (!afterTotals) tripSavings += amt;
      rows.push(row);
      continue;
    }
    if (kind === 'item') {
      const nodot = money ? null : ITEM_NODOT.exec(text);
      const bent = money || nodot ? null : ITEM_BENT.exec(text);
      let item: ReceiptItem;
      if (bent) {
        item = newItem(++n, raw, bent.groups!.name!);
        item.priceCents = Number(bent.groups!.int) * 100 + Number(bent.groups!.dec);
        item.taxFlag = bent.groups!.tax!;
        item.issues.push('price partly unclear; please check it');
      } else if (nodot) {
        item = newItem(++n, raw, nodot.groups!.name!);
        item.priceCents = Number(nodot.groups!.price);
        item.taxFlag = nodot.groups!.tax!;
        item.issues.push('price decimal point not read; please check it');
      } else if (format === 'kroger_digital') {
        const di = digitalItem(text, money!.index);
        item = newItem(++n, raw, di.name);
        item.priceCents = money!.cents;
        item.quantity = di.qty;
        if (di.weightLb != null) {
          item.weightLb = di.weightLb;
          item.pricePerLbCents = Math.round(money!.cents / di.weightLb);
        }
      } else {
        const after = text.slice(money!.index + money!.tok.length);
        // paper: after the price only a tax flag or a stray mark; words there mean this is not an item row
        if (/[A-Za-z]{2}/.test(after.replace(/\b[FTB]\b/, ''))) {
          rows.push({ ...row, kind: 'unknown' });
          unparsed.push({ text: raw.text, confidence: raw.confidence });
          lastWasItem = false;
          continue;
        }
        item = newItem(++n, raw, text.slice(0, money!.index));
        item.priceCents = money!.cents;
        item.taxFlag = /\b([FTB])\b/.exec(after)?.[1] ?? null;
        if (money!.fixed) item.issues.push('price had letters that look like digits; please check it');
      }
      item.snapEligible = item.taxFlag === 'F';
      if (pending) {
        applyDetail(item, pending, true);
        pending = null;
      }
      if (!item.name || item.name.length < 2) item.issues.push('name not read');
      items.push(item);
      rows.push({ ...row, itemId: item.id });
      lastWasItem = true;
      continue;
    }
    // unknown: data-looking rows are shown to the shopper as unread; the rest is noise
    if (/\d+[.,]\d{2}\b/.test(fixDigits(text).value) && /[A-Za-z]{2,}/.test(text)) unparsed.push({ text: raw.text, confidence: raw.confidence });
    else skipped++;
    rows.push(row);
    lastWasItem = false;
    if (format === 'kroger_digital' && !afterTotals && /[A-Za-z]{3}/.test(text) && !money) nameOnly = { text, confidence: raw.confidence };
  }
  // a row repeating the receipt's total (an OCR-garbled BALANCE or payment line) is never an item
  if (total != null && items.length > 1) {
    for (let k = items.length - 1; k >= 0; k--) {
      if (items[k]!.priceCents !== total) continue;
      const r = rows.find((x) => x.itemId === items[k]!.id);
      if (r) {
        r.kind = 'total';
        delete r.itemId;
      }
      items.splice(k, 1);
    }
  }
  const check = reconcile(items, tripSavings, subtotal, tax, total, itemsSold);
  for (const i of items) {
    if (i.priceCents == null) i.issues.push('no price read');
    i.paidCents = i.priceCents == null ? null : i.priceCents - (check.savingsApplied ? i.savingsCents : 0);
    i.needsLook = i.issues.length > 0 || (i.confidence != null && i.confidence < LOW_CONFIDENCE);
  }
  return { parser: 'kroger', format, header, items, rows, subtotalCents: subtotal ?? check.subtotalCents, taxCents: tax, totalCents: total, tripSavingsCents: tripSavings, unparsed, dropped, skipped, check };
}

/**
 * Do the items add up? Target: the printed subtotal, else total minus tax, else
 * the total. Item savings lines either reduce the line price or are already in
 * it (Kroger paper prints the paid price); whichever the receipt's own numbers
 * confirm is used. Within $0.02 counts as a match.
 */
export function reconcile(
  items: Array<Pick<ReceiptItem, 'priceCents' | 'savingsCents' | 'quantity' | 'weightLb'>>,
  tripSavingsCents: number,
  subtotal: number | null,
  tax: number | null,
  total: number | null,
  itemsSold: number | null = null,
): ReceiptCheck {
  const gross = items.reduce((s, i) => s + (i.priceCents ?? 0), 0) - tripSavingsCents;
  const lineSavings = items.reduce((s, i) => s + i.savingsCents, 0);
  const net = gross - lineSavings;
  const target = subtotal ?? (total != null ? total - (tax ?? 0) : null);
  const targetLabel: ReceiptCheck['targetLabel'] = subtotal != null ? 'subtotal' : total != null ? (tax != null ? 'total minus tax' : 'total') : null;
  let savingsApplied = lineSavings > 0;
  let itemsCents = net;
  let matches: boolean | null = null;
  if (target != null) {
    if (Math.abs(net - target) <= 2) matches = true;
    else if (lineSavings && Math.abs(gross - target) <= 2) {
      matches = true;
      savingsApplied = false;
      itemsCents = gross;
    } else {
      matches = false;
      if (lineSavings && Math.abs(gross - target) < Math.abs(net - target)) {
        savingsApplied = false;
        itemsCents = gross;
      }
    }
  }
  const itemsCounted = items.reduce((s, i) => s + (i.weightLb != null ? 1 : i.quantity), 0);
  return {
    itemsCents,
    targetCents: target,
    targetLabel,
    matches,
    gapCents: target == null ? null : target - itemsCents,
    savingsApplied,
    subtotalCents: target,
    itemsSold,
    itemsCounted,
    countMatches: itemsSold == null ? null : itemsSold === itemsCounted,
  };
}

export function parseKrogerReceipt(input: OcrLine[] | string): ParsedReceipt {
  const lines: OcrLine[] = typeof input === 'string' ? input.split(/\r?\n/).map((text) => ({ text, confidence: null })) : input;
  const format = detectFormat(lines);
  const segs = splitReceipts(lines)
    .map((s) => assemble(s, format))
    .reduce<ParsedReceipt[]>((acc, r) => {
      // a segment with no items and no total is a footer fragment of the one before
      if (!r.items.length && r.totalCents == null && acc.length) return acc;
      acc.push(r);
      return acc;
    }, []);
  if (segs.length <= 1) return segs[0] ?? assemble(lines, format);
  return { ...segs[0]!, receipts: segs };
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
  const parsed = blocks
    .map((b) => parseReceipt(b))
    .flatMap((r) => r.receipts ?? [r])
    .filter((r) => r.items.length || r.totalCents != null);
  if (!parsed.length) return parseReceipt(blocks.flat());
  if (parsed.length === 1) return parsed[0]!;
  return { ...parsed[0]!, receipts: parsed };
}

/** Higher is better: picks between reconstructions and rotations. The receipt's own numbers weigh most. */
export function parseScore(r: ParsedReceipt): number {
  const all = r.receipts ?? [r];
  let s = 0;
  for (const x of all) {
    const conf = x.items.length ? x.items.reduce((a, i) => a + (i.confidence ?? 60), 0) / x.items.length : 0;
    const suspect = x.items.filter((i) => !/[A-Za-z]{3}/.test(i.name)).length;
    const c = x.check;
    const numbers = c.matches ? 100 : c.targetCents && c.gapCents != null ? Math.max(0, 60 - Math.abs(c.gapCents) / 25) : 0;
    const headerFields = [x.header.store, x.header.zip, x.header.date].filter(Boolean).length;
    s += numbers + (c.countMatches ? 30 : 0) + Math.min(x.items.length, 40) * 2 + conf * 0.3 + headerFields * 3 - suspect * 5 - x.unparsed.length;
  }
  return s;
}
