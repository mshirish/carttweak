# Decisions

## 2026-11-21 — Starting assumptions (milestone 1: data proof)

| Area | Decision | Why |
|---|---|---|
| Frontend | React + TypeScript + Vite (`web/`) | Fast to scaffold, web-first demo |
| Secrets | Node + TypeScript server (`server/`, Hono on `@hono/node-server`, run with tsx) is the only runtime that reads API keys | Kroger/FDC/Walmart credentials never reach the browser; Vite dev proxies `/api` to the server |
| Domain code | `shared/` holds pure TS (no I/O): UPC normalization, size parsing, per-100 g math, checkout cost | Same logic in server, probes, and browser; easy to unit-test |
| Probes | `scripts/` one-off TS scripts run with tsx | Prove data access before building UI |
| Tests | Vitest at repo root (`npm test`) | Zero-config TS |
| Receipt OCR | Browser-side OCR, later | Keeps receipt images off the server |
| Trip storage | `localStorage`, later | No accounts/DB needed for a hackathon demo |
| Cross-platform | All npm scripts are plain `tsx ...`; env via dotenv; Node built-in `fetch` | Windows dev machine |

## Data-accuracy rules (non-negotiable)
- **Unknown is `null`**, never 0, never estimated. A reported 0 on a label stays 0.
- **Barcode match is strict**: Kroger UPC and FDC `gtinUpc` must normalize to the same GTIN-14 (with a valid GS1 check digit). Candidate text forms are only used to *find* records; they never decide a match.
- **Equal-portion comparison**: per 100 g or per 100 mL, computed from the FDC serving size. Only serving units `g/GRM` and `ml/MLT` are converted; anything else → null. g vs mL never compared.
- **Package size**: single `<number> <unit>` strings (oz, lb, fl oz, g, kg, mL, L, gal, qt, pt, ct) → `sizeBasis: "explicit"`. Multipack strings (`6 ct / 5.3 oz`, `4 pk/6 fl oz`, `2 x 16 oz`) → N × per-unit, `sizeBasis: "inferred_per_unit"` *(changed 2026-11-22; was null)*. If FDC `packageWeight` is present on the same basis and differs from the inferred total by > 10%, the size is treated as unparseable and the reason logged. The verified proof prefers pairs where both sizes are explicit and flags it if not. `oz` = mass, `fl oz` = volume; g vs mL never converted.
- **Checkout cost**: target = one package of the original; buy `ceil(target / replacement size)` whole packages at the current branch price. The headline difference uses **REGULAR price for both products** *(changed 2026-11-22; was promo-if-present)*. If either product has a promo (> 0; Kroger reports 0 for "no promo"), a second line labelled **"with current promo (may require Kroger card)"** uses each product's promo where it has one. Price types are never mixed in an unlabelled number, and the verified JSON records the price type used. Money in integer cents.
- **FDC lookup**: barcode candidate forms first, then brand + description text search. Either way, a record counts only if its `gtinUpc` normalizes to the same GTIN-14 as the Kroger UPC. The lookup method is recorded per match. FDC dates are normalized to ISO before "newest record wins" (FDC mixes `M/D/YYYY` and `YYYY-MM-DD`).

## Changes made during setup
- Vite pinned to 7.x in `web/` to dedupe with the copy Vitest 3 installs (two copies caused plugin type conflicts).
- Web scaffold written by hand (minimal Vite React TS) instead of `npm create vite`, to avoid interactive prompts.
- Probe adds a sanity filter on product descriptions (e.g. original yogurt must say "vanilla", replacement "plain" + "greek") so off-target search results can't form a pair. Off-target products are still FDC-matched and counted in the match rate.
- If multiple FDC Branded records share the same GTIN-14, the most recently modified one is used; the count is recorded (`matchingFdcRecords`).
- FDC `foodNutrients` (already per 100 g) are captured alongside `labelNutrients` as a cross-check, but the comparison uses label values scaled by serving size, as specified.

## 2026-11-22: Milestone 1 (swap engine + data service)

### Engine thresholds (`shared/engine.ts` → `THRESHOLDS`)
Minimum meaningful change per 100 g / 100 mL. A candidate must improve the primary goal by at least this much:

| Nutrient | Threshold |
|---|---|
| protein | +2 g |
| fiber | +2 g |
| added sugar | −3 g |
| sodium | −100 mg |

- **Secondary goal:** if it is known for both products and gets worse by more than its threshold, the candidate is **ineligible**. If it is unknown, the candidate is allowed and flagged `secondary_unknown`.
- **Other tracked nutrients** (protein, fiber, added sugar, sodium) that get worse past their threshold are **flagged** (`nutrient_worse`), not blocked. The explanation also mentions smaller worsening (e.g. "sodium rises 46 mg per 100 g"), unflagged.
- **Unknown goal nutrient** on either product means the candidate is ineligible. **Added sugar never falls back to total sugars**; total sugars appear only as `contextOnly`.
- **Equal portion:** comparisons are per 100 g or per 100 mL, and g vs mL is never compared or converted. That includes the package size vs the nutrition basis: if the size is in mL but FDC nutrition is per 100 g, the outcome is `basis_mismatch`. Live examples: Kroger milk; Campbell's condensed soup, which is the other way round.
- **Labels older than 2 years** (relative to `asOf`) are flagged "label may be outdated".

