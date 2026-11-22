/**
 * Receipt image -> parsed receipt, in the browser. Shared by the upload screen
 * and scripts/receipts-eval.ts (which imports this module in a headless page),
 * so the accuracy numbers measure exactly what shoppers get.
 */
import { parseReceipt, type ParsedReceipt } from '@carttweak/shared';
import { autoRotation, DEFAULT_PREP, preprocess, recognize, type OcrProgress, type Prep } from './ocr.ts';

export interface PipelineResult {
  parsed: ParsedReceipt;
  /** quarter turns used */
  rotation: number;
  /** which reconstruction won */
  path: 'lines';
}

export async function readReceiptImage(
  img: HTMLImageElement | ImageBitmap,
  opts: { prep?: Prep; autoRotate?: boolean; onProgress?: (p: OcrProgress) => void } = {},
): Promise<PipelineResult> {
  const onProgress = opts.onProgress ?? (() => {});
  let prep = opts.prep ?? DEFAULT_PREP;
  if (opts.autoRotate !== false) {
    const r = await autoRotation(img, prep, onProgress).catch(() => prep.rotation);
    prep = { ...prep, rotation: r };
  }
  const lines = await recognize(preprocess(img, prep, document.createElement('canvas')), onProgress);
  return { parsed: parseReceipt(lines), rotation: prep.rotation, path: 'lines' };
}
