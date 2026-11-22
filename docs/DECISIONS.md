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
- **Package size**: only single `<number> <unit>` strings (oz, lb, fl oz, g, kg, mL, L, gal, qt, pt, ct). Multipack strings like `6 ct / 5.3 oz` → null (per-item vs total is ambiguous). `oz` = mass, `fl oz` = volume.
- **Checkout cost**: target = one package of the original; buy `ceil(target / replacement size)` whole packages at the current branch price. Promo price used only when > 0 (Kroger reports 0 for "no promo"); the price type is always labelled. Money in integer cents.

## Changes made during setup
- Vite pinned to 7.x in `web/` to dedupe with the copy Vitest 3 installs (two copies caused plugin type conflicts).
- Web scaffold written by hand (minimal Vite React TS) instead of `npm create vite`, to avoid interactive prompts.
- Probe adds a sanity filter on product descriptions (e.g. original yogurt must say "vanilla", replacement "plain" + "greek") so off-target search results can't form a pair. Off-target products are still FDC-matched and counted in the match rate.
- If multiple FDC Branded records share the same GTIN-14, the most recently modified one is used; the count is recorded (`matchingFdcRecords`).
- FDC `foodNutrients` (already per 100 g) are captured alongside `labelNutrients` as a cross-check, but the comparison uses label values scaled by serving size, as specified.
