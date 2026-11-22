/**
 * Walmart receipt parser. Pure: OCR lines in -> structured receipt out.
 *
 * Finding (2026-11-22, verified against USDA FDC): the item code Walmart prints
 * is the UPC WITHOUT its check digit, zero-padded to 12 digits (same convention
 * as Kroger product ids). Produce prints a PLU (e.g. 000000004011).
 *
 * Privacy: card digits, approval/reference codes, AID/AAC/terminal ids, TC#,
 * manager/operator names, survey ids and receipt barcodes are dropped here and
 * never returned (only a count by kind).
 */
import { gs1CheckDigit, padTo, stripLeadingZeros } from './upc.ts';
import { isPlu } from './resolve.ts';

export interface OcrLine {
  text: string;
  /** 0-100 from the OCR engine; null when unknown (e.g. typed text) */
  confidence: number | null;
}

export interface ReceiptHeader {
  chain: 'walmart';
  storeNumber: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  /** ISO date YYYY-MM-DD */
  date: string | null;
  time: string | null;
}

export interface ReceiptItem {
  id: string;
  /** abbreviated name as printed */
  name: string;
  /** 12-digit code as printed (after OCR clean-up), or null */
  code: string | null;
  /** produce (PLU) codes have no barcode */
  isPlu: boolean;
  quantity: number;
  /** line total actually charged, in cents (before savings lines) */
  priceCents: number | null;
  unitPriceCents: number | null;
  weightLb: number | null;
  pricePerLbCents: number | null;
  /** coupon / discount lines attached to this item (positive cents; subtracted from the total) */
  savingsCents: number;
  /** "WAS 3.00 YOU SAVED 2.70": the earlier price (informational; the printed price is already net) */
  wasPriceCents: number | null;
  /** 'F' printed after the code (SNAP/EBT eligible on Walmart receipts) */
  snapEligible: boolean;
  /** tax flag letter printed after the price (e.g. N, X, T, H) */
  taxFlag: string | null;
  /** lowest OCR confidence of the lines that make up this item */
  confidence: number | null;
  /** raw OCR text of the lines that make up this item (client-side display only) */
  lines: string[];
  issues: string[];
  needsLook: boolean;
}

export interface ParsedReceipt {
  header: ReceiptHeader;
  items: ReceiptItem[];
  subtotalCents: number | null;
  taxCents: number | null;
  totalCents: number | null;
  /** lines that look like data but could not be parsed; shown to the shopper as rows to fix */
  unparsed: Array<{ text: string; confidence: number | null }>;
  /** sensitive lines removed, by kind (counts only, never content) */
  dropped: Record<string, number>;
  /** non-item lines recognized and skipped (totals, payment, footer), count only */
  skipped: number;
  /** sum of item prices minus savings vs printed subtotal */
  check: { itemsCents: number; subtotalCents: number | null; matches: boolean | null };
}

export const LOW_CONFIDENCE = 80;

// ---------- OCR clean-up ----------
/** Digits that OCR commonly confuses with letters (only applied inside codes and prices). */
const DIGIT_FIX: Record<string, string> = { O: '0', o: '0', Q: '0', D: '0', I: '1', l: '1', '|': '1', S: '5', B: '8', Z: '2' };

export function fixDigits(s: string): { value: string; fixed: boolean } {
  let fixed = false;
  const value = [...s].map((c) => (/\d/.test(c) ? c : DIGIT_FIX[c] != null ? ((fixed = true), DIGIT_FIX[c]) : c)).join('');
  return { value, fixed };
}

function cents(s: string | undefined | null): number | null {
  if (s == null) return null;
  const { value } = fixDigits(s.replace(',', '.').trim());
  const m = /^(\d+)\.(\d{2})$/.exec(value);
  return m ? Number(m[1]) * 100 + Number(m[2]) : null;
}

/** Receipt code -> UPC-A with check digit (12 digits), or null (PLU / not a UPC body). */
export function receiptCodeToUpcA(code: string): string | null {
  const d = code.replace(/\D/g, '');
  if (!d || isPlu(d)) return null;
  const body = stripLeadingZeros(d);
  if (body.length > 11) return null;
  return padTo(body + String(gs1CheckDigit(body)), 12);
}

