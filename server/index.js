import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, tx, COVER_DIR, DATA_DIR, getSetting, setSetting } from './db.js';
import sharp from 'sharp';
import { pagesFor, readPage } from './pages.js';
import { runScan, scanState, rescanSeries } from './scanner.js';
import * as al from './anilist.js';
import { startDetect, detectJobs } from './detect.js';
import * as nh from './nhentai.js';
import * as md from './mangadex.js';
import { matchManga } from './matching.js';
import { collectionFor, missingCount } from './collection.js';
import { FIELDS, clean, getOverrides, saveOverrides, applyOverrides, customCoverFile } from './meta.js';
import * as updater from './updater.js';
import { mountAnime, mergePass } from './anime.js';
import { mountRelations, relationsPass } from './relations.js';
import { thumbFor } from './transcode.js';
import { reveal, isLocalRequest } from './reveal.js';
import * as autoscan from './autoscan.js';
import { mountSocial } from './social.js';
import { mountNovels, scanSeries as scanNovelSeries, coverOf as novelCover } from './novels.js';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT) || 8484;
const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));

// auto-updates only install while nobody is using the app
let lastActivity = Date.now();
app.use((req, res, next) => { if (req.path.startsWith('/api') && req.path !== '/api/update/status') lastActivity = Date.now(); next(); });

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const parseJson = (s, d = []) => { try { return JSON.parse(s) ?? d; } catch { return d; } };

if (!getSetting('libraries') && process.env.MANGA_DIR) setSetting('libraries', [path.resolve(process.env.MANGA_DIR)]);
if (!getSetting('doujin_libraries') && process.env.DOUJIN_DIR) setSetting('doujin_libraries', [path.resolve(process.env.DOUJIN_DIR)]);
if (!getSetting('anime_libraries') && process.env.ANIME_DIR) setSetting('anime_libraries', [path.resolve(process.env.ANIME_DIR)]);
if (!getSetting('novel_libraries') && process.env.NOVEL_DIR) setSetting('novel_libraries', [path.resolve(process.env.NOVEL_DIR)]);

// ---------- optional PIN lock for the doujin section ----------

const sessions = new Map(); // token -> expiry (memory only: a restart locks everything again)
const SESSION_MS = 7 * 24 * 3600 * 1000;
const cookieOf = (req, name) => (req.headers.cookie || '').split(';').map((c) => c.trim())
  .find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
const pinSet = () => !!getSetting('doujin_pin');
const unlocked = (req) => {
  if (!pinSet()) return true;
  const exp = sessions.get(cookieOf(req, 'ms_dj'));
  return !!exp && exp > Date.now();
};
const hashPin = (pin, salt = crypto.randomBytes(16).toString('hex')) =>
  `${salt}:${crypto.scryptSync(String(pin), salt, 32).toString('hex')}`;
