import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import StreamZip from 'node-stream-zip';
import sharp from 'sharp';
import { db, tx, getSetting, setSetting, DATA_DIR } from './db.js';
import { naturalCompare } from './pages.js';
import * as al from './anilist.js';

/**
 * Light novels: .epub files. A folder (or a single .epub) is one series, every epub in it is one volume,
 * and each volume is one row of `chapters` (kind = 'epub'; page_count = number of sections in its spine,
 * progress.page = the section you are in, progress.pos = how far down it).
 */

const EPUB_RE = /\.epub$/i;
const stripExt = (n) => n.replace(/\.epub$/i, '');

// ---------- reading one epub ----------

const decodeEnt = (s) => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const textOf = (s) => decodeEnt(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function attrsOf(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1].toLowerCase()] = decodeEnt(m[3] ?? m[4] ?? '');
  return out;
}

/** href relative to the file that holds it → path inside the zip */
function resolveIn(baseFile, href) {
  const clean = decodeURI(String(href).split('#')[0].split('?')[0]);
  if (!clean) return '';
  const parts = (clean.startsWith('/') ? clean.slice(1) : path.posix.join(path.posix.dirname(baseFile), clean)).split('/');
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
  return out.join('/');
}

const zips = new Map(); // file -> { zip: Promise<StreamZip.async>, timer }
function openZip(file) {
  let z = zips.get(file);
  if (!z) {
    z = { zip: null, timer: null };
    zips.set(file, z);
    z.zip = (async () => {
      const zip = new StreamZip.async({ file });
      await zip.entries();
      return zip;
    })();
    z.zip.catch(() => zips.delete(file));
  }
  clearTimeout(z.timer);
  z.timer = setTimeout(() => {
    zips.delete(file);
    z.zip.then((zip) => zip.close()).catch(() => {});
  }, 30_000);
  z.timer.unref?.();
  return z.zip;
}

async function entryData(file, name) {
  const zip = await openZip(file);
  const entries = await zip.entries();
  let key = name;
  if (!entries[key]) { // tolerate case differences and stray slashes
    const lower = name.toLowerCase();
    key = Object.keys(entries).find((k) => k.toLowerCase() === lower);
  }
  if (!key || entries[key].isDirectory) return null;
  return zip.entryData(key);
}

const cache = new Map(); // `${file}|${mtime}|${size}` -> parsed epub

