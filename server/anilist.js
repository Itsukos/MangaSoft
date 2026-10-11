import fs from 'node:fs/promises';
import path from 'node:path';
import { db, COVER_DIR, getSetting, setSetting } from './db.js';
import { applyOverrides } from './meta.js';
import { cleanAnimeTitle } from './animefiles.js';

const API = 'https://graphql.anilist.co';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;

async function gql(query, variables = {}, { auth = false } = {}) {
  const token = auth ? getSetting('anilist_token') : null;
  if (auth && !token) throw Object.assign(new Error('Not connected to AniList'), { status: 401 });

  for (let attempt = 0; attempt < 3; attempt++) {
    // gentle client-side throttle (AniList allows ~90 req/min)
    const wait = lastCall + 700 - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();

    const res = await fetch(API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after')) || 30;
      await sleep(retry * 1000);
      continue;
    }
    const json = await res.json().catch(() => ({}));
    if (json.errors?.length) {
      const err = new Error(json.errors[0].message || 'AniList error');
      err.status = res.status === 401 || /invalid token/i.test(err.message) ? 401 : 502;
      throw err;
    }
    return json.data;
  }
  throw new Error('AniList rate limit - try again shortly');
}

const MEDIA_FIELDS = `
  id siteUrl format status chapters volumes averageScore description(asHtml: false)
  genres bannerImage startDate { year }
  tags { name rank isMediaSpoiler }
  title { romaji english native }
  synonyms
  coverImage { extraLarge large color }
  staff(perPage: 4, sort: RELEVANCE) { edges { role node { name { full } } } }
`;

export async function search(term, perPage = 10) {
  const data = await gql(
    `query ($s: String, $n: Int) { Page(perPage: $n) { media(search: $s, type: MANGA, sort: SEARCH_MATCH) { ${MEDIA_FIELDS} } } }`,
    { s: term, n: perPage },
  );
  return data.Page.media;
}

export async function searchNovel(term, perPage = 10) {
  const data = await gql(
    `query ($s: String, $n: Int) { Page(perPage: $n) { media(search: $s, type: MANGA, format: NOVEL, sort: SEARCH_MATCH) { ${MEDIA_FIELDS} } } }`,
    { s: term, n: perPage },
  );
  return data.Page.media;
}

export async function getMedia(id) {
  const data = await gql(`query ($id: Int) { Media(id: $id, type: MANGA) { ${MEDIA_FIELDS} } }`, { id });
  return data.Media;
}

const ANIME_FIELDS = `
  id idMal siteUrl format status episodes duration averageScore description(asHtml: false)
  genres bannerImage startDate { year month } season seasonYear
  tags { name rank isMediaSpoiler }
  title { romaji english native }
  synonyms
  coverImage { extraLarge large color }
  studios(isMain: true) { nodes { name } }
`;

/** An authenticated query / mutation with the account connected in Settings (social page). */
export const gqlAuth = (query, variables = {}) => gql(query, variables, { auth: true });

export async function searchAnime(term, perPage = 10) {
  const data = await gql(
    `query ($s: String, $n: Int) { Page(perPage: $n) { media(search: $s, type: ANIME, sort: SEARCH_MATCH) { ${ANIME_FIELDS} } } }`,
    { s: term, n: perPage },
  );
  return data.Page.media;
}

/** AniList's relations of one entry: adaptations, sequels, side stories… as [{ id, type, rel }]. */
export async function getRelations(id, type) {
  const data = await gql(
    `query ($id: Int, $t: MediaType) { Media(id: $id, type: $t) { relations { edges { relationType(version: 2)
      node { id type format title { romaji english } coverImage { medium } } } } } }`,
    { id, t: type },
  );
  return (data.Media?.relations?.edges || []).map((e) => ({
    id: e.node.id, type: e.node.type, rel: e.relationType, fmt: e.node.format || null,
    title: e.node.title?.english || e.node.title?.romaji || null, cover: e.node.coverImage?.medium || null,
  }));
}

/** MAL id and AniList's streaming-episode titles for one anime. */
export async function getEpisodeTitles(id) {
  const data = await gql('query ($id: Int) { Media(id: $id, type: ANIME) { idMal streamingEpisodes { title } } }', { id });
  return data.Media;
}

