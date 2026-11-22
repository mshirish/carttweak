// HTTP layer. Every JSON response passes a secret check before it leaves.
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { UpstreamError } from './cache.ts';
import { containsSecret, redact } from './secrets.ts';
import { ServiceError, type PlanProgress, type Service } from './service.ts';

function errorPayload(err: unknown): { status: number; error: { code: string; message: string; upstreamStatus?: number | null } } {
  if (err instanceof ServiceError) return { status: err.status, error: { code: err.code, message: redact(err.message) } };
  if (err instanceof UpstreamError) return { status: 503, error: { code: `${err.service}_unavailable`, message: redact(err.message), upstreamStatus: err.status } };
  if (err instanceof SyntaxError) return { status: 400, error: { code: 'bad_json', message: 'request body is not valid JSON' } };
  console.error(redact(String((err as any)?.stack ?? err)));
  return { status: 500, error: { code: 'internal', message: 'internal error' } };
}

interface Job {
  id: string;
  status: 'running' | 'done' | 'error';
  progress: PlanProgress;
  startedAt: number;
  finishedAt: number | null;
  result: unknown;
  error: { status: number; error: { code: string; message: string } } | null;
}
const JOB_TTL_MS = 15 * 60_000;

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
    const e = errorPayload(err);
    return send(c, e.status, { error: e.error });
  });
  app.notFound((c) => send(c, 404, { error: { code: 'not_found', message: `no route ${c.req.method} ${c.req.path}` } }));

  app.get('/api/health', (c) => send(c, 200, { ok: true, config }));
  app.get('/api/config', async (c) => send(c, 200, await svc.config()));
  app.get('/api/demo-list', (c) => send(c, 200, svc.demoList()));
  app.post('/api/resolve', async (c) => send(c, 200, await svc.resolveList(await c.req.json())));

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

  // Plan jobs: POST returns a job id at once; GET reports progress ("Checking prices 12/20…") and, when done, the result.
  const jobs = new Map<string, Job>();
  const sweep = () => {
    const now = Date.now();
    for (const [id, j] of jobs) if (now - j.startedAt > JOB_TTL_MS) jobs.delete(id);
  };
  app.post('/api/plan/jobs', async (c) => {
    sweep();
    const body = await c.req.json();
    svc.validatePlan(body); // 400s fail fast, before a job exists
    const job: Job = {
      id: randomUUID(),
      status: 'running',
      progress: { phase: 'store', done: 0, total: 1, message: 'Starting…' },
      startedAt: Date.now(),
      finishedAt: null,
      result: null,
      error: null,
    };
    jobs.set(job.id, job);
    svc
      .plan(body, (p) => (job.progress = p))
      .then((r) => {
        job.result = r;
        job.status = 'done';
      })
      .catch((e) => {
        job.error = errorPayload(e);
        job.status = 'error';
      })
      .finally(() => (job.finishedAt = Date.now()));
    return send(c, 202, { jobId: job.id, poll: `/api/plan/jobs/${job.id}` });
  });
  app.get('/api/plan/jobs/:id', (c) => {
    const job = jobs.get(c.req.param('id'));
    if (!job) return send(c, 404, { error: { code: 'job_not_found', message: 'unknown or expired job id' } });
    return send(c, 200, {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
      ...(job.status === 'done' ? { result: job.result } : {}),
      ...(job.status === 'error' ? { error: job.error!.error, httpStatus: job.error!.status } : {}),
    });
  });

  return app;
}
