// One-time: creates the key pair used to sign updates.
//   release/keys/private.pem  -> KEEP SECRET, back it up, never deploy it or share it
//   server/update-public.pem  -> shipped inside MangaSoft; installs use it to verify updates
// If you lose the private key, existing installs can no longer be updated (they must be reinstalled).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keyDir = path.join(root, 'release', 'keys');
const priv = path.join(keyDir, 'private.pem');
if (fs.existsSync(priv) && !process.argv.includes('--force')) {
  console.error('A private key already exists. Refusing to overwrite it (use --force only if you really mean it:\n' +
    'installs built with the old public key will stop accepting your updates).');
  process.exit(1);
}
fs.mkdirSync(keyDir, { recursive: true });
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
fs.writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
fs.writeFileSync(path.join(root, 'server', 'update-public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
console.log('Created release/keys/private.pem (secret!) and server/update-public.pem');
