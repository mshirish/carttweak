import { useEffect, useRef, useState } from 'react';
import { dollars, shortName } from '@carttweak/shared';
import { Heart } from '../components/Icons.tsx';
import { DEFAULT_PREP, preprocess, recognize, type Prep } from '../ocr.ts';
import { priceCents, receiptFromOcr, rowNeedsLook, type MatchCard, type MatchRow, type ReceiptRow, type ReceiptState } from '../receipt.ts';
import { go } from '../router.ts';
import type { Branch } from '../types.ts';

// ---------- 1. upload + prepare + OCR ----------
export function ReceiptUploadScreen({ onRead }: { onRead: (s: ReceiptState) => void }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [prep, setPrep] = useState<Prep>(DEFAULT_PREP);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ status: string; progress: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const url = useRef<string | null>(null);

  useEffect(() => () => void (url.current && URL.revokeObjectURL(url.current)), []);
  useEffect(() => {
    if (img && canvas.current) preprocess(img, prep, canvas.current);
  }, [img, prep]);

  function pick(f: File | undefined) {
    setError(null);
    if (!f) return;
    if (!/^image\//.test(f.type)) {
      setError('Please choose a photo (JPG or PNG).');
      return;
    }
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = URL.createObjectURL(f);
    const i = new Image();
    i.onload = () => {
      setImg(i);
      setPrep(DEFAULT_PREP);
    };
    i.onerror = () => setError("That photo couldn't be opened.");
    i.src = url.current;
  }

  async function read() {
    if (!img || !canvas.current) return;
    setBusy(true);
    setError(null);
    try {
      const lines = await recognize(preprocess(img, prep, document.createElement('canvas')), setProgress);
      const { state } = receiptFromOcr(lines);
      if (!state.rows.length) {
        setError('No item lines were found. Try rotating the photo, cropping to the items, or turning on black & white.');
        return;
      }
      // drop the photo: it is never stored or sent
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = null;
      onRead(state);
    } catch {
      setError('Reading the receipt failed. Check your connection (the reader downloads once) and try again.');
    } finally {
      setBusy(false);
    }
  }

  const set = (p: Partial<Prep>) => setPrep((x) => ({ ...x, ...p }));
  const setCrop = (k: keyof Prep['crop'], v: number) => setPrep((x) => ({ ...x, crop: { ...x.crop, [k]: v } }));
  return (
    <section>
      <h1>Upload a receipt</h1>
      <p className="lede">Walmart receipts work best. Your photo stays on this device: we read it here and only send the item lines to check prices. The photo is never saved.</p>
      <div className="panel rule-top">
        <label className="btn primary" style={{ width: '100%' }}>
          {img ? 'Choose a different photo' : 'Choose a receipt photo'}
          <input type="file" accept="image/*" capture="environment" className="sr-only" data-testid="receipt-file" onChange={(e) => pick(e.target.files?.[0])} />
        </label>
        {error ? <p className="error" role="alert">{error}</p> : null}
        {img ? (
          <>
            <div className="receipt-preview">
              <canvas ref={canvas} aria-label="Receipt preview" />
            </div>
            <div className="prep-controls">
              <div className="row">
                <button type="button" className="btn small" onClick={() => set({ rotation: prep.rotation + 3 })} aria-label="Rotate left">
                  ⟲ Rotate left
                </button>
                <button type="button" className="btn small" onClick={() => set({ rotation: prep.rotation + 1 })} aria-label="Rotate right">
                  Rotate right ⟳
                </button>
                <label className="toggle">
                  <input type="checkbox" checked={prep.threshold} onChange={(e) => set({ threshold: e.target.checked })} /> Black &amp; white
                </label>
              </div>
              <label className="field small">
                Contrast
                <input type="range" min={0.5} max={2.5} step={0.1} value={prep.contrast} onChange={(e) => set({ contrast: Number(e.target.value) })} />
              </label>
              <details>
                <summary>Crop (optional)</summary>
                {(['top', 'bottom', 'left', 'right'] as const).map((k) => (
                  <label key={k} className="field small">
                    Trim {k}: {prep.crop[k]}%
                    <input type="range" min={0} max={45} step={1} value={prep.crop[k]} onChange={(e) => setCrop(k, Number(e.target.value))} />
                  </label>
                ))}
              </details>
            </div>
            {busy ? (
              <div className="progress" role="status" aria-live="polite">
                <strong>{progress?.status ? progress.status.replace(/^./, (c) => c.toUpperCase()) : 'Starting the reader'}…</strong>
                <div className="bar" aria-hidden="true">
                  <span style={{ width: `${Math.round((progress?.progress ?? 0) * 100)}%` }} />
                </div>
                <p className="help">Reading happens on this device. The first time, the reader downloads (about 10 MB).</p>
              </div>
            ) : (
              <div className="actions">
                <button type="button" className="btn primary" onClick={read}>
                  Read receipt
                </button>
              </div>
            )}
          </>
        ) : null}
      </div>
      <p className="small" style={{ marginTop: 14 }}>
        <button type="button" className="btn ghost" onClick={() => go({ name: 'list' })}>
          Or type your list instead
        </button>
      </p>
    </section>
  );
}