const checkPin = (pin, stored) => {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex'), b = crypto.scryptSync(String(pin), salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const attempts = { n: 0, until: 0 };

/** Block any request that touches a doujin series/chapter while the section is locked. */
app.use('/api', (req, res, next) => {
  if (unlocked(req)) return next();
  let seriesId = null;
  const m = req.path.match(/^\/(series|chapters)\/(\d+)/);
  if (m) {
    seriesId = m[1] === 'series' ? Number(m[2])
      : db.prepare('SELECT series_id FROM chapters WHERE id = ?').get(Number(m[2]))?.series_id;
  } else if (['/progress', '/anilist/progress'].includes(req.path)) {
    seriesId = db.prepare('SELECT series_id FROM chapters WHERE id = ?').get(Number(req.body?.chapterId))?.series_id;
  }
  if (seriesId && db.prepare('SELECT kind FROM series WHERE id = ?').get(seriesId)?.kind === 'doujin') {
    return res.status(403).json({ error: 'locked', locked: true });
  }
  next();
});

// ---------- helpers ----------

function doujinInfo(s) {
  const m = parseJson(s.nh_meta, {});
  const by = (t) => (m.tags || []).filter((x) => x.type === t).map((x) => x.name);
  return {
    artists: by('artist'), groups: by('group'), parodies: by('parody'), characters: by('character'),
    languages: by('language'), categories: by('category'), tags: by('tag'), pages: m.pages ?? null, local: !!m.local,
  };
}


function seriesDto(s) {
  return {
    id: s.id, title: s.title_english || s.title_romaji || s.title, folderName: s.title,
    romaji: s.title_romaji, english: s.title_english, native: s.title_native,
    description: s.description, genres: parseJson(s.genres), authors: parseJson(s.authors),
    status: s.status, format: s.format, chaptersTotal: s.chapters_total, volumesTotal: s.volumes_total,
    score: s.score, year: s.year, banner: s.banner_url, color: s.cover_color, siteUrl: s.site_url,
    anilistId: s.anilist_id, matchState: s.match_state,
    airSeason: s.air_season, airYear: s.air_year, tags: parseJson(s.tags),
    metaSource: s.meta_source || (s.anilist_id ? 'anilist' : null), mdId: s.md_id,
    edited: Object.keys(parseJson(s.overrides, {})),
    kind: s.kind, nhId: s.nh_id, doujin: s.kind === 'doujin' ? doujinInfo(s) : null,
  };
}

const chapterLabel = (c) => c.title;

// ---------- library ----------

app.get('/api/library', (req, res) => {
  const kind = ['doujin', 'novel'].includes(req.query.kind) ? req.query.kind : 'manga';
  if (kind === 'doujin' && !unlocked(req)) return res.status(403).json({ error: 'locked', locked: true });
  const rows = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM chapters c WHERE c.series_id = s.id) AS ch_count,
      (SELECT COUNT(*) FROM chapters c JOIN progress p ON p.chapter_id = c.id
         WHERE c.series_id = s.id AND p.completed = 1) AS read_count,
      (SELECT MAX(p.updated_at) FROM chapters c JOIN progress p ON p.chapter_id = c.id
         WHERE c.series_id = s.id) AS last_read
    FROM series s WHERE s.kind = ? ORDER BY LOWER(COALESCE(s.title_english, s.title_romaji, s.title))`).all(kind);
  res.json(rows.map((s) => ({
    ...seriesDto(s), chapterCount: s.ch_count, readCount: s.read_count, lastRead: s.last_read, addedAt: s.added_at,
    missing: s.kind === 'manga' && getSetting('show_missing', true) ? missingCount(s.id) : null,
  })));
});

app.get('/api/continue', (req, res) => {
  const kind = ['doujin', 'novel'].includes(req.query.kind) ? req.query.kind : 'manga';
  if (kind === 'doujin' && !unlocked(req)) return res.json([]);
  const rows = db.prepare(`
    SELECT s.id AS series_id, s.title, s.title_english, s.title_romaji,
           c.id AS chapter_id, c.title AS chapter_title, c.page_count, c.sort_idx, p.page, p.completed, p.updated_at
    FROM progress p JOIN chapters c ON c.id = p.chapter_id JOIN series s ON s.id = c.series_id
    WHERE s.kind = ? AND (p.completed = 1 OR p.page > 0) AND p.updated_at = (SELECT MAX(p2.updated_at) FROM progress p2 JOIN chapters c2 ON c2.id = p2.chapter_id
                          WHERE c2.series_id = s.id)
    ORDER BY p.updated_at DESC, c.sort_idx DESC LIMIT 400`).all(kind);
  // one entry per series (marking a series read stamps every chapter at the same moment): the furthest one
  const seen = new Set();
  const latest = rows.filter((r) => { if (seen.has(r.series_id)) return false; seen.add(r.series_id); return true; });
  const hidden = getSetting('continue_hidden', {});
  res.json(latest.filter((r) => !((hidden[`${kind === 'doujin' ? 'd' : kind === 'novel' ? 'n' : 'm'}:${r.series_id}`] || 0) >= r.updated_at)).slice(0, 12).map((r) => {
    let chapterId = r.chapter_id, page = r.page, title = r.chapter_title;
    const last = r.completed ? { id: r.chapter_id, title: r.chapter_title } : null; // the one just finished
    if (r.completed) { // jump to the next chapter
      const cur = db.prepare('SELECT sort_idx FROM chapters WHERE id = ?').get(r.chapter_id);
      const next = db.prepare(`SELECT c.id, c.title FROM chapters c LEFT JOIN progress p ON p.chapter_id = c.id
        WHERE c.series_id = ? AND c.sort_idx > ? AND COALESCE(p.completed, 0) = 0 ORDER BY c.sort_idx LIMIT 1`)
        .get(r.series_id, cur.sort_idx);
      if (!next) return null;
      chapterId = next.id; page = 0; title = next.title;
    }
    return { seriesId: r.series_id, title: r.title_english || r.title_romaji || r.title, chapterId, chapterTitle: title, page, last };
  }).filter(Boolean));
});

/** Take a series off the Continue shelf until you read something in it again. */
app.post('/api/continue/hide', (req, res) => {
  const kind = req.body?.kind === 'doujin' ? 'd' : req.body?.kind === 'novel' ? 'n' : 'm';
  const id = Number(req.body?.seriesId);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'seriesId needed' });
  setSetting('continue_hidden', { ...getSetting('continue_hidden', {}), [`${kind}:${id}`]: Date.now() });
  res.json({ ok: true });
});

app.get('/api/series/:id', wrap((req, res) => {
  const s = db.prepare('SELECT * FROM series WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const chapters = db.prepare(`
    SELECT c.id, c.title, c.number, c.volume, c.page_count, c.page_start, c.page_end,
           (SELECT 1 FROM splits sp WHERE sp.path = c.path) AS manual, p.page, p.completed
    FROM chapters c LEFT JOIN progress p ON p.chapter_id = c.id
    WHERE c.series_id = ? ORDER BY c.sort_idx`).all(s.id);
  res.json({
    ...seriesDto(s),
    chapters: chapters.map((c) => ({
      id: c.id, title: chapterLabel(c), number: c.number, volume: c.volume,
      pageCount: c.page_count, page: c.page ?? 0, completed: !!c.completed,
      splittable: (c.page_start === 0 && c.page_end === null) || !!c.manual, manual: !!c.manual,
    })),
  });
}));

app.get('/api/series/:id/cover', wrap(async (req, res) => {
  const s = db.prepare('SELECT id, has_cover, kind FROM series WHERE id = ?').get(req.params.id);
  if (!s) return res.sendStatus(404);
  res.set('Cache-Control', 'no-cache'); // always revalidate (cheap 304) so a provider/cover change shows at once
  if (getOverrides(s.id).cover && fs.existsSync(customCoverFile(s.id))) return res.sendFile(customCoverFile(s.id));
  if (s.has_cover) {
    const file = path.join(COVER_DIR, `${s.id}.jpg`);
    if (fs.existsSync(file)) return res.sendFile(file);
  }
  // anime without a poster: a frame from its first episode
  const ep = db.prepare('SELECT * FROM episodes WHERE series_id = ? ORDER BY sort_idx LIMIT 1').get(s.id);
  if (ep) {
    try { return res.sendFile(await thumbFor(ep, { width: 360 })); } catch { return res.sendStatus(404); }
  }
  // fall back to the first page of the first chapter
  const ch = db.prepare('SELECT * FROM chapters WHERE series_id = ? ORDER BY sort_idx LIMIT 1').get(s.id);
  if (s.kind === 'novel') { // light novel: the cover inside its first volume
    const data = ch && (await novelCover(ch.path).catch(() => null));
    if (!data) return res.sendStatus(404);
    res.type('image/jpeg');
    try { return res.send(await sharp(data, { failOn: 'none' }).rotate().resize({ width: 600, withoutEnlargement: true }).jpeg({ quality: 84 }).toBuffer()); }
    catch { return res.sendStatus(404); }
  }
  const page = ch && (await readPage(ch, 0));
  if (!page) return res.sendStatus(404);
  res.type(page.mime);
  page.file ? res.sendFile(page.file) : res.send(page.buffer);
}));

// ---------- volume covers (gallery view) ----------

const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
fs.mkdirSync(THUMB_DIR, { recursive: true });

/** Cover for one volume: page 1 of its file, shrunk and cached on disk. `vol` is a number or "none". */
app.get('/api/series/:id/volume/:vol/cover', wrap(async (req, res) => {
  const sid = Number(req.params.id);
  if (req.params.vol !== 'none') {
    const off = db.prepare('SELECT file, remote FROM volume_covers WHERE series_id = ? AND volume = ?').get(sid, Number(req.params.vol));
    const usable = off && (off.remote === 'custom' || getSetting('official_covers', true));
    const f = usable && path.join(COVER_DIR, off.file);
    if (f && fs.existsSync(f)) { res.set('Cache-Control', 'no-cache'); return res.sendFile(f); }
  }
  const row = req.params.vol === 'none'
    ? db.prepare('SELECT * FROM chapters WHERE series_id = ? AND volume IS NULL ORDER BY sort_idx LIMIT 1').get(sid)
    : db.prepare('SELECT * FROM chapters WHERE series_id = ? AND volume = ? ORDER BY sort_idx LIMIT 1').get(sid, Number(req.params.vol));
  if (!row) return res.sendStatus(404);

  let st;
  try { st = fs.statSync(row.path); } catch { return res.sendStatus(404); }
  const key = crypto.createHash('sha1').update(`${row.path}|${st.mtimeMs}|${st.size}`).digest('hex').slice(0, 20);
  const file = path.join(THUMB_DIR, `${key}.jpg`);
  if (!fs.existsSync(file)) {
    const page = await readPage({ ...row, page_start: 0, page_end: null }, 0);
    if (!page) return res.sendStatus(404);
    try {
      await sharp(page.file || page.buffer, { failOn: 'none' }).rotate()
        .resize({ width: 420, withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(file);
    } catch { return res.sendStatus(404); }
  }
  res.set('Cache-Control', 'no-cache'); // revalidate (cheap 304) so switching covers takes effect at once
  res.sendFile(file);
}));

/** How much of the series the user has, versus what MangaDex / AniList say exists. */
const catalogTries = new Map(); // series id -> last on-demand lookup (ms)
app.get('/api/series/:id/missing', (req, res) => {
  if (!getSetting('show_missing', true)) return res.json({ known: false, disabled: true });
  const id = Number(req.params.id);
  const c = collectionFor(id);
  if (c.known) return res.json(c);
  // nothing cached yet: look it up in the background so just opening the page fills it in
  const s = db.prepare('SELECT kind, anilist_id, md_id, catalog FROM series WHERE id = ?').get(id);
  const matched = !!(s && s.kind === 'manga' && (s.anilist_id || s.md_id));
  let loading = false;
  if (matched && !s.catalog && Date.now() - (catalogTries.get(id) || 0) > 10 * 60 * 1000) {
    catalogTries.set(id, Date.now());
    loading = true;
    md.fetchSeries({ id }).catch(() => {});
  }
  res.json({ known: false, matched, loading });
});

/** Re-run the official-cover lookup for one series. */
app.post('/api/series/:id/covers/fetch', wrap(async (req, res) => {
  const s = db.prepare('SELECT * FROM series WHERE id = ?').get(req.params.id);
  if (!s) return res.sendStatus(404);
  if (s.kind !== 'manga') return res.status(400).json({ error: 'Official covers are for manga series' });
  if (!s.anilist_id && !s.md_id) return res.status(400).json({ error: 'Match this series on AniList or MangaDex first' });
  res.json(await md.fetchSeries(s, { force: true }));
}));

// ---------- chapters & pages ----------

app.get('/api/chapters/:id', wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM chapters WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const s = db.prepare('SELECT * FROM series WHERE id = ?').get(c.series_id);
  const pages = s.kind === 'novel' ? { length: c.page_count } : await pagesFor(c);
  const prev = db.prepare('SELECT id FROM chapters WHERE series_id = ? AND sort_idx < ? ORDER BY sort_idx DESC LIMIT 1').get(c.series_id, c.sort_idx);
  const next = db.prepare('SELECT id FROM chapters WHERE series_id = ? AND sort_idx > ? ORDER BY sort_idx LIMIT 1').get(c.series_id, c.sort_idx);
  const p = db.prepare('SELECT page, pos, completed FROM progress WHERE chapter_id = ?').get(c.id);
  const index = db.prepare('SELECT COUNT(*) AS n FROM chapters WHERE series_id = ? AND sort_idx <= ?').get(c.series_id, c.sort_idx).n;
  res.json({
    id: c.id, title: chapterLabel(c), number: c.number, index, pageCount: pages.length,
    series: { id: s.id, kind: s.kind, title: s.title_english || s.title_romaji || s.title, anilistId: s.anilist_id, chaptersTotal: s.chapters_total },
    prevId: prev?.id ?? null, nextId: next?.id ?? null,
    page: p?.page ?? 0, pos: p?.pos ?? 0, completed: !!p?.completed,
  });
}));

app.get('/api/chapters/:id/page/:n', wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM chapters WHERE id = ?').get(req.params.id);
  if (!c) return res.sendStatus(404);
  const page = await readPage(c, Number(req.params.n));
  if (!page) return res.sendStatus(404);
  res.set('Cache-Control', 'private, max-age=604800');
  res.type(page.mime);
  page.file ? res.sendFile(page.file) : res.send(page.buffer);
}));

app.post('/api/progress', (req, res) => {
  const { chapterId, page, completed } = req.body || {};
  const pos = Math.min(1, Math.max(0, Number(req.body?.pos) || 0));
  const c = db.prepare('SELECT id FROM chapters WHERE id = ?').get(chapterId);
  if (!c) return res.status(404).json({ error: 'Unknown chapter' });
  db.prepare(`INSERT INTO progress (chapter_id, page, pos, completed, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chapter_id) DO UPDATE SET page = excluded.page, pos = excluded.pos,
      completed = CASE WHEN excluded.completed = 1 OR progress.completed = 1 THEN 1 ELSE 0 END,
      updated_at = excluded.updated_at`).run(chapterId, Math.max(0, page | 0), pos, completed ? 1 : 0, Date.now());
  res.json({ ok: true });
});

app.post('/api/chapters/:id/read', (req, res) => {
  const read = req.body?.read !== false;
  db.prepare(`INSERT INTO progress (chapter_id, page, completed, updated_at) VALUES (?, 0, ?, ?)
    ON CONFLICT(chapter_id) DO UPDATE SET completed = excluded.completed, updated_at = excluded.updated_at,
      page = CASE WHEN excluded.completed = 1 THEN progress.page ELSE 0 END,
      pos = CASE WHEN excluded.completed = 1 THEN progress.pos ELSE 0 END`)
    .run(req.params.id, read ? 1 : 0, Date.now());
  res.json({ ok: true });
});

app.post('/api/chapters/read-bulk', (req, res) => {
  const read = req.body?.read !== false;
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger).slice(0, 5000);
  const stmt = db.prepare(`INSERT INTO progress (chapter_id, page, completed, updated_at) VALUES (?, 0, ?, ?)
    ON CONFLICT(chapter_id) DO UPDATE SET completed = excluded.completed, updated_at = excluded.updated_at,
      page = CASE WHEN excluded.completed = 1 THEN progress.page ELSE 0 END,
      pos = CASE WHEN excluded.completed = 1 THEN progress.pos ELSE 0 END`);
  const now = Date.now();
  for (const id of ids) stmt.run(id, read ? 1 : 0, now);
  res.json({ ok: true, count: ids.length });
});

app.post('/api/series/:id/read-all', (req, res) => {
  const read = req.body?.read !== false;
  const ids = db.prepare('SELECT id FROM chapters WHERE series_id = ?').all(req.params.id);
  const stmt = db.prepare(`INSERT INTO progress (chapter_id, page, completed, updated_at) VALUES (?, 0, ?, ?)
    ON CONFLICT(chapter_id) DO UPDATE SET completed = excluded.completed, updated_at = excluded.updated_at,
      page = CASE WHEN excluded.completed = 1 THEN progress.page ELSE 0 END,
      pos = CASE WHEN excluded.completed = 1 THEN progress.pos ELSE 0 END`);
  for (const { id } of ids) stmt.run(id, read ? 1 : 0, Date.now());
  res.json({ ok: true });
});

// ---------- manual chapter splitting ----------

const wholeFile = (c) => ({ ...c, page_start: 0, page_end: null });

app.post('/api/chapters/:id/reveal', (req, res) => {
  const c = db.prepare('SELECT path FROM chapters WHERE id = ?').get(req.params.id);
  if (!c) return res.sendStatus(404);
  if (!fs.existsSync(c.path)) return res.status(404).json({ error: 'The file is not at its old location any more', path: c.path });
  res.json({ opened: isLocalRequest(req) && reveal(c.path), path: c.path });
});

app.get('/api/chapters/:id/properties', wrap(async (req, res) => {
  const c = db.prepare(`SELECT c.*, s.title AS folder_title, s.title_english, s.title_romaji FROM chapters c JOIN series s ON s.id = c.series_id WHERE c.id = ?`).get(req.params.id);
  if (!c) return res.sendStatus(404);
  let st = null;
  try { st = await fsp.stat(c.path); } catch { /* missing */ }
  const p = db.prepare('SELECT page, completed FROM progress WHERE chapter_id = ?').get(c.id);
  res.json({
    name: path.basename(c.path), folder: path.dirname(c.path), path: c.path, exists: !!st,
    type: c.kind === 'dir' ? 'Folder of images' : path.extname(c.path).slice(1).toUpperCase() || 'Archive',
    size: st && !st.isDirectory() ? st.size : null, modified: st?.mtimeMs ?? null,
    series: c.title_english || c.title_romaji || c.folder_title, title: c.title, volume: c.volume, number: c.number,
    pages: c.page_count, pageRange: c.page_end != null ? `${c.page_start + 1}–${c.page_end}` : null,
    read: !!p?.completed, page: p?.page ?? 0,
  });
}));

app.get('/api/chapters/:id/splits', wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM chapters WHERE id = ?').get(req.params.id);
  if (!c) return res.sendStatus(404);
  const pageCount = (await pagesFor(wholeFile(c))).length;
  const row = db.prepare('SELECT starts, numbers, first_number FROM splits WHERE path = ?').get(c.path);
  const maxOther = db.prepare('SELECT MAX(number) AS n FROM chapters WHERE series_id = ? AND path != ?').get(c.series_id, c.path).n;
  res.json({
    pageCount, title: c.title, seriesId: c.series_id, volume: c.volume,
    starts: row ? JSON.parse(row.starts) : null, firstNumber: row?.first_number ?? null,
    markers: row ? JSON.parse(row.starts).map((page, i) => ({
      page, number: (row.numbers ? JSON.parse(row.numbers)[i] : null) ?? row.first_number + i,
    })) : null,
    suggestedFirst: Math.floor(maxOther ?? 0) + 1,
  });
}));

/** Whole-volume page image, ignoring any chapter range (used by the splitter). */
app.get('/api/chapters/:id/archive-page/:n', wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM chapters WHERE id = ?').get(req.params.id);
  if (!c) return res.sendStatus(404);
  const page = await readPage(wholeFile(c), Number(req.params.n));
  if (!page) return res.sendStatus(404);
  res.set('Cache-Control', 'private, max-age=604800');
  res.type(page.mime);
  page.file ? res.sendFile(page.file) : res.send(page.buffer);
}));

app.put('/api/chapters/:id/splits', wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM chapters WHERE id = ?').get(req.params.id);
  if (!c) return res.sendStatus(404);
  const s = db.prepare('SELECT * FROM series WHERE id = ?').get(c.series_id);

  let markers = [];
  if (Array.isArray(req.body?.markers)) {
    markers = req.body.markers.map((m) => ({ page: Number(m.page), number: Number(m.number) }));
  } else if (Array.isArray(req.body?.starts)) { // legacy: sequential numbering from firstNumber
    const first = Number(req.body.firstNumber);
    markers = [...new Set(req.body.starts.map(Number))].sort((a, b) => a - b).map((page, i) => ({ page, number: first + i }));
  }
  if (markers.some((m) => !Number.isInteger(m.page) || m.page < 0 || !Number.isFinite(m.number) || m.number < 0)) {
    return res.status(400).json({ error: 'Every chapter needs a page and a chapter number' });
  }
  const pages = markers.map((m) => m.page);
  if (new Set(pages).size !== pages.length) return res.status(400).json({ error: 'Two chapters start on the same page' });
  const nums = markers.map((m) => m.number);
  if (new Set(nums).size !== nums.length) return res.status(400).json({ error: 'Two chapters have the same number' });

  if (markers.length === 0) {
    db.prepare('DELETE FROM splits WHERE path = ?').run(c.path);
  } else {
    markers.sort((a, b) => a.page - b.page);
    db.prepare(`INSERT INTO splits (path, starts, numbers, first_number) VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET starts = excluded.starts, numbers = excluded.numbers, first_number = excluded.first_number`)
      .run(c.path, JSON.stringify(markers.map((m) => m.page)), JSON.stringify(markers.map((m) => m.number)), markers[0].number);
  }
  await rescanSeries(s.path, s.title);
  const again = db.prepare('SELECT id FROM chapters WHERE series_id = ? AND path = ? ORDER BY page_start LIMIT 1').get(s.id, c.path);
  res.json({ ok: true, seriesId: s.id, chapterId: again?.id });
}));

/** OCR the volume for "Chapter N" title pages; the splitter UI polls the job and asks the user to confirm. */
app.post('/api/chapters/:id/detect', wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM chapters WHERE id = ?').get(req.params.id);
  if (!c) return res.sendStatus(404);
  const whole = wholeFile(c);
  const count = (await pagesFor(whole)).length;
  const maxOther = db.prepare('SELECT MAX(number) AS n FROM chapters WHERE series_id = ? AND path != ?').get(c.series_id, c.path).n;
  const job = startDetect(c.path, count, (i) => readPage(whole, i), Math.floor(maxOther ?? 0) + 1);
  res.json({ state: job.state });
}));

app.get('/api/chapters/:id/detect', (req, res) => {
  const c = db.prepare('SELECT path FROM chapters WHERE id = ?').get(req.params.id);
  const job = c && detectJobs.get(c.path);
  if (!job) return res.json({ state: 'none' });
  res.json({ state: job.state, phase: job.phase, done: job.done, total: job.total, candidates: job.candidates, error: job.error });
});

// ---------- scanning & libraries ----------

app.get('/api/scan', (req, res) => res.json(scanState));

/** Restart the server: it exits with the code the launcher (start.bat, tray app, Docker) answers by starting it again. */
app.post('/api/restart', (req, res) => {
  if (!updater.supervised) {
    return res.status(400).json({ error: 'MangaSoft was not started through its launcher (start.bat, the tray app or Docker), so it cannot restart itself. Close it and start it again.' });
  }
  res.json({ ok: true });
  setTimeout(() => process.exit(75), 600);
});

app.get('/api/auto-scan', (req, res) => res.json(autoscan.status()));
app.put('/api/auto-scan', wrap((req, res) => {
  autoscan.saveSettings(req.body || {});
  autoscan.reconfigure();
  res.json(autoscan.status());
}));
app.post('/api/scan', (req, res) => {
  const library = req.body?.library ? path.resolve(String(req.body.library)) : null;
  if (library) {
    const known = [...getSetting('libraries', []), ...getSetting('doujin_libraries', []), ...getSetting('anime_libraries', []), ...getSetting('novel_libraries', [])].map((p) => path.resolve(p));
    if (!known.includes(library)) return res.status(400).json({ error: 'That is not one of your library folders' });
  }
  runScan({ rematch: !!req.body?.rematch, library });
  res.json({ started: true });
});

/** Re-read one series' files (after renaming, adding or removing chapters). Reading progress follows renamed files. */
app.post('/api/series/:id/rescan', wrap(async (req, res) => {
  const s = db.prepare('SELECT id, path, title FROM series WHERE id = ?').get(req.params.id);
  if (!s) return res.sendStatus(404);
  if (!fs.existsSync(s.path)) {
    return res.status(409).json({ missing: true, error: 'The folder or file is not at its old location any more - it may have been renamed.' });
  }
  const isNovel = db.prepare('SELECT kind FROM series WHERE id = ?').get(s.id)?.kind === 'novel';
  const r = isNovel ? await scanNovelSeries(s.path, s.title) : await rescanSeries(s.path, s.title);
  res.json(r || { id: s.id, added: 0, removed: 0, moved: 0, chapters: 0 });
}));

app.get('/api/libraries', (req, res) => res.json(getSetting('libraries', [])));
app.post('/api/libraries', wrap(async (req, res) => {
  const raw = String(req.body?.path || '').trim().replace(/^"|"$/g, '');
  if (!raw) return res.status(400).json({ error: 'Enter a folder path' });
  const p = path.resolve(raw);
  const st = await fsp.stat(p).catch(() => null);
  if (!st?.isDirectory()) return res.status(400).json({ error: `Folder not found: ${p}` });
  const libs = getSetting('libraries', []);
  if (!libs.includes(p)) setSetting('libraries', [...libs, p]);
  runScan();
  res.json(getSetting('libraries', []));
}));
app.delete('/api/libraries', (req, res) => {
  setSetting('libraries', getSetting('libraries', []).filter((l) => l !== req.body?.path));
  runScan();
  res.json(getSetting('libraries', []));
});

// ---------- AniList ----------

app.get('/api/anilist/status', (req, res) => {
  res.json({
    connected: !!getSetting('anilist_token'),
    user: getSetting('anilist_user'),
    clientId: getSetting('anilist_client_id', ''),
    autoSync: getSetting('auto_sync', false),
    autoMatch: getSetting('auto_match', true),
    officialCovers: getSetting('official_covers', true),
    showMissing: getSetting('show_missing', true),
    continuousChapters: getSetting('chapter_continuous', true),
    mangadexFallback: getSetting('mangadex_fallback', true),
    metaOrder: getSetting('meta_order', 'anilist-first'),
  });
});

app.put('/api/settings', (req, res) => {
  const b = req.body || {};
  if ('autoSync' in b) setSetting('auto_sync', !!b.autoSync);
  if ('autoMatch' in b) setSetting('auto_match', !!b.autoMatch);
  if ('clientId' in b) setSetting('anilist_client_id', String(b.clientId).trim());
  if ('nhAutoMatch' in b) setSetting('nh_auto_match', !!b.nhAutoMatch);
  if ('officialCovers' in b) setSetting('official_covers', !!b.officialCovers);
  if ('showMissing' in b) setSetting('show_missing', !!b.showMissing);
  if ('continuousChapters' in b) setSetting('chapter_continuous', !!b.continuousChapters);
  if ('mangadexFallback' in b) setSetting('mangadex_fallback', !!b.mangadexFallback);
  if (b.metaOrder === 'anilist-first' || b.metaOrder === 'mangadex-first') setSetting('meta_order', b.metaOrder);
  if ('nhApiKey' in b) setSetting('nh_api_key', String(b.nhApiKey).trim() || null);
  if ('doujinHideNav' in b) setSetting('doujin_hide_nav', !!b.doujinHideNav);
  if ('updateUrl' in b) setSetting('update_url', String(b.updateUrl).trim() || null);
  if ('autoUpdate' in b) setSetting('auto_update', !!b.autoUpdate);
  res.json({ ok: true });
});

app.post('/api/anilist/token', wrap(async (req, res) => {
  let token = String(req.body?.token || '').trim();
  const m = token.match(/access_token=([^&\s]+)/); // allow pasting the whole redirect URL
  if (m) token = m[1];
  if (!token) return res.status(400).json({ error: 'No token provided' });
  setSetting('anilist_token', token);
  try {
    const viewer = await al.fetchViewer();
    setSetting('anilist_user', viewer);
    res.json({ user: viewer });
  } catch (e) {
    setSetting('anilist_token', null);
    res.status(400).json({ error: `AniList rejected that token: ${e.message}` });
  }
}));

app.delete('/api/anilist/token', (req, res) => {
  setSetting('anilist_token', null);
  setSetting('anilist_user', null);
  res.json({ ok: true });
});

app.get('/api/anilist/search', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  const results = req.query.novel ? await al.searchNovel(q, 10) : await al.search(q, 10);
  res.json(results.map((m) => ({
    id: m.id, title: m.title.english || m.title.romaji, romaji: m.title.romaji, native: m.title.native,
    cover: m.coverImage?.large, year: m.startDate?.year, format: m.format, chapters: m.chapters, status: m.status,
  })));
}));

app.post('/api/series/:id/match', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM series WHERE id = ?').get(id)) return res.sendStatus(404);
  if (req.body?.anilistId === null) {
    db.prepare("UPDATE series SET anilist_id = NULL, match_state = 'manual' WHERE id = ?").run(id);
    return res.json({ ok: true });
  }
  const media = await al.getMedia(Number(req.body.anilistId));
  await al.applyMedia(id, media, 'manual');
  db.prepare('UPDATE series SET md_id = NULL, md_checked = NULL WHERE id = ?').run(id);
  db.prepare('DELETE FROM volume_covers WHERE series_id = ?').run(id);
  if (db.prepare('SELECT kind FROM series WHERE id = ?').get(id)?.kind === 'manga') md.fetchSeries({ id }).catch(() => {});
  db.prepare('UPDATE series SET rel_checked = NULL WHERE id = ?').run(id);
  relationsPass().catch(() => {});
  res.json({ ok: true });
}));

/** Re-fetch a series' details from whichever provider it came from (manual edits are re-applied on top). */
async function refreshSeries(s) {
  if (s.kind === 'anime') {
    if (s.anilist_id) await al.applyMedia(s.id, await al.getAnime(s.anilist_id), s.match_state);
    else await al.autoMatch(s, true);
    mergePass();
  } else if (s.meta_source === 'mangadex' && s.md_id) {
    const m = await md.getManga(s.md_id);
    if (m) await md.applyManga(s.id, m, s.match_state);
  } else if (s.anilist_id) await al.applyMedia(s.id, await al.getMedia(s.anilist_id), s.match_state);
  else if (s.kind === 'novel') await al.autoMatch(s, false, true);
  else if (s.kind === 'manga') await matchManga(s);
}

app.post('/api/series/:id/refresh', wrap(async (req, res) => {
  const s = db.prepare('SELECT * FROM series WHERE id = ?').get(req.params.id);
  if (!s) return res.sendStatus(404);
  await refreshSeries(s);
  res.json({ ok: true });
}));

/**
 * Hand-edit a series. Each supplied field becomes an override that survives provider refreshes.
 * A field set to null drops its override (the provider's value comes back on the next refresh).
 * Fields: title, native, description, genres, authors, status, year, chapters, volumes; coverUrl.
 */
app.put('/api/series/:id/metadata', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM series WHERE id = ?').get(id)) return res.sendStatus(404);
  const body = req.body || {};
  const o = getOverrides(id);
  try {
    for (const key of Object.keys(FIELDS)) {
      if (!(key in body)) continue;
      if (body[key] === null) delete o[key];
      else if (key === 'title' && !String(body[key]).trim()) continue;
      else o[key] = clean(key, body[key]);
    }
  } catch (e) { return res.status(400).json({ error: e.message }); }

  if (body.coverUrl) {
    let url;
    try { url = new URL(String(body.coverUrl)); } catch { return res.status(400).json({ error: 'That cover URL is not valid' }); }
    if (!/^https?:$/.test(url.protocol)) return res.status(400).json({ error: 'Cover URL must be http(s)' });
    const r = await fetch(url).catch(() => null);
    if (!r?.ok || !(r.headers.get('content-type') || '').startsWith('image/')) {
      return res.status(400).json({ error: 'Could not download an image from that URL' });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 15 * 1024 * 1024) return res.status(400).json({ error: 'Cover image is too large' });
    try {
      await sharp(buf, { failOn: 'none' }).rotate().resize({ height: 1400, withoutEnlargement: true }).jpeg({ quality: 88 }).toFile(customCoverFile(id));
    } catch { return res.status(400).json({ error: 'That file is not a usable image' }); }
    o.cover = true;
  }
  saveOverrides(id, o);
  applyOverrides(id);
  res.json({ ok: true, edited: Object.keys(o) });
}));

/** Drop every manual edit (and the custom cover) and take the provider's values again. */
app.post('/api/series/:id/metadata/reset', wrap(async (req, res) => {
  const s = db.prepare('SELECT * FROM series WHERE id = ?').get(req.params.id);
  if (!s) return res.sendStatus(404);
  saveOverrides(s.id, {});
  fs.rmSync(customCoverFile(s.id), { force: true });
  await refreshSeries(s).catch(() => {});
  res.json({ ok: true });
}));

const imageBody = express.raw({ type: 'image/*', limit: '15mb' });
async function toJpeg(buf, opts) {
  return sharp(buf, { failOn: 'none' }).rotate().resize({ ...opts, withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
}

/** Upload a cover image for the series (kept across refreshes). */
app.post('/api/series/:id/cover', imageBody, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM series WHERE id = ?').get(id)) return res.sendStatus(404);
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Send an image file' });
  let jpeg;
  try { jpeg = await toJpeg(req.body, { height: 1400 }); } catch { return res.status(400).json({ error: 'That file is not a usable image' }); }
  await fsp.writeFile(customCoverFile(id), jpeg);
  const o = getOverrides(id); o.cover = true; saveOverrides(id, o);
  res.json({ ok: true });
}));

app.delete('/api/series/:id/cover', (req, res) => {
  const id = Number(req.params.id);
  fs.rmSync(customCoverFile(id), { force: true });
  const o = getOverrides(id); delete o.cover; saveOverrides(id, o);
  res.json({ ok: true });
});

/** Upload / remove a cover for one volume (shown in the gallery; official covers never replace it). */
app.post('/api/series/:id/volume/:vol/cover', imageBody, wrap(async (req, res) => {
  const sid = Number(req.params.id), vol = Number(req.params.vol);
  if (!Number.isInteger(vol) || !db.prepare('SELECT 1 FROM series WHERE id = ?').get(sid)) return res.sendStatus(404);
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Send an image file' });
  let jpeg;
  try { jpeg = await toJpeg(req.body, { width: 600 }); } catch { return res.status(400).json({ error: 'That file is not a usable image' }); }
  const file = `vol-${sid}-${vol}-custom.jpg`;
  await fsp.writeFile(path.join(COVER_DIR, file), jpeg);
  db.prepare(`INSERT INTO volume_covers (series_id, volume, file, remote) VALUES (?, ?, ?, 'custom')
    ON CONFLICT(series_id, volume) DO UPDATE SET file = excluded.file, remote = 'custom'`).run(sid, vol, file);
  res.json({ ok: true });
}));

app.delete('/api/series/:id/volume/:vol/cover', wrap(async (req, res) => {
  const sid = Number(req.params.id), vol = Number(req.params.vol);
  const row = db.prepare('SELECT file, remote FROM volume_covers WHERE series_id = ? AND volume = ?').get(sid, vol);
  if (row?.remote === 'custom') {
    fs.rmSync(path.join(COVER_DIR, row.file), { force: true });
    db.prepare('DELETE FROM volume_covers WHERE series_id = ? AND volume = ?').run(sid, vol);
    // put the official cover back straight away (best effort; the next scan retries if offline)
    await md.fetchSeries({ id: sid }, { force: true }).catch(() => {});
  }
  res.json({ ok: true });
}));

app.get('/api/series/:id/anilist', wrap(async (req, res) => {
  const s = db.prepare('SELECT anilist_id FROM series WHERE id = ?').get(req.params.id);
  if (!s?.anilist_id || !getSetting('anilist_token')) return res.json({ connected: !!getSetting('anilist_token'), entry: null });
  res.json({ connected: true, entry: await al.getListEntry(s.anilist_id) });
}));

/** Set list status for a series (adds it to the user's AniList if necessary). */
app.post('/api/series/:id/anilist', wrap(async (req, res) => {
  const s = db.prepare('SELECT anilist_id FROM series WHERE id = ?').get(req.params.id);
  if (!s?.anilist_id) return res.status(400).json({ error: 'This series is not matched to AniList yet' });
  const allowed = ['CURRENT', 'PLANNING', 'COMPLETED', 'PAUSED', 'DROPPED', 'REPEATING'];
  if (!allowed.includes(req.body?.status)) return res.status(400).json({ error: 'Invalid status' });
  res.json({ entry: await al.saveEntry(s.anilist_id, { status: req.body.status }) });
}));

/**
 * Record a chapter as read on AniList: progress = max(current, chapter number).
 * Moves the entry to CURRENT (or COMPLETED when the last known chapter is reached).
 */
app.post('/api/anilist/progress', wrap(async (req, res) => {
  const c = db.prepare('SELECT * FROM chapters WHERE id = ?').get(req.body?.chapterId);
  if (!c) return res.sendStatus(404);
  const s = db.prepare('SELECT * FROM series WHERE id = ?').get(c.series_id);
  if (!s.anilist_id) return res.status(400).json({ error: 'Match this series to AniList first' });

  let target = c.number != null ? Math.floor(c.number)
    : db.prepare('SELECT COUNT(*) AS n FROM chapters WHERE series_id = ? AND sort_idx <= ?').get(s.id, c.sort_idx).n;
  if (req.body?.progress != null) target = Number(req.body.progress) | 0;

  const entry = await al.getListEntry(s.anilist_id);
  const current = entry?.progress ?? 0;
  const progress = req.body?.force ? target : Math.max(current, target);
  let status = entry?.status;
  if (!status || ['PLANNING', 'PAUSED', 'DROPPED'].includes(status)) status = 'CURRENT';
  if (s.chapters_total && progress >= s.chapters_total && status === 'CURRENT') status = 'COMPLETED';

  const saved = await al.saveEntry(s.anilist_id, { progress, status });
  db.prepare(`INSERT INTO progress (chapter_id, page, completed, updated_at) VALUES (?, 0, 1, ?)
    ON CONFLICT(chapter_id) DO UPDATE SET completed = 1`).run(c.id, Date.now());
  res.json({
    entry: saved, previous: current, target,
    changed: saved.progress !== current || saved.status !== entry?.status,
  });
}));

// ---------- doujin section ----------

const needUnlocked = (req, res) => {
  if (unlocked(req)) return true;
  res.status(403).json({ error: 'locked', locked: true });
  return false;
};

app.get('/api/doujin/status', (req, res) => {
  const open = unlocked(req);
  res.json({
    enabled: getSetting('doujin_libraries', []).length > 0,
    libraries: open ? getSetting('doujin_libraries', []) : [],
    pinSet: pinSet(), unlocked: open,
    hideNav: getSetting('doujin_hide_nav', false),
    autoMatch: getSetting('nh_auto_match', true), hasApiKey: !!getSetting('nh_api_key'),
  });
});

app.post('/api/doujin/unlock', (req, res) => {
  if (Date.now() < attempts.until) return res.status(429).json({ error: 'Too many attempts - wait a minute' });
  if (!checkPin(req.body?.pin, getSetting('doujin_pin'))) {
    if (++attempts.n >= 5) { attempts.n = 0; attempts.until = Date.now() + 60_000; }
    return res.status(401).json({ error: 'Wrong PIN' });
  }
  attempts.n = 0;
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_MS);
  res.setHeader('Set-Cookie', `ms_dj=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}`);
  res.json({ ok: true });
});

app.post('/api/doujin/lock', (req, res) => {
  sessions.delete(cookieOf(req, 'ms_dj'));
  res.setHeader('Set-Cookie', 'ms_dj=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

/** Set, change or remove the PIN. `pin: ''` removes it. Changing needs the current PIN. */
app.put('/api/doujin/pin', (req, res) => {
  const { pin = '', current = '' } = req.body || {};
  if (pinSet() && !checkPin(current, getSetting('doujin_pin'))) return res.status(401).json({ error: 'Current PIN is wrong' });
  if (pin === '') {
    setSetting('doujin_pin', null);
    sessions.clear();
    return res.json({ pinSet: false });
  }
  if (String(pin).length < 4) return res.status(400).json({ error: 'Use at least 4 characters' });
  setSetting('doujin_pin', hashPin(pin));
  sessions.clear();
  const token = crypto.randomBytes(24).toString('hex'); // keep this device unlocked
  sessions.set(token, Date.now() + SESSION_MS);
  res.setHeader('Set-Cookie', `ms_dj=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}`);
  res.json({ pinSet: true });
});

app.post('/api/doujin/libraries', wrap(async (req, res) => {
  if (!needUnlocked(req, res)) return;
  const raw = String(req.body?.path || '').trim().replace(/^"|"$/g, '');
  if (!raw) return res.status(400).json({ error: 'Enter a folder path' });
  const p = path.resolve(raw);
  const st = await fsp.stat(p).catch(() => null);
  if (!st?.isDirectory()) return res.status(400).json({ error: `Folder not found: ${p}` });
  if (getSetting('libraries', []).includes(p)) return res.status(400).json({ error: 'That folder is already a manga library' });
  const libs = getSetting('doujin_libraries', []);
  if (!libs.includes(p)) setSetting('doujin_libraries', [...libs, p]);
  runScan();
  res.json(getSetting('doujin_libraries', []));
}));

app.delete('/api/doujin/libraries', (req, res) => {
  if (!needUnlocked(req, res)) return;
  setSetting('doujin_libraries', getSetting('doujin_libraries', []).filter((l) => l !== req.body?.path));
  runScan();
  res.json(getSetting('doujin_libraries', []));
});

app.get('/api/doujin/search', wrap(async (req, res) => {
  if (!needUnlocked(req, res)) return;
  const q = String(req.query.q || '').trim();
  res.json(q ? await nh.search(q) : []);
}));

const doujinSeries = (req, res) => {
  const s = db.prepare('SELECT * FROM series WHERE id = ?').get(req.params.id);
  if (!s) { res.sendStatus(404); return null; }
  if (s.kind !== 'doujin') { res.status(400).json({ error: 'Not a doujin series' }); return null; }
  return s;
};

/** Link a series to an nhentai gallery by number (or unlink with nhId: null). */
app.post('/api/series/:id/nhentai', wrap(async (req, res) => {
  const s = doujinSeries(req, res); if (!s) return;
  if (req.body?.nhId === null) {
    db.prepare("UPDATE series SET nh_id = NULL, match_state = 'manual', site_url = NULL WHERE id = ?").run(s.id);
    nh.applyLocal(s, 'manual');
    return res.json({ ok: true });
  }
  const g = await nh.getGallery(Number(req.body?.nhId));
  if (!g) return res.status(404).json({ error: 'nhentai has no gallery with that number' });
  await nh.applyGallery(s.id, g, 'manual');
  res.json({ ok: true });
}));

app.post('/api/series/:id/nhentai/refresh', wrap(async (req, res) => {
  const s = doujinSeries(req, res); if (!s) return;
  if (s.nh_id) {
    const g = await nh.getGallery(s.nh_id);
    if (g) await nh.applyGallery(s.id, g, s.match_state);
  } else await nh.autoMatch(s);
  res.json({ ok: true });
}));

// ---------- updates ----------

app.get('/api/update/status', (req, res) => res.json(updater.status()));

app.post('/api/update/check', wrap(async (req, res) => res.json(await updater.check())));

app.post('/api/update/install', wrap(async (req, res) => {
  if (!updater.status().available) await updater.check();
  if (!updater.status().available) return res.status(400).json({ error: 'You are already on the latest version' });
  await updater.installNow(); // verifies, stages, then restarts shortly after this response
  res.json({ ok: true, restarting: true, to: updater.status().available.version });
}));

// ---------- MangaDex as a metadata source ----------

app.get('/api/mangadex/search', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  res.json((await md.searchManga(q)).map((m) => ({
    id: m.id, title: m.title, native: m.native, year: m.year, status: m.status,
    chapters: m.lastChapter, cover: m.cover ? `/api/mangadex/cover/${m.id}/${m.cover}` : null,
  })));
}));

/** Small proxy so the browser never talks to MangaDex's image host directly. */
app.get('/api/mangadex/cover/:id/:file', wrap(async (req, res) => {
  const { id, file } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[A-Za-z0-9._-]+\.(jpe?g|png|webp)$/i.test(file)) return res.sendStatus(400);
  const r = await fetch(`https://uploads.mangadex.org/covers/${id}/${file}.256.jpg`, { headers: { 'User-Agent': 'MangaSoft/1.2 (personal self-hosted library)' } });
  if (!r.ok) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=86400').type('image/jpeg').send(Buffer.from(await r.arrayBuffer()));
}));

