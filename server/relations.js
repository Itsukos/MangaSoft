import { db, getSetting } from './db.js';
import * as al from './anilist.js';

/**
 * Connections between series of different kinds: the manga a show was adapted from, the anime made from a
 * manga, sequels, and doujin that parody a series. Most are found automatically (AniList's own relations,
 * nhentai's parody tags); anything can also be linked or unlinked by hand.
 */

const INVERSE = { ADAPTATION: 'SOURCE', SOURCE: 'ADAPTATION', SEQUEL: 'PREQUEL', PREQUEL: 'SEQUEL', SIDE_STORY: 'PARENT', PARENT: 'SIDE_STORY' };
const LABEL = {
  ADAPTATION: 'Adaptation', SOURCE: 'Source', SEQUEL: 'Sequel', PREQUEL: 'Prequel', SIDE_STORY: 'Side story', PARENT: 'Main story',
  SPIN_OFF: 'Spin-off', ALTERNATIVE: 'Alternative version', CHARACTER: 'Shared characters', SUMMARY: 'Summary',
  COMPILATION: 'Compilation', CONTAINS: 'Contains', OTHER: 'Related', PARODY: 'Parody', PARODIED_BY: 'Parodied by doujin',
};

export function labelFor(link, viewerId, viewerKind, otherKind) {
  if (link.state === 'manual' || !link.rel) return 'Linked by you';
  if (link.rel === 'PARODY') return viewerKind === 'doujin' ? 'Parody of' : 'Doujin parody';
  const rel = link.src === viewerId ? link.rel : (INVERSE[link.rel] || link.rel);
  if (rel === 'ADAPTATION') return otherKind === 'anime' ? 'Anime adaptation' : otherKind === 'manga' ? 'Manga adaptation' : 'Adaptation';
  if (rel === 'SOURCE') return otherKind === 'manga' ? 'Source manga' : otherKind === 'anime' ? 'Source anime' : 'Source';
  return LABEL[rel] || 'Related';
}

const ordered = (x, y) => (x < y ? [x, y] : [y, x]);

function addLink(x, y, rel, src, state = 'auto') {
  if (x === y) return;
  const [a, b] = ordered(x, y);
  // an existing row (manual, or an auto link the user hid) is never overwritten
  db.prepare('INSERT OR IGNORE INTO series_links (a, b, rel, src, state) VALUES (?, ?, ?, ?, ?)').run(a, b, rel, src, state);
}

// Latin text loses its accents (Ōkami = Okami); Japanese / Chinese / Korean text is kept as it is
const norm = (s) => (s || '').toLowerCase().normalize('NFKC')
  .replace(/\p{Script=Latin}+/gu, (m) => m.normalize('NFKD').replace(/\p{M}+/gu, ''))
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// long vowels differ between romanisations (Ookami / Ohkami / Okami, Yuusha / Yusha)
const loose = (s) => norm(s).replace(/ou|oo|oh/g, 'o').replace(/uu/g, 'u');
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const usable = (n) => { const t = n.trim(); return t.length >= 4 || (CJK.test(t) && t.length >= 3); };
/** Every spelling worth comparing: as written, and with the romanisation differences smoothed over. */
const forms = (s) => {
  const a = norm(s);
  if (!a) return [];
  const b = loose(s);
  return [...new Set([a, b])].map((x) => ` ${x} `).filter(usable);
};

