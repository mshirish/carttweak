# Data sources log

Anything not confirmed by a live call is marked **UNVERIFIED**.

## Sources

| Source | Endpoint(s) | Auth | Status |
|---|---|---|---|
| Kroger Public API | `POST /v1/connect/oauth2/token` (client_credentials, scope `product.compact`), `GET /v1/locations`, `GET /v1/products?filter.locationId=` | Basic → Bearer | **UNVERIFIED** (awaiting `.env`) |
| USDA FoodData Central | `GET /fdc/v1/foods/search?dataType=Branded`, `GET /fdc/v1/food/{fdcId}` | `api_key` query param | **UNVERIFIED** (awaiting `.env`) |
| Walmart I/O | not called yet | RSA signature (keys in `secrets/`) | **UNVERIFIED** — keys generated, public key not yet uploaded |

## Log

### 2026-11-21 — setup
- Probe written (`npm run probe:kroger-fdc`); not yet run against live APIs.
- Assumptions to check on first run (all **UNVERIFIED**):
  - Kroger `upc` is 13 digits, zero-padded, without GS1 check digit.
  - FDC full-text `query` matches on `gtinUpc`.
  - FDC Branded `labelNutrients` includes `addedSugar` for most products.
  - Kroger returns `price.regular` / `price.promo` with `product.compact` scope when `filter.locationId` is set.
