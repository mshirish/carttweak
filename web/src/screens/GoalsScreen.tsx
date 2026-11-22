import type { Goal } from '@carttweak/shared';
import { BudgetControl } from '../components/BudgetControl.tsx';
import type { Goals } from '../types.ts';

export const GOAL_OPTIONS: Array<{ id: Goal; title: string; sub: string }> = [
  { id: 'more_protein', title: 'More protein', sub: '+2 g per 100 g or more' },
  { id: 'more_fiber', title: 'More fiber', sub: '+2 g per 100 g or more' },
  { id: 'less_added_sugar', title: 'Less added sugar', sub: '−3 g per 100 g or more' },
  { id: 'less_sodium', title: 'Less sodium', sub: '−100 mg per 100 g or more' },
];

export function GoalsScreen({
  goals,
  setGoals,
  budgetCents,
  setBudget,
  onPlan,
  itemCount,
}: {
  goals: Goals;
  setGoals: (g: Goals) => void;
  budgetCents: number;
  setBudget: (c: number) => void;
  onPlan: () => void;
  itemCount: number;
}) {
  const pickPrimary = (id: Goal) => setGoals({ primary: id, secondary: goals.secondary === id ? null : goals.secondary });
  return (
    <section>
      <h1>Goals and budget</h1>
      <p className="lede">Pick what matters most. We compare products per 100 g (or 100 mL) and only suggest swaps that clearly help.</p>

      <fieldset className="panel rule-top" style={{ margin: 0 }}>
        <legend className="sr-only">Main goal</legend>
        <h2 style={{ marginTop: 0 }}>Main goal</h2>
        <div className="radio-grid" role="radiogroup" aria-label="Main goal">
          {GOAL_OPTIONS.map((o) => (
            <label key={o.id} className={`radio-card${goals.primary === o.id ? ' checked' : ''}`}>
              <input type="radio" name="primary" value={o.id} checked={goals.primary === o.id} onChange={() => pickPrimary(o.id)} />
              <span className="rc-title">{o.title}</span>
              <span className="rc-sub">{o.sub}</span>
            </label>
          ))}
        </div>

        <h2>Also watch (optional)</h2>
        <p className="help" style={{ marginTop: 0 }}>Swaps that make this clearly worse are skipped.</p>
        <div className="seg" role="radiogroup" aria-label="Secondary goal">
          <label className={`radio-card${goals.secondary == null ? ' checked' : ''}`}>
            <input type="radio" name="secondary" value="" checked={goals.secondary == null} onChange={() => setGoals({ ...goals, secondary: null })} />
            <span className="rc-title">None</span>
          </label>
          {GOAL_OPTIONS.map((o) => {
            const disabled = goals.primary === o.id;
            return (
              <label key={o.id} className={`radio-card${goals.secondary === o.id ? ' checked' : ''}${disabled ? ' disabled' : ''}`}>
                <input type="radio" name="secondary" value={o.id} disabled={disabled} checked={goals.secondary === o.id} onChange={() => setGoals({ ...goals, secondary: o.id })} />
                <span className="rc-title">{o.title}</span>
              </label>
            );
          })}
        </div>

        <h2>Max extra spend for the whole trip</h2>
        <BudgetControl cents={budgetCents} onChange={setBudget} />
      </fieldset>

      <div className="actions">
        <button type="button" className="btn primary" disabled={!goals.primary} onClick={onPlan}>
          {goals.primary ? `Find swaps for ${itemCount} item${itemCount === 1 ? '' : 's'}` : 'Pick a main goal'}
        </button>
      </div>
    </section>
  );
}
