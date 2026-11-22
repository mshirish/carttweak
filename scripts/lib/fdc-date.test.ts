import { describe, expect, it } from 'vitest';
import { fdcDateToIso, latestFdcDate } from './fdc-date.ts';

describe('fdcDateToIso', () => {
  it('M/D/YYYY (detail endpoint)', () => {
    expect(fdcDateToIso('4/23/2026')).toBe('2026-04-23');
    expect(fdcDateToIso('10/29/2026')).toBe('2026-10-29');
  });
  it('YYYY-MM-DD (search endpoint)', () => {
    expect(fdcDateToIso('2023-10-26')).toBe('2023-10-26');
  });
  it('junk -> null', () => {
    expect(fdcDateToIso('')).toBeNull();
    expect(fdcDateToIso(null)).toBeNull();
    expect(fdcDateToIso('13/1/2020')).toBeNull();
  });
  it('sorts chronologically, not lexically', () => {
    // lexically "4/23/2026" > "10/29/2026"; chronologically it is earlier
    expect(latestFdcDate('4/23/2026', '10/29/2026')).toBe('2026-10-29');
    expect(latestFdcDate(null, undefined)).toBeNull();
  });
});
