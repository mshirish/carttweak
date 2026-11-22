/**
 * Receipt image -> parsed receipt, in the browser. Shared by the upload screen
 * and scripts/receipts-eval.ts (which imports this module in a headless page),
 * so the accuracy numbers measure exactly what shoppers get.
 *
 * Each OCR pass gives two reconstructions: Tesseract's own line text ("lines")
 * and rows rebuilt from word boxes ("rows": deskewed, background trimmed,
 * side-by-side receipts split). Passes: each plausible rotation, plus a zoomed
 * re-read of the receipt's text band when it fills only part of the photo.
 * Every candidate is parsed; the best parse score (the receipt's own numbers
 * first) wins.
 */
import { parseReceiptBlocks, parseScore, rowsFromWords, textBounds, type OcrLine, type OcrLineBox, type ParsedReceipt } from '@carttweak/shared';
import { DEFAULT_PREP, preprocess, recognizeBoxes, rotationCandidates, type OcrProgress, type Prep } from './ocr.ts';

export type PipelinePath = 'lines' | 'rows' | 'zoom-lines' | 'zoom-rows';

export interface PipelineResult {
  parsed: ParsedReceipt;
  /** quarter turns used */
  rotation: number;
  /** which reconstruction won */
  path: PipelinePath;
  /** skew corrected on the rows path, degrees */
  skew: number;
  score: number;
  /** every candidate tried: rotation, path, score (no text) */
  tried: Array<{ rotation: number; path: PipelinePath; score: number }>;
  /** opts.keepOcr only (local eval): raw OCR per pass */
  ocr?: Array<{ rotation: number; zoom: boolean; lines: OcrLine[]; boxes: OcrLineBox[] }>;
}

/** Crop a canvas to a box and scale it so the text is read larger. */
function zoomCanvas(src: HTMLCanvasElement, b: { x0: number; y0: number; x1: number; y1: number }): HTMLCanvasElement {
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  const k = Math.min(3, Math.max(1, 1800 / w));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, b.x0, b.y0, w, h, 0, 0, c.width, c.height);
  return c;
}

export async function readReceiptImage(
  img: HTMLImageElement | ImageBitmap,
  opts: { prep?: Prep; autoRotate?: boolean; keepOcr?: boolean; onProgress?: (p: OcrProgress) => void } = {},
): Promise<PipelineResult> {
  const onProgress = opts.onProgress ?? (() => {});
  const prep = opts.prep ?? DEFAULT_PREP;
  const rotations = opts.autoRotate === false ? [prep.rotation] : await rotationCandidates(img, prep, onProgress).catch(() => [prep.rotation]);
  let best: Omit<PipelineResult, 'tried' | 'ocr'> | null = null;
  const tried: PipelineResult['tried'] = [];
  const ocr: NonNullable<PipelineResult['ocr']> = [];
  const consider = (rotation: number, zoom: boolean, lines: OcrLine[], boxes: OcrLineBox[]) => {
    if (opts.keepOcr) ocr.push({ rotation, zoom, lines, boxes });
    const rows = rowsFromWords(boxes);
    const cands = [
      { parsed: parseReceiptBlocks([lines]), path: (zoom ? 'zoom-lines' : 'lines') as PipelinePath, skew: 0 },
      { parsed: parseReceiptBlocks(rows.blocks), path: (zoom ? 'zoom-rows' : 'rows') as PipelinePath, skew: rows.angle },
    ];
    for (const c of cands) {
      const score = parseScore(c.parsed);
      tried.push({ rotation, path: c.path, score: Math.round(score) });
      if (!best || score > best.score) best = { ...c, rotation, score };
    }
  };
  for (const rotation of rotations) {
    const canvas = preprocess(img, { ...prep, rotation }, document.createElement('canvas'));
    const first = await recognizeBoxes(canvas, onProgress);
    consider(rotation, false, first.lines, first.boxes);
    const blocks = rowsFromWords(first.boxes).bounds;
    if (blocks.length > 1) {
      // several receipts side by side: zoom into each one and read it on its own
      const zl: OcrLine[][] = [];
      const zr: OcrLine[][] = [];
      for (const b of blocks) {
        const clip = { ...b, x1: Math.min(canvas.width, b.x1), y1: Math.min(canvas.height, b.y1) };
        const z = await recognizeBoxes(zoomCanvas(canvas, clip), onProgress);
        if (opts.keepOcr) ocr.push({ rotation, zoom: true, lines: z.lines, boxes: z.boxes });
        zl.push(z.lines);
        zr.push(...rowsFromWords(z.boxes).blocks);
      }
      for (const [path, parsed] of [['zoom-lines', parseReceiptBlocks(zl)], ['zoom-rows', parseReceiptBlocks(zr)]] as const) {
        const score = parseScore(parsed);
        tried.push({ rotation, path, score: Math.round(score) });
        if (!best || score > best.score) best = { parsed, path, skew: 0, rotation, score };
      }
    } else {
      const b = textBounds(first.boxes, canvas.width, canvas.height);
      if (b) {
        const z = await recognizeBoxes(zoomCanvas(canvas, b), onProgress);
        consider(rotation, true, z.lines, z.boxes);
      }
    }
  }
  const out: PipelineResult = { ...best!, tried };
  return opts.keepOcr ? { ...out, ocr } : out;
}
