// Builds a signed release into update-server/releases/.
//   node release/build.js --notes "What changed"
// The version comes from package.json (bump it first).
import AdmZip from 'adm-zip';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'update-server', 'releases');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8').replace(/^﻿/, ''));
const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const notes = arg('--notes') || '';

const keyFile = path.join(root, 'release', 'keys', 'private.pem');
if (!fs.existsSync(keyFile)) { console.error('No private key. Run: node release/keygen.js'); process.exit(1); }
if (!fs.existsSync(path.join(root, 'server', 'update-public.pem'))) { console.error('server/update-public.pem is missing'); process.exit(1); }

// the zip contains program files only - never data/, node_modules/ or media
const zip = new AdmZip();
zip.addLocalFolder(path.join(root, 'server'), 'server');
zip.addLocalFolder(path.join(root, 'public'), 'public');
for (const f of ['package.json', 'package-lock.json', 'README.md', 'start.bat', 'tray.ps1', 'MangaSoft.vbs']) {
  if (fs.existsSync(path.join(root, f))) zip.addLocalFile(path.join(root, f));
}
const buf = zip.toBuffer();
const file = `mangasoft-${pkg.version}.zip`;
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, file), buf);

const signature = crypto.sign(null, buf, crypto.createPrivateKey(fs.readFileSync(keyFile))).toString('base64');
const latest = {
  version: pkg.version, file, size: buf.length, notes, released: new Date().toISOString(),
  sha256: crypto.createHash('sha256').update(buf).digest('hex'), signature,
};
fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify(latest, null, 2));
console.log(`Built ${file} (${(buf.length / 1024).toFixed(0)} KB), signed. Deploy update-server/ to publish it.`);
