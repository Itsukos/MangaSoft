import { db, getSetting } from './db.js';
import * as al from './anilist.js';

/**
 * Episode titles. MyAnimeList's list (through the free Jikan API) is the main source, found through the
 * MAL id AniList gives for every entry; AniList's own streaming-episode titles are the fallback. Titles are
 * stored per series as { "<episode number>": "title" } and only shown, never written into your files.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastJikan = 0;

async function jikan(path) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = lastJikan + 450 - Date.now(); // Jikan allows ~3 requests/second, 60/minute
    if (wait > 0) await sleep(wait);
    lastJikan = Date.now();
    const r = await fetch(`https://api.jikan.moe/v4${path}`, {
      headers: { 'User-Agent': 'MangaSoft/1.4 (personal self-hosted library)' }, signal: AbortSignal.timeout(20000),
    });
    if (r.status === 429 || r.status >= 500) { await sleep(2500 * (attempt + 1)); continue; }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Jikan ${r.status}`);
    return r.json();
  }
  throw new Error('Jikan is busy - try again later');
}

async function fromJikan(malId) {
  const map = {};
  for (let page = 1; page <= 40; page++) {
    const j = await jikan(`/anime/${malId}/episodes?page=${page}`);
    if (!j) break;
    for (const e of j.data || []) {
      const t = (e.title || e.title_romanji || e.title_japanese || '').trim();
      if (e.mal_id != null && t) map[String(e.mal_id)] = t;
    }
    if (!j.pagination?.has_next_page) break;
  }
  return map;
}

async function fromAniList(id) {
  const media = await al.getEpisodeTitles(id);
  const map = {};
  for (const e of media?.streamingEpisodes || []) {
    const m = String(e.title || '').match(/^(?:episode|ep\.?)\s*(\d+(?:\.\d+)?)\s*[-–:]\s*(.+)$/i);
    if (m) map[m[1]] = m[2].trim();
  }
  return map;
}

/** ani.zip maps AniList ids to AniDB / TheTVDB and carries their episode titles (no key needed). */
async function fromAniZip(anilistId) {
  const r = await fetch(`https://api.ani.zip/mappings?anilist_id=${anilistId}`, { signal: AbortSignal.timeout(20000) });
  if (r.status === 404) return {};
  if (!r.ok) throw new Error(`ani.zip ${r.status}`);
  const j = await r.json();
  const map = {};
  for (const [k, e] of Object.entries(j?.episodes || {})) {
    if (!/^\d+(\.\d+)?$/.test(k)) continue; // S1, T1… are specials / trailers
    const t = String(e?.title?.en || e?.title?.['x-jat'] || e?.title?.ja || '').replace(/`/g, "'").trim();
    if (t && !/^episode\s*\d+$/i.test(t)) map[k] = t;
  }
  return map;
}

/** Kitsu knows AniList ids too (its "mappings"), and has an episode list per anime: a second source when Jikan is down or empty. */
async function fromKitsu(anilistId) {
  const get = async (url) => {
    const r = await fetch(url, { headers: { Accept: 'application/vnd.api+json' }, signal: AbortSignal.timeout(20000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Kitsu ${r.status}`);
    return r.json();
  };
  const m = await get(`https://kitsu.io/api/edge/mappings?filter[externalSite]=anilist/anime&filter[externalId]=${anilistId}&include=item`);
  const item = m?.data?.[0]?.relationships?.item?.data;
  if (!item || item.type !== 'anime') return {};
  const map = {};
  for (let offset = 0; offset < 1500; offset += 20) {
    const j = await get(`https://kitsu.io/api/edge/anime/${item.id}/episodes?page[limit]=20&page[offset]=${offset}&sort=number`);
    for (const e of j?.data || []) {
      const a = e.attributes || {};
      const t = (a.canonicalTitle || a.titles?.en_us || a.titles?.en_jp || '').trim();
      if (a.number != null && t && !/^episode\s*\d+$/i.test(t)) map[String(a.number)] = t;
    }
    if (!j?.links?.next || !(j.data || []).length) break;
  }
  return map;
}

/** Titles for one AniList entry. Returns { map, malId, failed } - failed means every source was unreachable (try again soon). */
export async function fetchTitles(anilistId, knownMalId = null) {
  let malId = knownMalId;
  let reached = false;
  if (!malId) { try { malId = (await al.getEpisodeTitles(anilistId))?.idMal ?? null; reached = true; } catch { /* offline */ } }
  let map = {};
  if (malId) { try { map = await fromJikan(malId); reached = true; } catch { /* Jikan down or busy: other sources below */ } }
  if (!Object.keys(map).length) { try { map = await fromAniZip(anilistId); reached = true; } catch { /* next source */ } }
  if (!Object.keys(map).length) { try { map = await fromKitsu(anilistId); reached = true; } catch { /* none */ } }
  if (!Object.keys(map).length) { try { map = await fromAniList(anilistId); reached = true; } catch { /* none */ } }
  return { map, malId, failed: !reached && !Object.keys(map).length };
}

let running = false;

/** Fetch titles for every matched anime that has none yet (retried after a few hours if empty, refreshed every 30 days). */
export async function titlesPass({ force = false, seriesId = null } = {}) {
  if (running) return;
  running = true;
  try {
    if (!force && !getSetting('auto_match', true)) return;
    const now = Date.now();
    const rows = db.prepare(`SELECT id, anilist_id, mal_id, ep_titles, ep_titles_checked FROM series
      WHERE kind = 'anime' AND anilist_id IS NOT NULL ${seriesId ? 'AND id = ?' : ''}`).all(...(seriesId ? [seriesId] : []));
    const done = new Map(); // anilist id -> result, so folders sharing an entry cost one lookup
    for (const s of rows) {
      const age = now - (s.ep_titles_checked || 0);
      const has = s.ep_titles && s.ep_titles !== '{}';
      if (!force && s.ep_titles_checked && age < (has ? 30 * 24 : 3) * 3600 * 1000) continue;
      let r = done.get(s.anilist_id);
      if (!r) {
        try { r = await fetchTitles(s.anilist_id, s.mal_id); } catch { continue; }
        done.set(s.anilist_id, r);
      }
      const found = Object.keys(r.map).length > 0;
      // nothing reachable (Jikan down, offline): keep what there was and look again in about an hour
      const stamp = r.failed || (!found && has) ? now - (has ? 30 * 24 - 1 : 2) * 3600 * 1000 : now;
      db.prepare('UPDATE series SET ep_titles = ?, ep_titles_checked = ?, mal_id = COALESCE(?, mal_id) WHERE id = ?')
        .run(found || !has ? JSON.stringify(r.map) : s.ep_titles, stamp, r.malId, s.id);
    }
  } finally { running = false; }
}

