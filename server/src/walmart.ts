/**
 * Walmart Affiliate API (walmart.io, read 2026-11-22). Signing lives here only.
 *
 * Every request carries:
 *   WM_CONSUMER.ID           consumer id (UUID from the walmart.io dashboard)
 *   WM_CONSUMER.INTIMESTAMP  Unix epoch milliseconds
 *   WM_SEC.KEY_VERSION       private key version
 *   WM_SEC.AUTH_SIGNATURE    base64(RSA-SHA256(privateKey, canonical))
 * canonical = the three header VALUES in header-name order, each + "\n":
 *   consumerId + "\n" + timestamp + "\n" + keyVersion + "\n"
 * A signature is valid for 180 s, so it is generated per live call (lazily, after a cache miss).
 * Headers and the key are never logged.
 *
 * Endpoints (base https://developer.api.walmart.com/api-proxy/service/affil/product/v2):
 *   /items?upc=|gtin=|ids=  [&zipCode=]   price + availability depend on zipCode (docs: default San Bruno, CA)
 *   /search?query=&numItems<=25           online catalogue search
 *   /stores?zip=                           store locator
 */
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { cachedJson, HOUR, type Fetched } from './cache.ts';

export const WALMART_BASE = 'https://developer.api.walmart.com/api-proxy/service/affil/product/v2';
export const WALMART_TTL = { items: 12 * HOUR, search: 12 * HOUR, stores: 24 * HOUR } as const;

export interface WalmartConfig {
  consumerId: string;
  keyVersion: string;
  privateKey: KeyObject;
}

/** The exact string that is signed. */
export function walmartCanonical(consumerId: string, timestampMs: string, keyVersion: string): string {
  // header names sorted: WM_CONSUMER.ID < WM_CONSUMER.INTIMESTAMP < WM_SEC.KEY_VERSION
  return `${consumerId.trim()}\n${timestampMs.trim()}\n${keyVersion.trim()}\n`;
}

export function walmartSignature(privateKey: KeyObject, consumerId: string, timestampMs: string, keyVersion: string): string {
  const s = createSign('RSA-SHA256');
  s.update(walmartCanonical(consumerId, timestampMs, keyVersion), 'utf8');
  s.end();
  return s.sign(privateKey).toString('base64');
}

export function walmartHeaders(cfg: WalmartConfig, now = Date.now()): Record<string, string> {
  const ts = String(now);
  return {
    'WM_CONSUMER.ID': cfg.consumerId,
    'WM_CONSUMER.INTIMESTAMP': ts,
    'WM_SEC.KEY_VERSION': cfg.keyVersion,
    'WM_SEC.AUTH_SIGNATURE': walmartSignature(cfg.privateKey, cfg.consumerId, ts, cfg.keyVersion),
    Accept: 'application/json',
  };
}

/**
 * Load config from env. Returns null + a reason (never the key) when not configured.
 * WALMART_KEY_VERSION defaults to "1"; WALMART_PRIVATE_KEY_PATH to secrets/walmart_private_key.pem.
 */
export function loadWalmartConfig(env: NodeJS.ProcessEnv, defaultKeyPath: string): { config: WalmartConfig | null; reason: string | null } {
  const consumerId = env.WALMART_CONSUMER_ID?.trim() ?? '';
  const keyVersion = env.WALMART_KEY_VERSION?.trim() || '1';
  const keyPath = env.WALMART_PRIVATE_KEY_PATH?.trim() || defaultKeyPath;
  if (!consumerId) return { config: null, reason: 'WALMART_CONSUMER_ID is not set' };
  if (!existsSync(keyPath)) return { config: null, reason: 'private key file not found (WALMART_PRIVATE_KEY_PATH)' };
  try {
    const privateKey = createPrivateKey(readFileSync(keyPath));
    return { config: { consumerId, keyVersion, privateKey }, reason: null };
  } catch {
    return { config: null, reason: 'private key file could not be read as a PEM private key' };
  }
}

function get<T>(cfg: WalmartConfig, namespace: string, url: string, ttl: number): Promise<Fetched<T>> {
  // lazy: headers (and a fresh 180 s signature) only for live calls
  return cachedJson<T>(namespace, url, async () => ({ headers: walmartHeaders(cfg) }), ttl, { service: 'walmart' });
}

export function itemsByUpc(cfg: WalmartConfig, upc: string, zipCode?: string | null) {
  const q = new URLSearchParams({ upc });
  if (zipCode) q.set('zipCode', zipCode);
  return get<any>(cfg, 'walmart-items', `${WALMART_BASE}/items?${q}`, WALMART_TTL.items);
}

export function itemsByGtin(cfg: WalmartConfig, gtin: string, zipCode?: string | null) {
  const q = new URLSearchParams({ gtin });
  if (zipCode) q.set('zipCode', zipCode);
  return get<any>(cfg, 'walmart-items', `${WALMART_BASE}/items?${q}`, WALMART_TTL.items);
}

export function itemsByIds(cfg: WalmartConfig, ids: string[], zipCode?: string | null) {
  const q = new URLSearchParams({ ids: ids.slice(0, 20).join(',') });
  if (zipCode) q.set('zipCode', zipCode);
  return get<any>(cfg, 'walmart-items', `${WALMART_BASE}/items?${q}`, WALMART_TTL.items);
}

export function search(cfg: WalmartConfig, query: string, opts: { numItems?: number; zipCode?: string | null } = {}) {
  const q = new URLSearchParams({ query, numItems: String(Math.min(25, opts.numItems ?? 10)) });
  // zipCode is not documented for search; only sent when explicitly asked (the probe tests it)
  if (opts.zipCode) q.set('zipCode', opts.zipCode);
  return get<any>(cfg, 'walmart-search', `${WALMART_BASE}/search?${q}`, WALMART_TTL.search);
}

/** Live availability check: never cached, no stale fallback. */
export function ping(cfg: WalmartConfig) {
  const url = `${WALMART_BASE}/search?query=milk&numItems=1`;
  return cachedJson<any>('walmart-ping', url, async () => ({ headers: walmartHeaders(cfg) }), 0, { service: 'walmart', retries: 0, live: true });
}

export function stores(cfg: WalmartConfig, zip: string) {
  return get<any>(cfg, 'walmart-stores', `${WALMART_BASE}/stores?zip=${encodeURIComponent(zip)}`, WALMART_TTL.stores);
}
