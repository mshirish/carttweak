# Data sources log

Anything not confirmed by a live call is marked **UNVERIFIED**.

## Sources

| Source | Endpoint(s) | Auth | Status |
|---|---|---|---|
| Kroger Public API | `POST /v1/connect/oauth2/token` (client_credentials, scope `product.compact`), `GET /v1/locations?filter.zipCode.near=`, `GET /v1/products?filter.term=&filter.locationId=` | Basic → Bearer | **Verified 2026-11-22** (live probe) |
| USDA FoodData Central | `GET /fdc/v1/foods/search?dataType=Branded`, `GET /fdc/v1/food/{fdcId}` | `api_key` query param | **Verified 2026-11-22** (live probe) |
| Walmart I/O | not called yet | RSA signature (keys in `secrets/`) | **UNVERIFIED**: keys generated, public key not yet uploaded |

## Log

### 2026-11-22: first live probe (`npm run probe:kroger-fdc`)

Run with `DEMO_ZIP=45202` as a one-off override (`.env` had `DEMO_ZIP` empty). Branch chosen:
**Kroger On the Rhine, locationId `01400513`, 100 E Court St, Cincinnati, OH 45202** (first result).
Verified output: `data/verified/kroger-01400513-2026-11-22.json`. Raw responses: `data/raw/2026-11-22T05-14-24-045Z/` (git-ignored).

Search terms: `vanilla yogurt`, `plain greek yogurt`, `white bread`, `whole grain bread` (10 results each). A pair qualified on the first pass, so no fallback terms were used.

#### Kroger: verified findings
- **Auth**: client_credentials with scope `product.compact` works; token `expires_in` = 1800 s. The token response has **no `scope` field**.
- **Locations**: `filter.zipCode.near` returns non-store entries too (e.g. Harris Teeter "Unused Spoke", "Forecast Shed" at a fulfillment address). The first result was a real store. **Do not assume result[0] is a store in other ZIPs.** Consider filtering by chain/name or pinning `DEMO_LOCATION_ID`.
- **UPC format**: 40/40 products have a **13-digit, zero-padded `upc` with NO GS1 check digit** (26/26 FDC matches came from the `check-digit-appended` interpretation). This confirms the earlier assumption.
- **Prices**: with `product.compact` + `filter.locationId`, `items[0].price.regular` was present for **40/40** products; `price.promo` > 0 for **9/40**. Kroger returns `promo: 0` (not null) when there is no promo. Products with no promo can also return `promo: null`.
- **Sizes**: `items[0].size` is mostly a single total (`"32 oz"`, `"20 oz"`, `"32 fl oz"`); 1/40 was a multipack (`"8 ct / 6 oz"`).
- **Size vs FDC discrepancy seen on an explicit size**: Sunbeam Giant White Bread is `22 oz` at Kroger but FDC `packageWeight` says `24 oz/680 g` (9% apart). Explicit sizes are not cross-checked (only inferred multipack totals are), so this is logged as an observation only.

#### FDC: verified findings
- **Barcode search works through full-text `query`**, but only with a check digit. Every match came from a form that **appends the computed check digit**:

  | UPC form that matched | count |
  |---|---|
  | `gtin14+check` (14 digits) | 12 |
  | `upca12+check` (12 digits) | 12 |
  | `ean13+check` (13 digits) | 2 |
  | as-is forms (no check digit) | 0 |

  FDC stores `gtinUpc` inconsistently (12-, 13- and 14-digit values, and some with dropped leading zeros, e.g. `11110028686`), so all candidate forms must be tried. The strict rule (both sides normalize to the same GTIN-14 with a valid check digit) decided every match.
- **Match rate (Kroger UPC → FDC Branded)**: **26/40 = 65%**.
  - Lookup method: **barcode 26**, brand+description **0**.
  - All 14 misses had no record with the same GTIN-14 after 8 barcode forms plus 1 brand+description search each. **12 of the 14 are Kroger store brands** (`Kroger`, `Simple Truth Organic`, `Smart Way`, `Private Selection`, UPC prefix `0001111`). FDC does have Kroger Co. records, but under other GTINs. The other 2 misses: Sara Lee Half Loaf White Bread and Artesano White Bread.
- **Brand + description fallback** (added 2026-11-22): implemented and run for all 14 misses; it found **0 additional matches**. FDC's GET search ORs words together (60k–190k `totalHits` per query), so the exact product rarely reaches the top 50. Tried and rejected:
  - `requireAllWords=true` returns **0 hits** even for "Kroger White Bread".
  - The `brandOwner=` query param **does not filter strictly** (15 different owners in the top 50).
  - A quoted phrase query returns an **HTML error page** instead of JSON.
