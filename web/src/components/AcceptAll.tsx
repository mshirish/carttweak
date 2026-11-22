import { useEffect, useRef, useState } from 'react';
import type { SwapOption } from '../types.ts';

/** "Accept all" above the swap cards; "Undo" stays for a few seconds. */
export function AcceptAll({ swaps, accepted, onSet, undoMs = 6000 }: { swaps: SwapOption[]; accepted: Record<string, string>; onSet: (a: Record<string, string>) => void; undoMs?: number }) {
  const [undo, setUndo] = useState<Record<string, string> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  if (!swaps.length) return null;
  const allAccepted = swaps.every((s) => accepted[s.itemId] === s.replacement.ref);
  return (
    <div className="row" style={{ marginBottom: 12 }}>
      <button
        type="button"
        className="btn primary small"
        disabled={allAccepted}
        onClick={() => {
          setUndo(accepted);
          onSet({ ...accepted, ...Object.fromEntries(swaps.map((s) => [s.itemId, s.replacement.ref])) });
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setUndo(null), undoMs);
        }}
      >
        {allAccepted ? 'All accepted ✓' : `Accept all (${swaps.length})`}
      </button>
      {undo ? (
        <button
          type="button"
          className="btn ghost small"
          onClick={() => {
            onSet(undo);
            setUndo(null);
          }}
        >
          Undo
        </button>
      ) : null}
    </div>
  );
}