/** Link a series to a MangaDex entry (or unlink with mdId: null). */
app.post('/api/series/:id/mangadex', wrap(async (req, res) => {
  const s = db.prepare('SELECT * FROM series WHERE id = ?').get(req.params.id);
  if (!s) return res.sendStatus(404);
  if (s.kind !== 'manga') return res.status(400).json({ error: 'Not a manga series' });
  if (req.body?.mdId === null) {
    db.prepare("UPDATE series SET md_id = NULL, md_checked = ?, meta_source = CASE WHEN anilist_id IS NOT NULL THEN 'anilist' ELSE NULL END, match_state = 'manual' WHERE id = ?")
      .run(Date.now(), s.id);
    db.prepare('DELETE FROM volume_covers WHERE series_id = ?').run(s.id);
    return res.json({ ok: true });
  }
  const mdId = String(req.body?.mdId || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(mdId)) return res.status(400).json({ error: 'Not a valid MangaDex id' });
  const m = await md.getManga(mdId);
  if (!m) return res.status(404).json({ error: 'MangaDex has no entry with that id' });
  db.prepare('DELETE FROM volume_covers WHERE series_id = ?').run(s.id);
  await md.applyManga(s.id, m, 'manual');
  md.fetchSeries({ id: s.id }, { force: true }).catch(() => {});
  res.json({ ok: true });
}));

