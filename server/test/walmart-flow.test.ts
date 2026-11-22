// Walmart (second chain) + receipt matching through HTTP, with upstreams mocked.
// Walmart responses are SYNTHETIC (shaped like the walmart.io docs sample; Walmart auth
// returned 401 live, so no recorded Walmart data exists). FDC records are recorded live 2026-11-22.
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeWalmartItem, receiptPrice } from '../src/normalize.ts';
import { createApp } from '../src/app.ts';
import { setCacheRoot, setClock, setFetch } from '../src/cache.ts';
import { resetTokenCache } from '../src/kroger.ts';
import { createService, krogerIdFromGtin14 } from '../src/service.ts';
import { fixture, ROOT } from './fixtures.ts';

const FDC: Record<string, any> = { '2569016': fixture('fdc-food-2569016.json').body, '2032747': fixture('fdc-food-2032747.json').body };
const white = fixture('kroger-products-white-bread.json');
const wg = fixture('kroger-products-whole-grain-bread.json');
const loc = fixture('kroger-locations-45202.json');

// synthetic Walmart catalogue (fictional item ids; UPCs chosen so the recorded FDC records apply)
const WM_ITEMS: Record<string, any> = {
  '900001': { itemId: 900001, name: 'SAMPLE Classic White Bread, 20 oz', brandName: 'SampleBrand', upc: '072250011372', salePrice: 2.98, size: '20 oz', categoryPath: 'Food/Bread & Bakery/Sliced Bread', stock: 'Available' },
  '900002': { itemId: 900002, name: 'SAMPLE Whole Grain Bread, 20 oz', brandName: 'SampleGrain', upc: '071314001854', salePrice: 3.48, size: null, categoryPath: 'Food/Bread & Bakery/Sliced Bread', stock: 'Available' },
};

let walmartUp = true;
const zipSeen: string[] = [];
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
async function upstream(url: string, init?: RequestInit): Promise<Response> {
  const u = new URL(url);
  if (u.hostname === 'developer.api.walmart.com') {
    const h = new Headers(init?.headers as any);
    for (const k of ['WM_CONSUMER.ID', 'WM_CONSUMER.INTIMESTAMP', 'WM_SEC.KEY_VERSION', 'WM_SEC.AUTH_SIGNATURE']) if (!h.get(k)) return json(400, { error: `missing ${k}` });
    if (!walmartUp) return json(401, { details: { Description: 'Public Key not found for  Consumer id : x' } });
    if (u.searchParams.get('zipCode')) zipSeen.push(u.searchParams.get('zipCode')!);
    if (u.pathname.endsWith('/search')) return json(200, { query: u.searchParams.get('query'), items: Object.values(WM_ITEMS) });
    if (u.pathname.endsWith('/items')) {
      const ids = u.searchParams.get('ids');
      if (ids) return json(200, { items: ids.split(',').map((i) => WM_ITEMS[i]).filter(Boolean) });
      const upc = u.searchParams.get('upc');
      return json(200, { items: Object.values(WM_ITEMS).filter((i) => i.upc === upc) });
    }
    return json(404, {});
  }
  if (u.pathname.endsWith('/oauth2/token')) return json(200, { access_token: 'tok-w', expires_in: 1800 });
  if (u.pathname === '/v1/locations/01400513') return json(200, { data: loc.body.data[0] });
  const byId = /^\/v1\/products\/(\d{13})$/.exec(u.pathname);
  if (byId) {
    const p = [...white.body.data, ...wg.body.data].find((x: any) => x.productId === byId[1]);
    return p ? json(200, { data: p }) : json(404, {});
  }
  if (u.pathname === '/v1/products') return json(200, /whole grain bread/i.test(u.searchParams.get('filter.term') ?? '') ? wg.body : { data: [] });
  if (u.pathname === '/fdc/v1/foods/search') {
    const forms = (u.searchParams.get('query') ?? '').split(' ').map((f) => f.replace(/^0+/, ''));
    const foods = Object.values(FDC).filter((f) => forms.includes(String(f.gtinUpc).replace(/^0+/, '')));
    return json(200, { foods: foods.map((f) => ({ fdcId: f.fdcId, gtinUpc: f.gtinUpc, publishedDate: '2023-01-01' })) });
  }
  const m = /\/fdc\/v1\/food\/(\d+)/.exec(u.pathname);
  if (m) return FDC[m[1]!] ? json(200, FDC[m[1]!]) : json(404, {});
  return json(404, { error: 'unmocked' });
}

