import path from 'node:path';
import { db, COVER_DIR } from './db.js';

/**
 * Manual edits. A provider (AniList / MangaDex / nhentai) refresh rewrites a series' details, so anything the
 * user changed by hand is remembered in `series.overrides` and re-applied after every provider update.
 */

// override key -> [column, kind]
export const FIELDS = {
  title: ['title_english', 'text'],
  native: ['title_native', 'text'],
  description: ['description', 'text'],
  genres: ['genres', 'list'],
  authors: ['authors', 'list'],
  status: ['status', 'text'],
  year: ['year', 'int'],
  chapters: ['chapters_total', 'int'],
  volumes: ['volumes_total', 'int'],
};

export const customCoverFile = (id) => path.join(COVER_DIR, `custom-${id}.jpg`);

export function getOverrides(id) {
  const row = db.prepare('SELECT overrides FROM series WHERE id = ?').get(id);
  try { return JSON.parse(row?.overrides || '{}') || {}; } catch { return {}; }
}

export function saveOverrides(id, o) {
  db.prepare('UPDATE series SET overrides = ? WHERE id = ?').run(Object.keys(o).length ? JSON.stringify(o) : null, id);
}

/** Validate/clean one user-supplied value. Returns the value to store, or throws a user-facing Error. */
export function clean(key, value) {
  const kind = FIELDS[key]?.[1];
  if (!kind) throw new Error(`Unknown field: ${key}`);
  if (kind === 'text') return String(value ?? '').replace(/\r/g, '').trim();
  if (kind === 'int') {
    if (value === '' || value === null) return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 100000) throw new Error(`${key} must be a whole number`);
    return n;
  }
  const arr = Array.isArray(value) ? value : String(value ?? '').split(/[,\n]/);
  return [...new Set(arr.map((v) => String(v).trim()).filter(Boolean))].slice(0, 60);
}

/** Re-apply the user's edits on top of whatever a provider just wrote. */
export function applyOverrides(id) {
  const o = getOverrides(id);
  for (const [key, [col, kind]] of Object.entries(FIELDS)) {
    if (!(key in o)) continue;
    const v = kind === 'list' ? JSON.stringify(o[key]) : o[key];
    db.prepare(`UPDATE series SET ${col} = ? WHERE id = ?`).run(v === '' ? null : v, id);
  }
}