/** Season (WINTER..FALL) and year an entry aired in; falls back to the start date when AniList has no season. */
export function airOf(media) {
  let season = media.season || null, year = media.seasonYear || null;
  const m = media.startDate;
  if (!season && m?.month) season = m.month <= 2 || m.month === 12 ? 'WINTER' : m.month <= 5 ? 'SPRING' : m.month <= 8 ? 'SUMMER' : 'FALL';
  if (!year && m?.year) year = m.year;
  return { season: year ? season : null, year: year || null };
}

/** Tag names, most relevant first, without spoilers. */
export function tagsOf(media) {
  return (media.tags || []).filter((t) => !t.isMediaSpoiler && (t.rank ?? 0) >= 30)
    .sort((a, b) => (b.rank || 0) - (a.rank || 0)).slice(0, 30).map((t) => t.name);
}

/** Season / tags / alternative titles for many entries at once (up to 50 ids per request). */
export async function getFacets(ids, type = 'ANIME') {
  const extra = type === 'ANIME' ? 'season seasonYear startDate { year month } tags { name rank isMediaSpoiler }' : 'tags { name rank isMediaSpoiler }';
  const data = await gql(
    `query ($ids: [Int], $t: MediaType) { Page(perPage: 50) { media(id_in: $ids, type: $t) { id synonyms ${extra} } } }`,
    { ids, t: type },
  );
  return data.Page.media;
}

/** Details + relations of many anime at once (a franchise's other seasons). */
export async function getMediaBatch(ids) {
  const data = await gql(
    `query ($ids: [Int]) { Page(perPage: 25) { media(id_in: $ids, type: ANIME) {
      id format status episodes season seasonYear startDate { year month day }
      title { romaji english } coverImage { large } description(asHtml: false)
      relations { edges { relationType(version: 2) node { id type format title { romaji english } coverImage { medium } } } }
    } } }`,
    { ids },
  );
  return data.Page.media;
}

export async function getAnime(id) {
  const data = await gql(`query ($id: Int) { Media(id: $id, type: ANIME) { ${ANIME_FIELDS} } }`, { id });
  return data.Media;
}

// ---------- matching helpers ----------

export function cleanTitle(raw) {
  return raw
    .replace(/[\[(【][^\])】]*[\])】]/g, ' ')   // [Group] (Digital) etc.
    .replace(/[_.]+/g, ' ')
    .replace(/\b(digital|raw|v\d+|vol(ume)?s?\.? ?\d+.*|complete|official)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = new Set(a.split(' ')), tb = new Set(b.split(' '));
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  const jacc = hit / (ta.size + tb.size - hit);
  const contains = a.includes(b) || b.includes(a) ? 0.15 : 0;
  return Math.min(1, jacc + contains);
}

export function bestMatch(folderTitle, results) {
  let best = null, bestScore = 0;
  for (const m of results) {
    const names = [m.title.romaji, m.title.english, m.title.native, ...(m.synonyms || [])].filter(Boolean);
    const score = Math.max(...names.map((n) => similarity(folderTitle, n)));
    if (score > bestScore) { best = m; bestScore = score; }
  }
  return { media: best, score: bestScore };
}

// ---------- applying metadata ----------

async function downloadCover(media, seriesId) {
  const url = media.coverImage?.extraLarge || media.coverImage?.large;
  if (!url) return false;
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    await fs.writeFile(path.join(COVER_DIR, `${seriesId}.jpg`), Buffer.from(await res.arrayBuffer()));
    return true;
  } catch { return false; }
}

