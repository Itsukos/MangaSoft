import fs from 'node:fs/promises';
import path from 'node:path';
import { db, COVER_DIR, getSetting } from './db.js';
import { cleanTitle } from './anilist.js';
import { applyOverrides } from './meta.js';

/**
 * Official per-volume cover art from MangaDex (public API, no key).
 * A MangaDex entry is accepted only when its AniList link equals the series' AniList ID,
 * so a wrong title match can never attach the wrong covers.
 */

const API = 'https://api.mangadex.org';
const UPLOADS = 'https://uploads.mangadex.org';
const UA = 'MangaSoft/1.1 (personal self-hosted library)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;

async function call(pathAndQuery) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = last + 350 - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const res = await fetch(API + pathAndQuery, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    if (res.status === 429) { await sleep(Math.min(30, Number(res.headers.get('retry-after')) || 5) * 1000); continue; }
    if (!res.ok) throw new Error(`MangaDex answered ${res.status}`);
    return res.json();
  }
  throw new Error('MangaDex rate limit - try again shortly');
}

async function findManga(anilistId, titles) {
  const tried = new Set();
  for (const raw of titles) {
    const t = String(raw || '').trim().slice(0, 100);
    if (!t || tried.has(t.toLowerCase())) continue;
    tried.add(t.toLowerCase());
    // all content ratings, otherwise MangaDex hides erotica/pornographic entries from search
    const d = await call(`/manga?title=${encodeURIComponent(t)}&limit=10`
      + '&contentRating%5B%5D=safe&contentRating%5B%5D=suggestive&contentRating%5B%5D=erotica&contentRating%5B%5D=pornographic');
    const hit = (d.data || []).find((m) => String(m.attributes?.links?.al) === String(anilistId));
    if (hit) return hit.id;
  }
  return null;
}

async function listCovers(mdId) {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const d = await call(`/cover?manga%5B%5D=${mdId}&limit=100&offset=${offset}&order%5Bvolume%5D=asc`);
    out.push(...(d.data || []));
    if (offset + 100 >= (d.total || 0)) break;
  }
  return out;
}

/** Which chapters (and volumes) exist, from MangaDex's aggregate. Works for ongoing series, unlike the "last chapter" fields. */
async function aggregate(mdId) {
  const d = await call(`/manga/${mdId}/aggregate`);
  const chapters = new Map(); // integer chapter -> volume | null
  const volumes = new Set();
  let fractional = 0;
  for (const [vol, vd] of Object.entries(d.volumes || {})) {
    const v = vol === 'none' ? null : parseInt(vol, 10);
    if (v !== null && Number.isFinite(v)) volumes.add(v);
    for (const key of Object.keys(vd.chapters || {})) {
      const n = Number(key);
      if (!Number.isFinite(n) || n < 1) continue;
      if (!Number.isInteger(n)) { fractional++; continue; } // 5.5, extras, omakes
      if (!chapters.has(n) || (chapters.get(n) === null && v !== null)) chapters.set(n, v);
    }
  }
  // MangaDex data sometimes has a chapter number typed into the volume field ("volume 115"): keep the
  // contiguous run of volumes and ignore a volume that jumps far past it
  const sorted = [...volumes].sort((a, b) => a - b);
  const keep = [];
  for (const v of sorted) { if (keep.length && v - keep[keep.length - 1] > 5) break; keep.push(v); }
  const valid = new Set(keep);
  for (const [n, v] of chapters) if (v !== null && !valid.has(v)) chapters.set(n, null);
  return {
    chapters: [...chapters].sort((a, b) => a[0] - b[0]),
    volumes: keep,
    fractional, checked: Date.now(),
  };
}

const LOCALE_RANK = { en: 0, ja: 1 };

