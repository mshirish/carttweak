/**
 * Disk cache for upstream API responses: data/cache/<namespace>/<sha1>.json.
 *  - fresh (age < TTL): served without a live call
 *  - expired or missing: live call; success overwrites the cache
 *  - live call fails (network error, 429, 5xx): serve the cached copy if any,
 *    marked stale with its retrievedAt; otherwise throw UpstreamError
 * 4xx responses other than 429 are returned as-is (not cached, no fallback).
 * Bodies are redacted before they are written.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { publicUrl, redact } from './secrets.ts';

export const HOUR = 3600_000;
export const TTL = {
  krogerProducts: 12 * HOUR, // prices
  krogerLocations: 24 * HOUR,
  fdc: 7 * 24 * HOUR,
} as const;

export interface Fetched<T = any> {
  status: number;
  ok: boolean;
  body: T;
  retrievedAt: string;
  fromCache: boolean;
  stale: boolean;
  /** public source URL (no secrets) */
  sourceUrl: string;
}

export class UpstreamError extends Error {
  constructor(
    public service: string,
    public status: number | null,
    message: string,
  ) {
    super(message);
  }
}

export const cacheStats = { hits: 0, misses: 0, liveCalls: 0, staleServed: 0, writes: 0 };

let cacheRoot = path.resolve('data', 'cache');
export function setCacheRoot(dir: string): void {
  cacheRoot = dir;
}
let now = () => Date.now();
export function setClock(fn: () => number): void {
  now = fn;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchFn = (u, i) => fetch(u, i);
export function setFetch(fn: FetchFn): void {
  fetchImpl = fn;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fileFor(namespace: string, key: string): string {
  const h = createHash('sha1').update(key).digest('hex');
  return path.join(cacheRoot, namespace, `${h}.json`);
}

interface Entry {
  key: string;
  retrievedAt: string;
  status: number;
  body: unknown;
}

function readEntry(file: string): Entry | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Entry;
  } catch {
    return null;
  }
}

/**
 * GET (or other) with cache. `url` may contain secrets (api_key); the cache key
 * and stored source URL use publicUrl(url). `cacheKeyExtra` separates entries
 * that share a URL (e.g. different auth scopes).
 */
export async function cachedJson<T = any>(
  namespace: string,
  url: string,
  /** request init, or a lazy factory (e.g. needs an auth token) called only for a live call */
  init: RequestInit | (() => Promise<RequestInit>),
  ttlMs: number,
  opts: { service: string; retries?: number } = { service: namespace },
): Promise<Fetched<T>> {
  const sourceUrl = publicUrl(url);
  const file = fileFor(namespace, sourceUrl);
  const cached = readEntry(file);
  if (cached && now() - Date.parse(cached.retrievedAt) < ttlMs) {
    cacheStats.hits++;
    return { status: cached.status, ok: true, body: cached.body as T, retrievedAt: cached.retrievedAt, fromCache: true, stale: false, sourceUrl };
  }
  cacheStats.misses++;
  let lastErr = '';
  let res: Response | null = null;
  let text = '';
  const retries = opts.retries ?? 2;
  let reqInit: RequestInit;
  try {
    reqInit = typeof init === 'function' ? await init() : init;
  } catch (e: any) {
    // live call impossible (e.g. auth failed): stale cache or error
    if (cached) {
      cacheStats.staleServed++;
      return { status: cached.status, ok: true, body: cached.body as T, retrievedAt: cached.retrievedAt, fromCache: true, stale: true, sourceUrl };
    }
    throw new UpstreamError(opts.service, e?.status ?? null, `${opts.service} unavailable (${redact(String(e?.message ?? e))}) and nothing cached`);
  }
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      cacheStats.liveCalls++;
      res = await fetchImpl(url, reqInit);
      text = await res.text();
      if (res.status !== 429 && res.status < 500) break;
      lastErr = `HTTP ${res.status}`;
    } catch (e: any) {
      res = null;
      lastErr = e?.message ?? String(e);
    }
    if (attempt < retries) await sleep(500 * (attempt + 1));
  }
  const failed = !res || res.status === 429 || res.status >= 500;
  if (failed) {
    if (cached) {
      cacheStats.staleServed++;
      return { status: cached.status, ok: true, body: cached.body as T, retrievedAt: cached.retrievedAt, fromCache: true, stale: true, sourceUrl };
    }
    throw new UpstreamError(opts.service, res?.status ?? null, `${opts.service} unavailable (${redact(lastErr)}) and nothing cached`);
  }
  let body: any = text;
  try {
    body = JSON.parse(redact(text));
  } catch {
    body = redact(text);
  }
  const retrievedAt = new Date(now()).toISOString();
  if (res!.ok) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ key: sourceUrl, retrievedAt, status: res!.status, body } satisfies Entry));
    cacheStats.writes++;
  }
  return { status: res!.status, ok: res!.ok, body, retrievedAt, fromCache: false, stale: false, sourceUrl };
}
