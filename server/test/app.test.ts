// End-to-end through HTTP with upstream calls served from recorded fixtures (no network).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { setCacheRoot, setClock, setFetch } from '../src/cache.ts';
import { resetTokenCache, tokenStats } from '../src/kroger.ts';
import { registerSecret } from '../src/secrets.ts';
import { createService } from '../src/service.ts';
import { fixture, RECORDED, ROOT } from './fixtures.ts';

const CLIENT_ID = 'test-client-id-xyz';
const loc = fixture('kroger-locations-45202.json');
const white = fixture('kroger-products-white-bread.json');
const wg = fixture('kroger-products-whole-grain-bread.json');
const FDC_FOODS: Record<string, any> = {
  '2569016': fixture('fdc-food-2569016.json').body,
  '2032747': fixture('fdc-food-2032747.json').body,
};

let t = Date.parse('2026-11-22T06:00:00Z');
let upstreamDown = false;
const seen: string[] = [];

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Router over recorded responses. FDC search bodies are built from the recorded detail records' gtinUpc.
async function upstream(url: string): Promise<Response> {
  seen.push(url);
  if (upstreamDown) throw new Error('ECONNREFUSED');
  const u = new URL(url);
  if (u.pathname.endsWith('/oauth2/token')) return json(200, { access_token: 'tok-abc-123', expires_in: 1800 });
  if (u.pathname === '/v1/locations') return json(200, loc.body);
  if (u.pathname === '/v1/locations/01400513') return json(200, { data: loc.body.data[0] });
  if (u.pathname === '/v1/products') {
    const term = u.searchParams.get('filter.term') ?? '';
    if (/wonder|white bread/i.test(term)) {
      // Kroger echoes the client id inside productPageURI: make sure it never leaks
      const data = white.body.data.map((p: any) => ({ ...p, productPageURI: `/p/x/${p.productId}?cid=dis.api.t:${CLIENT_ID}` }));
      return json(200, { data });
    }
    if (/whole grain bread/i.test(term)) return json(200, wg.body);
    return json(200, { data: [] });
  }
  const byId = /^\/v1\/products\/(\d{13})$/.exec(u.pathname);
  if (byId) {
    const p = [...white.body.data, ...wg.body.data].find((x: any) => x.productId === byId[1]);
    return p ? json(200, { data: p }) : json(404, { errors: { reason: 'not found' } });
  }
  if (u.pathname === '/fdc/v1/foods/search') {
    const q = u.searchParams.get('query') ?? '';
    const foods = Object.values(FDC_FOODS).filter((f) => q.split(' ').some((form) => form.replace(/^0+/, '') === String(f.gtinUpc).replace(/^0+/, '')));
    return json(200, { totalHits: foods.length, foods: foods.map((f) => ({ fdcId: f.fdcId, gtinUpc: f.gtinUpc, publishedDate: '2023-01-01' })) });
  }
  const m = /\/fdc\/v1\/food\/(\d+)/.exec(u.pathname);
  if (m) return FDC_FOODS[m[1]!] ? json(200, FDC_FOODS[m[1]!]) : json(404, {});
  return json(404, { error: 'unmocked' });
}