- **Nutrient coverage** among the 26 matches: sodium 25, calories 24, protein 24, sugars 24, fiber 22, **addedSugars only 12**. Added sugar is often missing, so the yogurt "less added sugar" goal falls back to protein for most pairs.
- **Serving size**: 25/26 convertible to g. 1 failure: Yoplait 32 oz tub (FDC 2756001, `dataSource: Euromonitor`) has `servingSizeUnit: "g"` but **no `servingSize`** and empty `labelNutrients`. It stays unknown (null), not estimated.
- **`packageWeight`** formats seen: `"20 oz/567 g"`, `"16 oz/1 lbs/454 g"`, `"680 g"`, `"20 oz"`, and GS1 unit codes **`"48 ONZ"`, `"32 ONZ"`, `"24.0 ONZ"`**. The parser now reads GS1 codes (ONZ/GRM/MLT/…) for packageWeight only. Kroger size strings still accept only plain units.
- **Multipack cross-check**: Yoplait `8 ct / 6 oz` (inferred 48 oz) vs FDC `packageWeight "48 ONZ"` **agrees (0.0% apart)**, so the inferred size was kept. 0 inferred sizes were rejected this run.
- **Dates**: `/food/{id}` returns `publicationDate`/`modifiedDate` as `M/D/YYYY`; `/foods/search` returns `publishedDate`/`modifiedDate` as `YYYY-MM-DD`. The probe now normalizes both to ISO before sorting. The first run sorted them as strings and picked "newest" wrongly.
- **Data sources** in matched records: `LI` (Label Insight, 2019–2023 dates), `GDSN` (2025–2026), `Euromonitor` (all published 2026-04-23, no `modifiedDate`, often missing serving/added sugar).

#### FDC record freshness (matched records)

| Kroger UPC | Product | FDC id | Found by | publishedDate | modifiedDate | FDC source |
|---|---|---|---|---|---|---|
| 0007047000439 | Yoplait Orig. Vanilla 32 oz tub | 2756001 | barcode `gtin14+check` | 2026-04-23 | — | Euromonitor |
| 0005215900002 | Stonyfield Org. Whole Milk Vanilla 32 oz | 2756931 | barcode `gtin14+check` | 2026-04-23 | — | Euromonitor |
| 0081829001979 | Chobani RF Greek Honey Vanilla 32 oz | 2756313 | barcode `gtin14+check` | 2026-04-23 | — | Euromonitor |
| 0003663200260 | Light + Fit Vanilla 32 fl oz | 2779035 | barcode `gtin14+check` | 2026-10-22 | 2026-09-23 | GDSN |
| 0007047000323 | Yoplait Orig. French Vanilla 6 oz | 2737261 | barcode `gtin14+check` | 2025-07-24 | 2025-07-07 | GDSN |
| 0007047018388 | Yoplait Orig. French Vanilla 8 ct / 6 oz | 2740284 | barcode `gtin14+check` | 2025-08-21 | 2025-07-29 | GDSN |
| 0001111050481 | Kroger Plain Nonfat Greek 5.3 oz cup | 1947113 | barcode `upca12+check` | 2021-07-29 | 2018-05-03 | LI |
| 0089470001001 | Chobani Non-Fat Plain Greek 5.3 oz | 2757147 | barcode `gtin14+check` | 2026-04-23 | — | Euromonitor |
| 0007835555000 | Greek Gods Plain Traditional 24 oz | 2757309 | barcode `gtin14+check` | 2026-04-23 | — | Euromonitor |
| 0089470001013 | Chobani Plain Nonfat Greek 32 oz | 2755837 | barcode `gtin14+check` | 2026-04-23 | — | Euromonitor |
| 0007835558000 | Greek Gods Plain Nonfat 24 oz | 2490000 | barcode `upca12+check` | 2023-02-16 | 2021-10-30 | LI |
| 0089470001043 | Chobani Whole Milk Plain Greek 32 oz | 2757438 | barcode `gtin14+check` | 2026-04-23 | — | Euromonitor |
| 0068954408020 | Fage Total 2% Plain 5.3 oz | 2756767 | barcode `gtin14+check` | 2026-04-23 | — | Euromonitor |
| 0007225001137 | **Wonder Classic White Bread 20 oz** | 2569016 | barcode `ean13+check` | 2023-06-29 | 2023-05-23 | LI |
| 0007130104737 | Sunbeam Giant White 22 oz | 2033091 | barcode `upca12+check` | 2021-10-28 | 2020-12-10 | LI |
| 0001111008415 | Private Selection White Rustic 24 oz | 2462854 | barcode `upca12+check` | 2023-02-16 | 2021-04-12 | LI |
| 0001410007083 | Pepperidge Farm Farmhouse Hearty White 24 oz | 2794321 | barcode `gtin14+check` | 2026-11-19 | 2026-10-29 | GDSN |
| 0007882110008 | Nickles Toastmaster Giant White 20 oz | 2033292 | barcode `upca12+check` | 2021-10-28 | 2020-04-15 | LI |
| 0007313000367 | Oroweat Healthy Multi-Grain 24 oz | 872918 | barcode `upca12+check` | 2020-05-28 | 2019-03-18 | LI |
| 0001376402713 | Dave's Killer 21 Grains Thin-Sliced 20.5 oz | 2674261 | barcode `upca12+check` | 2023-11-16 | 2023-05-31 | LI |
| 0007313000026 | Oroweat 12 Grains & Seeds 24 oz | 2679921 | barcode `upca12+check` | 2023-11-16 | 2022-11-05 | LI |
| 0007313002855 | Oroweat Oatnut 24 oz | 869654 | barcode `upca12+check` | 2020-05-28 | 2019-03-18 | LI |
| 0007225001767 | Nature's Own Life Sugar Free 100% WG 16 oz | 2634131 | barcode `upca12+check` | 2023-09-14 | 2023-08-01 | LI |
| 0001376402705 | Dave's Killer 21 Grains 27 oz | 2674263 | barcode `upca12+check` | 2023-11-16 | 2023-05-31 | LI |
| 0007131400185 | **Aunt Millie's Live Light! Whole Grain 20 oz** | 2032747 | barcode `upca12+check` | 2021-10-28 | 2020-04-08 | LI |
| 0007294570544 | Sara Lee White made w/ Whole Grain 20 oz | 2569522 | barcode `ean13+check` | 2023-06-29 | 2023-05-23 | LI |

