import fs from 'node:fs/promises';
import path from 'node:path';
import { db, tx } from './db.js';
import { naturalCompare } from './pages.js';

export const VIDEO_RE = /\.(mkv|mp4|m4v|webm|avi|mov|wmv|flv|ts|m2ts|ogm)$/i;
const EXTRA_DIR = /^(specials?|extras?|ovas?|oads?|sp|bonus|featurettes?|creditless|ncop|nced|omake)$/i;
const SEASON_DIR = /^(season|series|s|part|cour)[\s._-]*\d+$|^\d+(st|nd|rd|th)[\s._-]+season$/i;
const NOISE = /\b(2160p|1440p|1080p|1080i|720p|576p|480p|4k|uhd|bd|bdrip|bluray|blu-ray|brrip|web-?dl|web-?rip|webrip|hdtv|dvd(rip)?|x26[45]|h\.?26[45]|hevc|avc|av1|aac|flac|opus|ac3|dts|10[ -]?bit|8[ -]?bit|hi10p?|dual[ -]?audio|multi[ -]?subs?|eng(lish)? ?sub(bed|s)?|batch|complete|uncensored|remux|raw)\b/gi;

/** Season / episode from a video file name. Handles fansub and scene styles. */
export function parseEpisode(fileName) {
  let n = fileName.replace(VIDEO_RE, '');
  if (!/ /.test(n)) n = n.replace(/[._]+/g, ' ');           // Show.Name.S01E05.1080p → words
  n = n.replace(/\[[^\]]*\]|【[^】]*】/g, ' ').replace(/\((?:[^)]*\b(?:\d{3,4}p|bd|web|hevc|x26[45]|flac|aac|10bit|dual)[^)]*|[0-9a-f]{8})\)/gi, ' ');
  n = n.replace(/\s+/g, ' ').trim();

  let m;
  if ((m = n.match(/\bS(\d{1,2})[ ._-]?E(\d{1,4})(?:v\d)?\b/i))) return { season: +m[1], number: +m[2], special: false };
  if ((m = n.match(/\b(\d{1,2})x(\d{2,3})\b/i))) return { season: +m[1], number: +m[2], special: false };
  if (/\b(nc ?op|nc ?ed|ncop|nced|creditless)\b/i.test(n)) {
    m = n.match(/\b(?:nc ?op|nc ?ed)\s*(\d+)?/i);
    return { season: null, number: m?.[1] ? +m[1] : null, special: true };
  }
  if ((m = n.match(/\b(?:ova|oad|ona|sp|special|specials)[ ._-]*(\d{1,3})\b/i))) return { season: null, number: +m[1], special: true };
  if ((m = n.match(/\b(?:episode|ep)[ ._-]*(\d{1,4}(?:\.\d)?)/i)) || (m = n.match(/\bE(\d{1,4})\b/))) {
    return { season: null, number: +m[1], special: false };
  }
  if ((m = n.match(/(?:^|\s)-\s*(\d{1,4}(?:\.\d)?)(?:v\d)?(?=\s|$|-)/))) return { season: null, number: +m[1], special: false };
  if ((m = n.match(/#(\d{1,4})\b/))) return { season: null, number: +m[1], special: false };
  if (/\b(ova|oad|ona|special)\b/i.test(n)) return { season: null, number: null, special: true };

  // last loose number that is not a resolution / year / codec
  const loose = [...n.replace(NOISE, ' ').replace(/\b(season|part|cour)[ ._-]*\d+/gi, ' ').matchAll(/(?<![\w.])(\d{1,4})(?:v\d)?(?![\w.])/g)]
    .map((x) => +x[1]).filter((v) => ![480, 576, 720, 1080, 1280, 1440, 1920, 2160].includes(v));
  const pick = loose.filter((v) => !(v >= 1950 && v <= 2100)).pop(); // a lone year is not an episode number
  return { season: null, number: pick ?? null, special: false };
}

/** A folder/file name made searchable: no group tags, resolutions or codecs. */
export function cleanAnimeTitle(raw) {
  let t = raw.replace(VIDEO_RE, '');
  if (!/ /.test(t)) t = t.replace(/[._]+/g, ' ');
  // everything from the first technical tag on is not part of the name: "Bad Girl S01 720p WEB-DL …", "Black Cat 01-24 480p …"
  const cut = t.search(/\s(?:S\d{1,2}(?:E\d{1,3})?|\d{1,3}-\d{1,3}|(?:2160|1440|1080|720|576|480)p|BluRay|Blu-ray|BDRip|WEB-?DL|WEB-?Rip|HDTV|DVDRip|x26[45]|HEVC)(?=[\s\[(-]|$)/i);
  if (cut > 2) t = t.slice(0, cut);
  return t
    .replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】/g, ' ')
    .replace(NOISE, ' ')
    .replace(/\s*[-–]\s*(S\d{1,2}E\d{1,3}|\d{1,3})\s*$/i, ' ')
    .replace(/\bS\d{1,2}E\d{1,3}\b.*$/i, ' ')
    .replace(/\bseason[ ._-]*1\b/i, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A file name's own episode title: "Show - S01E02 - The Title WEBDL-720p.mkv" → "The Title". */
export function titleFromFileName(fileName) {
  let n = fileName.replace(VIDEO_RE, '');
  if (!/ /.test(n)) n = n.replace(/[._]+/g, ' ');
  const m = n.match(/(?:\bS\d{1,2}[ ._-]?E\d{1,4}(?:[-E]\d{1,4})?|\b\d{1,2}x\d{2,3}|\s[-–]\s\d{1,4}(?:v\d)?)\s*[-–:._ ]+\s*(\S.*)$/i);
  if (!m) return null;
  let t = m[1];
  const cut = t.search(/\s*[[(【]|\s+(?:2160p|1440p|1080p|720p|576p|480p|WEB-?DL|WEB-?Rip|WEBDL|Blu-?ray|BDRip|BD|HDTV|DVDRip|x26[45]|HEVC|AAC|FLAC|REPACK|PROPER)\b/i);
  if (cut === 0) return null;
  if (cut > 0) t = t.slice(0, cut);
  t = t.replace(/[\s._–-]+$/g, '').replace(/\s+/g, ' ').trim();
  if (t.length < 2 || /^\d+$/.test(t) || /^(episode|ep)\b/i.test(t)) return null;
  return t;
}

const toTitle = (ep) => {
  if (ep.special) return ep.number != null ? `Special ${ep.number}` : null;
  if (ep.number == null) return null;
  return `Episode ${ep.number}`;
};

async function listVideos(dir, out, extra) {
  let ents;
  try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isFile() && VIDEO_RE.test(e.name)) out.push({ path: full, name: e.name, extra });
    else if (e.isDirectory()) await listVideos(full, out, extra);
  }
}

/**
 * Find series ("units") under a library folder: a folder that directly holds videos is one series;
 * Specials / Extras / OVA sub-folders join their parent; every other sub-folder is a series of its own
 * (so "Show/Season 1", "Show/Season 2" become two entries that can each match AniList).
 */
async function collectUnits(dir, parentName, out) {
  let ents;
  try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  ents.sort((a, b) => naturalCompare(a.name, b.name));
  const files = [], subdirs = [];
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    if (e.isFile() && VIDEO_RE.test(e.name)) files.push({ path: path.join(dir, e.name), name: e.name, extra: false });
    else if (e.isDirectory()) subdirs.push(e);
  }
  const rest = [];
  for (const d of subdirs) {
    if (EXTRA_DIR.test(d.name)) await listVideos(path.join(dir, d.name), files, true);
    else rest.push(d);
  }
  const base = path.basename(dir);
  const children = [];
  for (const d of rest) await collectUnits(path.join(dir, d.name), base, children);
  if (files.length) {
    // videos lying directly in a show folder that also has a "Season 1" folder are part of that season
    const s1 = children.find((u) => path.dirname(u.path) === dir && showKey(u.title).season === 1);
    if (s1) s1.files.unshift(...files);
    else out.push({ path: dir, title: SEASON_DIR.test(base) && parentName ? `${parentName} ${base}` : base, files });
  }
  out.push(...children);
}

const SEASON_TAIL = /[\s._-]*(?:(?:season|series|s|part|cour)[\s._-]*(\d{1,2})|(\d{1,2})(?:st|nd|rd|th)[\s._-]+season)\s*$/i;

/** Comparable form of a show name: no groups, years or season suffix. { key, season } */
export function showKey(title) {
  let t = title.replace(/\[[^\]]*\]|【[^】]*】/g, ' ').replace(/\b(?:19|20)\d{2}\b/g, ' ').replace(/[._]+/g, ' ');
  let season = null;
  const m = t.match(SEASON_TAIL);
  if (m && m.index > 0) { season = +(m[1] || m[2]); t = t.slice(0, m.index); }
  const key = t.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return { key, season };
}

/** The show a loose file belongs to, from its name: "[Group] Bad Girl - S01E06 [1080p].mkv" → "Bad Girl". */
export function showOfFile(fileName) {
  let n = fileName.replace(VIDEO_RE, '');
  if (!/ /.test(n)) n = n.replace(/[._]+/g, ' ');
  n = n.replace(/^\s*(?:\[[^\]]*\]\s*)+/, '');
  const stop = /\s[-–]\s*\d{1,4}(?:v\d)?(?=\s|$|\[|\()|\bS\d{1,2}[ ._-]?E\d{1,4}\b|\bS\d{1,2}\b(?=\s|$)|\b\d{1,2}x\d{2,3}\b|\b(?:episode|ep)[ ._-]*\d|\bE\d{2,4}\b/i;
  const m = n.match(stop);
  let title = m && m.index > 0 ? n.slice(0, m.index) : n;
  title = title.replace(/\[[^\]]*\]|【[^】]*】|\((?:19|20)\d{2}\)/g, ' ').replace(NOISE, ' ')
    .replace(/[\s._–-]+$/g, '').replace(/\s+/g, ' ').trim();
  const ep = parseEpisode(fileName);
  const sk = showKey(title);
  return { title: title || n.trim(), key: sk.key, season: ep.season ?? sk.season ?? null, hasMarker: !!m };
}

const safeName = (s) => s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';

/**
 * Loose video files in a library root are filed under the show they belong to: into the folder of that
 * show when there is one (matching season), otherwise into a series made from the file names.
 */
function groupLoose(lib, units, loose) {
  const info = new Map(units.map((u) => [u, showKey(u.title)]));
  const taken = new Set(units.map((u) => u.path.toLowerCase()));
  const groups = new Map();
  for (const f of loose) {
    const s = showOfFile(f.name);
    if (!s.hasMarker) { // no episode marker: a movie or a one-off - its own series
      units.push({ path: f.path, title: f.name.replace(VIDEO_RE, ''), files: [f], single: true });
      continue;
    }
    const want = s.season ?? 1;
    const cands = units.filter((u) => info.get(u) && info.get(u).key === s.key && info.get(u).key);
    const target = cands.find((u) => info.get(u).season === want) || cands.find((u) => info.get(u).season == null);
    if (target) { target.files.push({ ...f, loose: true }); continue; }
    const gk = `${s.key}|${want}`;
    if (!groups.has(gk)) groups.set(gk, { season: want, titles: new Map(), files: [] });
    const g = groups.get(gk);
    g.files.push({ ...f, loose: true });
    g.titles.set(s.title, (g.titles.get(s.title) || 0) + 1);
  }
  for (const g of groups.values()) {
    const base = [...g.titles].sort((a, b) => b[1] - a[1])[0][0];
    const title = g.season > 1 ? `${base} Season ${g.season}` : base;
    let p = path.join(lib, safeName(title));
    while (taken.has(p.toLowerCase())) p += ' (files)';
    taken.add(p.toLowerCase());
    units.push({ path: p, title, files: g.files, virtual: true });
  }
}

/** Everything in a library root: sub-folders are series; loose video files join their show (see groupLoose). */
export async function collectLibrary(lib) {
  const ents = await fs.readdir(lib, { withFileTypes: true }); // throws when unreadable (caller leaves the library alone)
  const out = [], loose = [];
  for (const e of ents.sort((a, b) => naturalCompare(a.name, b.name))) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(lib, e.name);
    if (e.isFile() && VIDEO_RE.test(e.name)) loose.push({ path: full, name: e.name, extra: false });
    else if (e.isDirectory()) await collectUnits(full, null, out);
  }
  groupLoose(lib, out, loose);
  return out;
}

/** The current state of one series, found through its library (it may be a folder, or made from loose files). */
export async function collectOne(seriesPath, libraries) {
  const lib = libraries.map((l) => path.resolve(l)).find((l) => seriesPath === l || seriesPath.toLowerCase().startsWith(l.toLowerCase() + path.sep));
  if (!lib) return null;
  const units = await collectLibrary(lib);
  return units.find((u) => u.path.toLowerCase() === seriesPath.toLowerCase()) || null;
}

/** Upsert one series + its episodes. Progress follows renamed files (same size and episode number). */
export async function scanUnit(unit) {
  const eps = [];
  const unitSeason = showKey(unit.title).season; // "Show Season 2" → 2, so its files are S2 even when named "Show - 05"
  for (const f of unit.files) {
    let st;
    try { st = await fs.stat(f.path); } catch { continue; }
    const p = parseEpisode(f.name);
    const special = p.special || f.extra;
    eps.push({
      ...f, ...p, season: p.season ?? (special ? null : unitSeason), special, size: st.size, mtime: Math.round(st.mtimeMs),
      epName: titleFromFileName(f.name),
    });
  }
  if (!eps.length) return null;

  // the same episode can sit in the show's folder and loose in the library root: keep one copy (the folder's, else the larger file)
  let dupes = 0;
  {
    const keep = [], at = new Map();
    for (const e of [...eps].sort((a, b) => (!!a.loose - !!b.loose))) {
      if (e.special || e.number == null) { keep.push(e); continue; }
      const k = `${e.season ?? 1}:${e.number}`;
      if (!at.has(k)) { at.set(k, keep.length); keep.push(e); continue; }
      dupes++;
      const i = at.get(k);
      if (keep[i].loose && e.loose && e.size > keep[i].size) keep[i] = e;
    }
    eps.length = 0;
    eps.push(...keep);
  }
  const multiSeason = new Set(eps.filter((e) => !e.special && e.season != null).map((e) => e.season)).size > 1;
  for (const e of eps) {
    const base = toTitle(e);
    e.title = base ? (multiSeason && e.season != null && !e.special ? `S${e.season} · ${base}` : base)
      : e.name.replace(VIDEO_RE, '').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim() || e.name;
  }
  eps.sort((a, b) => (a.special - b.special)
    || ((a.season ?? 0) - (b.season ?? 0))
    || ((a.number ?? Infinity) - (b.number ?? Infinity))
    || naturalCompare(a.name, b.name));

  return tx(() => {
    let row = db.prepare('SELECT id FROM series WHERE path = ?').get(unit.path);
    let created = false;
    if (!row) {
      const r = db.prepare("INSERT INTO series (title, path, added_at, kind) VALUES (?, ?, ?, 'anime')").run(unit.title, unit.path, Date.now());
      row = { id: Number(r.lastInsertRowid) };
      created = true;
    } else {
      db.prepare("UPDATE series SET kind = 'anime' WHERE id = ? AND kind != 'anime'").run(row.id);
    }
    const old = db.prepare('SELECT id, path, size, number, season FROM episodes WHERE series_id = ?').all(row.id);
    const oldPaths = new Set(old.map((o) => o.path));
    const keep = new Set();
    const upsert = db.prepare(`INSERT INTO episodes (series_id, path, name, title, number, season, special, size, mtime, sort_idx, added_at, ep_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET series_id = excluded.series_id, name = excluded.name, title = excluded.title, ep_name = excluded.ep_name,
        number = excluded.number, season = excluded.season, special = excluded.special, sort_idx = excluded.sort_idx,
        probe = CASE WHEN episodes.size IS excluded.size AND episodes.mtime IS excluded.mtime THEN episodes.probe END,
        kf = CASE WHEN episodes.size IS excluded.size AND episodes.mtime IS excluded.mtime THEN episodes.kf END,
        duration = CASE WHEN episodes.size IS excluded.size AND episodes.mtime IS excluded.mtime THEN episodes.duration END,
        size = excluded.size, mtime = excluded.mtime`);
    eps.forEach((e, i) => {
      upsert.run(row.id, e.path, e.name, e.title, e.number, e.season, e.special ? 1 : 0, e.size, e.mtime, i, Date.now(), e.epName ?? null);
      keep.add(e.path);
    });
    const stale = old.filter((o) => !keep.has(o.path));
    const fresh = db.prepare('SELECT id, path, size, number, season FROM episodes WHERE series_id = ?').all(row.id).filter((f) => !oldPaths.has(f.path));
    const free = new Set(fresh.map((f) => f.id));
    let moved = 0;
    for (const s of stale) {
      if (!db.prepare('SELECT 1 FROM episode_progress WHERE episode_id = ?').get(s.id)) continue;
      const m = fresh.find((f) => free.has(f.id) && f.size === s.size && (f.number ?? null) === (s.number ?? null));
      if (!m) continue;
      db.prepare('UPDATE episode_progress SET episode_id = ? WHERE episode_id = ?').run(m.id, s.id);
      free.delete(m.id);
      moved++;
    }
    for (const s of stale) db.prepare('DELETE FROM episodes WHERE id = ?').run(s.id);
    return { id: row.id, created, added: fresh.length, removed: stale.length, moved, episodes: eps.length, dupes };
  });
}

const baseSet = (names) => new Set(names.map((n) => n.toLowerCase()));
const jaccard = (a, b) => {
  let hit = 0;
  for (const x of a) if (b.has(x)) hit++;
  return a.size + b.size - hit ? hit / (a.size + b.size - hit) : 0;
};

/** A folder that vanished + a new folder holding the same files is a rename: keep the series (progress, matches, edits). */
export function adoptAnimeRenames(units, inScope) {
  const present = new Set(units.map((u) => u.path));
  const known = db.prepare("SELECT id, path FROM series WHERE kind = 'anime'").all();
  const knownPaths = new Set(known.map((k) => k.path));
  const vanished = known.filter((k) => inScope(k.path) && !present.has(k.path));
  const fresh = units.filter((u) => !knownPaths.has(u.path));
  if (!vanished.length || !fresh.length) return 0;
  const taken = new Set();
  let adopted = 0;
  for (const f of fresh) {
    const names = baseSet(f.files.map((x) => x.name));
    let best = null, bestScore = 0;
    for (const v of vanished) {
      if (taken.has(v.id)) continue;
      const o = baseSet(db.prepare('SELECT name FROM episodes WHERE series_id = ?').all(v.id).map((r) => r.name));
      const score = o.size && names.size ? jaccard(o, names) : 0;
      if (score >= 0.6 && score > bestScore) { best = v; bestScore = score; }
    }
    if (!best) continue;
    taken.add(best.id);
    tx(() => {
      const from = best.path;
      db.prepare('UPDATE series SET path = ?, title = ? WHERE id = ?').run(f.path, f.title, best.id);
      for (const r of db.prepare('SELECT id, path FROM episodes WHERE series_id = ?').all(best.id)) {
        if (r.path.startsWith(from)) db.prepare('UPDATE episodes SET path = ? WHERE id = ?').run(f.path + r.path.slice(from.length), r.id);
      }
    });
    adopted++;
  }
  return adopted;
}
