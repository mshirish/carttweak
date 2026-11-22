import { coverageLine, dollars, haulScore, shortName, type Grade, type HaulItem } from '@carttweak/shared';

export interface HaulRow extends HaulItem {
  quantity: number;
  matchMethod: 'barcode' | 'shopper_confirmed' | 'usda_generic' | 'unmatched' | 'list_match';
  krogerProductId: string | null;
  regularCents: number | null;
  /** P2: suggested "not food" (keyword), still undoable */
  nonFoodGuess?: boolean;
}

export const METHOD_VERSION = 'original 2017 algorithm';
const GRADE_COLOR: Record<Grade, string> = { A: '#0e6b4e', B: '#5a9a3d', C: '#c9a227', D: '#d9822b', E: '#b3261e' };

export function OverviewScreen({
  rows,
  storeLabel,
  date,
  source,
  onImprove,
  onSave,
  saved,
}: {
  rows: HaulRow[];
  storeLabel: string;
  date: string | null;
  source: 'receipt' | 'list';
  onImprove: () => void;
  onSave: () => void;
  saved: boolean;
}) {
  const h = haulScore(rows);
  const dist = (['A', 'B', 'C', 'D', 'E'] as Grade[]).map((g) => ({ g, cents: h.distribution[g] }));
  const distTotal = dist.reduce((s, x) => s + x.cents, 0);
  const groups: Array<[keyof typeof h.unscored, string]> = [
    ['label_missing', 'Label data missing'],
    ['not_matched', 'Not matched'],
    ['not_food', 'Not food, not scored'],
  ];
  return (
    <section>
      <h1>Your haul</h1>
      <div className="panel rule-top haul-hero">
        <div className="haul-score num" data-testid="haul-score">
          {h.score ?? '–'}
          <span className="out-of">/100</span>
        </div>
        <div>
          <div className="haul-verdict">{h.verdict ?? 'Not enough label data to score'}</div>
          <div className="small" data-testid="coverage">
            {coverageLine(h)} {h.lowConfidence ? <span className="badge warn">Low confidence</span> : null}
          </div>
          <div className="small muted num">
            {storeLabel}
            {date ? ` · ${date}` : ''} · {dollars(h.totalSpendCents)} spent · {h.itemCount} item{h.itemCount === 1 ? '' : 's'} · {source === 'receipt' ? 'from your receipt' : 'typed list'}
          </div>
        </div>
      </div>

      {distTotal > 0 ? (
        <div className="panel" style={{ marginTop: 14 }}>
          <h3>Grades by spend</h3>
          <div className="grade-bar" aria-label="Grade distribution by spend">
            {dist
              .filter((x) => x.cents > 0)
              .map((x) => (
                <span key={x.g} style={{ flexGrow: x.cents, background: GRADE_COLOR[x.g] }} title={`${x.g}: ${dollars(x.cents)}`}>
                  {x.g}
                </span>
              ))}
          </div>
          <div className="small muted num">{dist.map((x) => `${x.g} ${Math.round((x.cents / distTotal) * 100)}%`).join(' · ')}</div>
        </div>
      ) : null}

      <div className="grid-2" style={{ marginTop: 14 }}>
        <div className="panel">
          <h3>Helping your score</h3>
          {h.helpers.length ? (
            <ul className="score-list">
              {h.helpers.map((x) => (
                <li key={x.id}>
                  <span className={`grade g${x.grade}`}>{x.grade}</span> {shortName(x.name)} <span className="muted small">· {x.reason}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Nothing stands out yet.</p>
          )}
        </div>
        <div className="panel">
          <h3>Hurting your score</h3>
          {h.hurters.length ? (
            <ul className="score-list">
              {h.hurters.map((x) => (
                <li key={x.id}>
                  <span className={`grade g${x.grade}`}>{x.grade}</span> {shortName(x.name)} <span className="muted small">· {x.reason}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Nothing stands out.</p>
          )}
        </div>
      </div>

      {groups.some(([k]) => h.unscored[k].length) ? (
        <div className="panel" style={{ marginTop: 14 }}>
          <h3>Unscored</h3>
          {groups.map(([k, title]) =>
            h.unscored[k].length ? (
              <div key={k} className="reason-group" data-testid={`unscored-${k}`}>
                <strong>
                  {title} <span className="muted num">({h.unscored[k].length})</span>
                </strong>
                <ul>
                  {h.unscored[k].map((u) => (
                    <li key={u.id} className="small">
                      {shortName(u.name)}
                      {k === 'label_missing' ? <span className="muted"> · {u.reason}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
        </div>
      ) : null}

      <details className="sources panel" style={{ marginTop: 14 }}>
        <summary>How is this scored?</summary>
        <p>Based on the Nutri-Score method ({METHOD_VERSION}). Not an official Nutri-Score label.</p>
        <ul>
          <li>Each product gets points from its label per 100 g (or 100 mL for drinks): energy, total sugars, saturated fat and sodium count against it; fiber, protein and fruit/vegetable share count for it. Points become a grade A–E and a 0–100 score (best possible = 100, worst = 0, in a straight line).</li>
          <li>US labels don't state the fruit/vegetable/legume share, so it counts as 0% for packaged foods. Fresh produce matched to a USDA generic record counts as 100%.</li>
          <li>If any needed label value is missing, the product is left unscored. We never guess.</li>
          <li>Your haul score is the average of product scores, weighted by what you spent on each ({source === 'receipt' ? 'the price on your receipt' : 'the Kroger On the Rhine regular price'}).</li>
          <li>Coverage is the share of your food spend that could be scored. Under 50% shows “Low confidence”. Non-food items don't count.</li>
        </ul>
      </details>

      <div className="actions">
        <button type="button" className="btn primary" onClick={onImprove}>
          Improve this haul
        </button>
        <button type="button" className="btn" onClick={onSave} disabled={saved}>
          {saved ? 'Haul saved ✓' : 'Save haul'}
        </button>
      </div>
    </section>
  );
}