export async function readEpub(file) {
  const st = await fsp.stat(file);
  const key = `${file}|${st.mtimeMs}|${st.size}`;
  if (cache.has(key)) return cache.get(key);

  const container = await entryData(file, 'META-INF/container.xml');
  if (!container) throw new Error('Not an EPUB (no META-INF/container.xml)');
  const rootTag = container.toString('utf8').match(/<rootfile\b[^>]*>/i);
  const opfPath = rootTag && attrsOf(rootTag[0])['full-path'];
  if (!opfPath) throw new Error('EPUB has no package document');
  const opf = (await entryData(file, opfPath))?.toString('utf8');
  if (!opf) throw new Error('EPUB package document is missing');

  const manifest = new Map();
  for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
    const a = attrsOf(m[0]);
    if (a.id && a.href) manifest.set(a.id, { id: a.id, path: resolveIn(opfPath, a.href), mime: a['media-type'] || '', props: a.properties || '' });
  }
  const spine = [];
  for (const m of opf.matchAll(/<itemref\b[^>]*>/gi)) {
    const a = attrsOf(m[0]);
    const it = manifest.get(a.idref);
    if (it && a.linear !== 'no' && /x?html|xml/i.test(it.mime || it.path)) spine.push({ path: it.path, mime: it.mime || 'application/xhtml+xml' });
  }

  const meta = (name) => [...opf.matchAll(new RegExp(`<dc:${name}\\b[^>]*>([\\s\\S]*?)</dc:${name}>`, 'gi'))].map((m) => textOf(m[1])).filter(Boolean);
  let coverPath = null;
  const coverMeta = opf.match(/<meta\b[^>]*name\s*=\s*["']cover["'][^>]*>/i);
  const coverId = coverMeta && attrsOf(coverMeta[0]).content;
  if (coverId && manifest.get(coverId)) coverPath = manifest.get(coverId).path;
  if (!coverPath) coverPath = [...manifest.values()].find((i) => /cover-image/.test(i.props))?.path || null;
  if (!coverPath) coverPath = [...manifest.values()].find((i) => /^image\//.test(i.mime) && /cover/i.test(i.id + i.path))?.path || null;

  // table of contents: EPUB 3 nav document, else the EPUB 2 NCX
  const toc = [];
  const indexOf = new Map(spine.map((s, i) => [s.path, i]));
  const push = (title, href, base, depth) => {
    const p = resolveIn(base, href);
    const frag = String(href).includes('#') ? decodeURI(String(href).split('#')[1]) : '';
    const index = indexOf.get(p);
    if (index === undefined || !title) return;
    toc.push({ title, index, frag, depth });
  };
  const navItem = [...manifest.values()].find((i) => /\bnav\b/.test(i.props));
  const ncxItem = [...manifest.values()].find((i) => /ncx/.test(i.mime) || /\.ncx$/i.test(i.path));
  try {
    if (navItem) {
      const html = (await entryData(file, navItem.path))?.toString('utf8') || '';
      const navBlock = html.match(/<nav\b[^>]*epub:type\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i)?.[1] || html.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/i)?.[1] || '';
      let depth = 0;
      for (const m of navBlock.matchAll(/<(\/?)(ol|ul)\b[^>]*>|<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
        if (m[2]) depth += m[1] ? -1 : 1;
        else push(textOf(m[4]), attrsOf(`<a ${m[3]}>`).href || '', navItem.path, Math.max(0, depth - 1));
      }
    }
    if (!toc.length && ncxItem) {
      const xml = (await entryData(file, ncxItem.path))?.toString('utf8') || '';
      let depth = 0;
      for (const m of xml.matchAll(/<navPoint\b[^>]*>|<\/navPoint>|<navLabel\b[^>]*>[\s\S]*?<\/navLabel>\s*<content\b[^>]*>/gi)) {
        if (/^<navPoint/i.test(m[0])) depth++;
        else if (/^<\/navPoint/i.test(m[0])) depth--;
        else {
          const label = textOf(m[0].match(/<text\b[^>]*>([\s\S]*?)<\/text>/i)?.[1] || '');
          const src = attrsOf(m[0].match(/<content\b[^>]*>/i)[0]).src || '';
          push(label, src, ncxItem.path, Math.max(0, depth - 1));
        }
      }
    }
  } catch { /* a broken table of contents just means a plainer list */ }

  const info = {
    title: meta('title')[0] || '', authors: meta('creator'), description: meta('description')[0] || '',
    language: meta('language')[0] || '', coverPath, spine, toc,
  };
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  cache.set(key, info);
  return info;
}

const MIME = {
  '.xhtml': 'application/xhtml+xml', '.html': 'text/html', '.htm': 'text/html', '.xml': 'application/xml', '.css': 'text/css',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.avif': 'image/avif', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
};
const mimeOf = (name) => MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';

export async function coverOf(file) {
  const info = await readEpub(file);
  if (info.coverPath) {
    const data = await entryData(file, info.coverPath);
    if (data) return data;
  }
  // no declared cover: the first image of the first section
  const first = info.spine[0] && (await entryData(file, info.spine[0].path))?.toString('utf8');
  const img = first?.match(/<(?:img|image)\b[^>]*?(?:src|href)\s*=\s*["']([^"']+)["']/i)?.[1];
  return img ? entryData(file, resolveIn(info.spine[0].path, img)) : null;
}

// ---------- scanning ----------

function parseVolume(...names) {
  for (const n of names) {
    const m = n.match(/(?:volume|vol|v)[ ._-]*(\d+(?:\.\d+)?)/i) || n.match(/(?:^|[\s_\-[(])(\d{1,3})(?=[\s_\-\])(.]|$)/);
    if (m) return Math.floor(parseFloat(m[1]));
  }
  return null;
}

async function collectEpubs(dir, trail, out, depth = 0) {
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  ents.sort((a, b) => naturalCompare(a.name, b.name));
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isFile() && EPUB_RE.test(e.name)) out.push({ path: full, name: stripExt(e.name), trail });
    else if (e.isDirectory() && depth < 4) await collectEpubs(full, [...trail, e.name], out, depth + 1);
  }
}

/** Re-read one series (a folder of epubs or a single .epub). Returns { id, created, added, removed, moved, chapters } or null. */
export async function scanSeries(seriesPath, title) {
  const st = await fsp.stat(seriesPath);
  const files = [];
  if (st.isFile()) { if (EPUB_RE.test(seriesPath)) files.push({ path: seriesPath, name: stripExt(path.basename(seriesPath)), trail: [] }); }
  else await collectEpubs(seriesPath, [], files);
  if (!files.length) return null;

  const vols = [];
  for (const f of files) {
    let info = null;
    try { info = await readEpub(f.path); } catch { /* unreadable: still listed, with no sections */ }
    const volume = parseVolume(f.name, ...f.trail.slice().reverse());
    vols.push({ ...f, info, volume, count: info?.spine.length || 0 });
  }
  vols.sort((a, b) => {
    if ((a.volume ?? Infinity) !== (b.volume ?? Infinity)) return (a.volume ?? Infinity) - (b.volume ?? Infinity);
    return naturalCompare(a.path, b.path);
  });

  return tx(() => {
    let row = db.prepare('SELECT id FROM series WHERE path = ?').get(seriesPath);
    let created = false;
    if (!row) {
      const first = vols[0].info;
      const authors = (first?.authors || []).map((a) => `${a} (Author)`);
      const r = db.prepare('INSERT INTO series (title, path, added_at, kind, description, authors) VALUES (?, ?, ?, ?, ?, ?)')
        .run(title, seriesPath, Date.now(), 'novel', first?.description ? first.description.slice(0, 2000) : null, authors.length ? JSON.stringify(authors) : null);
      row = { id: Number(r.lastInsertRowid) };
      created = true;
    } else {
      db.prepare("UPDATE series SET kind = 'novel' WHERE id = ? AND kind != 'novel'").run(row.id);
    }

    const old = db.prepare('SELECT id, path, volume, page_count FROM chapters WHERE series_id = ?').all(row.id);
    const oldPaths = new Set(old.map((c) => c.path));
    const keep = new Set();
    const upsert = db.prepare(`INSERT INTO chapters (series_id, title, path, kind, number, volume, page_count, sort_idx, page_start, page_end)
      VALUES (?, ?, ?, 'epub', ?, ?, ?, ?, 0, NULL)
      ON CONFLICT(path, page_start) DO UPDATE SET series_id = excluded.series_id, title = excluded.title, kind = 'epub',
        number = excluded.number, volume = excluded.volume, page_count = excluded.page_count, sort_idx = excluded.sort_idx`);
    vols.forEach((v, i) => {
      const label = v.volume != null ? `Volume ${v.volume}` : (v.info?.title || v.name);
      upsert.run(row.id, label, v.path, v.volume, v.volume, v.count, i);
      keep.add(v.path);
    });

    const stale = old.filter((c) => !keep.has(c.path));
    const fresh = db.prepare('SELECT id, path, volume, page_count FROM chapters WHERE series_id = ?').all(row.id).filter((c) => !oldPaths.has(c.path));
    // a renamed volume file: reading progress follows it
    let moved = 0;
    const free = new Set(fresh.map((f) => f.id));
    for (const s of stale) {
      if (!db.prepare('SELECT 1 FROM progress WHERE chapter_id = ?').get(s.id)) continue;
      const m = fresh.find((f) => free.has(f.id) && f.volume === s.volume && f.page_count === s.page_count);
      if (!m) continue;
      db.prepare('UPDATE progress SET chapter_id = ? WHERE chapter_id = ?').run(m.id, s.id);
      free.delete(m.id);
      moved++;
    }
    for (const c of stale) db.prepare('DELETE FROM chapters WHERE id = ?').run(c.id);
    return { id: row.id, created, added: fresh.length, removed: stale.length, moved, chapters: vols.length };
  });
}

/**
 * Scan the novel libraries (or one of them). Series in a folder that cannot be read right now are left alone.
 * Returns the counts the scan summary shows.
 */
export async function scanNovels({ scope, inScope, unreadable, state }) {
  const res = { addedSeries: 0, removedSeries: 0, addedChapters: 0, removedChapters: 0, movedProgress: 0 };
  const libs = getSetting('novel_libraries', []).filter((l) => !scope || path.resolve(l) === scope);
  const seen = new Set();
  for (const lib of libs) {
    let ents;
    try { ents = await fsp.readdir(lib, { withFileTypes: true }); }
    catch { state.message += `Cannot read ${lib}. `; unreadable.push(lib); continue; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      if (!(e.isDirectory() || (e.isFile() && EPUB_RE.test(e.name)))) continue;
      const r = await scanSeries(path.join(lib, e.name), stripExt(e.name)).catch((err) => { state.message += `${e.name}: ${err.message}. `; return null; });
      if (!r) continue;
      seen.add(r.id);
      if (r.created) res.addedSeries++;
      res.addedChapters += r.added; res.removedChapters += r.removed; res.movedProgress += r.moved;
    }
  }
  for (const s of db.prepare("SELECT id, path FROM series WHERE kind = 'novel'").all()) {
    if (seen.has(s.id) || !inScope(s.path)) continue;
    if (unreadable.some((u) => s.path.startsWith(u + path.sep))) continue;
    db.prepare('DELETE FROM series WHERE id = ?').run(s.id);
    res.removedSeries++;
  }
  return res;
}

/** AniList details for novels: search restricted to light novels, best title wins. */
export async function matchPendingNovels({ rematch = false, state } = {}) {
  if (!getSetting('auto_match', true)) return;
  const rows = db.prepare(`SELECT id, title FROM series WHERE kind = 'novel' AND ${rematch ? "match_state != 'manual'" : "match_state = 'none'"}`).all();
  if (!rows.length) return;
  state.phase = 'matching'; state.done = 0; state.total = rows.length;
  for (const s of rows) {
    state.message = `Matching “${s.title}”`;
    try { await al.autoMatch(s, false, true); } catch (e) { state.error = `AniList: ${e.message}`; break; }
    state.done++;
  }
  if (!state.error) state.message = '';
}

// ---------- routes ----------

const THUMBS = path.join(DATA_DIR, 'thumbs');

export function mountNovels(app, { wrap, runScan }) {
  fs.mkdirSync(THUMBS, { recursive: true });

  app.get('/api/novels/status', (req, res) => {
    res.json({
      libraries: getSetting('novel_libraries', []),
      count: db.prepare("SELECT COUNT(*) AS n FROM series WHERE kind = 'novel'").get().n,
    });
  });

  app.post('/api/novels/libraries', wrap(async (req, res) => {
    const raw = String(req.body?.path || '').trim().replace(/^"|"$/g, '');
    if (!raw) return res.status(400).json({ error: 'Enter a folder path' });
    const p = path.resolve(raw);
    const st = await fsp.stat(p).catch(() => null);
    if (!st?.isDirectory()) return res.status(400).json({ error: `Folder not found: ${p}` });
    const other = [...getSetting('libraries', []), ...getSetting('doujin_libraries', []), ...getSetting('anime_libraries', [])].map((x) => path.resolve(x));
    if (other.includes(p)) return res.status(400).json({ error: 'That folder is already one of your other libraries' });
    const libs = getSetting('novel_libraries', []);
    if (!libs.includes(p)) setSetting('novel_libraries', [...libs, p]);
    runScan();
    res.json(getSetting('novel_libraries', []));
  }));

  app.delete('/api/novels/libraries', (req, res) => {
    setSetting('novel_libraries', getSetting('novel_libraries', []).filter((l) => l !== req.body?.path));
    runScan();
    res.json(getSetting('novel_libraries', []));
  });

  const chapterOf = (id) => db.prepare("SELECT * FROM chapters WHERE id = ? AND kind = 'epub'").get(id);

  /** sections + table of contents of one volume */
  app.get('/api/novels/:id/info', wrap(async (req, res) => {
    const c = chapterOf(req.params.id);
    if (!c) return res.sendStatus(404);
    const info = await readEpub(c.path);
    res.json({
      title: info.title || c.title, authors: info.authors, language: info.language,
      sections: info.spine.map((s) => s.path), toc: info.toc,
    });
  }));

  /** a file inside the epub (section, stylesheet, image, font); sections get the reader stylesheet added */
  app.get('/api/novels/:id/res/*', wrap(async (req, res) => {
    const c = chapterOf(req.params.id);
    if (!c) return res.sendStatus(404);
    const name = String(req.params[0] || '').replace(/^\/+/, '');
    const data = await entryData(c.path, name);
    if (!data) return res.sendStatus(404);
    const mime = mimeOf(name);
    res.set({
      'Content-Type': `${mime}${/html|xml|css|svg/.test(mime) ? '; charset=utf-8' : ''}`,
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      // books are not trusted: no scripts, nothing from other sites
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self'",
    });
    if (/html/.test(mime)) {
      let html = data.toString('utf8');
      const link = '<link rel="stylesheet" type="text/css" href="/novel-frame.css"/>';
      html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${link}</head>`)
        : /<body\b/i.test(html) ? html.replace(/<body\b/i, `${link}<body`) : link + html;
      return res.send(html);
    }
    res.send(data);
  }));

  /** small cover of one volume (cached) */
  app.get('/api/chapters/:id/cover', wrap(async (req, res) => {
    const c = chapterOf(req.params.id);
    if (!c) return res.sendStatus(404);
    let st;
    try { st = fs.statSync(c.path); } catch { return res.sendStatus(404); }
    const key = crypto.createHash('sha1').update(`epub|${c.path}|${st.mtimeMs}|${st.size}`).digest('hex').slice(0, 20);
    const file = path.join(THUMBS, `${key}.jpg`);
    if (!fs.existsSync(file)) {
      const data = await coverOf(c.path).catch(() => null);
      if (!data) return res.sendStatus(404);
      try { await sharp(data, { failOn: 'none' }).rotate().resize({ width: 420, withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(file); }
      catch { return res.sendStatus(404); }
    }
    res.set('Cache-Control', 'no-cache');
    res.sendFile(file);
  }));
}
