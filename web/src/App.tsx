import { useCallback, useEffect, useRef, useState } from 'react';
import { parseShoppingList } from '@carttweak/shared';
import { api, ApiError, runPlan } from './api.ts';
import { go, hrefFor, parseHash, type Route } from './router.ts';
import { AboutScreen } from './screens/AboutScreen.tsx';
import { CheckScreen, rowFromResolve } from './screens/CheckScreen.tsx';
import { GoalsScreen } from './screens/GoalsScreen.tsx';
import { ResultsScreen } from './screens/ResultsScreen.tsx';
import { SavedScreen, TripScreen } from './screens/SavedScreens.tsx';
import { ListScreen, StartScreen } from './screens/StartScreens.tsx';
import { ReceiptCheckScreen, ReceiptMatchScreen, ReceiptUploadScreen } from './screens/ReceiptScreens.tsx';
import { matchRequest, mergeMatchedRows, productKey, type MatchRow, type ReceiptState } from './receipt.ts';
import { StoreScreen } from './screens/StoreScreen.tsx';
import { buildRevisedList, newId, tripStore, type SavedItem, type SavedTrip } from './storage.ts';
import type { Branch, Goals, PlanProgress, PlanResponse, Row, SwapOption } from './types.ts';

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

function Header({ branch, route, note }: { branch: Branch | null; route: Route; note?: string | null }) {
  const cur = (names: Route['name'][]) => (names.includes(route.name) ? ('page' as const) : undefined);
  return (
    <header className="header">
      <a className="brand" href={hrefFor({ name: 'start' })}>
        CartTweak
      </a>
      <div className="branch" aria-label="Your store">
        {branch ? (
          <>
            <strong>{branch.name}</strong>
            {note ? <span className="badge warn" style={{ marginLeft: 6 }}>{note}</span> : null}
            <span className="addr">{branch.address}</span> ·{' '}
            <a href={hrefFor({ name: 'store' })} className="small">
              Change
            </a>
          </>
        ) : (
          <a href={hrefFor({ name: 'store' })}>Choose a store</a>
        )}
      </div>
      <nav className="nav" aria-label="Main">
        <a href={hrefFor({ name: 'start' })} aria-current={cur(['start', 'list', 'check', 'goals', 'results', 'receipt', 'receipt-check', 'receipt-match'])}>
          Plan
        </a>
        <a href={hrefFor({ name: 'saved' })} aria-current={cur(['saved', 'trip'])}>
          Saved trips
        </a>
        <a href={hrefFor({ name: 'about' })} aria-current={cur(['about'])}>
          About the data
        </a>
      </nav>
    </header>
  );
}

