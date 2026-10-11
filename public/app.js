'use strict';

// ---------- utils ----------
const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), isErr ? 6000 : 4500);
}

// ---------- preferences (per device) ----------
const THEMES = [
  { id: 'sakura', name: 'Sakura', colors: ['#fff3f7', '#ffe3ec', '#ec6a96'] },
  { id: 'sakura-night', name: 'Sakura Night', colors: ['#1d1219', '#3a2230', '#ff8fb4'] },
  { id: 'light', name: 'Daylight', colors: ['#f5f6f8', '#e9ecf1', '#4f6bed'] },
  { id: 'paper', name: 'Paper', colors: ['#f1e6cf', '#eadcbc', '#a8622a'] },
  { id: 'matcha', name: 'Matcha', colors: ['#eef3e6', '#dfe8cf', '#5d8a3a'] },
  { id: 'midnight', name: 'Midnight', colors: ['#0e1220', '#202842', '#7a9bff'] },
  { id: 'ocean', name: 'Ocean', colors: ['#0b1c26', '#194356', '#3fd0c9'] },
  { id: 'amoled', name: 'AMOLED', colors: ['#000000', '#181818', '#ff7aa8'] },
];
const DEFAULT_PREFS = { theme: 'sakura', mode: 'single', dir: 'rtl', fit: 'both', coverAlone: true, width: 800 };
const prefs = (() => {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem('ms.prefs') || '{}') }; }
  catch { return { ...DEFAULT_PREFS }; }
})();
function savePrefs() {
  try { localStorage.setItem('ms.prefs', JSON.stringify(prefs)); } catch { /* private mode */ }
  document.documentElement.dataset.theme = prefs.theme;
}
document.documentElement.dataset.theme = prefs.theme;

// ---------- router ----------
let cleanup = null;
async function route() {
  if (cleanup) { cleanup(); cleanup = null; }
  document.body.classList.remove('reading');
  $('#overlay').innerHTML = '';
  const [, page, id] = (location.hash || '#/').split('/');
  const section = page === 'settings' ? 'settings' : page === 'doujin' ? 'doujin' : page === 'novels' ? 'novels' : page === 'social' ? 'social' : (page === 'anime' || page === 'watch' || page === 'show' || page === 'ani') ? 'anime' : 'library';
  document.querySelectorAll('.nav .link').forEach((a) => a.classList.toggle('active', a.dataset.route === section));
  refreshNav();
  $('#nav').classList.remove('hidden');
  view.classList.remove('hidden');
  window.scrollTo(0, 0);
  try {
    if (page === 'series') await renderSeries(id);
    else if (page === 'read') await renderReader(id);
    else if (page === 'split') await renderSplitter(id);
    else if (page === 'settings') await renderSettings();
    else if (page === 'doujin') await renderDoujin();
    else if (page === 'novels') await renderLibrary('novel');
    else if (page === 'anime') await (id ? renderAnimeSeries(id) : renderAnimeLibrary());
    else if (page === 'show') await renderAnimeShow(id);
    else if (page === 'ani') await renderAnimeAni(id);
    else if (page === 'social') await renderSocial();
    else if (page === 'watch') await renderWatch(id);
    else await renderLibrary();
  } catch (e) {
    if (e.message === 'locked' && page !== 'doujin') { location.hash = '#/doujin'; return; }
    view.innerHTML = `<div class="empty"><div class="big">😿</div><p>${esc(e.message)}</p><a class="btn" href="#/">Back to library</a></div>`;
  }
}
window.addEventListener('hashchange', route);

/** Show the Doujin link only when that section is set up (and not hidden by the user). */
async function refreshNav() {
  try {
    const st = await api('/doujin/status');
    $('#navDoujin').classList.toggle('hidden', !(st.enabled && !st.hideNav));
    const an = await api('/anime/status');
    $('#navAnime').classList.toggle('hidden', !an.libraries.length);
    const nv = await api('/novels/status');
    $('#navNovels').classList.toggle('hidden', !nv.libraries.length);
    const al = await api('/anilist/status').catch(() => ({}));
    $('#navSocial').classList.toggle('hidden', !al.connected);
    const up = await api('/update/status');
    document.querySelector('.nav .link[data-route="settings"]').classList.toggle('has-update', !!up.available);
  } catch { /* ignore */ }
}

// ---------- scan status ----------
function scanSummary(r) {
  if (!r) return '';
  const parts = [];
  if (r.addedSeries) parts.push(`${r.addedSeries} new series`);
  if (r.addedChapters) parts.push(`${r.addedChapters} new chapter${r.addedChapters === 1 ? '' : 's'}`);
  if (r.addedEpisodes) parts.push(`${r.addedEpisodes} new episode${r.addedEpisodes === 1 ? '' : 's'}`);
  if (r.duplicateFiles) parts.push(`${r.duplicateFiles} duplicate file${r.duplicateFiles === 1 ? '' : 's'} skipped`);
  if (r.renamed) parts.push(`${r.renamed} renamed (progress kept)`);
  if (r.movedProgress) parts.push(`${r.movedProgress} renamed chapter${r.movedProgress === 1 ? '' : 's'} kept progress`);
  if (r.removedSeries) parts.push(`${r.removedSeries} removed`);
  if (r.unreadable?.length) parts.push(`couldn't read ${r.unreadable.length} folder${r.unreadable.length === 1 ? '' : 's'} (left untouched)`);
  return parts.length ? parts.join(' · ') : 'No changes found';
}

