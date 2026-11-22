// Kroger Public API client. Token cached in memory until shortly before expiry.
import { cachedJson, TTL, UpstreamError, type FetchFn, type Fetched } from './cache.ts';

import { registerSecret } from './secrets.ts';

const BASE = 'https://api.kroger.com/v1';

export interface KrogerConfig {
  clientId: string;
  clientSecret: string;
  fetch?: FetchFn;
}

let token: { value: string; expiresAt: number } | null = null;
export const tokenStats = { issued: 0, reused: 0 };

export function resetTokenCache(): void {
  token = null;
}

export async function krogerToken(cfg: KrogerConfig, force = false): Promise<string> {
  if (!force && token && Date.now() < token.expiresAt - 60_000) {
    tokenStats.reused++;
    return token.value;
  }
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const f = cfg.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(`${BASE}/connect/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'product.compact' }).toString(),
    });
  } catch (e: any) {
    throw new UpstreamError('kroger', null, `Kroger auth unreachable: ${e?.message ?? e}`);
  }
  const body: any = await res.json().catch(() => null);
  if (!res.ok || !body?.access_token) throw new UpstreamError('kroger', res.status, `Kroger auth failed: HTTP ${res.status}`);
  registerSecret(body.access_token);
  token = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in ?? 1800) * 1000 };
  tokenStats.issued++;
  return token.value;
}

/**
 * Cached GET. The token is only needed on a live call, so a fresh cache hit
 * never authenticates; if auth fails we still fall back to any cached copy.
 */
async function get<T>(cfg: KrogerConfig, namespace: string, url: string, ttl: number): Promise<Fetched<T>> {
  const init = (force = false) => async () => ({
    headers: { Authorization: `Bearer ${await krogerToken(cfg, force)}`, Accept: 'application/json' },
  });
  let r = await cachedJson<T>(namespace, url, init(), ttl, { service: 'kroger' });
  if (r.status === 401 && !r.fromCache) {
    r = await cachedJson<T>(namespace, url, init(true), ttl, { service: 'kroger' });
  }
  return r;
}

export function locationsNear(cfg: KrogerConfig, zip: string, limit = 10) {
  return get<any>(cfg, 'kroger-locations', `${BASE}/locations?filter.zipCode.near=${encodeURIComponent(zip)}&filter.limit=${limit}`, TTL.krogerLocations);
}

export function location(cfg: KrogerConfig, locationId: string) {
  return get<any>(cfg, 'kroger-locations', `${BASE}/locations/${encodeURIComponent(locationId)}`, TTL.krogerLocations);
}

export function productSearch(cfg: KrogerConfig, term: string, locationId: string, limit = 10) {
  return get<any>(
    cfg,
    'kroger-products',
    `${BASE}/products?filter.term=${encodeURIComponent(term)}&filter.locationId=${encodeURIComponent(locationId)}&filter.limit=${limit}`,
    TTL.krogerProducts,
  );
}

export function productById(cfg: KrogerConfig, productId: string, locationId: string) {
  return get<any>(
    cfg,
    'kroger-products',
    `${BASE}/products/${encodeURIComponent(productId)}?filter.locationId=${encodeURIComponent(locationId)}`,
    TTL.krogerProducts,
  );
}
