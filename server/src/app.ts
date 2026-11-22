// HTTP layer. Every JSON response passes a secret check before it leaves.
import { Hono } from 'hono';
import type { Context } from 'hono';
import { UpstreamError } from './cache.ts';
import { containsSecret, redact } from './secrets.ts';
import { ServiceError, type Service } from './service.ts';

function send(c: Context, status: number, payload: unknown) {
  const text = JSON.stringify(payload);
  if (containsSecret(text)) {
    return c.body(JSON.stringify({ error: { code: 'internal', message: 'response withheld: contained a secret' } }), 500, { 'Content-Type': 'application/json' });
  }
  return c.body(text, status as any, { 'Content-Type': 'application/json' });
}

export function createApp(svc: Service, config: { kroger: boolean; fdc: boolean }) {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof ServiceError) return send(c, err.status, { error: { code: err.code, message: redact(err.message) } });
    if (err instanceof UpstreamError) {
      return send(c, 503, { error: { code: `${err.service}_unavailable`, message: redact(err.message), upstreamStatus: err.status } });
    }
    if (err instanceof SyntaxError) return send(c, 400, { error: { code: 'bad_json', message: 'request body is not valid JSON' } });
    console.error(redact(String((err as any)?.stack ?? err)));
    return send(c, 500, { error: { code: 'internal', message: 'internal error' } });
  });
  app.notFound((c) => send(c, 404, { error: { code: 'not_found', message: `no route ${c.req.method} ${c.req.path}` } }));

  app.get('/api/health', (c) => send(c, 200, { ok: true, config }));

  app.get('/api/locations', async (c) => send(c, 200, await svc.stores(String(c.req.query('zip') ?? ''))));

  app.get('/api/products/search', async (c) => {
    const term = String(c.req.query('term') ?? '');
    const locationId = String(c.req.query('locationId') ?? '');
    const s = await svc.search(term, locationId);
    const results = await Promise.all(s.normalized.map((n) => svc.enrich(n)));
    return send(c, 200, {
      branch: s.branch,
      term: s.term,
      usedTerm: s.usedTerm,
      retrievedAt: s.retrievedAt,
      stale: s.stale,
      resolution: {
        status: s.resolution.status,
        method: s.resolution.method ?? null,
        chosenRef: s.resolution.chosen?.product.ref ?? null,
        candidateRefs: s.resolution.candidates.map((x) => x.product.ref),
        detail: s.resolution.detail,
      },
      results,
    });
  });

  app.get('/api/products/:upc', async (c) => {
    const locationId = String(c.req.query('locationId') ?? '');
    return send(c, 200, await svc.byUpc(c.req.param('upc'), locationId));
  });

  app.post('/api/candidates', async (c) => {
    const body: any = await c.req.json();
    const locationId = String(body?.locationId ?? '');
    const ref = body?.item?.upc ?? body?.item?.productId ?? body?.upc ?? body?.productId;
    if (!ref) throw new ServiceError(400, 'bad_item', 'item.upc or item.productId is required');
    const item = await svc.byUpc(String(ref), locationId);
    const r = await svc.candidatesFor(item.product, locationId);
    return send(c, 200, { item, ...r });
  });

  app.post('/api/plan', async (c) => send(c, 200, await svc.plan(await c.req.json())));

  return app;
}
