// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetControl, clampBudget } from './BudgetControl.tsx';

afterEach(cleanup);

function Harness({ initial = 200, spy }: { initial?: number; spy: (c: number) => void }) {
  const [c, setC] = useState(initial);
  return (
    <BudgetControl
      cents={c}
      onChange={(v) => {
        spy(v);
        setC(v);
      }}
    />
  );
}

describe('BudgetControl', () => {
  it('slider runs $0-$10 in $0.25 steps and reports cents', () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    const slider = screen.getByLabelText('Maximum extra spend for the whole trip') as HTMLInputElement;
    expect([slider.min, slider.max, slider.step]).toEqual(['0', '1000', '25']);
    fireEvent.change(slider, { target: { value: '350' } });
    expect(spy).toHaveBeenLastCalledWith(350);
    expect(screen.getByText('$3.50')).toBeTruthy();
    expect((screen.getByLabelText('Maximum extra spend in dollars') as HTMLInputElement).value).toBe('3.50');
  });
  it('number input commits as you type and clamps to $0-$10', () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    const box = screen.getByLabelText('Maximum extra spend in dollars') as HTMLInputElement;
    fireEvent.focusIn(box);
    fireEvent.change(box, { target: { value: '1.5' } });
    expect(spy).toHaveBeenLastCalledWith(150);
    expect(box.value).toBe('1.5'); // not rewritten while typing
    fireEvent.change(box, { target: { value: '25' } });
    expect(spy).toHaveBeenLastCalledWith(1000);
    fireEvent.focusOut(box, { target: { value: '25' } });
    expect(box.value).toBe('10.00');
  });
  it('$0 is allowed and explained', () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    const box = screen.getByLabelText('Maximum extra spend in dollars') as HTMLInputElement;
    fireEvent.change(box, { target: { value: '0' } });
    expect(spy).toHaveBeenLastCalledWith(0);
    expect(screen.getByText('$0 means only swaps that cost the same or save money.')).toBeTruthy();
  });
  it('invalid text reverts on blur', () => {
    const spy = vi.fn();
    render(<Harness spy={spy} initial={125} />);
    const box = screen.getByLabelText('Maximum extra spend in dollars') as HTMLInputElement;
    fireEvent.focusIn(box);
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.focusOut(box, { target: { value: '' } });
    expect(box.value).toBe('1.25');
    expect(spy).not.toHaveBeenCalled();
  });
  it('clampBudget', () => {
    expect([clampBudget(-5), clampBudget(1234.6), clampBudget(Number.NaN), clampBudget(99.6)]).toEqual([0, 1000, 0, 100]);
  });
});
