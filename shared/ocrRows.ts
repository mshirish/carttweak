/**
 * Rebuild receipt rows from OCR word boxes. Tesseract often reads a receipt's
 * price column as a separate block, splitting "NAME CODE F" from "6.22 X".
 * Grouping words by their vertical centre puts each printed row back together.
 * Pure; used by the browser OCR worker and the local accuracy script.
 */
import type { OcrLine } from './receipt.ts';

export interface OcrWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export function rowsFromWords(words: OcrWord[]): OcrLine[] {
  const ws = words.filter((w) => w.text.trim() && w.bbox.y1 > w.bbox.y0);
  if (!ws.length) return [];
  const heights = ws.map((w) => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)]!;
  const tol = Math.max(2, medianH * 0.5);
  const sorted = [...ws].sort((a, b) => (a.bbox.y0 + a.bbox.y1) / 2 - (b.bbox.y0 + b.bbox.y1) / 2);
  const rows: Array<{ cy: number; words: OcrWord[] }> = [];
  for (const w of sorted) {
    const cy = (w.bbox.y0 + w.bbox.y1) / 2;
    const row = rows.find((r) => Math.abs(r.cy - cy) <= tol);
    if (row) {
      row.words.push(w);
      row.cy = (row.cy * (row.words.length - 1) + cy) / row.words.length;
    } else rows.push({ cy, words: [w] });
  }
  rows.sort((a, b) => a.cy - b.cy);
  return rows.map((r) => {
    const line = r.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    // keep wide gaps visible (column breaks) as two spaces
    let text = '';
    let prevX1: number | null = null;
    for (const w of line) {
      if (prevX1 != null) text += w.bbox.x0 - prevX1 > medianH * 1.2 ? '  ' : ' ';
      text += w.text;
      prevX1 = w.bbox.x1;
    }
    return { text, confidence: Math.round(Math.min(...line.map((w) => w.confidence))) };
  });
}
