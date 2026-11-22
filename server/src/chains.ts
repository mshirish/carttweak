/**
 * Chain adapters: everything chain-specific the service needs, behind one
 * interface. Kroger is the only implementation today; see docs/ADDING_A_CHAIN.md.
 */
import type { Branch } from '@carttweak/shared';

export interface ChainAdapter {
  chain: string;
  /** product search at a branch (normalized products + resolution) */
  search(term: string, locationId: string): Promise<any>;
  /** product by the chain's own id at a branch */
  lookup(productId: string, locationId: string): Promise<any>;
  /** stores near a ZIP (stores only, no warehouses) */
  locations(zip: string): Promise<any>;
  /** one branch by id */
  branch(locationId: string): Promise<Branch>;
}

export function krogerAdapter(svc: {
  search: (term: string, locationId: string) => Promise<any>;
  byUpc: (id: string, locationId: string) => Promise<any>;
  stores: (zip: string) => Promise<any>;
  branch: (locationId: string) => Promise<Branch>;
}): ChainAdapter {
  return {
    chain: 'kroger',
    search: (term, locationId) => svc.search(term, locationId),
    lookup: (id, locationId) => svc.byUpc(id, locationId),
    locations: (zip) => svc.stores(zip),
    branch: (id) => svc.branch(id),
  };
}

/** Registered chains. Add a chain by implementing ChainAdapter and listing it here. */
export const CHAINS = ['kroger'] as const;
