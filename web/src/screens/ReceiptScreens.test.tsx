// @vitest-environment jsdom
// SAMPLE data only: synthetic receipt lines written for these tests.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { PriceObservation } from '@carttweak/shared';
import { paidLabel, priceSourceLabel } from '../components/SwapCard.tsx';
import { matchRequest, mergeMatchedRows, receiptFromOcr, rowNeedsLook, type MatchRow, type ReceiptState } from '../receipt.ts';
import { ReceiptCheckScreen, ReceiptMatchScreen } from './ReceiptScreens.tsx';

afterEach(cleanup);

const LINES = [
  { text: '100 EXAMPLE PKWY', confidence: 95 },
  { text: 'SPRINGFIELD, OH 45000', confidence: 94 },
  { text: 'ST# 01234 OP# 00999 TE# 12 TR# 05678', confidence: 90 },
  { text: 'SAMPLE OATS    012345600011 F    3.48 N', confidence: 96 },
  { text: 'SAMPLE JAM     012345600088 F    2.18 T', confidence: 55 },
  { text: 'S4MPLE ??? 3.1O', confidence: 30 },
  { text: 'VISA **** **** **** 4242 I 0', confidence: 92 },
  { text: '02/03/26 10:11:12', confidence: 90 },
];

describe('receipt state', () => {
  it('rows from OCR: low confidence and unreadable lines need a look; nothing dropped silently; card line removed', () => {
    const { state } = receiptFromOcr(LINES);
    expect(state.header).toEqual({ storeNumber: '01234', zip: '45000', date: '2026-02-03' });
    expect(state.rows.map((r) => [r.name, r.code, r.price, rowNeedsLook(r)])).toEqual([
      ['SAMPLE OATS', '012345600011', '3.48', false],
      ['SAMPLE JAM', '012345600088', '2.18', true],
      ['S4MPLE ??? 3.1O', '', '', true],
    ]);
    expect(state.dropped).toBe(2); // card line + staff/ids line
    expect(JSON.stringify(state)).not.toContain('4242');
  });
  it('only item lines go to the server (no raw OCR, no image)', () => {
    const { state } = receiptFromOcr(LINES);
    const req = matchRequest(state);
    expect(req).toEqual({
      zip: '45000',
      storeNumber: '01234',
      date: '2026-02-03',
      items: [
        { id: 'r01', name: 'SAMPLE OATS', code: '012345600011', quantity: 1, priceCents: 348 },
        { id: 'r02', name: 'SAMPLE JAM', code: '012345600088', quantity: 1, priceCents: 218 },
        { id: 'u01', name: 'S4MPLE ??? 3.1O', code: null, quantity: 1, priceCents: null },
      ],
    });
  });
});

function CheckHarness({ initial }: { initial: ReceiptState }) {
  const [s, setS] = useState(initial);
  return <ReceiptCheckScreen state={s} setState={(fn) => setS(fn)} busy={false} error={null} onContinue={() => {}} />;
}

describe('Check what we read', () => {
  it('shows "x of y lines need a look", highlights them, every field editable; fixing clears it', () => {
    const { state } = receiptFromOcr(LINES);
    render(<CheckHarness initial={state} />);
    expect(screen.getByTestId('need-look').textContent).toBe('2 of 3 lines need a look.');
    const rows = screen.getAllByTestId('receipt-row');
    expect(rows.map((r) => r.className.includes('look'))).toEqual([false, true, true]);
    expect(within(rows[1]!).getByText('read 55%')).toBeTruthy();
    fireEvent.click(within(rows[1]!).getByText('Looks right'));
    expect(screen.getByTestId('need-look').textContent).toBe('1 of 3 lines need a look.');
    const r3 = screen.getAllByTestId('receipt-row')[2]!;
    fireEvent.change(within(r3).getByLabelText('Name'), { target: { value: 'SAMPLE TEA' } });
    fireEvent.change(within(r3).getByLabelText('Price'), { target: { value: '3.10' } });
    expect(screen.getByTestId('need-look').textContent).toBe('0 of 3 lines need a look.');
    fireEvent.click(screen.getByText('+ Add a line'));
    expect(screen.getAllByTestId('receipt-row')).toHaveLength(4);
    expect(screen.getByTestId('need-look').textContent).toBe('1 of 4 lines need a look.');
  });
});

const card = (d: string, id: string) => ({ source: 'walmart' as const, gtin14: null, upcA: null, krogerProductId: null, walmartItemId: id, description: d, brand: null, sizeLabel: '20 oz', fdcId: null, regularCents: 298, imageUrl: null });

function MatchHarness({ initial, walmart }: { initial: MatchRow[]; walmart: { available: boolean; reason: string | null } }) {
  const [rows, setRows] = useState(initial);
  return <ReceiptMatchScreen rows={rows} setRows={(fn) => setRows(fn)} walmart={walmart} zip="45000" fallbackBranch={{ chain: 'kroger', locationId: '01400513', name: 'Kroger On the Rhine', address: '' }} onPlanWalmart={() => {}} onPlanFallback={() => {}} />;
}