Oldest label data (latest of published/modified per record): 2020-05-28. Newest: 2026-11-19. The verified pair's replacement label is from 2020–2021, so the current package may differ.

#### Products that failed (16 of 40 unique products had at least one issue; some had several)

| Reason | Products |
|---|---|
| No FDC Branded record with matching GTIN-14 (8 barcode forms + brand/description tried) | 14: Kroger Blended Vanilla LF Yogurt, Kroger Vanilla Whole Milk Yogurt, Kroger Vanilla Nonfat Greek, Simple Truth Org. Vanilla Nonfat Greek, Kroger Plain Nonfat Greek tub, Simple Truth Org. Plain Nonfat Greek, Kroger Plain Whole Milk Greek, Kroger White Bread, Kroger White Sandwich Bread, Smart Way Enriched White, Sara Lee Half Loaf White, Artesano White, Private Selection 12 Grain, Private Selection Multigrain |
| FDC serving size not convertible (missing `servingSize`) | 1: Yoplait Original Vanilla 32 oz tub (matched, but unusable) |
| Off-target search result (sanity filter on description) | 3: Oroweat Healthy Multi-Grain, Private Selection 12 Grain, Private Selection Multigrain (not "whole grain") |
| No price / unparseable size | 0 |

Yogurt pairs: 56 candidate pairs qualified overall (yogurt + bread). Added sugar was unknown for most yogurt pairs, so they fell back to protein. The bread pair won on the sort order: both sizes explicit, then primary target, then lowest regular-price checkout difference.

### 2026-11-21: setup
- Probe written; not yet run against live APIs. The original UNVERIFIED assumptions, now resolved above:
  - ~~Kroger `upc` is 13 digits, zero-padded, without GS1 check digit.~~ **Verified** (40/40).
  - ~~FDC full-text `query` matches on `gtinUpc`.~~ **Verified**, only for forms with the check digit appended.
  - ~~FDC Branded `labelNutrients` includes `addedSugar` for most products.~~ **False**: 12/26 matches.
  - ~~Kroger returns `price.regular` / `price.promo` with `product.compact` when `filter.locationId` is set.~~ **Verified** (40/40 regular, 9/40 promo).

### 2026-11-22: Milestone 2 live findings

