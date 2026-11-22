/**
 * Receipt rows from OCR word boxes. Pure.
 *
 * Tesseract's own line text breaks a printed row in two when the photo is
 * skewed or the price column is far from the name (handheld photos, wide
 * receipts). Here rows are rebuilt from word boxes instead:
 *   1. estimate skew from the text-line baselines and rotate word centres back;
 *   2. split the page into separate columns where an empty vertical band runs
 *      the full height (two receipts side by side, background junk);
 *   3. group words into rows by vertical-centre overlap (tolerance from the
 *      median word height), order left to right, and keep wide gaps as 4 spaces
 *      so column structure survives into the parser.
 */
import type { OcrLine } from './receipt.ts';

export interface WordBox {
  text: string;
  confidence: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrLineBox {
  /** text-line baseline from the OCR engine, used for the skew estimate */
  baseline?: { x0: number; y0: number; x1: number; y1: number } | null;
  words: WordBox[];
}

// ---------- money ----------
const NUM_FIX: Record<string, string> = { O: '0', o: '0', Q: '0', D: '0', l: '1', I: '1', '|': '1', S: '5', s: '5' };
/** A money-looking token: "$1.42", "1.42", "-$2.00", "-2.00", "2.00-", "(2.00)". */
export const MONEY_TOKEN = /(?<![\w.])(\(?-?\$?\s?[0-9OoQDlI|Ss]{1,4}[.,][0-9OoQDlI|Ss]{2}\)?-?)(?![\w.])/g;

/**
 * Parse a money token. OCR fixes (O->0, l/I->1, S->5) apply inside the number
 * only, and only when the token already has at least two real digits.
 */
export function parseMoney(tok: string): { cents: number; negative: boolean; fixed: boolean } | null {
  const t = tok.trim();
  const negative = /^\(.*\)$/.test(t) || /^-/.test(t) || /-$/.test(t);
  const body = t.replace(/^[(\-]+|[)\-]+$/g, '').replace(/^\$\s?/, '').replace(/^-/, '');
  if (!/^[0-9OoQDlI|Ss]{1,4}[.,][0-9OoQDlI|Ss]{2}$/.test(body)) return null;
  if ((body.match(/\d/g) ?? []).length < 2) return null;
  let fixed = false;
  const v = [...body].map((c) => (/\d|[.,]/.test(c) ? c : ((fixed = true), NUM_FIX[c] ?? c))).join('');
  const m = /^(\d+)[.,](\d{2})$/.exec(v);
  if (!m) return null;
  return { cents: Number(m[1]) * 100 + Number(m[2]), negative, fixed };
}

/** The rightmost money token in a row, with where it starts. */
export function rightmostMoney(text: string): { tok: string; index: number; cents: number; negative: boolean; fixed: boolean } | null {
  let best: { tok: string; index: number; cents: number; negative: boolean; fixed: boolean } | null = null;
  for (const m of text.matchAll(MONEY_TOKEN)) {
    const p = parseMoney(m[1]!);
    if (p) best = { tok: m[1]!, index: m.index!, ...p };
  }
  return best;
}

// ---------- geometry ----------
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const k = s.length >> 1;
  return s.length % 2 ? s[k]! : (s[k - 1]! + s[k]!) / 2;
};

/** Median baseline angle in degrees (positive = text drifts downward to the right). */
export function skewAngle(lines: OcrLineBox[]): number {
  const angles: number[] = [];
  for (const l of lines) {
    const b = l.baseline;
    if (!b || b.x1 - b.x0 < 80) continue;
    angles.push((Math.atan2(b.y1 - b.y0, b.x1 - b.x0) * 180) / Math.PI);
  }
  const a = median(angles.filter((x) => Math.abs(x) < 20));
  return Math.abs(a) < 0.3 ? 0 : a;
}

interface Placed extends WordBox {
  /** the word box as the OCR engine reported it (page coordinates) */
  orig: WordBox;
  cx: number;
  cy: number;
  h: number;
}