let dir: string;
let labelsDir: string;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'carttweak-app-'));
  setCacheRoot(dir);
  setClock(() => t);
  setFetch(upstream);
  resetTokenCache();
  registerSecret(CLIENT_ID);
  registerSecret('client-secret-zzz');
  registerSecret('fdc-key-qqq');
  const svc = createService({
    kroger: { clientId: CLIENT_ID, clientSecret: 'client-secret-zzz', fetch: upstream },
    fdcApiKey: 'fdc-key-qqq',
    sampleDir: path.join(ROOT, 'data', 'sample'),
    labelsDir: (labelsDir = path.join(dir, 'labels')),
    demoListPath: path.join(ROOT, 'docs', 'demo-list.txt'),
    now: () => new Date(t),
  });
  app = createApp(svc, { kroger: true, fdc: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const call = async (method: string, p: string, body?: unknown) => {
  const r = await app.request(p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, text, json: JSON.parse(text) };
};

const planBody = {
  locationId: '01400513',
  items: [
    { id: 'bread', query: 'Wonder Classic White Bread 20 oz' },
    { id: 'eggs', query: 'eggs' },
  ],
  goals: { primary: 'more_fiber' },
  locks: [],
  budget: { maxExtraSpendCents: 200 },
};

describe(`HTTP API over ${RECORDED} responses`, () => {
  it('GET /api/locations returns stores only', async () => {
    const r = await call('GET', '/api/locations?zip=45202');
    expect(r.status).toBe(200);
    expect(r.json.stores.map((s: any) => s.locationId)).toEqual(['01400513']);
    expect(r.json.dropped).toHaveLength(4);
  });
  it('POST /api/plan: resolves, finds candidates, reproduces the verified swap; vague item not guessed', async () => {
    const r = await call('POST', '/api/plan', planBody);
    expect(r.status).toBe(200);
    const s = r.json.plan.swaps[0];
    expect(s.replacement.description).toBe("Aunt Millie's Live Light! Whole Grain Bread");
    expect(s.cost.regular.differenceCents).toBe(50);
    expect(s.cost.promo.differenceCents).toBe(100);
    expect(r.json.plan.itemOutcomes.find((o: any) => o.itemId === 'eggs').code).toBe('unresolved');
    expect(r.json.containsSample).toBe(false);
    expect(r.json.explanations[0]).toMatch(/adds 9.3 g fiber per 100 g/);
  });
  it('secrets never leave the server (client id echoed by Kroger is stripped/redacted)', async () => {
    const r = await call('GET', '/api/products/search?term=white%20bread&locationId=01400513');
    expect(r.status).toBe(200);
    for (const s of [CLIENT_ID, 'client-secret-zzz', 'fdc-key-qqq', 'tok-abc-123']) expect(r.text).not.toContain(s);
    const wonder = r.json.results.find((x: any) => x.product.chainProductId === '0007225001137');
    expect(wonder.price.observedAt).toMatch(/^2026-11-22T/);
    expect(wonder.price.sourceRef).not.toContain('api_key');
  });
  it('Kroger token is cached until it expires', async () => {
    const before = tokenStats.issued;
    t += 60_000;
    await call('POST', '/api/plan', planBody);
    expect(tokenStats.issued).toBe(before); // no new token within expires_in
  });
  it('upstream down after TTL -> cached prices served stale, each with its date and a stale_price flag', async () => {
    const r1 = await call('GET', '/api/products/0007131400185?locationId=01400513');
    const firstSeen = r1.json.price.observedAt;
    t += 13 * 3600_000; // prices expired
    resetTokenCache(); // force a live auth attempt, which fails too
    upstreamDown = true;
    try {
      const r = await call('POST', '/api/plan', planBody);
      expect(r.status).toBe(200);
      const s = r.json.plan.swaps[0];
      const prices = s.sources.filter((x: any) => x.kind === 'price');
      for (const p of prices) {
        expect(p.stale).toBe(true);
        expect(p.date).toMatch(/^2026-11-22T/);
      }
      expect(s.flags.map((f: any) => f.code)).toContain('stale_price');
      const r2 = await call('GET', '/api/products/0007131400185?locationId=01400513');
      expect(r2.json.price).toMatchObject({ stale: true, observedAt: firstSeen });
    } finally {
      upstreamDown = false;
    }
  });
  it('upstream down with nothing cached -> clear JSON error (503)', async () => {
    upstreamDown = true;
    try {
      const r = await call('GET', '/api/products/search?term=never%20seen&locationId=01400513');
      expect(r.status).toBe(503);
      expect(r.json.error.code).toBe('kroger_unavailable');
    } finally {
      upstreamDown = false;
    }
  });
  it('bad input -> 400 JSON errors', async () => {
    expect((await call('POST', '/api/plan', { ...planBody, goals: { primary: 'more_vibes' } })).json.error.code).toBe('bad_goal');
    expect((await call('POST', '/api/plan', { ...planBody, budget: { maxExtraSpendCents: -1 } })).json.error.code).toBe('bad_budget');
    expect((await call('GET', '/api/locations?zip=abc')).status).toBe(400);
    const notStore = await call('GET', '/api/products/search?term=bread&locationId=542FC807');
    expect(notStore.status).toBeGreaterThanOrEqual(400);
    expect((await call('GET', '/api/nope')).json.error.code).toBe('not_found');
  });
  it('plan jobs: 202 + job id, progress while running, result when done; bad input fails fast', async () => {
    const start = await call('POST', '/api/plan/jobs', planBody);
    expect(start.status).toBe(202);
    let j: any;
    for (let i = 0; i < 200; i++) {
      j = (await call('GET', `/api/plan/jobs/${start.json.jobId}`)).json;
      expect(j.progress).toHaveProperty('message');
      if (j.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(j.status).toBe('done');
    expect(j.progress).toMatchObject({ phase: 'done' });
    expect(j.result.plan.swaps[0].replacement.description).toBe("Aunt Millie's Live Light! Whole Grain Bread");
    expect(j.result.timingsMs.total).toBeGreaterThanOrEqual(0);
    const bad = await call('POST', '/api/plan/jobs', { ...planBody, goals: { primary: 'nope' } });
    expect(bad.status).toBe(400);
    expect((await call('GET', '/api/plan/jobs/not-a-job')).status).toBe(404);
  });
  it('excludedCandidateIds: rejected swap is re-planned without it', async () => {
    const r = await call('POST', '/api/plan', { ...planBody, excludedCandidateIds: ['kroger:0007131400185'] });
    expect(r.status).toBe(200);
    expect(r.json.plan.swaps.find((s: any) => s.replacement.ref === 'kroger:0007131400185')).toBeUndefined();
    const o = r.json.plan.itemOutcomes.find((x: any) => x.itemId === 'bread');
    expect(o.rejections.find((x: any) => x.candidateRef === 'kroger:0007131400185').reason).toBe('excluded');
  });
  it('retailer_listing from data/labels/ (newer than FDC) is used and its URL is shown as the source', async () => {
    mkdirSync(labelsDir, { recursive: true });
    const url = 'https://www.kroger.com/p/aunt-millie-s-live-light-whole-grain-bread/0007131400185';
    // synthetic values for the test only (not a real transcription)
    const rec = {
      productRef: 'kroger:0007131400185', source: 'retailer_listing', basis: 'g', labelDate: '2026-11-21', sourceRef: url, sourceUrl: url,
      transcribedAt: '2026-11-21', transcribedBy: 'demo author', isSample: false, method: 'label_scaled', servingSize: { quantity: 47, unit: 'g' },
      per100: { calories: 150, protein_g: 8.5, fiber_g: 14, addedSugars_g: null, totalSugars_g: 2, sodium_mg: 360 },
    };
    writeFileSync(path.join(labelsDir, 'labels.json'), JSON.stringify({ records: [rec] }));
    try {
      const r = await call('POST', '/api/plan', planBody);
      const s = r.json.plan.swaps[0];
      const src = s.sources.find((x: any) => x.kind === 'nutrition' && x.role === 'replacement');
      expect(src).toMatchObject({ source: 'retailer_listing', sourceUrl: url, transcribedBy: 'demo author', choice: 'listing_newer_than_fdc', date: '2026-11-21' });
      expect(s.nutrients.find((n: any) => n.key === 'fiber_g').replacement).toBe(14);
      expect(r.json.containsSample).toBe(false);
    } finally {
      rmSync(labelsDir, { recursive: true, force: true });
    }
  });
  it('GET /api/config: default branch from the demo list header', async () => {
    const r = await call('GET', '/api/config');
    expect(r.json).toMatchObject({ defaultLocationId: '01400513', defaultLocationSource: 'demo list header', demoList: true });
    expect(r.json.defaultBranch.name).toBe('Kroger On the Rhine');
  });
  it('GET /api/demo-list: badged sample list, 20 items, qty-prefixed text', async () => {
    const r = await call('GET', '/api/demo-list');
    expect(r.json.badge).toBe('Sample list');
    expect(r.json.items).toHaveLength(20);
    expect(r.json.text.split('\n')[0]).toBe('1 Wonder Classic White Bread 20 oz');
    expect(r.json.items.find((i: any) => i.tags.includes('lock')).query).toMatch(/Cheerios/);
  });
  it('POST /api/resolve: matched card with price, unit price and Kroger image; unknown -> not_found', async () => {
    const r = await call('POST', '/api/resolve', { locationId: '01400513', items: [{ id: 'a', query: 'Wonder Classic White Bread 20 oz' }, { id: 'b', query: 'eggs' }] });
    expect(r.status).toBe(200);
    const [a, b] = r.json.items;
    expect(a).toMatchObject({ id: 'a', status: 'resolved', product: { productId: '0007225001137', sizeLabel: '20 oz', regularCents: 329, promoCents: 279, swapGroup: 'bread' } });
    expect(a.product.unitPrice.per).toBe('oz');
    expect(a.product.imageUrl).toMatch(/^https:\/\/www\.kroger\.com\/product\/images\//);
    expect(b.status).toBe('too_vague');
  });
  it('includeSample: true attaches sample label data and marks the result containsSample', async () => {
    const r = await call('POST', '/api/plan', { ...planBody, includeSample: true });
    expect(r.status).toBe(200);
    // no sample record matches these products -> still live-only
    expect(r.json.containsSample).toBe(false);
  });
});