/** Wait for the running scan to finish (for pages that have no progress banner), then say what it found. */
async function watchScan(onDone) {
  for (let i = 0; i < 600; i++) {
    const st = await api('/scan').catch(() => null);
    if (st && !st.running) {
      if (st.result) toast(`Scan finished: ${scanSummary(st.result)}`, !!st.result.unreadable?.length);
      onDone?.(st);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function scanBanner(container, onDone, expectResult = false) {
  const s = await api('/scan').catch(() => null);
  if (!s) return;
  const slot = container.querySelector('#scanSlot');
  if (!slot) return;
  if (s.running) {
    slot.innerHTML = `<div class="banner-msg"><div class="spinner"></div>
      <div>${s.phase === 'matching' ? 'Fetching AniList metadata' : 'Scanning library'}
      ${s.total ? `(${s.done}/${s.total})` : ''} <span class="muted">${esc(s.message)}</span></div></div>`;
    const t = setTimeout(() => scanBanner(container, onDone, true), 1500);
    const prev = cleanup;
    cleanup = () => { clearTimeout(t); prev?.(); };
  } else {
    slot.innerHTML = s.error ? `<div class="banner-msg">⚠️ ${esc(s.error)}</div>` : '';
    if ((container.dataset.wasRunning || expectResult) && s.result) toast(`Scan finished: ${scanSummary(s.result)}`, !!s.result.unreadable?.length);
    if (container.dataset.wasRunning) { delete container.dataset.wasRunning; onDone?.(); }
  }
  if (s.running) container.dataset.wasRunning = '1';
}

// ---------- library ----------
async function renderLibrary(kind = 'manga') {
  const dj = kind === 'doujin';
  const FK = `ms.filter.${kind}`;
  const [lib, cont] = await Promise.all([api(`/library?kind=${kind}`), api(`/continue?kind=${kind}`).catch(() => [])]);
  const sort = sessionStorage.getItem('ms.sort') || 'title';
  // filters (same bar as the anime library): search, searchable multi-selects, year / format / status
  const FKEY = `ms.f.${kind}`;
  let F = { q: '', sel: {}, year: '', format: '', status: '' };
  try { F = { ...F, ...JSON.parse(sessionStorage.getItem(FKEY) || '{}') }; } catch { /* fresh */ }
  F.sel = F.sel && typeof F.sel === 'object' ? F.sel : {};
  try { // a genre / tag clicked on a series page, or an artist / circle clicked on a doujin page
    const xf = sessionStorage.getItem(`ms.facet.${kind}`);
    const xq = dj ? sessionStorage.getItem('ms.q.doujin') : null;
    if (xf || xq) {
      F = { q: '', sel: {}, year: '', format: '', status: '' };
      if (xf) F.sel.tags = [xf];
      if (xq) F.q = xq;
    }
    sessionStorage.removeItem(`ms.facet.${kind}`);
    if (dj) sessionStorage.removeItem('ms.q.doujin');
  } catch { /* private mode */ }
  const saveF = () => { try { sessionStorage.setItem(FKEY, JSON.stringify(F)); } catch { /* private mode */ } };

  for (const x of lib) {
    x._h = (`${x.title} ${x.romaji || ''} ${x.native || ''} ${x.folderName} ` + (x.doujin
      ? [...x.doujin.artists, ...x.doujin.groups, ...x.doujin.parodies, ...x.doujin.characters, ...x.doujin.languages, ...x.doujin.tags].join(' ')
      : [...(x.genres || []), ...(x.tags || [])].join(' '))).toLowerCase();
  }

  // the fields offered: [key, label, values of one series, all? (every picked value must match)]
  // "Name (Story & Art)" -> Name; only the people who made it (not translators, letterers, editors)
  const authorsOf = (x) => (x.authors || []).map((n) => {
    const i = String(n).indexOf(' (');
    const name = i > 0 ? String(n).slice(0, i) : String(n);
    const role = i > 0 ? String(n).slice(i + 2, -1) : '';
    return /translat|letter|edit|proof|clean|typeset|redraw|cover/i.test(role) ? null : name.trim();
  }).filter(Boolean);
  const FIELDS = dj
    ? [['artists', 'Artist', (x) => x.doujin.artists], ['groups', 'Circle', (x) => x.doujin.groups], ['parodies', 'Parody', (x) => x.doujin.parodies],
      ['characters', 'Character', (x) => x.doujin.characters], ['languages', 'Language', (x) => x.doujin.languages],
      ['tags', 'Tags', (x) => x.doujin.tags, true]]
    : [['tags', 'Genres & Tags', (x) => [...(x.genres || []).map((g) => `genres:${g}`), ...(x.tags || []).map((t) => `tags:${t}`)], true],
      ['authors', 'Author / studio', authorsOf]];
  const countOf = (fn) => {
    const m = new Map();
    for (const x of lib) for (const k of new Set(fn(x) || [])) m.set(k, (m.get(k) || 0) + 1);
    return m;
  };
  const alphaBy = (a, b) => a.label.localeCompare(b.label);
  const optionsFor = ([key, , values]) => [...countOf(values)].map(([v, c]) => {
    const i = v.indexOf(':');
    const prefixed = key === 'tags' && !dj;
    return { value: v, label: prefixed ? v.slice(i + 1) : v, group: prefixed ? (v.startsWith('genres:') ? 'Genres' : 'Tags') : '', count: c };
  }).sort(alphaBy);
  const years = [...countOf((x) => (x.year ? [String(x.year)] : []))].sort((a, b) => b[0] - a[0]);
  const FORMAT_NAMES = { MANGA: 'Manga', NOVEL: 'Light novel', ONE_SHOT: 'One-shot', MANHWA: 'Manhwa', MANHUA: 'Manhua' };
  const STATUS_NAMES = { RELEASING: 'Publishing', FINISHED: 'Finished', NOT_YET_RELEASED: 'Not yet released', CANCELLED: 'Cancelled', HIATUS: 'Hiatus' };
  const formats = dj ? [] : [...countOf((x) => (x.format ? [x.format] : []))].sort((a, b) => b[1] - a[1]);
  const statuses = dj ? [] : [...countOf((x) => (x.status ? [x.status] : []))].sort((a, b) => b[1] - a[1]);
  const selBox = (id, label, opts, cur) => `<div class="fgroup"><label for="${id}">${label}</label>
    <select id="${id}"><option value="">Any</option>${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
  const fieldOpts = new Map(FIELDS.map((fd) => [fd[0], optionsFor(fd)]));

  view.innerHTML = `
    <div id="scanSlot"></div>
    <div id="cont"></div>
    <div class="filterbar">
      <div class="fgroup"><label for="q">Search</label><input type="search" id="q" placeholder="${dj ? `${lib.length} doujin…` : kind === 'novel' ? `${lib.length} novels…` : `${lib.length} series…`}" value="${esc(F.q)}"></div>
      ${FIELDS.filter((fd) => fieldOpts.get(fd[0]).length).map((fd) => `<div class="fgroup"><label>${fd[1]}</label><div id="fm-${fd[0]}"></div></div>`).join('')}
      ${!dj && years.length ? selBox('fYear', 'Year', years.map(([y, c]) => [y, `${y} (${c})`]), F.year) : ''}
      ${formats.length > 1 ? selBox('fFormat', 'Format', formats.map(([v, c]) => [v, `${FORMAT_NAMES[v] || v} (${c})`]), F.format) : ''}
      ${statuses.length > 1 ? selBox('fStatus', 'Status', statuses.map(([v, c]) => [v, `${STATUS_NAMES[v] || v} (${c})`]), F.status) : ''}
    </div>
    <div class="toolbar">
      <div class="chips" id="chips"></div>
      <span class="muted" id="fcount"></span>
      <button class="btn small hidden" id="fClear">✕ Clear filters</button>
      <select id="sort">
        <option value="title">Title</option><option value="added">Recently added</option><option value="read">Recently read</option>
      </select>
    </div>
    <div id="grid"></div>`;

  if (cont.length) {
    $('#cont').innerHTML = `<h2 style="margin-top:0">Continue reading</h2><div class="row-scroll">
      ${cont.map((c, i) => `<a class="card" href="#/read/${c.chapterId}" data-i="${i}">
        <div class="cover"><img loading="lazy" src="/api/series/${c.seriesId}/cover" alt="">
          <button class="more" title="More options (or right-click)">⋯</button>
          <button class="qtog" data-i="${i}" title="Mark this chapter read">✓ Read</button></div>
        <div class="name">${esc(c.title)}</div><div class="sub">${esc(c.chapterTitle)}</div></a>`).join('')}</div>`;
    const markCh = (cid, read) => api(`/chapters/${cid}/read`, { method: 'POST', body: { read } });
    $('#cont').addEventListener('click', async (e) => {
      const b = e.target.closest('.qtog'); if (!b) return;
      e.preventDefault(); e.stopPropagation();
      const c = cont[Number(b.dataset.i)];
      if (!c) return;
      try { await markCh(c.chapterId, true); toast(`${c.chapterTitle} marked read`); route(); } catch (err) { toast(err.message, true); }
    });
    bindCtx($('#cont'), '.card', (el) => {
      const c = cont[Number(el.dataset.i)];
      if (!c) return [];
      return [
        { label: `▶ Continue ${c.chapterTitle}`, run: () => { location.hash = `#/read/${c.chapterId}`; } },
        { label: `✓ Mark ${c.chapterTitle} read`, run: async () => { await markCh(c.chapterId, true); route(); } },
        c.last ? { label: `↺ Mark ${c.last.title} unread`, run: async () => { await markCh(c.last.id, false); route(); } } : null,
        { sep: true },
        { label: '✓ Mark the whole series read', run: async () => { await api(`/series/${c.seriesId}/read-all`, { method: 'POST', body: { read: true } }); route(); } },
        { label: '↺ Mark the whole series unread', run: async () => { await api(`/series/${c.seriesId}/read-all`, { method: 'POST', body: { read: false } }); route(); } },
        { label: '↗ Open series page', run: () => { location.hash = `#/series/${c.seriesId}`; } },
        { sep: true },
        { label: '✕ Remove from Continue reading', danger: true, run: async () => {
          await api('/continue/hide', { method: 'POST', body: { seriesId: c.seriesId, kind } }); route();
        } },
      ];
    });
  }

  const chips = [['all', 'All'], ['reading', 'In progress'], ['unread', 'Unread'], ['done', 'Completed'], ['match', 'Needs match']];
  const drawChips = () => {
    const f = sessionStorage.getItem(FK) || 'all';
    $('#chips').innerHTML = chips.map(([k, l]) => `<button class="chip ${f === k ? 'on' : ''}" data-k="${k}">${l}</button>`).join('');
  };
  const draw = () => {
    const f = sessionStorage.getItem(FK) || 'all';
    const s = $('#sort').value;
    const qq = F.q.trim().toLowerCase();
    const match = (x) => {
      if (qq && !x._h.includes(qq)) return false;
      for (const [key, , values, all] of FIELDS) {
        const picked = F.sel[key] || [];
        if (!picked.length) continue;
        const have = new Set(values(x) || []);
        if (all ? !picked.every((v) => have.has(v)) : !picked.some((v) => have.has(v))) return false;
      }
      if (F.year && String(x.year) !== F.year) return false;
      if (F.format && x.format !== F.format) return false;
      if (F.status && x.status !== F.status) return false;
      return true;
    };
    let items = lib.filter(match);
    const active = !!(qq || F.year || F.format || F.status || Object.values(F.sel).some((v) => v && v.length));
    $('#fClear').classList.toggle('hidden', !active);
    $('#fcount').textContent = active ? `${items.length} of ${lib.length}` : '';
    if (f === 'reading') items = items.filter((x) => x.readCount > 0 && x.readCount < x.chapterCount);
    if (f === 'unread') items = items.filter((x) => x.readCount === 0);
    if (f === 'match') items = items.filter((x) => (dj ? !x.nhId : (!x.anilistId && x.metaSource !== 'mangadex')) || x.matchState === 'none' || x.matchState === 'missing');
    if (f === 'done') items = items.filter((x) => x.chapterCount > 0 && x.readCount >= x.chapterCount);
    if (s === 'added') items.sort((a, b) => b.addedAt - a.addedAt);
    if (s === 'read') items.sort((a, b) => (b.lastRead || 0) - (a.lastRead || 0));
    if (!lib.length) {
      $('#grid').innerHTML = kind === 'novel'
        ? `<div class="empty"><div class="big">📖</div><h2>No light novels yet</h2>
           <p>Add a folder of .epub files in Settings → Light novel section.</p><a class="btn primary" href="#/settings">Open settings</a></div>`
        : dj
        ? `<div class="empty"><div class="big">📚</div><h2>No doujin yet</h2>
           <p>Add a folder in Settings → Doujin section. It stays separate from your manga.</p><a class="btn primary" href="#/settings">Open settings</a></div>`
        : `<div class="empty"><div class="big">🌸</div><h2>Your library is empty</h2>
           <p>Add a folder of manga in Settings and MangaSoft will do the rest.</p><a class="btn primary" href="#/settings">Open settings</a></div>`;
      return;
    }
    const cardHtml = (x) => {
      const left = x.chapterCount - x.readCount;
      const sub = dj
        ? [x.doujin.artists[0], x.doujin.pages ? `${x.doujin.pages} p` : ''].filter(Boolean).join(' · ')
        : kind === 'novel'
          ? `${x.chapterCount} vol${x.chapterCount === 1 ? '' : 's'}${x.year ? ' · ' + x.year : ''}`
          : `${x.chapterCount} ch${x.year ? ' · ' + x.year : ''}${x.missing ? ` · ${x.missing} missing` : ''}`;
      return `<a class="card" href="#/series/${x.id}" data-id="${x.id}">
        <div class="cover"><img loading="lazy" src="/api/series/${x.id}/cover" alt="">
          <button class="more" title="More options (or right-click)">⋯</button>
          ${left > 0 && x.readCount > 0 && !dj ? `<span class="badge">${left}</span>` : ''}
          ${x.matchState === 'missing' || x.matchState === 'none' ? '<span class="badge warn">no match</span>' : ''}
          ${x.chapterCount ? `<button class="qtog" data-sid="${x.id}" title="${x.readCount >= x.chapterCount ? 'Mark whole series unread' : 'Mark whole series read'}">${x.readCount >= x.chapterCount ? '↺ Unread' : '✓ Read'}</button>` : ''}
          <div class="bar"><i style="width:${x.chapterCount ? (x.readCount / x.chapterCount) * 100 : 0}%"></i></div></div>
        <div class="name">${esc(x.title)}</div>
        <div class="sub">${esc(sub)}</div></a>`;
    };
    // series without details (no AniList / MangaDex match) are kept apart, so the main shelf stays tidy
    const unmatched = (x) => !dj && !x.anilistId && x.metaSource !== 'mangadex';
    const main = items.filter((x) => !unmatched(x)), rest = items.filter(unmatched);
    $('#grid').innerHTML = (main.length ? `<div class="grid">${main.map(cardHtml).join('')}</div>` : (rest.length ? '' : '<div class="empty">Nothing matches.</div>'))
      + (rest.length ? `<h2 class="unmatched-h">Not matched yet <span class="muted">(${rest.length})</span></h2>
        <p class="muted" style="margin-top:-4px">These have no AniList details yet. Open one and use <b>Fix metadata</b> to match it, or run <b>Rescan &amp; re-match</b> in Settings.</p>
        <div class="grid">${rest.map(cardHtml).join('')}</div>` : '');
  };
  $('#sort').value = sort;
  drawChips(); draw();
  const multis = {};
  for (const [key, label] of FIELDS) {
    const host = $(`#fm-${key}`);
    if (!host) continue;
    multis[key] = makeMultiSelect(host, {
      options: fieldOpts.get(key), selected: F.sel[key] || [], any: 'Any', placeholder: `Search ${label.toLowerCase()}…`,
      onChange: (v) => { F.sel[key] = v; saveF(); draw(); },
    });
  }
  $('#q').addEventListener('input', (e) => { F.q = e.target.value; saveF(); draw(); });
  for (const [id, key] of [['#fYear', 'year'], ['#fFormat', 'format'], ['#fStatus', 'status']]) {
    $(id)?.addEventListener('change', (e) => { F[key] = e.target.value; saveF(); draw(); });
  }
  $('#fClear').addEventListener('click', () => {
    F = { q: '', sel: {}, year: '', format: '', status: '' };
    saveF();
    $('#q').value = '';
    for (const id of ['#fYear', '#fFormat', '#fStatus']) if ($(id)) $(id).value = '';
    Object.values(multis).forEach((m) => m.clear());
    draw();
  });
  $('#sort').addEventListener('change', (e) => { sessionStorage.setItem('ms.sort', e.target.value); draw(); });
  $('#grid').addEventListener('click', async (e) => {
    const b = e.target.closest('.qtog'); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const item = lib.find((x) => x.id === Number(b.dataset.sid));
    const makeRead = item.readCount < item.chapterCount;
    try {
      await api(`/series/${item.id}/read-all`, { method: 'POST', body: { read: makeRead } });
      item.readCount = makeRead ? item.chapterCount : 0;
      toast(`${item.title}: marked ${makeRead ? 'read' : 'unread'}`);
      draw();
    } catch (err) { toast(err.message, true); }
  });
  $('#chips').addEventListener('click', (e) => {
    const k = e.target.dataset.k; if (!k) return;
    sessionStorage.setItem(FK, k); drawChips(); draw();
  });
  bindCtx($('#grid'), '.card', (el) => {
    const x = lib.find((v) => v.id === Number(el.dataset.id));
    if (!x) return [];
    const setAll = (read) => async () => {
      await api(`/series/${x.id}/read-all`, { method: 'POST', body: { read } });
      x.readCount = read ? x.chapterCount : 0;
      toast(`${x.title}: marked ${read ? 'read' : 'unread'}`);
      draw();
    };
    const all = x.chapterCount > 0 && x.readCount >= x.chapterCount;
    return [
      { label: '↗ Open', run: () => { location.hash = `#/series/${x.id}`; } },
      x.chapterCount && !all ? { label: '✓ Mark all read', run: setAll(true) } : null,
      x.readCount > 0 ? { label: '↺ Mark all unread', run: setAll(false) } : null,
      x.readCount > 0 ? { label: '✕ Remove from Continue reading', run: async () => {
        await api('/continue/hide', { method: 'POST', body: { seriesId: x.id, kind } }); route();
      } } : null,
    ];
  });
  scanBanner(view, () => route());
}

// ---------- doujin section (optional PIN lock) ----------
async function renderDoujin() {
  const st = await api('/doujin/status');
  if (st.pinSet && !st.unlocked) return renderPinGate();
  if (!st.enabled) {
    view.innerHTML = `<div class="empty"><div class="big">📚</div><h2>Doujin section</h2>
      <p>Point it at a folder of its own, separate from your manga. Matching details come from nhentai.</p>
      <a class="btn primary" href="#/settings">Add a doujin folder</a></div>`;
    return;
  }
  await renderLibrary('doujin');
  if (st.pinSet) {
    $('.toolbar').insertAdjacentHTML('beforeend', '<button class="btn" id="lockBtn">🔒 Lock</button>');
    $('#lockBtn').addEventListener('click', async () => {
      await api('/doujin/lock', { method: 'POST' });
      sessionStorage.removeItem('ms.q.doujin');
      try { sessionStorage.removeItem('ms.f.doujin'); } catch { /* private mode */ }
      location.hash = '#/';
    });
  }
}

function renderPinGate() {
  view.innerHTML = `<div class="gate">
    <div class="big">🔒</div><h2>This section is locked</h2>
    <form id="pinForm"><input type="password" id="pin" inputmode="numeric" autocomplete="off" placeholder="PIN" autofocus>
      <button class="btn primary" style="width:100%;justify-content:center">Unlock</button></form></div>`;
  $('#pin').focus();
  $('#pinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/doujin/unlock', { method: 'POST', body: { pin: $('#pin').value } }); renderDoujin(); }
    catch (err) { toast(err.message, true); $('#pin').value = ''; $('#pin').focus(); }
  });
}

// ---------- series ----------
const STATUS_LABEL = {
  CURRENT: 'Reading', PLANNING: 'Plan to read', COMPLETED: 'Completed', PAUSED: 'On hold',
  DROPPED: 'Dropped', REPEATING: 'Re-reading',
};

