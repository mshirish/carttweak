/**
 * Receipt image -> parsed receipt, in the browser. Shared by the upload screen
 * and scripts/receipts-eval.ts (which imports this module in a headless page),
 * so the accuracy numbers measure exactly what shoppers get.
 *
 * One OCR pass per rotation tried gives both reconstructions: Tesseract's own
 * line text ("lines") and rows rebuilt from word boxes ("rows", deskewed and
 * split into side-by-side receipts). Both are parsed; the best parse score wins.
 */
import { parseReceiptBlocks, parseScore, rowsFromWords, type OcrLine, type OcrLineBox, type ParsedReceipt } from '@carttweak/shared';
import { DEFAULT_PREP, preprocess, recognizeBoxes, rotationCandidates, type OcrProgress, type Prep } from './ocr.ts';

export interface PipelineResult {
  parsed: ParsedReceipt;
  /** quarter turns used */
  rotation: number;
  /** which reconstruction won */
  path: 'lines' | 'rows';
  /** skew corrected on the rows path, degrees */
  skew: number;
  score: number;
  /** every candidate tried: rotation, path, score (no text) */
  tried: Array<{ rotation: number; path: 'lines' | 'rows'; score: number }>;
  /** opts.keepOcr only (local eval): raw OCR per rotation tried */
  ocr?: Array<{ rotation: number; lines: OcrLine[]; boxes: OcrLineBox[] }>;
}

export async function readReceiptImage(
  img: HTMLImageElement | ImageBitmap,
  opts: { prep?: Prep; autoRotate?: boolean; keepOcr?: boolean; onProgress?: (p: OcrProgress) => void } = {},
): Promise<PipelineResult> {
  const onProgress = opts.onProgress ?? (() => {});
  const prep = opts.prep ?? DEFAULT_PREP;
  const rotations = opts.autoRotate === false ? [prep.rotation] : await rotationCandidates(img, prep, onProgress).catch(() => [prep.rotation]);
  let best: PipelineResult | null = null;
  const tried: PipelineResult['tried'] = [];
  const ocr: NonNullable<PipelineResult['ocr']> = [];
  for (const rotation of rotations) {
    const { lines, boxes } = await recognizeBoxes(preprocess(img, { ...prep, rotation }, document.createElement('canvas')), onProgress);
    if (opts.keepOcr) ocr.push({ rotation, lines, boxes });
    const rows = rowsFromWords(boxes);
    const cands: Array<Omit<PipelineResult, 'tried'>> = [
      { parsed: parseReceiptBlocks([lines]), rotation, path: 'lines', skew: 0, score: 0 },
      { parsed: parseReceiptBlocks(rows.blocks), rotation, path: 'rows', skew: rows.angle, score: 0 },
    ];
    for (const c of cands) {
      c.score = parseScore(c.parsed);
      tried.push({ rotation, path: c.path, score: Math.round(c.score) });
      if (!best || c.score > best.score) best = { ...c, tried };
    }
  }
  return opts.keepOcr ? { ...best!, ocr } : best!;
}
