import { dollars, GOALS, shortName } from '@carttweak/shared';
import { SwapCard } from '../components/SwapCard.tsx';
import { hrefFor } from '../router.ts';
import type { SavedTrip } from '../storage.ts';

function when(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function SavedScreen({ trips, warning }: { trips: SavedTrip[]; warning: string | null }) {
  return (
    <section>
      <h1>Saved trips</h1>
      {warning ? <p className="notice" role="status">{warning}</p> : null}
      {trips.length === 0 ? (
        <p className="muted">No saved trips yet. Plan a trip and tap “Save revised list”.</p>
      ) : (
        <ul className="trip-list">
          {trips.map((t) => (
            <li key={t.id}>
              <a className="choice" href={hrefFor({ name: 'trip', id: t.id })} style={{ textDecoration: 'none' }}>
                <span>
                  <strong>{when(t.createdAt)}</strong>
                  {t.listIsSample ? <> <span className="badge sample">Sample list</span></> : null}
                  <br />
                  <span className="small muted">
                    {t.branch.name} · {t.originalItems.length} items · {t.acceptedSwaps.length} swap{t.acceptedSwaps.length === 1 ? '' : 's'} · goal: {t.goals.primary ? GOALS[t.goals.primary].label : 'none'}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function TripScreen({ trip, now }: { trip: SavedTrip | null; now: string }) {
  if (!trip) {
    return (
      <section>
        <h1>Trip not found</h1>
        <a href={hrefFor({ name: 'saved' })}>Back to saved trips</a>
      </section>
    );
  }
  const total = trip.acceptedSwaps.reduce((s, x) => s + x.cost.regular.differenceCents, 0);
  return (
    <section>
      <p className="small">
        <a href={hrefFor({ name: 'saved' })}>← Saved trips</a>
      </p>
      <h1>Revised list</h1>
      <p className="lede">
        {when(trip.createdAt)} · {trip.branch.name}, {trip.branch.address}
        <br />
        Goal: {trip.goals.primary ? GOALS[trip.goals.primary].label : 'none'}
        {trip.goals.secondary ? `, also ${GOALS[trip.goals.secondary].label}` : ''} · budget {dollars(trip.budgetCents)} · accepted swaps{' '}
        {total === 0 ? 'same price' : total > 0 ? `${dollars(total)} more` : `save ${dollars(-total)}`} at regular price
        {trip.listIsSample ? <> <span className="badge sample">Sample list</span></> : null}
      </p>
      <ul className="revised">
        {trip.revisedList.map((l) => (
          <li key={l.itemId}>
            <span className="qty num">{l.quantity}×</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              {shortName(l.description)} {l.sizeLabel ? <span className="muted num">({l.sizeLabel})</span> : null}
              {l.swapped ? <span className="was">was {shortName(l.replaces ?? '')}</span> : null}
            </span>
            {l.swapped ? <span className="badge accent">Swapped</span> : l.locked ? <span className="badge">Kept</span> : null}
          </li>
        ))}
      </ul>
      {trip.acceptedSwaps.length ? (
        <>
          <h2>Accepted swaps</h2>
          {trip.acceptedSwaps.map((s) => (
            <div key={s.itemId} style={{ marginBottom: 18 }}>
              <SwapCard swap={s} now={now} />
              <div className="row" style={{ marginTop: 8 }}>
                <button type="button" className="btn" disabled aria-describedby={`soon-${s.itemId}`}>
                  Try this swap
                </button>
                <span id={`soon-${s.itemId}`} className="small muted">
                  Challenges arrive in a later update.
                </span>
              </div>
            </div>
          ))}
        </>
      ) : null}
    </section>
  );
}
