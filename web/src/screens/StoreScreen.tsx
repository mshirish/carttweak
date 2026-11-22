import { useState } from 'react';
import { api, ApiError } from '../api.ts';
import type { Branch, Store } from '../types.ts';

export function StoreScreen({ current, defaultBranch, onChoose }: { current: Branch | null; defaultBranch: Branch | null; onChoose: (b: Branch) => void }) {
  const [zip, setZip] = useState('');
  const [stores, setStores] = useState<Store[] | null>(null);
  const [hidden, setHidden] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function find(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^\d{5}$/.test(zip.trim())) {
      setError('Enter a 5-digit ZIP code.');
      return;
    }
    setLoading(true);
    try {
      const r = await api.stores(zip.trim());
      setStores(r.stores);
      setHidden(r.dropped.length);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section>
      <h1>Choose your store</h1>
      <p className="lede">Prices and package sizes come from this Kroger store, so swaps match what is on its shelves.</p>
      {defaultBranch ? (
        <div className="panel rule-top" style={{ marginBottom: 16 }}>
          <h3>{current?.locationId === defaultBranch.locationId ? 'Current store' : 'Demo store'}</h3>
          <p style={{ margin: '0 0 10px' }}>
            <strong>{defaultBranch.name}</strong>
            <br />
            <span className="muted">{defaultBranch.address}</span>
          </p>
          <button type="button" className="btn primary" onClick={() => onChoose(defaultBranch)}>
            Use this store
          </button>
        </div>
      ) : null}
      <form onSubmit={find} className="panel">
        <label className="field" htmlFor="zip">
          Or find a store by ZIP code
        </label>
        <div className="row">
          <input id="zip" type="text" inputMode="numeric" autoComplete="postal-code" maxLength={5} placeholder="e.g. 45202" value={zip} onChange={(e) => setZip(e.target.value)} style={{ flex: '1 1 160px', width: 'auto' }} />
          <button className="btn" type="submit" disabled={loading}>
            {loading ? 'Finding…' : 'Find stores'}
          </button>
        </div>
        {error ? <p className="error" role="alert">{error}</p> : null}
        {stores ? (
          <>
            <ul className="store-list" aria-label="Stores">
              {stores.map((s) => (
                <li key={s.locationId}>
                  <button type="button" className={`choice${current?.locationId === s.locationId ? ' selected' : ''}`} onClick={() => onChoose(s)}>
                    <span>
                      <strong>{s.name}</strong>
                      <br />
                      <span className="muted small">{s.address}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {stores.length === 0 ? <p className="muted">No Kroger-family stores near {zip}.</p> : null}
            {hidden ? <p className="help">{hidden} warehouse or pickup-only location{hidden === 1 ? '' : 's'} hidden.</p> : null}
          </>
        ) : null}
      </form>
    </section>
  );
}
