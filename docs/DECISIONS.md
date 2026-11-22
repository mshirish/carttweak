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

## 2026-11-22: Milestone 2 (fixes + "Plan my next trip" UI)

### Units, decoupled (replaces the Milestone 1 single basis rule)
- **Nutrients:** compared only when both **nutrition records** share a basis (per 100 g or per 100 mL). Otherwise `basis_mismatch`.
- **Cost:** computed only when both **packages** share a dimension (weight, volume or count). Otherwise `package_dimension_mismatch`.
- **Trip impact:** computed only when the original's package dimension matches the nutrition basis. Otherwise `tripImpact = null`, with a note; the UI shows per-100 values only.
- **Ranking:** sets compare (1) known trip impact, (2) number of swaps, (3) per-100 improvement of the unknown-impact swaps, (4) cost, (5) label dates. Swaps with an unknown trip impact therefore rank after known ones.
- **Never** convert g ↔ mL.
- **Data guards:**
  - Nutrition records failing physical plausibility (e.g. more than 100 g of a nutrient per 100 g, sugars above total mass, more than 950 kcal, sodium above pure salt) count as unknown.
  - "Same product, other size" (same brand and name once size/package words are removed) is not a swap.

### Speed
- **Concurrency:** live calls go through an adaptive limiter per upstream: 6 concurrent, halved on 429 (min 1), +1 after 20 straight successes.
- **429 handling:** up to 4 retries, honouring Retry-After (else 1/2/4/8 s).
- **Parallelism:** all swap groups' candidate searches run in parallel.
- **`npm run warm`:** pre-fetches everything for the demo list. Prices stay cached 12 h, so re-run it within 12 h of a demo.
- **Progress:** plans run as jobs (`POST /api/plan/jobs`, then poll `GET /api/plan/jobs/:id`). Polling was chosen over SSE because it is simpler through the Vite proxy and survives reconnects.

### Nutrition sources
- **Types:** `fdc`, `label_observation` (photo), and `retailer_listing` (Nutrition Facts transcribed from the product's page on the chain's own site, with `sourceUrl`, `transcribedAt` and `transcribedBy`).
- **Precedence:** photo > listing > FDC, newest first within a source. A manual record must be newer than the newest dated FDC label to be used (Milestone 1 rule kept).
- **Entry:** `npm run add-label` writes to `data/labels/labels.json`. Real data only; sample data stays in `data/sample/`.

### Other rules
- **Rejected swaps:** `excludedCandidateIds` lists candidate product refs the shopper rejected. They are never re-suggested (reason `excluded`).
- **Promo wording:** the promo line names the chain's card ("may require Kroger card").
- **Combined budget:** with a $0 budget, a set may include a swap that costs more if another swap's savings cover it. Seen live with less added sugar at $0: Coke → Bubly saves $2.01, Wonder → Sara Lee costs $0.50.

### UI (`web/`)
- **Stack:** React + TypeScript + Vite, plain CSS (no Tailwind; one accent colour, Nutrition-Facts rules, tabular numbers, 48 px tap targets).
- **Routing:** hash routes (`#/start`, `#/saved/<id>`, …), with no router dependency.
- **Server-only data:** the browser only talks to `/api`. Kroger product images are loaded from kroger.com with `referrerPolicy="no-referrer"`.
- **Never auto-picks:** "Which one?" rows must be chosen by the shopper, even for the demo list.
- **Saved trips:** stored in `localStorage` under `carttweak.trips` (`schemaVersion: 1`). Accepted swaps are stored in full, including source snapshots. If storage fails, trips are kept in memory for the tab and a warning is shown.
- **Dev setup:** `npm run dev` starts the API (:8787) and Vite (:5173, proxying `/api`).
- **Screenshots:** `scripts/screenshots.ts` drives installed Edge via `playwright-core` (no browser download).

## 2026-11-22: Milestone 3 (pinned swaps, Walmart, receipts)

