import fs from 'node:fs/promises';
import path from 'node:path';
import { db, tx, getSetting } from './db.js';
import { IMG_RE, ARCHIVE_RE, naturalCompare, listZipImages, listDirImages, splitByChapterTag, clearPageCache } from './pages.js';
import { matchManga, anyProviderEnabled } from './matching.js';
import * as nh from './nhentai.js';
import * as md from './mangadex.js';
import { scanAnime, matchPendingAnime, probeMissing, mergePass, facetsPass, franchisePass } from './anime.js';
import { relationsPass } from './relations.js';
import { titlesPass } from './eptitles.js';
import { scanNovels, matchPendingNovels } from './novels.js';

export const scanState = { running: false, phase: 'idle', done: 0, total: 0, message: '', error: null, result: null };

const stripExt = (n) => n.replace(/\.(cbz|zip)$/i, '');

export function parseChapterNumber(name) {
  const clean = name.replace(/[\[(][^\])]*[\])]/g, ' ');
  let m = clean.match(/(?:chapter|chap|ch|c)[ ._-]*(\d+(?:\.\d+)?)/i);
  if (m) return parseFloat(m[1]);
  m = clean.match(/(?:^|[^a-z\d])#?(\d+(?:\.\d+)?)(?:[^a-z\d]|$)/i);
  if (m && !/vol(ume)?[ ._-]*\d+\s*$/i.test(clean)) return parseFloat(m[1]);
  return null;
}

/**
 * Volumes whose chapters start again at 1 ("Vol 2 / Chapter 1") are renumbered to carry on from the previous
 * volume (vol 1 ends at ch 10 → vol 2 starts at ch 11), which is how AniList and MangaDex count. Numbers that were
 * set explicitly (chapter tags in page names, or your own splits) are never changed; a volume that already
 * continues on is left alone.
 */
export function continueNumbering(items) {
  const vols = new Map();
  for (const it of items) {
    if (it.volume == null) continue;
    if (!vols.has(it.volume)) vols.set(it.volume, []);
    vols.get(it.volume).push(it);
  }
  let prevEnd = 0, changed = 0;
  for (const v of [...vols.keys()].sort((a, b) => a - b)) {
    const list = vols.get(v);
    const nums = list.filter((i) => i.number != null);
    if (!nums.length) continue;
    const min = Math.min(...nums.map((i) => i.number));
    const loose = nums.filter((i) => !i.fixed);
    if (loose.length && min <= prevEnd && loose.length === nums.length) {
      const shift = prevEnd + 1 - Math.min(...loose.map((i) => i.number));
      for (const it of loose) {
        const was = it.number;
        it.number = Math.round((it.number + shift) * 1000) / 1000;
        it.title = it.title.replace(/\b(chapter|chap|ch)\.?\s*0*\d+(?:\.\d+)?/i, (m, w) => `${w[0].toUpperCase()}${w.slice(1).toLowerCase()} ${it.number}`);
        if (it.number !== was) changed++;
      }
    }
    prevEnd = Math.max(prevEnd, ...list.filter((i) => i.number != null).map((i) => i.number));
  }
  return changed;
}

export function parseVolume(...names) {
  for (const n of names) {
    const m = n.match(/(?:volume|vol|v)[ ._-]*(\d+)/i);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

async function collect(dir, trail, out) {
  let ents;
  try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  ents.sort((a, b) => naturalCompare(a.name, b.name));

  if (ents.some((e) => e.isFile() && IMG_RE.test(e.name))) {
    out.push({ kind: 'dir', path: dir, title: path.basename(dir), trail });
  }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isFile() && ARCHIVE_RE.test(e.name)) {
      out.push({ kind: 'zip', path: full, title: stripExt(e.name), trail });
    } else if (e.isDirectory() && !e.name.startsWith('.')) {
      await collect(full, [...trail, e.name], out);
    }
  }
}

async function pageNames(ch) {
  try { return ch.kind === 'zip' ? await listZipImages(ch.path) : await listDirImages(ch.path); }
  catch { return []; }
}

