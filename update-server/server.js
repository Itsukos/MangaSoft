// Tiny update server for MangaSoft. No dependencies. Deploy this folder to any Node host.
//   GET /latest.json          newest release record (version, checksum, signature, notes)
//   GET /releases/<file>.zip  the signed package
//   GET /                     human-readable page
// Releases are built with `node release/build.js` and live in ./releases.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'releases');
const PORT = Number(process.env.PORT) || 3000;
const latest = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8')); } catch { return null; } };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.end('ok'); return; }

  if (url.pathname === '/latest.json') {
    const l = latest();
    if (!l) { res.writeHead(404).end('no release published'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }).end(JSON.stringify(l));
    return;
  }

  const m = url.pathname.match(/^\/releases\/([A-Za-z0-9._-]+\.zip)$/);
  if (m) {
    const f = path.join(dir, m[1]);
    if (!fs.existsSync(f)) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': fs.statSync(f).size });
    fs.createReadStream(f).pipe(res);
    return;
  }

  if (url.pathname === '/') {
    const l = latest();
    const host = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>MangaSoft updates</title>
<body style="font:16px/1.5 system-ui;max-width:560px;margin:60px auto;padding:0 16px;color:#4a2c3a;background:#fff3f7">
<h1>🌸 MangaSoft updates</h1>
${l ? `<p>Latest version: <b>${esc(l.version)}</b> <span style="color:#9a7283">(${esc(l.released?.slice(0, 10))})</span></p>
<p>${esc(l.notes) || '<i>No release notes.</i>'}</p>`
  : '<p>No release has been published yet.</p>'}
<p>In MangaSoft open <b>Settings → Updates</b> and set the update server to:</p>
<p><code style="background:#ffe3ec;padding:4px 8px;border-radius:6px;user-select:all">${esc(host)}</code></p>
</body>`);
    return;
  }
  res.writeHead(404).end('not found');
}).listen(PORT, () => console.log(`MangaSoft update server on :${PORT}`));