export default function App() {
  const route = useRoute();
  const [branch, setBranch] = useState<Branch | null>(null);
  const [defaultBranch, setDefaultBranch] = useState<Branch | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [demoAvailable, setDemoAvailable] = useState(false);
  const [listText, setListText] = useState('');
  const [listIsSample, setListIsSample] = useState(false);
  const [demoLocks, setDemoLocks] = useState<Set<string>>(new Set());
  const [loadingDemo, setLoadingDemo] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [rows, setRowsState] = useState<Row[]>([]);
  const [goals, setGoals] = useState<Goals>({ primary: null, secondary: null });
  const [budgetCents, setBudget] = useState(200);
  const [resp, setResp] = useState<PlanResponse | null>(null);
  const [progress, setProgress] = useState<PlanProgress | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [accepted, setAccepted] = useState<Record<string, string>>({});
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date().toISOString());
  const planSeq = useRef(0);
  // receipt flow
  const [tripSource, setTripSource] = useState<'list' | 'receipt'>('list');
  const [receipt, setReceipt] = useState<ReceiptState | null>(null);
  const [matchRows, setMatchRows] = useState<MatchRow[]>([]);
  const [walmart, setWalmart] = useState<{ available: boolean; reason: string | null }>({ available: false, reason: null });
  const [planTarget, setPlanTarget] = useState<'walmart' | 'kroger'>('kroger');
  const [matching, setMatching] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);
  const receiptMeta = useRef<{ zip: string; storeNumber: string | null; date: string | null }>({ zip: '', storeNumber: null, date: null });

  useEffect(() => {
    const t = setInterval(() => setNow(new Date().toISOString()), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    api
      .config()
      .then((c) => {
        setDefaultBranch(c.defaultBranch);
        setDemoAvailable(c.demoList);
        setBranch((b) => b ?? c.defaultBranch);
      })
      .catch((e) => setConfigError(e instanceof ApiError ? e.message : 'Could not load settings.'))
      .finally(() => setReady(true));
  }, []);

  // guards: later steps need the earlier ones
  useEffect(() => {
    if (!ready) return; // wait for the default store
    const receiptTrip = tripSource === 'receipt' && matchRows.length > 0;
    if (route.name === 'receipt-check' && !receipt) go({ name: 'receipt' });
    else if (route.name === 'receipt-match' && !matchRows.length) go({ name: receipt ? 'receipt-check' : 'receipt' });
    else if (['list', 'check'].includes(route.name) && !branch) go({ name: 'store' });
    else if (['goals', 'results'].includes(route.name) && !receiptTrip && !branch) go({ name: 'store' });
    else if (['goals', 'results'].includes(route.name) && !receiptTrip && rows.length === 0) go({ name: 'list' });
    else if (route.name === 'check' && rows.length === 0) go({ name: 'list' });
    else if (route.name === 'results' && !goals.primary) go({ name: 'goals' });
  }, [ready, route.name, branch, rows.length, goals.primary, tripSource, matchRows.length, receipt]);

  const setRows = useCallback((fn: (r: Row[]) => Row[]) => setRowsState(fn), []);

  async function loadDemo() {
    setLoadingDemo(true);
    try {
      const d = await api.demoList();
      setListText(d.text);
      setListIsSample(true);
      setDemoLocks(new Set(d.items.filter((i) => i.tags.includes('lock')).map((i) => i.query)));
      go({ name: 'list' });
    } catch (e) {
      setConfigError(e instanceof ApiError ? e.message : 'Could not load the demo list.');
    } finally {
      setLoadingDemo(false);
    }
  }

  async function checkList() {
    if (!branch) return go({ name: 'store' });
    const parsed = parseShoppingList(listText);
    if (!parsed.length) return;
    if (parsed.length > 40) {
      setListError('Up to 40 items per trip, please.');
      return;
    }
    setResolving(true);
    setListError(null);
    try {
      const items = parsed.map((p, i) => ({ id: `i${String(i + 1).padStart(2, '0')}`, query: p.query, quantity: p.quantity }));
      const r = await api.resolve(branch.locationId, items);
      setRowsState(r.items.map((it) => rowFromResolve(it, demoLocks.has(it.query))));
      setTripSource('list');
      setResp(null);
      setExcluded([]);
      setAccepted({});
      go({ name: 'check' });
    } catch (e) {
      setListError(e instanceof ApiError ? e.message : 'Could not check your list.');
    } finally {
      setResolving(false);
    }
  }

  function receiptPlanBody() {
    const m = receiptMeta.current;
    const paid = (r: MatchRow) => (r.priceCents != null ? { cents: r.priceCents, date: m.date, storeNumber: m.storeNumber, quantity: r.quantity } : undefined);
    // the same product on several receipt lines becomes one item (quantity and paid add up)
    const matched = mergeMatchedRows(matchRows);
    if (planTarget === 'walmart') {
      return {
        chain: 'walmart',
        zip: m.zip,
        items: matched.map((r) => ({ id: r.id, ...(r.product!.walmartItemId ? { walmartItemId: r.product!.walmartItemId } : { code: r.code }), quantity: r.quantity, paid: paid(r) })),
      };
    }
    return {
      locationId: defaultBranch?.locationId,
      items: matched.filter((r) => r.product!.krogerProductId).map((r) => ({ id: r.id, productId: r.product!.krogerProductId, quantity: r.quantity, paid: paid(r) })),
    };
  }

  async function plan(excludedIds = excluded, pinned: Array<{ itemId: string; candidateRef: string }> = []) {
    const receiptTrip = tripSource === 'receipt';
    if ((!receiptTrip && !branch) || !goals.primary) return;
    const seq = ++planSeq.current;
    setPlanning(true);
    setPlanError(null);
    setProgress(null);
    go({ name: 'results' });
    const listBody = () => ({
      locationId: branch!.locationId,
      items: rows
        .filter((r) => r.status === 'matched' || r.status === 'no_barcode')
        .map((r) => (r.status === 'matched' && r.product ? { id: r.id, productId: r.product.productId, quantity: r.quantity } : { id: r.id, query: r.query, quantity: r.quantity })),
    });
    const body = {
      ...(receiptTrip ? receiptPlanBody() : listBody()),
      locks: receiptTrip ? mergeMatchedRows(matchRows).filter((r) => r.locked).map((r) => r.id) : rows.filter((r) => r.locked).map((r) => r.id),
      goals: { primary: goals.primary, secondary: goals.secondary },
      budget: { maxExtraSpendCents: budgetCents },
      excludedCandidateIds: excludedIds,
      pinnedSwaps: pinned,
    };
    try {
      const r = await runPlan(body, (p) => seq === planSeq.current && setProgress(p));
      if (seq !== planSeq.current) return;
      setResp(r);
      // keep acceptances that are still on offer
      setAccepted((a) => Object.fromEntries(Object.entries(a).filter(([item, ref]) => r.plan.swaps.some((s) => s.itemId === item && s.replacement.ref === ref))));
    } catch (e) {
      if (seq === planSeq.current) setPlanError(e instanceof ApiError ? e.message : 'Planning failed.');
    } finally {
      if (seq === planSeq.current) setPlanning(false);
    }
  }

  function reject(s: SwapOption) {
    const next = [...excluded, s.replacement.ref];
    setExcluded(next);
    setAccepted((a) => {
      const { [s.itemId]: _drop, ...rest } = a;
      return rest;
    });
    // accepted swaps stay fixed; only the rejected slot is re-planned with what's left of the budget
    const pins = Object.entries(accepted)
      .filter(([itemId]) => itemId !== s.itemId)
      .map(([itemId, candidateRef]) => ({ itemId, candidateRef }));
    void plan(next, pins);
  }

  function toggleAccept(s: SwapOption) {
    setAccepted((a) => (a[s.itemId] === s.replacement.ref ? Object.fromEntries(Object.entries(a).filter(([k]) => k !== s.itemId)) : { ...a, [s.itemId]: s.replacement.ref }));
  }

  function save() {
    if (!resp) return;
    const receiptTrip = tripSource === 'receipt';
    // receipt images are never saved: only the item lines, matches and prices
    const originalItems: SavedItem[] = receiptTrip
      ? [...mergeMatchedRows(matchRows), ...matchRows.filter((r) => productKey(r) == null)].map((r) => ({
          itemId: r.id,
          query: r.name,
          quantity: r.quantity,
          status: r.status === 'matched' ? ('matched' as const) : ('unmatched' as const),
          locked: r.locked,
          matchMethod: r.status === 'needs_confirm' ? ('unmatched' as const) : r.matchMethod,
          paidCents: r.priceCents,
          product: r.product ? { ref: r.product.walmartItemId ? `walmart:${r.product.walmartItemId}` : `gtin:${r.product.gtin14}`, description: r.product.description, sizeLabel: r.product.sizeLabel, regularCents: r.product.regularCents, imageUrl: r.product.imageUrl } : null,
        }))
      : rows
      .filter((r) => r.status === 'matched' || r.status === 'no_barcode')
      .map((r) => ({
        itemId: r.id,
        query: r.query,
        quantity: r.quantity,
        status: r.status as 'matched' | 'no_barcode',
        locked: r.locked,
        matchMethod: null,
        product: r.product ? { ref: r.product.ref, description: r.product.description, sizeLabel: r.product.sizeLabel, regularCents: r.product.regularCents, imageUrl: r.product.imageUrl } : null,
      }));
    const acceptedSwaps = resp.plan.swaps.filter((s) => accepted[s.itemId] === s.replacement.ref);
    const trip: SavedTrip = {
      schemaVersion: 2,
      id: newId(),
      createdAt: new Date().toISOString(),
      branch: resp.branch,
      goals,
      budgetCents,
      originalItems,
      acceptedSwaps,
      revisedList: buildRevisedList(originalItems, acceptedSwaps),
      containsSample: resp.containsSample,
      listIsSample: receiptTrip ? false : listIsSample,
      source: receiptTrip ? 'receipt' : 'list',
      chain: resp.chain ?? 'kroger',
    };
    const r = tripStore.save(trip);
    setSaveWarning(r.warning);
    go({ name: 'trip', id: trip.id });
  }

  let body: React.ReactNode;
  switch (route.name) {
    case 'store':
      body = (
        <StoreScreen
          current={branch}
          defaultBranch={defaultBranch}
          onChoose={(b) => {
            setBranch(b);
            setRowsState([]);
            setResp(null);
            go({ name: 'start' });
          }}
        />
      );
      break;
    case 'receipt':
      body = (
        <ReceiptUploadScreen
          onRead={(s) => {
            setReceipt(s);
            setMatchRows([]);
            go({ name: 'receipt-check' });
          }}
        />
      );
      break;
    case 'receipt-check':
      body = receipt ? (
        <ReceiptCheckScreen
          state={receipt}
          setState={(fn) => setReceipt((s) => (s ? fn(s) : s))}
          busy={matching}
          error={matchError}
          onContinue={async () => {
            const req = matchRequest(receipt);
            receiptMeta.current = { zip: req.zip, storeNumber: req.storeNumber, date: req.date };
            setMatching(true);
            setMatchError(null);
            try {
              const r = await api.matchReceipt(req);
              setWalmart(r.walmart);
              setMatchRows(
                r.items.map((it: any) => {
                  const src = req.items.find((x) => x.id === it.id)!;
                  return { ...it, quantity: src.quantity, priceCents: src.priceCents, candidates: it.candidates ?? [], locked: false } as MatchRow;
                }),
              );
              go({ name: 'receipt-match' });
            } catch (e) {
              setMatchError(e instanceof ApiError ? e.message : 'Matching failed.');
            } finally {
              setMatching(false);
            }
          }}
        />
      ) : null;
      break;
    case 'receipt-match':
      body = (
        <ReceiptMatchScreen
          rows={matchRows}
          setRows={(fn) => setMatchRows(fn)}
          walmart={walmart}
          zip={receiptMeta.current.zip}
          fallbackBranch={defaultBranch}
          onPlanWalmart={() => {
            setTripSource('receipt');
            setPlanTarget('walmart');
            setResp(null);
            go({ name: 'goals' });
          }}
          onPlanFallback={() => {
            setTripSource('receipt');
            setPlanTarget('kroger');
            setResp(null);
            go({ name: 'goals' });
          }}
        />
      );
      break;
    case 'list':
      body = (
        <ListScreen
          text={listText}
          isSample={listIsSample}
          onChange={(t) => {
            setListText(t);
            if (!t.trim()) setListIsSample(false);
          }}
          onSubmit={checkList}
          loading={resolving}
          error={listError}
        />
      );
      break;
    case 'check':
      body = <CheckScreen rows={rows} setRows={setRows} locationId={branch?.locationId ?? ''} onContinue={() => go({ name: 'goals' })} />;
      break;
    case 'goals':
      body = (
        <GoalsScreen
          goals={goals}
          setGoals={setGoals}
          budgetCents={budgetCents}
          setBudget={setBudget}
          itemCount={tripSource === 'receipt' ? mergeMatchedRows(matchRows).length : rows.length}
          onPlan={() => {
            setExcluded([]);
            setAccepted({});
            void plan([]);
          }}
        />
      );
      break;
    case 'results':
      body = (
        <ResultsScreen
          resp={resp}
          progress={progress}
          error={planError}
          busy={planning}
          accepted={accepted}
          budgetCents={budgetCents}
          now={now}
          onAccept={toggleAccept}
          onReject={reject}
          onSave={save}
          onRetry={() => void plan()}
          excludedCount={excluded.length}
          keptUnmatched={tripSource === 'receipt' ? matchRows.filter((r) => r.status !== 'matched').map((r) => r.name) : []}
          differentStore={tripSource === 'receipt' && planTarget === 'kroger' && defaultBranch ? defaultBranch.name : null}
        />
      );
      break;
    case 'saved':
      body = <SavedScreen trips={tripStore.list()} warning={tripStore.warning ?? saveWarning} />;
      break;
    case 'trip':
      body = (
        <>
          {saveWarning ? <p className="notice" role="status">{saveWarning}</p> : null}
          <TripScreen trip={tripStore.get(route.id ?? '')} now={now} />
        </>
      );
      break;
    case 'about':
      body = <AboutScreen />;
      break;
    default:
      body = <StartScreen onDemo={loadDemo} demoAvailable={demoAvailable} loadingDemo={loadingDemo} />;
  }

  return (
    <div className="shell">
      <Header
        branch={tripSource === 'receipt' && ['goals', 'results'].includes(route.name) ? (planTarget === 'walmart' ? { chain: 'walmart', locationId: `zip:${receiptMeta.current.zip}`, name: `Walmart.com prices for ZIP ${receiptMeta.current.zip}`, address: 'from your receipt' } : defaultBranch) : branch}
        note={tripSource === 'receipt' && planTarget === 'kroger' && ['goals', 'results'].includes(route.name) ? 'Different store' : null}
        route={route}
      />
      {configError ? <p className="error" role="alert">{configError}</p> : null}
      <main>{body}</main>
    </div>
  );
}
