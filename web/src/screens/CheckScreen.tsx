import { useState } from 'react';
import { dollars, formatUnitPrice, shortName } from '@carttweak/shared';
import { api, ApiError } from '../api.ts';
import { Heart } from '../components/Icons.tsx';
import type { Card, ResolveItem, Row, RowStatus } from '../types.ts';

export function rowFromResolve(r: ResolveItem, locked = false): Row {
  const status: RowStatus =
    r.status === 'resolved' ? 'matched' : r.status === 'no_barcode' ? 'no_barcode' : r.status === 'not_found' ? 'not_found' : 'choose';
  return { id: r.id, query: r.query, quantity: r.quantity, status, detail: r.detail, product: r.product, candidates: r.candidates, locked: status === 'matched' && locked };
}

const CHIP: Record<RowStatus, string> = { matched: 'Matched', choose: 'Which one?', not_found: 'Not found', no_barcode: 'No barcode' };

function Price({ c }: { c: Card }) {
  return (
    <>
      <span className="p-price num">{c.regularCents != null ? dollars(c.regularCents) : 'no price'}</span>
      <span className="p-sub num">
        {c.sizeLabel ?? 'size unknown'} · {formatUnitPrice(c.unitPrice)}
      </span>
      <span className="p-sub num" style={{ textAlign: 'right' }}>
        {c.promoCents != null ? `${dollars(c.promoCents)} with card` : ''}
      </span>
    </>
  );
}

function Thumb({ url }: { url: string | null }) {
  return url ? <img className="thumb" src={url} alt="" referrerPolicy="no-referrer" /> : <span className="thumb empty" aria-hidden="true" />;
}

export function CheckScreen({
  rows,
  setRows,
  locationId,
  onContinue,
}: {
  rows: Row[];
  setRows: (fn: (rows: Row[]) => Row[]) => void;
  locationId: string;
  onContinue: () => void;
}) {
  const [searching, setSearching] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const update = (id: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const remove = (id: string) => setRows((rs) => rs.filter((r) => r.id !== id));
  const choose = (row: Row, c: Card) => update(row.id, { status: 'matched', product: c, detail: 'chosen by you' });
  async function searchAgain(row: Row) {
    const q = (searching[row.id] ?? '').trim();
    if (!q) return;
    setBusy(row.id);
    setError(null);
    try {
      const r = await api.resolve(locationId, [{ id: row.id, query: q, quantity: row.quantity }]);
      const next = rowFromResolve(r.items[0]!);
      update(row.id, { ...next, locked: false });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Search failed.');
    } finally {
      setBusy(null);
    }
  }
  const counts = rows.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {} as Record<RowStatus, number>);
  const blocking = (counts.choose ?? 0) + (counts.not_found ?? 0);
  return (
    <section>
      <h1>Check your list</h1>
      <p className="lede">
        <span className="num">
          {counts.matched ?? 0} matched
          {counts.choose ? ` · ${counts.choose} need your choice` : ''}
          {counts.not_found ? ` · ${counts.not_found} not found` : ''}
          {counts.no_barcode ? ` · ${counts.no_barcode} produce` : ''}
        </span>
        . Tap “Keep this” on favourites you never want swapped.
      </p>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <ul className="items">
        {rows.map((row) => (
          <li className="item" key={row.id} data-status={row.status}>
            <div className="item-head">
              <Thumb url={row.status === 'matched' ? row.product?.imageUrl ?? null : null} />
              <div className="item-main">
                <span className={`chip ${row.status}`}>{CHIP[row.status]}</span>
                {row.status === 'matched' && row.product ? (
                  <>
                    <div className="item-name">
                      {row.quantity > 1 ? <span className="num">{row.quantity} × </span> : null}
                      {shortName(row.product.description)}
                    </div>
                    <div className="item-meta num">
                      {row.product.sizeLabel ?? 'size unknown'} · {row.product.regularCents != null ? dollars(row.product.regularCents) : 'no price'} ·{' '}
                      {formatUnitPrice(row.product.unitPrice)}
                    </div>
                    <div className="item-meta">You typed “{row.query}”</div>
                  </>
                ) : (
                  <>
                    <div className="item-name">
                      {row.quantity > 1 ? <span className="num">{row.quantity} × </span> : null}
                      {row.query}
                    </div>
                    {row.status === 'no_barcode' ? (
                      <div className="item-meta">Loose produce has no barcode. It stays on your list but won't be swapped.</div>
                    ) : row.status === 'choose' ? (
                      <div className="item-meta">Several products match. Pick the one you buy; we never guess.</div>
                    ) : (
                      <div className="item-meta">{row.candidates.length ? 'No exact match. Pick a close result, search again, or remove it.' : 'Nothing found at this store. Try different words, or remove it.'}</div>
                    )}
                  </>
                )}
              </div>
              {row.status === 'matched' ? (
                <button type="button" className="lock" aria-pressed={row.locked} onClick={() => update(row.id, { locked: !row.locked })}>
                  <Heart filled={row.locked} />
                  Keep this
                </button>
              ) : null}
            </div>

            {(row.status === 'choose' || row.status === 'not_found') && row.candidates.length ? (
              <ul className="pick-list" aria-label={`Options for ${row.query}`}>
                {row.candidates.map((c) => (
                  <li key={c.ref}>
                    <button type="button" className="choice" onClick={() => choose(row, c)}>
                      <Thumb url={c.imageUrl} />
                      <span className="pick" style={{ flex: 1, minWidth: 0 }}>
                        <span className="p-name">{shortName(c.description)}</span>
                        <Price c={c} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            {row.status === 'not_found' || row.status === 'choose' ? (
              <form
                className="row"
                style={{ marginTop: 10 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  void searchAgain(row);
                }}
              >
                <input
                  type="search"
                  aria-label={`Search again for ${row.query}`}
                  placeholder="Search again, e.g. brand and size"
                  value={searching[row.id] ?? ''}
                  onChange={(e) => setSearching((s) => ({ ...s, [row.id]: e.target.value }))}
                  style={{ flex: '1 1 200px', width: 'auto' }}
                />
                <button className="btn small" type="submit" disabled={busy === row.id}>
                  {busy === row.id ? 'Searching…' : 'Search'}
                </button>
                <button className="btn small" type="button" onClick={() => remove(row.id)}>
                  Remove
                </button>
              </form>
            ) : row.status === 'matched' ? (
              <div className="row" style={{ marginTop: 6 }}>
                <button className="btn ghost small" type="button" onClick={() => update(row.id, { status: 'choose', candidates: row.candidates.length ? row.candidates : row.product ? [row.product] : [], locked: false })}>
                  Not this one
                </button>
                <button className="btn ghost small" type="button" onClick={() => remove(row.id)}>
                  Remove
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="actions">
        <button className="btn primary" type="button" disabled={blocking > 0 || rows.length === 0} onClick={onContinue}>
          {blocking ? `Choose or remove ${blocking} item${blocking === 1 ? '' : 's'} to continue` : 'Continue to goals'}
        </button>
      </div>
    </section>
  );
}