function place(words: WordBox[], angleDeg: number): Placed[] {
  const r = (-angleDeg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return words.map((w) => {
    const x = (w.x0 + w.x1) / 2;
    const y = (w.y0 + w.y1) / 2;
    const cx = x * cos - y * sin;
    const cy = x * sin + y * cos;
    const hw = (w.x1 - w.x0) / 2;
    return { ...w, orig: w, cx, cy, h: Math.max(1, w.y1 - w.y0), x0: cx - hw, x1: cx + hw };
  });
}

/** Split into side-by-side columns at vertical bands no word touches (min width: 2 median word heights). */
function splitColumns(ws: Placed[], minGap: number): Placed[][] {
  if (ws.length < 2) return [ws];
  const spans = ws.map((w) => [w.x0, w.x1] as const).sort((a, b) => a[0] - b[0]);
  const cuts: number[] = [];
  let reach = spans[0]![1];
  for (const [a, b] of spans.slice(1)) {
    if (a - reach >= minGap) cuts.push((a + reach) / 2);
    reach = Math.max(reach, b);
  }
  if (!cuts.length) return [ws];
  const groups: Placed[][] = Array.from({ length: cuts.length + 1 }, () => []);
  for (const w of ws) groups[cuts.filter((c) => w.cx > c).length]!.push(w);
  return groups.filter((g) => g.length);
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * q)))]!;
};

/**
 * Keep the receipt's own text band. A hand-held photo puts background words
 * (labels, packaging) on the same rows as the receipt. The receipt's left edge
 * is where its confident words start; its right edge is just past the price
 * column (room for a tax flag).
 */
export function cropToTextBand<T extends { x0: number; x1: number; confidence: number; text: string }>(ws: T[]): T[] {
  const good = ws.filter((w) => w.confidence >= 75 && /[A-Za-z0-9]{3}/.test(w.text));
  const money = ws.filter((w) => /\d[.,]\d{2}/.test(w.text) && w.confidence >= 60);
  if (good.length < 12 || money.length < 3) return ws;
  const charW = median(good.map((w) => (w.x1 - w.x0) / Math.max(1, w.text.length))) || 10;
  const left = quantile(good.map((w) => w.x0), 0.03) - charW * 3;
  const right = Math.max(quantile(money.map((w) => w.x1), 0.97), quantile(good.map((w) => w.x1), 0.97)) + charW * 4;
  return ws.filter((w) => (w.x0 + w.x1) / 2 >= left && (w.x0 + w.x1) / 2 <= right);
}

/**
 * Where the receipt's text sits on the page (canvas pixels), when it fills
 * well under the page width: worth cropping and reading again at a larger scale.
 */
export function textBounds(lines: OcrLineBox[], pageW: number, pageH: number): { x0: number; y0: number; x1: number; y1: number } | null {
  const words = lines.flatMap((l) => l.words).filter((w) => w.text.trim());
  const band = cropToTextBand(words);
  const good = band.filter((w) => w.confidence >= 60 && /[A-Za-z0-9]{2}/.test(w.text));
  if (good.length < 12) return null;
  const h = median(good.map((w) => w.y1 - w.y0)) || 10;
  const x0 = Math.max(0, quantile(good.map((w) => w.x0), 0.02) - h * 2);
  const x1 = Math.min(pageW, quantile(good.map((w) => w.x1), 0.98) + h * 3);
  const y0 = Math.max(0, Math.min(...good.map((w) => w.y0)) - h * 2);
  const y1 = Math.min(pageH, Math.max(...good.map((w) => w.y1)) + h * 2);
  if (x1 - x0 > pageW * 0.6) return null;
  return { x0, y0, x1, y1 };
}

