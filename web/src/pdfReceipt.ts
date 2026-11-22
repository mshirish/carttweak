/**
 * PDF receipts, in the browser (the file never leaves the device).
 * With a text layer (a receipt saved or emailed as PDF): read the text
 * directly, no OCR. Without one (a scan): render page 1 and OCR it like a photo.
 */
import { parseReceipt, rowsFromPdfText, type ParsedReceipt } from '@carttweak/shared';
import type { OcrProgress } from './ocr.ts';
import { readReceiptImage, type PipelineResult } from './receiptPipeline.ts';

export async function readReceiptPdf(file: Blob, onProgress: (p: OcrProgress) => void = () => {}): Promise<{ parsed: ParsedReceipt; via: 'pdf-text' | 'pdf-ocr'; pipeline?: PipelineResult }> {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  onProgress({ status: 'opening the PDF', progress: 0 });
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  try {
    // text layer: every page (digital receipts can run long)
    const rows = [];
    for (let p = 1; p <= Math.min(doc.numPages, 5); p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items = (tc.items as any[])
        .filter((i) => typeof i.str === 'string')
        .map((i) => ({ str: i.str as string, x: i.transform[4] as number, y: i.transform[5] as number, w: i.width as number, h: (i.height as number) || Math.abs(i.transform[3] as number) }));
      rows.push(...rowsFromPdfText(items, vp.height));
    }
    const parsed = parseReceipt(rows);
    if (rows.length >= 3 && (parsed.items.length || parsed.totalCents != null)) return { parsed, via: 'pdf-text' };
    // no usable text layer: render page 1 and read it like a photo
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 2.5 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp }).promise;
    const pipeline = await readReceiptImage(await createImageBitmap(canvas), { onProgress });
    return { parsed: pipeline.parsed, via: 'pdf-ocr', pipeline };
  } finally {
    await doc.destroy();
  }
}