- **Kroger search term limit:** Kroger rejects `filter.term` values with more than 8 words (HTTP 400 `PRODUCT-2019`; "/" counts as a word). The server drops size expressions and punctuation from long terms and caps them at 8 words. Matching still uses the full query, size included.
- **`filter.brand` works:** "Prego Traditional Italian Sauce" returns 0 results, but `filter.brand=Prego` lists 20 Prego sauces. Prego names its jars "Traditional Sauce" / "Marinara Sauce", so the pasta-sauce swap group now matches any sauce in the "Pasta, Sauces, Grain" category.
- **Implausible FDC records exist:** a Kroger half-gallon 2% milk record gives 96.7 g protein and 150 g total sugars per 100 g, most likely a serving size off by 100×. Records that fail physical plausibility checks are kept but treated as unknown (`qualityIssues`).
- **Units:**
  - Milk is sold by volume, but FDC often labels it per 100 g.
  - Campbell's condensed soup is sold by weight but labelled per 100 mL.
  - Since Milestone 2 these still compare per 100 (against candidates with the same basis), with no trip total.
- **Demo list (`docs/demo-list.txt`, names and sizes chosen 2026-11-22):**

  | Tag | Result |
  |---|---|
  | `[exact]` | 17/17 resolve without a choice |
  | `[vague]` | 2/2 ask "which one?" |
  | `[nobar]` | bananas skipped as produce |

  - 22 of the 32 products a shopper can pick have a USDA record.
  - **248 of 358 swap candidates (69%)** across 17 swap groups have a USDA record.
- **Speed** (20-item demo list, same machine):

  | Plan | Time | Live calls |
  |---|---|---|
  | Cold, empty cache | 20.9 s | 423, 0 throttled (Milestone 1: 58.7 s) |
  | Warm, smoke script | 0.4 s | none |
  | Warm, through the UI (job + 300 ms polling) | 1.2–2.0 s | none |

  The FDC key reported about 2,300–2,650 requests remaining per hour (`X-RateLimit-Remaining`).

### 2026-11-22: Walmart Affiliate API (`npm run probe:walmart`)

- **Docs read** 2026-11-22 at walmart.io/docs/affiliates/v1. The pages are client-rendered, so they were read in a headless browser.
- **Signing:** `WM_SEC.AUTH_SIGNATURE` = base64 RSA-SHA256 over the header values sorted by header name, each followed by `\n`, which gives `consumerId\ntimestamp(ms)\nkeyVersion\n`. A signature lives 180 s.
- **Endpoints** (base `https://developer.api.walmart.com/api-proxy/service/affil/product/v2`):
  - `/items?upc=|gtin=|ids=` (up to 20 ids), with optional `zipCode` (and `storeId`, which needs Walmart business approval).
  - `/search?query=&numItems<=25&start&sort&categoryId&responseGroup`. No ZIP parameter is documented.
  - `/stores?zip=|lat=&lon=`.
- **Price by ZIP:** the docs say "Price and availability is also dependent on zipCode and storeId. If no zipCode or storeId is passed then default zipCode of San Bruno is being used."
- **Documented item fields:** `itemId`, `upc`, `name`, `brandName`, `salePrice`, `msrp`, `size`, `stock` (Available / Limited Supply / Last few items / Not available), `availableOnline`, `offerType` (ONLINE_ONLY / ONLINE_AND_STORE / STORE_ONLY), `marketplace`, `sellerInfo`, `categoryPath`, `thumbnailImage`.
- **Live result 2026-11-22T16:19Z: auth failed.** Every call (5 UPC lookups × no ZIP / 45202 / 10001, 2 searches × 2, stores for 45202) returned **HTTP 401** with this body (consumer id redacted):
  `{"details":{"Description":"Public Key not found for  Consumer id : [REDACTED]","wm_svc.version":"2.0.0","wm_svc.name":"affil-product","wm_svc.env":"prod"}}`
  - **Likely cause:** Walmart has no public key on file for this consumer ID and key version. Either `secrets/walmart_public_key.pem` was never uploaded on walmart.io, or it was uploaded under a key version other than `WALMART_KEY_VERSION` (default `1`).
  - **UNVERIFIED** until auth works: which fields actually come back, whether `salePrice` changes with `zipCode`, whether search honours `zipCode`, and the store-locator fields.

### 2026-11-22: Walmart receipt item codes (verified on the shopper's own receipts, locally)

- **What the code is:** the item code printed on Walmart receipts is the **UPC without its check digit, zero-padded to 12 digits**. This is the same convention as Kroger product ids. Produce prints a PLU instead (e.g. `000000004011`).
- **How it was verified:** `scripts/verify-receipt-codes.ts` read the hand-typed codes of 4 private receipt photos (`data/receipts/private/`, gitignored; only counts recorded here). It tested both readings against USDA FDC.
- **Result** (69 unique codes, 5 of them PLU, 3 on a generator-style receipt with 9-digit codes):

  | Reading | FDC matches |
  |---|---|
  | Check digit appended to the code | **40 of 61** non-produce codes |
  | Code already includes its check digit | **0** |

  Only 4 of the 64 printed codes even carry a valid GS1 check digit as printed, which is chance level.
