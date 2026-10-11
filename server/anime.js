import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { db, getSetting, setSetting } from './db.js';
import * as al from './anilist.js';
import { collectLibrary, collectOne, scanUnit, adoptAnimeRenames, showKey } from './animefiles.js';
import { ffInfo, ready as ffReady, probe as ffprobe, gate } from './ffmpeg.js';
import * as tc from './transcode.js';
import { relationsPass } from './relations.js';
import { titlesPass } from './eptitles.js';
import { reveal, isLocalRequest } from './reveal.js';

// ---------- scanning ----------

/** Scan the anime libraries (or one of them). Folders that cannot be read right now are left untouched. */
export async function scanAnime({ scope, inScope, unreadable, state }) {
  const libs = getSetting('anime_libraries', []).filter((l) => !scope || path.resolve(l) === scope);
  const units = [];
  const mine = [];
  for (const lib of libs) {
    try { units.push(...await collectLibrary(lib)); mine.push(lib); }
    catch { state.message += `Cannot read ${lib}. `; unreadable.push(lib); }
  }
  const out = { addedSeries: 0, removedSeries: 0, renamed: 0, addedEpisodes: 0, removedEpisodes: 0, movedProgress: 0, duplicateFiles: 0 };
  if (!libs.length) return out;
  const offline = (p) => unreadable.some((u) => p.startsWith(u + path.sep));
  out.renamed = adoptAnimeRenames(units, (p) => inScope(p) && !offline(p));
  state.total += units.length;
  const seen = new Set();
  for (const u of units) {
    const r = await scanUnit(u).catch((e) => { state.message += `${u.title}: ${e.message}. `; return null; });
    if (r) {
      seen.add(r.id);
      if (r.created) out.addedSeries++;
      out.addedEpisodes += r.added; out.removedEpisodes += r.removed; out.movedProgress += r.moved; out.duplicateFiles += r.dupes || 0;
    }
    state.done++;
  }
  for (const s of db.prepare("SELECT id, path FROM series WHERE kind = 'anime'").all()) {
    if (seen.has(s.id) || String(s.path).startsWith('anilist:') || !inScope(s.path) || offline(s.path)) continue;
    db.prepare('DELETE FROM series WHERE id = ?').run(s.id);
    out.removedSeries++;
  }
  return out;
}

export async function matchPendingAnime({ rematch, state }) {
  if (!getSetting('auto_match', true)) return;
  const pending = db.prepare(
    `SELECT id, title FROM series WHERE kind = 'anime' AND ${rematch ? "match_state != 'manual'" : "match_state = 'none'"}`,
  ).all();
  if (!pending.length) return;
  state.phase = 'matching'; state.done = 0; state.total = pending.length;
  for (const s of pending) {
    state.message = `Matching “${s.title}”`;
    try { await al.autoMatch(s, true); } catch (e) { state.error = `AniList: ${e.message}`; break; }
    state.done++;
  }
  if (!state.error) state.message = '';
}

// ---------- probing ----------

const failed = new Set();
let probing = false;

/** Read duration / tracks of new files in the background (the library is usable meanwhile). */
export async function probeMissing() {
  if (probing || !ffReady()) return;
  probing = true;
  try {
    const run = gate(2);
    const rows = db.prepare('SELECT id, path FROM episodes WHERE probe IS NULL').all().filter((r) => !failed.has(r.id));
    await Promise.all(rows.map((r) => run(async () => {
      try { await probeEpisode(r); } catch { failed.add(r.id); }
    })));
  } finally { probing = false; }
}

async function probeEpisode(ep) {
  const p = await ffprobe(ep.path);
  db.prepare('UPDATE episodes SET probe = ?, duration = ? WHERE id = ?').run(JSON.stringify(p), p.duration || null, ep.id);
  return p;
}

const parse = (s, d = []) => { try { return JSON.parse(s) ?? d; } catch { return d; } };

async function probeOf(ep) {
  if (ep.probe) { const p = parse(ep.probe, null); if (p) return p; }
  if (!ffReady()) throw Object.assign(new Error('ffmpeg is not available on this server, so this file cannot be read'), { status: 503 });
  try { return await probeEpisode(ep); }
  catch (e) { throw Object.assign(new Error(`Could not read this video: ${e.message}`), { status: 422 }); }
}

// ---------- one show, several folders ----------

const orderEps = (a, b) => (a.special - b.special) || ((a.season ?? 0) - (b.season ?? 0))
  || ((a.number ?? Infinity) - (b.number ?? Infinity)) || String(a.name).localeCompare(String(b.name), undefined, { numeric: true });

/** One copy of each episode out of a combined show: watched ones first, then the primary folder's, then the larger file. */
function dedupeEpisodes(list, primaryId) {
  const rank = (e) => ((e.completed || e.position > 0) ? 4 : 0) + (e.series_id === primaryId ? 2 : 0);
  const best = new Map();
  for (const e of list) {
    const k = e.move_to != null ? `m:${e.id}` : e.special || e.number == null ? `x:${e.name}:${e.size}` : `${e.season ?? 1}:${e.number}`;
    const cur = best.get(k);
    if (!cur || rank(e) > rank(cur) || (rank(e) === rank(cur) && (e.size || 0) > (cur.size || 0))) best.set(k, e);
  }
  return [...best.values()].sort(orderEps);
}

const EP_COLS = `e.id, e.series_id, e.move_to, e.name, e.ep_name, e.title, e.number, e.season, e.special, e.duration, e.size, p.position, p.completed, p.updated_at`;
// the series an episode is shown under: where you moved it, else the folder it was found in
const EP_SERIES = 'COALESCE((SELECT m.id FROM series m WHERE m.id = e.move_to), e.series_id)';
const EXTRA_FORMATS = new Set(['MOVIE', 'OVA', 'SPECIAL', 'MUSIC']);
// a short ONA (a couple of episodes) is an extra, not a season
const isExtraEntry = (format, total) => EXTRA_FORMATS.has(format) || (format === 'ONA' && total != null && total < 6);
const seasonLike = (format, total) => !isExtraEntry(format, total) && (!format || format === 'TV' || format === 'TV_SHORT' || format === 'ONA');
const epHome = (ep) => (ep.move_to && db.prepare('SELECT 1 FROM series WHERE id = ?').get(ep.move_to) ? ep.move_to : ep.series_id);

/** Episodes of a show: its own plus those of folders merged into it, de-duplicated. */
export function groupEpisodes(primaryId) {
  const rows = db.prepare(`SELECT ${EP_COLS} FROM episodes e JOIN series s ON s.id = ${EP_SERIES}
    LEFT JOIN episode_progress p ON p.episode_id = e.id WHERE s.id = ? OR s.merged_into = ?`).all(primaryId, primaryId);
  return dedupeEpisodes(rows, primaryId);
}

export const primaryOf = (seriesId) => db.prepare('SELECT COALESCE(merged_into, id) AS id FROM series WHERE id = ?').get(seriesId)?.id ?? seriesId;

/**
 * Series that matched the same AniList entry are one show kept in several folders (two releases, a loose
 * batch next to a Season folder…): show them as one. The folders stay separate on disk and in the database;
 * "Split apart" on the series page undoes it.
 */
/**
 * AniList often has ONE entry for a whole show (Cardcaptor Sakura: 70 episodes) while the files are in
 * "Season 1/2/3" folders, so the later seasons never match anything. When a "… Season N" folder has no
 * match and its first season is matched to an entry big enough to hold them all, it joins that entry
 * (and is then combined with it by the merge below, keeping S1/S2/S3).
 */
export function attachSeasons() {
  const rows = db.prepare("SELECT id, title, anilist_id, chapters_total, match_state, merged_into, merge_lock FROM series WHERE kind = 'anime'").all();
  const cnt = db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE series_id = ?');
  const keyed = rows.map((r) => ({ ...r, ...showKey(r.title) }));
  const bases = keyed.filter((r) => r.anilist_id && (r.season ?? 1) === 1 && r.merged_into == null);
  for (const o of keyed) {
    if (o.anilist_id || o.match_state === 'manual' || o.merge_lock || !o.season || o.season < 2 || !o.key) continue;
    const base = bases.find((b) => b.key === o.key && b.id !== o.id && b.chapters_total);
    if (!base) continue;
    const used = groupEpisodes(base.id).length;
    if (used + cnt.get(o.id).n > base.chapters_total) continue; // that entry is just the first season
    db.prepare("UPDATE series SET anilist_id = ?, match_state = 'auto', meta_source = 'anilist' WHERE id = ?").run(base.anilist_id, o.id);
    o.anilist_id = base.anilist_id;
  }
}