export async function applyMedia(seriesId, media, state) {
  const prev = db.prepare('SELECT anilist_id, meta_source FROM series WHERE id = ?').get(seriesId);
  const hasCover = await downloadCover(media, seriesId);
  // a different entry whose cover couldn't be fetched must not keep showing the previous entry's cover
  const dropCover = !hasCover && !(prev?.anilist_id === media.id && prev?.meta_source !== 'mangadex');
  const authors = media.studios
    ? media.studios.nodes.map((n) => `${n.name} (Studio)`)
    : (media.staff?.edges || []).map((e) => `${e.node.name.full} (${e.role})`);
  const desc = (media.description || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
  db.prepare(`UPDATE series SET
      meta_source = 'anilist', anilist_id = ?, match_state = ?, title_romaji = ?, title_english = ?, title_native = ?,
      description = ?, genres = ?, authors = ?, status = ?, format = ?, chapters_total = ?,
      volumes_total = ?, score = ?, year = ?, banner_url = ?, cover_color = ?, site_url = ?,
      has_cover = CASE WHEN ? THEN 1 WHEN ? THEN 0 ELSE has_cover END
    WHERE id = ?`).run(
    media.id, state, media.title.romaji, media.title.english, media.title.native,
    desc, JSON.stringify(media.genres || []), JSON.stringify(authors), media.status, media.format,
    media.chapters ?? media.episodes ?? null, media.volumes ?? null, media.averageScore, media.startDate?.year ?? null,
    media.bannerImage, media.coverImage?.color, media.siteUrl,
    hasCover ? 1 : 0, dropCover ? 1 : 0, seriesId,
  );
  if (media.idMal) db.prepare('UPDATE series SET mal_id = ? WHERE id = ?').run(media.idMal, seriesId);
  if (Array.isArray(media.synonyms)) db.prepare('UPDATE series SET synonyms = ? WHERE id = ?').run(JSON.stringify(media.synonyms), seriesId);
  if ('season' in media) { // anime entries carry their season and tags
    const a = airOf(media);
    db.prepare('UPDATE series SET air_season = ?, air_year = ?, tags = ?, facets_checked = ? WHERE id = ?')
      .run(a.season, a.year, JSON.stringify(tagsOf(media)), Date.now(), seriesId);
  } else if ('tags' in media) { // manga: tags only
    db.prepare('UPDATE series SET tags = ? WHERE id = ?').run(JSON.stringify(tagsOf(media)), seriesId);
  }
  if (prev?.anilist_id !== media.id) { // a different entry: what was cached for the old one no longer applies
    db.prepare('UPDATE series SET ep_titles = NULL, ep_titles_checked = NULL, rel_json = NULL, rel_checked = NULL WHERE id = ?').run(seriesId);
  }
  applyOverrides(seriesId);
}

export async function autoMatch(series, anime = false, novel = false) {
  const term = anime ? cleanAnimeTitle(series.title) : cleanTitle(series.title);
  const results = anime ? await searchAnime(term, 8) : novel ? await searchNovel(term, 8) : await search(term, 6);
  const { media, score } = bestMatch(term, results);
  if (!media || score < 0.6) {
    db.prepare("UPDATE series SET match_state = 'missing' WHERE id = ?").run(series.id);
    return false;
  }
  await applyMedia(series.id, media, 'auto');
  return true;
}

// ---------- authenticated (user) calls ----------

export async function fetchViewer() {
  const data = await gql('query { Viewer { id name siteUrl avatar { medium } } }', {}, { auth: true });
  return data.Viewer;
}

export async function getListEntry(mediaId) {
  const viewer = getSetting('anilist_user');
  if (!viewer) throw Object.assign(new Error('Not connected to AniList'), { status: 401 });
  const data = await gql(
    `query ($m: Int, $u: Int) { MediaList(mediaId: $m, userId: $u) { id status progress score(format: POINT_10) } }`,
    { m: mediaId, u: viewer.id }, { auth: true },
  ).catch((e) => {
    if (/not found/i.test(e.message)) return { MediaList: null }; // no entry yet
    throw e;
  });
  return data.MediaList;
}

export async function saveEntry(mediaId, { progress, status }) {
  const vars = { m: mediaId };
  const decl = ['$m: Int'], args = ['mediaId: $m'];
  if (progress !== undefined) { vars.p = progress; decl.push('$p: Int'); args.push('progress: $p'); }
  if (status !== undefined) { vars.s = status; decl.push('$s: MediaListStatus'); args.push('status: $s'); }
  const data = await gql(
    `mutation (${decl.join(', ')}) { SaveMediaListEntry(${args.join(', ')}) { id status progress } }`,
    vars, { auth: true },
  );
  return data.SaveMediaListEntry;
}

export { setSetting, getSetting };