- **Accepted swaps are pinned** (`pinnedSwaps`). Rejecting a swap re-plans only the open slot(s). The remaining budget is the budget minus the pinned swaps' combined regular difference. A pinned swap that no longer qualifies is reported in `pinnedDropped`, never silently kept.
- **The budget is for the trip total.** Each card shows its own difference, and the trip bar says how the budget is used, e.g. "Your $0.00 budget covers the whole trip: the Bubly swap saves $2.01, which pays for the $0.50 bread swap." (`budgetSentence`).
- **Walmart (`server/src/walmart.ts`):**
  - **Signing:** RSA-SHA256 over `consumerId\ntimestamp\nkeyVersion\n` (base64). It is generated per live call, after a cache miss, because a signature is valid for only 180 s. Key and headers are never logged.
  - **Configuration:** `WALMART_KEY_VERSION` defaults to 1, `WALMART_PRIVATE_KEY_PATH` to `secrets/walmart_private_key.pem`.
  - **Prices:** Walmart prices are `walmart_api` observations for a ZIP, labelled "Walmart.com price for ZIP xxxxx (checked …)". They are never called a shelf price.
  - **Candidates:** found with the swap groups' `WALMART_SEARCH_TERMS`, then re-priced for the ZIP with `items?ids=`, because search results aren't ZIP-specific.
  - **Availability:** checked live (uncached) by `/api/walmart/status`. When unavailable, a Walmart plan returns 503 "We can't check Walmart's current prices right now", and the UI offers the Kroger demo branch, labelled "Different store".
- **Receipts:**
  - **OCR in the browser:** tesseract.js (Web Worker), PSM 6, with photos narrower than 1400 px upscaled. The image never leaves the browser, is released after reading, and is never saved. The language data downloads once from tesseract.js's default CDN and carries no image data.
  - **Parser** (`shared/receipt.ts`): its printed codes are the UPC without check digit (verified, see DATA_SOURCES). Card digits, approval/ref/AID/AAC/terminal ids, TC#, staff names, survey ids and barcodes are dropped (counts only). Unreadable data lines become rows for the shopper; nothing is dropped silently.
  - **Match methods:** `barcode` (Walmart lookup by UPC, else FDC by GTIN-14), `shopper_confirmed` (picked from Walmart search candidates; never auto-picked), `unmatched` (kept on the list, never swapped, and not sent for planning).
  - **Duplicate lines:** the same matched product on several lines becomes one plan item, with quantity and paid amounts added up.
  - **Paid vs current prices:** what the shopper paid is a separate `receipt` PriceObservation ("You paid $X for N on <date> at Walmart #<store>"). It is context only. Swap cost math always uses current prices from one source for both products.
- **Saved trips v2:** add `source` (list/receipt), `chain`, and per-item `matchMethod` plus `paidCents`. v1 trips migrate on read.
- **Local-only tools** that read `data/receipts/private/` (gitignored) print counts only:
  - `scripts/verify-receipt-codes.ts`
  - `scripts/receipt-accuracy.ts`
  - `scripts/receipt-e2e.ts`

  Real-receipt screenshots stay in that folder. Committed screenshots use the synthetic `docs/samples/sample-receipt.png`.

## 2026-11-22: Final milestone (haul rater pivot)

