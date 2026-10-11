import { db, getSetting } from './db.js';
import * as al from './anilist.js';

/**
 * Social page: your AniList friends' activity (what they watched / read / posted), likes, and adding things to
 * your lists. Everything is read from and written to AniList with the account connected in Settings.
 */

const FEED = `
query ($page: Int, $following: Boolean, $types: [ActivityType], $userId: Int) {
  Page(page: $page, perPage: 25) {
    pageInfo { hasNextPage currentPage }
    activities(isFollowing: $following, type_in: $types, userId: $userId, sort: ID_DESC) {
      __typename
      ... on ListActivity {
        id status progress createdAt likeCount replyCount isLiked siteUrl
        user { id name avatar { medium } }
        media { id type format episodes chapters title { romaji english } coverImage { medium large } mediaListEntry { status progress } }
      }
      ... on TextActivity {
        id text(asHtml: true) createdAt likeCount replyCount isLiked siteUrl
        user { id name avatar { medium } }
      }
      ... on MessageActivity {
        id message(asHtml: true) createdAt likeCount replyCount isLiked siteUrl
        messenger { id name avatar { medium } }
        recipient { id name }
      }
    }
  }
}`;

const TYPES = {
  everything: ['ANIME_LIST', 'MANGA_LIST', 'TEXT'],
  anime: ['ANIME_LIST'],
  manga: ['MANGA_LIST'],
  posts: ['TEXT'],
};

const STATUSES = ['CURRENT', 'PLANNING', 'COMPLETED', 'DROPPED', 'PAUSED', 'REPEATING'];

let followCache = { at: 0, list: [] };

export function mountSocial(app, { wrap }) {
  const viewer = () => getSetting('anilist_user');
  const needAuth = (res) => {
    if (getSetting('anilist_token') && viewer()) return true;
    res.status(401).json({ error: 'Connect your AniList account in Settings first', notConnected: true });
    return false;
  };

  /** Which of these AniList entries are in the library: { 'ANIME:123': seriesId }. */
  const inLibrary = (medias) => {
    const out = new Map();
    const ids = [...new Set(medias.map((m) => m.id))];
    if (!ids.length) return out;
    const rows = db.prepare(`SELECT COALESCE(merged_into, id) AS id, kind, anilist_id FROM series
      WHERE anilist_id IN (${ids.map(() => '?').join(',')}) AND kind IN ('anime', 'manga')`).all(...ids);
    for (const r of rows) out.set(`${r.kind === 'anime' ? 'ANIME' : 'MANGA'}:${r.anilist_id}`, r.id);
    return out;
  };

  app.get('/api/social/feed', wrap(async (req, res) => {
    if (!needAuth(res)) return;
    const me = viewer();
    const scope = String(req.query.scope || 'following');
    const types = TYPES[String(req.query.type || 'everything')] || TYPES.everything;
    const vars = { page: Math.max(1, Number(req.query.page) | 0 || 1), types };
    if (scope === 'following') vars.following = true;
    else if (scope === 'global') vars.following = false;
    else if (scope === 'mine') vars.userId = me.id;
    else if (/^user:\d+$/.test(scope)) vars.userId = Number(scope.slice(5));
    else vars.following = true;
    const data = await al.gqlAuth(FEED, vars);
    const items = (data.Page.activities || []).filter((a) => a && a.id);
    const lib = inLibrary(items.filter((a) => a.media).map((a) => a.media));
    res.json({
      hasNext: !!data.Page.pageInfo?.hasNextPage, page: vars.page,
      items: items.map((a) => {
        const user = a.user || a.messenger || null;
        const base = {
          id: a.id, kind: a.__typename === 'ListActivity' ? 'list' : a.__typename === 'TextActivity' ? 'text' : 'message',
          at: (a.createdAt || 0) * 1000, likes: a.likeCount || 0, replies: a.replyCount || 0, liked: !!a.isLiked, url: a.siteUrl,
          user: user ? { id: user.id, name: user.name, avatar: user.avatar?.medium || null } : null,
        };
        if (a.__typename === 'ListActivity' && a.media) {
          const m = a.media;
          return {
            ...base, status: a.status, progress: a.progress,
            media: {
              id: m.id, type: m.type, format: m.format, title: m.title?.english || m.title?.romaji, cover: m.coverImage?.medium || null,
              total: m.type === 'ANIME' ? m.episodes : m.chapters,
              entry: m.mediaListEntry ? { status: m.mediaListEntry.status, progress: m.mediaListEntry.progress } : null,
              seriesId: lib.get(`${m.type}:${m.id}`) ?? null,
            },
          };
        }
        // AniList sends posts as (sanitised) HTML: images, links, centred text
        if (a.__typename === 'MessageActivity') return { ...base, text: a.message || '', html: true, to: a.recipient?.name || null };
        return { ...base, text: a.text || '', html: true };
      }),
    });
  }));

  app.get('/api/social/following', wrap(async (req, res) => {
    if (!needAuth(res)) return;
    if (Date.now() - followCache.at < 10 * 60 * 1000 && followCache.list.length) return res.json(followCache.list);
    const me = viewer();
    const out = [];
    for (let page = 1; page <= 4; page++) {
      const d = await al.gqlAuth(
        'query ($uid: Int!, $page: Int) { Page(page: $page, perPage: 50) { pageInfo { hasNextPage } following(userId: $uid, sort: USERNAME) { id name avatar { medium } } } }',
        { uid: me.id, page },
      );
      for (const u of d.Page.following || []) out.push({ id: u.id, name: u.name, avatar: u.avatar?.medium || null });
      if (!d.Page.pageInfo?.hasNextPage) break;
    }
    followCache = { at: Date.now(), list: out };
    res.json(out);
  }));

  app.post('/api/social/like', wrap(async (req, res) => {
    if (!needAuth(res)) return;
    const id = Number(req.body?.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad activity id' });
    const d = await al.gqlAuth(
      `mutation ($id: Int) { ToggleLikeV2(id: $id, type: ACTIVITY) {
        ... on ListActivity { isLiked likeCount } ... on TextActivity { isLiked likeCount } ... on MessageActivity { isLiked likeCount } } }`,
      { id },
    );
    const r = d.ToggleLikeV2 || {};
    res.json({ liked: !!r.isLiked, likes: r.likeCount ?? 0 });
  }));

  /** Add something to one of your lists (or move it): status is Watching/Reading, Planning, Completed… */
  app.post('/api/social/list', wrap(async (req, res) => {
    if (!needAuth(res)) return;
    const mediaId = Number(req.body?.mediaId);
    const status = String(req.body?.status || '');
    if (!Number.isInteger(mediaId) || !STATUSES.includes(status)) return res.status(400).json({ error: 'Pick a media entry and a list' });
    const saved = await al.saveEntry(mediaId, { status });
    res.json({ status: saved.status, progress: saved.progress });
  }));
}
