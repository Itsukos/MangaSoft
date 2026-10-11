import fs from 'node:fs/promises';
import path from 'node:path';
import { db, COVER_DIR, getSetting } from './db.js';
import { applyOverrides } from './meta.js';

/**
 * Metadata from nhentai's official v2 API (https://nhentai.net/api/v2/docs).
 * Works anonymously (about 20 requests/min); an optional API key raises the limit.
 * Only metadata and the cover are fetched - pages always come from the user's own files.
 */

const BASE = 'https://nhentai.net/api/v2';
const UA = 'MangaSoft/1.0 (personal self-hosted library)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;

async function call(pathAndQuery) {
  const key = getSetting('nh_api_key');
  const gap = key ? 1600 : 3300; // stay under the anonymous per-minute limit
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = lastCall + gap - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();

    const res = await fetch(BASE + pathAndQuery, {
      headers: { 'User-Agent': UA, Accept: 'application/json', ...(key ? { Authorization: `Key ${key}` } : {}) },
    });
    if (res.status === 429) {
      await sleep(Math.min(60, Number(res.headers.get('retry-after')) || 30) * 1000);
      continue;
    }
    if (res.status === 404) return null;
    if (res.status === 401) throw new Error('nhentai rejected the API key - check it in Settings');
    if (res.status === 403) throw new Error('nhentai refused the request (blocked). Try again later.');
    if (!res.ok) throw new Error(`nhentai error ${res.status}`);
    return res.json();
  }
  throw new Error('nhentai rate limit - try again in a minute');
}

let cdnCache = null;
async function thumbServer() {
  if (!cdnCache) {
    const c = await call('/cdn').catch(() => null);
    cdnCache = c?.thumb_servers?.[0] || 'https://t1.nhentai.net';
  }
  return cdnCache;
}

export const getGallery = (id) => call(`/galleries/${Number(id)}`);

export async function search(query) {
  const r = await call(`/search?query=${encodeURIComponent(query)}`);
  const base = await thumbServer();
  return (r?.result || []).slice(0, 10).map((x) => ({
    id: x.id, title: x.english_title || x.japanese_title || `#${x.id}`, japanese: x.japanese_title,
    pages: x.num_pages, cover: x.thumbnail ? `${base}/${x.thumbnail}` : null,
  }));
}

// ---------- filename parsing ----------

const LANGS = /^(english|japanese|chinese|korean|spanish|french|german|russian|italian|portuguese|thai|vietnamese|polish|indonesian|turkish|dutch|arabic)/i;

/** "(C97) [Circle (Artist)] Title (Parody) [English] [Digital]" → parts. */
export function parseDoujinName(raw) {
  let s = raw.replace(/\.(cbz|zip)$/i, '').replace(/_/g, ' ').trim();
  const out = { id: null, event: null, circle: null, artist: null, parody: null, language: null, title: '' };

  const idm = s.match(/(?:#|nhentai[ -]?)(\d{4,7})\b/i) || s.match(/\[(\d{5,7})\]/);
  if (idm) { out.id = Number(idm[1]); s = s.replace(idm[0], ' '); }

  s = s.replace(/^\s*\(([^)]+)\)\s*/, (_, e) => { out.event = e; return ''; });
  s = s.replace(/^\s*\[([^\]]+)\]\s*/, (_, inner) => {
    const m = inner.match(/^(.*?)\s*\((.+)\)$/);
    if (m) { out.circle = m[1].trim(); out.artist = m[2].trim(); } else out.artist = inner.trim();
    return '';
  });
  for (;;) { // trailing [English] [Digital] [Decensored] …
    const m = s.match(/\s*\[([^\]]*)\]\s*$/);
    if (!m) break;
    if (LANGS.test(m[1]) && !out.language) out.language = m[1].split(/[ ,]/)[0];
    s = s.slice(0, m.index);
  }
  const pm = s.match(/\s*\(([^()]+)\)\s*$/);
  if (pm && !/digital|decensor|uncensor|^\d{4}$/i.test(pm[1])) { out.parody = pm[1].trim(); s = s.slice(0, pm.index); }
  out.title = s.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim() || raw;
  return out;
}

