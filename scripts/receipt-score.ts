/**
 * Score a parsed receipt against hand-typed ground truth. Pure; returns counts
 * only so callers can print results without item names.
 */
export interface TruthItem {
  name: string;
  qty?: number;
  weightLb?: number;
  priceCents: number;
  savingsCents?: number;
}
export interface TruthReceipt {
  store: string | null;
  zip: string | null;
  date: string | null;
  items: TruthItem[];
  subtotalCents?: number;
  taxCents?: number;
  totalCents?: number;
  itemsSold?: number;
}
interface ParsedLike {
  header: { store: string | null; zip: string | null; date: string | null };
  items: Array<{ name: string; priceCents: number | null }>;
}

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

export function lev(a: string, b: string): number {
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

export function similarity(a: string, b: string): number {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  return 1 - lev(x, y) / Math.max(x.length, y.length);
}

export interface ReceiptScore {
  items: number;
  itemsCorrect: number;
  pricesCorrect: number;
  falseItems: number;
  header: number;
  headerCorrect: number;
}

/** Items match by name similarity >= 0.7 (greedy, in order); prices compared on matched pairs. */
export function scoreReceipt(p: ParsedLike, t: TruthReceipt): ReceiptScore {
  const used = new Set<number>();
  let itemsCorrect = 0;
  let pricesCorrect = 0;
  for (const ti of t.items) {
    let best = -1;
    let bestSim = 0.7;
    p.items.forEach((pi, k) => {
      if (used.has(k)) return;
      const s = similarity(pi.name, ti.name) + (pi.priceCents === ti.priceCents ? 0.05 : 0);
      if (s >= bestSim) {
        bestSim = s;
        best = k;
      }
    });
    if (best >= 0) {
      used.add(best);
      itemsCorrect++;
      if (p.items[best]!.priceCents === ti.priceCents) pricesCorrect++;
    }
  }
  const headerCorrect =
    Number(t.store == null ? p.header.store == null : !!p.header.store && similarity(p.header.store, t.store) >= 0.8) +
    Number((p.header.zip ?? null) === t.zip) +
    Number((p.header.date ?? null) === t.date);
  return { items: t.items.length, itemsCorrect, pricesCorrect, falseItems: p.items.length - used.size, header: 3, headerCorrect };
}
