// Generate a 2048-bit RSA key pair for Walmart I/O signature auth.
// Private key never leaves secrets/ (gitignored). Refuses to overwrite.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'secrets');
const privPath = path.join(dir, 'walmart_private_key.pem');
const pubPath = path.join(dir, 'walmart_public_key.pem');

if (existsSync(privPath) || existsSync(pubPath)) {
  console.log('Keys already exist; not overwriting.');
  console.log(`Public key: ${pubPath}`);
  process.exit(0);
}

mkdirSync(dir, { recursive: true });
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
writeFileSync(privPath, privateKey, { mode: 0o600 });
writeFileSync(pubPath, publicKey);
console.log('Generated 2048-bit RSA key pair.');
console.log(`Private key (keep secret): ${privPath}`);
console.log(`Public key (upload to walmart.io): ${pubPath}`);