// ---------- line patterns ----------
const PRICE = String.raw`(\d{1,4}[.,]\s?\d{2})`;
// name, then a code-like run (allows OCR letters), optional F / tax letter glued, optional price, optional tax flag
const ITEM_RE = new RegExp(String.raw`^(?<name>.*?[A-Za-z].*?)\s+(?<code>[0-9OoQDIl|SBZ]{6,13})(?<glued>[A-Z])?(?:\s+(?<f>F))?(?:\s+(?<price>${PRICE.slice(1, -1)}))?(?:\s*(?<tax>[A-Z]))?\s*$`);
const QTY_RE = new RegExp(String.raw`^\s*(?<qty>\d+)\s+AT\s+(?<n>\d+)\s+FOR\s+(?<unit>\d+[.,]\d{2})\s+(?<total>\d+[.,]\d{2})\s*(?<tax>[A-Z])?\s*$`, 'i');
const WEIGHT_RE = new RegExp(
  // "lb" is often OCR'd as "1b" / "Ib" (seen on real receipts)
  String.raw`^\s*(?<w>\d+[.,]\d+)\s*[l1I|]b\s*@\s*(?:(?:1(?:[.,]0+)?)\s*[l1I|]b\s*\/\s*(?<rateA>\d+(?:[.,]\d{1,2})?)|(?<rateB>\d+(?:[.,]\d{1,2})?)\s*\/\s*[l1I|]b)\s+(?<total>\d+[.,]\d{2})\s*(?<tax>[A-Z])?\s*$`,
  'i',
);
const SAVED_RE = /\bWAS\s+(\d+[.,]\d{2})\s+YOU\s+SAVED\s+(\d+[.,]\d{2})/i;
const DISCOUNT_RE = new RegExp(String.raw`^\s*(?:.*\b(?:COUPON|SAVINGS|DISCOUNT|ROLLBACK|PRICE\s*MATCH)\b.*?)\s+(\d+[.,]\d{2})\s*-?\s*(?:[A-Z])?\s*$`, 'i');
const SUBTOTAL_RE = new RegExp(String.raw`\bSUB\s*TOTAL\s+${PRICE}`, 'i');
const TAX_RE = new RegExp(String.raw`^\s*TAX\s*\d*\s+[\d.,]+\s*%\s+${PRICE}`, 'i');
const TOTAL_RE = new RegExp(String.raw`^\s*TOTAL\s+${PRICE}\s*$`, 'i');

