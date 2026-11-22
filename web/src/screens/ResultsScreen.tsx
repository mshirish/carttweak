import { budgetSentence, dollars, explainOutcome, GOALS, groupOutcomes, NUTRIENT_UNIT, suggestChange } from '@carttweak/shared';
import { SwapCard } from '../components/SwapCard.tsx';
import type { PlanProgress, PlanResponse, SwapOption } from '../types.ts';

const PHASES: Array<{ id: string; label: string }> = [
  { id: 'store', label: 'Checking your store' },
  { id: 'resolve', label: 'Checking prices' },
  { id: 'candidates', label: 'Finding alternatives and labels' },
  { id: 'plan', label: 'Comparing labels and prices' },
];

export function Progress({ progress }: { progress: PlanProgress | null }) {
  const phaseIdx = Math.max(0, PHASES.findIndex((p) => p.id === progress?.phase));
  const frac = progress && progress.total > 0 ? progress.done / progress.total : 0;
  const overall = Math.min(1, (phaseIdx + frac) / PHASES.length);
  return (
    <div className="panel rule-top progress" role="status" aria-live="polite">
      <h2 style={{ marginTop: 0 }}>{progress?.message ?? 'Starting…'}</h2>
      <div className="bar" aria-hidden="true">
        <span style={{ width: `${Math.round(overall * 100)}%` }} />
      </div>
      <ol className="steps">
        {PHASES.map((p, i) => (
          <li key={p.id} className={i < phaseIdx || progress?.phase === 'done' ? 'done' : i === phaseIdx ? 'now' : undefined}>
            {p.label}
            {i === phaseIdx && progress && progress.total > 1 ? <span className="num"> ({progress.done}/{progress.total})</span> : null}
          </li>
        ))}
      </ol>
      <p className="help">The first plan at a store can take about 20 seconds while prices and labels load; after that it's quick.</p>
    </div>
  );
}

export function NoSwapPanel({ resp }: { resp: PlanResponse }) {
  const groups = groupOutcomes(resp.plan);
  const suggestion = suggestChange(resp.plan);
  return (
    <div className="panel rule-top">
      <h2 style={{ marginTop: 0 }}>No swaps this time</h2>
      <p className="muted">Nothing on your list met your goal and budget together. Here's why, item by item.</p>
      {suggestion ? (
        <p className="suggest" data-testid="suggestion">
          {suggestion}
        </p>
      ) : null}
      {groups.map((g) => (
        <div className="reason-group" key={g.id}>
          <h3>
            {g.title} <span className="muted num">({g.items.length})</span>
          </h3>
          <ul>
            {g.items.map((o) => (
              <li key={o.itemId}>
                {explainOutcome(o)}
                {o.code === 'over_budget' && o.cheapestQualifying ? <span className="num"> Cheapest option: {dollars(o.cheapestQualifying.differenceCents)} more.</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function TripTotal({ resp, budgetCents, acceptedCount, onSave }: { resp: PlanResponse; budgetCents: number; acceptedCount: number; onSave: () => void }) {
  const c = resp.plan.combined;
  const diff = c?.differenceCents ?? 0;
  const over = diff > budgetCents;
  const goal = GOALS[resp.plan.primaryGoal];
  return (
    <div className={`total-bar${over ? ' over' : ''}`} data-testid="trip-total">
      <div>
        <div className="t-main num">
          Trip: {diff === 0 ? 'same price' : diff > 0 ? `${dollars(diff)} more` : `saves ${dollars(-diff)}`} · budget {dollars(budgetCents)}
        </div>
        {budgetSentence(resp.plan) ? (
          <div className="t-sentence" data-testid="budget-sentence">
            {budgetSentence(resp.plan)}
          </div>
        ) : null}
        <div className="t-sub num">
          {c && c.tripImpact > 0 ? `${goal.better === 'higher' ? '+' : '−'}${c.tripImpact.toFixed(1)} ${NUTRIENT_UNIT[GOALS[resp.plan.primaryGoal].nutrient]} ${goal.label} across what you buy` : ''}
          {c && c.tripImpactUnknown ? `${c.tripImpact > 0 ? ' · ' : ''}${c.tripImpactUnknown} swap${c.tripImpactUnknown === 1 ? '' : 's'} per-100 only` : ''}
          {c && c.promoDifferenceCents != null ? ` · with promos ${c.promoDifferenceCents >= 0 ? `${dollars(c.promoDifferenceCents)} more` : `saves ${dollars(-c.promoDifferenceCents)}`}` : ''}
        </div>
      </div>
      <button type="button" className="btn small" onClick={onSave}>
        Save revised list{acceptedCount ? ` (${acceptedCount} swap${acceptedCount === 1 ? '' : 's'})` : ''}
      </button>
    </div>
  );
}

export function ResultsScreen({
  resp,
  progress,
  error,
  busy,
  accepted,
  budgetCents,
  now,
  onAccept,
  onReject,
  onSave,
  onRetry,
  excludedCount,
}: {
  resp: PlanResponse | null;
  progress: PlanProgress | null;
  error: string | null;
  busy: boolean;
  accepted: Record<string, string>;
  budgetCents: number;
  now: string;
  onAccept: (s: SwapOption) => void;
  onReject: (s: SwapOption) => void;
  onSave: () => void;
  onRetry: () => void;
  excludedCount: number;
}) {
  if (error) {
    return (
      <section>
        <h1>Your swaps</h1>
        <p className="error" role="alert">
          {error}
        </p>
        <button className="btn" type="button" onClick={onRetry}>
          Try again
        </button>
      </section>
    );
  }
  if (busy || !resp) {
    return (
      <section>
        <h1>Your swaps</h1>
        <Progress progress={progress} />
      </section>
    );
  }
  const swaps = resp.plan.swaps;
  const acceptedCount = swaps.filter((s) => accepted[s.itemId] === s.replacement.ref).length;
  return (
    <section>
      <h1>Your swaps</h1>
      <p className="lede">
        {swaps.length ? `Up to two swaps that do the most for ${GOALS[resp.plan.primaryGoal].label} within your budget.` : ''}
        {excludedCount ? ` ${excludedCount} rejected swap${excludedCount === 1 ? '' : 's'} left out.` : ''}
        {resp.containsSample ? ' ' : ''}
        {resp.containsSample ? <span className="badge sample">Sample data</span> : null}
      </p>
      {swaps.length ? (
        swaps.map((s) => (
          <SwapCard
            key={`${s.itemId}-${s.replacement.ref}`}
            swap={s}
            now={now}
            accepted={accepted[s.itemId] === s.replacement.ref}
            busy={busy}
            onAccept={() => onAccept(s)}
            onReject={() => onReject(s)}
          />
        ))
      ) : (
        <NoSwapPanel resp={resp} />
      )}
      {swaps.length ? (
        <details className="sources panel" style={{ marginTop: 18 }}>
          <summary>Why not the other items?</summary>
          <ul>
            {resp.plan.itemOutcomes
              .filter((o) => o.code !== 'swapped')
              .map((o) => (
                <li key={o.itemId}>{explainOutcome(o)}</li>
              ))}
          </ul>
        </details>
      ) : null}
      <TripTotal resp={resp} budgetCents={budgetCents} acceptedCount={acceptedCount} onSave={onSave} />
    </section>
  );
}