// ---------- 2. check what we read ----------
export function ReceiptCheckScreen({ state, setState, onContinue, busy, error }: { state: ReceiptState; setState: (fn: (s: ReceiptState) => ReceiptState) => void; onContinue: () => void; busy: boolean; error: string | null }) {
  const need = state.rows.filter(rowNeedsLook).length;
  const setRow = (id: string, patch: Partial<ReceiptRow>) => setState((s) => ({ ...s, rows: s.rows.map((r) => (r.id === id ? { ...r, ...patch, reviewed: true } : r)) }));
  const remove = (id: string) => setState((s) => ({ ...s, rows: s.rows.filter((r) => r.id !== id) }));
  const add = () =>
    setState((s) => ({
      ...s,
      rows: [...s.rows, { id: `n${Date.now().toString(36)}`, name: '', code: '', quantity: '1', price: '', confidence: null, needsLook: true, reviewed: false, issues: ['added by you'], fromUnparsed: false }],
    }));
  const setH = (k: keyof ReceiptState['header'], v: string) => setState((s) => ({ ...s, header: { ...s.header, [k]: v } }));
  const total = state.rows.reduce((t, r) => t + (priceCents(r.price) ?? 0), 0);
  const zipOk = /^\d{5}$/.test(state.header.zip.trim());
  return (
    <section>
      <h1>Check what we read</h1>
      <p className="lede">
        <strong className="num" data-testid="need-look">
          {need} of {state.rows.length} lines need a look.
        </strong>{' '}
        Highlighted rows were hard to read. Fix anything that's wrong; nothing is dropped without you.
        {state.dropped ? ` We removed ${state.dropped} payment and ID line${state.dropped === 1 ? '' : 's'} for your privacy.` : ''}
      </p>
      <fieldset className="panel rule-top receipt-header">
        <legend className="sr-only">Store</legend>
        <label className="field small">
          Walmart store #
          <input type="text" inputMode="numeric" value={state.header.storeNumber} onChange={(e) => setH('storeNumber', e.target.value)} />
        </label>
        <label className="field small">
          ZIP {zipOk ? '' : <span className="badge warn">needed</span>}
          <input type="text" inputMode="numeric" maxLength={5} value={state.header.zip} onChange={(e) => setH('zip', e.target.value)} />
        </label>
        <label className="field small">
          Date
          <input type="text" placeholder="YYYY-MM-DD" value={state.header.date} onChange={(e) => setH('date', e.target.value)} />
        </label>
      </fieldset>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <ul className="items receipt-rows">
        {state.rows.map((r) => {
          const look = rowNeedsLook(r);
          return (
            <li key={r.id} className={`item rrow${look ? ' look' : ''}`} data-testid="receipt-row">
              <div className="rrow-grid">
                <label className="rname">
                  <span className="sr-only">Name</span>
                  <input type="text" value={r.name} placeholder="Item name" onChange={(e) => setRow(r.id, { name: e.target.value })} />
                </label>
                <label className="rcode">
                  <span className="sr-only">Item code</span>
                  <input type="text" inputMode="numeric" value={r.code} placeholder="Item code" onChange={(e) => setRow(r.id, { code: e.target.value })} />
                </label>
                <label className="rqty">
                  <span className="sr-only">Quantity</span>
                  <input type="text" inputMode="numeric" value={r.quantity} onChange={(e) => setRow(r.id, { quantity: e.target.value })} />
                </label>
                <label className="rprice">
                  <span className="sr-only">Price</span>
                  <input type="text" inputMode="decimal" value={r.price} placeholder="0.00" onChange={(e) => setRow(r.id, { price: e.target.value })} />
                </label>
              </div>
              <div className="row small" style={{ marginTop: 4 }}>
                <span className={`badge${r.confidence != null && r.confidence < 80 ? ' warn' : ''}`} title="How sure the reader is about this line">
                  {r.confidence == null ? 'typed' : `read ${r.confidence}%`}
                </span>
                {look && r.issues.length ? <span className="muted">{r.issues.join('; ')}</span> : null}
                <span className="spacer" />
                {look ? (
                  <button type="button" className="btn ghost small" onClick={() => setRow(r.id, {})}>
                    Looks right
                  </button>
                ) : null}
                <button type="button" className="btn ghost small" onClick={() => remove(r.id)}>
                  Remove
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="row" style={{ marginTop: 10 }}>
        <button type="button" className="btn small" onClick={add}>
          + Add a line
        </button>
        <span className="spacer" />
        <span className="num small muted">
          Lines add up to {dollars(total)}
          {state.subtotalCents != null ? ` · receipt subtotal ${dollars(state.subtotalCents)}` : ''}
        </span>
      </div>
      <div className="actions">
        <button type="button" className="btn primary" disabled={busy || !state.rows.length} onClick={onContinue}>
          {busy ? 'Matching products…' : 'Match products'}
        </button>
      </div>
    </section>
  );
}

// ---------- 3. match ----------
const METHOD_TEXT = { barcode: 'Matched by barcode', shopper_confirmed: 'You confirmed', unmatched: 'Not matched' } as const;

function Card({ c }: { c: MatchCard }) {
  return (
    <span className="pick" style={{ flex: 1, minWidth: 0 }}>
      <span className="p-name">{shortName(c.description)}</span>
      <span className="p-price num">{c.regularCents != null ? dollars(c.regularCents) : ''}</span>
      <span className="p-sub">{c.sizeLabel ?? 'size unknown'}</span>
    </span>
  );
}

export function ReceiptMatchScreen({
  rows,
  setRows,
  walmart,
  zip,
  fallbackBranch,
  onPlanWalmart: _onPlanWalmart,
  onPlanFallback,
  busy = false,
  error = null,
}: {
  rows: MatchRow[];
  setRows: (fn: (r: MatchRow[]) => MatchRow[]) => void;
  walmart: { available: boolean; reason: string | null };
  zip: string;
  fallbackBranch: Branch | null;
  onPlanWalmart: () => void;
  onPlanFallback: () => void;
  busy?: boolean;
  error?: string | null;
}) {
  const set = (id: string, patch: Partial<MatchRow>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const counts = { barcode: 0, shopper_confirmed: 0, unmatched: 0, pending: 0 };
  for (const r of rows) r.status === 'needs_confirm' ? counts.pending++ : counts[r.matchMethod]++;
  const usableForKroger = rows.filter((r) => r.status === 'matched' && r.product?.krogerProductId).length;
  return (
    <section>
      <h1>Match your items</h1>
      <p className="lede num">
        {counts.barcode} matched by barcode · {counts.shopper_confirmed} you confirmed · {counts.unmatched} not matched
        {counts.pending ? ` · ${counts.pending} to pick` : ''}. Unmatched items stay on your list and are never swapped.
      </p>
      <p className="notice" role="status">Prices from {fallbackBranch?.name ?? "Kroger On the Rhine"}; Walmart prices coming soon.</p>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <ul className="items">
        {rows.map((r) => (
          <li className="item" key={r.id} data-status={r.status}>
            <div className="item-head">
              <div className="item-main">
                <span className={`chip ${r.status === 'matched' ? 'matched' : r.status === 'needs_confirm' ? 'choose' : 'no_barcode'}`}>
                  {r.status === 'needs_confirm' ? 'Pick one' : METHOD_TEXT[r.matchMethod]}
                </span>
                <div className="item-name">{r.product ? shortName(r.product.description) : r.name}</div>
                <div className="item-meta num">
                  Receipt: {r.name}
                  {r.code ? ` · ${r.code}` : ''}
                  {r.priceCents != null ? ` · paid ${dollars(r.priceCents)}` : ''}
                  {r.product?.sizeLabel ? ` · ${r.product.sizeLabel}` : ''}
                </div>
                {r.status === 'matched' && r.via === 'fdc' ? <div className="item-meta">Barcode found in the USDA label database.</div> : null}
                {r.status === 'unmatched' && r.reason && !r.produceConfirmed && !r.nonFood ? <div className="item-meta">{r.reason}. Kept on your list, never swapped.</div> : null}
                {r.produceConfirmed ? (
                  <div className="item-meta">
                    <span className="chip matched">USDA generic record, you confirmed</span> {r.produceConfirmed.description}{' '}
                    <button type="button" className="btn ghost small" onClick={() => set(r.id, { produceConfirmed: null })}>
                      Undo
                    </button>
                  </div>
                ) : null}
                {r.status === 'unmatched' && r.nonFood ? (
                  <div className="item-meta">
                    <span className="chip no_barcode">{r.nonFoodGuess ? 'Not food?' : 'Not food'}</span> Not scored.{' '}
                    <button type="button" className="btn ghost small" onClick={() => set(r.id, { nonFood: false, nonFoodGuess: false })}>
                      Undo
                    </button>
                  </div>
                ) : r.status === 'unmatched' && !r.produceConfirmed ? (
                  <button type="button" className="btn ghost small" onClick={() => set(r.id, { nonFood: true, nonFoodGuess: false })}>
                    Not food
                  </button>
                ) : null}
              </div>
              {r.status === 'matched' ? (
                <button type="button" className="lock" aria-pressed={r.locked} onClick={() => set(r.id, { locked: !r.locked })}>
                  <Heart filled={r.locked} />
                  Keep this
                </button>
              ) : null}
            </div>
            {r.status === 'unmatched' && !r.nonFood && !r.produceConfirmed && !r.produceDismissed && r.produceGuess && r.produceCandidates?.length ? (
              <div data-testid="produce-confirm">
                <div className="item-meta" style={{ marginTop: 6 }}>
                  <strong>Is this {r.produceGuess.label.toLowerCase()}?</strong> Pick the closest USDA generic food so we can score it.
                </div>
                <ul className="pick-list" aria-label={`USDA options for ${r.name}`}>
                  {r.produceCandidates.map((c) => (
                    <li key={c.fdcId}>
                      <button type="button" className="choice" onClick={() => set(r.id, { produceConfirmed: c })}>
                        {c.description}
                      </button>
                    </li>
                  ))}
                </ul>
                <button type="button" className="btn ghost small" onClick={() => set(r.id, { produceDismissed: true })}>
                  No, leave it unscored
                </button>
              </div>
            ) : null}
            {r.status === 'needs_confirm' ? (
              <>
                <ul className="pick-list" aria-label={`Options for ${r.name}`}>
                  {r.candidates.map((c) => (
                    <li key={c.walmartItemId ?? c.gtin14 ?? c.description}>
                      <button type="button" className="choice" onClick={() => set(r.id, { status: 'matched', matchMethod: 'shopper_confirmed', via: 'shopper', product: c })}>
                        <Card c={c} />
                      </button>
                    </li>
                  ))}
                </ul>
                <button type="button" className="btn ghost small" onClick={() => set(r.id, { status: 'unmatched', matchMethod: 'unmatched', reason: 'skipped by you' })}>
                  Skip this item
                </button>
              </>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="actions">
        <button type="button" className="btn primary" disabled={busy || counts.pending > 0} onClick={onPlanFallback}>
          {busy ? "Scoring your haul…" : counts.pending ? `Pick or skip ${counts.pending} item${counts.pending === 1 ? "" : "s"}` : "See your haul score"}
        </button>
      </div>
    </section>
  );
}
