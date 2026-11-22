import { describe, expect, it } from 'vitest';
import { expandAbbrev } from './krogerAbbrev.ts';
import { needsLookCount, parseKrogerReceipt, parseReceipt, RECEIPT_PARSERS } from './receipt.ts';

// SAMPLE: synthetic Kroger-style receipt text written for these tests (made-up store and items).
const SAMPLE = `
Kroger
FRESH FOR EVERYONE
100 Sample Parkway
555-010-0100
Your cashier was SAMPLE 101
SAMPLE OAT MILK<+          4.79 F
SAMPLE BEANS       PC      1.59 F
1 @ 2/5.00
DRIS STRAWBERRY            2.50 F
KROGER SAVINGS             0.50
2 @ 2.69
BROCCOLI                   5.38 F
0.63 lb @ 1.39 /lb
WT    ONIONS               0.88 F
SAMPLE TOY BLOCKS          3.99 T
SAMPLE TEA          <+     2.99 B
TAX                        0.33
**** BALANCE              21.94
Sampletown Oh 45000
AMERICAN EXPRESS Purchase
************4242 - H
REF#: 000000 TOTAL: 21.94
AID: A000000025010402
TC: 0000AAAA
KROGER PLUS CUSTOMER ****1234
AMEX                      21.94
CHANGE                     0.00
TOTAL NUMBER OF ITEMS SOLD = 8
02/03/26 09:33am 747 650 36 999999650
JOIN KROGER PLUS & BEGIN SAVING TODAY
YOU COULD HAVE SAVED $1.25 MORE
`;

describe('parseKrogerReceipt (synthetic SAMPLE)', () => {
  const r = parseKrogerReceipt(SAMPLE);
  it('header: store address, ZIP printed near payment, footer date/time; cashier dropped', () => {
    expect(r.header).toEqual({ chain: 'kroger', store: '100 Sample Parkway', zip: '45000', city: 'Sampletown', state: 'OH', storeNumber: null, date: '2026-02-03', time: '09:33am' });
  });
  it('items: markers (PC, <+) stripped, tax flags F/T/B', () => {
    expect(r.items.map((i) => [i.name, i.priceCents, i.taxFlag])).toEqual([
      ['SAMPLE OAT MILK', 479, 'F'],
      ['SAMPLE BEANS', 159, 'F'],
      ['DRIS STRAWBERRY', 250, 'F'],
      ['BROCCOLI', 538, 'F'],
      ['ONIONS', 88, 'F'],
      ['SAMPLE TOY BLOCKS', 399, 'T'],
      ['SAMPLE TEA', 299, 'B'],
    ]);
  });
  it('multi-buy lines attach to the NEXT item ("1 @ 2/5.00", "2 @ 2.69")', () => {
    expect(r.items[2]).toMatchObject({ quantity: 1, unitPriceCents: 250 });
    expect(r.items[3]).toMatchObject({ quantity: 2, unitPriceCents: 269 });
  });
  it('weighted line before its item ("0.63 lb @ 1.39 /lb" then "WT ONIONS")', () => {
    expect(r.items[4]).toMatchObject({ weightLb: 0.63, pricePerLbCents: 139 });
  });
  it('savings attach to the previous item', () => {
    expect(r.items[2]!.savingsCents).toBe(50);
  });
  it('tax and balance; card digits, REF/AID/TC, loyalty number and cashier dropped (counts only)', () => {
    expect([r.taxCents, r.totalCents]).toEqual([33, 2194]);
    const all = JSON.stringify(r);
    for (const s of ['4242', '1234', 'A000000025010402', '0000AAAA', 'SAMPLE 101']) expect(all).not.toContain(s);
    expect(r.dropped.card).toBeGreaterThanOrEqual(2);
    expect(r.dropped.cashier).toBe(1);
    expect(needsLookCount(r)).toEqual({ need: 0, total: 7 });
  });
  it('abbreviations expanded for search; original kept', () => {
    expect(r.items[2]).toMatchObject({ name: 'DRIS STRAWBERRY', searchTerm: "Driscoll's Strawberry" });
  });
});

describe('OCR noise and registry', () => {
  it('O/0, l/1, S/5 in prices are fixed and flagged', () => {
    const r = parseKrogerReceipt('SAMPLE JAM   2.l9 F\nSAMPLE RICE  O.99 F\nSAMPLE SOUP  1.S9 F');
    expect(r.items.map((i) => i.priceCents)).toEqual([219, 99, 159]);
    expect(r.items.every((i) => i.needsLook)).toBe(true);
  });
  it('lines with no price are dropped unless weighted/multi-buy; data-like lines are shown', () => {
    const r = parseKrogerReceipt('SAMPLE NOTE LINE\nSAMPLE ??? 3.1X 9');
    expect(r.items).toEqual([]);
    expect(r.skipped).toBe(2);
  });
  it('registry: Kroger is the only parser and is picked', () => {
    expect(RECEIPT_PARSERS.map((p) => p.id)).toEqual(['kroger']);
    expect(parseReceipt(SAMPLE).parser).toBe('kroger');
  });
  it('expandAbbrev', () => {
    expect(expandAbbrev('APL HNY ORG')).toBe('Apple Honey Organic');
    expect(expandAbbrev('PPRS BL GRN ORGNC')).toBe('Peppers Bell Green Organic');
    expect(expandAbbrev('NBSC WHEAT THINS')).toBe('Nabisco Wheat Thins');
  });
});

describe('handheld photo noise (synthetic)', () => {
  it('edge junk past the receipt is trimmed; a lost decimal point is read but flagged', () => {
    const r = parseKrogerReceipt([
      { text: 'Kroger', confidence: 90 },
      { text: 'a2            SAMPLE GRN BEANS      1.29 |              9    a', confidence: 70 },
      { text: '=      SAMPLE JAM 399 F', confidence: 70 },
      { text: '>        2.13 1b ¢ 1,99 /1b       99 ¢', confidence: 60 },
      { text: 'SAMPLE APPLES 4.24 F', confidence: 70 },
    ]);
    expect(r.items.map((i) => [i.name, i.priceCents])).toEqual([
      ['SAMPLE GRN BEANS', 129],
      ['SAMPLE JAM', 399],
      ['SAMPLE APPLES', 424],
    ]);
    expect(r.items[1]!.issues.join()).toMatch(/decimal point/);
    expect(r.items[2]!.weightLb).toBeCloseTo(2.13);
    expect(r.items[2]!.pricePerLbCents).toBe(199);
  });
});