function djMeta(s) {
  const d = s.doujin;
  const tag = (n) => `<a class="tag" href="#/doujin" data-q="${esc(n)}">${esc(n)}</a>`;
  const row = (label, arr) => (arr.length ? `<div class="meta"><span class="lbl">${label}</span> ${arr.map(tag).join(' ')}</div>` : '');
  return `
    ${row('Artist', d.artists)}${row('Circle', d.groups)}${row('Parody', d.parodies)}${row('Language', d.languages)}
    ${row('Characters', d.characters.slice(0, 12))}
    ${d.tags.length ? `<div class="tags">${d.tags.map(tag).join('')}</div>` : ''}
    <div class="meta">
      ${d.pages ? `<span>${d.pages} pages</span>` : ''}${s.year ? `<span>${s.year}</span>` : ''}
    </div>
    ${d.local || !s.nhId ? '<div class="muted" style="margin-bottom:10px">Details come from the file name. Use “Fix metadata” to match it on nhentai.</div>' : ''}`;
}

async function renderSeries(id) {
  const s = await api(`/series/${id}`);
  if (s.kind === 'novel') return renderNovelSeries(s);
  const readCount = s.chapters.filter((c) => c.completed).length;
  const next = s.chapters.find((c) => !c.completed) || s.chapters[0];
  const resumeCh = s.chapters.find((c) => !c.completed && c.page > 0) || next;
  const started = s.chapters.some((c) => c.completed || c.page > 0);
  let reversed = sessionStorage.getItem('ms.rev') === '1';
  const dj = s.kind === 'doujin';

  // volumes, for the gallery view (chapters carry the volume number parsed from the files)
  const volKey = (c) => (c.volume != null ? String(c.volume) : 'none');
  const groups = new Map();
  for (const c of s.chapters) { const k = volKey(c); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
  const volumes = [...groups].map(([key, chs]) => {
    const nums = chs.map((c) => c.number).filter((n) => n != null);
    const lo = Math.min(...nums), hi = Math.max(...nums);
    return {
      key, chs, label: key === 'none' ? 'Other chapters' : `Vol. ${key}`,
      read: chs.filter((c) => c.completed).length,
      range: nums.length ? (lo === hi ? `Ch ${lo}` : `Ch ${lo}–${hi}`) : `${chs.length} ch`,
    };
  }).sort((a, b) => (a.key === 'none') - (b.key === 'none') || Number(a.key) - Number(b.key));
  const canGallery = !dj && volumes.length >= 2 && volumes.some((v) => v.key !== 'none');
  let mode = canGallery && (localStorage.getItem('ms.seriesView') || 'gallery') === 'gallery' ? 'gallery' : 'chapters';
  let openVol = sessionStorage.getItem(`ms.vol.${id}`);
  if (!volumes.some((v) => v.key === openVol)) openVol = null;

  view.innerHTML = `
    ${dj ? '<a class="muted" href="#/doujin">← Doujin</a>' : ''}
    <div class="hero">
      ${s.banner ? `<div class="bg" style="background-image:url('${esc(s.banner)}')"></div>` : ''}
      <div class="inner">
        <div class="poster"><img src="/api/series/${s.id}/cover" alt=""></div>
        <div class="info">
          <h1>${esc(s.title)}</h1>
          <div class="alt">${esc([s.native, s.romaji !== s.title ? s.romaji : ''].filter(Boolean).join(' · '))}</div>
          ${dj ? djMeta(s) : `
          <div class="meta">
            ${s.status ? `<span>${esc(s.status.replace(/_/g, ' ').toLowerCase())}</span>` : ''}
            ${s.format ? `<span>${esc(s.format.replace(/_/g, ' '))}</span>` : ''}
            ${s.year ? `<span>${s.year}</span>` : ''}
            ${s.score ? `<span>★ ${s.score}%</span>` : ''}
            ${s.chaptersTotal ? `<span>${s.chaptersTotal} chapters</span>` : ''}
            ${s.authors.length ? `<span>${esc(s.authors.slice(0, 3).join(', '))}</span>` : ''}
          </div>
          ${s.genres.length || (!dj && s.tags?.length) ? `<div class="tags">${s.genres.map((g) => (dj ? `<span class="tag">${esc(g)}</span>` : `<a class="tag genre" href="#/" data-facet="genres:${esc(g)}">${esc(g)}</a>`)).join('')}
            ${dj ? '' : (s.tags || []).map((g, i) => `<a class="tag soft ${i >= 10 ? 'xtag hidden' : ''}" href="#/" data-facet="tags:${esc(g)}">${esc(g)}</a>`).join('')}
            ${!dj && (s.tags || []).length > 10 ? `<button class="tag soft" id="moreTags">+${s.tags.length - 10} tags</button>` : ''}</div>` : ''}
          ${s.metaSource === 'mangadex' ? '<div class="muted" style="margin-bottom:8px">Details from MangaDex</div>' : ''}
          ${s.edited?.length ? '<div class="muted" style="margin-bottom:8px">✎ Includes your manual edits</div>' : ''}
          ${s.description ? `<div class="desc">${esc(s.description)}</div>` : ''}
          `}
          <div class="actions">
            ${next ? `<a class="btn primary" href="#/read/${resumeCh.id}">${started ? '▶ Continue' : '▶ Start reading'}</a>` : ''}
            <button class="btn" id="match">🛠 Fix metadata${(dj ? s.nhId : (s.anilistId || s.metaSource === 'mangadex')) ? '' : (dj ? ' · Match on nhentai' : ' · Match on AniList / MangaDex')}</button>
            ${(dj ? s.nhId : (s.anilistId || s.metaSource === 'mangadex')) ? '<button class="btn" id="refresh">↻ Refresh info</button>' : ''}
            ${s.siteUrl ? `<a class="btn" href="${esc(s.siteUrl)}" target="_blank" rel="noopener">${dj ? 'nhentai' : (s.metaSource === 'mangadex' ? 'MangaDex' : 'AniList')} ↗</a>` : ''}
            <button class="btn" id="rescan" title="Re-read this series' folder after renaming or adding files">↻ Rescan files</button>
            <button class="btn" id="markAll">${readCount === s.chapters.length ? 'Mark all unread' : 'Mark all read'}</button>
          </div>
          <div id="al"></div>
        </div>
      </div>
    </div>
    <div id="collection"></div>
    <div id="related"></div>
    <div class="viewbar">
      <h2 id="listTitle" style="margin:0;flex:1"></h2>
      ${canGallery && s.anilistId ? '<button class="btn small hidden" id="fetchCovers" title="Look up official volume covers on MangaDex">↻ Official covers</button>' : ''}
      ${canGallery ? '<label class="sizer hidden" id="sizer" title="Cover size"><span class="muted">▫</span><input type="range" id="volSize" min="90" max="320" step="10"><span class="muted">▣</span></label>' : ''}
      ${canGallery ? '<div class="seg" id="viewSeg"><button data-v="chapters">Chapters</button><button data-v="gallery">Gallery</button></div>' : ''}
      <button class="btn small" id="rev">${reversed ? '↑ Oldest first' : '↓ Newest first'}</button>
    </div>
    <div id="volhead" class="volhead hidden" style="margin-top:10px"></div>
    <div id="gal" class="vgrid hidden" style="margin-top:12px"></div>
    <div class="chapters" id="chs" style="margin-top:10px"></div>`;

  renderRelated(id);

  const chapterRows = (list) => (reversed ? [...list].reverse() : list).map((c) => `
      <a class="ch ${c.completed ? 'read' : ''}" href="#/read/${c.id}" data-id="${c.id}">
        <span class="state">${c.completed ? '✓' : ''}</span>
        <span class="t">${esc(c.title)}</span>
        ${!c.completed && c.page > 0 ? `<span class="mini"><i style="width:${(c.page / Math.max(1, c.pageCount)) * 100}%"></i></span>` : ''}
        <span class="muted">${c.pageCount} p</span>
        ${c.splittable ? `<button class="btn small spl" data-id="${c.id}" title="${c.manual ? 'Edit chapter splits' : 'Split this volume into chapters'}">✂</button>` : ''}
        <button class="btn small tog" data-id="${c.id}" data-read="${c.completed ? 0 : 1}" title="${c.completed ? 'Mark this chapter unread' : 'Mark this chapter read'}">${c.completed ? '↺ Unread' : '✓ Read'}</button>
        <button class="more" title="More options (or right-click)">⋯</button>
      </a>`).join('') || '<div class="empty">No readable chapters found in this folder.</div>';

  const renderList = () => {
    const showGrid = mode === 'gallery' && openVol === null;
    const vol = mode === 'gallery' && openVol !== null ? volumes.find((v) => v.key === openVol) : null;
    $('#gal').classList.toggle('hidden', !showGrid);
    $('#chs').classList.toggle('hidden', showGrid);
    $('#rev').classList.toggle('hidden', showGrid);
    $('#fetchCovers')?.classList.toggle('hidden', !showGrid);
    $('#sizer')?.classList.toggle('hidden', !showGrid);
    $('#volhead').classList.toggle('hidden', !vol);
    document.querySelectorAll('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === mode));

    if (showGrid) {
      $('#listTitle').innerHTML = `Volumes <span class="muted">(${volumes.length} · ${readCount}/${s.chapters.length} chapters read)</span>`;
      $('#gal').innerHTML = `<div class="grid">${volumes.map((v) => {
        const done = v.read === v.chs.length;
        return `<div class="card" data-v="${esc(v.key)}">
          <div class="cover"><img loading="lazy" src="/api/series/${s.id}/volume/${esc(v.key)}/cover" alt="">
            ${done ? '<span class="badge done">✓ Read</span>' : v.read > 0 ? `<span class="badge">${v.chs.length - v.read}</span>` : ''}
            <div class="bar"><i style="width:${(v.read / v.chs.length) * 100}%"></i></div></div>
          <div class="name">${esc(v.label)}</div>
          <div class="sub">${esc(v.range)} · ${v.read}/${v.chs.length} read</div></div>`;
      }).join('')}</div>`;
      return;
    }
    if (vol) {
      $('#listTitle').innerHTML = `${esc(vol.label)} <span class="muted">(${vol.read}/${vol.chs.length} read)</span>`;
      const pages = vol.chs.reduce((n, c) => n + c.pageCount, 0);
      $('#volhead').innerHTML = `
        <img src="/api/series/${s.id}/volume/${esc(vol.key)}/cover" alt="">
        <div class="vinfo">
          <div class="vtitle">${esc(vol.label)}</div>
          <div class="muted">${esc(vol.range)} · ${vol.chs.length} chapter${vol.chs.length === 1 ? '' : 's'} · ${pages} pages</div>
          <div class="muted">${vol.read}/${vol.chs.length} read</div>
          <div class="actions" style="margin-top:10px">
            <button class="btn small" id="volBack">← All volumes</button>
            <button class="btn small" id="volRead">${vol.read === vol.chs.length ? '↺ Mark volume unread' : '✓ Mark volume read'}</button>
            ${vol.key !== 'none' ? `<button class="btn small" id="volCover">🖼 Change cover</button>
            <button class="btn small" id="volCoverReset" title="Remove my cover and use the official / file cover">↺ Default cover</button>
            <input type="file" id="volFile" accept="image/*" class="hidden">` : ''}
          </div>
        </div>`;
      $('#chs').innerHTML = chapterRows(vol.chs);
    } else {
      $('#listTitle').innerHTML = `Chapters <span class="muted">(${readCount}/${s.chapters.length} read)</span>`;
      $('#chs').innerHTML = chapterRows(s.chapters);
    }
  };
  renderList();

  const sizeDefault = window.innerWidth < 640 ? 110 : 150;
  const sizeSaved = Number(localStorage.getItem('ms.volSize'));
  const setSize = (v) => $('#gal').style.setProperty('--vol-size', `${v}px`);
  if ($('#volSize')) {
    const start = sizeSaved >= 90 && sizeSaved <= 320 ? sizeSaved : sizeDefault;
    $('#volSize').value = start; setSize(start);
    $('#volSize').addEventListener('input', (e) => { setSize(e.target.value); localStorage.setItem('ms.volSize', e.target.value); });
  }

  $('#fetchCovers')?.addEventListener('click', async (e) => {
    const b = e.target; b.disabled = true; b.textContent = 'Looking up…';
    try {
      const r = await api(`/series/${id}/covers/fetch`, { method: 'POST' });
      toast(r.found ? `Found ${r.found} official cover${r.found === 1 ? '' : 's'}` : `No official covers: ${r.reason || 'nothing to add'}`, !r.found);
      renderSeries(id);
    } catch (err) { toast(err.message, true); b.disabled = false; b.textContent = '↻ Official covers'; }
  });
  $('#viewSeg')?.addEventListener('click', (e) => {
    const v = e.target.dataset.v; if (!v) return;
    mode = v; localStorage.setItem('ms.seriesView', v);
    openVol = null; sessionStorage.removeItem(`ms.vol.${id}`);
    renderList();
  });
  $('#gal').addEventListener('click', (e) => {
    const c = e.target.closest('.card'); if (!c) return;
    openVol = c.dataset.v; sessionStorage.setItem(`ms.vol.${id}`, openVol);
    renderList();
    $('#listTitle').scrollIntoView({ block: 'start' });
  });
  $('#volhead').addEventListener('change', async (e) => {
    if (e.target.id !== 'volFile' || !e.target.files[0]) return;
    const file = e.target.files[0];
    try {
      const r = await fetch(`/api/series/${id}/volume/${openVol}/cover`, { method: 'POST', headers: { 'Content-Type': file.type || 'image/jpeg' }, body: file });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not use that image');
      toast('Volume cover updated');
      renderSeries(id);
    } catch (err) { toast(err.message, true); }
  });
  $('#volhead').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'volCover') { $('#volFile').click(); return; }
    if (b.id === 'volCoverReset') {
      try { await api(`/series/${id}/volume/${openVol}/cover`, { method: 'DELETE' }); toast('Back to the default cover'); renderSeries(id); }
      catch (err) { toast(err.message, true); }
      return;
    }
    if (b.id === 'volBack') { openVol = null; sessionStorage.removeItem(`ms.vol.${id}`); renderList(); return; }
    if (b.id === 'volRead') {
      const vol = volumes.find((v) => v.key === openVol);
      const makeRead = vol.read !== vol.chs.length;
      await Promise.all(vol.chs.map((c) => api(`/chapters/${c.id}/read`, { method: 'POST', body: { read: makeRead } })));
      renderSeries(id);
    }
  });

  $('#chs').addEventListener('click', async (e) => {
    const sp = e.target.closest('.spl');
    if (sp) { e.preventDefault(); location.hash = `#/split/${sp.dataset.id}`; return; }
    const b = e.target.closest('.tog'); if (!b) return;
    e.preventDefault();
    await api(`/chapters/${b.dataset.id}/read`, { method: 'POST', body: { read: b.dataset.read === '1' } });
    renderSeries(id);
  });
  bindCtx($('#chs'), '.ch', (el) => {
    const c = s.chapters.find((x) => x.id === Number(el.dataset.id));
    if (!c) return [];
    const at = s.chapters.indexOf(c);
    const bulk = (list, read) => async () => {
      await api('/chapters/read-bulk', { method: 'POST', body: { ids: list.map((x) => x.id), read } });
      renderSeries(id);
    };
    return [
      { label: '▶ Read', run: () => { location.hash = `#/read/${c.id}`; } },
      { label: c.completed ? '↺ Mark unread' : '✓ Mark read', run: bulk([c], !c.completed) },
      at > 0 ? { label: '✓ Mark everything up to here read', run: bulk(s.chapters.slice(0, at + 1), true) } : null,
      at < s.chapters.length - 1 ? { label: '↺ Mark everything from here unread', run: bulk(s.chapters.slice(at), false) } : null,
      c.splittable ? { sep: true } : null,
      c.splittable ? { label: '✂ Split into chapters…', run: () => { location.hash = `#/split/${c.id}`; } } : null,
      { sep: true },
      { label: '📂 Show in folder', run: () => revealFile('chapters', c.id) },
      { label: 'ⓘ Properties', run: async () => {
        const p = await api(`/chapters/${c.id}/properties`);
        openProperties(p.name, [
          ['Series', p.series], ['Chapter', p.title], ['Volume', p.volume], ['Type', p.type],
          ['Pages', p.pages], ['Pages in the file', p.pageRange], ['Size', fmtBytes(p.size)],
          ['Folder', p.folder], ['Modified', fmtDate(p.modified)],
          ['Read', p.read ? 'Yes' : p.page > 0 ? `In progress (page ${p.page + 1})` : 'No'],
          ['Status', p.exists ? '' : 'File not found at this location'],
        ], { base: 'chapters', id: c.id, path: p.path });
      } },
    ];
  });
  $('#rev').addEventListener('click', () => {
    reversed = !reversed; sessionStorage.setItem('ms.rev', reversed ? '1' : '0');
    $('#rev').textContent = reversed ? '↑ Oldest first' : '↓ Newest first'; renderList();
  });
  $('#rescan').addEventListener('click', async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try {
      const r = await api(`/series/${id}/rescan`, { method: 'POST' });
      const bits = [`${r.chapters} chapter${r.chapters === 1 ? '' : 's'}`];
      if (r.added) bits.push(`${r.added} new`);
      if (r.removed) bits.push(`${r.removed} gone`);
      if (r.moved) bits.push(`${r.moved} renamed, progress kept`);
      toast(`Rescanned: ${bits.join(' · ')}`);
      renderSeries(id);
    } catch (err) {
      b.disabled = false;
      if (err.message.includes('not at its old location') && confirm(`${err.message}\n\nScan your libraries now so MangaSoft can find it again?`)) {
        await api('/scan', { method: 'POST', body: {} });
        toast('Scanning libraries…');
        watchScan(() => route());
      } else toast(err.message, true);
    }
  });
  $('#markAll').addEventListener('click', async () => {
    await api(`/series/${id}/read-all`, { method: 'POST', body: { read: readCount !== s.chapters.length } });
    renderSeries(id);
  });
  $('#match').addEventListener('click', () => openMatchModal(s, () => renderSeries(id)));
  view.querySelector('.hero').addEventListener('click', (e) => {
    const more = e.target.closest('#moreTags');
    if (more) { view.querySelectorAll('.xtag').forEach((t) => t.classList.remove('hidden')); more.remove(); return; }
    const t = e.target.closest('[data-facet]'); if (!t) return;
    try { sessionStorage.setItem('ms.facet.manga', t.dataset.facet); sessionStorage.setItem('ms.filter.manga', 'all'); } catch { /* private mode */ }
  });
  $('#refresh')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { await api(`/series/${id}/${dj ? 'nhentai/refresh' : 'refresh'}`, { method: 'POST' }); renderSeries(id); }
    catch (err) { toast(err.message, true); e.target.disabled = false; }
  });

  // clicking a tag on a doujin jumps to the doujin library filtered by it
  document.querySelectorAll('a.tag[data-q]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    sessionStorage.setItem('ms.q.doujin', a.dataset.q);
    location.hash = '#/doujin';
  }));

  // what's missing compared with the published series
  if (!dj) {
    const showMissing = (attempt = 0) => api(`/series/${id}/missing`).then((m) => {
      const slot = $('#collection'); if (!slot) return;
      if (m.disabled) { slot.innerHTML = ''; return; } // switched off in Settings
      if (!m.known) {
        if (!m.matched) {
          slot.innerHTML = `<div class="panel collection" style="margin-top:0"><b>Your collection</b>
            <div class="muted">Match this series on AniList or MangaDex (Fix metadata) to see which volumes and chapters you are missing.</div></div>`;
          return;
        }
        slot.innerHTML = `<div class="panel collection" style="margin-top:0">
          <div class="viewbar"><b style="flex:1">Your collection</b>
            <button class="btn small" id="recheck">↻ Check now</button></div>
          <div class="muted">${m.loading || attempt === 0 ? 'Looking up what has been published…' : 'Nothing found yet. MangaDex may not list this series - try again later.'}</div></div>`;
        $('#recheck').addEventListener('click', async (e) => {
          e.target.disabled = true; e.target.textContent = 'Checking…';
          try { await api(`/series/${id}/covers/fetch`, { method: 'POST' }); } catch (err) { toast(err.message, true); }
          showMissing(1);
        });
        if (attempt < 3) setTimeout(() => { if ($('#collection')) showMissing(attempt + 1); }, 4000);
        return;
      }
      const cap = (arr) => (arr.length > 8 ? arr.slice(0, 8).join(', ') + ' …' : arr.join(', '));
      const volLine = m.volumes.expected ? `<div><b>Volumes</b> ${m.volumes.have} / ${m.volumes.expected}
        ${m.volumes.missing ? `<span class="muted">· missing ${esc(cap(m.volumes.ranges))}</span>` : '<span class="muted">· complete</span>'}</div>` : '';
      slot.innerHTML = `<div class="panel collection" style="margin-top:0">
        <div class="viewbar"><b style="flex:1">Your collection</b>
          <button class="btn small" id="recheck" title="Look it up again on ${esc(m.source)}">↻ Check again</button></div>
        ${volLine}
        <div><b>Chapters</b> ${m.chapters.have} / ${m.chapters.expected}
          ${m.chapters.missing ? `<span class="muted">· missing ${esc(cap(m.chapters.ranges))}</span>` : '<span class="muted">· complete</span>'}</div>
        <div class="muted" style="font-size:12.5px;margin-top:6px">
          Based on what ${esc(m.source)} lists as published${m.ongoing ? ' (the series is still running, so newer chapters appear over time)' : ''}.
          ${m.chapters.notInVolume ? `${m.chapters.notInVolume} of the missing chapters are newer than the latest volume. ` : ''}
          ${m.unsplit ? `${m.unsplit} volume file${m.unsplit === 1 ? ' isn’t' : 's aren’t'} split into chapters; their chapters are counted from the volume number.` : ''}
        </div></div>`;
      $('#recheck').addEventListener('click', async (e) => {
        e.target.disabled = true; e.target.textContent = 'Checking…';
        try { await api(`/series/${id}/covers/fetch`, { method: 'POST' }); } catch (err) { toast(err.message, true); }
        renderSeries(id);
      });
    }).catch(() => {});
    showMissing();
  }

  // AniList list status
  if (s.anilistId && !dj) {
    const box = $('#al');
    try {
      const r = await api(`/series/${id}/anilist`);
      if (!r.connected) {
        box.innerHTML = '<div class="al-box muted">Connect AniList in <a href="#/settings">Settings</a> to track your reading.</div>';
      } else {
        const e = r.entry;
        box.innerHTML = `<div class="al-box">
          <span><b>AniList:</b> ${e ? `${STATUS_LABEL[e.status] || e.status} · ${e.progress}${s.chaptersTotal ? ' / ' + s.chaptersTotal : ''} ch` : 'not on your list'}</span>
          <select id="alStatus">
            ${e ? '' : '<option value="">Add to list…</option>'}
            ${Object.entries(STATUS_LABEL).map(([k, l]) => `<option value="${k}" ${e?.status === k ? 'selected' : ''}>${l}</option>`).join('')}
          </select></div>`;
        $('#alStatus').addEventListener('change', async (ev) => {
          if (!ev.target.value) return;
          try { await api(`/series/${id}/anilist`, { method: 'POST', body: { status: ev.target.value } }); toast('AniList updated'); renderSeries(id); }
          catch (err) { toast(err.message, true); }
        });
      }
    } catch (err) {
      box.innerHTML = `<div class="al-box muted">AniList: ${esc(err.message)}</div>`;
    }
  }
}