/** Local part: turn stored AniList relations and nhentai parody tags into links. No network. */
export function linkAuto() {
  const byAnilist = new Map();
  for (const s of db.prepare("SELECT id, kind, anilist_id FROM series WHERE anilist_id IS NOT NULL AND kind IN ('manga', 'anime', 'novel') AND merged_into IS NULL").all()) {
    byAnilist.set(`${s.kind === 'anime' ? 'ANIME' : 'MANGA'}:${s.anilist_id}`, s.id);
  }
  for (const s of db.prepare('SELECT id, rel_json FROM series WHERE rel_json IS NOT NULL').all()) {
    let edges = [];
    try { edges = JSON.parse(s.rel_json) || []; } catch { /* ignore */ }
    for (const e of edges) {
      const other = byAnilist.get(`${e.type}:${e.id}`);
      if (other) addLink(s.id, other, e.rel, s.id);
    }
  }

  // doujin ↔ the series they parody (parody tag equals / is a whole-word part of a title)
  // every name a series is known by: English, romaji, native (Japanese), the folder name and AniList's synonyms
  const targets = db.prepare("SELECT id, title, title_english, title_romaji, title_native, synonyms FROM series WHERE kind IN ('manga', 'anime', 'novel')").all()
    .map((t) => {
      let syn = [];
      try { syn = JSON.parse(t.synonyms || '[]') || []; } catch { /* none */ }
      return { id: t.id, names: [...new Set([t.title_english, t.title_romaji, t.title_native, t.title, ...syn].filter(Boolean).flatMap(forms))] };
    });
  for (const d of db.prepare("SELECT id, nh_meta FROM series WHERE kind = 'doujin' AND nh_meta IS NOT NULL").all()) {
    let meta = {};
    try { meta = JSON.parse(d.nh_meta) || {}; } catch { continue; }
    const parodies = (meta.tags || []).filter((t) => t.type === 'parody' && norm(t.name) !== 'original').flatMap((t) => forms(t.name));
    if (!parodies.length) continue;
    for (const t of targets) {
      if (t.names.some((n) => parodies.some((p) => n === p || n.includes(p) || p.includes(n)))) addLink(d.id, t.id, 'PARODY', d.id);
    }
  }
}

let running = false;

/** Ask AniList which entries are related to each matched manga/anime (cached for two weeks), then link. */
export async function relationsPass() {
  if (running) return;
  running = true;
  try {
    if (getSetting('auto_match', true)) {
      const stale = Date.now() - 14 * 24 * 3600 * 1000;
      const rows = db.prepare(`SELECT id, kind, anilist_id FROM series
        WHERE anilist_id IS NOT NULL AND kind IN ('manga', 'anime', 'novel')
          AND (rel_checked IS NULL OR rel_checked < ? OR (rel_json LIKE '[{%' AND rel_json NOT LIKE '%"title"%'))`).all(stale);
      for (const s of rows) {
        try {
          const edges = await al.getRelations(s.anilist_id, s.kind === 'anime' ? 'ANIME' : 'MANGA');
          db.prepare('UPDATE series SET rel_json = ?, rel_checked = ? WHERE id = ?').run(JSON.stringify(edges), Date.now(), s.id);
        } catch (e) {
          if (e.status === 401 || /rate/i.test(e.message)) break; // try again after the next scan
        }
      }
    }
    linkAuto();
  } finally { running = false; }
}

