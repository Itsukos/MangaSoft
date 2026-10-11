'use strict';

// Social page: what your AniList friends watched / read / posted, likes, and adding to your lists.
// Loaded before app.js; uses $, view, api, esc, toast from there when a page is rendered.

const LIST_LABEL = (type) => ({
  CURRENT: type === 'MANGA' ? 'Reading' : 'Watching', PLANNING: type === 'MANGA' ? 'Plan to read' : 'Plan to watch',
  COMPLETED: 'Completed', PAUSED: 'On hold', DROPPED: 'Dropped', REPEATING: type === 'MANGA' ? 'Re-reading' : 'Re-watching',
});

const SAFE_TAGS = new Set(['A', 'IMG', 'BR', 'P', 'B', 'STRONG', 'I', 'EM', 'U', 'DEL', 'S', 'CENTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'UL', 'OL', 'LI', 'BLOCKQUOTE', 'CODE', 'PRE', 'HR', 'DIV', 'SPAN']);
const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'VIDEO', 'AUDIO', 'FORM', 'INPUT', 'BUTTON', 'LINK', 'META', 'SVG']);
/** AniList post HTML reduced to plain formatting, images and links (everything else is removed). */
function safeHtml(html) {
  const doc = new DOMParser().parseFromString(`<div id="r">${html}</div>`, 'text/html');
  const clean = (node) => {
    for (const ch of [...node.childNodes]) {
      if (ch.nodeType === 3) continue;
      if (ch.nodeType !== 1) { ch.remove(); continue; }
      const tag = ch.tagName;
      if (DROP_TAGS.has(tag)) { ch.remove(); continue; }
      clean(ch);
      if (!SAFE_TAGS.has(tag)) { ch.replaceWith(...ch.childNodes); continue; }
      for (const at of [...ch.attributes]) {
        const n = at.name.toLowerCase();
        const ok = (tag === 'A' && n === 'href') || (tag === 'IMG' && (n === 'src' || n === 'width' || n === 'alt'));
        if (!ok) ch.removeAttribute(at.name);
      }
      if (tag === 'A') {
        const h = ch.getAttribute('href') || '';
        if (!/^https?:\/\//i.test(h)) ch.removeAttribute('href');
        ch.setAttribute('target', '_blank'); ch.setAttribute('rel', 'noopener noreferrer');
      }
      if (tag === 'IMG') {
        const s = ch.getAttribute('src') || '';
        if (!/^https?:\/\//i.test(s)) { ch.remove(); continue; }
        const w = Number(ch.getAttribute('width'));
        if (!(w > 0 && w <= 900)) ch.removeAttribute('width');
        ch.setAttribute('loading', 'lazy'); ch.setAttribute('referrerpolicy', 'no-referrer');
      }
    }
  };
  const root = doc.getElementById('r');
  clean(root);
  return root.innerHTML;
}

function timeAgo(ms) {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24); if (d < 30) return `${d} d ago`;
  return new Date(ms).toLocaleDateString();
}

/** "Today", "Yesterday", "Monday", then the date. */
function dayLabel(ms) {
  const d = new Date(ms), now = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(now) - start(d)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

async function renderSocial() {
  const st = await api('/anilist/status').catch(() => ({}));
  if (!st.connected) {
    view.innerHTML = `<div class="empty"><div class="big">💬</div><h2>Social</h2>
      <p>Connect your AniList account to see what your friends are watching and reading, like their activity and add shows to your lists.</p>
      <a class="btn primary" href="#/settings">Connect AniList</a></div>`;
    return;
  }
  const K = (k) => `ms.social.${k}`;
  const get = (k, d) => { try { return sessionStorage.getItem(K(k)) || d; } catch { return d; } };
  const put = (k, v) => { try { sessionStorage.setItem(K(k), v); } catch { /* private mode */ } };
  let scope = get('scope', 'following');
  let type = get('type', 'everything');
  let page = 1;
  let busy = false;
  let lastDay = '';
  let friends = [];

  view.innerHTML = `
    <div class="social">
      <div class="socialbar">
        <div class="seg" id="scopeSeg"></div>
        <div class="seg" id="typeSeg"></div>
        <span style="flex:1"></span>
        <button class="btn small" id="refresh">↻ Refresh</button>
      </div>
      <div class="socialgrid">
        <div class="socialmain">
          <div id="feed" class="feed"></div>
          <div id="moreWrap" style="text-align:center;margin:18px 0"></div>
        </div>
        <aside class="friendside">
          <h3>Following</h3>
          <div id="friends" class="friendlist"></div>
        </aside>
      </div>
    </div>`;

  const scopes = [['following', 'Following'], ['global', 'Global'], ['mine', 'You']];
  const types = [['everything', 'All'], ['anime', 'Anime'], ['manga', 'Manga'], ['posts', 'Posts']];
  const drawSegs = () => {
    $('#scopeSeg').innerHTML = scopes.map(([k, l]) => `<button class="${scope === k ? 'on' : ''}" data-k="${k}">${l}</button>`).join('');
    $('#typeSeg').innerHTML = types.map(([k, l]) => `<button class="${type === k ? 'on' : ''}" data-k="${k}">${l}</button>`).join('');
  };
  const drawFriends = () => {
    const userScope = scope.startsWith('user:');
    $('#friends').innerHTML = friends.length
      ? `<button class="friend ${userScope ? '' : 'on'}" data-all="1"><span class="av all">★</span><span>Everyone</span></button>`
        + friends.map((f) => `<button class="friend ${scope === `user:${f.id}` ? 'on' : ''}" data-id="${f.id}" title="${esc(f.name)}">
          <img class="av" src="${esc(f.avatar || '')}" alt="" onerror="this.style.visibility='hidden'"><span>${esc(f.name)}</span></button>`).join('')
      : '<div class="muted" style="padding:6px">Loading…</div>';
  };

  const openHref = (m) => (m.seriesId ? (m.type === 'ANIME' ? `#/anime/${m.seriesId}` : `#/series/${m.seriesId}`)
    : m.type === 'ANIME' ? `#/ani/${m.id}` : `https://anilist.co/manga/${m.id}`);
  const ext = (m) => (!m.seriesId && m.type !== 'ANIME' ? ' target="_blank" rel="noopener"' : '');
  const likeBtn = (a) => `<button class="like ${a.liked ? 'on' : ''}" data-id="${a.id}" title="Like">${a.liked ? '♥' : '♡'} <span>${a.likes}</span></button>`;
  const replies = (a) => `<a class="replies" href="${esc(a.url || '#')}" target="_blank" rel="noopener" title="Replies on AniList">💬 ${a.replies}</a>`;
  const avatar = (u) => (u ? `<img class="av" src="${esc(u.avatar || '')}" alt="" onerror="this.style.visibility='hidden'">` : '<span class="av"></span>');

  const itemHtml = (a) => {
    const u = a.user;
    if (a.kind === 'list' && a.media) {
      const m = a.media, own = m.entry;
      const what = `${a.status || ''}${a.progress ? ' ' + a.progress : ''}`.trim();
      const meta = [m.type === 'ANIME' ? 'Anime' : 'Manga', m.format && m.format !== m.type ? m.format.replace(/_/g, ' ') : '',
        m.total ? `${m.total} ${m.type === 'ANIME' ? 'episodes' : 'chapters'}` : ''].filter(Boolean).join(' · ');
      return `<article class="act" data-id="${a.id}">
        ${avatar(u)}
        <div class="actmain">
          <div class="acthead"><span><b>${esc(u?.name || '?')}</b> <span class="verb">${esc(what)}</span></span><span class="muted time">${timeAgo(a.at)}</span></div>
          <div class="actmedia">
            <a class="cov" href="${esc(openHref(m))}"${ext(m)}>${m.cover ? `<img src="${esc(m.cover)}" alt="" loading="lazy">` : ''}</a>
            <div class="actinfo">
              <a class="mtitle" href="${esc(openHref(m))}"${ext(m)}>${esc(m.title)}</a>
              <div class="muted">${esc(meta)}</div>
              <div class="badges">
                ${m.seriesId ? '<span class="pill lib">In your library</span>' : ''}
                ${own ? `<span class="pill own">${esc(LIST_LABEL(m.type)[own.status] || own.status)}${own.progress ? ` · ${own.progress}${m.total ? ' / ' + m.total : ''}` : ''}</span>` : ''}
              </div>
            </div>
          </div>
          <div class="actfoot">
            <div class="reacts">${likeBtn(a)}${replies(a)}</div>
            <div class="rowacts">
              <select class="addlist" data-mid="${m.id}" data-type="${m.type}" title="Your list">
                <option value="">${own ? 'Move to…' : '＋ Add to list'}</option>
                ${Object.entries(LIST_LABEL(m.type)).map(([k, l]) => `<option value="${k}" ${own?.status === k ? 'disabled' : ''}>${l}</option>`).join('')}
              </select>
              <a class="btn small" href="${esc(openHref(m))}"${ext(m)}>${m.seriesId ? 'Open' : 'Details'}</a>
            </div>
          </div>
        </div>
      </article>`;
    }
    return `<article class="act" data-id="${a.id}">
      ${avatar(u)}
      <div class="actmain">
        <div class="acthead"><span><b>${esc(u?.name || '?')}</b> <span class="verb">${a.kind === 'message' && a.to ? `sent a message to <b>${esc(a.to)}</b>` : 'posted'}</span></span><span class="muted time">${timeAgo(a.at)}</span></div>
        <div class="acttext">${(a.html ? safeHtml(a.text) : esc(a.text)).trim() || `<a href="${esc(a.url || '#')}" target="_blank" rel="noopener">Open this post on AniList ↗</a>`}</div>
        <div class="actfoot"><div class="reacts">${likeBtn(a)}${replies(a)}</div></div>
      </div>
    </article>`;
  };

  const feed = $('#feed');
  const load = async (reset) => {
    if (busy) return;
    busy = true;
    if (reset) { page = 1; lastDay = ''; feed.innerHTML = '<div class="muted" style="padding:24px">Loading…</div>'; $('#moreWrap').innerHTML = ''; }
    try {
      const r = await api(`/social/feed?scope=${encodeURIComponent(scope)}&type=${type}&page=${page}`);
      if (reset) feed.innerHTML = '';
      let html = '';
      for (const a of r.items) {
        const day = dayLabel(a.at);
        if (day !== lastDay) { html += `<h3 class="dayhead">${esc(day)}</h3>`; lastDay = day; }
        html += itemHtml(a);
      }
      if (!html && reset) html = `<div class="empty" style="padding:40px 10px">${scope === 'following' ? 'No activity from the people you follow yet.' : 'Nothing here yet.'}</div>`;
      feed.insertAdjacentHTML('beforeend', html);
      $('#moreWrap').innerHTML = r.hasNext ? '<button class="btn" id="moreBtn">Load more</button>' : '';
      $('#moreBtn')?.addEventListener('click', () => { page += 1; load(false); });
    } catch (e) {
      feed.innerHTML = `<div class="empty" style="padding:40px 10px">${esc(e.message)}</div>`;
    } finally { busy = false; }
  };

  $('#scopeSeg').addEventListener('click', (e) => {
    const k = e.target.dataset.k; if (!k) return;
    scope = k; put('scope', k); drawSegs(); drawFriends(); load(true);
  });
  $('#typeSeg').addEventListener('click', (e) => {
    const k = e.target.dataset.k; if (!k) return;
    type = k; put('type', k); drawSegs(); load(true);
  });
  $('#refresh').addEventListener('click', () => load(true));
  $('#friends').addEventListener('click', (e) => {
    const b = e.target.closest('.friend'); if (!b) return;
    if (b.dataset.all) scope = 'following';
    else { const key = `user:${b.dataset.id}`; scope = scope === key ? 'following' : key; }
    put('scope', scope); drawSegs(); drawFriends(); load(true);
  });

  feed.addEventListener('click', async (e) => {
    const like = e.target.closest('.like');
    if (!like) return;
    try {
      const r = await api('/social/like', { method: 'POST', body: { id: Number(like.dataset.id) } });
      like.classList.toggle('on', r.liked);
      like.innerHTML = `${r.liked ? '♥' : '♡'} <span>${r.likes}</span>`;
    } catch (err) { toast(err.message, true); }
  });
  feed.addEventListener('change', async (e) => {
    const sel = e.target.closest('.addlist');
    if (!sel || !sel.value) return;
    const status = sel.value;
    sel.disabled = true;
    try {
      await api('/social/list', { method: 'POST', body: { mediaId: Number(sel.dataset.mid), status } });
      const label = LIST_LABEL(sel.dataset.type)[status];
      toast(`Added to your list: ${label}`);
      // every card of the same title shows the new state
      feed.querySelectorAll(`.addlist[data-mid="${sel.dataset.mid}"]`).forEach((s2) => {
        s2.querySelector('option').textContent = 'Move to…';
        [...s2.options].forEach((o) => { o.disabled = o.value === status; });
        s2.value = '';
        const badges = s2.closest('.actmain').querySelector('.badges');
        let pill = badges.querySelector('.own');
        if (!pill) { pill = document.createElement('span'); pill.className = 'pill own'; badges.append(pill); }
        pill.textContent = label;
      });
    } catch (err) { toast(err.message, true); sel.value = ''; }
    finally { sel.disabled = false; }
  });

  drawSegs();
  drawFriends();
  load(true);
  api('/social/following').then((f) => { friends = f; drawFriends(); }).catch(() => { friends = []; $('#friends').innerHTML = ''; });
}