function openMatchModal(series, onDone) {
  const dj = series.kind === 'doujin';
  const anime = series.kind === 'anime';
  // source: nhentai for doujin; AniList only for anime; AniList or MangaDex for manga (start on whichever the series already uses)
  let src = dj ? 'nhentai' : (series.metaSource === 'mangadex' && !anime ? 'mangadex' : 'anilist');
  const SRC = {
    anilist: {
      site: 'AniList', search: anime ? '/anime/search?q=' : series.kind === 'novel' ? '/anilist/search?novel=1&q=' : '/anilist/search?q=', linked: () => series.anilistId,
      path: () => (anime ? `/anime/series/${series.id}/match` : `/series/${series.id}/match`), body: (v) => ({ anilistId: v }), num: true,
      paste: `https://anilist.co/${anime ? 'anime' : 'manga'}/12345`, pasteLabel: 'Or paste an AniList link / ID',
      parse: (v) => (v.match(/(?:manga|anime)\/(\d+)/) || v.match(/^(\d+)$/))?.[1], bad: `Paste an anilist.co/${anime ? 'anime' : 'manga'}/… link or a numeric ID`,
      meta: (r) => [r.native, r.year, r.format, r.chapters ? r.chapters + (anime ? ' ep' : ' ch') : ''],
    },
    mangadex: {
      site: 'MangaDex', search: '/mangadex/search?q=', linked: () => series.metaSource === 'mangadex' && series.mdId,
      path: () => `/series/${series.id}/mangadex`, body: (v) => ({ mdId: v }), num: false,
      paste: 'https://mangadex.org/title/…', pasteLabel: 'Or paste a MangaDex link',
      parse: (v) => v.match(/title\/([0-9a-f-]{36})/i)?.[1] || (/^[0-9a-f-]{36}$/i.test(v) ? v : null), bad: 'Paste a mangadex.org/title/… link',
      meta: (r) => [r.native, r.year, r.status, r.chapters ? r.chapters + ' ch' : ''],
    },
    nhentai: {
      site: 'nhentai', search: '/doujin/search?q=', linked: () => series.nhId,
      path: () => `/series/${series.id}/nhentai`, body: (v) => ({ nhId: v }), num: true,
      paste: 'https://nhentai.net/g/123456/ or 123456', pasteLabel: 'Or paste an nhentai link / gallery number',
      parse: (v) => (v.match(/\/g\/(\d+)/) || v.match(/^#?(\d{1,7})$/))?.[1], bad: 'Paste an nhentai.net/g/… link or a gallery number',
      meta: (r) => [r.japanese, r.pages ? `${r.pages} p` : '', `#${r.id}`],
    },
  };
  const startQuery = dj
    ? series.folderName.replace(/\.(cbz|zip)$/i, '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
    : series.folderName;
  const ov = $('#overlay');
  const close = () => { ov.innerHTML = ''; };
  let query = startQuery;

  const edited = (k) => (series.edited?.includes(k) ? '<span class="muted" title="You edited this">✎</span>' : '');
  const field = (k, label, control) => `<label>${label} ${edited(k)}
    ${series.edited?.includes(k) ? `<button class="linkbtn" data-reset="${k}" title="Go back to the provider's value">↺ reset</button>` : ''}</label>${control}`;

  const render = () => {
    const c = SRC[src];
    ov.innerHTML = `<div class="modal-bg"><div class="modal">
      <h2 style="margin-top:0">Fix metadata</h2>
      <div class="muted">Folder: ${esc(series.folderName)}</div>
      ${dj || anime || series.kind === 'novel' ? '' : `<div class="seg" id="srcSeg" style="margin-top:10px;max-width:300px">
        <button data-s="anilist" class="${src === 'anilist' ? 'on' : ''}">AniList</button>
        <button data-s="mangadex" class="${src === 'mangadex' ? 'on' : ''}">MangaDex</button></div>`}

      <h3>Search ${c.site}</h3>
      <div class="form-row" style="margin-top:0"><input type="search" id="mq" value="${esc(query)}"><button class="btn primary" id="go">Search</button></div>
      <div id="res" style="margin-top:8px"></div>

      <h3>${c.pasteLabel}</h3>
      <div class="form-row" style="margin-top:0"><input type="text" id="aid" placeholder="${esc(c.paste)}"><button class="btn" id="useId">Use</button></div>

      <h3>Edit by hand</h3>
      <p class="muted" style="margin-top:0">Your edits are kept when details are refreshed or re-matched. Edited fields are marked ✎.</p>
      <div id="editForm">
        ${field('title', 'Title', `<input type="text" data-k="title" value="${esc(series.title)}">`)}
        ${field('native', 'Native title', `<input type="text" data-k="native" value="${esc(series.native || '')}">`)}
        ${dj ? '' : field('description', 'Description', `<textarea data-k="description" rows="4">${esc(series.description || '')}</textarea>`)}
        ${field('genres', dj ? 'Tags (comma separated)' : 'Genres (comma separated)', `<input type="text" data-k="genres" value="${esc((series.genres || []).join(', '))}">`)}
        ${field('authors', dj ? 'Artists (comma separated)' : anime ? 'Studios (comma separated)' : 'Authors (comma separated)', `<input type="text" data-k="authors" value="${esc((series.authors || []).join(', '))}">`)}
        <div class="editrow">
          ${dj ? '' : field('status', 'Status', `<select data-k="status">${['', 'RELEASING', 'FINISHED', 'HIATUS', 'CANCELLED', 'NOT_YET_RELEASED']
            .map((v) => `<option value="${v}" ${(series.status || '') === v ? 'selected' : ''}>${v ? v.replace(/_/g, ' ').toLowerCase() : '-'}</option>`).join('')}</select>`)}
          ${field('year', 'Year', `<input type="text" inputmode="numeric" data-k="year" value="${series.year ?? ''}">`)}
          ${dj ? '' : field('chapters', anime ? 'Episodes' : 'Chapters', `<input type="text" inputmode="numeric" data-k="chapters" value="${series.chaptersTotal ?? ''}">`)}
          ${dj || anime ? '' : field('volumes', 'Volumes', `<input type="text" inputmode="numeric" data-k="volumes" value="${series.volumesTotal ?? ''}">`)}
        </div>
        <label>Cover ${edited('cover')}</label>
        <div class="form-row" style="margin-top:0">
          <input type="file" id="mcFile" accept="image/*" style="flex:0 1 auto">
          <input type="text" id="mc" placeholder="…or an image URL">
          ${edited('cover') ? '<button class="btn small" id="coverReset">↺ Use provider cover</button>' : ''}
        </div>
      </div>
      <div class="form-row">
        <button class="btn primary" id="saveMeta">Save changes</button>
        ${series.edited?.length ? '<button class="btn danger" id="resetAll">Reset all my edits</button>' : ''}
      </div>

      <div class="form-row" style="justify-content:flex-end">
        ${c.linked() ? `<button class="btn danger" id="unlink">Unlink from ${c.site}</button>` : ''}<button class="btn" id="close">Close</button>
      </div></div></div>`;

    const box = $('#res'); // keep a handle: the dialog may be closed while a lookup is in flight
    const apply = async (v) => {
      box.innerHTML = '<div class="muted">Applying…</div>';
      try { await api(c.path(), { method: 'POST', body: c.body(c.num ? Number(v) : v) }); close(); onDone(); }
      catch (err) { box.innerHTML = ''; toast(err.message, true); }
    };
    const search = async () => {
      query = $('#mq')?.value ?? query;
      box.innerHTML = '<div class="muted">Searching…</div>';
      try {
        const rs = await api(c.search + encodeURIComponent(query));
        box.innerHTML = rs.map((r) => `<div class="result" data-id="${esc(r.id)}">
          ${r.cover ? `<img src="${esc(r.cover)}" alt="">` : '<img alt="">'}<div><b>${esc(r.title)}</b>
          <div class="muted">${esc(c.meta(r).filter(Boolean).join(' · '))}</div></div></div>`).join('')
          || '<div class="muted">No results.</div>';
      } catch (e) { box.innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
    };
    $('#go').addEventListener('click', search);
    $('#mq').addEventListener('keydown', (e) => e.key === 'Enter' && search());
    $('#close').addEventListener('click', close);
    $('.modal-bg').addEventListener('mousedown', (e) => e.target.classList.contains('modal-bg') && close());
    $('#srcSeg')?.addEventListener('click', (e) => {
      const s2 = e.target.dataset.s; if (!s2 || s2 === src) return;
      query = $('#mq').value; src = s2; render();
    });
    $('#unlink')?.addEventListener('click', async () => {
      await api(c.path(), { method: 'POST', body: c.body(null) }); close(); onDone();
    });
    box.addEventListener('click', (e) => { const r = e.target.closest('.result'); if (r) apply(r.dataset.id); });
    $('#useId').addEventListener('click', () => {
      const v = c.parse($('#aid').value.trim());
      if (!v) return toast(c.bad, true);
      apply(v);
    });
    const initial = {
      title: series.title, native: series.native || '', description: series.description || '',
      genres: (series.genres || []).join(', '), authors: (series.authors || []).join(', '),
      status: series.status || '', year: String(series.year ?? ''), chapters: String(series.chaptersTotal ?? ''), volumes: String(series.volumesTotal ?? ''),
    };
    const sendCover = async (file) => {
      const r = await fetch(`/api/series/${series.id}/cover`, { method: 'POST', headers: { 'Content-Type': file.type || 'image/jpeg' }, body: file });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not use that image');
    };
    $('#saveMeta').addEventListener('click', async () => {
      const body = {};
      document.querySelectorAll('#editForm [data-k]').forEach((el) => {
        if (el.value !== initial[el.dataset.k]) body[el.dataset.k] = el.value;
      });
      try {
        const file = $('#mcFile').files[0];
        if (file) await sendCover(file);
        else if ($('#mc').value.trim()) body.coverUrl = $('#mc').value.trim();
        if (Object.keys(body).length) await api(`/series/${series.id}/metadata`, { method: 'PUT', body });
        close(); onDone();
      } catch (err) { toast(err.message, true); }
    });
    $('#editForm').addEventListener('click', async (e) => {
      const k = e.target.dataset.reset; if (!k) return;
      try {
        await api(`/series/${series.id}/metadata`, { method: 'PUT', body: { [k]: null } });
        await api(`/series/${series.id}/${dj ? 'nhentai/refresh' : 'refresh'}`, { method: 'POST' });
        close(); onDone();
      } catch (err) { toast(err.message, true); }
    });
    $('#coverReset')?.addEventListener('click', async () => {
      await api(`/series/${series.id}/cover`, { method: 'DELETE' }); close(); onDone();
    });
    $('#resetAll')?.addEventListener('click', async () => {
      if (!confirm('Remove all your manual edits (including a custom cover) and use the provider details again?')) return;
      try { await api(`/series/${series.id}/metadata/reset`, { method: 'POST' }); close(); onDone(); }
      catch (err) { toast(err.message, true); }
    });
    search();
  };
  render();
}

// ---------- chapter splitter ----------
async function renderSplitter(chapterId) {
  const sp = await api(`/chapters/${chapterId}/splits`);
  const total = sp.pageCount;
  // markers: where each chapter starts. auto = suggested by OCR (confidence), confirmed = user has checked it
  let markers = (sp.markers || []).map((m) => ({ page: m.page, number: m.number, confirmed: true }));
  let uncertain = [];
  let pollTimer = null;
  const img = (i) => `/api/chapters/${chapterId}/archive-page/${i}`;

  view.innerHTML = `
    <h1>Split into chapters</h1>
    <p class="muted" style="margin-top:-8px">${esc(sp.title)} · ${total} pages. Let MangaSoft look for “Chapter N” title pages, then confirm
      or fix them. You can also tap any page below to add or remove a chapter start.</p>
    <div class="split-bar">
      <button class="btn primary" id="detect">🔍 Auto-detect chapters</button>
      <span id="dstate" class="muted"></span>
      <span style="flex:1"></span>
      ${sp.markers ? '<button class="btn danger" id="reset">Remove splits</button>' : ''}
      <a class="btn" href="#/series/${sp.seriesId}">Cancel</a>
      <button class="btn primary" id="save">Save chapters</button>
    </div>
    <div id="qwrap"></div>
    <h2>Pages</h2>
    <div class="sgrid" id="sgrid">${Array.from({ length: total }, (_, i) => `
      <div class="th" data-i="${i}"><img loading="lazy" src="${img(i)}" alt="">
        <span class="ch-badge"></span><span class="n">${i + 1}</span></div>`).join('')}</div>`;

  const sorted = () => [...markers].sort((a, b) => a.page - b.page);
  const nextNumberFor = (page) => {
    const before = sorted().filter((m) => m.page < page).pop();
    return before ? before.number + 1 : sp.suggestedFirst;
  };
  const flash = (page) => {
    const t = document.querySelector(`.th[data-i="${page}"]`); if (!t) return;
    t.scrollIntoView({ block: 'center', behavior: 'smooth' });
    t.classList.add('flash'); setTimeout(() => t.classList.remove('flash'), 1400);
  };

  function paint() {
    const list = sorted();
    document.querySelectorAll('.th').forEach((t) => {
      const m = list.find((x) => x.page === Number(t.dataset.i));
      t.classList.toggle('start', !!m);
      if (m) t.querySelector('.ch-badge').textContent = `Ch ${m.number}`;
    });

    const unconfirmed = list.filter((m) => !m.confirmed).length;
    const rows = [];
    list.forEach((m, k) => {
      const prev = list[k - 1];
      if (prev && m.number - prev.number > 1) {
        const missing = [];
        for (let n = prev.number + 1; n < m.number && missing.length < 6; n++) missing.push(n);
        rows.push(`<div class="gaprow">⚠️ Chapter ${missing.join(', ')} not found between pages ${prev.page + 1} and ${m.page + 1}.
          <button class="btn small" data-jump="${prev.page + 1}">Look there</button></div>`);
      }
      rows.push(`<div class="mrow ${m.confirmed ? '' : 'unconfirmed'}" data-p="${m.page}">
        <img src="${img(m.page)}" alt="" data-jump="${m.page}" title="Show in page grid">
        <div class="mid">
          <div><b>Starts on page ${m.page + 1}</b>
            ${m.auto ? `<span class="pill ${m.auto}">auto · ${m.auto}</span>` : ''}${m.inferred ? ' <span class="pill">number inferred</span>' : ''}</div>
          ${m.text ? `<div class="txt">“${esc(m.text)}”</div>` : ''}
        </div>
        <label class="muted">Ch <input type="text" inputmode="decimal" data-num="${m.page}" value="${m.number}"></label>
        <button class="btn small" data-step="-1" data-p="${m.page}" title="Start one page earlier">◀</button>
        <button class="btn small" data-step="1" data-p="${m.page}" title="Start one page later">▶</button>
        ${m.confirmed ? '<span class="muted" title="Confirmed">✓</span>'
          : `<button class="btn small primary" data-ok="${m.page}">Confirm</button>`}
        <button class="btn small danger" data-del="${m.page}" title="Remove">✕</button>
      </div>`);
    });

    $('#qwrap').innerHTML = list.length || uncertain.length ? `<div class="queue">
      <h2>${list.length} chapter${list.length === 1 ? '' : 's'}
        ${unconfirmed ? `<span class="pill">${unconfirmed} to confirm</span><button class="btn small" id="okAll">Confirm all</button>` : '<span class="pill high">all confirmed</span>'}</h2>
      ${rows.join('')}
      ${uncertain.length ? `<div class="gaprow"><b>Uncertain:</b> ${uncertain.map((u) =>
        `<button class="btn small" data-add="${u.page}" data-n="${u.number ?? ''}">p.${u.page + 1}${u.number ? ' → ch ' + u.number : ''}</button>`).join(' ')}</div>` : ''}
    </div>` : '';
  }
  paint();

  // --- interactions ---
  $('#sgrid').addEventListener('click', (e) => {
    const t = e.target.closest('.th'); if (!t) return;
    const i = Number(t.dataset.i);
    const at = markers.findIndex((m) => m.page === i);
    if (at >= 0) markers.splice(at, 1);
    else markers.push({ page: i, number: nextNumberFor(i), confirmed: true });
    paint();
  });
  $('#qwrap').addEventListener('click', (e) => {
    const b = e.target.closest('[data-jump],[data-del],[data-ok],[data-step],[data-add],#okAll'); if (!b) return;
    if (b.dataset.jump !== undefined) return flash(Number(b.dataset.jump));
    if (b.dataset.del !== undefined) markers = markers.filter((m) => m.page !== Number(b.dataset.del));
    if (b.dataset.ok !== undefined) markers.find((m) => m.page === Number(b.dataset.ok)).confirmed = true;
    if (b.id === 'okAll') markers.forEach((m) => { m.confirmed = true; });
    if (b.dataset.step !== undefined) {
      const m = markers.find((x) => x.page === Number(b.dataset.p));
      const np = m.page + Number(b.dataset.step);
      if (np >= 0 && np < total && !markers.some((x) => x.page === np)) m.page = np;
    }
    if (b.dataset.add !== undefined) {
      const page = Number(b.dataset.add);
      uncertain = uncertain.filter((u) => u.page !== page);
      if (!markers.some((m) => m.page === page)) {
        markers.push({ page, number: Number(b.dataset.n) || nextNumberFor(page), confirmed: false, auto: 'low' });
      }
    }
    paint();
  });
  $('#qwrap').addEventListener('change', (e) => {
    const inp = e.target.closest('[data-num]'); if (!inp) return;
    const m = markers.find((x) => x.page === Number(inp.dataset.num));
    const n = parseFloat(inp.value);
    if (m && Number.isFinite(n) && n >= 0) { m.number = n; m.confirmed = true; }
    paint();
  });

  // --- detection ---
  const applyCandidates = (cands) => {
    const have = new Set(markers.map((m) => m.page));
    for (const c of cands) {
      if (c.number === null) { uncertain.push(c); continue; }
      if (c.confidence === 'low') { uncertain.push(c); continue; }
      if (have.has(c.page) || markers.some((m) => m.number === c.number)) continue;
      markers.push({ page: c.page, number: c.number, confirmed: false, auto: c.confidence, text: c.text, inferred: c.inferred });
    }
  };
  const poll = async () => {
    const j = await api(`/chapters/${chapterId}/detect`).catch(() => null);
    if (!j) return;
    if (j.state === 'running') {
      $('#dstate').innerHTML = `<span class="spinner" style="display:inline-block;vertical-align:-2px"></span> ${j.phase === 'gaps' ? 'Looking closer at gaps' : 'Reading pages'} ${j.done}/${j.total}`;
      pollTimer = setTimeout(poll, 1500);
    } else if (j.state === 'done') {
      $('#detect').disabled = false;
      $('#dstate').textContent = j.candidates.length ? `Found ${j.candidates.length} possible chapter start${j.candidates.length === 1 ? '' : 's'} - please confirm below.` : 'No “Chapter N” pages found. Tap pages below to mark chapters by hand.';
      applyCandidates(j.candidates);
      paint();
    } else if (j.state === 'error') {
      $('#detect').disabled = false;
      $('#dstate').textContent = `Detection failed: ${j.error}`;
    }
  };
  $('#detect').addEventListener('click', async () => {
    if (markers.length && !confirm('Replace the chapters below with fresh detection results?')) return;
    markers = []; uncertain = []; paint();
    $('#detect').disabled = true;
    $('#dstate').textContent = 'Starting…';
    try { await api(`/chapters/${chapterId}/detect`, { method: 'POST' }); poll(); }
    catch (err) { $('#detect').disabled = false; $('#dstate').textContent = err.message; }
  });
  cleanup = () => clearTimeout(pollTimer);
  api(`/chapters/${chapterId}/detect`).then((j) => { // resume a job already running/finished
    if (j?.state === 'running') { $('#detect').disabled = true; poll(); }
  }).catch(() => {});

  // --- save ---
  const save = async (body) => {
    try {
      const r = await api(`/chapters/${chapterId}/splits`, { method: 'PUT', body });
      toast('Chapters updated');
      location.hash = `#/series/${r.seriesId}`;
    } catch (err) { toast(err.message, true); }
  };
  $('#save').addEventListener('click', () => {
    const unconfirmed = markers.filter((m) => !m.confirmed).length;
    if (unconfirmed && !confirm(`${unconfirmed} suggested chapter${unconfirmed === 1 ? ' is' : 's are'} not confirmed yet. Save anyway?`)) return;
    save({ markers: markers.map((m) => ({ page: m.page, number: m.number })) });
  });
  $('#reset')?.addEventListener('click', () => save({ markers: [] }));
}

// ---------- settings ----------
async function renderSettings() {
  const [libs, al, dj, up, an, auto, nv] = await Promise.all([api('/libraries'), api('/anilist/status'), api('/doujin/status'), api('/update/status'), api('/anime/status'), api('/auto-scan').catch(() => null), api('/novels/status')]);
  const origin = location.origin;
  view.innerHTML = `
    <h1>Settings</h1>
    <div id="scanSlot"></div>

    <div class="panel"><h2>Server</h2>
      <p class="muted" style="margin-top:0">Restart MangaSoft after changing a setting that asks for it, or if something looks stuck. Anything playing or scanning stops, and it is back in a few seconds.</p>
      <div class="form-row" style="align-items:center">
        <button class="btn" id="restartBtn" ${up.supervised ? '' : 'disabled'}>↻ Restart MangaSoft</button>
        ${up.supervised ? '' : '<span class="muted">This copy was not started through its launcher (start.bat, the tray app or Docker), so it cannot restart itself.</span>'}
      </div>
    </div>

    ${auto ? `<div class="panel"><h2>Automatic scanning</h2>
      <p class="muted" style="margin-top:0">Keeps all your folders (manga, doujin and anime) up to date: new files appear by themselves.</p>
      <label style="display:block"><input type="checkbox" id="asOn" ${auto.enabled ? 'checked' : ''}> Scan automatically</label>
      <div class="form-row" style="align-items:center;margin-top:8px">
        <label for="asMin" style="flex:0 0 auto">Check every</label>
        <select id="asMin" style="flex:0 1 auto">${[[15, '15 minutes'], [30, '30 minutes'], [60, 'hour'], [180, '3 hours'], [360, '6 hours'], [720, '12 hours'], [1440, 'day']]
          .map(([m, l]) => `<option value="${m}" ${auto.minutes === m ? 'selected' : ''}>${l}</option>`).join('')}
          ${[15, 30, 60, 180, 360, 720, 1440].includes(auto.minutes) ? '' : `<option value="${auto.minutes}" selected>${auto.minutes} minutes</option>`}</select>
      </div>
      <label style="display:block;margin-top:8px"><input type="checkbox" id="asWatch" ${auto.watch ? 'checked' : ''}> Also scan soon after files change
        <span class="muted">(instant on local disks; on network shares the timer above does the work)</span></label>
      <div class="muted" style="margin-top:8px">${auto.lastScan ? `Last scan: ${new Date(auto.lastScan).toLocaleString()}` : 'Not scanned yet'}${auto.watching ? ` · watching ${auto.watching} folder${auto.watching === 1 ? '' : 's'}` : ''}</div>
    </div>` : ''}

    <div class="panel"><h2>Manga folders</h2>
      <p class="muted">Each sub-folder (or .cbz/.zip file) inside a library folder becomes a series. Chapters can be
      sub-folders of images or .cbz/.zip archives.</p>
      <div id="libs">${libs.map((l) => `<div class="list-row"><span style="flex:1">${esc(l)}</span>
        <button class="btn small" data-scan="${esc(l)}" title="Check just this folder for new or changed files">↻ Scan</button>
        <button class="btn small danger" data-rm="${esc(l)}">Remove</button></div>`).join('') || '<div class="muted">No folders yet.</div>'}</div>
      <div class="form-row"><input type="text" id="newLib" placeholder="e.g. D:\\Manga"><button class="btn primary" id="addLib">Add folder</button></div>
      <div class="form-row">
        <button class="btn" id="rescan">↻ Rescan</button>
        <button class="btn" id="rematch">↻ Rescan &amp; re-match AniList</button>
      </div>
      <label style="display:block;margin-top:12px"><input type="checkbox" id="autoMatch" ${al.autoMatch ? 'checked' : ''}> Automatically fetch covers &amp; info from AniList</label>
      <div class="form-row" style="margin-top:12px;align-items:center">
        <label for="metaOrder" style="flex:0 0 auto">Metadata source</label>
        <select id="metaOrder" style="flex:0 1 auto">
          <option value="anilist-first" ${al.metaOrder === 'anilist-first' ? 'selected' : ''}>AniList first, MangaDex as backup</option>
          <option value="mangadex-first" ${al.metaOrder === 'mangadex-first' ? 'selected' : ''}>MangaDex first, AniList as backup</option>
        </select>
      </div>
      <p class="muted" style="margin:4px 0 0">Used when matching new series (and on “Rescan &amp; re-match”). You can always pick the source for one series in its <b>Fix metadata</b> dialog, and anything you edit by hand is kept.</p>
      <label style="display:block;margin-top:6px"><input type="checkbox" id="mdFallback" ${al.mangadexFallback ? 'checked' : ''}> Use MangaDex for details (as backup, or first if chosen above)</label>
      <label style="display:block;margin-top:6px"><input type="checkbox" id="contCh" ${al.continuousChapters !== false ? 'checked' : ''}> Number chapters straight through the volumes (vol 2 carries on from vol 1's last chapter instead of starting at 1)</label>
      <label style="display:block;margin-top:6px"><input type="checkbox" id="showMissing" ${al.showMissing ? 'checked' : ''}> Show which volumes and chapters I'm missing (series page and library)</label>
      <label style="display:block;margin-top:6px"><input type="checkbox" id="offCovers" ${al.officialCovers ? 'checked' : ''}> Use official volume covers (from MangaDex) in the gallery when available</label>
    </div>

    ${animeSettingsHtml(an)}

    ${novelSettingsHtml(nv)}

    <div class="panel"><h2>Doujin section</h2>
      ${dj.pinSet && !dj.unlocked ? `<p class="muted">This section is locked. Unlock it from the <a href="#/doujin">Doujin page</a> to change its settings.</p>` : `
      <p class="muted">A separate library with its own folders. It never mixes with your manga and has no AniList tracking.
        Details and covers are looked up on nhentai.</p>
      <div id="djLibs">${dj.libraries.map((l) => `<div class="list-row"><span style="flex:1">${esc(l)}</span>
        <button class="btn small" data-scan="${esc(l)}" title="Check just this folder for new or changed files">↻ Scan</button>
        <button class="btn small danger" data-djrm="${esc(l)}">Remove</button></div>`).join('') || '<div class="muted">No folders yet.</div>'}</div>
      <div class="form-row"><input type="text" id="newDj" placeholder="e.g. D:\\Doujin"><button class="btn primary" id="addDj">Add folder</button></div>
      <label style="display:block;margin-top:12px"><input type="checkbox" id="nhAuto" ${dj.autoMatch ? 'checked' : ''}> Look up details on nhentai automatically</label>
      <label style="display:block;margin-top:6px"><input type="checkbox" id="djHide" ${dj.hideNav ? 'checked' : ''}> Hide “Doujin” from the menu (it stays reachable at <code class="k">${esc(origin)}/#/doujin</code>)</label>
      <details style="margin-top:10px"><summary class="muted">nhentai API key (optional, raises the lookup limit)</summary>
        <div class="form-row"><input type="password" id="nhKey" placeholder="${dj.hasApiKey ? 'A key is saved - enter a new one to replace it' : 'API key'}">
        <button class="btn" id="saveKey">Save</button>${dj.hasApiKey ? '<button class="btn danger" id="clearKey">Remove</button>' : ''}</div></details>
      <h3 style="margin:18px 0 6px;font-size:14px">PIN lock <span class="muted">(optional)</span></h3>
      <p class="muted" style="margin-top:0">${dj.pinSet ? 'The doujin section asks for a PIN on each device.' : 'Off. Set a PIN to hide the section and its covers until it is entered.'}
        This is a privacy lock for people on your network, not strong security.</p>
      <div class="form-row">
        ${dj.pinSet ? '<input type="password" id="pinCur" placeholder="Current PIN">' : ''}
        <input type="password" id="pinNew" placeholder="${dj.pinSet ? 'New PIN (leave empty to remove)' : 'New PIN (4+ characters)'}">
        <button class="btn primary" id="pinSave">${dj.pinSet ? 'Change / remove PIN' : 'Set PIN'}</button>
      </div>`}
    </div>

    <div class="panel"><h2>AniList</h2>
      ${al.connected ? `
        <div class="list-row"><span style="flex:1">Connected as <b>${esc(al.user?.name || '?')}</b></span>
        <button class="btn small danger" id="disc">Disconnect</button></div>
        <label style="display:block;margin-top:12px"><input type="checkbox" id="autoSync" ${al.autoSync ? 'checked' : ''}>
          Automatically update AniList when I finish a chapter or episode</label>
        <p class="muted">Otherwise use the “Add to AniList” button on the reader page. Progress only ever moves forward.</p>`
      : `
        <p>Connect your account so you can log chapters to your AniList manga list right from the reader.</p>
        <ol class="steps">
          <li>Open <a href="https://anilist.co/settings/developer" target="_blank" rel="noopener">anilist.co/settings/developer</a> and click <b>Create New Client</b>.</li>
          <li>Set <b>Redirect URL</b> to <code class="k">${esc(origin)}/auth.html</code> and save.</li>
          <li>Paste the client <b>ID</b> below, then press Connect (do this from the browser on the server PC if you use <code class="k">localhost</code>).</li>
        </ol>
        <div class="form-row"><input type="text" id="clientId" placeholder="Client ID" value="${esc(al.clientId)}">
          <button class="btn primary" id="connect">Connect AniList</button></div>
        <details style="margin-top:12px"><summary class="muted">Or paste an access token manually</summary>
          <div class="form-row"><input type="password" id="tok" placeholder="Access token (or the full redirect URL)">
          <button class="btn" id="saveTok">Save token</button></div></details>`}
    </div>

    <div class="panel"><h2>Updates</h2>
      <div class="list-row"><span style="flex:1">MangaSoft <b>v${esc(up.version)}</b>
        ${up.available ? `<span class="pill high">v${esc(up.available.version)} available</span>` : up.url && !up.error ? '<span class="muted"> · up to date</span>' : ''}</span>
        <button class="btn small" id="updCheck" ${up.url ? '' : 'disabled'}>Check now</button></div>
      ${up.available ? `<div style="margin:10px 0"><b>What's new in v${esc(up.available.version)}</b>
        <div class="muted" style="white-space:pre-line">${esc(up.available.notes || 'No release notes.')}</div>
        <div class="form-row"><button class="btn primary" id="updInstall" ${up.supervised ? '' : 'disabled'}>Install v${esc(up.available.version)} &amp; restart</button></div></div>` : ''}
      ${!up.supervised ? '<p class="muted">This copy wasn’t started through its launcher (start.bat, the tray app, or Docker), so it can’t restart itself to update.</p>' : ''}
      ${up.failedVersion ? `<p class="muted">⚠️ v${esc(up.failedVersion)} failed to start on this machine and was rolled back (${esc(up.failedReason || '')}).</p>` : ''}
      ${up.error ? `<p class="muted">⚠️ ${esc(up.error)}</p>` : ''}
      <div class="form-row"><input type="text" id="updUrl" placeholder="Update server address (leave empty for no updates)" value="${esc(up.url)}">
        <button class="btn" id="updSave">Save</button></div>
      <label style="display:block;margin-top:10px"><input type="checkbox" id="autoUpd" ${up.autoUpdate ? 'checked' : ''}>
        Install updates automatically (when nobody is using it)</label>
      <p class="muted" style="margin-bottom:0">Updates replace the program only. Your library, reading progress, settings and media folders are never touched,
        and every update must be signed by the publisher or it is refused. ${up.lastChecked ? 'Last checked ' + new Date(up.lastChecked).toLocaleString() + '.' : ''}</p>
    </div>

    <div class="panel"><h2>Series page</h2>
      <p class="muted" style="margin-top:0">How a series opens when it has more than one volume. Gallery shows the volume covers;
        click one to see its chapters. Remembered separately on each device.</p>
      <div class="seg" id="viewPref" style="max-width:320px">
        <button data-v="gallery">Gallery</button><button data-v="chapters">Chapter list</button>
      </div>
    </div>

    <div class="panel"><h2>Theme</h2>
      <div class="themes">${THEMES.map((t) => `<div class="theme-opt ${prefs.theme === t.id ? 'on' : ''}" data-t="${t.id}">
        <div class="sw">${t.colors.map((c) => `<i style="background:${c}"></i>`).join('')}</div>${t.name}</div>`).join('')}</div>
      <p class="muted">Themes are remembered per device. Reader layout (scroll / pages / spreads, direction) is set from the ⚙ button while reading.</p>
    </div>`;

  const refresh = () => renderSettings();
  $('#addLib').addEventListener('click', async () => {
    try { await api('/libraries', { method: 'POST', body: { path: $('#newLib').value } }); refresh(); refreshNav(); }
    catch (e) { toast(e.message, true); }
  });
  const scanLib = async (e) => {
    const lib = e.target.dataset?.scan; if (!lib) return;
    try {
      await api('/scan', { method: 'POST', body: { library: lib } });
      toast('Checking that folder…');
      scanBanner(view, undefined, true);
    } catch (err) { toast(err.message, true); }
  };
  $('#libs').addEventListener('click', scanLib);
  bindAnimeSettings(refresh, scanLib);
  bindNovelSettings(refresh, scanLib);
  $('#djLibs')?.addEventListener('click', scanLib);
  $('#libs').addEventListener('click', async (e) => {
    const p = e.target.dataset.rm; if (!p) return;
    await api('/libraries', { method: 'DELETE', body: { path: p } }); refresh();
  });
  $('#addDj')?.addEventListener('click', async () => {
    try { await api('/doujin/libraries', { method: 'POST', body: { path: $('#newDj').value } }); refresh(); }
    catch (e) { toast(e.message, true); }
  });
  $('#djLibs')?.addEventListener('click', async (e) => {
    const p = e.target.dataset.djrm; if (!p) return;
    await api('/doujin/libraries', { method: 'DELETE', body: { path: p } }); refresh();
  });
  $('#nhAuto')?.addEventListener('change', (e) => api('/settings', { method: 'PUT', body: { nhAutoMatch: e.target.checked } }));
  $('#djHide')?.addEventListener('change', async (e) => {
    await api('/settings', { method: 'PUT', body: { doujinHideNav: e.target.checked } }); refreshNav();
  });
  $('#saveKey')?.addEventListener('click', async () => {
    if (!$('#nhKey').value.trim()) return toast('Enter an API key first', true);
    await api('/settings', { method: 'PUT', body: { nhApiKey: $('#nhKey').value } }); toast('API key saved'); refresh();
  });
  $('#clearKey')?.addEventListener('click', async () => {
    await api('/settings', { method: 'PUT', body: { nhApiKey: '' } }); refresh();
  });
  $('#pinSave')?.addEventListener('click', async () => {
    try {
      const r = await api('/doujin/pin', { method: 'PUT', body: { pin: $('#pinNew').value, current: $('#pinCur')?.value || '' } });
      toast(r.pinSet ? 'PIN saved' : 'PIN removed');
      refresh();
    } catch (e) { toast(e.message, true); }
  });
  const drawViewPref = () => {
    const cur = localStorage.getItem('ms.seriesView') || 'gallery';
    document.querySelectorAll('#viewPref button').forEach((b) => b.classList.toggle('on', b.dataset.v === cur));
  };
  drawViewPref();
  $('#viewPref').addEventListener('click', (e) => {
    const v = e.target.dataset.v; if (!v) return;
    localStorage.setItem('ms.seriesView', v);
    drawViewPref();
  });
  $('#updSave').addEventListener('click', async () => {
    await api('/settings', { method: 'PUT', body: { updateUrl: $('#updUrl').value } });
    try { await api('/update/check', { method: 'POST' }); } catch { /* shown below */ }
    refresh();
  });
  $('#autoUpd').addEventListener('change', (e) => api('/settings', { method: 'PUT', body: { autoUpdate: e.target.checked } }));
  $('#updCheck').addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Checking…';
    try { await api('/update/check', { method: 'POST' }); } catch (err) { toast(err.message, true); }
    refresh(); refreshNav();
  });
  $('#updInstall')?.addEventListener('click', async (e) => {
    if (!confirm('Install the update now? MangaSoft restarts for a few seconds.')) return;
    e.target.disabled = true; e.target.textContent = 'Downloading & verifying…';
    try {
      await api('/update/install', { method: 'POST' });
      e.target.textContent = 'Restarting…';
      const from = up.version, t0 = Date.now();
      const wait = async () => {
        try {
          const st = await api('/update/status');
          if (st.version !== from) return location.reload();
        } catch { /* server is restarting */ }
        if (Date.now() - t0 > 90_000) { e.target.textContent = 'Taking a while… reload the page'; return; }
        setTimeout(wait, 1500);
      };
      setTimeout(wait, 2500);
    } catch (err) { toast(err.message, true); e.target.disabled = false; e.target.textContent = 'Install update'; }
  });
  $('#restartBtn')?.addEventListener('click', async () => {
    if (!confirm('Restart MangaSoft now? Anything playing or scanning will stop.')) return;
    try { await api('/restart', { method: 'POST' }); } catch (err) {
      // an older server process has no restart route yet: it has to be restarted by hand once
      toast(/not found|404/i.test(err.message)
        ? 'This server is still running the previous version. Close and start MangaSoft once yourself; after that this button works.'
        : err.message, true);
      return;
    }
    const veil = document.createElement('div');
    veil.className = 'restart-veil';
    veil.innerHTML = '<div class="spinner"></div><div>Restarting…</div>';
    document.body.append(veil);
    const t0 = Date.now();
    const poll = async () => {
      try { const r = await fetch('/api/scan', { cache: 'no-store' }); if (r.ok) { location.reload(); return; } } catch { /* still down */ }
      if (Date.now() - t0 > 90_000) { veil.innerHTML = '<div>Taking longer than expected. Reload this page in a moment.</div>'; return; }
      setTimeout(poll, 1000);
    };
    setTimeout(poll, 2000);
  });
  const autoPut = (body) => api('/auto-scan', { method: 'PUT', body }).catch((err) => toast(err.message, true));
  $('#asOn')?.addEventListener('change', (e) => autoPut({ enabled: e.target.checked }));
  $('#asMin')?.addEventListener('change', (e) => autoPut({ minutes: Number(e.target.value) }));
  $('#asWatch')?.addEventListener('change', (e) => autoPut({ watch: e.target.checked }));
  $('#rescan').addEventListener('click', async () => { await api('/scan', { method: 'POST', body: {} }); scanBanner(view, undefined, true); });
  $('#rematch').addEventListener('click', async () => { await api('/scan', { method: 'POST', body: { rematch: true } }); scanBanner(view); });
  $('#autoMatch').addEventListener('change', (e) => api('/settings', { method: 'PUT', body: { autoMatch: e.target.checked } }));
  $('#metaOrder').addEventListener('change', (e) => api('/settings', { method: 'PUT', body: { metaOrder: e.target.value } }));
  $('#mdFallback').addEventListener('change', (e) => api('/settings', { method: 'PUT', body: { mangadexFallback: e.target.checked } }));
  $('#contCh').addEventListener('change', async (e) => {
    await api('/settings', { method: 'PUT', body: { continuousChapters: e.target.checked } });
    await api('/scan', { method: 'POST', body: {} });
    toast('Renumbering chapters…');
    scanBanner(view, undefined, true);
  });
  $('#showMissing').addEventListener('change', (e) => api('/settings', { method: 'PUT', body: { showMissing: e.target.checked } }));
  $('#offCovers').addEventListener('change', (e) => api('/settings', { method: 'PUT', body: { officialCovers: e.target.checked } }));
  $('#autoSync')?.addEventListener('change', (e) => api('/settings', { method: 'PUT', body: { autoSync: e.target.checked } }));
  $('#disc')?.addEventListener('click', async () => { await api('/anilist/token', { method: 'DELETE' }); refresh(); });
  $('#connect')?.addEventListener('click', async () => {
    const id = $('#clientId').value.trim();
    if (!/^\d+$/.test(id)) return toast('Enter your numeric AniList client ID', true);
    await api('/settings', { method: 'PUT', body: { clientId: id } });
    location.href = `https://anilist.co/api/v2/oauth/authorize?client_id=${id}&response_type=token`;
  });
  $('#saveTok')?.addEventListener('click', async () => {
    try { await api('/anilist/token', { method: 'POST', body: { token: $('#tok').value } }); refresh(); }
    catch (e) { toast(e.message, true); }
  });
  document.querySelector('.themes').addEventListener('click', (e) => {
    const t = e.target.closest('.theme-opt'); if (!t) return;
    prefs.theme = t.dataset.t; savePrefs();
    document.querySelectorAll('.theme-opt').forEach((o) => o.classList.toggle('on', o === t));
  });
  scanBanner(view);
}

// ---------- reader ----------
async function renderReader(chapterId) {
  const ch = await api(`/chapters/${chapterId}`);
  if (ch.series.kind === 'novel') return renderNovelReader(ch);
  const al = await api('/anilist/status').catch(() => ({ connected: false }));
  document.body.classList.add('reading');
  $('#nav').classList.add('hidden');
  view.classList.add('hidden');

  const ov = $('#overlay');
  const total = ch.pageCount;
  const img = (n) => `/api/chapters/${ch.id}/page/${n}`;
  let cur = ch.completed ? 0 : Math.min(ch.page, Math.max(0, total - 1));
  let finished = ch.completed;
  let synced = false;
  let popOpen = false;
  let saveTimer;

  const chNo = ch.number != null ? ch.number : ch.index;
  const isDj = ch.series.kind === 'doujin';
  const canSync = !isDj && al.connected && ch.series.anilistId;
  const alLabel = () => {
    if (!al.connected) return 'Connect AniList';
    if (!ch.series.anilistId) return 'Match on AniList';
    return synced ? `✓ AniList: ch ${chNo}` : `＋ Mark ch ${chNo} read on AniList`;
  };

  ov.innerHTML = `
    <div class="reader" id="reader">
      <div class="rbar">
        <a class="btn small" href="#/series/${ch.series.id}" title="Back (Esc)">←</a>
        <div class="title"><b>${esc(ch.series.title)}</b> <span class="muted">· ${esc(ch.title)}</span></div>
        <span class="pg" id="pg"></span>
        ${isDj ? '' : `<button class="btn small" id="alBtn"><span class="al-label">${esc(alLabel())}</span><span class="hidden-label">${synced ? '✓' : '＋'}</span></button>`}
        <button class="btn small" id="prevCh" ${ch.prevId ? '' : 'disabled'} title="Previous chapter">⏮</button>
        <button class="btn small" id="nextCh" ${ch.nextId ? '' : 'disabled'} title="Next chapter">⏭</button>
        <button class="btn small" id="gear" title="Reader settings">⚙</button>
      </div>
      <div id="pop"></div>
      <div class="rstage" id="stage"></div>
    </div>`;
  const reader = $('#reader'), stage = $('#stage');

  // --- sync to AniList ---
  async function markOnAniList({ silent = false } = {}) {
    if (isDj) return;
    if (!al.connected) { location.hash = '#/settings'; return; }
    if (!ch.series.anilistId) { toast('Match this series to AniList first (series page → Match on AniList)', true); return; }
    try {
      let r = await api('/anilist/progress', { method: 'POST', body: { chapterId: ch.id } });
      const of = ch.series.chaptersTotal ? ` / ${ch.series.chaptersTotal}` : '';
      if (!r.changed && r.target < r.previous) {
        // AniList is already further along; only go backwards if the user explicitly says so
        if (!silent && confirm(`AniList already has you at chapter ${r.previous}.\nSet your progress back to chapter ${r.target}?`)) {
          r = await api('/anilist/progress', { method: 'POST', body: { chapterId: ch.id, force: true } });
        } else {
          synced = true; refreshAlButton();
          if (!silent) toast(`AniList is already at chapter ${r.previous} - nothing to update`);
          return;
        }
      }
      synced = true;
      refreshAlButton();
      const e = r.entry;
      toast(r.changed
        ? `✓ AniList updated: ${r.previous} → ${e.progress}${of} (${STATUS_LABEL[e.status] || e.status})`
        : `AniList already at chapter ${e.progress}${of} - nothing to update`);
    } catch (e) { if (!silent) toast(e.message, true); }
  }
  function refreshAlButton() {
    if ($('#alBtn')) {
      $('#alBtn .al-label').textContent = alLabel();
      $('#alBtn .hidden-label').textContent = synced ? '✓' : '＋'; // the only thing visible on phones
      $('#alBtn').classList.toggle('primary', synced);
    }
    document.querySelectorAll('.end-al').forEach((b) => { b.textContent = alLabel(); });
  }
  $('#alBtn')?.addEventListener('click', () => markOnAniList());

  // --- progress ---
  function pushProgress(completed = false) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => api('/progress', { method: 'POST', body: { chapterId: ch.id, page: cur, completed } }).catch(() => {}), completed ? 0 : 500);
  }
  function onFinish() {
    if (finished) return;
    finished = true;
    pushProgress(true);
    if (al.autoSync && canSync) markOnAniList({ silent: true });
  }
  function setPage(n, { silent = false } = {}) {
    cur = Math.max(0, Math.min(n, total - 1));
    $('#pg').textContent = `${cur + 1} / ${total}`;
    if (!silent) pushProgress(false);
    if (cur >= total - 1) onFinish();
  }

  // --- end card ---
  const endCard = () => `<div class="endcard">
      <h2>End of ${esc(ch.title)}</h2>
      <p class="muted">${ch.nextId ? 'Ready for the next one?' : 'You’re all caught up.'}</p>
      <div class="actions">
        ${!isDj && (canSync || !al.connected || !ch.series.anilistId) ? `<button class="btn ${synced ? '' : 'primary'} end-al">${esc(alLabel())}</button>` : ''}
        ${ch.nextId ? `<a class="btn primary" href="#/read/${ch.nextId}">Next chapter →</a>` : ''}
        <a class="btn" href="#/series/${ch.series.id}">Chapter list</a>
      </div></div>`;
  const bindEnd = () => stage.querySelectorAll('.end-al').forEach((b) => b.addEventListener('click', () => markOnAniList()));

  // --- stage builders ---
  let spreads = [], pos = 0, scrollObserver;
  const rtl = () => prefs.dir === 'rtl';

  function buildSpreads() {
    spreads = [];
    if (prefs.mode === 'double') {
      let i = 0;
      if (prefs.coverAlone && total > 0) { spreads.push([0]); i = 1; }
      for (; i < total; i += 2) spreads.push(i + 1 < total ? [i, i + 1] : [i]);
    } else {
      for (let i = 0; i < total; i++) spreads.push([i]);
    }
  }

  function buildStage() {
    scrollObserver?.disconnect();
    stage.className = 'rstage';
    stage.onscroll = null;
    stage.innerHTML = '';
    reader.className = 'reader' + (reader.classList.contains('immersive') ? ' immersive' : '');

    if (prefs.mode === 'scroll') {
      stage.classList.add('scroll');
      const w = prefs.width ? `${prefs.width}px` : '100%';
      stage.innerHTML = `<div class="pages" style="max-width:${w}">
        ${Array.from({ length: total }, (_, i) => `<img data-i="${i}" loading="${i < 3 ? 'eager' : 'lazy'}" src="${img(i)}" alt="Page ${i + 1}">`).join('')}
        </div>${endCard()}`;
      bindEnd();
      const imgs = [...stage.querySelectorAll('.pages img')];
      let ticking = false;
      stage.onscroll = () => {
        if (ticking) return; ticking = true;
        requestAnimationFrame(() => {
          ticking = false;
          const mid = stage.getBoundingClientRect().top + stage.clientHeight * 0.4;
          let idx = 0;
          for (let i = 0; i < imgs.length; i++) { if (imgs[i].getBoundingClientRect().top <= mid) idx = i; else break; }
          const atEnd = stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 40;
          if (idx !== cur || atEnd) setPage(atEnd ? total - 1 : idx);
        });
      };
      if (cur > 0) requestAnimationFrame(() => imgs[cur]?.scrollIntoView());
      setPage(cur, { silent: true });
      return;
    }

    // paged / double
    buildSpreads();
    pos = Math.max(0, spreads.findIndex((s) => s.includes(cur)));
    stage.classList.add('paged', `fit-${prefs.fit}`, prefs.mode === 'double' ? 'double' : 'single');
    stage.innerHTML = `<div class="tap l" data-a="left"></div><div class="tap mid" data-a="mid"></div><div class="tap r" data-a="right"></div>
      <div id="spreadHost" style="display:contents"></div>`;
    stage.querySelector('.tap.l').onclick = () => (rtl() ? step(1) : step(-1));
    stage.querySelector('.tap.r').onclick = () => (rtl() ? step(-1) : step(1));
    stage.querySelector('.tap.mid').onclick = () => reader.classList.toggle('immersive');
    // swipe navigation (phones/tablets); ignored while pinch-zoomed
    let sx = 0, sy = 0, st = 0;
    stage.ontouchstart = (e) => { if (e.touches.length === 1) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now(); } else st = 0; };
    stage.ontouchend = (e) => {
      if (!st || Date.now() - st > 600 || (window.visualViewport && window.visualViewport.scale > 1.05)) return;
      const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? (rtl() ? -1 : 1) : (rtl() ? 1 : -1));
    };
    showSpread();
  }

  function showSpread() {
    const host = $('#spreadHost');
    if (pos >= spreads.length) { // end card
      host.innerHTML = `<div style="overflow:auto;max-height:100%">${endCard()}</div>`;
      bindEnd();
      stage.querySelectorAll('.tap').forEach((t) => { t.style.display = 'none'; }); // zones would cover the buttons
      $('#pg').textContent = `${total} / ${total}`;
      onFinish();
      return;
    }
    stage.querySelectorAll('.tap').forEach((t) => { t.style.display = ''; });
    const s = spreads[pos];
    host.innerHTML = `<div class="spread ${rtl() ? 'rtl' : ''}">${s.map((i) => `<img src="${img(i)}" alt="Page ${i + 1}">`).join('')}</div>`;
    stage.scrollTop = 0;
    setPage(s[0]);
    if (s.length > 1) $('#pg').textContent = `${s[0] + 1}-${s[1] + 1} / ${total}`;
    if (s[s.length - 1] >= total - 1) onFinish(); // last spread counts as finished
    for (const n of (spreads[pos + 1] || []).concat(spreads[pos + 2] || [])) new Image().src = img(n); // preload
  }

  function step(d) {
    if (prefs.mode === 'scroll') {
      stage.scrollBy({ top: d * stage.clientHeight * 0.85, behavior: 'smooth' });
      return;
    }
    const n = pos + d;
    if (n < 0) { if (ch.prevId) location.hash = `#/read/${ch.prevId}`; return; }
    if (n > spreads.length) return;
    pos = n;
    showSpread();
  }

  // --- settings popover ---
  function seg(key, opts) {
    return `<div class="seg" data-k="${key}">${opts.map(([v, l]) => `<button data-v="${v}" class="${String(prefs[key]) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  }
  function drawPop() {
    const pop = $('#pop');
    if (!popOpen) { pop.innerHTML = ''; return; }
    pop.innerHTML = `<div class="rpop">
      <label>Layout</label>${seg('mode', [['scroll', 'Scroll'], ['single', 'Page'], ['double', 'Spread']])}
      ${prefs.mode !== 'scroll' ? `<label>Reading direction</label>${seg('dir', [['rtl', 'Right → Left'], ['ltr', 'Left → Right']])}
        <label>Fit</label>${seg('fit', [['both', 'Screen'], ['width', 'Width'], ['height', 'Height']])}` : `
        <label>Page width</label>${seg('width', [[600, 'Narrow'], [800, 'Medium'], [1100, 'Wide'], [0, 'Full']])}`}
      ${prefs.mode === 'double' ? `<label>First page</label>${seg('coverAlone', [[true, 'Alone'], [false, 'Paired']])}` : ''}
      <label>Theme</label>
      <div class="theme-dots">${THEMES.map((t) => `<button title="${t.name}" data-theme="${t.id}" class="${prefs.theme === t.id ? 'on' : ''}"
        style="background:linear-gradient(135deg,${t.colors[0]} 50%,${t.colors[2]} 50%)"></button>`).join('')}</div>
    </div>`;
    pop.querySelectorAll('.seg').forEach((sg) => sg.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const k = sg.dataset.k; let v = b.dataset.v;
      if (v === 'true') v = true; else if (v === 'false') v = false; else if (k === 'width') v = Number(v);
      prefs[k] = v; savePrefs(); drawPop(); buildStage();
    }));
    pop.querySelector('.theme-dots').addEventListener('click', (e) => {
      const t = e.target.dataset.theme; if (!t) return;
      prefs.theme = t; savePrefs(); drawPop();
    });
  }
  $('#gear').addEventListener('click', () => { popOpen = !popOpen; drawPop(); });

  $('#prevCh').addEventListener('click', () => ch.prevId && (location.hash = `#/read/${ch.prevId}`));
  $('#nextCh').addEventListener('click', () => ch.nextId && (location.hash = `#/read/${ch.nextId}`));

  // --- keyboard ---
  const onKey = (e) => {
    if (e.target.matches('input, select, textarea')) return;
    // Right / Down / PageDown / Space = next page, Left / Up / PageUp = previous, in every mode
    // (tap zones and swipes still follow the reading direction).
    switch (e.key) {
      case 'ArrowRight': case 'ArrowDown': case 'PageDown': case ' ':
        e.target.blur?.(); step(1); break;
      case 'ArrowLeft': case 'ArrowUp': case 'PageUp': step(-1); break;
      case 'n': if (ch.nextId) location.hash = `#/read/${ch.nextId}`; break;
      case 'p': if (ch.prevId) location.hash = `#/read/${ch.prevId}`; break;
      case 'm': markOnAniList(); break;
      case 'f': document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.(); break;
      case 'Escape': location.hash = `#/series/${ch.series.id}`; break;
      default: return;
    }
    if (e.key === ' ' || e.key.startsWith('Arrow') || e.key.startsWith('Page')) e.preventDefault();
  };
  window.addEventListener('keydown', onKey);
  cleanup = () => { window.removeEventListener('keydown', onKey); scrollObserver?.disconnect(); clearTimeout(saveTimer); };

  if (total === 0) { stage.innerHTML = '<div class="empty">This chapter has no readable pages.</div>'; return; }
  buildStage();
}

// ---------- boot ----------
route();
