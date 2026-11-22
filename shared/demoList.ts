/**
 * docs/demo-list.txt format:  qty | item as typed | [tags] | why
 * Lines starting with # are comments. Pure parser (no I/O).
 */
export interface DemoItem {
  id: string;
  quantity: number;
  query: string;
  tags: string[];
  why: string;
}

export interface DemoList {
  items: DemoItem[];
  /** "(locationId 01400513)" in the header, if present */
  headerLocationId: string | null;
  /** header comment lines, without the leading "# " */
  header: string[];
}

export function parseDemoList(text: string): DemoList {
  const header: string[] = [];
  const items: DemoItem[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) {
      header.push(t.replace(/^#\s?/, ''));
      continue;
    }
    if (!t.includes('|')) continue;
    const [qty, query, tags, why] = t.split('|').map((s) => s.trim());
    if (!query) continue;
    items.push({
      id: `i${String(items.length + 1).padStart(2, '0')}`,
      quantity: Math.max(1, Number.parseInt(qty ?? '1', 10) || 1),
      query,
      tags: [...(tags ?? '').matchAll(/\[(\w+)\]/g)].map((m) => m[1]!),
      why: why ?? '',
    });
  }
  const headerLocationId = /locationId\s+([A-Za-z0-9]{8})/.exec(header.join('\n'))?.[1] ?? null;
  return { items, headerLocationId, header };
}

/**
 * Shopper's free-text list: one item per line, optional quantity prefix
 * ("2 bananas", "2x bananas", "2 x bananas"). A number that is part of a size
 * ("16 oz peanut butter") is NOT treated as a quantity.
 */
export function parseShoppingList(text: string): Array<{ quantity: number; query: string }> {
  const out: Array<{ quantity: number; query: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^[-*•]\s*/, '').trim();
    if (!line) continue;
    const m = /^(\d{1,2})\s*(?:x\s+|x(?=\D)|\s+)(.+)$/i.exec(line);
    const isSize = m && /^(oz|fl\.?\s*oz|lb|lbs|g|kg|ml|l|ct|pk|pack|gal|qt|pt|%)\b/i.test(m[2]!.trim());
    if (m && !isSize && Number(m[1]) > 0) out.push({ quantity: Number(m[1]), query: m[2]!.trim() });
    else out.push({ quantity: 1, query: line });
  }
  return out;
}
