// CartTweak API server. The ONLY runtime place API secrets are read.
// Milestone 1: health + a shared-code smoke route. Real endpoints come later.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { gtin14Interpretations, upcCandidates } from '@carttweak/shared';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
dotenv.config({ path: path.join(root, '.env') });

const app = new Hono();

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    // report presence only, never values
    config: {
      kroger: Boolean(process.env.KROGER_CLIENT_ID && process.env.KROGER_CLIENT_SECRET),
      fdc: Boolean(process.env.FDC_API_KEY),
      walmart: Boolean(process.env.WALMART_CONSUMER_ID),
    },
  }),
);

app.get('/api/upc/:code', (c) => {
  const code = c.req.param('code');
  return c.json({ code, interpretations: gtin14Interpretations(code), candidates: upcCandidates(code) });
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`CartTweak server listening on http://localhost:${info.port}`);
});
