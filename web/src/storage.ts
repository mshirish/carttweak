/**
 * Saved trips in localStorage, versioned. Every access is wrapped: if storage
 * is blocked or broken, trips are kept in memory for this tab and a warning
 * is exposed for the UI to show.
 */
import type { Branch, Goals, SwapOption } from './types.ts';

export const STORAGE_KEY = 'carttweak.trips';
export const SCHEMA_VERSION = 2 as const;

export type MatchMethod = 'barcode' | 'shopper_confirmed' | 'unmatched';

export interface SavedItem {
  itemId: string;
  query: string;
  quantity: number;
  status: 'matched' | 'no_barcode' | 'unmatched';
  locked: boolean;
  /** receipt trips: how the line was matched; list trips: null (matched by name at the store) */
  matchMethod: MatchMethod | null;
  /** receipt trips: what the shopper paid (cents) */
  paidCents?: number | null;
  product: { ref: string; description: string; sizeLabel: string | null; regularCents: number | null; imageUrl: string | null } | null;
}

export interface RevisedLine {
  itemId: string;
  quantity: number;
  description: string;
  sizeLabel: string | null;
  swapped: boolean;
  /** original product, when swapped */
  replaces?: string;
  locked: boolean;
}

export interface SavedTrip {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  createdAt: string;
  branch: Branch;
  goals: Goals;
  budgetCents: number;
  originalItems: SavedItem[];
  /** full engine output for each accepted swap, including price + nutrition source snapshots */
  acceptedSwaps: SwapOption[];
  revisedList: RevisedLine[];
  containsSample: boolean;
  listIsSample: boolean;
  /** v2 */
  source: 'list' | 'receipt';
  chain: 'kroger' | 'walmart';
}

/** v1 trips (Milestone 2) were list trips at Kroger. */
export function migrateTrip(t: any): SavedTrip | null {
  if (t?.schemaVersion === SCHEMA_VERSION) return t as SavedTrip;
  if (t?.schemaVersion === 1) {
    return {
      ...t,
      schemaVersion: SCHEMA_VERSION,
      source: 'list',
      chain: 'kroger',
      originalItems: (t.originalItems ?? []).map((i: any) => ({ ...i, matchMethod: null })),
    } as SavedTrip;
  }
  return null;
}

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export class TripStore {
  private memory: SavedTrip[] = [];
  private usingMemory = false;
  warning: string | null = null;

  constructor(private storage: () => StorageLike | null = () => (typeof window !== 'undefined' ? window.localStorage : null)) {}

  private fallback(reason: string) {
    this.usingMemory = true;
    this.warning = `Saving to this browser failed (${reason}). Trips are kept only until you close this tab.`;
  }

  list(): SavedTrip[] {
    if (this.usingMemory) return [...this.memory];
    try {
      const s = this.storage();
      if (!s) {
        this.fallback('storage unavailable');
        return [...this.memory];
      }
      const raw = s.getItem(STORAGE_KEY);
      if (!raw) return [];
      const doc = JSON.parse(raw);
      const trips: unknown[] = Array.isArray(doc?.trips) ? doc.trips : [];
      const ok = trips.map(migrateTrip).filter((t): t is SavedTrip => t != null);
      if (ok.length !== trips.length) this.warning = `${trips.length - ok.length} saved trip(s) use an unknown format and were skipped.`;
      return ok.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch (e: any) {
      this.fallback(e?.name === 'SyntaxError' ? 'saved data is unreadable' : 'storage blocked');
      return [...this.memory];
    }
  }

  get(id: string): SavedTrip | null {
    return this.list().find((t) => t.id === id) ?? null;
  }

  save(trip: SavedTrip): { ok: boolean; warning: string | null } {
    const all = [trip, ...this.list().filter((t) => t.id !== trip.id)];
    if (this.usingMemory) {
      this.memory = all;
      return { ok: false, warning: this.warning };
    }
    try {
      const s = this.storage();
      if (!s) throw new Error('storage unavailable');
      s.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: SCHEMA_VERSION, trips: all }));
      return { ok: true, warning: this.warning };
    } catch (e: any) {
      this.memory = all;
      this.fallback(e?.name === 'QuotaExceededError' ? 'storage is full' : 'storage blocked');
      return { ok: false, warning: this.warning };
    }
  }
}

export const tripStore = new TripStore();

/** Revised list: accepted swaps replace their originals (with the packages needed); everything else unchanged. */
export function buildRevisedList(items: SavedItem[], accepted: SwapOption[]): RevisedLine[] {
  return items.map((it) => {
    const s = accepted.find((a) => a.itemId === it.itemId);
    if (s) {
      return {
        itemId: it.itemId,
        quantity: s.packagesNeeded,
        description: s.replacement.description,
        sizeLabel: s.replacement.sizeLabel,
        swapped: true,
        replaces: s.original.description,
        locked: false,
      };
    }
    return {
      itemId: it.itemId,
      quantity: it.quantity,
      description: it.product?.description ?? it.query,
      sizeLabel: it.product?.sizeLabel ?? null,
      swapped: false,
      locked: it.locked,
    };
  });
}

export function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }
}