// ---------- anime (video) ----------

mountAnime(app, { wrap, seriesDto, runScan, scanState });
mountSocial(app, { wrap });
mountNovels(app, { wrap, runScan });
mountRelations(app, { wrap, unlocked });

// ---------- static ----------

app.get('/healthz', (req, res) => res.send('ok'));
// libass in the browser (styled ASS subtitles): wasm + default font (the JS is bundled in public/vendor/jassub)
app.use('/vendor/jassub-dist', express.static(path.join(here, '..', 'node_modules', 'jassub', 'dist'), { maxAge: '7d' }));
app.use('/vendor', express.static(path.join(here, '..', 'node_modules', 'hls.js', 'dist'), { maxAge: '7d' }));
app.use(express.static(path.join(here, '..', 'public'), { extensions: ['html'] }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n  MangaSoft is running 🌸\n');
  console.log(`  This PC:   http://localhost:${PORT}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  Network:   http://${a.address}:${PORT}`);
    }
  }
  console.log('');
  if (getSetting('libraries', []).length || getSetting('doujin_libraries', []).length || getSetting('anime_libraries', []).length || getSetting('novel_libraries', []).length) runScan();
  updater.confirmBoot();
  autoscan.startAutoScan({ runScan, scanState, busy: () => [...detectJobs.values()].some((j) => j.state === 'running') });
  updater.startScheduler(() => !scanState.running
    && ![...detectJobs.values()].some((j) => j.state === 'running')
    && Date.now() - lastActivity > 120_000);
});
