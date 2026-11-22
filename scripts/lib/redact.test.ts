import { describe, expect, it } from 'vitest';
import { publicUrl, redact, registerSecret } from './redact.ts';

describe('redact', () => {
  it('removes registered secrets, bearer tokens, api_key params', () => {
    registerSecret('super-secret-value');
    const out = redact(
      'id=super-secret-value Authorization: Bearer abc.def-123 https://x.gov/a?api_key=KEY123&q=1 {"access_token":"tok"}',
    );
    expect(out).not.toContain('super-secret-value');
    expect(out).not.toContain('abc.def-123');
    expect(out).not.toContain('KEY123');
    expect(out).not.toContain('"tok"');
  });
  it('publicUrl strips api_key', () => {
    expect(publicUrl('https://api.nal.usda.gov/fdc/v1/food/1?api_key=K')).toBe('https://api.nal.usda.gov/fdc/v1/food/1');
  });
});
