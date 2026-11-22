import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWalmartConfig, walmartCanonical, walmartHeaders, walmartSignature } from '../src/walmart.ts';

// A throwaway key generated for this test only - never the real key.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const CONSUMER = '00000000-0000-4000-8000-000000000000';

describe('Walmart request signing', () => {
  it('signs exactly "consumerId\\ntimestamp\\nkeyVersion\\n"', () => {
    expect(walmartCanonical(CONSUMER, '1795330000000', '1')).toBe(`${CONSUMER}\n1795330000000\n1\n`);
  });
  it('signature is base64 RSA-SHA256 that verifies with the public key', () => {
    const sig = walmartSignature(privateKey, CONSUMER, '1795330000000', '1');
    expect(sig).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const v = createVerify('RSA-SHA256');
    v.update(`${CONSUMER}\n1795330000000\n1\n`);
    expect(v.verify(publicKey, Buffer.from(sig, 'base64'))).toBe(true);
    // a different timestamp does not verify
    const v2 = createVerify('RSA-SHA256');
    v2.update(`${CONSUMER}\n1795330000001\n1\n`);
    expect(v2.verify(publicKey, Buffer.from(sig, 'base64'))).toBe(false);
  });
  it('headers: the four WM_ headers, timestamp in ms', () => {
    const h = walmartHeaders({ consumerId: CONSUMER, keyVersion: '2', privateKey }, 1795330000000);
    expect(h['WM_CONSUMER.ID']).toBe(CONSUMER);
    expect(h['WM_CONSUMER.INTIMESTAMP']).toBe('1795330000000');
    expect(h['WM_SEC.KEY_VERSION']).toBe('2');
    const v = createVerify('RSA-SHA256');
    v.update(`${CONSUMER}\n1795330000000\n2\n`);
    expect(v.verify(createPublicKey(publicKey.export({ type: 'spki', format: 'pem' })), Buffer.from(h['WM_SEC.AUTH_SIGNATURE']!, 'base64'))).toBe(true);
  });
  it('config loading: PEM from a path, key version default "1", clear reasons when missing', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wm-key-'));
    try {
      const keyPath = path.join(dir, 'k.pem');
      writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
      const ok = loadWalmartConfig({ WALMART_CONSUMER_ID: CONSUMER }, keyPath);
      expect(ok.reason).toBeNull();
      expect(ok.config!.keyVersion).toBe('1');
      expect(loadWalmartConfig({}, keyPath).reason).toMatch(/WALMART_CONSUMER_ID/);
      expect(loadWalmartConfig({ WALMART_CONSUMER_ID: CONSUMER }, path.join(dir, 'missing.pem')).reason).toMatch(/not found/);
      writeFileSync(path.join(dir, 'bad.pem'), 'not a key');
      expect(loadWalmartConfig({ WALMART_CONSUMER_ID: CONSUMER, WALMART_PRIVATE_KEY_PATH: path.join(dir, 'bad.pem') }, keyPath).reason).toMatch(/could not be read/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
