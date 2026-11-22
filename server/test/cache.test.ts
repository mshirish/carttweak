import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cachedJson, HOUR, setCacheRoot, setClock, setFetch, TTL, UpstreamError } from '../src/cache.ts';
import { registerSecret } from '../src/secrets.ts';

let dir: string;
let t: number;
let calls: string[];

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'carttweak-cache-'));
  setCacheRoot(dir);
  t = Date.parse('2026-11-22T06:00:00Z');
  setClock(() => t);
  calls = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('disk cache', () => {
  it('TTLs: prices 12 h, FDC 7 days', () => {
    expect(TTL.krogerProducts).toBe(12 * HOUR);
    expect(TTL.fdc).toBe(7 * 24 * HOUR);
  });
  it('fresh entries are served without a live call; expired entries refetch', async () => {
    let n = 0;
    setFetch(async (u) => (calls.push(u), respond(200, { n: ++n })));
    const a = await cachedJson('k', 'https://x.test/a', {}, TTL.krogerProducts, { service: 'kroger' });
    expect(a).toMatchObject({ fromCache: false, stale: false, body: { n: 1 } });
    t += 11 * HOUR;
    const b = await cachedJson('k', 'https://x.test/a', {}, TTL.krogerProducts, { service: 'kroger' });
    expect(b).toMatchObject({ fromCache: true, stale: false, body: { n: 1 }, retrievedAt: a.retrievedAt });
    t += 2 * HOUR; // 13 h old
    const c = await cachedJson('k', 'https://x.test/a', {}, TTL.krogerProducts, { service: 'kroger' });
    expect(c).toMatchObject({ fromCache: false, body: { n: 2 } });
    expect(calls).toHaveLength(2);
  });
  it('failed live call -> cached copy marked stale, with its original retrievedAt', async () => {
    setFetch(async () => respond(200, { price: 3.29 }));
    const first = await cachedJson('k', 'https://x.test/p', {}, TTL.krogerProducts, { service: 'kroger', retries: 0 });
    t += 13 * HOUR;
    setFetch(async () => {
      throw new Error('ECONNRESET');
    });
    const s = await cachedJson('k', 'https://x.test/p', {}, TTL.krogerProducts, { service: 'kroger', retries: 0 });
    expect(s).toMatchObject({ stale: true, fromCache: true, body: { price: 3.29 }, retrievedAt: first.retrievedAt });
    setFetch(async () => respond(503, { error: 'down' }));
    expect((await cachedJson('k', 'https://x.test/p', {}, TTL.krogerProducts, { service: 'kroger', retries: 0 })).stale).toBe(true);
  });
  it('failed live call with nothing cached -> UpstreamError', async () => {
    setFetch(async () => respond(500, {}));
    await expect(cachedJson('k', 'https://x.test/none', {}, TTL.fdc, { service: 'fdc', retries: 0 })).rejects.toBeInstanceOf(UpstreamError);
  });
  it('lazy init failure (e.g. auth) -> stale cache, never a live call', async () => {
    setFetch(async () => respond(200, { ok: 1 }));
    await cachedJson('k', 'https://x.test/l', {}, 1, { service: 'kroger' });
    t += 10;
    setFetch(async (u) => (calls.push(u), respond(200, { ok: 2 })));
    const r = await cachedJson('k', 'https://x.test/l', async () => { throw new Error('auth failed'); }, 1, { service: 'kroger' });
    expect(r).toMatchObject({ stale: true, body: { ok: 1 } });
    expect(calls).toHaveLength(0);
  });
  it('4xx (not 429) is returned, not cached', async () => {
    setFetch(async () => respond(404, { error: 'nope' }));
    const r = await cachedJson('k', 'https://x.test/404', {}, TTL.krogerProducts, { service: 'kroger' });
    expect(r).toMatchObject({ status: 404, ok: false });
    expect(readdirSync(dir)).toHaveLength(0);
  });
  it('api_key never reaches the cache file or the source URL; secrets in bodies are redacted', async () => {
    registerSecret('CLIENT-ID-123456');
    setFetch(async () => respond(200, { productPageURI: '/p/x?cid=dis.api.t:CLIENT-ID-123456' }));
    const r = await cachedJson('fdc', 'https://api.test/foods?api_key=SECRETKEY&query=1', {}, TTL.fdc, { service: 'fdc' });
    expect(r.sourceUrl).toBe('https://api.test/foods?query=1');
    const files = readdirSync(path.join(dir, 'fdc'));
    const text = readFileSync(path.join(dir, 'fdc', files[0]!), 'utf8');
    expect(text).not.toContain('SECRETKEY');
    expect(text).not.toContain('CLIENT-ID-123456');
  });
});
