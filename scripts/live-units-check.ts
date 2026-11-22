// One-off live check for A1 (units decoupled): milk (sold by volume, labelled per 100 g)
// and Campbell's condensed soup (sold by weight, labelled per 100 mL).
//   npx tsx scripts/live-units-check.ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { setCacheRoot } from '../server/src/cache.ts';
import { registerSecret } from '../server/src/secrets.ts';
import { createService } from '../server/src/service.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env'), quiet: true } as any);
const id = process.env.KROGER_CLIENT_ID!.trim();
const secret = process.env.KROGER_CLIENT_SECRET!.trim();
const fdc = process.env.FDC_API_KEY!.trim();
[id, secret, fdc].forEach(registerSecret);
setCacheRoot(path.join(root, 'data', 'cache'));
const svc = createService({ kroger: { clientId: id, clientSecret: secret }, fdcApiKey: fdc, sampleDir: path.join(root, 'data', 'sample') });

for (const [query, goal] of [
  ['Kroger 2% Reduced Fat Milk 1 gal', 'more_protein'],
  ["Campbell's Chicken Noodle Soup 10.75 oz", 'less_sodium'],
] as const) {
  const r = await svc.plan({ locationId: '01400513', items: [{ id: 'x', query }], goals: { primary: goal }, budget: { maxExtraSpendCents: 500 } });
  const o = r.plan.itemOutcomes[0]!;
  console.log(`\n${query} [${goal}] -> ${o.code}: ${o.detail}`);
  console.log(`  candidate reasons: ${JSON.stringify(o.candidateReasonCounts)}`);
  for (const s of r.plan.swaps) {
    console.log(`  swap -> ${s.replacement.description} (${s.replacement.sizeLabel}) per100${s.basis} ${s.goal.improvementPer100.toFixed(2)}; trip ${s.goal.tripImpact}; ${s.cost.regular.differenceCents}c`);
    console.log(`  ${r.explanations[0]}`);
  }
}