function rowsOf(all: Placed[]): OcrLine[] {
  const ws = cropToTextBand(all);
  const h = median(ws.map((w) => w.h)) || 10;
  const sorted = [...ws].sort((a, b) => a.cy - b.cy);
  const rows: Array<{ cy: number; words: Placed[] }> = [];
  for (const w of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(w.cy - last.cy) <= h * 0.55) {
      last.words.push(w);
      last.cy = last.words.reduce((s, x) => s + x.cy, 0) / last.words.length;
    } else rows.push({ cy: w.cy, words: [w] });
  }
  return rows.map(({ words }) => {
    words.sort((a, b) => a.x0 - b.x0);
    const charW = median(words.map((w) => (w.x1 - w.x0) / Math.max(1, w.text.length))) || h * 0.6;
    let text = '';
    words.forEach((w, i) => {
      if (i) text += w.x0 - words[i - 1]!.x1 > charW * 2.2 ? '    ' : ' ';
      text += w.text;
    });
    const letters = words.reduce((s, w) => s + w.text.length, 0) || 1;
    const confidence = Math.round(words.reduce((s, w) => s + w.confidence * w.text.length, 0) / letters);
    return { text, confidence };
  });
}

/**
 * Rows from word boxes. Returns one block of rows per side-by-side column
 * (usually one), plus the skew angle that was corrected.
 */
/**
 * Text copied from a digital receipt (kroger.com or an email). Table cells
 * arrive tab-separated or one per line; put each printed row back together,
 * keeping columns as wide gaps.
 */
export function normalizePastedText(text: string): OcrLine[] {
  const out: string[] = [];
  const cellOnly = /^\s*(?:\(?-?\$?\s?\d+[.,]\d{2}\)?-?|\d+(?:[.,]\d+)?\s*(?:lbs?|oz|ct|ea)?)\s*$/i;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\t+/g, '    ').replace(/ /g, ' ').trimEnd();
    if (!line.trim()) continue;
    const prev = out[out.length - 1];
    // a lone qty or price cell belongs to the row above (unless that row already ends in a price)
    if (prev != null && cellOnly.test(line) && !/\d[.,]\d{2}\)?-?\s*$/.test(prev)) out[out.length - 1] = `${prev}    ${line.trim()}`;
    else out.push(line);
  }
  return out.map((t) => ({ text: t, confidence: null }));
}

/** Text items from a PDF text layer (x, y from the bottom, width, height) -> rows. */
export function rowsFromPdfText(items: Array<{ str: string; x: number; y: number; w: number; h: number }>, pageHeight: number): OcrLine[] {
  const words: WordBox[] = items
    .filter((i) => i.str.trim())
    .map((i) => ({ text: i.str.trim(), confidence: 100, x0: i.x, x1: i.x + Math.max(i.w, 1), y0: pageHeight - i.y - Math.max(i.h, 1), y1: pageHeight - i.y }));
  if (!words.length) return [];
  return rowsOf(place(words, 0)).map((r) => ({ ...r, confidence: null }));
}

export function rowsFromWords(lines: OcrLineBox[]): { blocks: OcrLine[][]; angle: number; bounds: Array<{ x0: number; y0: number; x1: number; y1: number }> } {
  const angle = skewAngle(lines);
  const words = lines.flatMap((l) => l.words).filter((w) => w.text.trim());
  if (!words.length) return { blocks: [], angle, bounds: [] };
  const placed = place(words, angle);
  const h = median(placed.map((w) => w.h)) || 10;
  const hasMoney = (g: Placed[]) => g.some((w) => /\d[.,]\d{2}/.test(w.text));
  const wordy = (g: Placed[]) => g.filter((w) => /[A-Za-z]{3}/.test(w.text)).length >= 3;
  const merged: Placed[][] = [];
  for (const g of splitColumns(placed, h * 2.5)) {
    // a price-only column belongs to the names on its left
    // (the names column may hold money itself: weight lines like "1.37 lb @ 2.29 /lb")
    if (!wordy(g) && hasMoney(g) && merged.length) merged[merged.length - 1]!.push(...g);
    else merged.push(g);
  }
  // background junk carries no prices
  const cols = merged.filter(hasMoney);
  const use = cols.length ? cols : [placed];
  const bounds = use.map((g) => {
    const o = g.map((w) => w.orig);
    return { x0: Math.max(0, Math.min(...o.map((w) => w.x0)) - h * 2), y0: Math.max(0, Math.min(...o.map((w) => w.y0)) - h * 2), x1: Math.max(...o.map((w) => w.x1)) + h * 3, y1: Math.max(...o.map((w) => w.y1)) + h * 2 };
  });
  return { blocks: use.map(rowsOf), angle, bounds };
}
