import { useState } from 'react';
import { dollars } from '@carttweak/shared';
import type { Profile } from '../profiles.ts';
import { go, hrefFor } from '../router.ts';
import type { SavedTrip } from '../storage.ts';

export function LoginScreen({ profiles, onSignIn, onPick, warning }: { profiles: Profile[]; onSignIn: (name: string) => void; onPick: (id: string) => void; warning: string | null }) {
  const [name, setName] = useState('');
  return (
    <section>
      <h1>Who's shopping?</h1>
      <p className="lede">Rate your grocery haul and find easy swaps. Just a name, no password.</p>
      {profiles.length ? (
        <ul className="store-list" aria-label="Profiles">
          {profiles.map((p) => (
            <li key={p.id}>
              <button type="button" className="choice" onClick={() => onPick(p.id)}>
                <strong>{p.name}</strong>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="panel rule-top"
        style={{ marginTop: 16 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onSignIn(name);
        }}
      >
        <label className="field" htmlFor="who">
          {profiles.length ? 'Or add someone new' : 'Your name'}
        </label>
        <div className="row">
          <input id="who" type="text" autoComplete="given-name" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sam" style={{ flex: '1 1 200px', width: 'auto' }} />
          <button className="btn primary" type="submit" disabled={!name.trim()}>
            Start
          </button>
        </div>
        <p className="help">Profiles are saved in this browser only.</p>
        {warning ? <p className="notice">{warning}</p> : null}
      </form>
    </section>
  );
}

export function HomeScreen({ profile, hauls, onDemo, demoAvailable }: { profile: Profile; hauls: SavedTrip[]; onDemo: () => void; demoAvailable: boolean }) {
  return (
    <section>
      <h1>Hi {profile.name}</h1>
      <p className="lede">Upload a grocery receipt to rate your haul out of 100, then find swaps that raise the score within your budget.</p>
      <div className="panel rule-top home-upload">
        <h2 style={{ marginTop: 0 }}>Upload a receipt</h2>
        <p className="muted">Walmart receipts work best. Your photo stays on this device.</p>
        <button type="button" className="btn primary big" onClick={() => go({ name: 'receipt' })}>
          Upload a receipt
        </button>
      </div>
      <p style={{ marginTop: 12 }}>
        <a href={hrefFor({ name: 'list' })}>No receipt? Type your list</a>
        {demoAvailable ? (
          <>
            {' · '}
            <button type="button" className="btn ghost small" onClick={onDemo} style={{ padding: 0 }}>
              Use demo list
            </button>{' '}
            <span className="badge sample">Sample list</span>
          </>
        ) : null}
      </p>
      <h2>Your past hauls</h2>
      {hauls.length ? (
        <ul className="trip-list" aria-label="Past hauls">
          {hauls.map((t) => (
            <li key={t.id}>
              <a className="choice" href={hrefFor({ name: 'trip', id: t.id })} style={{ textDecoration: 'none' }}>
                <span className="haul-mini num">{t.haul?.score ?? '–'}</span>
                <span>
                  <strong>{t.date ?? t.createdAt.slice(0, 10)}</strong> · {t.storeLabel ?? t.branch.name}
                  <br />
                  <span className="small muted num">
                    {t.totalSpentCents != null ? dollars(t.totalSpentCents) : ''} · {t.originalItems.length} items · {t.source === 'receipt' ? 'receipt' : 'typed list'}
                    {t.acceptedSwaps.length ? ` · ${t.acceptedSwaps.length} swap${t.acceptedSwaps.length === 1 ? '' : 's'}` : ''}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No hauls yet.</p>
      )}
    </section>
  );
}