export function mergePass() {
  attachSeasons();
  const rows = db.prepare("SELECT id, anilist_id, merged_into, merge_lock FROM series WHERE kind = 'anime'").all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const set = db.prepare('UPDATE series SET merged_into = ? WHERE id = ?');
  for (const r of rows) { // forget merges that no longer hold
    if (r.merged_into == null) continue;
    const p = byId.get(r.merged_into);
    if (!p || p.merged_into != null || r.anilist_id == null || p.anilist_id !== r.anilist_id || r.merge_lock) { set.run(null, r.id); r.merged_into = null; }
  }
  const groups = new Map();
  for (const r of rows) {
    if (r.anilist_id == null || r.merge_lock) continue;
    if (!groups.has(r.anilist_id)) groups.set(r.anilist_id, []);
    groups.get(r.anilist_id).push(r);
  }
  const count = db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE series_id = ?');
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    // keep the current primary when there is one, otherwise the folder with the most episodes
    let primary = members.find((m) => m.merged_into == null && members.some((o) => o.merged_into === m.id));
    primary ||= [...members].sort((a, b) => count.get(b.id).n - count.get(a.id).n || a.id - b.id)[0];
    for (const m of members) {
      const want = m.id === primary.id ? null : primary.id;
      if ((m.merged_into ?? null) !== want) set.run(want, m.id);
    }
  }
}

/** Fill in the season (Winter 2012…) and tags of matched anime that do not have them yet. */
let facetsRunning = false;
export async function facetsPass() {
  if (facetsRunning) return;
  facetsRunning = true;
  try {
    // anime: season + tags + alternative titles; manga: alternative titles (used to link doujin and sequels by name)
    const all = db.prepare(`SELECT id, kind, anilist_id FROM series WHERE kind IN ('anime', 'manga') AND anilist_id IS NOT NULL
      AND (synonyms IS NULL OR tags IS NULL OR (kind = 'anime' AND facets_checked IS NULL))`).all();
    const updAnime = db.prepare('UPDATE series SET air_season = ?, air_year = ?, tags = ?, synonyms = ?, facets_checked = ? WHERE id = ?');
    const updManga = db.prepare('UPDATE series SET synonyms = ?, tags = ? WHERE id = ?');
    for (const kind of ['anime', 'manga']) {
      const rows = all.filter((r) => r.kind === kind);
      const ids = [...new Set(rows.map((r) => r.anilist_id))];
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        let list;
        try { list = await al.getFacets(chunk, kind === 'anime' ? 'ANIME' : 'MANGA'); } catch { return; } // offline: try again at the next scan
        const byId = new Map(list.map((m) => [m.id, m]));
        for (const r of rows) {
          if (!chunk.includes(r.anilist_id)) continue;
          const m = byId.get(r.anilist_id);
          const syn = JSON.stringify(m?.synonyms || []);
          if (kind === 'manga') { updManga.run(syn, JSON.stringify(m ? al.tagsOf(m) : []), r.id); continue; }
          const a = m ? al.airOf(m) : { season: null, year: null };
          updAnime.run(a.season, a.year, JSON.stringify(m ? al.tagsOf(m) : []), syn, Date.now(), r.id);
        }
      }
    }
  } finally { facetsRunning = false; }
}

// ---------- AniList franchise cache: seasons you do not have, so numbers stay right ----------

const TV_LIKE = new Set(['TV', 'TV_SHORT', 'ONA']);
const isSeasonFmt = (f) => !f || TV_LIKE.has(f);
const SEASON_MONTH = { WINTER: 0, SPRING: 3, SUMMER: 6, FALL: 9 };
let alCache = null;
function alMedia() {
  if (!alCache) {
    alCache = new Map();
    for (const r of db.prepare('SELECT anilist_id, json FROM al_media').all()) {
      try { alCache.set(r.anilist_id, JSON.parse(r.json)); } catch { /* skip */ }
    }
  }
  return alCache;
}
const dateKey = (m) => {
  if (m.startDate?.year) return m.startDate.year * 12 + ((m.startDate.month || 1) - 1);
  if (m.seasonYear) return m.seasonYear * 12 + (SEASON_MONTH[m.season] ?? 0);
  return null;
};
const plainDesc = (t) => String(t || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 420);

/**
 * Every season of the shows you have, found through AniList's sequel / alternative links (including the ones you
 * do not own), so "S7" stays S7 and the missing ones can be listed with their own info. Cached for 30 days.
 */
let franchiseRunning = false;
export async function franchisePass() {
  if (franchiseRunning) return;
  franchiseRunning = true;
  try {
    if (!getSetting('auto_match', true)) return;
    const withAlt = getSetting('anime_group_alt', true);
    const cache = alMedia();
    const owned = new Map(db.prepare("SELECT anilist_id, rel_json FROM series WHERE kind = 'anime' AND anilist_id IS NOT NULL").all().map((r) => [r.anilist_id, r]));
    const edgesOfOwned = (r) => { try { return JSON.parse(r.rel_json || '[]') || []; } catch { return []; } };
    const follow = (e) => e.type === 'ANIME' && (e.rel === 'SEQUEL' || e.rel === 'PREQUEL' || (withAlt && e.rel === 'ALTERNATIVE' && isSeasonFmt(e.fmt)));
    const seen = new Set(), visit = [], need = [];
    const push = (id) => { if (!seen.has(id)) { seen.add(id); visit.push(id); } };
    for (const id of owned.keys()) { seen.add(id); visit.push(id); }
    const stale = Date.now() - 30 * 24 * 3600 * 1000;
    const store = db.prepare('INSERT INTO al_media (anilist_id, json, fetched) VALUES (?, ?, ?) ON CONFLICT(anilist_id) DO UPDATE SET json = excluded.json, fetched = excluded.fetched');
    let fetched = 0;
    for (;;) {
      while (visit.length) {
        const id = visit.shift();
        const o = owned.get(id);
        if (o) { for (const e of edgesOfOwned(o)) if (follow(e)) push(e.id); continue; }
        const m = cache.get(id);
        if (m && m.fetched > stale) { for (const e of m.edges) if (follow(e)) push(e.id); } else need.push(id);
      }
      if (!need.length || fetched >= 150) break;
      const batch = need.splice(0, 25);
      fetched += batch.length;
      let list;
      try { list = await al.getMediaBatch(batch); } catch { break; } // offline / rate limit: next scan
      const got = new Set();
      for (const m of list) {
        got.add(m.id);
        const rec = {
          id: m.id, format: m.format, status: m.status, episodes: m.episodes, season: m.season, seasonYear: m.seasonYear,
          startDate: m.startDate, title: m.title?.english || m.title?.romaji || '', cover: m.coverImage?.large || null,
          description: plainDesc(m.description), fetched: Date.now(),
          edges: (m.relations?.edges || []).map((e) => ({
            id: e.node.id, type: e.node.type, rel: e.relationType, fmt: e.node.format || null,
            title: e.node.title?.english || e.node.title?.romaji || null, cover: e.node.coverImage?.medium || null,
          })),
        };
        store.run(m.id, JSON.stringify(rec), rec.fetched);
        cache.set(m.id, rec);
        for (const e of rec.edges) if (follow(e)) push(e.id);
      }
      for (const id of batch) if (!got.has(id)) cache.set(id, { id, format: null, edges: [], fetched: Date.now() }); // gone from AniList
    }
  } finally { franchiseRunning = false; }
}

/**
 * Number the TV-like entries of a franchise by air date, owned or not: { rank: Map(anilist id -> n), ghosts: [...] }.
 * null when something is still unknown (not fetched yet), so the plain numbering stays.
 */
function franchiseRanks(chainRows, ownedByAl, withAlt) {
  const cache = alMedia();
  const edgesFor = (aid) => {
    const o = ownedByAl.get(aid);
    if (o) { try { return JSON.parse(o.rel_json || '[]') || []; } catch { return []; } }
    return cache.get(aid)?.edges || [];
  };
  const seen = new Set(), queue = [];
  for (const r of chainRows) if (r.anilist_id && !seen.has(r.anilist_id)) { seen.add(r.anilist_id); queue.push(r.anilist_id); }
  while (queue.length) {
    for (const e of edgesFor(queue.shift())) {
      if (e.type !== 'ANIME' || seen.has(e.id)) continue;
      const ok = e.rel === 'SEQUEL' || e.rel === 'PREQUEL' || (withAlt && e.rel === 'ALTERNATIVE' && isSeasonFmt(e.fmt));
      if (ok) { seen.add(e.id); queue.push(e.id); }
    }
  }
  const list = [];
  for (const aid of seen) {
    const o = ownedByAl.get(aid);
    if (o) {
      if (!seasonLike(o.format, o.chapters_total)) continue;
      list.push({ aid, key: o.air_year ? o.air_year * 12 + (SEASON_MONTH[o.air_season] ?? 0) : null, own: true });
      continue;
    }
    const m = cache.get(aid);
    if (!m) return null;
    if (!seasonLike(m.format, m.episodes)) continue;
    list.push({ aid, key: dateKey(m), m });
  }
  if (!list.length || list.some((x) => x.key == null)) return null;
  list.sort((a, b) => a.key - b.key || a.aid - b.aid);
  const rank = new Map(), ghosts = [];
  list.forEach((x, i) => {
    rank.set(x.aid, i + 1);
    if (!x.own) ghosts.push({ anilistId: x.aid, rank: i + 1, m: x.m });
  });
  return { rank, ghosts };
}