let dir: string;
let app: ReturnType<typeof createApp>;
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'carttweak-wm-'));
  setCacheRoot(dir);
  setClock(() => Date.parse('2026-11-22T12:00:00Z'));
  setFetch(upstream as any);
  resetTokenCache();
  // throwaway key for the test, never the real one
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const svc = createService({
    kroger: { clientId: 'cid-x', clientSecret: 'sec-x', fetch: upstream as any },
    fdcApiKey: 'fdc-x',
    sampleDir: path.join(ROOT, 'data', 'sample'),
    labelsDir: path.join(dir, 'labels'),
    walmart: { consumerId: '00000000-0000-4000-8000-000000000000', keyVersion: '1', privateKey },
  });
  app = createApp(svc, { kroger: true, fdc: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const call = async (method: string, p: string, body?: unknown) => {
  const r = await app.request(p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json()) as any };
};

describe('Walmart normalization', () => {
  const meta = { observedAt: '2026-11-22T12:00:00Z', sourceRef: 'https://developer.api.walmart.com/x', stale: false };
  it('walmart_api price for a ZIP; gtin14 from the UPC (which includes its check digit); size from field or name', () => {
    const n = normalizeWalmartItem(WM_ITEMS['900001'], '45202', meta);
    expect(n.product).toMatchObject({ chain: 'walmart', ref: 'walmart:900001', gtin14: '00072250011372', categories: ['Food', 'Bread & Bakery', 'Sliced Bread'] });
    expect(n.product.size!.label).toBe('20 oz');
    expect(n.price).toMatchObject({ source: 'walmart_api', regularCents: 298, promoCents: null, branch: { chain: 'walmart', name: 'Walmart.com (ZIP 45202)' } });
    expect(normalizeWalmartItem(WM_ITEMS['900002'], '45202', meta).product.size!.label).toBe('20 oz'); // from the name
  });
  it('receipt price is its own observation (source receipt), labelled with store and date', () => {
    const p = receiptPrice('walmart:900001', { cents: 248, date: '2026-02-03', storeNumber: '01711', quantity: 1 });
    expect(p).toMatchObject({ source: 'receipt', regularCents: 248, observedAt: '2026-02-03', branch: { name: 'Walmart #1711' } });
  });
  it('Kroger id from a GTIN-14: drop the check digit, pad to 13', () => {
    expect(krogerIdFromGtin14('00072250011372')).toBe('0007225001137');
  });
});

describe('receipt matching (matchMethod labels)', () => {
  it('barcode via Walmart lookup when Walmart works; produce and unknown codes are kept as unmatched', async () => {
    walmartUp = true;
    const r = await call('POST', '/api/receipt/match', {
      zip: '45202',
      items: [
        { id: 'a', name: 'SAMPLE WHT BRD', code: '007225001137' },
        { id: 'b', name: 'BANANAS', code: '000000004011' },
        { id: 'c', name: 'SAMPLE THING', code: '012345600011' },
      ],
    });
    expect(r.json.walmart.available).toBe(true);
    const [a, b, c] = r.json.items;
    expect(a).toMatchObject({ status: 'matched', matchMethod: 'barcode', via: 'walmart', product: { walmartItemId: '900001', krogerProductId: '0007225001137' } });
    expect(b).toMatchObject({ status: 'unmatched', matchMethod: 'unmatched', reason: 'produce (PLU code, no barcode)' });
    // no barcode match -> Walmart search candidates for the shopper to pick; never auto-picked
    expect(c).toMatchObject({ status: 'needs_confirm', matchMethod: 'unmatched' });
    expect(c.candidates.length).toBeGreaterThan(0);
    expect(c.product).toBeUndefined();
  });
  it('Walmart down: barcode via FDC by GTIN still works; status says why', async () => {
    walmartUp = false;
    // a fresh service so the status cache does not carry over
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const svc = createService({ kroger: { clientId: 'cid-x', clientSecret: 'sec-x', fetch: upstream as any }, fdcApiKey: 'fdc-x', sampleDir: path.join(ROOT, 'data', 'sample'), walmart: { consumerId: 'c', keyVersion: '1', privateKey } });
    const r = await svc.matchReceipt({ zip: '45202', items: [{ id: 'a', name: 'WHT BRD', code: '007225001137' }, { id: 'c', name: 'X', code: '012345600011' }] });
    expect(r.walmart).toMatchObject({ available: false });
    expect(r.walmart.reason).toMatch(/HTTP 401/);
    expect(r.items[0]).toMatchObject({ status: 'matched', matchMethod: 'barcode', via: 'fdc', product: { fdcId: 2569016, krogerProductId: '0007225001137' } });
    expect(r.items[1]).toMatchObject({ status: 'unmatched', matchMethod: 'unmatched' });
    walmartUp = true;
  });
});

describe('Walmart plan + Walmart-down fallback', () => {
  const body = {
    chain: 'walmart',
    zip: '45202',
    items: [{ id: 'r01', walmartItemId: '900001', quantity: 1, paid: { cents: 248, date: '2026-02-03', storeNumber: '01711' } }],
    goals: { primary: 'more_fiber' },
    budget: { maxExtraSpendCents: 200 },
  };
  it('plans at Walmart.com for the receipt ZIP; cost uses CURRENT walmart_api prices; paid price kept separate', async () => {
    walmartUp = true;
    const r = await call('POST', '/api/plan', body);
    expect(r.status).toBe(200);
    expect(r.json.chain).toBe('walmart');
    const s = r.json.plan.swaps[0];
    expect(s.replacement.ref).toBe('walmart:900002');
    expect(s.cost.regular.differenceCents).toBe(348 - 298); // current prices, same source
    expect(s.sources.filter((x: any) => x.kind === 'price').map((x: any) => x.source)).toEqual(['walmart_api', 'walmart_api']);
    expect(r.json.paid.r01).toMatchObject({ source: 'receipt', regularCents: 248 });
    expect(zipSeen).toContain('45202');
  });
  it("Walmart unavailable -> clear 503 'We can't check Walmart's current prices right now'", async () => {
    walmartUp = false;
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const svc = createService({ kroger: { clientId: 'cid-x', clientSecret: 'sec-x', fetch: upstream as any }, fdcApiKey: 'fdc-x', sampleDir: path.join(ROOT, 'data', 'sample'), walmart: { consumerId: 'c', keyVersion: '1', privateKey } });
    const a = createApp(svc, { kroger: true, fdc: true });
    const r = await a.request('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).error.message).toMatch(/We can't check Walmart's current prices right now/);
    walmartUp = true;
  });
  it('fallback: the same receipt items planned at the Kroger demo branch, paid Walmart price shown as context only', async () => {
    const r = await call('POST', '/api/plan', {
      locationId: '01400513',
      items: [{ id: 'r01', productId: '0007225001137', quantity: 1, paid: { cents: 248, date: '2026-02-03', storeNumber: '01711' } }],
      goals: { primary: 'more_fiber' },
      budget: { maxExtraSpendCents: 200 },
    });
    expect(r.status).toBe(200);
    expect(r.json.chain).toBe('kroger');
    const s = r.json.plan.swaps[0];
    expect(s.cost.regular.originalCents).toBe(329); // Kroger's current price, not the $2.48 paid at Walmart
    expect(r.json.paid.r01).toMatchObject({ source: 'receipt', regularCents: 248, branch: { name: 'Walmart #1711' } });
  });
});

describe('display helpers for FDC matches and receipt prices', () => {
  it('no repeated brand; GS1 units made readable; store "00000" is not lost', async () => {
    const { fdcDisplayName, prettyPackageWeight } = await import('../src/normalize.ts');
    expect(fdcDisplayName('Jif', 'Jif 16 Ounce Creamy Peanut Butter')).toBe('Jif 16 Ounce Creamy Peanut Butter');
    expect(fdcDisplayName('WONDER', 'CLASSIC WHITE BREAD')).toBe('WONDER CLASSIC WHITE BREAD');
    expect(prettyPackageWeight('144.0 OZA')).toBe('144 fl oz');
    expect(prettyPackageWeight('16 ONZ')).toBe('16 oz');
    expect(receiptPrice('x', { cents: 1, date: null, storeNumber: '00000', quantity: 1 }).branch.name).toBe('Walmart #0');
    expect(receiptPrice('x', { cents: 1, date: null, storeNumber: '01711', quantity: 1 }).branch.name).toBe('Walmart #1711');
  });
});
