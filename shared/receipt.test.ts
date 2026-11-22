import { describe, expect, it } from 'vitest';
import { fixDigits, needsLookCount, parseWalmartReceipt, receiptCodeToUpcA, type OcrLine } from './receipt.ts';
import { hasValidCheckDigit } from './upc.ts';

// SAMPLE receipts: synthetic text written for these tests. Store, address,
// names, codes and prices are made up (codes use a fictional 0123456 prefix).
const SAMPLE_A = `
Walmart
Save money. Live better.
555-010-0199 Mgr:SAMPLE PERSON
100 EXAMPLE PKWY
SPRINGFIELD, OH 45000
ST# 01234 OP# 00999 TE# 12 TR# 05678
SAMPLE OATS    012345600011 F    3.48 N
SAMPLE SOUP    012345600022 F
   2 AT 1 FOR 1.25          2.50 N
SAMPLE APPLES  000000004133 F
   1.32 lb @ 0.58 /lb       0.77 N
SAMPLE SOAP    012345600033      5.00 X
   COUPON 012345600033      1.00-X
SAMPLE CANDLE  012345600044      0.30 T
    WAS 3.00 YOU SAVED 2.70
                SUBTOTAL   11.05
       TAX 1   7.000 %      0.31
                   TOTAL   11.36
     VISA TEND             11.36
VISA **** **** **** 4242 I 0
REF # 000000000000
APPR CODE 000000
AID A0000000031010
TERMINAL # SC000000
TC# 1111 2222 3333 4444 5555
    # ITEMS SOLD 6
Low Prices You Can Trust. Every Day.
02/03/26    10:11:12
`;

describe('parseWalmartReceipt (synthetic SAMPLE receipt)', () => {
  const r = parseWalmartReceipt(SAMPLE_A);
  it('header: store number, address, ZIP, date/time', () => {
    expect(r.header).toEqual({ chain: 'walmart', storeNumber: '01234', street: '100 EXAMPLE PKWY', city: 'SPRINGFIELD', state: 'OH', zip: '45000', date: '2026-02-03', time: '10:11:12' });
  });
  it('item lines: name, 12-digit code, price, SNAP flag, tax flag', () => {
    expect(r.items.map((i) => [i.name, i.code, i.priceCents, i.snapEligible, i.taxFlag])).toEqual([
      ['SAMPLE OATS', '012345600011', 348, true, 'N'],
      ['SAMPLE SOUP', '012345600022', 250, true, 'N'],
      ['SAMPLE APPLES', '000000004133', 77, true, 'N'],
      ['SAMPLE SOAP', '012345600033', 500, false, 'X'],
      ['SAMPLE CANDLE', '012345600044', 30, false, 'T'],
    ]);
  });
  it('quantity line "2 AT 1 FOR 1.25" attaches to its item', () => {
    expect(r.items[1]).toMatchObject({ quantity: 2, unitPriceCents: 125, priceCents: 250 });
    expect(r.items[1]!.lines).toHaveLength(2);
  });
  it('weighted item "1.32 lb @ 0.58 /lb" (PLU, no barcode)', () => {
    expect(r.items[2]).toMatchObject({ isPlu: true, weightLb: 1.32, pricePerLbCents: 58, priceCents: 77 });
  });
  it('coupon attaches to its item and is subtracted; "WAS/YOU SAVED" is informational', () => {
    expect(r.items[3]!.savingsCents).toBe(100);
    expect(r.items[4]).toMatchObject({ savingsCents: 0, wasPriceCents: 300, priceCents: 30 });
    expect(r.check).toEqual({ itemsCents: 1105, subtotalCents: 1105, matches: true });
  });
  it('subtotal / tax / total', () => {
    expect([r.subtotalCents, r.taxCents, r.totalCents]).toEqual([1105, 31, 1136]);
  });
  it('drops card digits, approval/ref codes, TC#, staff names, ids - and never returns their text', () => {
    expect(r.dropped).toEqual({ staff_name: 2, card: 1, approval_or_reference: 4, transaction_code: 1 });
    const all = JSON.stringify(r);
    for (const secret of ['4242', 'A0000000031010', 'SC000000', '1111 2222', 'SAMPLE PERSON', '00999', '05678']) expect(all).not.toContain(secret);
  });
  it('nothing needs a look on a clean receipt', () => {
    expect(needsLookCount(r)).toEqual({ need: 0, total: 5 });
    expect(r.unparsed).toEqual([]);
  });
});

