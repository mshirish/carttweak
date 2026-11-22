import { describe, expect, it } from 'vitest';
import { buildRevisedList, SCHEMA_VERSION, STORAGE_KEY, TripStore, type SavedTrip, type StorageLike } from './storage.ts';

const trip = (id: string, createdAt = '2026-11-22T08:00:00Z'): SavedTrip => ({
  schemaVersion: SCHEMA_VERSION,
  id,
  createdAt,
  branch: { chain: 'kroger', locationId: '01400513', name: 'Kroger On the Rhine', address: '100 E Court St' },
  goals: { primary: 'more_fiber', secondary: null },
  budgetCents: 200,
  originalItems: [],
  acceptedSwaps: [],
  revisedList: [],
  containsSample: false,
  listIsSample: true,
});

function mem(): StorageLike & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
}

describe('TripStore', () => {
  it('saves versioned trips and lists newest first', () => {
    const s = mem();
    const store = new TripStore(() => s);
    store.save(trip('a', '2026-11-21T08:00:00Z'));
    store.save(trip('b'));
    expect(JSON.parse(s.data[STORAGE_KEY]!).schemaVersion).toBe(1);
    expect(store.list().map((t) => t.id)).toEqual(['b', 'a']);
    expect(store.warning).toBeNull();
  });
  it('falls back to memory with a visible warning when storage throws', () => {
    const broken: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
      },
    };
    const store = new TripStore(() => broken);
    const r = store.save(trip('a'));
    expect(r.ok).toBe(false);
    expect(r.warning).toMatch(/storage is full.*until you close this tab/);
    expect(store.get('a')!.id).toBe('a');
  });
  it('blocked storage (getter throws) and unreadable data both fall back', () => {
    const blocked = new TripStore(() => {
      throw new Error('SecurityError');
    });
    expect(blocked.list()).toEqual([]);
    expect(blocked.warning).toMatch(/blocked/);
    const s = mem();
    s.data[STORAGE_KEY] = '{not json';
    const bad = new TripStore(() => s);
    expect(bad.list()).toEqual([]);
    expect(bad.warning).toMatch(/unreadable/);
  });
  it('skips trips with an unknown schema version, with a warning', () => {
    const s = mem();
    s.data[STORAGE_KEY] = JSON.stringify({ trips: [trip('ok'), { ...trip('future'), schemaVersion: 99 }] });
    const store = new TripStore(() => s);
    expect(store.list().map((t) => t.id)).toEqual(['ok']);
    expect(store.warning).toMatch(/unknown format/);
  });
});

describe('buildRevisedList', () => {
  it('replaces accepted items with the replacement and packages needed', () => {
    const items = [
      { itemId: 'i1', query: 'bread', quantity: 1, status: 'matched' as const, locked: false, product: { ref: 'k:1', description: 'Wonder Classic White Bread', sizeLabel: '20 oz', regularCents: 329, imageUrl: null } },
      { itemId: 'i2', query: 'cheerios', quantity: 1, status: 'matched' as const, locked: true, product: { ref: 'k:2', description: 'Honey Nut Cheerios', sizeLabel: '10.8 oz', regularCents: 399, imageUrl: null } },
      { itemId: 'i3', query: 'bananas', quantity: 6, status: 'no_barcode' as const, locked: false, product: null },
    ];
    const swap: any = { itemId: 'i1', packagesNeeded: 2, replacement: { description: 'Small Whole Grain Loaf', sizeLabel: '12 oz' }, original: { description: 'Wonder Classic White Bread' } };
    expect(buildRevisedList(items, [swap])).toEqual([
      { itemId: 'i1', quantity: 2, description: 'Small Whole Grain Loaf', sizeLabel: '12 oz', swapped: true, replaces: 'Wonder Classic White Bread', locked: false },
      { itemId: 'i2', quantity: 1, description: 'Honey Nut Cheerios', sizeLabel: '10.8 oz', swapped: false, locked: true },
      { itemId: 'i3', quantity: 6, description: 'bananas', sizeLabel: null, swapped: false, locked: false },
    ]);
  });
});
