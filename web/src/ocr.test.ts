import { describe, expect, it } from 'vitest';
import { MIN_OCR_WIDTH, ocrScale, otsu, rotationScore, rotationsToTry } from './ocr.ts';

describe('OCR prep', () => {
  it('images under 1000 px are upscaled at least 2x; wider ones up to MIN_OCR_WIDTH; big ones untouched', () => {
    expect(ocrScale(900)).toBe(2);
    expect(ocrScale(300)).toBeCloseTo(MIN_OCR_WIDTH / 300);
    expect(ocrScale(1200)).toBeCloseTo(MIN_OCR_WIDTH / 1200);
    expect(ocrScale(3000)).toBe(1);
  });
  it('rotation candidates follow the photo shape', () => {
    expect(rotationsToTry(1000, 3000)).toEqual([0, 2]);
    expect(rotationsToTry(3000, 1000)).toEqual([1, 3]);
    expect(rotationsToTry(1000, 1000)).toEqual([0, 1, 2, 3]);
  });
  it('upright receipt text outscores sideways garbage (synthetic lines)', () => {
    const upright = [
      { text: 'SAMPLE OATS 3.48 F', confidence: 90 },
      { text: 'SAMPLE JAM 2.18 F', confidence: 85 },
    ];
    const garbage = [
      { text: "l1' ,:. |I ;", confidence: 30 },
      { text: 'ouo 81.Z', confidence: 25 },
    ];
    expect(rotationScore(upright)).toBeGreaterThan(rotationScore(garbage) * 5);
  });
  it('otsu splits two clusters', () => {
    const t = otsu([10, 12, 11, 200, 210, 205]);
    expect(t).toBeGreaterThanOrEqual(12);
    expect(t).toBeLessThan(200);
  });
});
