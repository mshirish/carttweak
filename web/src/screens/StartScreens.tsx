import { go } from '../router.ts';

export function StartScreen({ onDemo, demoAvailable, loadingDemo }: { onDemo: () => void; demoAvailable: boolean; loadingDemo: boolean }) {
  return (
    <section>
      <h1>Plan my next trip</h1>
      <p className="lede">Tell us what you usually buy. We'll suggest up to two swaps that move you toward a nutrition goal, within a budget you set.</p>
      <div className="grid-2">
        <div className="panel rule-top start-card">
          <h2>Enter my shopping list</h2>
          <p className="muted">Type or paste your items, one per line. We'll match each one to a product at your store.</p>
          <button type="button" className="btn primary" onClick={() => go({ name: 'list' })}>
            Enter my list
          </button>
        </div>
        <div className="panel rule-top start-card">
          <h2>Upload a receipt</h2>
          <p className="muted">Start from a past receipt instead of typing.</p>
          <button type="button" className="btn primary" onClick={() => go({ name: 'receipt' })}>
            Upload a receipt
          </button>
        </div>
      </div>
      {demoAvailable ? (
        <p style={{ marginTop: 18 }}>
          <button type="button" className="btn ghost" onClick={onDemo} disabled={loadingDemo}>
            {loadingDemo ? 'Loading demo list…' : 'Use demo list'}
          </button>{' '}
          <span className="badge sample">Sample list</span>
        </p>
      ) : null}
    </section>
  );
}

export function ReceiptScreen() {
  return (
    <section>
      <h1>Upload a receipt</h1>
      <div className="panel rule-top">
        <p style={{ marginTop: 0 }}>
          <strong>Receipt reading arrives in the next update.</strong>
        </p>
        <p className="muted">For now, enter your list by hand. It takes about a minute, and you can use quantities like "2 bananas".</p>
        <div className="actions">
          <button type="button" className="btn primary" onClick={() => go({ name: 'list' })}>
            Enter my list instead
          </button>
          <button type="button" className="btn" onClick={() => go({ name: 'start' })}>
            Back
          </button>
        </div>
      </div>
    </section>
  );
}

export function ListScreen({
  text,
  isSample,
  onChange,
  onSubmit,
  loading,
  error,
}: {
  text: string;
  isSample: boolean;
  onChange: (t: string) => void;
  onSubmit: () => void;
  loading: boolean;
  error: string | null;
}) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
  return (
    <section>
      <h1>Your shopping list</h1>
      <p className="lede">One item per line. Add a number first for more than one, like "2 bananas". Brand and size help us find the exact product.</p>
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <div className="row" style={{ marginBottom: 6 }}>
          <label className="field" htmlFor="list" style={{ margin: 0 }}>
            Items
          </label>
          {isSample ? <span className="badge sample">Sample list</span> : null}
          <span className="spacer" />
          <span className="small muted num">{lines} item{lines === 1 ? '' : 's'}</span>
        </div>
        <textarea id="list" value={text} onChange={(e) => onChange(e.target.value)} placeholder={'2 bananas\nJif Creamy Peanut Butter 16 oz\nwhole milk gallon'} spellCheck={false} />
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="actions">
          <button className="btn primary" type="submit" disabled={loading || lines === 0}>
            {loading ? 'Checking your store…' : 'Check my list'}
          </button>
        </div>
      </form>
    </section>
  );
}