export function mountRelations(app, { wrap, unlocked }) {
  const row = (id) => db.prepare('SELECT id, kind FROM series WHERE id = ?').get(id);

  app.get('/api/series/:id/related', (req, res) => {
    const me = row(Number(req.params.id));
    if (!me) return res.sendStatus(404);
    linkAuto();
    const open = unlocked(req);
    const rows = db.prepare(`
      SELECT l.a, l.b, l.rel, l.src, l.state, s.id, s.kind, s.title, s.title_english, s.title_romaji, s.year, s.match_state
      FROM series_links l JOIN series s ON s.id = CASE WHEN l.a = ? THEN l.b ELSE l.a END
      WHERE (l.a = ? OR l.b = ?) AND l.state != 'hidden'
      ORDER BY s.kind, LOWER(COALESCE(s.title_english, s.title_romaji, s.title))`).all(me.id, me.id, me.id);
    res.json(rows.filter((r) => open || r.kind !== 'doujin').map((r) => ({
      id: r.id, kind: r.kind, title: r.title_english || r.title_romaji || r.title, year: r.year,
      label: labelFor(r, me.id, me.kind, r.kind), manual: r.state === 'manual',
    })));
  });

  /** What AniList lists as related (movies, OVAs, spin-offs, sequels, source manga…) that is not in your library. */
  app.get('/api/series/:id/related-missing', wrap(async (req, res) => {
    const me = db.prepare('SELECT id, kind, anilist_id, rel_json FROM series WHERE id = ?').get(Number(req.params.id));
    if (!me) return res.sendStatus(404);
    // not fetched yet (or from before titles were kept): ask AniList now rather than waiting for the background pass
    if (me.anilist_id && me.kind !== 'doujin' && (!me.rel_json || (me.rel_json.startsWith('[{') && !me.rel_json.includes('"title"')))) {
      try {
        const fresh = await al.getRelations(me.anilist_id, me.kind === 'anime' ? 'ANIME' : 'MANGA');
        me.rel_json = JSON.stringify(fresh);
        db.prepare('UPDATE series SET rel_json = ?, rel_checked = ? WHERE id = ?').run(me.rel_json, Date.now(), me.id);
      } catch { /* offline: show nothing extra */ }
    }
    let edges = [];
    try { edges = JSON.parse(me.rel_json || '[]') || []; } catch { /* none */ }
    const have = new Set(db.prepare('SELECT kind, anilist_id FROM series WHERE anilist_id IS NOT NULL').all()
      .map((r) => `${r.kind === 'anime' ? 'ANIME' : 'MANGA'}:${r.anilist_id}`));
    res.json(edges.filter((e) => e.title && e.rel !== 'CHARACTER' && !have.has(`${e.type}:${e.id}`)).map((e) => ({
      anilistId: e.id, type: e.type, title: e.title, format: e.fmt, cover: e.cover, rel: e.rel,
      label: e.rel === 'SOURCE' && e.type === 'MANGA' ? 'Source manga' : e.rel === 'SOURCE' && e.type === 'ANIME' ? 'Source anime'
        : e.rel === 'ADAPTATION' ? (e.type === 'ANIME' ? 'Anime adaptation' : 'Manga adaptation') : (LABEL[e.rel] || 'Related'), url: `https://anilist.co/${String(e.type).toLowerCase()}/${e.id}`,
    })));
  }));

  app.post('/api/series/:id/related', (req, res) => {
    const me = row(Number(req.params.id)), other = row(Number(req.body?.otherId));
    if (!me || !other) return res.sendStatus(404);
    if (me.id === other.id) return res.status(400).json({ error: 'A series cannot be linked to itself' });
    if (!unlocked(req) && other.kind === 'doujin') return res.status(403).json({ error: 'locked', locked: true });
    const [a, b] = ordered(me.id, other.id);
    db.prepare(`INSERT INTO series_links (a, b, rel, src, state) VALUES (?, ?, NULL, NULL, 'manual')
      ON CONFLICT(a, b) DO UPDATE SET state = 'manual'`).run(a, b);
    res.json({ ok: true });
  });

  app.delete('/api/series/:id/related/:otherId', (req, res) => {
    const [a, b] = ordered(Number(req.params.id), Number(req.params.otherId));
    const l = db.prepare('SELECT state FROM series_links WHERE a = ? AND b = ?').get(a, b);
    if (!l) return res.json({ ok: true });
    // an automatic link is hidden (so it does not come back); one made by hand is simply removed
    if (l.state === 'manual') db.prepare('DELETE FROM series_links WHERE a = ? AND b = ?').run(a, b);
    else db.prepare("UPDATE series_links SET state = 'hidden' WHERE a = ? AND b = ?").run(a, b);
    res.json({ ok: true });
  });

  /** Find any series (manga, anime, doujin) by name, for the "link to…" picker. */
  app.get('/api/series-search', (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return res.json([]);
    const open = unlocked(req);
    const kindQ = ['manga', 'anime', 'doujin', 'novel'].includes(req.query.kind) ? req.query.kind : '';
    const rows = db.prepare(`
      SELECT id, kind, title, title_english, title_romaji, year FROM series
      WHERE merged_into IS NULL AND LOWER(COALESCE(title_english, '') || ' ' || COALESCE(title_romaji, '') || ' ' || COALESCE(title_native, '') || ' ' || title) LIKE ?
      AND (? = '' OR kind = ?)
      ORDER BY LOWER(COALESCE(title_english, title_romaji, title)) LIMIT 60`).all(`%${q.replace(/[%_]/g, '')}%`, kindQ, kindQ);
    res.json(rows.filter((r) => open || r.kind !== 'doujin').filter((r) => r.id !== Number(req.query.exclude))
      .slice(0, 20).map((r) => ({ id: r.id, kind: r.kind, title: r.title_english || r.title_romaji || r.title, year: r.year })));
  });
}