/** Chapters defined by hand in the splitter UI (see /api/chapters/:id/splits). */
function manualGroups(file, pageTotal) {
  const row = db.prepare('SELECT starts, numbers, first_number FROM splits WHERE path = ?').get(file);
  if (!row) return null;
  let starts, numbers = null;
  try { starts = JSON.parse(row.starts); numbers = row.numbers ? JSON.parse(row.numbers) : null; } catch { return null; }
  let pairs = starts.map((st, i) => ({ start: st, number: numbers?.[i] ?? row.first_number + i }));
  pairs = pairs.filter((p) => Number.isInteger(p.start) && p.start >= 0 && p.start < pageTotal).sort((a, b) => a.start - b.start);
  if (!pairs.length) return null;
  if (pairs[0].start !== 0) pairs[0].start = 0; // pages before the first marker belong to the first chapter
  if (pairs.length < 2) return null;
  return pairs.map((p, i) => ({ number: p.number, start: p.start, end: pairs[i + 1]?.start ?? pageTotal }));
}

/** Re-read one series' folder/file. Returns { id, created, added, removed, moved, chapters } or null when nothing readable. */
export async function rescanSeries(seriesPath, title) {
  const kind = db.prepare('SELECT kind FROM series WHERE path = ?').get(seriesPath)?.kind || 'manga';
  const r = await scanSeries(seriesPath, title, kind);
  clearPageCache();
  return r;
}

async function scanSeries(seriesPath, title, kind = 'manga', _again = false) {
  const found = [];
  const st = await fs.stat(seriesPath);
  if (st.isFile()) {
    found.push({ kind: 'zip', path: seriesPath, title: stripExt(path.basename(seriesPath)), trail: [] });
  } else {
    await collect(seriesPath, [], found);
  }
  if (!found.length) return null;

  // Volumes whose page names carry chapter tags (…c003…p052) are split into real chapters.
  const expanded = [];
  for (const ch of found) {
    const names = await pageNames(ch);
    const volume = parseVolume(...ch.trail, ch.title);
    const groups = splitByChapterTag(names) || manualGroups(ch.path, names.length);
    if (groups) {
      for (const g of groups) {
        expanded.push({
          ...ch, number: g.number, volume, pageStart: g.start, pageEnd: g.end, pageCount: g.end - g.start, fixed: true,
          title: `${volume != null ? `Vol. ${volume} · ` : ''}Chapter ${g.number}`,
        });
      }
    } else {
      expanded.push({ ...ch, number: parseChapterNumber(ch.title), volume, pageStart: 0, pageEnd: null, pageCount: names.length });
    }
  }
  if (getSetting('chapter_continuous', true)) continueNumbering(expanded);
  found.length = 0;
  found.push(...expanded);
  found.sort((a, b) => {
    const na = a.number ?? Infinity, nb = b.number ?? Infinity;
    if (na !== nb) return na - nb;
    return naturalCompare(a.path, b.path) || a.pageStart - b.pageStart;
  });

  let movedSplits = false;
  const result = tx(() => {
    let row = db.prepare('SELECT id FROM series WHERE path = ?').get(seriesPath);
    let created = false;
    if (!row) {
      const r = db.prepare('INSERT INTO series (title, path, added_at, kind) VALUES (?, ?, ?, ?)')
        .run(title, seriesPath, Date.now(), kind);
      row = { id: Number(r.lastInsertRowid) };
      created = true;
    } else {
      db.prepare('UPDATE series SET kind = ? WHERE id = ? AND kind != ?').run(kind, row.id, kind);
    }

    const oldRows = db.prepare('SELECT id, path, page_start, number, volume, page_count FROM chapters WHERE series_id = ?').all(row.id);
    const oldKeys = new Set(oldRows.map((c) => `${c.path}#${c.page_start}`));
    const keep = new Set();
    const upsert = db.prepare(`INSERT INTO chapters (series_id, title, path, kind, number, volume, page_count, sort_idx, page_start, page_end)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path, page_start) DO UPDATE SET series_id = excluded.series_id, title = excluded.title, kind = excluded.kind,
        number = excluded.number, volume = excluded.volume, page_count = excluded.page_count, sort_idx = excluded.sort_idx,
        page_end = excluded.page_end`);
    found.forEach((ch, i) => {
      upsert.run(row.id, ch.title, ch.path, ch.kind, ch.number, ch.volume, ch.pageCount, i, ch.pageStart, ch.pageEnd);
      keep.add(`${ch.path}#${ch.pageStart}`);
    });

    const stale = oldRows.filter((c) => !keep.has(`${c.path}#${c.page_start}`));
    const fresh = db.prepare('SELECT id, path, page_start, number, volume, page_count FROM chapters WHERE series_id = ?').all(row.id)
      .filter((c) => !oldKeys.has(`${c.path}#${c.page_start}`));

    // a renamed file shows up as one stale + one fresh chapter: carry the reading progress across
    const freeFresh = new Set(fresh.map((f) => f.id));
    let moved = 0;
    for (const s of stale) {
      if (!db.prepare('SELECT 1 FROM progress WHERE chapter_id = ?').get(s.id)) continue;
      const match = fresh.find((f) => freeFresh.has(f.id) && f.volume === s.volume && f.page_count === s.page_count
        && (s.number === null ? f.number === null : f.number === s.number));
      if (!match) continue;
      db.prepare('UPDATE progress SET chapter_id = ? WHERE chapter_id = ?').run(match.id, s.id);
      freeFresh.delete(match.id);
      moved++;
    }
    // ...and manual chapter splits follow a renamed volume file (same total page count)
    const sum = (rows) => rows.reduce((n, r) => n + r.page_count, 0);
    const groupBy = (rows) => rows.reduce((m, r) => ((m[r.path] ||= []).push(r), m), {});
    const stalePaths = groupBy(stale), freshPaths = groupBy(fresh.filter((f) => !oldRows.some((o) => o.path === f.path)));
    for (const [oldPath, rows] of Object.entries(stalePaths)) {
      if (!db.prepare('SELECT 1 FROM splits WHERE path = ?').get(oldPath)) continue;
      const target = Object.entries(freshPaths).find(([p, r]) => sum(r) === sum(rows) && !db.prepare('SELECT 1 FROM splits WHERE path = ?').get(p));
      if (target) { db.prepare('UPDATE splits SET path = ? WHERE path = ?').run(target[0], oldPath); movedSplits = true; }
    }
    for (const c of stale) db.prepare('DELETE FROM chapters WHERE id = ?').run(c.id);

    return { id: row.id, created, added: fresh.length, removed: stale.length, moved, chapters: found.length };
  });

  // the splits moved to a renamed file only take effect on a second pass
  if (movedSplits && !_again) return scanSeries(seriesPath, title, kind, true);
  return result;
}