describe('OCR noise', () => {
  it('O/0, l/1, I/1, S/5 inside codes are fixed and flagged for a look', () => {
    const r = parseWalmartReceipt('SAMPLE TEA   O1234560OO5l F   1.43 T\nSAMPLE RICE  0I2345600O66 F   2.97 X');
    expect(r.items.map((i) => i.code)).toEqual(['012345600051', '012345600066']);
    expect(r.items.every((i) => i.needsLook && i.issues[0]!.includes('look like digits'))).toBe(true);
  });
  it('fixDigits only maps look-alikes', () => {
    expect(fixDigits('O1lI|SBZ')).toEqual({ value: '01111582', fixed: true });
    expect(fixDigits('123')).toEqual({ value: '123', fixed: false });
  });
  it('tax flag glued to the code ("...187H")', () => {
    const r = parseWalmartReceipt('SAMPLE BRACE  012345600077H     22.98 X');
    expect(r.items[0]).toMatchObject({ code: '012345600077', taxFlag: 'X', priceCents: 2298 });
  });
  it('weight line where OCR read "lb" as "1b"', () => {
    const r = parseWalmartReceipt('SAMPLE PEARS  000000004409  F\n  1.50  lb @  1.0  1b  /0.80  1.20');
    expect(r.items[0]).toMatchObject({ weightLb: 1.5, pricePerLbCents: 80, priceCents: 120, needsLook: false });
  });
  it('weight line with "1 lb /2.0" rate form', () => {
    const r = parseWalmartReceipt('SAMPLE CHICKEN 000000004995\n  2.33 LB @ 1 lb /2.0     4.66 N');
    expect(r.items[0]).toMatchObject({ weightLb: 2.33, pricePerLbCents: 200, priceCents: 466, taxFlag: 'N' });
  });
  it('low OCR confidence highlights the row; a missing price is flagged, not dropped', () => {
    const lines: OcrLine[] = [
      { text: 'SAMPLE JAM   012345600088 F   2.18 T', confidence: 62 },
      { text: 'SAMPLE BREAD 012345600099 F', confidence: 95 },
      { text: 'S4MPLE ??? 3.1O', confidence: 40 },
    ];
    const r = parseWalmartReceipt(lines);
    expect(r.items[0]).toMatchObject({ confidence: 62, needsLook: true });
    expect(r.items[1]!.issues).toContain('no price read');
    expect(r.unparsed).toEqual([{ text: 'S4MPLE ??? 3.1O', confidence: 40 }]);
    expect(needsLookCount(r)).toEqual({ need: 3, total: 3 });
  });
  it('"City,ST ZIP" without a space, and running SUBTOTAL lines (last one wins)', () => {
    const r = parseWalmartReceipt('200 SAMPLE BLVD\nSampletown,CA 90000\nSAMPLE A 012345600011 F 1.00 N\n   SUBTOTAL 1.00\nSAMPLE B 012345600022 F 2.00 N\n   SUBTOTAL 3.00');
    expect(r.header).toMatchObject({ city: 'Sampletown', state: 'CA', zip: '90000' });
    expect(r.subtotalCents).toBe(300);
    expect(r.check.matches).toBe(true);
  });
  it('store number survives OCR noise ("STH# 0042 OP# ...")', () => {
    expect(parseWalmartReceipt('STH# 0042 OP# 1 TE# 2 TR# 3').header.storeNumber).toBe('0042');
  });
  it('a header without a ZIP leaves zip null (the shopper can fill it in)', () => {
    expect(parseWalmartReceipt('SAMPLEVILLE, MI\nST# 0001 OP# 1').header).toMatchObject({ city: 'SAMPLEVILLE', state: 'MI', zip: null, storeNumber: '0001' });
  });
});

describe('receipt code -> UPC-A (check digit appended)', () => {
  it('appends the GS1 check digit to the 11-digit body', () => {
    // Wonder Classic White Bread: Kroger id 0007225001137 <-> UPC-A 072250011372 (verified with FDC 2026-11-22)
    expect(receiptCodeToUpcA('007225001137')).toBe('072250011372');
    expect(hasValidCheckDigit(receiptCodeToUpcA('012345600011')!)).toBe(true);
  });
  it('PLU produce codes have no UPC', () => {
    expect(receiptCodeToUpcA('000000004011')).toBeNull();
  });
});
