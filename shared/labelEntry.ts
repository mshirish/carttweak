/**
 * Manually transcribed Nutrition Facts (retailer listing or label photo) ->
 * NutritionRecord. Pure: validation + per-serving -> per-100 conversion.
 * Missing values stay null (never 0). Used by `npm run add-label`.
 */
import { emptyPer100, per100QualityIssues, PER100_KEYS, type NutritionRecord, type Per100Key, type TranscribedBy } from './model.ts';

export interface LabelEntryInput {
  /** Kroger product id (13 digits) or "kroger:<id>" */
  product: string;
  source: 'retailer_listing' | 'label_observation';
  /** retailer_listing: the product page URL on the chain's own website */
  sourceUrl?: string;
  /** label_observation: photo id */
  photoId?: string;
  /** ISO date (YYYY-MM-DD) the label was transcribed / the photo was taken */
  transcribedAt: string;
  transcribedBy: TranscribedBy | string;
  servingSize: number;
  servingUnit: 'g' | 'ml' | string;
  /** per-serving values; null/undefined = not on the label */
  perServing: Partial<Record<Per100Key, number | null | undefined>>;
}

export interface LabelEntryResult {
  record: NutritionRecord | null;
  errors: string[];
}

/** Chain website hosts accepted for retailer listings. */
export const RETAILER_HOSTS: Record<string, RegExp> = {
  kroger: /(^|\.)kroger\.com$/i,
};

const GRAM_KEYS: Per100Key[] = ['protein_g', 'fiber_g', 'addedSugars_g', 'totalSugars_g'];

export function parseProductRef(product: string): string | null {
  const s = product.trim();
  const m = /^(?:kroger:)?(\d{13})$/.exec(s);
  return m ? `kroger:${m[1]}` : null;
}

export function buildLabelRecord(input: LabelEntryInput, today: string): LabelEntryResult {
  const errors: string[] = [];
  const productRef = parseProductRef(input.product ?? '');
  if (!productRef) errors.push('product must be a 13-digit Kroger product id (e.g. 0007225001137)');
  if (input.source !== 'retailer_listing' && input.source !== 'label_observation') errors.push('source must be retailer_listing or label_observation');
  let sourceRef = '';
  if (input.source === 'retailer_listing') {
    try {
      const u = new URL(String(input.sourceUrl ?? ''));
      if (u.protocol !== 'https:') errors.push('sourceUrl must be https');
      else if (!RETAILER_HOSTS.kroger!.test(u.hostname)) errors.push(`sourceUrl must be on the chain's own website (kroger.com), got ${u.hostname}`);
      // drop tracking parameters
      u.search = '';
      u.hash = '';
      sourceRef = u.toString();
    } catch {
      errors.push('sourceUrl is not a valid URL');
    }
  } else if (input.source === 'label_observation') {
    if (!input.photoId || !/^[\w.-]{3,80}$/.test(input.photoId)) errors.push('photoId is required (letters, digits, . _ -)');
    sourceRef = input.photoId ?? '';
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.transcribedAt ?? '') || Number.isNaN(Date.parse(input.transcribedAt))) {
    errors.push('transcribedAt must be a date YYYY-MM-DD');
  } else if (input.transcribedAt > today) errors.push(`transcribedAt ${input.transcribedAt} is in the future`);
  if (input.transcribedBy !== 'demo author' && input.transcribedBy !== 'shopper') errors.push('transcribedBy must be "demo author" or "shopper"');
  const serving = Number(input.servingSize);
  const unit = String(input.servingUnit ?? '').toLowerCase();
  if (!(serving > 0) || !Number.isFinite(serving) || serving > 2000) errors.push('servingSize must be a number between 0 and 2000');
  if (unit !== 'g' && unit !== 'ml') errors.push('servingUnit must be g or ml (other units are never converted)');

  const per100 = emptyPer100();
  for (const k of PER100_KEYS) {
    const v = input.perServing?.[k];
    if (v == null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      errors.push(`${k} must be a non-negative number or blank`);
      continue;
    }
    if (unit === 'g' && GRAM_KEYS.includes(k) && v > serving) errors.push(`${k} ${v} g is more than the ${serving} g serving`);
    if (serving > 0) per100[k] = (v * 100) / serving;
  }
  const a = input.perServing?.addedSugars_g;
  const t = input.perServing?.totalSugars_g;
  if (a != null && t != null && a > t + 0.5) errors.push(`added sugars (${a} g) cannot exceed total sugars (${t} g)`);
  if (!errors.length) errors.push(...per100QualityIssues(per100).map((x) => `implausible: ${x}`));
  if (errors.length) return { record: null, errors };
  return {
    record: {
      productRef: productRef!,
      source: input.source,
      per100,
      basis: unit as 'g' | 'ml',
      servingSize: { quantity: serving, unit },
      labelDate: input.transcribedAt,
      sourceRef,
      isSample: false,
      method: 'label_scaled',
      ...(input.source === 'retailer_listing' ? { sourceUrl: sourceRef } : {}),
      transcribedAt: input.transcribedAt,
      transcribedBy: input.transcribedBy as TranscribedBy,
    },
    errors: [],
  };
}

/** Shape check for records read back from data/labels/ (returns problems; empty = ok). */
export function storedLabelProblems(r: any): string[] {
  const out: string[] = [];
  if (!r || typeof r !== 'object') return ['not an object'];
  if (!parseProductRef(String(r.productRef ?? ''))) out.push('bad productRef');
  if (r.source !== 'retailer_listing' && r.source !== 'label_observation') out.push('bad source');
  if (r.isSample !== false) out.push('isSample must be false (sample data belongs in data/sample/)');
  if (r.basis !== 'g' && r.basis !== 'ml') out.push('bad basis');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.labelDate ?? ''))) out.push('bad labelDate');
  if (!r.per100 || typeof r.per100 !== 'object') out.push('missing per100');
  else for (const k of PER100_KEYS) if (r.per100[k] != null && !(typeof r.per100[k] === 'number' && r.per100[k] >= 0)) out.push(`bad per100.${k}`);
  if (r.source === 'retailer_listing' && !String(r.sourceUrl ?? '').startsWith('https://')) out.push('retailer_listing needs an https sourceUrl');
  return out;
}