const norm = (p) => path.basename(p).replace(/\.(cbz|zip)$/i, '').toLowerCase();

/** What a series looks like on disk, as a cheap fingerprint (used to recognise a renamed folder). */
async function diskProfile(p) {
  const found = [];
  const st = await fs.stat(p);
  if (st.isFile()) found.push({ kind: 'zip', path: p, trail: [] }); else await collect(p, [], found);
  let pages = 0;
  const names = new Set();
  for (const ch of found) {
    pages += (await pageNames(ch)).length;
    names.add(norm(path.relative(p, ch.path) || p));
  }
  return { names, files: found.length, pages };
}

function dbProfile(s) {
  const rows = db.prepare('SELECT path, page_count FROM chapters WHERE series_id = ?').all(s.id);
  const names = new Set(rows.map((r) => norm(path.relative(s.path, r.path) || s.path)));
  return { names, files: new Set(rows.map((r) => r.path)).size, pages: rows.reduce((n, r) => n + r.page_count, 0) };
}

const jaccard = (a, b) => {
  let hit = 0;
  for (const x of a) if (b.has(x)) hit++;
  return a.size + b.size - hit ? hit / (a.size + b.size - hit) : 0;
};

/**
 * A series folder/file that vanished plus a new one with the same contents is a rename, not a delete + add:
 * re-point the existing series (so progress, matches and edits stay) before the scan runs.
 */
