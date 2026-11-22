/**
 * Expand common Kroger receipt abbreviations into search words. Pure.
 * The original receipt text is always kept and shown; this only builds search terms.
 */
export const KROGER_ABBREV: Record<string, string> = {
  DRIS: "Driscoll's", NBSC: 'Nabisco', KRO: 'Kroger', KRGR: 'Kroger', ORG: 'Organic', ORGNC: 'Organic', GRN: 'Green', WHT: 'White',
  CHS: 'Cheese', BRY: 'Berry', SWT: 'Sweet', PPRS: 'Peppers', ONS: 'Onions', CHIQ: 'Chiquita', APL: 'Apple', STO: 'Simple Truth Organic',
  ST: 'Simple Truth', MSSN: 'Mission', WYMN: "Wyman's", HNY: 'Honey', BL: 'Bell', DR: 'Dairy', YM: 'Yerba Mate', GUAY: 'Guayaki',
  OTV: 'On The Vine', MED: 'Medium', PB: 'Peanut Butter', CRM: 'Cream', CHOC: 'Chocolate', VAN: 'Vanilla', STRWB: 'Strawberry',
  BNLS: 'Boneless', SKNLS: 'Skinless', BRST: 'Breast', CHKN: 'Chicken', GRD: 'Ground', BF: 'Beef', TRKY: 'Turkey', WW: 'Whole Wheat',
  WHL: 'Whole', MLK: 'Milk', YGRT: 'Yogurt', YOG: 'Yogurt', GRK: 'Greek', BRD: 'Bread', CRKR: 'Cracker', CRKRS: 'Crackers', PNT: 'Peanut',
  BTR: 'Butter', OJ: 'Orange Juice', LG: 'Large', SM: 'Small', PK: 'Pack', CT: 'Count', FF: 'Fat Free', RF: 'Reduced Fat', LF: 'Low Fat',
  NF: 'Nonfat', TOM: 'Tomato', TOMS: 'Tomatoes', POT: 'Potato', POTS: 'Potatoes', BAN: 'Banana', SPN: 'Spinach', BRC: 'Broccoli',
};

/** "DRIS STRAWBERRY" -> "Driscoll's Strawberry"; unknown words kept (title-cased). */
export function expandAbbrev(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      const key = w.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (KROGER_ABBREV[key]) return KROGER_ABBREV[key];
      return w.length > 1 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w;
    })
    .join(' ');
}
