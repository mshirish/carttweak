// USDA FoodData Central client: barcode lookup only.
import { matchBarcodes, upcCandidates, latestFdcDate } from '@carttweak/shared';
import { cachedJson, TTL, type Fetched } from './cache.ts';

const BASE = 'https://api.nal.usda.gov/fdc/v1';

export interface FdcLookup {
  match: { fdcId: number; gtin14: string; formsQueried: string[]; matchingRecords: number } | null;
  search: Fetched;
  detail: Fetched | null;
}

/**
 * One full-text search with every check-digit form OR'ed together (verified
 * live 2026-11-22: FDC ORs query words, and only check-digit forms ever
 * matched). A record counts only if its gtinUpc normalizes to the same GTIN-14.
 * If several records share the GTIN, the most recently published/modified wins.
 */
export async function lookupByUpc(apiKey: string, upc: string): Promise<FdcLookup> {
  const forms = upcCandidates(upc)
    .filter((c) => c.form.endsWith('+check'))
    .map((c) => c.value);
  const url = `${BASE}/foods/search?api_key=${encodeURIComponent(apiKey)}&query=${encodeURIComponent(forms.join(' '))}&dataType=Branded&pageSize=25`;
  const search = await cachedJson<any>('fdc-search', url, {}, TTL.fdc, { service: 'fdc' });
  const foods: any[] = search.ok ? search.body?.foods ?? [] : [];
  const matches = foods.filter((f) => f.gtinUpc && matchBarcodes(upc, String(f.gtinUpc)));
  if (!matches.length) return { match: null, search, detail: null };
  matches.sort((a, b) => (latestFdcDate(b.modifiedDate, b.publishedDate) ?? '').localeCompare(latestFdcDate(a.modifiedDate, a.publishedDate) ?? ''));
  const best = matches[0];
  const detail = await cachedJson<any>('fdc-food', `${BASE}/food/${best.fdcId}?api_key=${encodeURIComponent(apiKey)}`, {}, TTL.fdc, { service: 'fdc' });
  const verify = detail.ok && detail.body?.gtinUpc ? matchBarcodes(upc, String(detail.body.gtinUpc)) : null;
  if (!verify) return { match: null, search, detail };
  return { match: { fdcId: best.fdcId, gtin14: verify.gtin14, formsQueried: forms, matchingRecords: matches.length }, search, detail };
}
