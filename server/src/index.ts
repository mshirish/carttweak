// CartTweak API server. The ONLY runtime place API secrets are read.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { setCacheRoot } from './cache.ts';
import { registerSecret } from './secrets.ts';
import { createService } from './service.ts';
import { loadWalmartConfig } from './walmart.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
dotenv.config({ path: path.join(root, '.env'), quiet: true } as any);

const env = {
  KROGER_CLIENT_ID: process.env.KROGER_CLIENT_ID?.trim() ?? '',
  KROGER_CLIENT_SECRET: process.env.KROGER_CLIENT_SECRET?.trim() ?? '',
  FDC_API_KEY: process.env.FDC_API_KEY?.trim() ?? '',
};
// client id is registered too: Kroger echoes it inside productPageURI
[env.KROGER_CLIENT_ID, env.KROGER_CLIENT_SECRET, env.FDC_API_KEY, process.env.WALMART_CONSUMER_ID?.trim()].forEach(registerSecret);

// CARTTWEAK_CACHE_DIR lets timing runs use an empty cache without touching data/cache/
setCacheRoot(process.env.CARTTWEAK_CACHE_DIR ? path.resolve(process.env.CARTTWEAK_CACHE_DIR) : path.join(root, 'data', 'cache'));
const svc = createService({
  kroger: { clientId: env.KROGER_CLIENT_ID, clientSecret: env.KROGER_CLIENT_SECRET },
  fdcApiKey: env.FDC_API_KEY,
  sampleDir: path.join(root, 'data', 'sample'),
  demoListPath: path.join(root, 'docs', 'demo-list.txt'),
  defaultLocationId: process.env.DEMO_LOCATION_ID?.trim() || undefined,
  ...(() => {
    const w = loadWalmartConfig(process.env, path.join(root, 'secrets', 'walmart_private_key.pem'));
    return { walmart: w.config, walmartReason: w.reason };
  })(),
});
const app = createApp(svc, { kroger: Boolean(env.KROGER_CLIENT_ID && env.KROGER_CLIENT_SECRET), fdc: Boolean(env.FDC_API_KEY) });

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`CartTweak server listening on http://localhost:${info.port}`);
});