- **Why 21 codes didn't match:**
  - Non-food items (FDC covers food only): deodorant, a knee brace, wax, hair colour.
  - The generator-style receipt's 9-digit codes, which aren't UPCs.
- **Walmart lookup by UPC:** could not be used to confirm, because Walmart auth returns 401 (see above).
- **OCR** (tesseract.js 5, `eng`, Node, local; per receipt: item lines with code AND price read correctly / total):

  | Receipt | Default page segmentation (PSM 3) | PSM 6, "uniform block" | PSM 6 + parser accepting "1b" for "lb" |
  |---|---|---|---|
  | 1 | ~1/38 | — | **38/38** |
  | 2 | ~3/6 | — | **6/6** |
  | 3 | ~1/28 | — | **28/28** |
  | 4 (300 px wide) | — | **0/4** | **0/4** |

  - **Why PSM 3 failed:** it reads the price column as a separate block.
  - **Receipt 4:** a low-resolution image; it needs upscaling (see the browser numbers below).

### 2026-11-22: receipt flow end to end (browser, local, the shopper's 4 private receipt photos)

`scripts/receipt-e2e.ts` ran the real UI in Edge, using tesseract.js in the browser (PSM 6, automatic upscaling, default contrast). Walmart auth is still 401, so every receipt was planned at the Kroger demo branch, labelled "Different store". Counts only:

| Receipt | Item lines read correctly (code + price) | Needed a look | Header (store / ZIP / date) | Matched by barcode | Confirmed | Not matched | OCR time | Match time | Plan time |
|---|---|---|---|---|---|---|---|---|---|
| 1 (540 px) | 38/38 | 0 | ok / none printed / ok | 26 | 0 | 12 | 6.3 s | 0.2 s | 1.5 s |
| 2 (540 px) | 6/6 | 0 | ok / ok / ok | 1 | 0 | 5 | 4.1 s | 0.1 s | 0.1 s |
| 3 (540 px) | 28/28 | 1 | ok / ok / ok | 19 | 0 | 9 | 4.6 s | 0.1 s | 1.1 s |
| 4 (300 px, generator-style) | 0/4 | 6/6 | store misread / ok / ok | 0 | 0 | 6 | 3.1 s | 0.1 s | n/a |

- **Matching:** all barcode matches came via USDA FDC by GTIN (Walmart lookup unavailable).
- **"Confirmed":** 0 because confirming needs Walmart search candidates, which require Walmart auth.
- **"Not matched"** covers produce (PLU codes), non-food items (FDC is food-only), and codes not in FDC.
- **Receipt 4:** 300 px wide; still unreadable with black & white on. The shopper can type or fix its lines on the check screen.
- **Match and plan times** above are with a warm cache. The first match on receipts 1 and 3 took about 3 s.
- **Example plans:** reported privately to the shopper; not recorded here because they would reveal what was bought.

### 2026-11-22: haul scores (final milestone; scores and counts only)

Nutri-Score original 2017 algorithm. Prices and swaps from Kroger On the Rhine. Receipt produce lines confirmed as the first USDA candidate in the test run.

| Haul | Score | Coverage | Projected with suggested swaps (More fiber, $2) |
|---|---|---|---|
| Private receipt 1 | **66** | 26 of 36 items, 70% of spend | 66 → 67 |
| Private receipt 2 | **25** | 1 of 3 food items, 26% of spend → Low confidence. Mostly non-food (deodorant, knee brace, bath bomb, marked "Not food") | no swaps |
| Private receipt 3 | **54** | 13 of 19 items, 55% of spend | 54 → 56 |
| Demo list (typed) | **54** | 15 of 20 items, 70% of spend | 54 → 58 (54 → 55 with one swap accepted) |
| Low-res receipt (300 px) | — | unreadable by OCR | — |

- **Why items go unscored:**
  - No USDA record, mostly store brands.
  - A label that omits a required value, e.g. soda labels with no fiber.
  - Produce not confirmed. On typed lists there is no produce confirm step yet.
- **Generic produce:** USDA Foundation records can lack saturated fat, so SR Legacy candidates are listed first.

## Nov 22, 2026: Kroger only

The Walmart Affiliate API is no longer used, and its env vars were removed from `.env.example`. Receipt line items come from Kroger receipts that the shopper photographs. They are matched by name with Kroger product search at the selected branch, as Kroger receipts carry no UPCs. The prices shown are Kroger API prices for that branch.
