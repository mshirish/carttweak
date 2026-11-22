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

export const cacheStats = { hits: 0, misses: 0, liveCalls: 0, staleServed: 0, writes: 0, throttled: 0 };

/**
 * Adaptive concurrency limit per upstream service: starts at `max` (6),
 * halves on HTTP 429 (min 1), and creeps back up by 1 after 20 straight
 * successes. Only live calls take a slot; cache hits never wait.
 */
export class AdaptiveLimiter {
  limit: number;
  private active = 0;
  private queue: Array<() => void> = [];
  private streak = 0;
  /** last X-RateLimit-Remaining seen (api.data.gov sends it for FDC) */
  remaining: number | null = null;
  constructor(public readonly max = 6) {
    this.limit = max;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active + this.waking >= this.limit || this.queue.length) {
      const turn = new Promise<void>((r) => this.queue.push(r));
      this.next(); // a slot may already be free
      await turn;
      this.waking--;
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.next();
    }
  }
  private next() {
    // wake at most as many waiters as there are free slots
    let free = this.limit - this.active - this.waking;
    while (free-- > 0 && this.queue.length) {
      this.waking++;
      this.queue.shift()!();
    }
  }
  private waking = 0;
  on429() {
    this.limit = Math.max(1, Math.floor(this.limit / 2));
    this.streak = 0;
  }
  onOk() {
    if (++this.streak >= 20 && this.limit < this.max) {
      this.limit++;
      this.streak = 0;
      this.next();
    }
  }
  get inFlight() {
    return this.active;
  }
}

export const limiters: Record<string, AdaptiveLimiter> = {};
export function limiterFor(service: string): AdaptiveLimiter {
  return (limiters[service] ??= new AdaptiveLimiter(6));
}

/** Backoff for 429: Retry-After (seconds) if given, else 1 s, 2 s, 4 s, 8 s. */
export function backoffMs(attempt: number, retryAfter: string | null): number {
  const ra = Number(retryAfter);
  if (retryAfter && Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, 30_000);
  return Math.min(1000 * 2 ** attempt, 8000);
}
let sleepImpl = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export function setSleep(fn: (ms: number) => Promise<void>): void {
  sleepImpl = fn;
}

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
  const limiter = limiterFor(opts.service);
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
  // 429s get more patience than 5xx: up to 4 retries with backoff
  const maxAttempts = Math.max(retries, 4);
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    let throttled = false;
    let retryAfter: string | null = null;
    try {
      cacheStats.liveCalls++;
      res = await limiter.run(() => fetchImpl(url, reqInit));
      text = await res.text();
      const rem = res.headers?.get?.('x-ratelimit-remaining');
      if (rem != null && rem !== '') limiter.remaining = Number(rem);
      if (res.status === 429) {
        throttled = true;
        retryAfter = res.headers?.get?.('retry-after') ?? null;
        limiter.on429();
        cacheStats.throttled++;
      } else if (res.status < 500) {
        limiter.onOk();
        break;
      }
      lastErr = `HTTP ${res.status}`;
    } catch (e: any) {
      res = null;
      lastErr = e?.message ?? String(e);
    }
    if (!throttled && attempt >= retries) break;
    if (attempt < maxAttempts) await (throttled ? sleepImpl(backoffMs(attempt, retryAfter)) : sleep(500 * (attempt + 1)));
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