describe('Match screen labels', () => {
  const rows: MatchRow[] = [
    { id: 'a', name: 'SAMPLE OATS', code: '012345600011', quantity: 1, priceCents: 348, status: 'matched', matchMethod: 'barcode', via: 'fdc', product: { ...card('Sample Oats 18 oz', 'x'), source: 'fdc', walmartItemId: null, krogerProductId: '0012345600011' }, candidates: [], locked: false },
    { id: 'b', name: 'SMPL BRD', code: '012345600099', quantity: 1, priceCents: 250, status: 'needs_confirm', matchMethod: 'unmatched', candidates: [card('Sample Bread A', '1'), card('Sample Bread B', '2')], locked: false },
    { id: 'c', name: 'BANANAS', code: '000000004011', quantity: 1, priceCents: 101, status: 'unmatched', matchMethod: 'unmatched', reason: 'produce (PLU code, no barcode)', candidates: [], locked: false },
  ];
  it('Matched by barcode / Pick one / Not matched; never auto-picks; picking gives "You confirmed"', () => {
    render(<MatchHarness initial={rows} walmart={{ available: true, reason: null }} />);
    expect(screen.getByText('Matched by barcode')).toBeTruthy();
    expect(screen.getByText('Pick one')).toBeTruthy();
    expect(screen.getByText('Not matched')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Pick or skip 1 item/ })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: /Sample Bread B/ }));
    expect(screen.getByText('You confirmed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'See your haul score' })).toHaveProperty('disabled', false);
  });
  it("Walmart down: says so and offers the Kroger demo branch, clearly a different store", () => {
    render(<MatchHarness initial={rows} walmart={{ available: false, reason: null }} />);
    expect(screen.getByText('Prices from Kroger On the Rhine; Walmart prices coming soon.')).toBeTruthy();
  });
});

describe('price labels', () => {
  it('Walmart API price: "Walmart.com price for ZIP xxxxx (checked ...)" - never a shelf price', () => {
    const t = priceSourceLabel({ source: 'walmart_api', branch: 'Walmart.com (ZIP 45000)', date: '2026-11-22T10:00:00Z' }, '2026-11-22T12:00:00Z');
    expect(t).toBe('Walmart.com price for ZIP 45000 (checked 2 hours ago)');
    expect(t).not.toMatch(/shelf/i);
  });
  it('paid line: "You paid $X on <date> at Walmart #<store>"', () => {
    const p: PriceObservation = { productRef: 'x', branch: { chain: 'walmart', locationId: 'store:01711', name: 'Walmart #1711', address: '' }, regularCents: 248, promoCents: null, source: 'receipt', observedAt: '2026-02-03', sourceRef: 'receipt', isSample: false };
    expect(paidLabel(p)).toBe('You paid $2.48 on Feb 3, 2026 at Walmart #1711');
  });
});

describe('duplicate receipt lines', () => {
  it('the same matched product on two lines becomes one item; quantity and paid add up; a lock carries over', () => {
    const base = { code: '012345600011', status: 'matched' as const, matchMethod: 'barcode' as const, candidates: [], product: card('Sample Rice Bowl', '7') };
    const merged = mergeMatchedRows([
      { ...base, id: 'a', name: 'SMPL BOWL', quantity: 1, priceCents: 252, locked: false },
      { ...base, id: 'b', name: 'SMPL BOWL', quantity: 1, priceCents: 252, locked: true },
      { id: 'c', name: 'BANANAS', code: '000000004011', quantity: 1, priceCents: 101, status: 'unmatched', matchMethod: 'unmatched', candidates: [], locked: false },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 'a', quantity: 2, priceCents: 504, locked: true, mergedIds: ['a', 'b'] });
  });
  it('paid label mentions the quantity', () => {
    const p: PriceObservation = { productRef: 'x', branch: { chain: 'walmart', locationId: 's', name: 'Walmart #1711', address: '' }, regularCents: 504, promoCents: null, source: 'receipt', observedAt: '2020-02-03', sourceRef: 'r', isSample: false, quantity: 2 };
    expect(paidLabel(p)).toBe('You paid $5.04 for 2 on Feb 3, 2020 at Walmart #1711');
  });
});

describe('P2: produce confirm + non-food', () => {
  const base = { code: null, quantity: 1, priceCents: 100, status: 'unmatched' as const, matchMethod: 'unmatched' as const, candidates: [], locked: false };
  it('produce: "Is this bananas?" never auto-confirms; tapping a USDA record labels it', () => {
    const rows: MatchRow[] = [{ ...base, id: 'p', name: 'BANANAS', code: '000000004011', produceGuess: { term: 'bananas raw', label: 'Bananas' }, produceCandidates: [{ fdcId: 1105314, description: 'Bananas, raw' }] }];
    render(<MatchHarness initial={rows} walmart={{ available: false, reason: null }} />);
    expect(screen.getByText('Is this bananas?')).toBeTruthy();
    expect(screen.queryByText('USDA generic record, you confirmed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Bananas, raw' }));
    expect(screen.getByText('USDA generic record, you confirmed')).toBeTruthy();
  });
  it('non-food: pre-marked "Not food?" can be undone; any unmatched line can be marked "Not food"', () => {
    const rows: MatchRow[] = [
      { ...base, id: 'd', name: 'TIDE DETERGENT', nonFood: true, nonFoodGuess: true },
      { ...base, id: 'x', name: 'MYSTERY ITEM' },
    ];
    render(<MatchHarness initial={rows} walmart={{ available: false, reason: null }} />);
    expect(screen.getByText('Not food?')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Undo' })[0]!);
    expect(screen.queryByText('Not food?')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Not food' })[1]!);
    expect(screen.getByText('Not food', { selector: '.chip' })).toBeTruthy();
  });
});
