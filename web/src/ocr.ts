/**
 * Receipt OCR in the browser. The image never leaves the device: it is
 * preprocessed on a canvas and read by tesseract.js, which runs in its own Web
 * Worker. Only the parsed item lines are sent to the server later.
 * (tesseract.js downloads its worker, wasm core and English model on first use;
 * those downloads carry no image data.)
 */
import type { OcrLine, OcrLineBox } from '@carttweak/shared';

export interface Prep {
  /** quarter turns clockwise: 0..3 */
  rotation: number;
  /** 0.5 .. 2.5 */
  contrast: number;
  /** black & white (automatic Otsu threshold) */
  threshold: boolean;
  /** crop margins in percent of the rotated image */
  crop: { top: number; bottom: number; left: number; right: number };
}

export const DEFAULT_PREP: Prep = { rotation: 0, contrast: 1.3, threshold: false, crop: { top: 0, bottom: 0, left: 0, right: 0 } };

/** Small receipts OCR badly (a 300 px wide photo read 0 of 4 lines); upscale to at least this width. */
export const MIN_OCR_WIDTH = 1400;

/** Upscale factor: images under 1000 px wide get at least 2x; everything is brought up to MIN_OCR_WIDTH. */
export function ocrScale(width: number): number {
  if (width < 1000) return Math.max(2, MIN_OCR_WIDTH / width);
  return width < MIN_OCR_WIDTH ? MIN_OCR_WIDTH / width : 1;
}

/**
 * How "receipt-like" a quick OCR pass reads: confident lines that carry both a
 * word and a price count most. Text read sideways or upside down scores near 0.
 */
export function rotationScore(lines: OcrLine[]): number {
  let s = 0;
  for (const l of lines) {
    const c = (l.confidence ?? 0) / 100;
    const words = (l.text.match(/[A-Za-z]{3,}/g) ?? []).length;
    const price = /\d+[.,]\d{2}\b/.test(l.text) ? 1 : 0;
    s += c * c * (Math.min(words, 4) + 3 * price * (words ? 1 : 0));
  }
  return s;
}

/** Rotations worth trying: a tall photo is upright or upside down; a wide one is on its side. */
export function rotationsToTry(w: number, h: number): number[] {
  if (h > w * 1.2) return [0, 2];
  if (w > h * 1.2) return [1, 3];
  return [0, 1, 2, 3];
}

/**
 * Best of the candidate quarter turns, by a fast OCR pass on a small copy.
 * Returns the rotation with the highest rotationScore (ties keep the first).
 */
export async function autoRotation(img: HTMLImageElement | ImageBitmap, prep: Prep, onProgress: (p: OcrProgress) => void): Promise<number> {
  return (await rotationCandidates(img, prep, onProgress))[0]!;
}

/** Quick-pass scores for each plausible quarter turn, best first. */
export async function rotationScores(img: HTMLImageElement | ImageBitmap, prep: Prep, onProgress: (p: OcrProgress) => void): Promise<Array<{ rotation: number; score: number }>> {
  const tries = rotationsToTry(img.width, img.height);
  const { createWorker, PSM } = await import('tesseract.js');
  const worker = await createWorker('eng', 1);
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK } as any);
    const out: Array<{ rotation: number; score: number }> = [];
    for (const [i, r] of tries.entries()) {
      onProgress({ status: 'finding which way is up', progress: i / tries.length });
      const full = preprocess(img, { ...prep, rotation: r });
      const small = document.createElement('canvas');
      const k = Math.min(1, 900 / full.width);
      small.width = Math.round(full.width * k);
      small.height = Math.round(full.height * k);
      small.getContext('2d')!.drawImage(full, 0, 0, small.width, small.height);
      const { data } = await worker.recognize(small);
      const lines: OcrLine[] = ((data as any).lines ?? []).map((l: any) => ({ text: String(l.text), confidence: Math.round(l.confidence) }));
      out.push({ rotation: r, score: rotationScore(lines) });
    }
    // stable: ties keep the first tried
    return out.map((x, i) => ({ ...x, i })).sort((x, y) => y.score - x.score || x.i - y.i).map(({ rotation, score }) => ({ rotation, score }));
  } finally {
    await worker.terminate();
  }
}