async function adoptRenames(targets, inScope) {
  const targetPaths = new Set(targets.map((t) => t.path));
  const known = db.prepare("SELECT id, path, kind FROM series WHERE kind IN ('manga', 'doujin')").all();
  const knownPaths = new Set(known.map((k) => k.path));
  const vanished = known.filter((k) => inScope(k.path) && !targetPaths.has(k.path));
  const fresh = targets.filter((t) => !knownPaths.has(t.path));
  if (!vanished.length || !fresh.length) return 0;

  const oldProfiles = new Map(vanished.map((v) => [v.id, dbProfile(v)]));
  const taken = new Set();
  let adopted = 0;
  for (const f of fresh) {
    let prof;
    try { prof = await diskProfile(f.path); } catch { continue; }
    if (!prof.pages) continue;
    let best = null, bestScore = 0;
    for (const v of vanished) {
      if (taken.has(v.id) || v.kind !== f.kind) continue;
      const o = oldProfiles.get(v.id);
      const overlap = o.names.size >= 2 && prof.names.size >= 2 ? jaccard(o.names, prof.names) : 0;
      const sameShape = o.files === prof.files && o.pages === prof.pages && prof.pages >= 60;
      const score = overlap >= 0.6 ? overlap : (sameShape ? 0.5 : 0);
      if (score > bestScore) { best = v; bestScore = score; }
    }
    if (!best) continue;
    taken.add(best.id);
    tx(() => {
      const from = best.path;
      db.prepare('UPDATE series SET path = ?, title = ? WHERE id = ?').run(f.path, f.title, best.id);
      for (const c of db.prepare('SELECT id, path FROM chapters WHERE series_id = ?').all(best.id)) {
        if (c.path.startsWith(from)) db.prepare('UPDATE chapters SET path = ? WHERE id = ?').run(f.path + c.path.slice(from.length), c.id);
      }
      for (const sp of db.prepare('SELECT path FROM splits').all()) {
        if (sp.path.startsWith(from)) db.prepare('UPDATE splits SET path = ? WHERE path = ?').run(f.path + sp.path.slice(from.length), sp.path);
      }
    });
    adopted++;
  }
  return adopted;
}

/**
 * Scan the configured libraries, or just one of them (`library` = its path).
 * Series in a library that cannot be read right now (NAS offline, drive unplugged) are left alone.
 */