const SENSITIVE: Array<[string, RegExp]> = [
  ['card', /\*{3,}|X{4,}\s*\d{2,4}|\bACCOUNT\b|\b(?:VISA|MASTERCARD|AMEX|DISCOVER|DEBIT|CREDIT)\b.*\d{4}/i],
  // no trailing \b: several of these end in '#', where a word boundary never matches
  ['approval_or_reference', /\b(?:APPR(?:OVAL)?\s*(?:CODE|#)|REF\s*#|NETWORK\s*ID\b|AID\b|AAC\b|TERMINAL\s*#|TRANS(?:ACTION)?\s*ID\b|AUTH\b|ARQC\b|TVR\b|TSI\b)/i],
  ['transaction_code', /\bTC\s*#/i],
  ['staff_name', /\b(?:MGR|MANAGER|CASHIER|OP#|OPERATOR)\b/i],
  ['survey_or_receipt_id', /\bID\s*#|survey\.walmart|feedback/i],
  ['barcode', /^[\s|Il1!]{12,}$|^[|Il!\s]{8,}$/],
];

const SKIP_RE =
  /\b(CHANGE\s+DUE|TEND\b|ITEMS\s+SOLD|TOTAL\s+PURCHASE|PAY\s+FROM|EFT\b|US\s+DEBIT|SHOP(?:PING)?\s+CARD|REDEMPTION|BEG\s+BAL|TRAN\s+AMT|END\s+BAL|LOW\s+PRICES|SAVE\s+MONEY|LIVE\s+BETTER|THANK\s+YOU|INTRODUCING|JOIN\s+TODAY|WALMART\.COM|SUPERCENTER|WAL\*?MART|NEIGHBORHOOD\s+MARKET|BALANCE|CASH\b)/i;

const STREET_RE = /^\s*\d{2,6}\s+[A-Za-z].*\b(ST|STREET|AVE|AVENUE|RD|ROAD|BLVD|DR|DRIVE|HWY|HIGHWAY|PKWY|LN|LANE|WAY|PIKE|CT|PL|SQ|TPKE|CIR)\b/i;
const CITY_RE = /^\s*([A-Za-z][A-Za-z .'-]+?)\s*(?:,\s*|\s+)([A-Z]{2})\s*,?\s*(\d{5})?(?:-\d{4})?\s*$/;
const DATE_RE = /\b(\d{2})\/(\d{2})\/(\d{2}|\d{4})\s+(\d{2}:\d{2}(?::\d{2})?)/;
const STORE_RE = /\bST\s*#\s*([0-9OoIl]{2,6})/i;

function isoDate(m: RegExpExecArray): string {
  const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
  return `${y}-${m[1]}-${m[2]}`;
}

function newItem(id: number, line: OcrLine, name: string): ReceiptItem {
  return {
    id: `r${String(id).padStart(2, '0')}`,
    name: name.replace(/\s+/g, ' ').trim(),
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
    confidence: line.confidence,
    lines: [line.text],
    issues: [],
    needsLook: false,
  };
}

function minConf(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

/** Parse OCR lines of a Walmart receipt. */
export function parseWalmartReceipt(input: OcrLine[] | string): ParsedReceipt {
  const lines: OcrLine[] = typeof input === 'string' ? input.split(/\r?\n/).map((text) => ({ text, confidence: null })) : input;
  const header: ReceiptHeader = { chain: 'walmart', storeNumber: null, street: null, city: null, state: null, zip: null, date: null, time: null };
  const items: ReceiptItem[] = [];
  const unparsed: ParsedReceipt['unparsed'] = [];
  const dropped: Record<string, number> = {};
  let skipped = 0;
  let subtotal: number | null = null;
  let tax: number | null = null;
  let total: number | null = null;
  let seenItems = false;
  let n = 0;

  for (const raw of lines) {
    const text = raw.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;

    // header facts that share a line with staff ids: take what we need, then drop the line
    const store = STORE_RE.exec(text);
    if (store && !header.storeNumber) header.storeNumber = fixDigits(store[1]!).value;
    const date = DATE_RE.exec(text);
    if (date) {
      // the last date on the receipt is the transaction time
      header.date = isoDate(date);
      header.time = date[4]!;
    }
    const sensitive = SENSITIVE.find(([, re]) => re.test(text));
    if (sensitive || store) {
      const kind = sensitive ? sensitive[0] : 'staff_name';
      dropped[kind] = (dropped[kind] ?? 0) + 1;
      continue;
    }
    if (date && text.replace(DATE_RE, '').trim().length < 4) continue;

    const prev = items[items.length - 1];
    const q = QTY_RE.exec(text);
    if (q && prev) {
      prev.quantity = Number(q.groups!.qty);
      prev.unitPriceCents = cents(q.groups!.unit);
      prev.priceCents = cents(q.groups!.total);
      prev.taxFlag = q.groups!.tax ?? prev.taxFlag;
      prev.lines.push(raw.text);
      prev.confidence = minConf(prev.confidence, raw.confidence);
      if (prev.unitPriceCents != null && prev.priceCents != null && Math.abs(prev.unitPriceCents * prev.quantity - prev.priceCents) > 1) prev.issues.push('quantity x unit price does not match the line total');
      continue;
    }
    const w = WEIGHT_RE.exec(text);
    if (w && prev) {
      prev.weightLb = Number(w.groups!.w!.replace(',', '.'));
      const rate = (w.groups!.rateA ?? w.groups!.rateB)!.replace(',', '.');
      prev.pricePerLbCents = Math.round(Number(rate) * 100);
      prev.priceCents = cents(w.groups!.total);
      prev.taxFlag = w.groups!.tax ?? prev.taxFlag;
      prev.lines.push(raw.text);
      prev.confidence = minConf(prev.confidence, raw.confidence);
      if (prev.priceCents != null && Math.abs(Math.round(prev.weightLb * prev.pricePerLbCents) - prev.priceCents) > 2) prev.issues.push('weight x price per lb does not match the line total');
      continue;
    }
    const sv = SAVED_RE.exec(text);
    if (sv && prev) {
      prev.wasPriceCents = cents(sv[1]);
      prev.lines.push(raw.text);
      continue;
    }
    const disc = DISCOUNT_RE.exec(text);
    if (disc && prev && !SUBTOTAL_RE.test(text)) {
      prev.savingsCents += cents(disc[1]) ?? 0;
      prev.lines.push(raw.text);
      continue;
    }
    const st = SUBTOTAL_RE.exec(text);
    if (st) {
      subtotal = cents(st[1]); // running subtotals: keep the last
      skipped++;
      continue;
    }
    const tx = TAX_RE.exec(text);
    if (tx) {
      tax = (tax ?? 0) + (cents(tx[1]) ?? 0);
      skipped++;
      continue;
    }
    const tt = TOTAL_RE.exec(text);
    if (tt) {
      total = cents(tt[1]);
      skipped++;
      continue;
    }
    if (SKIP_RE.test(text)) {
      skipped++;
      continue;
    }
    const m = ITEM_RE.exec(text);
    if (m && /\d/.test(m.groups!.code!)) {
      const it = newItem(++n, raw, m.groups!.name!);
      const fixed = fixDigits(m.groups!.code!);
      const digits = fixed.value.replace(/\D/g, '');
      it.code = digits.length ? digits.padStart(12, '0') : null;
      if (fixed.fixed) it.issues.push('code had letters that look like digits; please check it');
      if (digits.length !== 12 && digits.length !== 0) it.issues.push(`code has ${digits.length} digits (Walmart prints 12)`);
      it.isPlu = it.code != null && isPlu(it.code);
      // glued letter: F or a tax flag right after the code ("005113119187H")
      const glued = m.groups!.glued;
      if (glued === 'F' || m.groups!.f) it.snapEligible = true;
      else if (glued) it.taxFlag = glued;
      it.priceCents = cents(m.groups!.price);
      if (m.groups!.tax) it.taxFlag = m.groups!.tax;
      items.push(it);
      seenItems = true;
      continue;
    }
    // header lines (before any item)
    if (!seenItems) {
      if (!header.street && STREET_RE.test(text)) {
        header.street = text;
        continue;
      }
      const c = CITY_RE.exec(text);
      if (c && !header.city) {
        header.city = c[1]!.trim();
        header.state = c[2]!;
        header.zip = c[3] ?? null;
        continue;
      }
      if (/^\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}/.test(text)) {
        skipped++; // store phone
        continue;
      }
    }
    // numbers only (e.g. gift-card balance rows) can't be an item: no name
    if (!/[A-Za-z]{2,}/.test(text)) {
      skipped++;
      continue;
    }
    // looks like data (price or long digit run) but not understood: show it to the shopper
    if (/\d+[.,]\d{2}\b|\d{6,}/.test(fixDigits(text).value)) unparsed.push({ text: raw.text, confidence: raw.confidence });
    else skipped++;
  }

  for (const it of items) {
    if (it.priceCents == null) it.issues.push('no price read');
    if (it.code == null) it.issues.push('no item code read');
    it.needsLook = it.issues.length > 0 || (it.confidence != null && it.confidence < LOW_CONFIDENCE);
  }
  const itemsCents = items.reduce((s, i) => s + (i.priceCents ?? 0) - i.savingsCents, 0);
  return {
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

/** Count rows that need the shopper's attention ("x of y lines need a look"). */
export function needsLookCount(r: Pick<ParsedReceipt, 'items' | 'unparsed'>): { need: number; total: number } {
  return { need: r.items.filter((i) => i.needsLook).length + r.unparsed.length, total: r.items.length + r.unparsed.length };
}
