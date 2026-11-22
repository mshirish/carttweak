// Plain-English explanation of the data. Coverage numbers come from docs/DATA_SOURCES.md.
export const COVERAGE = {
  asOf: '2026-11-22',
  probeMatch: { matched: 26, total: 40 },
  probeStoreBrandMisses: { storeBrand: 12, misses: 14 },
  addedSugarKnown: { known: 12, of: 26 },
  labelDates: { oldest: '2020', newest: '2026' },
  demoCandidates: { withFdc: 248, total: 358 },
};

export function AboutScreen() {
  const c = COVERAGE;
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–');
  return (
    <section className="prose">
      <h1>About the data</h1>
      <p className="lede">CartTweak only suggests a swap when it can show where every number came from. When something isn't known, it says “unknown” instead of guessing.</p>

      <div className="stat-row">
        <div className="stat">
          <div className="v num">{pct(c.probeMatch.matched, c.probeMatch.total)}</div>
          <div className="k">of Kroger products matched a USDA label by barcode ({c.probeMatch.matched} of {c.probeMatch.total})</div>
        </div>
        <div className="stat">
          <div className="v num">{pct(c.demoCandidates.withFdc, c.demoCandidates.total)}</div>
          <div className="k">of swap candidates for the demo list had a USDA label ({c.demoCandidates.withFdc} of {c.demoCandidates.total})</div>
        </div>
        <div className="stat">
          <div className="v num">{pct(c.addedSugarKnown.known, c.addedSugarKnown.of)}</div>
          <div className="k">of matched labels list added sugar</div>
        </div>
        <div className="stat">
          <div className="v num">
            {c.labelDates.oldest}–{c.labelDates.newest}
          </div>
          <div className="k">range of label dates we see</div>
        </div>
      </div>
      <p className="small muted">Figures from live checks on {c.asOf} at Kroger On the Rhine, Cincinnati.</p>

      <h2>Prices and sizes: Kroger</h2>
      <p>
        Prices, promotions and package sizes come from Kroger's public product API for the store you chose. We show the regular price first.
        Promo prices are shown separately because they may require a Kroger card. Prices are refreshed at most every 12 hours, and every
        price shows when it was checked. If Kroger can't be reached we show the last price we have and mark it “stale”.
      </p>

      <h2>Nutrition: USDA FoodData Central</h2>
      <p>
        Nutrition Facts come from the USDA's FoodData Central branded foods database, matched to the Kroger product by barcode. A label
        only counts if its barcode is exactly the same product. We compare products per 100 g (or per 100 mL) so different package sizes
        are fair, and we never convert between grams and millilitres.
      </p>
      <p>
        Coverage is good for national brands and weaker for Kroger's own brands: in our first check, {c.probeStoreBrandMisses.storeBrand} of
        the {c.probeStoreBrandMisses.misses} products with no USDA match were Kroger store brands. Labels can also be old (some date from{' '}
        {c.labelDates.oldest}), so we flag labels older than two years as “label may be outdated”. Added sugar is missing on many labels; we
        never substitute total sugars for it.
      </p>

      <h2>Retailer listings and label photos</h2>
      <p>
        When USDA has no label, or an older one, a Nutrition Facts panel can be typed in from the product's page on kroger.com (a “retailer
        listing”) or from a photo of the package. Each one records who transcribed it and when. A photo takes priority over a listing,
        and either one is only used if it is newer than the USDA label.
      </p>

      <h2>Sample data</h2>
      <p>
        The demo shopping list is a made-up sample and is always badged “Sample list”. A few illustrative store-brand labels exist for
        tests only; they're never mixed into real results, and any result that uses them is badged “Sample data”.
      </p>

      <h2>What stays on your device</h2>
      <p>Saved trips are stored in this browser only. Nothing about your list is sent anywhere except our own server, which asks Kroger and the USDA for product data.</p>
    </section>
  );
}