export async function runScan({ rematch = false, library = null } = {}) {
  if (scanState.running) return;
  Object.assign(scanState, { running: true, phase: 'scanning', done: 0, total: 0, message: '', error: null, result: null });
  try {
    const scope = library ? path.resolve(library) : null;
    const inScope = (p) => !scope || p === scope || p.startsWith(scope + path.sep);
    const libraries = [
      ...getSetting('libraries', []).map((p) => ({ p, kind: 'manga' })),
      ...getSetting('doujin_libraries', []).map((p) => ({ p, kind: 'doujin' })),
    ].filter((l) => !scope || path.resolve(l.p) === scope);

    const unreadable = [];
    const targets = [];
    for (const { p: lib, kind } of libraries) {
      let ents;
      try { ents = await fs.readdir(lib, { withFileTypes: true }); }
      catch { scanState.message += `Cannot read ${lib}. `; unreadable.push(lib); continue; }
      for (const e of ents) {
        if (e.name.startsWith('.')) continue;
        if (e.isDirectory() || (e.isFile() && ARCHIVE_RE.test(e.name))) {
          targets.push({ path: path.join(lib, e.name), title: stripExt(e.name), kind });
        }
      }
    }
    scanState.total = targets.length;

    const count = (sql) => db.prepare(sql).get().n;
    const seriesBefore = count('SELECT COUNT(*) AS n FROM series');
    const renamed = await adoptRenames(targets, (p) => inScope(p) && !unreadable.some((u) => p.startsWith(u + path.sep)));

    const seen = new Set();
    let addedSeries = 0, addedChapters = 0, removedChapters = 0, movedProgress = 0;
    for (const t of targets) {
      const r = await scanSeries(t.path, t.title, t.kind).catch((e) => { scanState.message += `${t.title}: ${e.message}. `; return null; });
      if (r) {
        seen.add(r.id);
        if (r.created) addedSeries++;
        addedChapters += r.added; removedChapters += r.removed; movedProgress += r.moved;
      }
      scanState.done++;
    }
    // drop series that vanished from disk, but never because a library was merely unreachable
    let removedSeries = 0;
    for (const s of db.prepare("SELECT id, path FROM series WHERE kind IN ('manga', 'doujin')").all()) {
      if (seen.has(s.id) || !inScope(s.path)) continue;
      if (unreadable.some((u) => s.path.startsWith(u + path.sep))) continue;
      db.prepare('DELETE FROM series WHERE id = ?').run(s.id);
      removedSeries++;
    }
    // anime libraries (video files) are scanned by their own module
    const anime = await scanAnime({ scope, inScope, unreadable, state: scanState });
    const novels = await scanNovels({ scope, inScope, unreadable, state: scanState });
    scanState.result = {
      addedSeries: addedSeries + anime.addedSeries + novels.addedSeries, removedSeries: removedSeries + anime.removedSeries + novels.removedSeries,
      renamed: renamed + anime.renamed, addedChapters: addedChapters + novels.addedChapters, removedChapters: removedChapters + novels.removedChapters,
      addedEpisodes: anime.addedEpisodes, removedEpisodes: anime.removedEpisodes,
      movedProgress: movedProgress + anime.movedProgress + novels.movedProgress, duplicateFiles: anime.duplicateFiles,
      library: scope, unreadable, total: count('SELECT COUNT(*) AS n FROM series'), before: seriesBefore, at: Date.now(),
    };
    clearPageCache();

    if (anyProviderEnabled()) {
      const pending = db.prepare(
        `SELECT id, title FROM series WHERE kind = 'manga' AND ${rematch ? "match_state != 'manual'" : "match_state IN ('none')"}`,
      ).all();
      scanState.phase = 'matching';
      scanState.done = 0;
      scanState.total = pending.length;
      for (const s of pending) {
        scanState.message = `Matching “${s.title}”`;
        try { await matchManga(s); } catch (e) { scanState.error = `AniList: ${e.message}`; break; }
        scanState.done++;
      }
      if (!scanState.error) scanState.message = '';
    }

    // light novels: AniList (MANGA entries whose format is NOVEL)
    await matchPendingNovels({ rematch, state: scanState });

    // anime: AniList (type ANIME), then read durations/tracks in the background
    await matchPendingAnime({ rematch, state: scanState });
    mergePass();
    probeMissing();

    facetsPass().then(() => relationsPass()).then(() => franchisePass()).then(() => titlesPass()).catch(() => {}); // links between manga / anime / doujin, then episode titles, in the background

    // series AniList couldn't match earlier: try MangaDex once, then retry weekly
    if (getSetting('mangadex_fallback', true)) {
      const weekAgo2 = Date.now() - 7 * 24 * 3600 * 1000;
      const lost = db.prepare(`SELECT id, title FROM series WHERE kind = 'manga' AND match_state = 'missing'
        AND anilist_id IS NULL AND md_id IS NULL AND (md_checked IS NULL OR md_checked < ?)`).all(weekAgo2);
      if (lost.length) {
        scanState.phase = 'matching'; scanState.done = 0; scanState.total = lost.length;
        for (const s of lost) {
          scanState.message = `MangaDex: “${s.title}”`;
          try { await md.autoMatch(s); } catch { /* try again next scan */ }
          scanState.done++;
        }
        scanState.message = '';
      }
    }

    // official volume covers (MangaDex), for matched series we haven't looked up yet (retry misses weekly)
    if (getSetting('official_covers', true)) {
      const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
      const need = db.prepare(`SELECT id, title FROM series WHERE kind = 'manga' AND (anilist_id IS NOT NULL OR md_id IS NOT NULL)
        AND (md_checked IS NULL OR catalog IS NULL OR (md_id IS NULL AND md_checked < ?) OR (md_id IS NOT NULL AND md_checked < ?))`)
        .all(weekAgo, Date.now() - 3 * 24 * 3600 * 1000);
      if (need.length) {
        scanState.phase = 'matching'; scanState.done = 0; scanState.total = need.length;
        for (const s of need) {
          scanState.message = `Official covers: “${s.title}”`;
          try { await md.fetchSeries(s); } catch { /* optional extra: never fail the scan */ }
          scanState.done++;
        }
        scanState.message = '';
      }
    }

    // doujin: parse what the file name tells us, then (optionally) look the rest up on nhentai
    const pendingDj = db.prepare(
      `SELECT id, title FROM series WHERE kind = 'doujin' AND ${rematch ? "match_state != 'manual'" : "match_state = 'none'"}`,
    ).all();
    if (pendingDj.length) {
      for (const s of pendingDj) nh.applyLocal(s);
      if (getSetting('nh_auto_match', true) && !scanState.error) {
        scanState.phase = 'matching';
        scanState.done = 0;
        scanState.total = pendingDj.length;
        for (const s of pendingDj) {
          scanState.message = `Matching “${s.title}”`;
          try { await nh.autoMatch(s); } catch (e) { scanState.error = `nhentai: ${e.message}`; break; }
          scanState.done++;
        }
        if (!scanState.error) scanState.message = '';
      }
    }
  } catch (e) {
    scanState.error = e.message;
  } finally {
    scanState.running = false;
    scanState.phase = 'idle';
  }
}