/** Look up and download official covers for the volumes this series actually has. */
export async function fetchSeries(series, { force = false } = {}) {
  const row = db.prepare('SELECT id, anilist_id, md_id, title, title_romaji, title_english FROM series WHERE id = ?').get(series.id);
  if (!row?.anilist_id && !row?.md_id) return { found: 0, reason: 'not matched on AniList or MangaDex' };

  // a MangaDex-matched series already knows its id; an AniList-matched one is found through AniList's link
  let mdId = (!force || !row.anilist_id) && row.md_id ? row.md_id : null;
  if (!mdId) mdId = await findManga(row.anilist_id, [row.title_romaji, row.title_english, row.title]);
  db.prepare('UPDATE series SET md_id = ?, md_checked = ? WHERE id = ?').run(mdId, Date.now(), row.id);
  if (!mdId) return { found: 0, reason: 'not found on MangaDex' };

  try { // what has been published, for the "what am I missing" summary (optional extra; skipped when switched off)
    if (getSetting('show_missing', true)) db.prepare('UPDATE series SET catalog = ? WHERE id = ?').run(JSON.stringify(await aggregate(mdId)), row.id);
  } catch { /* keep the previous catalog */ }

  const owned = db.prepare('SELECT DISTINCT volume FROM chapters WHERE series_id = ? AND volume IS NOT NULL').all(row.id).map((r) => r.volume);
  const best = new Map(); // volume -> best cover (English edition first, then Japanese)
  for (const c of await listCovers(mdId)) {
    const v = Number(c.attributes?.volume);
    if (!Number.isInteger(v)) continue;
    const rank = LOCALE_RANK[c.attributes.locale] ?? 5;
    const cur = best.get(v);
    if (!cur || rank < cur.rank) best.set(v, { rank, fileName: c.attributes.fileName });
  }

  let found = 0;
  for (const vol of owned) {
    const c = best.get(vol);
    if (!c) continue;
    const existing = db.prepare('SELECT file, remote FROM volume_covers WHERE series_id = ? AND volume = ?').get(row.id, vol);
    const file = `vol-${row.id}-${vol}.jpg`;
    if (existing?.remote === 'custom') { found++; continue; } // set by hand: leave it alone
    if (existing?.remote === c.fileName) {
      try { await fs.access(path.join(COVER_DIR, existing.file)); found++; continue; } catch { /* re-download */ }
    }
    const res = await fetch(`${UPLOADS}/covers/${mdId}/${c.fileName}.512.jpg`, { headers: { 'User-Agent': UA } });
    if (!res.ok || !(res.headers.get('content-type') || '').startsWith('image/')) continue;
    await fs.writeFile(path.join(COVER_DIR, file), Buffer.from(await res.arrayBuffer()));
    db.prepare(`INSERT INTO volume_covers (series_id, volume, file, remote) VALUES (?, ?, ?, ?)
      ON CONFLICT(series_id, volume) DO UPDATE SET file = excluded.file, remote = excluded.remote`).run(row.id, vol, file, c.fileName);
    found++;
  }
  return { found, mdId, available: best.size };
}


// ---------- MangaDex as a metadata provider (fallback when AniList has no match) ----------

const INCLUDES = 'includes%5B%5D=cover_art&includes%5B%5D=author&includes%5B%5D=artist';
const RATINGS = 'contentRating%5B%5D=safe&contentRating%5B%5D=suggestive&contentRating%5B%5D=erotica&contentRating%5B%5D=pornographic';
const pickTitle = (o) => o?.en || o?.['ja-ro'] || Object.values(o || {})[0] || '';

function shape(m) {
  const a = m.attributes || {};
  const rel = (t) => (m.relationships || []).filter((r) => r.type === t);
  const alt = (a.altTitles || []).flatMap((o) => Object.values(o));
  const native = (a.altTitles || []).map((o) => o.ja || o.ko || o.zh).find(Boolean) || null;
  return {
    id: m.id, title: pickTitle(a.title), native, alt,
    description: a.description?.en || Object.values(a.description || {})[0] || '',
    status: a.status, year: a.year || null, lang: a.originalLanguage, alId: Number(a.links?.al) || null,
    lastVolume: a.lastVolume, lastChapter: a.lastChapter,
    tags: (a.tags || []).map((t) => ({ name: t.attributes?.name?.en, group: t.attributes?.group })).filter((t) => t.name),
    authors: [...new Set([...rel('author'), ...rel('artist')].map((r) => r.attributes?.name).filter(Boolean))],
    cover: rel('cover_art')[0]?.attributes?.fileName || null,
  };
}

