import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.MANGASOFT_DATA || path.join(root, 'data');
export const COVER_DIR = path.join(DATA_DIR, 'covers');
fs.mkdirSync(COVER_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'library.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS series (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  anilist_id INTEGER,
  match_state TEXT NOT NULL DEFAULT 'none',   -- none | auto | manual | missing
  title_romaji TEXT, title_english TEXT, title_native TEXT,
  description TEXT,
  genres TEXT,                -- JSON array
  authors TEXT,               -- JSON array of "Name (Role)"
  status TEXT, format TEXT,
  chapters_total INTEGER, volumes_total INTEGER,
  score INTEGER, year INTEGER,
  banner_url TEXT, cover_color TEXT, site_url TEXT,
  has_cover INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY,
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,         -- dir | zip
  number REAL,
  volume INTEGER,
  page_count INTEGER NOT NULL DEFAULT 0,
  sort_idx INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chapters_series ON chapters(series_id, sort_idx);
CREATE TABLE IF NOT EXISTS progress (
  chapter_id INTEGER PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
  page INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

// Migration: a chapter may be a page range inside one archive/folder (volumes split by
// chapter tags), so `path` is no longer unique on its own.
if (!db.prepare('PRAGMA table_info(chapters)').all().some((c) => c.name === 'page_start')) {
  db.exec('PRAGMA foreign_keys = OFF; BEGIN;');
  db.exec(`
    CREATE TABLE chapters_new (
      id INTEGER PRIMARY KEY,
      series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      path TEXT NOT NULL,
      kind TEXT NOT NULL,
      number REAL,
      volume INTEGER,
      page_count INTEGER NOT NULL DEFAULT 0,
      sort_idx INTEGER NOT NULL DEFAULT 0,
      page_start INTEGER NOT NULL DEFAULT 0,
      page_end INTEGER
    );
    INSERT INTO chapters_new (id, series_id, title, path, kind, number, volume, page_count, sort_idx)
      SELECT id, series_id, title, path, kind, number, volume, page_count, sort_idx FROM chapters;
    DROP TABLE chapters;
    ALTER TABLE chapters_new RENAME TO chapters;
    CREATE UNIQUE INDEX idx_chapters_loc ON chapters(path, page_start);
    CREATE INDEX idx_chapters_series ON chapters(series_id, sort_idx);
  `);
  db.exec('COMMIT; PRAGMA foreign_keys = ON;');
}

db.exec(`CREATE TABLE IF NOT EXISTS splits (
  path TEXT PRIMARY KEY,
  starts TEXT NOT NULL,          -- JSON array of page indices where chapters begin
  first_number REAL NOT NULL
)`);

if (!db.prepare('PRAGMA table_info(progress)').all().some((c) => c.name === 'pos')) {
  db.exec('ALTER TABLE progress ADD COLUMN pos REAL NOT NULL DEFAULT 0'); // light novels: how far down the section you are (0..1)
}

if (!db.prepare('PRAGMA table_info(splits)').all().some((c) => c.name === 'numbers')) {
  db.exec('ALTER TABLE splits ADD COLUMN numbers TEXT'); // JSON array aligned with `starts`
}

{
  const cols = db.prepare('PRAGMA table_info(series)').all().map((c) => c.name);
  if (!cols.includes('kind')) db.exec("ALTER TABLE series ADD COLUMN kind TEXT NOT NULL DEFAULT 'manga'"); // manga | doujin
  if (!cols.includes('nh_id')) db.exec('ALTER TABLE series ADD COLUMN nh_id INTEGER');
  if (!cols.includes('nh_meta')) db.exec('ALTER TABLE series ADD COLUMN nh_meta TEXT');
  if (!cols.includes('md_id')) db.exec('ALTER TABLE series ADD COLUMN md_id TEXT');          // MangaDex manga id
  if (!cols.includes('catalog')) db.exec('ALTER TABLE series ADD COLUMN catalog TEXT'); // published chapters/volumes per MangaDex
  if (!cols.includes('overrides')) db.exec('ALTER TABLE series ADD COLUMN overrides TEXT'); // JSON of the user's manual edits
  if (!cols.includes('meta_source')) db.exec('ALTER TABLE series ADD COLUMN meta_source TEXT'); // anilist | mangadex
  if (!cols.includes('md_checked')) db.exec('ALTER TABLE series ADD COLUMN md_checked INTEGER'); // last lookup (ms)
  if (!cols.includes('mal_id')) db.exec('ALTER TABLE series ADD COLUMN mal_id INTEGER'); // MyAnimeList id (episode titles)
  if (!cols.includes('ep_titles')) db.exec('ALTER TABLE series ADD COLUMN ep_titles TEXT'); // JSON { episode number: title }
  if (!cols.includes('ep_titles_checked')) db.exec('ALTER TABLE series ADD COLUMN ep_titles_checked INTEGER');
  if (!cols.includes('merged_into')) db.exec('ALTER TABLE series ADD COLUMN merged_into INTEGER'); // anime: shown under another series (same AniList entry)
  if (!cols.includes('merge_lock')) db.exec('ALTER TABLE series ADD COLUMN merge_lock INTEGER NOT NULL DEFAULT 0'); // user split it apart
  if (!cols.includes('rel_json')) db.exec('ALTER TABLE series ADD COLUMN rel_json TEXT'); // AniList relations: [{id, type, rel}]
  if (!cols.includes('rel_checked')) db.exec('ALTER TABLE series ADD COLUMN rel_checked INTEGER');
  if (!cols.includes('synonyms')) db.exec('ALTER TABLE series ADD COLUMN synonyms TEXT'); // AniList alternative titles, JSON array
  if (!cols.includes('show_title')) db.exec('ALTER TABLE series ADD COLUMN show_title TEXT'); // anime: name of the whole show (on its first entry)
  if (!cols.includes('air_season')) db.exec('ALTER TABLE series ADD COLUMN air_season TEXT'); // anime: WINTER | SPRING | SUMMER | FALL
  if (!cols.includes('air_year')) db.exec('ALTER TABLE series ADD COLUMN air_year INTEGER');
  if (!cols.includes('tags')) db.exec('ALTER TABLE series ADD COLUMN tags TEXT'); // AniList tags, JSON array of names (best first)
  if (!cols.includes('facets_checked')) db.exec('ALTER TABLE series ADD COLUMN facets_checked INTEGER');
  if (!cols.includes('parent_id')) db.exec('ALTER TABLE series ADD COLUMN parent_id INTEGER'); // anime: season of this show by hand (0 = on its own)
  if (!cols.includes('season_label')) db.exec('ALTER TABLE series ADD COLUMN season_label TEXT'); // custom name in the season bar ("S3 Part 2")
  if (!cols.includes('sections')) db.exec('ALTER TABLE series ADD COLUMN sections TEXT'); // anime: JSON [{season, number, label}] episode groups
  db.exec(`CREATE TABLE IF NOT EXISTS volume_covers (
    series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    volume INTEGER NOT NULL,
    file TEXT NOT NULL,        -- file in data/covers
    remote TEXT,               -- MangaDex file name it came from
    PRIMARY KEY (series_id, volume)
  )`);
}

// Links between series of any kind (manga <-> anime <-> doujin). a < b. state: auto | manual | hidden (an auto link the user removed)
db.exec(`CREATE TABLE IF NOT EXISTS series_links (
  a INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  b INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  rel TEXT,                      -- AniList relation type, PARODY, or NULL for manual
  src INTEGER,                   -- the series whose AniList entry listed the relation (gives it a direction)
  state TEXT NOT NULL DEFAULT 'auto',
  PRIMARY KEY (a, b)
)`);

// Anime: video files of a series (kind = 'anime'); chapters/progress above stay manga-only.
db.exec(`
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY,
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,           -- file name
  title TEXT NOT NULL,          -- what the list shows
  number REAL,
  season INTEGER,
  special INTEGER NOT NULL DEFAULT 0,
  size INTEGER,
  mtime INTEGER,
  duration REAL,
  probe TEXT,                   -- JSON from ffprobe (tracks, chapters)
  kf TEXT,                      -- JSON array of video keyframe times (for remuxing)
  sort_idx INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episodes_series ON episodes(series_id, sort_idx);
CREATE TABLE IF NOT EXISTS episode_progress (
  episode_id INTEGER PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
  position REAL NOT NULL DEFAULT 0,
  duration REAL,
  completed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
`);

if (!db.prepare('PRAGMA table_info(episodes)').all().some((c) => c.name === 'move_to')) {
  db.exec('ALTER TABLE episodes ADD COLUMN move_to INTEGER'); // shown under another series (movie / OVA / season) by hand
}
if (!db.prepare('PRAGMA table_info(episodes)').all().some((c) => c.name === 'ep_name')) {
  db.exec('ALTER TABLE episodes ADD COLUMN ep_name TEXT'); // episode title found in the file name
}

// AniList entries of a franchise that are not in the library (seasons you are missing): cached to number the ones you have
db.exec(`CREATE TABLE IF NOT EXISTS al_media (
  anilist_id INTEGER PRIMARY KEY,
  json TEXT NOT NULL,
  fetched INTEGER NOT NULL
)`);

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

export function setSetting(key, value) {
  if (value === null || value === undefined) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  } else {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }
}

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
