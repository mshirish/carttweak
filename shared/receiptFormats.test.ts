// SAMPLE data only: synthetic receipt text written for these tests (made-up store, items, numbers).
import { describe, expect, it } from 'vitest';
import { classifyRow, detectFormat, parseKrogerReceipt, parseReceiptDate, reconcile } from './receipt.ts';

const DIGITAL = `
Digital Receipt
Order # 1234567890
Kroger Store #100    Feb 3, 2026, 4:05 PM
100 Sample Avenue    VISA •••• 0000
Sampletown, OH 45000
Item    Qty    Price
Sample Whole Milk, 1 gal    1    $3.00
Sample Bananas    2.00 lb    $1.20
2.00 lb @ $0.60/lb
Sample Pasta, Penne, 16 oz    2    $2.00
Kroger Savings    -$0.50
Digital Coupon Savings    -$0.20
Subtotal    $5.50
Tax (8.00%)    $0.44
Total    $5.94
Fuel Points Earned: 10
Thank you for shopping at Kroger!
`;

describe('row classifier', () => {
  it('classifies the kinds of row a Kroger receipt prints', () => {
    const cases: Array<[string, string]> = [
      ['SAMPLE OATS    3.48 F', 'item'],
      ['2.41 lb @ 0.59 /lb', 'item_detail'],
      ['2 @ 2.69', 'item_detail'],
      ['1 @ 2/5.00', 'item_detail'],
      ['KROGER SAVINGS    0.50', 'savings'],
      ['Digital Coupon Savings    -$1.00', 'savings'],
      ['**** BALANCE    8.41', 'total'],
      ['**** BALANGE    8.41', 'total'],
      ['Subtotal    $19.25', 'total'],
      ['TAX    0.33', 'total'],
      ['TOTAL NUMBER OF ITEMS SOLD = 3', 'total'],
      ['CHANGE    0.00', 'payment'],
      ['CASH    10.00', 'payment'],
      ['VISA •••• 4242', 'sensitive'],
      ['REF#: 000000 TOTAL: 8.41', 'sensitive'],
      ['Order # 1234567890', 'sensitive'],
      ['Your cashier was SAMPLE', 'sensitive'],
      ['Fuel Points Earned: 20', 'marketing'],
      ['YOU COULD HAVE SAVED $1.25 MORE', 'marketing'],
      ['Sampletown Oh 45000', 'header'],
      ['555-010-0100', 'header'],
      ['Item    Qty    Price', 'header'],
    ];
    for (const [t, k] of cases) expect([t, classifyRow(t)]).toEqual([t, k]);
  });
  it('dates in several formats', () => {
    expect(parseReceiptDate('07/14/21 11:56am 562 512')).toEqual({ date: '2021-07-14', time: '11:56am' });
    expect(parseReceiptDate('Jan 14, 2025, 2:37 PM')).toEqual({ date: '2025-01-14', time: '2:37pm' });
    expect(parseReceiptDate('2025-01-14')).toEqual({ date: '2025-01-14', time: null });
  });
});

describe('digital Kroger receipt (synthetic)', () => {
  const r = parseKrogerReceipt(DIGITAL);
  it('is detected as digital', () => {
    expect(r.format).toBe('kroger_digital');
    expect(detectFormat([{ text: 'SAMPLE OATS 3.48 F', confidence: 90 }])).toBe('kroger_paper');
  });
  it('NAME | QTY | $PRICE; weight qty; detail line below attaches to the item above', () => {
    expect(r.items.map((i) => [i.name, i.quantity, i.priceCents, i.weightLb])).toEqual([
      ['Sample Whole Milk, 1 gal', 1, 300, null],
      ['Sample Bananas', 1, 120, 2],
      ['Sample Pasta, Penne, 16 oz', 2, 200, null],
    ]);
    expect(r.items[1]!.pricePerLbCents).toBe(60);
  });
  it('header: store number, street, city/state/ZIP, date; order number and card dropped', () => {
    expect(r.header).toMatchObject({ storeNumber: '100', store: '100 Sample Avenue    VISA •••• 0000'.split('    ')[0], zip: '45000', state: 'OH', date: '2026-02-03' });
    expect(JSON.stringify(r)).not.toContain('1234567890');
    expect(JSON.stringify(r)).not.toContain('•••• 0000');
  });
  it('savings with no clear item stay trip-level; items - savings = subtotal', () => {
    expect(r.tripSavingsCents).toBe(70);
    expect(r.check).toMatchObject({ itemsCents: 550, targetCents: 550, targetLabel: 'subtotal', matches: true });
    expect(r.items.some((i) => /savings|total|tax/i.test(i.name))).toBe(false);
  });
});

describe('several receipts in one photo (synthetic)', () => {
  it('two stacked receipts stay separate, never merged', () => {
    const text = `100 Sample Ave\nYour cashier was A\nSAMPLE OATS    3.00 F\nSAMPLE JAM    2.00 F\n**** BALANCE    5.00\nCASH    5.00\n100 Sample Ave\nYour cashier was B\n0.50 lb @ 0.80 /lb\nWT    SAMPLE YAMS    0.40 F\n**** BALANCE    0.40\n`;
    const r = parseKrogerReceipt(text);
    expect(r.receipts?.map((x) => [x.items.map((i) => i.name), x.totalCents, x.check.matches])).toEqual([
      [['SAMPLE OATS', 'SAMPLE JAM'], 500, true],
      [['SAMPLE YAMS'], 40, true],
    ]);
  });
});

describe('self-check against the receipt numbers', () => {
  it('paper prices already net of item savings: the check notices and does not subtract twice', () => {
    const items = [
      { priceCents: 349, savingsCents: 50, quantity: 1, weightLb: null },
      { priceCents: 99, savingsCents: 41, quantity: 1, weightLb: 2.55 },
    ];
    expect(reconcile(items, 0, null, 0, 448, 2)).toMatchObject({ matches: true, savingsApplied: false, itemsCents: 448, countMatches: true });
    expect(reconcile(items, 0, null, 0, 357)).toMatchObject({ matches: true, savingsApplied: true, itemsCents: 357 });
  });
  it('a missing line shows as a gap; the item count is compared with ITEMS SOLD', () => {
    const r = parseKrogerReceipt('SAMPLE OATS    3.00 F\nTAX    0.10\n**** BALANCE    5.10\nTOTAL NUMBER OF ITEMS SOLD = 2');
    expect(r.check).toMatchObject({ itemsCents: 300, targetCents: 500, targetLabel: 'total minus tax', matches: false, gapCents: 200, itemsSold: 2, itemsCounted: 1, countMatches: false });
  });
  it('a row repeating the total is never an item', () => {
    const r = parseKrogerReceipt('SAMPLE OATS    3.00 F\nSAMPLE JAM    2.00 F\nAMX 8ALNCE    5.00\n**** BALANCE    5.00');
    expect(r.items.map((i) => i.name)).toEqual(['SAMPLE OATS', 'SAMPLE JAM']);
  });
});
