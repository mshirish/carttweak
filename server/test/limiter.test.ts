import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AdaptiveLimiter, backoffMs, cachedJson, limiterFor, setCacheRoot, setClock, setFetch, setSleep } from '../src/cache.ts';

describe('AdaptiveLimiter', () => {
  it('never runs more than the limit (6) at once', async () => {
    const l = new AdaptiveLimiter(6);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 40 }, () =>
        l.run(async () => {
          peak = Math.max(peak, ++active);
          await new Promise((r) => setTimeout(r, 2));
          active--;
        }),
      ),
    );
    expect(peak).toBe(6);
  });
  it('halves on 429 (min 1) and recovers by 1 after 20 straight successes', () => {
    const l = new AdaptiveLimiter(6);
    l.on429();
    expect(l.limit).toBe(3);
    l.on429();
    l.on429();
    l.on429();
    expect(l.limit).toBe(1);
    for (let i = 0; i < 20; i++) l.onOk();
    expect(l.limit).toBe(2);
  });
  it('respects a lowered limit', async () => {
    const l = new AdaptiveLimiter(6);
    l.on429(); // 3
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 12 }, () => l.run(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
    })));
    expect(peak).toBe(3);
  });
  it('backoff: Retry-After seconds, else 1 s, 2 s, 4 s, 8 s cap', () => {
    expect(backoffMs(0, '3')).toBe(3000);
    expect(backoffMs(0, null)).toBe(1000);
    expect(backoffMs(2, null)).toBe(4000);
    expect(backoffMs(9, null)).toBe(8000);
  });
});

describe('cachedJson backs off on 429', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  it('retries after Retry-After, lowers the service limit, then succeeds', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'carttweak-429-'));
    setCacheRoot(dir);
    setClock(() => Date.parse('2026-11-22T06:00:00Z'));
    const slept: number[] = [];
    setSleep(async (ms) => void slept.push(ms));
    let n = 0;
    setFetch(async () =>
      ++n <= 2
        ? new Response('{}', { status: 429, headers: { 'Retry-After': '2' } })
        : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'X-RateLimit-Remaining': '512' } }),
    );
    const r = await cachedJson('t', 'https://x.test/throttled', {}, 1000, { service: 'svc429' });
    expect(r.body).toEqual({ ok: true });
    expect(slept).toEqual([2000, 2000]);
    expect(limiterFor('svc429').limit).toBe(1); // 6 -> 3 -> 1
    expect(limiterFor('svc429').remaining).toBe(512);
  });
});
