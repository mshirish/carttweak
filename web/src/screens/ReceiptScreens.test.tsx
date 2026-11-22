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
  { text: 'Kroger', confidence: 95 },
  { text: '100 EXAMPLE PKWY', confidence: 95 },
  { text: 'Your cashier was SAMPLE', confidence: 90 },
  { text: 'SAMPLE OATS 3.48 F', confidence: 96 },
  { text: 'SAMPLE JAM 2.18 F', confidence: 55 },
  { text: 'S4MPLE ??? 3.1O ~ ?', confidence: 30 },
  { text: 'VISA ************4242', confidence: 92 },
  { text: 'SPRINGFIELD, OH 45000', confidence: 94 },
  { text: '02/03/26 10:11am', confidence: 90 },
];

describe('receipt state', () => {
  it('rows from OCR: low confidence and unreadable lines need a look; nothing dropped silently; card line removed', () => {
    const { state } = receiptFromOcr(LINES);
    expect(state.header).toEqual({ store: '100 EXAMPLE PKWY', zip: '45000', date: '2026-02-03' });
    expect(state.rows.map((r) => [r.name, r.price, rowNeedsLook(r)])).toEqual([
      ['SAMPLE OATS', '3.48', false],
      ['SAMPLE JAM', '2.18', true],
      ['S4MPLE ??? 3.1O ~ ?', '', true],
    ]);
    expect(state.dropped).toBe(2); // card line + cashier line
    expect(JSON.stringify(state)).not.toContain('4242');
  });
  it('only item lines go to the server (no raw OCR, no image); names are expanded for search', () => {
    const { state } = receiptFromOcr(LINES);
    const req = matchRequest(state);
    expect(req).toMatchObject({
      zip: '45000',
      store: '100 EXAMPLE PKWY',
      date: '2026-02-03',
      items: [
        { id: 'r01', name: 'SAMPLE OATS', code: null, quantity: 1, priceCents: 348, skipSearch: false },
        { id: 'r02', name: 'SAMPLE JAM', code: null, quantity: 1, priceCents: 218, skipSearch: false },
        { id: 'u01', name: 'S4MPLE ??? 3.1O ~ ?', code: null, quantity: 1, priceCents: null },
      ],
    });
    expect(JSON.stringify(req)).not.toContain('cashier');
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

const card = (d: string, id: string) => ({ source: 'kroger' as const, ref: `kroger:${id}`, gtin14: null, upcA: null, krogerProductId: id, description: d, brand: null, sizeLabel: '20 oz', fdcId: null, regularCents: 298, imageUrl: null });

function MatchHarness({ initial, zipNote = null }: { initial: MatchRow[]; zipNote?: string | null }) {
  const [rows, setRows] = useState(initial);
  return <ReceiptMatchScreen rows={rows} setRows={(fn) => setRows(fn)} zip="45000" zipNote={zipNote} fallbackBranch={{ chain: 'kroger', locationId: '01400513', name: 'Kroger On the Rhine', address: '' }} onPlanFallback={() => {}} />;
}

describe('Match screen labels', () => {
  const rows: MatchRow[] = [
    { id: 'a', name: 'SAMPLE OATS', code: '012345600011', quantity: 1, priceCents: 348, status: 'matched', matchMethod: 'barcode', via: 'fdc', product: { ...card('Sample Oats 18 oz', 'x'), source: 'fdc', krogerProductId: '0012345600011' }, candidates: [], locked: false },
    { id: 'b', name: 'SMPL BRD', code: '012345600099', quantity: 1, priceCents: 250, status: 'needs_confirm', matchMethod: 'unmatched', candidates: [card('Sample Bread A', '1'), card('Sample Bread B', '2')], locked: false },
    { id: 'c', name: 'BANANAS', code: '000000004011', quantity: 1, priceCents: 101, status: 'unmatched', matchMethod: 'unmatched', reason: 'produce (PLU code, no barcode)', candidates: [], locked: false },
  ];
  it('Matched by barcode / Pick one / Not matched; never auto-picks; picking gives "You confirmed"', () => {
    render(<MatchHarness initial={rows} />);
    expect(screen.getByText('Matched by barcode')).toBeTruthy();
    expect(screen.getByText('Pick one')).toBeTruthy();
    expect(screen.getByText('Not matched')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Pick or skip 1 item/ })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: /Sample Bread B/ }));
    expect(screen.getByText('You confirmed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'See your haul score' })).toHaveProperty('disabled', false);
  });
  it('receipt from another Kroger: says which store the swap prices use', () => {
    render(<MatchHarness initial={rows} zipNote="Receipt from Kroger, 1 Sample St. Swap prices use Kroger On the Rhine." />);
    expect(screen.getByTestId('zip-note').textContent).toBe('Receipt from Kroger, 1 Sample St. Swap prices use Kroger On the Rhine.');
  });
  it('one strong match is preselected but needs a tap; "Confirm all suggested" is visible and undoable', () => {
    const rs: MatchRow[] = [{ ...rows[1]!, suggestedRef: 'kroger:2' }];
    render(<MatchHarness initial={rs} />);
    expect(screen.getByText('Suggested')).toBeTruthy();
    expect(screen.queryByText('You confirmed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Confirm all suggested \(1\)/ }));
    expect(screen.getByText('You confirmed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.queryByText('You confirmed')).toBeNull();
  });
});

describe('price labels', () => {
  it('Kroger API price: "Prices from <branch> (checked ...)"', () => {
    const t = priceSourceLabel({ source: 'kroger_api', branch: 'Kroger On the Rhine', date: '2026-11-22T10:00:00Z' }, '2026-11-22T12:00:00Z');
    expect(t).toBe('Prices from Kroger On the Rhine (checked 2 hours ago)');
  });
  it('paid line: "You paid $X on <date> at Kroger, <store>"', () => {
    const p: PriceObservation = { productRef: 'x', branch: { chain: 'kroger', locationId: 'store:01711', name: 'Kroger, 1 Sample St', address: '' }, regularCents: 248, promoCents: null, source: 'receipt', observedAt: '2026-02-03', sourceRef: 'receipt', isSample: false };
    expect(paidLabel(p)).toBe('You paid $2.48 on Feb 3, 2026 at Kroger, 1 Sample St');
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
    const p: PriceObservation = { productRef: 'x', branch: { chain: 'kroger', locationId: 's', name: 'Kroger, 1 Sample St', address: '' }, regularCents: 504, promoCents: null, source: 'receipt', observedAt: '2020-02-03', sourceRef: 'r', isSample: false, quantity: 2 };
    expect(paidLabel(p)).toBe('You paid $5.04 for 2 on Feb 3, 2020 at Kroger, 1 Sample St');
  });
});

describe('P2: produce confirm + non-food', () => {
  const base = { code: null, quantity: 1, priceCents: 100, status: 'unmatched' as const, matchMethod: 'unmatched' as const, candidates: [], locked: false };
  it('produce: "Is this bananas?" never auto-confirms; tapping a USDA record labels it', () => {
    const rows: MatchRow[] = [{ ...base, id: 'p', name: 'BANANAS', code: '000000004011', produceGuess: { term: 'bananas raw', label: 'Bananas' }, produceCandidates: [{ fdcId: 1105314, description: 'Bananas, raw' }] }];
    render(<MatchHarness initial={rows} />);
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
    render(<MatchHarness initial={rows} />);
    expect(screen.getByText('Not food?')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Undo' })[0]!);
    expect(screen.queryByText('Not food?')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Not food' })[1]!);
    expect(screen.getByText('Not food', { selector: '.chip' })).toBeTruthy();
  });
});