### Same kind of food
A candidate must **share a specific Kroger category** with the original ("Natural & Organic", "International" and similar don't count), **and** be in the **same curated swap group** (`shared/swapGroups.ts`). There are 17 groups, matched on the description because Kroger categories are coarse ("Dairy" holds milk, yogurt, cheese and eggs). "Juice/soda" was split into `juice` and `soda`; `pasta_sauce` and `eggs` were added.

### Cost
- **Quantity:** replace the ORIGINAL quantity (packages × package size). `packagesNeeded = ceil(originalQty / candidateQty)`.
- **Headline number:** `packagesNeeded × candidate regular − packages × original regular`, in integer cents.
- **Promo line:** shown only when either product has a promo, labelled "with current promo (may require loyalty card)". Each product uses its promo price if it has one, otherwise its regular price.
- **Budget:** `maxExtraSpendCents` is the limit for the **combined** difference of the chosen set. A negative difference (savings) always fits, including at a $0 budget.

### Ranking
- **Trip impact** = improvement per 100 × quantity of the original actually bought (g or mL) ÷ 100, in the nutrient's unit. Per-100 values are what the shopper sees; ranking uses trip impact.
- **Choosing swaps:** the engine picks the best **set of up to 2 swaps** on different items whose combined regular-price difference is ≤ the budget, maximising combined trip impact. It checks every single option and every pair.
- **Ties:** lower combined cost wins, then the newer oldest-replacement label date, then a stable id order (so results are deterministic).
- Note: the example sentence in the milestone brief said "+186 g across the 20 oz loaf". That is 9.3 × 20, mixing g and oz. The correct figure is 9.3 g/100 g × 567 g = **52.7 g**.

### Item outcomes
Every item gets one outcome code, plus candidate rejection counts. `noSwapReason` lists them when no swap is chosen.

| Code | Meaning |
|---|---|
| `swapped` | a swap was chosen for this item |
| `locked` | shopper locked it; never swapped |
| `unresolved` | needs the shopper to pick (`ambiguous`, `too_vague`, `not_found` or `no_barcode`), with candidates |
| `price_unknown` | no regular price at this store |
| `size_unknown` | package size unknown |
| `basis_mismatch` | size and nutrition units differ (g vs mL) |
| `goal_nutrient_unknown` | the goal nutrient isn't on the label |
| `no_candidates` | nothing of the same kind was found |
| `below_threshold` | no candidate improves enough |
| `secondary_worse` | every helpful candidate makes the secondary goal worse |
| `over_budget` | qualifying swaps exist but cost too much; includes the cheapest one and its cost |
| `not_selected` | fits the budget alone, but another set did more within the combined budget |

### Size conflict (`shared/model.ts` → `reconcileSize`)
- **Any size more than 5% off** FDC `packageWeight` (same basis): keep the **Kroger size** for cost math and flag `size_conflict`. Live example: Sunbeam 22 oz vs FDC 24 oz.
- **Inferred multipack more than 10% off:** the size is rejected (`size_rejected`, size becomes null). This is the Milestone-0 rule. "N ct / X oz" is genuinely ambiguous at Kroger: Yoplait `8 ct / 6 oz` is per cup, but Lay's `10 ct / 10 oz` and eggs `12 ct / 24 oz` are totals.
- **Inferred multipack with no comparable packageWeight:** kept and flagged `size_inferred`.

### Nutrition precedence (`chooseNutrition`)
- A `label_observation` newer than the FDC `labelDate` wins. An undated FDC record loses to a dated label.
- Otherwise FDC is used. Every record is kept (`alternatives`) and the reason is recorded.
- **FDC per-100 values:** the label block scaled by serving size (`label_scaled`). If the label block is empty, as in Euromonitor records, FDC `foodNutrients` per 100 of the serving unit are used instead (`fdc_per100`, recorded on the record).

### Resolving what the shopper typed (`shared/resolve.ts`)
- **Match rule:** a product matches only if every query word is in its brand + description, and any size in the query matches within 2%.
- **No match:** produce PLU codes give `no_barcode`, fewer than 2 words gives `too_vague`, and no matching product gives `not_found`. Each comes with candidates.
- **One clear match:** exactly one match, or a unique "closest name", resolves the item. Closest name is refused if another match has the same description at a different size, so **a size is never assumed**.
- **Zero search results:** the server retries once with the first three words.

### Data service (`server/`)
- **Store rule** for `/api/locations`: a location is a store only if it has a phone, at least one department, a numeric `storeNumber`, and no spoke/forecast/shed/unused/fulfillment/warehouse/distribution in its name. Live near 45202: 6 of 10 results were fulfillment sites, all dropped.
- **FDC lookup:** one search per UPC with all check-digit forms ORed in the query (live: 8/8 found with `totalHits: 1`), then the detail record. A match counts only if both sides normalize to the same GTIN-14. Candidates are filtered by same-kind, price and size before any FDC call.
- **Kroger token:** cached in memory until 60 s before `expires_in`, and fetched lazily only when a live call is needed.
- **Cache** (`data/cache/`, gitignored):

  | Data | TTL |
  |---|---|
  | Kroger products / prices | 12 h |
  | Kroger locations | 24 h |
  | FDC search and food records | 7 days |

  - **Stale fallback:** a failed live call (network error, 429, 5xx, or auth failure) serves the cached copy marked `stale: true` with its original `retrievedAt`. Prices then carry `stale` and the swap gets a `stale_price` flag.
  - **Nothing cached:** the request gets a 503 JSON error.
  - **Never a price without its date:** every `PriceObservation` has `observedAt` = the response's `retrievedAt`.
- **Secrets:** they are only read in `server/`. Bodies are redacted before caching; Kroger's `cid` URL parameter is stripped because it embeds the client ID. Every JSON response is checked for registered secrets and withheld if one appears.
- **Sample data:** only in `data/sample/`, every record `isSample: true`. It is used only when a request sets `includeSample: true`, and results then carry `containsSample: true`.
