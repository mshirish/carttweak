// The browser only ever talks to our server (/api, proxied by Vite). No keys here.
import type { Branch, DemoList, PlanProgress, PlanResponse, ResolveItem, Store } from './types.ts';

export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  } catch {
    throw new ApiError("Can't reach the CartTweak server. Is it running?", 'network', 0);
  }
  const j: any = await r.json().catch(() => null);
  if (!r.ok) throw new ApiError(j?.error?.message ?? `Request failed (HTTP ${r.status})`, j?.error?.code ?? 'http', r.status);
  return j as T;
}

export const api = {
  config: () =>
    call<{ defaultLocationId: string | null; defaultLocationSource: string | null; defaultBranch: Branch | null; demoList: boolean }>('/api/config'),
  stores: (zip: string) => call<{ stores: Store[]; dropped: Array<{ locationId: string; name: string; reasons: string[] }> }>(`/api/locations?zip=${encodeURIComponent(zip)}`),
  demoList: () => call<DemoList>('/api/demo-list'),
  resolve: (locationId: string, items: Array<{ id: string; query: string; quantity: number }>) =>
    call<{ branch: Branch; items: ResolveItem[] }>('/api/resolve', { method: 'POST', body: JSON.stringify({ locationId, items }) }),
  startPlan: (body: unknown) => call<{ jobId: string }>('/api/plan/jobs', { method: 'POST', body: JSON.stringify(body) }),
  pollPlan: (id: string) =>
    call<{ status: 'running' | 'done' | 'error'; progress: PlanProgress; result?: PlanResponse; error?: { code: string; message: string }; httpStatus?: number }>(
      `/api/plan/jobs/${encodeURIComponent(id)}`,
    ),
};

/** Start a plan job and poll until it finishes, reporting progress. */
export async function runPlan(body: unknown, onProgress: (p: PlanProgress) => void, signal?: AbortSignal): Promise<PlanResponse> {
  const { jobId } = await api.startPlan(body);
  for (;;) {
    if (signal?.aborted) throw new ApiError('cancelled', 'cancelled', 0);
    const j = await api.pollPlan(jobId);
    onProgress(j.progress);
    if (j.status === 'done') return j.result!;
    if (j.status === 'error') throw new ApiError(j.error?.message ?? 'Planning failed', j.error?.code ?? 'error', j.httpStatus ?? 500);
    await new Promise((r) => setTimeout(r, 300));
  }
}
