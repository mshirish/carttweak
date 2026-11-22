// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcceptAll } from './AcceptAll.tsx';

afterEach(cleanup);
const swaps = [
  { itemId: 'a', replacement: { ref: 'k:1' } },
  { itemId: 'b', replacement: { ref: 'k:2' } },
] as any;

function H({ spy }: { spy: (a: Record<string, string>) => void }) {
  const [acc, setAcc] = useState<Record<string, string>>({ a: 'k:1' });
  return <AcceptAll swaps={swaps} accepted={acc} onSet={(a) => (spy(a), setAcc(a))} undoMs={1000} />;
}

describe('Accept all', () => {
  it('accepts every shown swap; Undo restores the previous choice and disappears after a few seconds', () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    render(<H spy={spy} />);
    fireEvent.click(screen.getByRole('button', { name: 'Accept all (2)' }));
    expect(spy).toHaveBeenLastCalledWith({ a: 'k:1', b: 'k:2' });
    expect(screen.getByRole('button', { name: 'All accepted ✓' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(spy).toHaveBeenLastCalledWith({ a: 'k:1' });
    fireEvent.click(screen.getByRole('button', { name: 'Accept all (2)' }));
    act(() => void vi.advanceTimersByTime(1100));
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    vi.useRealTimers();
  });
});
