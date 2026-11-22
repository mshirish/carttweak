import { describe, expect, it } from 'vitest';
import { parseMoney, rightmostMoney, rowsFromWords, skewAngle, type OcrLineBox, type WordBox } from './receiptRows.ts';

// SYNTHETIC word boxes: 10 px per character, rows 30 px apart.
function row(y: number, parts: Array<[number, string]>, dyPerPx = 0): WordBox[] {
  return parts.flatMap(([x, s]) =>
    s.split(' ').reduce<{ x: number; out: WordBox[] }>(
      (acc, w) => {
        const x0 = acc.x;
        const x1 = x0 + w.length * 10;
        const dy = x0 * dyPerPx;
        acc.out.push({ text: w, confidence: 90, x0, x1, y0: y + dy, y1: y + 20 + dy });
        acc.x = x1 + 10;
        return acc;
      },
      { x, out: [] },
    ).out,
  );
}

describe('money tokens', () => {
  it('accepts $, minus, trailing minus and parentheses; fixes O/l/S inside numbers only', () => {
    expect(parseMoney('$1.42')).toMatchObject({ cents: 142, negative: false });
    expect(parseMoney('-$2.00')).toMatchObject({ cents: 200, negative: true });
    expect(parseMoney('2.00-')).toMatchObject({ cents: 200, negative: true });
    expect(parseMoney('(2.00)')).toMatchObject({ cents: 200, negative: true });
    expect(parseMoney('1.S9')).toMatchObject({ cents: 159, fixed: true });
    expect(parseMoney('O.99')).toMatchObject({ cents: 99, fixed: true });
    expect(parseMoney('SO.OS')).toBeNull(); // fewer than two real digits: not a number
    expect(rightmostMoney('SAMPLE 2 @ 2.69    5.38 F')).toMatchObject({ cents: 538 });
  });
});

describe('rows from word boxes', () => {
  it('rejoins a name and a far-right price into one row, keeping the column gap', () => {
    const lines: OcrLineBox[] = [
      { words: row(0, [[0, 'SAMPLE OATS']]) },
      { words: row(2, [[400, '3.48 F']]) },
      { words: row(30, [[0, 'SAMPLE JAM'], [400, '2.18 F']]) },
    ];
    const { blocks } = rowsFromWords(lines);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.map((r) => r.text)).toEqual(['SAMPLE OATS    3.48 F', 'SAMPLE JAM    2.18 F']);
  });
  it('deskews a tilted photo before grouping', () => {
    const tilt = 0.1; // 10 px down per 100 px right: price would land on the next row
    const words = [...row(0, [[0, 'SAMPLE OATS'], [400, '3.48 F']], tilt), ...row(30, [[0, 'SAMPLE JAM'], [400, '2.18 F']], tilt)];
    const baseline = { x0: 0, y0: 20, x1: 460, y1: 20 + 46 };
    const lines: OcrLineBox[] = [{ baseline, words: words.slice(0, 4) }, { baseline: { ...baseline, y0: 50, y1: 96 }, words: words.slice(4) }];
    expect(skewAngle(lines)).toBeCloseTo(5.7, 0);
    expect(rowsFromWords(lines).blocks[0]!.map((r) => r.text)).toEqual(['SAMPLE OATS    3.48 F', 'SAMPLE JAM    2.18 F']);
  });
  it('two receipts side by side become two blocks; a price-only column stays with its receipt', () => {
    const left = [...row(0, [[0, 'SAMPLE OATS'], [300, '3.48 F']]), ...row(30, [[0, 'SAMPLE BALANCE'], [300, '3.48']])];
    const right = [...row(0, [[800, 'SAMPLE JAM'], [1100, '2.18 F']]), ...row(30, [[800, 'SAMPLE BALANCE'], [1100, '2.18']])];
    const { blocks } = rowsFromWords([{ words: [...left, ...right] }]);
    expect(blocks.map((b) => b.map((r) => r.text))).toEqual([
      ['SAMPLE OATS    3.48 F', 'SAMPLE BALANCE    3.48'],
      ['SAMPLE JAM    2.18 F', 'SAMPLE BALANCE    2.18'],
    ]);
  });
  it('background junk with no prices is dropped', () => {
    const { blocks } = rowsFromWords([{ words: [...row(0, [[0, 'SAMPLE OATS 3.48 F']]), ...row(0, [[900, 'junk words here']])] }]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]![0]!.text).toBe('SAMPLE OATS 3.48 F');
  });
});
