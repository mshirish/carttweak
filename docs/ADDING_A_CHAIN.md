# Adding a chain

Kroger is the only chain today. A new chain plugs in at four points. Nothing else in the engine, scoring or UI is chain-specific.

1. **Store API: `server/src/chains.ts`.** Implement `ChainAdapter`:
   - `search(term, locationId)`: return normalized products plus a resolution, in the same shape as the Kroger search in `server/src/service.ts`.
   - `lookup(productId, locationId)`: fetch one product by the chain's own ID.
   - `locations(zip)`: list stores near a ZIP, stores only.
   - `branch(locationId)`: return one `Branch`.

   Add the chain name to `CHAINS`, and add it to `Chain` in `shared/model.ts`. Keep the API keys in `.env` and list the variable names in `.env.example`. Put the HTTP client in its own file, as `server/src/kroger.ts` does, and test it with recorded fixtures.
2. **Prices.** Add a `PriceSource` value if the prices are not shelf prices for a branch, for example online prices for a ZIP. Then add a matching label in `priceSourceLabel` (`web/src/components/SwapCard.tsx`). Every price must say where it came from and when it was checked.
3. **Receipts: `shared/receipt.ts`.** Write a `ReceiptParser` (`{ id, chain, detect, parse }`) and add it to `RECEIPT_PARSERS`. `detect(lines)` must return true only when it recognizes the chain's header. `parseReceipt` uses the first parser that matches and falls back to Kroger. The parser must be pure:
   - Drop card digits, approvals and loyalty numbers. Never return them.
   - Return `ReceiptHeader` (store address line, ZIP, date).
   - Return each item with a `searchTerm`. If the chain prints abbreviations, add an expander like `shared/krogerAbbrev.ts`.

   Test it only with synthetic receipt text. Never use text from real receipts.
4. **Search terms.** If the chain's search needs different words for a swap group, return them from `searchTermsFor(group, chain)` in `shared/swapGroups.ts`.

Receipt matching is by name. The server searches the selected branch, and the shopper confirms each match. Never auto-pick a match.
