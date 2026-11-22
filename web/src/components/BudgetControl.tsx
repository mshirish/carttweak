import { useEffect, useRef, useState } from 'react';

export const BUDGET_MAX_CENTS = 1000;
export const BUDGET_STEP_CENTS = 25;

/** Clamp to $0–$10 and whole cents. */
export function clampBudget(cents: number): number {
  if (!Number.isFinite(cents)) return 0;
  return Math.min(BUDGET_MAX_CENTS, Math.max(0, Math.round(cents)));
}

export function BudgetControl({ cents, onChange }: { cents: number; onChange: (cents: number) => void }) {
  const [text, setText] = useState((cents / 100).toFixed(2));
  const editing = useRef(false);
  // mirror slider changes into the box, but never rewrite what the shopper is typing
  useEffect(() => {
    if (!editing.current) setText((cents / 100).toFixed(2));
  }, [cents]);
  const commit = (s: string) => {
    const v = Number(s.replace(/^\$/, ''));
    if (s.trim() === '' || !Number.isFinite(v)) {
      setText((cents / 100).toFixed(2));
      return;
    }
    onChange(clampBudget(v * 100));
  };
  return (
    <div>
      <div className="budget-value num" aria-live="polite">
        ${(cents / 100).toFixed(2)}
      </div>
      <div className="budget">
        <input
          type="range"
          min={0}
          max={BUDGET_MAX_CENTS}
          step={BUDGET_STEP_CENTS}
          value={cents}
          aria-label="Maximum extra spend for the whole trip"
          onChange={(e) => onChange(clampBudget(Number(e.target.value)))}
        />
        <input
          type="number"
          inputMode="decimal"
          min={0}
          max={10}
          step={0.25}
          aria-label="Maximum extra spend in dollars"
          value={text}
          onChange={(e) => {
            // commit valid values as you type, so tapping "Find swaps" next never races a blur
            setText(e.target.value);
            const v = Number(e.target.value);
            if (e.target.value.trim() !== '' && Number.isFinite(v)) onChange(clampBudget(v * 100));
          }}
          onFocus={() => (editing.current = true)}
          onBlur={(e) => {
            editing.current = false;
            commit(e.target.value);
            const v = Number(e.target.value);
            if (e.target.value.trim() !== '' && Number.isFinite(v)) setText((clampBudget(v * 100) / 100).toFixed(2));
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
          }}
        />
      </div>
      <p className="help">$0 means only swaps that cost the same or save money.</p>
    </div>
  );
}
