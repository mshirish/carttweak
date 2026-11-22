import type { Branch, Goal, ItemOutcome, PlanResult, SwapOption } from '@carttweak/shared';

export type { Branch, Goal, ItemOutcome, PlanResult, SwapOption };

/** Product summary from /api/resolve */
export interface Card {
  productId: string;
  ref: string;
  brand: string | null;
  description: string;
  sizeLabel: string | null;
  size: { quantity: number; unit: 'g' | 'ml' | 'each'; basis: string } | null;
  regularCents: number | null;
  promoCents: number | null;
  observedAt: string | null;
  stale: boolean;
  unitPrice: { cents: number; per: 'oz' | 'fl oz' | 'ct' } | null;
  imageUrl: string | null;
  noBarcode: boolean;
  categories: string[];
  swapGroup: string | null;
}

export interface ResolveItem {
  id: string;
  query: string;
  quantity: number;
  status: 'resolved' | 'ambiguous' | 'not_found' | 'no_barcode' | 'too_vague';
  method: 'only_match' | 'closest_name' | null;
  detail: string;
  product: Card | null;
  candidates: Card[];
  retrievedAt?: string;
  stale?: boolean;
}

export type RowStatus = 'matched' | 'choose' | 'not_found' | 'no_barcode';

/** One line of the shopper's list on the "check your list" screen. */
export interface Row {
  id: string;
  query: string;
  quantity: number;
  status: RowStatus;
  detail: string;
  product: Card | null;
  candidates: Card[];
  locked: boolean;
}

export interface PlanProgress {
  phase: string;
  done: number;
  total: number;
  message: string;
}

export interface PlanResponse {
  branch: Branch;
  generatedAt: string;
  plan: PlanResult;
  explanations: string[];
  containsSample: boolean;
  excludedCandidateIds: string[];
  timingsMs: { resolve: number; candidates: number; engine: number; total: number };
  cache: { hits: number; misses: number; liveCalls: number; staleServed: number };
  chain: 'kroger' | 'walmart';
  /** what the shopper paid, from their receipt (context only; never used for cost math) */
  paid?: Record<string, import('@carttweak/shared').PriceObservation>;
}

export interface Store extends Branch {
  storeNumber?: string;
  phone?: string;
}

export interface DemoList {
  badge: string;
  header: string[];
  items: Array<{ id: string; quantity: number; query: string; tags: string[]; why: string }>;
  text: string;
}

export interface Goals {
  primary: Goal | null;
  secondary: Goal | null;
}