/** The best rotation, plus the runner-up when it scored close (both then get a full read; the parse decides). */
export async function rotationCandidates(img: HTMLImageElement | ImageBitmap, prep: Prep, onProgress: (p: OcrProgress) => void): Promise<number[]> {
  const s = await rotationScores(img, prep, onProgress);
  return s.filter((x, i) => i === 0 || (i === 1 && x.score >= s[0]!.score * 0.6)).map((x) => x.rotation);
}

export function otsu(gray: Uint8ClampedArray | number[]): number {
  const hist = new Array(256).fill(0);
  for (const g of gray) hist[g]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/** Draw the image rotated, cropped, upscaled, grayscale, contrast-adjusted (and optionally thresholded). */
export function preprocess(img: HTMLImageElement | ImageBitmap, prep: Prep, canvas: HTMLCanvasElement = document.createElement('canvas')): HTMLCanvasElement {
  const w0 = img.width;
  const h0 = img.height;
  const rot = ((prep.rotation % 4) + 4) % 4;
  const rw = rot % 2 ? h0 : w0;
  const rh = rot % 2 ? w0 : h0;
  // rotate onto a temp canvas
  const tmp = document.createElement('canvas');
  tmp.width = rw;
  tmp.height = rh;
  const t = tmp.getContext('2d')!;
  t.translate(rw / 2, rh / 2);
  t.rotate((rot * Math.PI) / 2);
  t.drawImage(img, -w0 / 2, -h0 / 2);
  // crop
  const cx = Math.round((rw * prep.crop.left) / 100);
  const cy = Math.round((rh * prep.crop.top) / 100);
  const cw = Math.max(1, Math.round(rw * (1 - (prep.crop.left + prep.crop.right) / 100)));
  const ch = Math.max(1, Math.round(rh * (1 - (prep.crop.top + prep.crop.bottom) / 100)));
  const scale = ocrScale(cw);
  canvas.width = Math.round(cw * scale);
  canvas.height = Math.round(ch * scale);
  const c = canvas.getContext('2d', { willReadFrequently: true })!;
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.drawImage(tmp, cx, cy, cw, ch, 0, 0, canvas.width, canvas.height);
  const data = c.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  const gray = new Uint8ClampedArray(px.length / 4);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const g = 0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!;
    gray[j] = Math.max(0, Math.min(255, (g - 128) * prep.contrast + 128));
  }
  const th = prep.threshold ? otsu(gray) : -1;
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const v = th >= 0 ? (gray[j]! > th ? 255 : 0) : gray[j]!;
    px[i] = px[i + 1] = px[i + 2] = v;
    px[i + 3] = 255;
  }
  c.putImageData(data, 0, 0);
  return canvas;
}

export interface OcrProgress {
  status: string;
  progress: number;
}

/** OCR lines with per-line confidence. PSM 6 (one uniform block) keeps each printed row together. */
export async function recognize(canvas: HTMLCanvasElement, onProgress: (p: OcrProgress) => void): Promise<OcrLine[]> {
  return (await recognizeBoxes(canvas, onProgress)).lines;
}

/** Line text plus word boxes and baselines (for row reconstruction, see shared/receiptRows.ts). */
export async function recognizeBoxes(canvas: HTMLCanvasElement, onProgress: (p: OcrProgress) => void): Promise<{ lines: OcrLine[]; boxes: OcrLineBox[] }> {
  const { createWorker, PSM } = await import('tesseract.js');
  const worker = await createWorker('eng', 1, {
    logger: (m: { status: string; progress: number }) => onProgress({ status: m.status, progress: m.progress ?? 0 }),
  });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: '1' } as any);
    const { data } = await worker.recognize(canvas);
    const raw: any[] = (data as any).lines ?? [];
    const lines: OcrLine[] = raw.map((l: any) => ({ text: String(l.text).replace(/\n$/, ''), confidence: Math.round(l.confidence) }));
    const boxes: OcrLineBox[] = raw.map((l: any) => ({
      baseline: l.baseline ? { x0: l.baseline.x0, y0: l.baseline.y0, x1: l.baseline.x1, y1: l.baseline.y1 } : null,
      words: (l.words ?? []).map((w: any) => ({ text: String(w.text), confidence: Math.round(w.confidence), x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 })),
    }));
    // dev server only: keep the last OCR lines in this page's memory for local debugging (never sent anywhere)
    if ((import.meta as any).env?.DEV) (window as any).__carttweakLastOcr = lines;
    return { lines, boxes };
  } finally {
    await worker.terminate();
  }
}
