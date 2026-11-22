// fetch wrapper: retries 429/5xx, saves every response (redacted) to data/raw/<run>/.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { redact } from './redact.ts';

export interface HttpResult<T = unknown> {
  status: number;
  ok: boolean;
  body: T;
  rawPath: string | null;
  retrievedAt: string;
}

let rawDir: string | null = null;
let seq = 0;

export function initRawDir(dir: string): void {
  rawDir = dir;
  mkdirSync(dir, { recursive: true });
}

function slug(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60).toLowerCase();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function httpJson<T = any>(
  url: string,
  init: RequestInit & { label: string; save?: boolean },
): Promise<HttpResult<T>> {
  const { label, save = true, ...req } = init;
  let res: Response | null = null;
  let text = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url, req);
    text = await res.text();
    if (res.status !== 429 && res.status < 500) break;
    await sleep(1500 * (attempt + 1));
  }
  const retrievedAt = new Date().toISOString();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  let rawPath: string | null = null;
  if (save && rawDir) {
    seq += 1;
    rawPath = path.join(rawDir, `${String(seq).padStart(3, '0')}-${slug(label)}.json`);
    const record = { label, method: req.method ?? 'GET', url, status: res!.status, retrievedAt, body };
    writeFileSync(rawPath, redact(JSON.stringify(record, null, 2)));
  }
  return { status: res!.status, ok: res!.ok, body, rawPath, retrievedAt };
}