const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = new Set(a.split(' ')), tb = new Set(b.split(' '));
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return Math.min(1, hit / (ta.size + tb.size - hit) + (a.includes(b) || b.includes(a) ? 0.2 : 0));
}

// ---------- applying ----------

async function saveCover(gallery, seriesId) {
  const rel = gallery.cover?.path || gallery.thumbnail?.path;
  if (!rel) return false;
  try {
    const res = await fetch(`${await thumbServer()}/${rel}`, { headers: { 'User-Agent': UA } });
    if (!res.ok || !(res.headers.get('content-type') || '').startsWith('image/')) return false;
    await fs.writeFile(path.join(COVER_DIR, `${seriesId}.jpg`), Buffer.from(await res.arrayBuffer()));
    return true;
  } catch { return false; }
}

export async function applyGallery(seriesId, g, state) {
  const tags = (g.tags || []).map((t) => ({ type: t.type, name: t.name }));
  const names = (type) => tags.filter((t) => t.type === type).map((t) => t.name);
  const prev = db.prepare('SELECT nh_id FROM series WHERE id = ?').get(seriesId);
  const hasCover = await saveCover(g, seriesId);
  const dropCover = !hasCover && prev?.nh_id !== g.id;
  const year = g.upload_date ? new Date(g.upload_date * 1000).getUTCFullYear() : null;
  db.prepare(`UPDATE series SET nh_id = ?, nh_meta = ?, match_state = ?, title_english = ?, title_native = ?,
      genres = ?, authors = ?, year = ?, site_url = ?, has_cover = CASE WHEN ? THEN 1 WHEN ? THEN 0 ELSE has_cover END
    WHERE id = ?`).run(
    g.id, JSON.stringify({ tags, pages: g.num_pages, favorites: g.num_favorites, titles: g.title }), state,
    g.title?.pretty || g.title?.english || null, g.title?.japanese || null,
    JSON.stringify(names('tag')), JSON.stringify(names('artist')), year, `https://nhentai.net/g/${g.id}/`,
    hasCover ? 1 : 0, dropCover ? 1 : 0, seriesId,
  );
  applyOverrides(seriesId);
}

/** What we can say from the file name alone (used when nothing is found, or as a first pass). */
export function applyLocal(series, state = null) {
  const p = parseDoujinName(series.title);
  const tags = [];
  if (p.artist) tags.push({ type: 'artist', name: p.artist.toLowerCase() });
  if (p.circle) tags.push({ type: 'group', name: p.circle.toLowerCase() });
  if (p.parody) tags.push({ type: 'parody', name: p.parody.toLowerCase() });
  if (p.language) tags.push({ type: 'language', name: p.language.toLowerCase() });
  db.prepare(`UPDATE series SET title_english = ?, authors = ?, nh_meta = ?, match_state = COALESCE(?, match_state) WHERE id = ?`)
    .run(p.title, JSON.stringify(p.artist ? [p.artist.toLowerCase()] : []), JSON.stringify({ tags, local: true }), state, series.id);
  applyOverrides(series.id);
  return p;
}

/** Match one doujin series: explicit gallery number in the name, else a title search. */
export async function autoMatch(series) {
  const p = parseDoujinName(series.title);
  if (p.id) {
    const g = await getGallery(p.id);
    if (g) { await applyGallery(series.id, g, 'auto'); return true; }
  }
  const phrase = `"${p.title.replace(/"/g, '')}"`;
  let results = p.artist ? await search(`${phrase} artist:"${p.artist.replace(/"/g, '')}"`) : [];
  if (!results.length) results = await search(phrase);
  let best = null, bestScore = 0;
  for (const r of results) {
    const score = Math.max(similarity(p.title, r.title), similarity(p.title, r.japanese));
    if (score > bestScore) { best = r; bestScore = score; }
  }
  if (!best || bestScore < 0.5) { applyLocal(series, 'missing'); return false; }
  const g = await getGallery(best.id);
  if (!g) { applyLocal(series, 'missing'); return false; }
  await applyGallery(series.id, g, 'auto');
  return true;
}
