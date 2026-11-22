import { dollars, explainSwap, GOALS, NUTRIENT_LABEL, NUTRIENT_UNIT, relativeTime, shortName, type PriceObservation, type SwapOption } from '@carttweak/shared';

/** Human label for where a price came from: "Prices from <branch> (checked <time>)". */
export function priceSourceLabel(p: { source: string; branch?: string; date: string | null; stale?: boolean }, now: string): string {
  const checked = `checked ${relativeTime(p.date, now)}`;
  if (p.source === 'kroger_api') return `Prices from ${p.branch} (${checked})`;
  return `${p.source}, ${p.branch ?? ''}, ${checked}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "You paid $2.48 on Feb 3, 2026 at Kroger, 100 Main St" */
export function paidLabel(p: PriceObservation): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(p.observedAt);
  const when = m ? ` on ${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : '';
  return `You paid ${dollars(p.regularCents)}${p.quantity && p.quantity > 1 ? ` for ${p.quantity}` : ''}${when} at ${p.branch.name}`;
}

const FLAG_TEXT: Record<string, string> = {
  label_outdated: 'Label may be outdated',
  size_conflict: 'Size conflict',
  secondary_unknown: 'Secondary goal unknown',
  stale_price: 'Stale price',
  sample_data: 'Sample data',
  size_inferred: 'Size inferred',
};

function fmt(v: number | null, unit: string): string {
  if (v == null) return 'unknown';
  const d = unit === 'mg' || unit === 'kcal' ? 0 : 1;
  return `${(Math.round(v * 10 ** d) / 10 ** d).toFixed(d)} ${unit}`;
}

function fmtDelta(v: number | null, unit: string): string {
  if (v == null) return 'unknown';
  const d = unit === 'mg' || unit === 'kcal' ? 0 : 1;
  const r = Math.round(v * 10 ** d) / 10 ** d;
  return `${r > 0 ? '+' : r < 0 ? '−' : '±'}${Math.abs(r).toFixed(d)} ${unit}`;
}

function money(cents: number): string {
  if (cents === 0) return 'Same price';
  return cents > 0 ? `${dollars(cents)} more` : `Saves ${dollars(-cents)}`;
}

export function badgesFor(s: SwapOption): Array<{ key: string; text: string; tone: 'warn' | 'plain' | 'sample' }> {
  const out: Array<{ key: string; text: string; tone: 'warn' | 'plain' | 'sample' }> = [];
  const seen = new Set<string>();
  for (const f of s.flags) {
    if (f.code === 'nutrient_worse') {
      const t = f.detail.charAt(0).toUpperCase() + f.detail.slice(1);
      out.push({ key: `worse-${f.nutrient}`, text: t, tone: 'warn' });
      continue;
    }
    if (seen.has(f.code) || !FLAG_TEXT[f.code]) continue;
    seen.add(f.code);
    out.push({ key: f.code, text: FLAG_TEXT[f.code]!, tone: f.code === 'sample_data' ? 'sample' : f.code === 'label_outdated' ? 'warn' : 'plain' });
  }
  if (s.goal.tripImpact == null) out.push({ key: 'per100', text: 'Per-100 only', tone: 'plain' });
  return out;
}

export interface SwapCardProps {
  swap: SwapOption;
  now: string;
  accepted?: boolean;
  busy?: boolean;
  onAccept?: () => void;
  onReject?: () => void;
  /** what the shopper paid for the original (receipt); context only */
  paid?: PriceObservation | null;
}

export function SwapCard({ swap: s, now, accepted, busy, onAccept, onReject, paid }: SwapCardProps) {
  const g = GOALS[s.goal.goal];
  const unit = NUTRIENT_UNIT[s.goal.nutrient];
  const priceSrc = s.sources.filter((x) => x.kind === 'price');
  const nutSrc = s.sources.filter((x) => x.kind === 'nutrition');
  const img = (role: 'original' | 'replacement') => (role === 'original' ? s.original : s.replacement);
  return (
    <article className={`swap${accepted ? ' accepted' : ''}`} aria-label={`Swap ${shortName(s.original.description)} for ${shortName(s.replacement.description)}`}>
      <div className="vs">
        {(['original', 'replacement'] as const).map((role) => {
          const p = img(role);
          const price = priceSrc.find((x) => x.role === role);
          const cents = role === 'original' ? s.cost.regular.originalCents / s.originalPackages : s.cost.regular.replacementCents / s.packagesNeeded;
          return (
            <div className="side" key={role}>
              <div className="label">{role === 'original' ? 'Instead of' : 'Try'}</div>
              {p.imageUrl ? <img src={p.imageUrl} alt="" referrerPolicy="no-referrer" /> : null}
              <div className="pname">{shortName(p.description)}</div>
              <div className="psize num">
                {p.sizeLabel ?? 'size unknown'} · {dollars(Math.round(cents))}
                {price?.stale ? ' (cached)' : ''}
              </div>
              {role === 'original' && paid ? (
                <div className="psize num" data-testid="paid-line">
                  {paidLabel(paid)}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {s.goal.tripImpact != null ? (
        <p className="impact num">
          {g.better === 'higher' ? '+' : '−'}
          {(Math.round(s.goal.tripImpact * 10) / 10).toFixed(1)} {unit} {g.label} across what you buy
        </p>
      ) : (
        <p className="impact unknown num">
          {g.better === 'higher' ? '+' : '−'}
          {(Math.round(s.goal.improvementPer100 * 10) / 10).toFixed(1)} {unit} {g.label} per 100 {s.basis}. Trip total unknown (sold by{' '}
          {s.goal.quantityUnit === 'ml' ? 'volume' : s.goal.quantityUnit === 'g' ? 'weight' : 'count'}, label per 100 {s.basis})
        </p>
      )}

      <table className="facts">
        <caption>Per 100 {s.basis}</caption>
        <thead>
          <tr>
            <th scope="col">Nutrient</th>
            <th scope="col">Now</th>
            <th scope="col">Swap</th>
            <th scope="col">Change</th>
          </tr>
        </thead>
        <tbody>
          {s.nutrients.map((n) => (
            <tr key={n.key} className={n.key === s.goal.nutrient ? 'goal' : undefined}>
              <td>
                {NUTRIENT_LABEL[n.key].charAt(0).toUpperCase() + NUTRIENT_LABEL[n.key].slice(1)}
                {n.contextOnly ? <span className="ctx">context only, not added sugar</span> : null}
              </td>
              <td className={n.original == null ? 'unknown' : undefined}>{fmt(n.original, n.unit)}</td>
              <td className={n.replacement == null ? 'unknown' : undefined}>{fmt(n.replacement, n.unit)}</td>
              <td className={n.delta == null ? 'unknown' : undefined}>{fmtDelta(n.delta, n.unit)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="money num">
        <div>
          <div className="big" data-testid="regular-diff">{money(s.cost.regular.differenceCents)}</div>
          <div className="small muted">at regular price</div>
        </div>
        <div className="small muted" style={{ textAlign: 'right' }}>
          {s.packagesNeeded} package{s.packagesNeeded === 1 ? '' : 's'}
          <br />
          replaces {s.originalPackages} × {s.original.sizeLabel}
        </div>
        {s.cost.promo ? (
          <div className="promo" data-testid="promo-line" style={{ gridColumn: '1 / -1' }}>
            With current promo, may require Kroger card: <strong>{money(s.cost.promo.differenceCents)}</strong>
          </div>
        ) : null}
      </div>

      <p className="why">{explainSwap(s)}</p>

      <div className="badges" aria-label="Notes">
        {badgesFor(s).map((b) => (
          <span key={b.key} className={`badge${b.tone === 'warn' ? ' warn' : b.tone === 'sample' ? ' sample' : ''}`}>
            {b.text}
          </span>
        ))}
      </div>

      <details className="sources">
        <summary>Sources</summary>
        <ul>
          {priceSrc.map((p) => (
            <li key={`p-${p.role}`}>
              {p.role === 'original' ? 'Current item' : 'Swap'} price: {priceSourceLabel(p, now)}
              {p.stale ? ' (served from cache; live price unavailable)' : ''}
            </li>
          ))}
          {paid ? <li key="paid">Receipt: {paidLabel(paid)} (what you paid; not used to compare prices)</li> : null}
          {nutSrc.map((n) => {
            const fdcId = n.source === 'fdc' ? n.sourceRef.replace(/^fdc:/, '') : null;
            return (
              <li key={`n-${n.role}`}>
                {n.role === 'original' ? 'Current item' : 'Swap'} nutrition:{' '}
                {fdcId ? (
                  <a href={`https://fdc.nal.usda.gov/food-details/${fdcId}/nutrients`} target="_blank" rel="noreferrer">
                    USDA FoodData Central #{fdcId}
                  </a>
                ) : n.source === 'retailer_listing' && n.sourceUrl ? (
                  <a href={n.sourceUrl} target="_blank" rel="noreferrer">
                    Kroger product page
                  </a>
                ) : n.source === 'label_observation' ? (
                  `label photo ${n.sourceRef}`
                ) : (
                  n.sourceRef
                )}
                , label date {n.date ?? 'unknown'}
                {n.transcribedBy ? `, transcribed by ${n.transcribedBy}` : ''}
                {n.outdated ? ' (label may be outdated)' : ''}
              </li>
            );
          })}
        </ul>
      </details>

      {onAccept || onReject ? (
        <div className="card-actions">
          <button type="button" className={`btn${accepted ? ' primary' : ''}`} onClick={onAccept} disabled={busy} aria-pressed={!!accepted}>
            {accepted ? 'Accepted ✓' : 'Accept'}
          </button>
          <button type="button" className="btn" onClick={onReject} disabled={busy}>
            Reject
          </button>
        </div>
      ) : null}
    </article>
  );
}