export async function getManga(id) {
  const d = await call(`/manga/${encodeURIComponent(id)}?${INCLUDES}`);
  return d?.data ? shape(d.data) : null;
}

export async function searchManga(q, limit = 10) {
  const d = await call(`/manga?title=${encodeURIComponent(String(q).slice(0, 100))}&limit=${limit}&${INCLUDES}&${RATINGS}`);
  return (d.data || []).map(shape);
}

const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = new Set(a.split(' ')), tb = new Set(b.split(' '));
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return Math.min(1, hit / (ta.size + tb.size - hit) + (a.includes(b) || b.includes(a) ? 0.15 : 0));
}

/** Write MangaDex details onto a series (same fields AniList fills, so the UI needs no special cases). */
export async function applyManga(seriesId, m, state) {
  const genres = m.tags.filter((t) => t.group === 'genre' || t.group === 'theme').map((t) => t.name);
  const status = { ongoing: 'RELEASING', completed: 'FINISHED', hiatus: 'HIATUS', cancelled: 'CANCELLED' }[m.status] || null;
  const pos = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; };
  const format = ({ ja: 'MANGA', ko: 'MANHWA', zh: 'MANHUA', 'zh-hk': 'MANHUA' })[m.lang] || 'MANGA';

  const prev = db.prepare('SELECT md_id, meta_source FROM series WHERE id = ?').get(seriesId);
  let hasCover = false;
  if (m.cover) {
    try {
      const res = await fetch(`${UPLOADS}/covers/${m.id}/${m.cover}.512.jpg`, { headers: { 'User-Agent': UA } });
      if (res.ok && (res.headers.get('content-type') || '').startsWith('image/')) {
        await fs.writeFile(path.join(COVER_DIR, `${seriesId}.jpg`), Buffer.from(await res.arrayBuffer()));
        hasCover = true;
      }
    } catch { /* cover is optional */ }
  }
  const dropCover = !hasCover && !(prev?.md_id === m.id && prev?.meta_source === 'mangadex');
  db.prepare(`UPDATE series SET
      meta_source = 'mangadex', md_id = ?, md_checked = NULL, match_state = ?, anilist_id = COALESCE(anilist_id, ?),
      title_english = ?, title_romaji = NULL, title_native = ?, description = ?, genres = ?, authors = ?,
      status = ?, format = ?, chapters_total = ?, volumes_total = ?, score = NULL, year = ?,
      banner_url = NULL, site_url = ?, has_cover = CASE WHEN ? THEN 1 WHEN ? THEN 0 ELSE has_cover END
    WHERE id = ?`).run(
    m.id, state, m.alId, m.title, m.native, m.description.replace(/\r/g, '').trim(),
    JSON.stringify(genres), JSON.stringify(m.authors.slice(0, 6)),
    status, format, pos(m.lastChapter), pos(m.lastVolume), m.year,
    `https://mangadex.org/title/${m.id}`, hasCover ? 1 : 0, dropCover ? 1 : 0, seriesId,
  );
  applyOverrides(seriesId);
}

/** Title search; accepts a result only when it is clearly the same series. */
export async function autoMatch(series) {
  const term = cleanTitle(series.title);
  const results = await searchManga(term, 8);
  let best = null, bestScore = 0;
  for (const r of results) {
    const score = Math.max(...[r.title, r.native, ...r.alt].filter(Boolean).map((n) => similarity(term, n)));
    if (score > bestScore) { best = r; bestScore = score; }
  }
  db.prepare('UPDATE series SET md_checked = ? WHERE id = ?').run(Date.now(), series.id);
  if (!best || bestScore < 0.6) return false;
  await applyManga(series.id, best, 'auto');
  return true;
}
