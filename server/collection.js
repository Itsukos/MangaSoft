import { db } from './db.js';

/**
 * What the user is missing from a series, compared with what MangaDex lists as published (and AniList's
 * totals when it has them). Chapters that belong to a volume the user owns count as owned even when the
 * volume file isn't split into chapters yet, using MangaDex's chapter→volume mapping.
 */

const parse = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };

/** [1,2,3,7,9,10] -> ["1–3", "7", "9–10"] */
export function toRanges(nums) {
  const out = [];
  const a = [...nums].sort((x, y) => x - y);
  for (let i = 0; i < a.length;) {
    let j = i;
    while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++;
    out.push(i === j ? String(a[i]) : `${a[i]}–${a[j]}`);
    i = j + 1;
  }
  return out;
}

export function collectionFor(seriesId) {
  const s = db.prepare('SELECT status, chapters_total, volumes_total, catalog FROM series WHERE id = ?').get(seriesId);
  if (!s) return { known: false };
  const catalog = parse(s.catalog, null);

  // what exists: MangaDex's published chapters, topped up with AniList's total if that is higher
  const expected = new Map(); // integer chapter -> volume | null
  if (catalog) for (const [n, v] of catalog.chapters) expected.set(n, v);
  const top = expected.size ? Math.max(...expected.keys()) : 0;
  if (s.chapters_total && s.chapters_total > top) for (let n = top + 1; n <= s.chapters_total; n++) expected.set(n, null);
  if (!expected.size) return { known: false };

  const expectedVolumes = new Set(catalog?.volumes || []);
  if (!catalog && s.volumes_total) for (let v = 1; v <= s.volumes_total; v++) expectedVolumes.add(v);

  const rows = db.prepare('SELECT number, volume FROM chapters WHERE series_id = ?').all(seriesId);
  const ownedChapters = new Set(rows.filter((r) => r.number != null).map((r) => Math.floor(r.number)));
  const ownedVolumes = new Set(rows.filter((r) => r.volume != null).map((r) => r.volume));
  const unsplit = rows.filter((r) => r.number == null).length;

  const covered = (n) => ownedChapters.has(n) || (expected.get(n) != null && ownedVolumes.has(expected.get(n)));
  const missingChapters = [...expected.keys()].filter((n) => !covered(n)).sort((a, b) => a - b);
  const missingVolumes = [...expectedVolumes].filter((v) => !ownedVolumes.has(v)).sort((a, b) => a - b);
  const notInVolume = missingChapters.filter((n) => expected.get(n) == null).length;

  return {
    known: true,
    source: catalog ? 'MangaDex' : 'AniList',
    checked: catalog?.checked || null,
    ongoing: s.status === 'RELEASING',
    latestChapter: Math.max(...expected.keys()),
    chapters: {
      expected: expected.size, have: expected.size - missingChapters.length,
      missing: missingChapters.length, ranges: toRanges(missingChapters), notInVolume,
    },
    volumes: {
      expected: expectedVolumes.size, have: expectedVolumes.size - missingVolumes.length,
      missing: missingVolumes.length, ranges: toRanges(missingVolumes),
    },
    unsplit,
  };
}

/** Cheap count for the library grid. null when nothing is known about the series. */
export function missingCount(seriesId) {
  const c = collectionFor(seriesId);
  return c.known ? c.chapters.missing : null;
}