- **Product:** a grocery haul rater + swap coach. Flow: "Who's shopping?" (name-only profile, this browser only) → upload a receipt (primary) or type a list → check lines → match → **haul overview** (score out of 100) → goals + budget → swaps → save haul (per profile). The "Try a swap" challenge was removed.
- **Walmart API is off.** The server no longer loads Walmart config, so nothing calls it. Every swap price is from the Kroger demo branch, labelled "Prices from Kroger On the Rhine; Walmart prices coming soon". The receipt's "You paid $X on <date>" stays as separate context.
- **Nutrition score** (`shared/nutriscore.ts`):
  - **Version: the ORIGINAL Nutri-Score algorithm (2017).** Source: Santé publique France, Nutri-Score règlement d'usage (2017), built on the UK FSA/Ofcom nutrient profiling model (FSA, *Nutrient Profiling Technical Guidance*, 2011). The 2023 update was not implemented because its tables could not be verified within the deadline.
  - **Threshold tables:**

    | Component | Thresholds per 100 g (each one exceeded = 1 point) |
    |---|---|
    | Energy (kJ) | 335 / 670 / … / 3350 |
    | Total sugars (g) | 4.5 / 9 / 13.5 / 18 / 22.5 / 27 / 31 / 36 / 40 / 45 |
    | Saturated fat (g) | 1 … 10 |
    | Sodium (mg) | 90 … 900 |
    | Fruit/veg/legume % | >40 = 1, >60 = 2, >80 = 5 |
    | Fiber (g) | 0.9 / 1.9 / 2.8 / 3.7 / 4.7 |
    | Protein (g) | 1.6 / 3.2 / 4.8 / 6.4 / 8.0 |

  - **Beverages** use their own energy table (0 / 30 / … / 270 kJ) and sugar table (0 / 1.5 / … / 13.5 g), and fruit/veg % scores 2 / 4 / 10.
  - **Protein** is not counted when negative points are 11 or more and fruit/veg points are below the maximum, except for cheese.
  - **Grades:** foods A ≤ −1, B 0–2, C 3–10, D 11–18, E ≥ 19. Beverages: water A, B ≤ 1, C 2–5, D 6–9, E ≥ 10.
  - **Inputs:** energy (kJ = kcal × 4.184), total sugars, saturated fat (FDC `labelNutrients.saturatedFat`, else nutrient 606 / id 1258), sodium, fiber, protein, all per 100 g/mL. Fruit/veg % is 0 (not on US labels) and 100 for USDA generic produce.
  - **Missing data:** any required input null means "not scored (label data missing: …)". Nothing is guessed.
  - **Categories:** milk is a general food; soda, juice and plant milk are beverages; zero-energy, zero-sugar water is water. The fats/oils special case is NOT handled, because total fat isn't stored; such products are scored as general foods.
  - **0–100 mapping:** `score100 = round(100 × (40 − points) / 55)`, clamped to 0–100. Best food points −15 give 100, worst 40 give 0. Water gives 100.
  - **Tests** use examples hand-computed from the tables above. They are not copied from the official documentation's worked examples.
- **Haul score** (`shared/haul.ts`):
  - **Score:** the spend-weighted average of product scores over scored food items. The weight is the price paid on the receipt, or for typed lists the Kroger regular price × quantity.
  - **Coverage:** scored food spend ÷ all food spend. Below 50% shows "Low confidence". Non-food items are excluded from both.
  - **Verdicts:** 80+ Great haul, 60–79 Solid, 40–59 Room to improve, below 40 Lots of easy wins.
- **Receipt lines not carried at the Kroger demo branch** are still scored from their USDA label (FDC by barcode). They just can't be swapped, because there's no Kroger price.

## Kroger only (Nov 22, 2026)

- Walmart is removed: the API client, request signing, the probe, the env vars, the receipt parser, the copy and the tests. Chain-specific code now sits behind `ChainAdapter` (`server/src/chains.ts`) and `RECEIPT_PARSERS` (`shared/receipt.ts`). Kroger is the only implementation of each. See `docs/ADDING_A_CHAIN.md`. Older notes above that mention Walmart are history.
- Kroger receipts print no barcodes, so items are matched by name. The abbreviated name is expanded (`shared/krogerAbbrev.ts`) and searched at the selected branch, and the top 5 candidates are shown. The shopper picks one or skips. When there is a single strong match it is preselected as "Suggested", but it still needs a tap or "Confirm all suggested", and either can be undone. Produce and weighted lines go to the USDA produce step. Obvious non-food is pre-marked.
- Price label: "Prices from <branch> (checked <time>)". If the receipt ZIP differs from the branch ZIP, the app says: "Receipt from Kroger, <address>. Swap prices use <branch>."
