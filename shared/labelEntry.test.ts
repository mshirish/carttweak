import { describe, expect, it } from 'vitest';
import { buildLabelRecord, storedLabelProblems, type LabelEntryInput } from './labelEntry.ts';
import { chooseNutrition, emptyPer100, type NutritionRecord } from './model.ts';

const TODAY = '2026-11-22';
const base: LabelEntryInput = {
  product: '0007131400185',
  source: 'retailer_listing',
  sourceUrl: 'https://www.kroger.com/p/aunt-millie-s-live-light-whole-grain-bread/0007131400185?cid=tracking',
  transcribedAt: '2026-11-21',
  transcribedBy: 'demo author',
  servingSize: 47,
  servingUnit: 'g',
  perServing: { calories: 70, protein_g: 4, fiber_g: 6, addedSugars_g: null, totalSugars_g: 1, sodium_mg: 170 },
};

describe('add-label conversion (per serving -> per 100)', () => {
  it('converts by serving size; missing values stay null; tracking params dropped', () => {
    const { record, errors } = buildLabelRecord(base, TODAY);
    expect(errors).toEqual([]);
    expect(record!.productRef).toBe('kroger:0007131400185');
    expect(record!.basis).toBe('g');
    expect(record!.per100.fiber_g!).toBeCloseTo(12.766, 3); // 6 * 100 / 47
    expect(record!.per100.sodium_mg!).toBeCloseTo(361.7, 1);
    expect(record!.per100.addedSugars_g).toBeNull();
    expect(record!).toMatchObject({ source: 'retailer_listing', labelDate: '2026-11-21', transcribedBy: 'demo author', isSample: false });
    expect(record!.sourceUrl).toBe('https://www.kroger.com/p/aunt-millie-s-live-light-whole-grain-bread/0007131400185');
  });
  it('mL servings give per-100 mL values', () => {
    const r = buildLabelRecord({ ...base, servingSize: 240, servingUnit: 'ml', perServing: { protein_g: 8, sodium_mg: 120 } }, TODAY).record!;
    expect(r.basis).toBe('ml');
    expect(r.per100.protein_g!).toBeCloseTo(3.333, 3);
    expect(r.per100.fiber_g).toBeNull();
  });
  it('label_observation needs a photo id; no URL needed', () => {
    const r = buildLabelRecord({ ...base, source: 'label_observation', sourceUrl: undefined, photoId: 'IMG_2041.jpg', transcribedBy: 'shopper' }, TODAY);
    expect(r.errors).toEqual([]);
    expect(r.record!.sourceRef).toBe('IMG_2041.jpg');
    expect(buildLabelRecord({ ...base, source: 'label_observation', sourceUrl: undefined }, TODAY).errors[0]).toMatch(/photoId/);
  });
  it('validation', () => {
    const errs = (over: Partial<LabelEntryInput>) => buildLabelRecord({ ...base, ...over }, TODAY).errors.join(' | ');
    expect(errs({ product: '12345' })).toMatch(/13-digit/);
    expect(errs({ sourceUrl: 'https://www.walmart.com/ip/123' })).toMatch(/kroger\.com/);
    expect(errs({ sourceUrl: 'http://www.kroger.com/p/x' })).toMatch(/https/);
    expect(errs({ servingUnit: 'oz' })).toMatch(/g or ml/);
    expect(errs({ servingSize: 0 })).toMatch(/servingSize/);
    expect(errs({ transcribedAt: '2027-01-01' })).toMatch(/future/);
    expect(errs({ transcribedBy: 'robot' })).toMatch(/demo author/);
    expect(errs({ perServing: { protein_g: -1 } })).toMatch(/non-negative/);
    expect(errs({ perServing: { fiber_g: 60 } })).toMatch(/more than the 47 g serving/);
    expect(errs({ perServing: { addedSugars_g: 5, totalSugars_g: 1 } })).toMatch(/cannot exceed total/);
    expect(errs({ perServing: { calories: 600 } })).toMatch(/implausible/); // 1277 kcal / 100 g
  });
  it('stored record shape check', () => {
    expect(storedLabelProblems(buildLabelRecord(base, TODAY).record)).toEqual([]);
    expect(storedLabelProblems({ ...buildLabelRecord(base, TODAY).record, isSample: true })[0]).toMatch(/isSample/);
  });
});

describe('precedence: label_observation (photo) > retailer_listing > fdc, newest first', () => {
  const rec = (source: NutritionRecord['source'], labelDate: string | null, ref: string): NutritionRecord => ({
    productRef: 'kroger:1',
    source,
    per100: emptyPer100(),
    basis: 'g',
    servingSize: null,
    labelDate,
    sourceRef: ref,
    isSample: false,
  });
  const fdc = rec('fdc', '2021-10-28', 'fdc:1');
  it('retailer listing newer than FDC beats FDC', () => {
    const c = chooseNutrition([fdc, rec('retailer_listing', '2026-11-21', 'url')])!;
    expect(c.used.source).toBe('retailer_listing');
    expect(c.reason).toBe('listing_newer_than_fdc');
  });
  it('a newer FDC label beats an older listing', () => {
    expect(chooseNutrition([rec('fdc', '2026-10-01', 'fdc:2'), rec('retailer_listing', '2025-01-01', 'url')])!.used.source).toBe('fdc');
  });
  it('photo beats listing (both newer than FDC), even if the listing is newer', () => {
    const c = chooseNutrition([fdc, rec('retailer_listing', '2026-11-21', 'url'), rec('label_observation', '2026-06-01', 'photo')])!;
    expect(c.used.source).toBe('label_observation');
    expect(c.alternatives.map((a) => a.source).sort()).toEqual(['fdc', 'retailer_listing']);
  });
  it('newest first within a source', () => {
    const c = chooseNutrition([rec('retailer_listing', '2026-01-01', 'old'), rec('retailer_listing', '2026-11-01', 'new')])!;
    expect(c.used.sourceRef).toBe('new');
    expect(c.reason).toBe('newest_retailer_listing');
  });
  it('listing vs undated FDC -> listing', () => {
    expect(chooseNutrition([rec('fdc', null, 'fdc:3'), rec('retailer_listing', '2026-01-01', 'url')])!.reason).toBe('fdc_label_undated');
  });
});
