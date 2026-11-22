// Fixture loader. All fixtures under recorded-2026-11-22/ were recorded live on 2026-11-22.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'recorded-2026-11-22');
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

export const RECORDED = 'recorded live 2026-11-22';
