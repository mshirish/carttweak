/**
 * FDC dates come back as "M/D/YYYY" on /food/{id} and "YYYY-MM-DD" on
 * /foods/search. Normalize to ISO "YYYY-MM-DD" so they sort correctly.
 * Unrecognized or empty -> null.
 */
export function fdcDateToIso(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

/** Latest of the given FDC dates (ISO), or null. */
export function latestFdcDate(...dates: unknown[]): string | null {
  const iso = dates.map(fdcDateToIso).filter((d): d is string => d != null).sort();
  return iso.length ? iso[iso.length - 1]! : null;
}