const NAME_STOP = new Set(['season', 'part', 'movie', 'final', 'specials', 'special', 'tv', 'anime', 'series', 'story', 'chapter', 'the', 'and']);
/** A name for a franchise made of differently-titled series: the word most of them share ("Precure"). */
function commonName(titles) {
  const n = titles.length;
  if (n < 3) return null;
  const df = new Map();
  for (const t of titles) {
    const toks = new Set(String(t || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ')
      .filter((w) => w.length >= 4 && !NAME_STOP.has(w) && !/^\d+$/.test(w)));
    for (const w of toks) df.set(w, (df.get(w) || 0) + 1);
  }
  let best = null;
  for (const [w, c] of df) if (c >= Math.ceil(n * 0.6) && (!best || c > best[1] || (c === best[1] && w.length > best[0].length))) best = [w, c];
  return best ? best[0].charAt(0).toUpperCase() + best[0].slice(1) : null;
}

// ---------- seasons: sequels of a show shown under its first season ----------

/**
 * AniList lists a show's seasons as separate entries joined by SEQUEL / PREQUEL. Entries that are in the
 * library are chained: the first one is the "root", later ones are its seasons (S1, S2, … / Movie / OVA).
 */
export function franchises() {
  const none = { rootOf: new Map(), chains: new Map(), labels: new Map(), ranks: new Map(), ghosts: new Map(), altRoots: new Set(), names: new Map() };
  const auto = getSetting('anime_group_seasons', true);
  const rows = db.prepare("SELECT id, title, title_english, title_romaji, anilist_id, format, chapters_total, year, air_season, air_year, rel_json, parent_id, season_label, show_title FROM series WHERE kind = 'anime' AND merged_into IS NULL").all();
  if (!auto && !rows.some((r) => r.parent_id)) return none;
  const byAl = new Map(rows.filter((r) => r.anilist_id).map((r) => [r.anilist_id, r]));
  const prev = new Map();
  const edgesOf = (r) => { try { return JSON.parse(r.rel_json || '[]') || []; } catch { return []; } };
  if (auto) {
    // sequel graph over AniList ids: an entry you do not own (an ONA, a recap) can sit between two seasons you do
    const after = new Map();
    const addAfter = (a, b) => { if (!after.has(a)) after.set(a, new Set()); after.get(a).add(b); };
    for (const r of rows) {
      if (!r.anilist_id) continue;
      for (const e of edgesOf(r)) {
        if (e.type !== 'ANIME') continue;
        if (e.rel === 'SEQUEL') addAfter(r.anilist_id, e.id);
        else if (e.rel === 'PREQUEL') addAfter(e.id, r.anilist_id);
      }
    }
    for (const r of rows) {
      if (!r.anilist_id) continue;
      const seen = new Set([r.anilist_id]);
      const queue = [r.anilist_id];
      while (queue.length) {
        const n = queue.shift();
        for (const m of after.get(n) || []) {
          if (seen.has(m)) continue;
          seen.add(m);
          const o = byAl.get(m);
          if (o) { if (o.id !== r.id && !prev.has(o.id)) prev.set(o.id, r.id); } else queue.push(m);
        }
      }
    }
  }
  // movies, OVAs and specials that AniList files under a show (side story, spin-off, summary…) sit with its seasons
  if (auto) {
    const SIDE = new Set(['SIDE_STORY', 'PARENT', 'SPIN_OFF', 'ALTERNATIVE', 'SUMMARY', 'COMPILATION', 'CONTAINS', 'OTHER']);
    const near = new Map();
    const add = (x, y) => { if (!near.has(x)) near.set(x, new Set()); near.get(x).add(y); };
    for (const r of rows) {
      let edges = [];
      try { edges = JSON.parse(r.rel_json || '[]') || []; } catch { /* ignore */ }
      for (const e of edges) {
        if (e.type !== 'ANIME' || !SIDE.has(e.rel)) continue;
        const o = byAl.get(e.id);
        if (o && o.id !== r.id) { add(r.id, o.id); add(o.id, r.id); }
      }
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const r of rows) {
      if (prev.has(r.id) || !isExtraEntry(r.format, r.chapters_total)) continue;
      const cands = [...(near.get(r.id) || [])].map((id) => byId.get(id)).filter((o) => o && !isExtraEntry(o.format, o.chapters_total));
      if (!cands.length) continue;
      cands.sort((a, b) => Math.abs((a.year || 0) - (r.year || 0)) - Math.abs((b.year || 0) - (r.year || 0)) || a.id - b.id);
      prev.set(r.id, cands[0].id); // the target is a TV entry, so it never has this extra above it: no loop
    }
  }
  const tvLike = (r) => !r.format || r.format === 'TV' || r.format === 'TV_SHORT';
  const altMain = new Set();
  // separate series AniList calls alternatives of each other (Precure, Fate…) become one show, first entry on top
  if (auto && getSetting('anime_group_alt', true)) {
    const up = new Map(rows.map((r) => [r.id, r.id]));
    const find = (x) => { while (up.get(x) !== x) { up.set(x, up.get(up.get(x))); x = up.get(x); } return x; };
    for (const r of rows) {
      if (!tvLike(r)) continue;
      for (const e of edgesOf(r)) {
        const o = e.type === 'ANIME' && e.rel === 'ALTERNATIVE' ? byAl.get(e.id) : null;
        if (o && o.id !== r.id && tvLike(o)) up.set(find(r.id), find(o.id));
      }
    }
    const top = (id) => { let x = id; for (let n = 0; prev.has(x) && n < 60; n++) x = prev.get(x); return x; };
    const comps = new Map();
    for (const r of rows) {
      if (!tvLike(r)) continue;
      const k = find(r.id);
      if (!comps.has(k)) comps.set(k, new Set());
      comps.get(k).add(top(r.id));
    }
    const yr = new Map(rows.map((r) => [r.id, r.year || 9999]));
    for (const tops of comps.values()) {
      if (tops.size < 2) continue;
      const [main, ...rest] = [...tops].sort((a, b) => yr.get(a) - yr.get(b) || a - b);
      for (const t of rest) if (!prev.has(t)) prev.set(t, main);
      altMain.add(main);
    }
  }
  // "Oreimo 2", "Show Season 3", "Show II" go under "Oreimo" / "Show" when AniList does not link them
  if (auto) {
    const MARK = /\s+(?:season\s*)?(\d{1,2})$|\s+(\d{1,2})(?:st|nd|rd|th)\s+season$|\s+(ii|iii|iv|v)$/i;
    const clean = (t) => String(t || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const namesOf = (r) => [r.title_english, r.title_romaji, r.title].filter(Boolean).map(clean);
    const plain = new Map();
    for (const r of rows) {
      if (!tvLike(r)) continue;
      for (const n of namesOf(r)) if (!MARK.test(n) && n.length >= 3 && !plain.has(n)) plain.set(n, r);
    }
    for (const r of rows) {
      if (prev.has(r.id) || !tvLike(r)) continue;
      for (const n of namesOf(r)) {
        const m = n.match(MARK);
        if (!m || m[1] === '1' || m[2] === '1') continue;
        const o = plain.get(n.replace(MARK, '').trim());
        if (o && o.id !== r.id && !prev.has(o.id) && (o.year || 0) <= (r.year || 9999)) { prev.set(r.id, o.id); break; }
      }
    }
  }
  // by hand: "this is a season of …" beats what AniList says; parent 0 keeps a show on its own
  const redirect = new Map(db.prepare("SELECT id, merged_into FROM series WHERE kind = 'anime' AND merged_into IS NOT NULL").all().map((r) => [r.id, r.merged_into]));
  const here = new Set(rows.map((r) => r.id));
  for (const r of rows) if (r.parent_id === 0) prev.delete(r.id);
  for (const r of rows) {
    if (!r.parent_id) continue;
    const pid = redirect.get(r.parent_id) ?? r.parent_id;
    if (pid === r.id || !here.has(pid)) continue;
    let p = pid, loop = false;
    for (let n = 0; p != null && n < 60; n++) { if (p === r.id) { loop = true; break; } p = prev.get(p); }
    if (!loop) prev.set(r.id, pid);
  }
  const kids = new Map();
  for (const [c, p] of prev) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(c); }
  const info = new Map(rows.map((r) => [r.id, r]));
  const out = { rootOf: new Map(), chains: new Map(), labels: new Map(), ranks: new Map(), ghosts: new Map(), altRoots: altMain, names: new Map() };
  const ownedByAl = new Map(rows.filter((r) => r.anilist_id).map((r) => [r.anilist_id, r]));
  const withAlt = auto && getSetting('anime_group_alt', true);
  for (const r of rows) {
    if (prev.has(r.id) || !kids.has(r.id)) continue; // not a first season, or a show with no other seasons here
    const chain = [], seen = new Set();
    const visit = (id) => {
      if (seen.has(id)) return;
      seen.add(id); chain.push(id);
      for (const k of (kids.get(id) || []).sort((a, b) => (info.get(a).year || 9999) - (info.get(b).year || 9999) || a - b)) visit(k);
    };
    visit(r.id);
    if (chain.length < 2) continue;
    out.chains.set(r.id, chain);
    let season = 0;
    const counters = {};
    for (const id of chain) {
      const f = info.get(id).format;
      let label;
      if (seasonLike(f, info.get(id).chapters_total)) label = `S${++season}`;
      else {
        const name = f === 'MOVIE' ? 'Movie' : f === 'OVA' ? 'OVA' : f === 'SPECIAL' ? 'Special' : f === 'MUSIC' ? 'Music' : f;
        counters[name] = (counters[name] || 0) + 1;
        label = name;
      }
      out.labels.set(id, label);
      if (id !== r.id) out.rootOf.set(id, r.id);
    }
    // number repeated kinds: Movie 1, Movie 2
    for (const [name, n] of Object.entries(counters)) {
      if (n < 2) continue;
      let i = 0;
      for (const id of chain) if (out.labels.get(id) === name) out.labels.set(id, `${name} ${++i}`);
    }
    // numbers as AniList counts them, counting the seasons you do not own, so S7 stays S7
    const fm = franchiseRanks(chain.map((id) => info.get(id)), ownedByAl, withAlt);
    if (fm) {
      for (const id of chain) {
        const row = info.get(id);
        const n = fm.rank.get(row.anilist_id);
        if (n && seasonLike(row.format, row.chapters_total)) { out.labels.set(id, `S${n}`); out.ranks.set(id, n); }
      }
      out.ghosts.set(r.id, fm.ghosts);
    }
    // name of the whole show: yours, else the shared word of different titles (Precure), else the first entry
    const rootRow = info.get(r.id);
    let name = rootRow.show_title || null;
    if (!name && altMain.has(r.id)) {
      const titles = [...chain.map((id) => { const x = info.get(id); return x.title_english || x.title_romaji || x.title; }), ...(fm?.ghosts || []).map((g) => g.m.title)];
      name = commonName(titles);
    }
    if (name) out.names.set(r.id, name);
    for (const id of chain) if (info.get(id).season_label) out.labels.set(id, info.get(id).season_label); // named by hand
  }
  return out;
}

const SEASON_NO = { WINTER: 0, SPRING: 1, SUMMER: 2, FALL: 3 };

const titlesOf = (seriesId) => {
  try { return JSON.parse(db.prepare('SELECT ep_titles FROM series WHERE id = ?').get(seriesId)?.ep_titles || '{}') || {}; } catch { return {}; }
};
/**
 * When one AniList entry holds several seasons (S1 ends at 35, S2 starts again at 1), online lists and AniList
 * count straight through: S2 ep 1 is #36. Offsets per season, or null when the list has one season only.
 */
function seasonOffsets(list) {
  const max = new Map();
  for (const e of list) {
    if (e.special || e.number == null || e.move_to != null) continue;
    const s = e.season ?? 1;
    max.set(s, Math.max(max.get(s) || 0, Math.floor(e.number)));
  }
  if (max.size < 2) return null;
  const off = new Map();
  let acc = 0;
  for (const s of [...max.keys()].sort((a, b) => a - b)) { off.set(s, acc); acc += max.get(s); }
  return off;
}
const absNumber = (e, off) => (e.number == null ? null : e.number + (e.move_to != null ? 0 : (off?.get(e.season ?? 1) ?? 0)));

/** Title of an episode: from the online list (by its number in the entry), else from the file name. */
const nameOf = (e, titles, off = null) => {
  if (!e.special && e.number != null && e.move_to == null) {
    const t = titles[String(absNumber(e, off))];
    if (t) return t;
  }
  return e.ep_name || null;
};

const MISS_LABEL = { SEQUEL: 'Sequel', PREQUEL: 'Prequel', SIDE_STORY: 'Side story', SPIN_OFF: 'Spin-off', SUMMARY: 'Summary', COMPILATION: 'Compilation' };

/** Seasons / movies of a show that AniList knows and the library does not. */
function missingCards(memberRows, fr, rootId) {
  const owned = new Set(db.prepare("SELECT anilist_id FROM series WHERE kind = 'anime' AND anilist_id IS NOT NULL").all().map((r) => r.anilist_id));
  const out = [], seenIds = new Set();
  for (const g of fr.ghosts.get(rootId) || []) {
    seenIds.add(g.anilistId);
    out.push({
      anilistId: g.anilistId, title: g.m.title, format: g.m.format || null, rank: g.rank, label: `S${g.rank}`, rel: 'SEQUEL',
      cover: g.m.cover || null, url: `https://anilist.co/anime/${g.anilistId}`, extra: false,
      airSeason: g.m.season || null, airYear: g.m.seasonYear || g.m.startDate?.year || null, episodes: g.m.episodes ?? null, description: g.m.description || '',
    });
  }
  for (const m of memberRows) {
    let edges = [];
    try { edges = JSON.parse(m.rel_json || '[]') || []; } catch { /* none */ }
    for (const e of edges) {
      if (e.type !== 'ANIME' || !e.title || !MISS_LABEL[e.rel] || owned.has(e.id) || seenIds.has(e.id)) continue;
      seenIds.add(e.id);
      const cached = alMedia().get(e.id);
      out.push({
        anilistId: e.id, title: e.title, format: e.fmt || null, rank: null, rel: e.rel, label: MISS_LABEL[e.rel], cover: e.cover || null,
        url: `https://anilist.co/anime/${e.id}`, extra: (e.rel !== 'SEQUEL' && e.rel !== 'PREQUEL') || isExtraEntry(e.fmt, cached?.episodes),
        airSeason: cached?.season || null, airYear: cached?.seasonYear || cached?.startDate?.year || null, episodes: cached?.episodes ?? null,
        description: cached?.description || '',
      });
    }
  }
  return out;
}

/** One card per entry of a show: label, poster id, progress… */
function seasonCards(chainIds, fr, rootId, currentId, curEps) {
  const rows = db.prepare(`SELECT * FROM series WHERE id IN (${chainIds.map(() => '?').join(',')})`).all(...chainIds);
  return chainIds.map((id) => {
    const r = rows.find((x) => x.id === id);
    const list = id === currentId && curEps ? curEps : groupEpisodes(id);
    return {
      id, label: fr.labels.get(id), rank: fr.ranks.get(id) ?? null, title: r ? (r.title_english || r.title_romaji || r.title) : '', year: r?.year ?? null,
      current: id === currentId, root: id === rootId, manual: !!r?.parent_id && id !== rootId, customLabel: !!r?.season_label,
      format: r?.format ?? null, extra: isExtraEntry(r?.format, r?.chapters_total), status: r?.status ?? null, airSeason: r?.air_season ?? null, airYear: r?.air_year ?? null,
      description: (r?.description || '').slice(0, 420), total: r?.chapters_total ?? null,
      episodes: list.length, watched: list.filter((e) => e.completed).length, anilistId: r?.anilist_id ?? null,
    };
  });
}

// ---------- routes ----------

export function mountAnime(app, { wrap, seriesDto, runScan, scanState }) {
  const epRow = (id) => db.prepare('SELECT * FROM episodes WHERE id = ?').get(id);
  const need = (req, res) => {
    const ep = epRow(Number(req.params.id));
    if (!ep) { res.status(404).json({ error: 'Episode not found' }); return null; }
    return ep;
  };
  const needFf = (res) => {
    if (ffReady()) return true;
    res.status(503).json({ error: 'ffmpeg is not installed on this server, so videos that need converting cannot be played.' });
    return false;
  };
  const animeSeries = (id) => db.prepare("SELECT * FROM series WHERE id = ? AND kind = 'anime'").get(id);

  app.get('/api/anime/status', (req, res) => {
    const f = ffInfo();
    res.json({
      libraries: getSetting('anime_libraries', []),
      ffmpeg: { ready: ffReady(), version: f.version, libass: f.libass, encoders: f.encoders },
      encoder: getSetting('anime_encoder', 'libx264'),
      groupSeasons: getSetting('anime_group_seasons', true),
      groupAlt: getSetting('anime_group_alt', true),
      count: db.prepare("SELECT COUNT(*) AS n FROM series WHERE kind = 'anime'").get().n,
    });
  });

  app.put('/api/anime/settings', (req, res) => {
    if ('groupSeasons' in (req.body || {})) setSetting('anime_group_seasons', !!req.body.groupSeasons);
    if ('groupAlt' in (req.body || {})) setSetting('anime_group_alt', !!req.body.groupAlt);
    const enc = req.body?.encoder;
    if (enc !== undefined) {
      if (!['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox'].includes(enc)) return res.status(400).json({ error: 'Unknown encoder' });
      setSetting('anime_encoder', enc);
    }
    res.json({ ok: true });
  });

  // libraries (folders of their own, separate from manga and doujin)
  app.post('/api/anime/libraries', wrap(async (req, res) => {
    const raw = String(req.body?.path || '').trim().replace(/^"|"$/g, '');
    if (!raw) return res.status(400).json({ error: 'Enter a folder path' });
    const p = path.resolve(raw);
    const st = await fsp.stat(p).catch(() => null);
    if (!st?.isDirectory()) return res.status(400).json({ error: `Folder not found: ${p}` });
    const other = [...getSetting('libraries', []), ...getSetting('doujin_libraries', []), ...getSetting('novel_libraries', [])].map((x) => path.resolve(x));
    if (other.includes(p)) return res.status(400).json({ error: 'That folder is already a manga or doujin library' });
    const libs = getSetting('anime_libraries', []);
    if (!libs.includes(p)) setSetting('anime_libraries', [...libs, p]);
    runScan();
    res.json(getSetting('anime_libraries', []));
  }));

  app.delete('/api/anime/libraries', (req, res) => {
    setSetting('anime_libraries', getSetting('anime_libraries', []).filter((l) => l !== req.body?.path));
    runScan();
    res.json(getSetting('anime_libraries', []));
  });

  // library + continue watching
  app.get('/api/anime/library', (req, res) => {
    const fr = franchises();
    const rows = db.prepare(`SELECT s.* FROM series s WHERE s.kind = 'anime' AND s.merged_into IS NULL
      ORDER BY LOWER(COALESCE(s.title_english, s.title_romaji, s.title))`).all();
    const rowById = new Map(rows.map((r) => [r.id, r]));
    const all = db.prepare(`SELECT ${EP_COLS}, COALESCE(s.merged_into, s.id) AS grp FROM episodes e JOIN series s ON s.id = ${EP_SERIES}
      LEFT JOIN episode_progress p ON p.episode_id = e.id WHERE s.kind = 'anime'`).all();
    const byGroup = new Map();
    for (const e of all) { if (!byGroup.has(e.grp)) byGroup.set(e.grp, []); byGroup.get(e.grp).push(e); }
    res.json(rows.filter((s) => !fr.rootOf.has(s.id)).map((s) => {
      const chain = fr.chains.get(s.id) || [s.id];
      let count = 0, done = 0, last = 0;
      for (const id of chain) {
        const eps = dedupeEpisodes(byGroup.get(id) || [], id);
        count += eps.length;
        done += eps.filter((e) => e.completed).length;
        last = eps.reduce((m, e) => Math.max(m, e.updated_at || 0), last);
      }
      const members = chain.map((id) => rowById.get(id)).filter(Boolean);
      const extraCount = members.filter((r) => r.id !== s.id && isExtraEntry(r.format, r.chapters_total)).length;
      const mainCount = chain.length - extraCount;
      const airs = [...new Set(members.filter((r) => r.air_season && r.air_year).map((r) => `${r.air_year} ${r.air_season}`))];
      const union = (f) => [...new Set(members.flatMap((r) => { try { return JSON.parse(r[f] || '[]') || []; } catch { return []; } }))];
      const studios = [...new Set(members.flatMap((r) => {
        let a = [];
        try { a = JSON.parse(r.authors || '[]') || []; } catch { /* none */ }
        return a.filter((n) => /\(Studio\)$/i.test(n)).map((n) => n.replace(/\s*\(Studio\)$/i, ''));
      }))];
      return {
        ...seriesDto(s), genres: union('genres'), tags: union('tags'), airs, studios,
        formats: [...new Set(members.map((r) => r.format).filter(Boolean))],
        statuses: [...new Set(members.map((r) => r.status).filter(Boolean))],
        ...(chain.length > 1 && fr.names.get(s.id) ? { title: fr.names.get(s.id) } : {}),
        airKey: s.air_year ? s.air_year * 4 + (SEASON_NO[s.air_season] ?? 0) : null,
        chapterCount: count, readCount: done, lastRead: last || null, addedAt: s.added_at,
        seasons: mainCount > 1 ? mainCount : null, extras: extraCount || null,
        memberTitles: chain.slice(1).map((id) => { const r = rowById.get(id); return r ? (r.title_english || r.title_romaji || r.title) : ''; }),
      };
    }));
  });

  app.get('/api/anime/continue', (req, res) => {
    const recent = db.prepare(`
      SELECT e.id AS ep_id, e.series_id, e.title AS ep_title, e.number, e.season, p.position, p.duration, p.completed, p.updated_at, COALESCE(s.merged_into, s.id) AS grp
      FROM episode_progress p JOIN episodes e ON e.id = p.episode_id JOIN series s ON s.id = ${EP_SERIES}
      WHERE s.kind = 'anime' AND (p.completed = 1 OR p.position > 5) ORDER BY p.updated_at DESC LIMIT 200`).all();
    const seen = new Set(), out = [];
    const fr = franchises();
    const hidden = getSetting('continue_hidden', {});
    for (const r of recent) {
      const show = fr.rootOf.get(r.grp) ?? r.grp; // the seasons of one show share a card
      if (seen.has(show)) continue;
      seen.add(show);
      if ((hidden[`a:${show}`] || 0) >= r.updated_at) continue;
      const s = db.prepare('SELECT id, title, title_english, title_romaji FROM series WHERE id = ?').get(r.grp);
      if (!s) continue;
      let id = r.ep_id, title = r.ep_title, position = r.position, fraction = r.duration ? r.position / r.duration : 0;
      const last = r.completed ? { id: r.ep_id, title: r.ep_title } : null;
      if (r.completed) { // jump to the next episode of the show
        const list = groupEpisodes(r.grp);
        let i = list.findIndex((e) => e.id === r.ep_id);
        if (i < 0) i = list.findIndex((e) => (e.season ?? 1) === (r.season ?? 1) && e.number === r.number);
        // the next one you have not watched yet (marking a whole show watched leaves every episode "just finished")
        let k = i + 1;
        while (i >= 0 && list[k] && list[k].completed) k++;
        const next = i >= 0 ? list[k] : null;
        if (!next) continue;
        id = next.id; title = next.title; position = 0; fraction = 0;
      }
      const nm = (() => {
        const row = db.prepare('SELECT number, season, special, ep_name, move_to FROM episodes WHERE id = ?').get(id);
        const gl = groupEpisodes(r.grp);
        return row ? nameOf(row, titlesOf(r.grp), seasonOffsets(gl)) : null;
      })();
      out.push({
        seriesId: s.id, showId: show, title: s.title_english || s.title_romaji || s.title, episodeId: id, epTitle: title,
        episodeTitle: nm ? `${title} · ${nm}` : title, position, fraction, last,
      });
      if (out.length >= 12) break;
    }
    res.json(out);
  });

  app.get('/api/anime/series/:id', (req, res) => {
    const s = animeSeries(Number(req.params.id));
    if (!s) return res.status(404).json({ error: 'Not found' });
    if (s.merged_into) return res.json({ mergedInto: s.merged_into });
    const eps = groupEpisodes(s.id);
    const titles = titlesOf(s.id);
    const offs = seasonOffsets(eps);
    const fr = franchises();
    const rootId = fr.rootOf.get(s.id) ?? s.id;
    const chainIds = fr.chains.get(rootId);
    const seasons = chainIds ? db.prepare(`SELECT * FROM series WHERE id IN (${chainIds.map(() => '?').join(',')})`)
      .all(...chainIds) : [];
    const rootRow = chainIds ? seasons.find((x) => x.id === rootId) : null;
    let sections = [];
    try { sections = JSON.parse(s.sections || '[]') || []; } catch { /* none */ }
    const missing = missingCards(chainIds ? seasons : [s], fr, rootId);
    const sources = db.prepare('SELECT id, title, path FROM series WHERE merged_into = ?').all(s.id)
      .map((r) => ({ id: r.id, folderName: r.title, path: r.path }));
    res.json({
      ...seriesDto(s), sources, sections, virtual: String(s.path).startsWith('anilist:'),
      parentId: s.parent_id ?? null, seasonLabel: s.season_label,
      show: { id: rootId, title: fr.names.get(rootId) || (rootRow ? (rootRow.title_english || rootRow.title_romaji || rootRow.title) : (s.title_english || s.title_romaji || s.title)), named: !!rootRow?.show_title },
      missing,
      seasons: chainIds ? seasonCards(chainIds, fr, rootId, s.id, eps) : null,
      episodes: eps.map((e) => ({
        id: e.id, title: e.title, name: nameOf(e, titles, offs), number: e.number, abs: absNumber(e, offs), season: e.season, special: !!e.special, moved: e.move_to != null, duration: e.duration,
        position: e.position ?? 0, completed: !!e.completed,
      })),
    });
  });

  /** Details of an AniList entry (a season / movie / OVA that is not in the library yet), for its page in the app. */
  app.get('/api/anime/anilist/:id', wrap(async (req, res) => {
    const aid = Number(req.params.id);
    if (!Number.isInteger(aid)) return res.status(400).json({ error: 'Bad id' });
    const mine = db.prepare("SELECT id FROM series WHERE kind = 'anime' AND anilist_id = ?").get(aid);
    if (mine) return res.json({ ownedId: primaryOf(mine.id) });
    const m = await al.getAnime(aid);
    if (!m) return res.status(404).json({ error: 'That entry was not found on AniList' });
    const a = al.airOf(m);
    res.json({
      id: m.id, title: m.title.english || m.title.romaji, romaji: m.title.romaji, native: m.title.native,
      description: plainDesc(m.description).length ? String(m.description || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim() : '',
      cover: m.coverImage?.extraLarge || m.coverImage?.large || null, banner: m.bannerImage || null,
      format: m.format, status: m.status, episodes: m.episodes ?? null, duration: m.duration ?? null,
      season: a.season, year: a.year, score: m.averageScore ?? null, genres: m.genres || [], tags: al.tagsOf(m),
      studios: (m.studios?.nodes || []).map((n) => n.name), siteUrl: m.siteUrl, ownedId: null,
    });
  }));

  /** The landing page of a show: all its seasons (owned and not) and where to carry on watching. */
  app.get('/api/anime/show/:id', wrap(async (req, res) => {
    const s0 = animeSeries(primaryOf(Number(req.params.id)));
    if (!s0) return res.status(404).json({ error: 'Not found' });
    let fr = franchises();
    if (fr.chains.has(fr.rootOf.get(s0.id) ?? s0.id)) {
      // make sure the other seasons are known (quick when cached; never waits long)
      await Promise.race([franchisePass(), new Promise((r) => setTimeout(r, 6000))]).catch(() => {});
      fr = franchises();
    }
    const rootId = fr.rootOf.get(s0.id) ?? s0.id;
    const chainIds = fr.chains.get(rootId);
    if (!chainIds) return res.json({ single: true, seriesId: s0.id });
    const root = animeSeries(rootId);
    const rows = db.prepare(`SELECT * FROM series WHERE id IN (${chainIds.map(() => '?').join(',')})`).all(...chainIds);
    const cards = seasonCards(chainIds, fr, rootId, null, null);
    const missing = missingCards(rows, fr, rootId);
    const union = (f) => [...new Set(rows.flatMap((r) => { try { return JSON.parse(r[f] || '[]') || []; } catch { return []; } }))];
    // where to carry on: the unfinished episode, else the one after the last finished
    const flat = [];
    for (const id of chainIds) for (const e of groupEpisodes(id)) if (!e.special) flat.push({ ...e, grp: id });
    let cur = null;
    for (const e of flat) if (e.updated_at && (!cur || e.updated_at > cur.updated_at)) cur = e;
    let next = flat[0] || null, started = false;
    if (cur) {
      started = true;
      if (!cur.completed) next = cur;
      else { const i = flat.indexOf(cur); next = flat[i + 1] || null; }
    }
    const years = rows.map((r) => r.air_year || r.year).filter(Boolean);
    // the page is about the whole show: when its first entry is one you do not own, use AniList's poster and blurb for it
    const first = missing.find((g) => g.rank === 1);
    const useFirst = first && (fr.ranks.get(rootId) ?? 1) > 1;
    res.json({
      id: rootId, title: fr.names.get(rootId) || root.show_title || root.title_english || root.title_romaji || root.title, named: !!root.show_title,
      description: useFirst && first.description ? first.description : root.description, poster: useFirst ? first.cover : null, banner: useFirst ? null : root.banner_url, genres: union('genres'), tags: union('tags'),
      siteUrl: root.site_url,
      seasons: cards, missing,
      episodes: cards.reduce((n, c) => n + c.episodes, 0), watched: cards.reduce((n, c) => n + c.watched, 0),
      firstYear: years.length ? Math.min(...years) : null, lastYear: years.length ? Math.max(...years) : null,
      next: next ? { episodeId: next.id, title: next.title, started } : null,
    });
  }));

  app.post('/api/anime/series/:id/rescan', wrap(async (req, res) => {
    const s = animeSeries(Number(req.params.id));
    if (!s) return res.sendStatus(404);
    const libs = getSetting('anime_libraries', []);
    const members = [s, ...db.prepare('SELECT id, path, title FROM series WHERE merged_into = ?').all(s.id)]
      .filter((m) => !String(m.path).startsWith('anilist:')); // entries made from AniList have no folder
    const total = { id: s.id, added: 0, removed: 0, moved: 0, episodes: 0 };
    if (!members.length) { total.episodes = groupEpisodes(s.id).length; return res.json(total); }
    let found = 0;
    for (const m of members) {
      const unit = await collectOne(m.path, libs).catch(() => null);
      if (!unit) continue;
      const r = await scanUnit(unit);
      if (!r) continue;
      found++;
      total.added += r.added; total.removed += r.removed; total.moved += r.moved;
    }
    if (!found) {
      return res.status(409).json({ missing: true, error: 'The folder or files are not at their old location any more - they may have been renamed.' });
    }
    total.episodes = groupEpisodes(s.id).length;
    probeMissing();
    res.json(total);
  }));

  /** Make this series a season of another show (parentId), keep it on its own (0), or go back to automatic (null). */
  app.post('/api/anime/series/:id/parent', (req, res) => {
    const s = animeSeries(Number(req.params.id));
    if (!s) return res.sendStatus(404);
    const sid = primaryOf(s.id);
    const pid = req.body?.parentId;
    let value = null;
    if (pid === 0) value = 0;
    else if (pid !== null && pid !== undefined) {
      const p = animeSeries(Number(pid));
      if (!p) return res.status(404).json({ error: 'That show was not found' });
      const fr = franchises();
      const pp = primaryOf(p.id);
      const top = fr.rootOf.get(pp) ?? pp;
      if (top === sid || pp === sid) return res.status(400).json({ error: 'A show cannot be a season of itself' });
      if (fr.rootOf.get(sid) === top) return res.status(400).json({ error: 'It is already a season of that show' });
      value = top;
    }
    db.prepare('UPDATE series SET parent_id = ? WHERE id = ?').run(value, sid);
    const fr = franchises();
    res.json({ ok: true, rootId: fr.rootOf.get(sid) ?? sid });
  });

  /**
   * Show files under another entry of the show. The target is one of your series (seriesId), an AniList entry
   * (anilistId, created in the library when it is not there yet), or null to put the files back.
   */
  app.post('/api/anime/episodes/move', wrap(async (req, res) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger).slice(0, 2000);
    const eps = ids.map(epRow).filter(Boolean);
    if (!eps.length) return res.status(400).json({ error: 'No files chosen' });
    let target = null;
    if (req.body?.anilistId) {
      const aid = Number(req.body.anilistId);
      const have = db.prepare("SELECT id FROM series WHERE kind = 'anime' AND anilist_id = ?").all(aid);
      if (have.length) target = primaryOf(have[0].id);
      else {
        const media = await al.getAnime(aid);
        if (!media) return res.status(404).json({ error: 'That entry was not found on AniList' });
        const r = db.prepare("INSERT INTO series (title, path, added_at, kind) VALUES (?, ?, ?, 'anime')")
          .run(media.title.english || media.title.romaji, `anilist:${aid}`, Date.now());
        target = Number(r.lastInsertRowid);
        await al.applyMedia(target, media, 'manual');
        const show = Number(req.body?.showId);
        if (show && animeSeries(show)) {
          const fr = franchises();
          const g = primaryOf(show);
          db.prepare('UPDATE series SET parent_id = ? WHERE id = ?').run(fr.rootOf.get(g) ?? g, target); // sits with the show it was moved from
        }
        mergePass();
        relationsPass().then(() => franchisePass()).catch(() => {});
      }
    } else if (req.body?.seriesId !== null && req.body?.seriesId !== undefined) {
      const t = animeSeries(Number(req.body.seriesId));
      if (!t) return res.status(404).json({ error: 'That series was not found' });
      target = primaryOf(t.id);
    }
    const upd = db.prepare('UPDATE episodes SET move_to = ? WHERE id = ?');
    for (const e of eps) upd.run(target == null || primaryOf(e.series_id) === target ? null : target, e.id);
    // entries made only for moved files are removed again once nothing is in them
    for (const v of db.prepare("SELECT id FROM series WHERE kind = 'anime' AND path LIKE 'anilist:%'").all()) {
      const n = db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE move_to = ? OR series_id = ?').get(v.id, v.id).n;
      if (!n) db.prepare('DELETE FROM series WHERE id = ?').run(v.id);
    }
    res.json({ ok: true, seriesId: target });
  }));

  /** Show one file under another series (a season, movie or OVA of the show). null puts it back where it was found. */
  app.post('/api/anime/episodes/:id/move', (req, res) => {
    const ep = need(req, res); if (!ep) return;
    const t = req.body?.seriesId;
    let value = null;
    if (t !== null && t !== undefined) {
      const target = animeSeries(Number(t));
      if (!target) return res.status(404).json({ error: 'That series was not found' });
      value = primaryOf(target.id) === primaryOf(ep.series_id) ? null : target.id;
    }
    db.prepare('UPDATE episodes SET move_to = ? WHERE id = ?').run(value, ep.id);
    res.json({ ok: true });
  });

  /** Name of the whole show (shown on its card and landing page), e.g. "Precure". Empty goes back to the first entry's title. */
  app.put('/api/anime/series/:id/show-title', (req, res) => {
    const s = animeSeries(Number(req.params.id));
    if (!s) return res.sendStatus(404);
    const title = String(req.body?.title ?? '').trim().slice(0, 120) || null;
    db.prepare('UPDATE series SET show_title = ? WHERE id = ?').run(title, primaryOf(s.id));
    res.json({ ok: true });
  });

  /** Name for the season bar ("S3 Part 2"); empty goes back to the automatic one. */
  app.put('/api/anime/series/:id/label', (req, res) => {
    const s = animeSeries(Number(req.params.id));
    if (!s) return res.sendStatus(404);
    const label = String(req.body?.label ?? '').trim().slice(0, 40) || null;
    db.prepare('UPDATE series SET season_label = ? WHERE id = ?').run(label, primaryOf(s.id));
    res.json({ ok: true });
  });

  /** Split the episode list into named sections ("Part 1", "Part 2") - [{ season, number, label }] where each starts. */
  app.put('/api/anime/series/:id/sections', (req, res) => {
    const s = animeSeries(Number(req.params.id));
    if (!s) return res.sendStatus(404);
    const list = Array.isArray(req.body?.sections) ? req.body.sections : [];
    const clean = list.slice(0, 60).map((m) => ({
      season: Number.isFinite(Number(m?.season)) ? Math.trunc(Number(m.season)) : 1,
      number: Number(m?.number),
      label: String(m?.label ?? '').trim().slice(0, 60) || 'Part',
    })).filter((m) => Number.isFinite(m.number));
    db.prepare('UPDATE series SET sections = ? WHERE id = ?').run(clean.length ? JSON.stringify(clean) : null, primaryOf(s.id));
    res.json({ ok: true, sections: clean });
  });

  /** Mark many episodes at once (everything up to here, a whole section…). */
  app.post('/api/anime/episodes/watched-bulk', (req, res) => {
    const watched = req.body?.watched !== false;
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger).slice(0, 5000);
    const stmt = db.prepare(markSql);
    const now = Date.now();
    for (const id of ids) if (epRow(id)) stmt.run(id, watched ? 1 : 0, now);
    res.json({ ok: true, count: ids.length });
  });

  /** Take a show off the Continue watching shelf until you watch something of it again. */
  app.post('/api/anime/continue/hide', (req, res) => {
    const id = Number(req.body?.seriesId);
    if (!animeSeries(id)) return res.sendStatus(404);
    const fr = franchises();
    const g = primaryOf(id);
    const show = fr.rootOf.get(g) ?? g;
    setSetting('continue_hidden', { ...getSetting('continue_hidden', {}), [`a:${show}`]: Date.now() });
    res.json({ ok: true });
  });

  /** Look the episode titles up again (MyAnimeList via Jikan, then AniList). */
  app.post('/api/anime/series/:id/titles', wrap(async (req, res) => {
    const s = animeSeries(Number(req.params.id));
    if (!s) return res.sendStatus(404);
    if (!s.anilist_id) return res.status(400).json({ error: 'Match this series on AniList first' });
    await titlesPass({ force: true, seriesId: s.id });
    const n = Object.keys(titlesOf(s.id)).length;
    res.json({ titles: n });
  }));

  /** Show the combined folders as separate series again (and do not combine them automatically). */
  app.post('/api/anime/series/:id/split', (req, res) => {
    const s = animeSeries(Number(req.params.id));
    if (!s) return res.sendStatus(404);
    db.prepare('UPDATE series SET merged_into = NULL, merge_lock = 1 WHERE merged_into = ?').run(s.id);
    res.json({ ok: true });
  });

  // metadata (AniList, type ANIME)
  app.get('/api/anime/search', wrap(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    res.json((await al.searchAnime(q, 10)).map((m) => ({
      id: m.id, title: m.title.english || m.title.romaji, romaji: m.title.romaji, native: m.title.native,
      cover: m.coverImage?.large, year: m.startDate?.year, format: m.format, chapters: m.episodes, status: m.status,
    })));
  }));

  app.post('/api/anime/series/:id/match', wrap(async (req, res) => {
    const s = animeSeries(Number(req.params.id));
    if (!s) return res.sendStatus(404);
    if (req.body?.anilistId === null) {
      db.prepare("UPDATE series SET anilist_id = NULL, match_state = 'manual' WHERE id = ?").run(s.id);
      return res.json({ ok: true });
    }
    await al.applyMedia(s.id, await al.getAnime(Number(req.body.anilistId)), 'manual');
    db.prepare('UPDATE series SET rel_checked = NULL, merge_lock = 0 WHERE id = ?').run(s.id);
    mergePass();
    relationsPass().catch(() => {});
    titlesPass().catch(() => {});
    res.json({ ok: true });
  }));

  // ---------- playback ----------

  app.get('/api/anime/episodes/:id', wrap(async (req, res) => {
    const ep = need(req, res); if (!ep) return;
    const gid = primaryOf(epHome(ep));
    const s = db.prepare('SELECT * FROM series WHERE id = ?').get(gid);
    let probe = null, probeError = null;
    try { probe = await probeOf(ep); } catch (e) { probeError = e.message; }
    const list = groupEpisodes(gid);
    let at = list.findIndex((e) => e.id === ep.id);
    if (at < 0) at = list.findIndex((e) => (e.season ?? 1) === (ep.season ?? 1) && e.number === ep.number && e.number != null);
    const prev = at > 0 ? list[at - 1] : null, next = at >= 0 ? list[at + 1] : null;
    const p = db.prepare('SELECT position, completed FROM episode_progress WHERE episode_id = ?').get(ep.id);
    const index = at >= 0 ? at + 1 : 1;
    const v = probe && tc.videoOf(probe);
    const tracks = probe ? tc.tracksOf(probe, ep.path) : { audio: [], subs: [] };
    const intro = probe?.chapters.find((c) => /^(op|opening|intro|オープニング)\b/i.test(c.title.trim()));
    res.json({
      id: ep.id, title: ep.title, name: nameOf(ep, titlesOf(gid), seasonOffsets(list)), number: ep.number,
      anilistNumber: ep.number == null ? null : Math.floor(absNumber(ep, seasonOffsets(list)) ?? ep.number),
      season: ep.season, special: !!ep.special, index,
      series: { id: s.id, title: s.title_english || s.title_romaji || s.title, anilistId: s.anilist_id, episodesTotal: s.chapters_total },
      prevId: prev?.id ?? null, nextId: next?.id ?? null,
      position: p?.position ?? 0, completed: !!p?.completed,
      duration: probe?.duration ?? ep.duration ?? 0,
      error: probeError,
      video: v ? { codec: v.codec, width: v.width, height: v.height } : null,
      audio: tracks.audio, subs: tracks.subs,
      chapters: probe?.chapters ?? [],
      intro: intro ? { start: intro.start, end: intro.end } : null,
      directPlay: probe ? tc.canDirectPlay(probe, ep.path) : false,
      ffmpeg: { ready: ffReady(), libass: ffInfo().libass },
    });
  }));

  /** Direct play: the file itself, with Range support for seeking. */
  app.get('/api/anime/episodes/:id/file', (req, res) => {
    const ep = need(req, res); if (!ep) return;
    const types = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska' };
    res.type(types[path.extname(ep.path).toLowerCase()] || 'application/octet-stream');
    res.sendFile(ep.path, { acceptRanges: true }, (err) => { if (err && !res.headersSent) res.sendStatus(404); });
  });

  /** Decide how to play with the chosen tracks and hand back a playlist address. */
  app.get('/api/anime/episodes/:id/session', wrap(async (req, res) => {
    const ep = need(req, res); if (!ep) return;
    if (!needFf(res)) return;
    const probe = await probeOf(ep);
    const q = req.query;
    const audioCount = probe.streams.filter((s) => s.type === 'audio').length;
    const audio = Math.min(Math.max(0, Number(q.audio) | 0), Math.max(0, audioCount - 1));
    const subs = tc.tracksOf(probe, ep.path).subs;
    let sub = q.sub === undefined || q.sub === '' || q.sub === 'n' ? null : Number(q.sub);
    if (sub !== null && !(Number.isInteger(sub) && sub >= 0 && sub < subs.length)) sub = null;
    let burn = q.burn === '1' && sub !== null;
    if (burn && !ffInfo().libass && subs[sub].text) return res.status(400).json({ error: 'This ffmpeg build cannot burn in subtitles (no libass).' });
    if (burn && subs[sub].external && !subs[sub].text) burn = false;
    const height = [0, 360, 480, 720, 1080].includes(Number(q.height)) ? Number(q.height) : 0;
    const mode = tc.modeFor(probe, { burn, height, forceTranscode: q.transcode === '1' });
    const styleIn = tc.parseStyle(q.sty) ? String(q.sty) : null; // a look chosen for burned-in subtitles
    const key = tc.makeKey({ audio, sub: burn ? sub : null, burn, height, mode, style: burn && subs[sub]?.text ? styleIn : null });
    const session = await openSession(ep, probe, key);
    res.json({
      url: `/api/anime/stream/${ep.id}/${key}/index.m3u8`,
      mode: mode === 'r' ? 'remux' : 'transcode', segments: session.bounds.length, duration: probe.duration,
      burn, audio, sub,
    });
  }));

  async function openSession(ep, probe, key) {
    const opts = tc.parseKey(key);
    if (!opts) throw Object.assign(new Error('Bad stream key'), { status: 400 });
    const fresh = epRow(ep.id) || ep;
    const kf = opts.mode === 'r' ? await tc.keyframesOf(fresh) : null;
    const bounds = tc.boundaries(opts.mode, probe.duration || fresh.duration || 0, kf);
    return tc.getSession(fresh, probe, key, opts, bounds);
  }

  app.get('/api/anime/stream/:id/:key/index.m3u8', wrap(async (req, res) => {
    const ep = need(req, res); if (!ep) return;
    if (!needFf(res)) return;
    const probe = await probeOf(ep);
    const s = await openSession(ep, probe, req.params.key);
    res.set('Cache-Control', 'no-store').type('application/vnd.apple.mpegurl').send(tc.playlist(s.bounds, probe.duration));
  }));

  app.get('/api/anime/stream/:id/:key/:n.ts', wrap(async (req, res) => {
    const ep = need(req, res); if (!ep) return;
    if (!needFf(res)) return;
    const probe = await probeOf(ep);
    const s = await openSession(ep, probe, req.params.key);
    const file = await tc.ensureSegment(s, Number(req.params.n));
    if (!file) return res.sendStatus(404);
    res.set('Cache-Control', 'private, max-age=600').type('video/mp2t');
    res.sendFile(file);
  }));

  /** One subtitle track as WebVTT, for showing it without burning it in. */
  app.get('/api/anime/episodes/:id/subs/:ord.vtt', wrap(async (req, res) => {
    const ep = need(req, res); if (!ep) return;
    if (!needFf(res)) return;
    const probe = await probeOf(ep);
    const vtt = await tc.vttFor(ep, probe, Number(req.params.ord));
    res.set('Cache-Control', 'private, max-age=3600').type('text/vtt');
    res.sendFile(vtt);
  }));

  /** The subtitle track as ASS, for the in-browser libass renderer (fonts, signs and karaoke exactly as authored). */
  app.get('/api/anime/episodes/:id/subs/:ord.ass', wrap(async (req, res) => {
    const ep = need(req, res); if (!ep) return;
    if (!needFf(res)) return;
    const probe = await probeOf(ep);
    const dir = await tc.textSub(ep, probe, Number(req.params.ord));
    res.set('Cache-Control', 'private, max-age=3600').type('text/plain; charset=utf-8');
    res.sendFile(path.join(dir, `sub-${Number(req.params.ord)}.ass`));
  }));

  /** Fonts embedded in the video file (the styled subtitles use them). */
  app.get('/api/anime/episodes/:id/fonts', wrap(async (req, res) => {
    const ep = need(req, res); if (!ep) return;
    if (!ffReady()) return res.json([]);
    const probe = await probeOf(ep);
    const dir = await tc.ensureFonts(ep, probe);
    let names = [];
    try { names = fs.readdirSync(path.join(dir, 'fonts')).filter((n) => /\.(ttf|otf|ttc|woff2?)$/i.test(n)); } catch { /* none */ }
    res.json(names.map((n) => ({ name: n, url: `/api/anime/episodes/${ep.id}/fonts/${encodeURIComponent(n)}` })));
  }));

  app.get('/api/anime/episodes/:id/fonts/:name', wrap(async (req, res) => {
    const ep = need(req, res); if (!ep) return;
    const name = path.basename(String(req.params.name));
    const probe = await probeOf(ep);
    const dir = await tc.ensureFonts(ep, probe);
    const file = path.join(dir, 'fonts', name);
    if (!/\.(ttf|otf|ttc|woff2?)$/i.test(name) || !fs.existsSync(file)) return res.sendStatus(404);
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(file);
  }));

  app.get('/api/anime/episodes/:id/thumb', wrap(async (req, res) => {
    const ep = need(req, res); if (!ep) return;
    if (!ffReady()) return res.sendStatus(404);
    try {
      const f = await tc.thumbFor(ep);
      res.set('Cache-Control', 'private, max-age=86400');
      res.sendFile(f);
    } catch { res.sendStatus(404); }
  }));

  // ---------- progress ----------

  app.post('/api/anime/progress', (req, res) => {
    const { episodeId, position, duration, completed } = req.body || {};
    if (!epRow(episodeId)) return res.status(404).json({ error: 'Unknown episode' });
    db.prepare(`INSERT INTO episode_progress (episode_id, position, duration, completed, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(episode_id) DO UPDATE SET position = excluded.position, duration = excluded.duration,
        completed = CASE WHEN excluded.completed = 1 OR episode_progress.completed = 1 THEN 1 ELSE 0 END,
        updated_at = excluded.updated_at`)
      .run(episodeId, Math.max(0, Number(position) || 0), Number(duration) || null, completed ? 1 : 0, Date.now());
    res.json({ ok: true });
  });

  const markSql = `INSERT INTO episode_progress (episode_id, position, completed, updated_at) VALUES (?, 0, ?, ?)
    ON CONFLICT(episode_id) DO UPDATE SET completed = excluded.completed, updated_at = excluded.updated_at,
      position = CASE WHEN excluded.completed = 1 THEN episode_progress.position ELSE 0 END`;

  /** Open the file manager on the file - only when the browser is on the same machine as the server. */
  app.post('/api/anime/episodes/:id/reveal', (req, res) => {
    const ep = need(req, res); if (!ep) return;
    if (!fs.existsSync(ep.path)) return res.status(404).json({ error: 'The file is not at its old location any more', path: ep.path });
    const opened = isLocalRequest(req) && reveal(ep.path);
    res.json({ opened, path: ep.path });
  });

  /** Everything known about one file. */
  app.get('/api/anime/episodes/:id/properties', wrap(async (req, res) => {
    const ep = need(req, res); if (!ep) return;
    let st = null;
    try { st = await fsp.stat(ep.path); } catch { /* missing */ }
    let probe = null;
    try { probe = await probeOf(ep); } catch { /* not readable */ }
    const v = probe && tc.videoOf(probe);
    const tracks = probe ? tc.tracksOf(probe, ep.path) : { audio: [], subs: [] };
    const home = db.prepare('SELECT id, title, title_english, title_romaji FROM series WHERE id = ?').get(epHome(ep));
    const p = db.prepare('SELECT position, completed FROM episode_progress WHERE episode_id = ?').get(ep.id);
    res.json({
      name: path.basename(ep.path), folder: path.dirname(ep.path), path: ep.path, exists: !!st,
      size: st?.size ?? ep.size ?? null, modified: st?.mtimeMs ?? ep.mtime ?? null, added: ep.added_at,
      extension: path.extname(ep.path).slice(1).toLowerCase(), container: probe?.container || null,
      duration: probe?.duration || ep.duration || null, bitrate: probe?.bitrate || null,
      video: v ? { codec: v.codec, profile: v.profile, width: v.width, height: v.height, pixFmt: v.pixFmt, bits: v.bits } : null,
      audio: tracks.audio.map((a) => a.label), subs: tracks.subs.map((s) => s.label),
      chapters: probe?.chapters?.length ?? null,
      show: home ? (home.title_english || home.title_romaji || home.title) : null,
      season: ep.season, number: ep.number, special: !!ep.special, moved: ep.move_to != null,
      watched: !!p?.completed, position: p?.position ?? 0,
      directPlay: probe ? tc.canDirectPlay(probe, ep.path) : null,
    });
  }));

  app.post('/api/anime/episodes/:id/watched', (req, res) => {
    const ep = need(req, res); if (!ep) return;
    db.prepare(markSql).run(ep.id, req.body?.watched === false ? 0 : 1, Date.now());
    res.json({ ok: true });
  });

  app.post('/api/anime/series/:id/watched-all', (req, res) => {
    const watched = req.body?.watched !== false;
    const stmt = db.prepare(markSql);
    const gid = primaryOf(Number(req.params.id));
    // a whole show covers all of its seasons; scope "season" is just this entry
    let groups = [gid];
    if (req.body?.scope !== 'season') {
      const fr = franchises();
      groups = fr.chains.get(fr.rootOf.get(gid) ?? gid) || [gid];
    }
    const q = db.prepare(`SELECT e.id FROM episodes e JOIN series s ON s.id = ${EP_SERIES} WHERE s.id = ? OR s.merged_into = ?`);
    const now = Date.now();
    for (const g of groups) for (const { id } of q.all(g, g)) stmt.run(id, watched ? 1 : 0, now);
    res.json({ ok: true });
  });

  /** Record an episode on AniList: progress = max(current, episode number). */
  app.post('/api/anime/anilist/progress', wrap(async (req, res) => {
    const ep = epRow(Number(req.body?.episodeId));
    if (!ep) return res.sendStatus(404);
    const s = db.prepare('SELECT * FROM series WHERE id = ?').get(ep.series_id);
    if (!s.anilist_id) return res.status(400).json({ error: 'Match this series to AniList first' });
    if (ep.special || ep.number == null) return res.status(400).json({ error: 'Specials do not count towards AniList progress' });

    const gid = primaryOf(epHome(ep));
    const off = seasonOffsets(groupEpisodes(gid));
    const entryTotal = db.prepare('SELECT chapters_total FROM series WHERE id = ?').get(gid)?.chapters_total || s.chapters_total;
    let target = Math.floor(ep.number);
    const abs = Math.floor(absNumber(ep, off));
    if (off && (!entryTotal || abs <= entryTotal)) target = abs; // S2 ep 1 of a 70-episode entry is #36
    if (req.body?.progress != null) target = Number(req.body.progress) | 0;
    const entry = await al.getListEntry(s.anilist_id);
    const current = entry?.progress ?? 0;
    const progress = req.body?.force ? target : Math.max(current, target);
    let status = entry?.status;
    if (!status || ['PLANNING', 'PAUSED', 'DROPPED'].includes(status)) status = 'CURRENT';
    const total = entryTotal || s.chapters_total;
    if (total && progress >= total && status === 'CURRENT') status = 'COMPLETED';
    const saved = await al.saveEntry(s.anilist_id, { progress, status });
    db.prepare(markSql).run(ep.id, 1, Date.now());
    res.json({ entry: saved, previous: current, target, changed: saved.progress !== current || saved.status !== entry?.status });
  }));

  // kick the probe queue when the app starts and after scans (cheap when nothing is new)
  setTimeout(() => probeMissing(), 3000).unref();
  setTimeout(() => facetsPass().then(() => relationsPass()).then(() => franchisePass()).then(() => titlesPass()).catch(() => {}), 8000).unref(); // seasons / tags / names for what is already matched
  setInterval(() => { if (!scanState.running) probeMissing(); }, 60_000).unref();
}
