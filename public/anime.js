'use strict';

// Anime section: library, series page and video player. Loaded before app.js; everything here runs on demand
// (it uses $, view, api, esc, toast, cleanup … from app.js only when a page is rendered).

const animePrefs = (() => {
  const d = { audioLang: 'jpn', subLang: 'eng', subs: true, burn: false, height: 0, autoNext: true };
  try { return { ...d, ...JSON.parse(localStorage.getItem('ms.anime') || '{}') }; } catch { return d; }
})();
// how subtitles look: soft subtitles always follow it; burned-in ones only when "applyBurn" is on
const SUB_DEFAULT = { useAss: true, size: 100, color: '#ffffff', outline: 2, shadow: 1, bg: false, bgColor: '#000000', bgOpacity: 60, font: 'sans', applyBurn: false };
animePrefs.sub = { ...SUB_DEFAULT, ...(animePrefs.sub || {}) };
const SUB_FONTS = { sans: 'system-ui, "Segoe UI", Arial, sans-serif', serif: 'Georgia, "Times New Roman", serif', mono: 'Consolas, "Courier New", monospace', rounded: '"Trebuchet MS", "Segoe UI", sans-serif' };
const hex6 = (c) => String(c).replace('#', '').toLowerCase().padEnd(6, '0').slice(0, 6);
/** The look as the server wants it for burned-in subtitles, or '' for the file's own styling. */
function subStyleParam() {
  const s = animePrefs.sub;
  if (!s.applyBurn) return '';
  return [Math.round(s.size), hex6(s.color), s.outline, s.shadow, s.bg ? hex6(s.bgColor) : 'n', Math.round(s.bgOpacity)].join('_');
}
/** CSS for the browser's subtitle layer (::cue) on the player video. */
function subCueCss(videoH) {
  const s = animePrefs.sub;
  const px = Math.max(12, Math.round((videoH || 480) * 0.045 * s.size / 100));
  const edge = [];
  if (s.outline) for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) if (x || y) edge.push(`${x * s.outline * 0.7}px ${y * s.outline * 0.7}px 0 #000`);
  if (s.shadow) edge.push(`${s.shadow}px ${s.shadow}px ${s.shadow * 2}px rgba(0,0,0,.9)`);
  const rgb = hex6(s.bgColor).match(/../g).map((h) => parseInt(h, 16)).join(',');
  return `#vid::cue { color: ${s.color}; font-size: ${px}px; font-family: ${SUB_FONTS[s.font] || SUB_FONTS.sans};
    background-color: ${s.bg ? `rgba(${rgb},${s.bgOpacity / 100})` : 'transparent'}; text-shadow: ${edge.join(',') || 'none'}; line-height: 1.25; }`;
}
/** Subtitle look controls (the player's menu and the settings page share them). */
function subStyleHtml(idp) {
  const s = animePrefs.sub;
  const opt = (v, cur, l) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${l}</option>`;
  return `<div class="substyle">
    <label class="ssburn"><input type="checkbox" id="${idp}ass" ${s.useAss ? 'checked' : ''}> Show styled (ASS) subtitles the way they were made
      <span class="muted">(signs, fonts, karaoke). The look below is then used for plain subtitles only.</span></label>
    <div class="ssrow"><label>Size</label><input type="range" id="${idp}size" min="50" max="250" step="10" value="${s.size}"><span class="muted" id="${idp}sizeV">${s.size}%</span></div>
    <div class="ssrow"><label>Text</label><input type="color" id="${idp}color" value="${s.color}">
      <select id="${idp}font">${opt('sans', s.font, 'Sans')}${opt('serif', s.font, 'Serif')}${opt('mono', s.font, 'Mono')}${opt('rounded', s.font, 'Rounded')}</select></div>
    <div class="ssrow"><label>Outline</label><select id="${idp}outline">${opt(0, s.outline, 'None')}${opt(1, s.outline, 'Thin')}${opt(2, s.outline, 'Medium')}${opt(3, s.outline, 'Thick')}</select>
      <label>Shadow</label><select id="${idp}shadow">${opt(0, s.shadow, 'None')}${opt(1, s.shadow, 'Soft')}${opt(2, s.shadow, 'Medium')}${opt(3, s.shadow, 'Hard')}</select></div>
    <div class="ssrow"><label><input type="checkbox" id="${idp}bg" ${s.bg ? 'checked' : ''}> Background</label>
      <input type="color" id="${idp}bgColor" value="${s.bgColor}"><input type="range" id="${idp}bgOp" min="10" max="100" step="10" value="${s.bgOpacity}" title="Opacity"></div>
    <label class="ssburn"><input type="checkbox" id="${idp}burn" ${s.applyBurn ? 'checked' : ''}> Also use this look for burned-in subtitles
      <span class="muted">(replaces the file's own styling, signs included)</span></label>
    <div class="sspreview" id="${idp}prev"><span>The quick brown fox jumps over the lazy dog</span></div>
    <button class="btn small" type="button" id="${idp}reset">Reset</button>
  </div>`;
}
function bindSubStyle(idp, onChange) {
  const s = animePrefs.sub;
  const prev = () => {
    const el = document.getElementById(idp + 'prev');
    if (!el) return;
    const rgb = hex6(s.bgColor).match(/../g).map((h) => parseInt(h, 16)).join(',');
    const sp = el.firstElementChild;
    const edge = [];
    if (s.outline) for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) if (x || y) edge.push(`${x * s.outline * 0.7}px ${y * s.outline * 0.7}px 0 #000`);
    if (s.shadow) edge.push(`${s.shadow}px ${s.shadow}px ${s.shadow * 2}px rgba(0,0,0,.9)`);
    sp.style.cssText = `color:${s.color};font-family:${SUB_FONTS[s.font] || SUB_FONTS.sans};font-size:${Math.round(16 * s.size / 100)}px;
      background:${s.bg ? `rgba(${rgb},${s.bgOpacity / 100})` : 'transparent'};text-shadow:${edge.join(',') || 'none'};padding:2px 6px;border-radius:3px`;
    const v = document.getElementById(idp + 'sizeV'); if (v) v.textContent = s.size + '%';
  };
  const bind = (suffix, key, read) => {
    const el = document.getElementById(idp + suffix);
    if (!el) return;
    el.addEventListener('input', () => { s[key] = read(el); saveAnimePrefs(); prev(); onChange?.(key); });
  };
  bind('size', 'size', (e) => Number(e.value)); bind('color', 'color', (e) => e.value); bind('font', 'font', (e) => e.value);
  bind('outline', 'outline', (e) => Number(e.value)); bind('shadow', 'shadow', (e) => Number(e.value));
  bind('bg', 'bg', (e) => e.checked); bind('bgColor', 'bgColor', (e) => e.value); bind('bgOp', 'bgOpacity', (e) => Number(e.value));
  bind('burn', 'applyBurn', (e) => e.checked);
  bind('ass', 'useAss', (e) => e.checked);
  document.getElementById(idp + 'reset')?.addEventListener('click', () => {
    Object.assign(s, SUB_DEFAULT); saveAnimePrefs();
    const host = document.getElementById(idp + 'prev')?.closest('.substyle');
    if (host) { host.outerHTML = subStyleHtml(idp); bindSubStyle(idp, onChange); }
    onChange?.('reset');
  });
  prev();
}

function saveAnimePrefs() {
  try { localStorage.setItem('ms.anime', JSON.stringify(animePrefs)); } catch { /* private mode */ }
}

const LANG_ALIAS = { ja: 'jpn', jp: 'jpn', en: 'eng', es: 'spa', fr: 'fre', fra: 'fre', de: 'ger', deu: 'ger', zh: 'chi', zho: 'chi', ko: 'kor', pt: 'por', ru: 'rus', it: 'ita' };
const langKey = (l) => LANG_ALIAS[l] || l || '';
const LANG_CHOICES = [['jpn', 'Japanese'], ['eng', 'English'], ['spa', 'Spanish'], ['fre', 'French'], ['ger', 'German'], ['por', 'Portuguese'], ['ita', 'Italian'], ['rus', 'Russian'], ['kor', 'Korean'], ['chi', 'Chinese']];

function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

let hlsLoader = null;
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  hlsLoader ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/hls.min.js';
    s.onload = () => resolve(window.Hls);
    s.onerror = () => { hlsLoader = null; reject(new Error('Could not load the video player component')); };
    document.head.append(s);
  });
  return hlsLoader;
}

// ---------- context menu: right-click, long-press, or the ⋯ button ----------
let ctxEl = null;
function closeCtx() { ctxEl?.remove(); ctxEl = null; }
function openCtx(x, y, items) {
  closeCtx();
  // no separator first, last or twice in a row
  const list = (items || []).filter(Boolean).filter((it, i, all) => !it.sep || (i > 0 && !all[i - 1].sep));
  while (list.length && list[list.length - 1].sep) list.pop();
  if (!list.length) return;
  const el = document.createElement('div');
  el.className = 'ctxmenu';
  el.innerHTML = list.map((it, i) => (it.sep ? '<hr>' : `<button type="button" data-i="${i}" class="${it.danger ? 'danger' : ''}">${esc(it.label)}</button>`)).join('');
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    e.stopPropagation();
    const it = list[Number(b.dataset.i)];
    closeCtx();
    try { await it.run(); } catch (err) { toast(err.message || String(err), true); }
  });
  document.body.append(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 6)) + 'px';
  el.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 6)) + 'px';
  ctxEl = el;
}
document.addEventListener('mousedown', (e) => { if (ctxEl && !ctxEl.contains(e.target)) closeCtx(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtx(); });
window.addEventListener('hashchange', closeCtx);
window.addEventListener('resize', closeCtx);

/** Menu for every `selector` element inside `root`: build(el) returns [{ label, run, danger? } | { sep: true }]. */
function bindCtx(root, selector, build) {
  if (!root) return;
  root.addEventListener('contextmenu', (e) => {
    const el = e.target.closest(selector); if (!el) return;
    const items = build(el);
    if (!items?.length) return;
    e.preventDefault();
    openCtx(e.clientX, e.clientY, items);
  });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('.more'); if (!b) return;
    const el = b.closest(selector); if (!el) return;
    e.preventDefault(); e.stopPropagation();
    const r = b.getBoundingClientRect();
    openCtx(r.left - 160, r.bottom + 4, build(el));
  });
  // touch: press and hold
  let timer = null, fired = false, sx = 0, sy = 0;
  root.addEventListener('touchstart', (e) => {
    const el = e.target.closest(selector);
    if (!el || e.touches.length !== 1) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; fired = false;
    clearTimeout(timer);
    timer = setTimeout(() => { fired = true; openCtx(sx, sy, build(el)); }, 550);
  }, { passive: true });
  root.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10) clearTimeout(timer);
  }, { passive: true });
  root.addEventListener('touchend', (e) => { clearTimeout(timer); if (fired) e.preventDefault(); });
  root.addEventListener('click', (e) => { if (fired) { fired = false; e.preventDefault(); e.stopPropagation(); } }, true);
}

const cap = (w) => (w ? w.charAt(0) + w.slice(1).toLowerCase() : '');
const seasonLabel = (k) => { const [y, s] = String(k).split(' '); return `${cap(s)} ${y}`; };

/** Pick one of your anime by name (or several, with multi: true). */
function pickAnime({ title, note, exclude = [], onPick, multi = false }) {
  const ov = $('#overlay');
  const close = () => { ov.innerHTML = ''; };
  const chosen = new Set();
  ov.innerHTML = `<div class="modal-bg"><div class="modal">
    <h2 style="margin-top:0">${esc(title)}</h2>
    <p class="muted" style="margin-top:0">${esc(note)}</p>
    <div class="form-row" style="margin-top:0"><input type="search" id="pq" placeholder="Search your anime…" autofocus></div>
    <div id="pres" style="margin-top:8px"></div>
    <div class="form-row" style="justify-content:flex-end">
      ${multi ? '<button class="btn" id="pall">Select all results</button><span style="flex:1"></span><button class="btn primary" id="pgo" disabled>Add</button>' : ''}
      <button class="btn" id="pclose">Close</button></div></div></div>`;
  const box = $('#pres');
  let timer, shown = [];
  const sync = () => {
    box.querySelectorAll('.result').forEach((r) => r.classList.toggle('on', chosen.has(Number(r.dataset.id))));
    if (multi) { $('#pgo').disabled = !chosen.size; $('#pgo').textContent = chosen.size ? `Add ${chosen.size}` : 'Add'; }
  };
  const search = async () => {
    const q = $('#pq').value.trim();
    if (q.length < 2) { box.innerHTML = '<div class="muted">Type at least two letters.</div>'; return; }
    try {
      shown = (await api(`/series-search?kind=anime&q=${encodeURIComponent(q)}`)).filter((r) => !exclude.includes(r.id));
      box.innerHTML = shown.map((r) => `<div class="result" data-id="${r.id}">
        <img src="/api/series/${r.id}/cover" alt=""><div><b>${esc(r.title)}</b>
        <div class="muted">${r.year || ''}</div></div></div>`).join('') || '<div class="muted">No matches.</div>';
      sync();
    } catch (e) { box.innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
  };
  $('#pq').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });
  box.addEventListener('click', async (e) => {
    const r = e.target.closest('.result'); if (!r) return;
    const rid = Number(r.dataset.id);
    if (multi) { if (chosen.has(rid)) chosen.delete(rid); else chosen.add(rid); sync(); return; }
    try { await onPick(rid); close(); } catch (err) { toast(err.message, true); }
  });
  $('#pall')?.addEventListener('click', () => { shown.forEach((r) => chosen.add(r.id)); sync(); });
  $('#pgo')?.addEventListener('click', async () => {
    try { await onPick([...chosen]); close(); } catch (err) { toast(err.message, true); }
  });
  $('#pclose').addEventListener('click', close);
  $('.modal-bg').addEventListener('mousedown', (e) => e.target.classList.contains('modal-bg') && close());
  $('#pq').focus();
  search();
}

// ---------- file actions in the menus: show in folder, properties ----------
const fmtBytes = (n) => {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
};
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString() : '');

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.append(t); t.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* blocked */ }
    t.remove();
    return ok;
  }
}

/** Open the file manager on a file (same machine), otherwise copy its path. base: 'anime/episodes' | 'chapters' */
async function revealFile(base, id) {
  const r = await api(`/${base}/${id}/reveal`, { method: 'POST' });
  if (r.opened) { toast('Opened in your file manager'); return; }
  const ok = await copyText(r.path);
  toast(ok ? `Server path copied: ${r.path}` : r.path);
}

/** A small table of facts about one file. rows: [[label, value]] (empty values are skipped). */
function openProperties(title, rows, { base, id, path: filePath } = {}) {
  const ov = $('#overlay');
  const close = () => { ov.innerHTML = ''; };
  ov.innerHTML = `<div class="modal-bg"><div class="modal">
    <h2 style="margin-top:0">${esc(title)}</h2>
    <table class="props">${rows.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) =>
      `<tr><th>${esc(k)}</th><td>${Array.isArray(v) ? v.map(esc).join('<br>') : esc(v)}</td></tr>`).join('')}</table>
    <div class="form-row" style="justify-content:flex-end">
      ${filePath ? '<button class="btn" id="prCopy">Copy path</button>' : ''}
      ${base ? '<button class="btn" id="prShow">📂 Show in folder</button>' : ''}
      <button class="btn" id="prClose">Close</button></div></div></div>`;
  $('#prClose').addEventListener('click', close);
  $('#prCopy')?.addEventListener('click', async () => toast((await copyText(filePath)) ? 'Path copied' : 'Could not copy'));
  $('#prShow')?.addEventListener('click', () => revealFile(base, id).catch((e) => toast(e.message, true)));
  $('.modal-bg').addEventListener('mousedown', (e) => e.target.classList.contains('modal-bg') && close());
}

async function showEpisodeProperties(epId) {
  const p = await api(`/anime/episodes/${epId}/properties`);
  const v = p.video;
  openProperties(p.name, [
    ['Show', p.show],
    ['Episode', p.special ? 'Special' : [p.season > 1 || p.season ? `Season ${p.season ?? 1}` : '', p.number != null ? `Episode ${p.number}` : ''].filter(Boolean).join(' · ')],
    ['Type', [p.extension ? p.extension.toUpperCase() : '', p.container && p.container !== p.extension ? p.container : ''].filter(Boolean).join(' · ')],
    ['Size', fmtBytes(p.size)],
    ['Length', p.duration ? fmtTime(p.duration) : ''],
    ['Bitrate', p.bitrate ? `${(p.bitrate / 1e6).toFixed(2)} Mb/s` : ''],
    ['Video', v ? [v.codec?.toUpperCase(), v.profile, v.width ? `${v.width}×${v.height}` : '', v.pixFmt, v.bits ? `${v.bits}-bit` : ''].filter(Boolean).join(' · ') : ''],
    ['Audio', p.audio],
    ['Subtitles', p.subs],
    ['Chapters', p.chapters || ''],
    ['Plays directly', p.directPlay == null ? '' : p.directPlay ? 'Yes (no conversion)' : 'Needs converting for the browser'],
    ['Watched', p.watched ? 'Yes' : p.position > 5 ? `In progress (${fmtTime(p.position)})` : 'No'],
    ['Shown under another entry', p.moved ? 'Yes (moved by you)' : ''],
    ['Folder', p.folder],
    ['Modified', fmtDate(p.modified)],
    ['Added to MangaSoft', fmtDate(p.added)],
    ['Status', p.exists ? '' : 'File not found at this location'],
  ], { base: 'anime/episodes', id: epId, path: p.path });
}

// watched / unwatched calls shared by the menus
const watchedApi = {
  episode: (id, watched) => api(`/anime/episodes/${id}/watched`, { method: 'POST', body: { watched } }),
  bulk: (ids, watched) => api('/anime/episodes/watched-bulk', { method: 'POST', body: { ids, watched } }),
  show: (id, watched, scope) => api(`/anime/series/${id}/watched-all`, { method: 'POST', body: { watched, scope } }),
  hide: (seriesId) => api('/anime/continue/hide', { method: 'POST', body: { seriesId } }),
};

// ---------- poster size (seasons, movies, related) ----------
const posterW = () => { try { return Number(localStorage.getItem('ms.posterW')) || 84; } catch { return 84; } };
const posterSizerHtml = () => `<label class="sizer" title="Poster size"><span class="muted">▫</span><input type="range" class="pw" min="56" max="180" step="4" value="${posterW()}"><span class="muted">▣</span></label>`;
function bindPosterSize() {
  view.style.setProperty('--pw', posterW() + 'px');
  document.querySelectorAll('input.pw').forEach((el) => {
    if (el.dataset.bound) return;
    el.dataset.bound = '1';
    el.addEventListener('input', () => {
      const w = Number(el.value);
      view.style.setProperty('--pw', w + 'px');
      try { localStorage.setItem('ms.posterW', String(w)); } catch { /* private mode */ }
      document.querySelectorAll('input.pw').forEach((o2) => { if (o2 !== el) o2.value = String(w); });
    });
  });
}

// ---------- related series (manga <-> anime <-> doujin) ----------
const KIND_LABEL = { manga: 'Manga', anime: 'Anime', doujin: 'Doujin' };
const seriesHref = (r) => (r.kind === 'anime' ? `#/anime/${r.id}` : `#/series/${r.id}`);

/** Fill #related with the series connected to this one, plus a picker to connect or disconnect by hand. */
/** skip: AniList ids already shown as cards in the show's season strip, so they are not listed twice; true hides the
 *  "not in your library" list altogether (a season page of a show: the main page has those). */
async function renderRelated(seriesId, skip = [], skipSeries = []) {
  const hideMissing = skip === true;
  if (hideMissing) skip = [];
  const box = $('#related');
  if (!box) return;
  let list = [], missing = [];
  try { list = (await api(`/series/${seriesId}/related`)).filter((r) => !skipSeries.includes(r.id)); } catch { /* locked or offline: show only the button */ }
  if (!hideMissing) { try { missing = (await api(`/series/${seriesId}/related-missing`)).filter((r) => !skip.includes(r.anilistId)); } catch { /* none */ } }
  if (!$('#related')) return; // the page changed while we were asking
  box.innerHTML = `<div class="panel related" style="margin-top:0">
    <div class="viewbar"><b style="flex:1">Related</b>${posterSizerHtml()}<button class="btn small" id="linkBtn">＋ Link a series…</button></div>
    ${list.length ? `<div class="seasoncards">${list.map((r) => `
      <a class="scard" href="${seriesHref(r)}">
        <img class="sposter" loading="lazy" src="/api/series/${r.id}/cover" alt="">
        <div class="sbody">
          <div class="stitle"><span class="chip">${esc(KIND_LABEL[r.kind] || r.kind)}</span> ${esc(r.title)}</div>
          <div class="muted smeta">${esc(r.label)}${r.year ? ' · ' + r.year : ''}</div>
          <div class="sprog"><button class="linkbtn unlink" data-id="${r.id}" title="Remove this connection">✕ unlink</button></div>
        </div></a>`).join('')}</div>`
    : '<div class="muted" style="margin-top:6px">Nothing connected yet. Matching a manga or anime on AniList finds its adaptation and sequels by itself; you can also link any series by hand.</div>'}
    ${missing.length ? `<div class="muted" style="margin-top:14px">More on AniList, not in your library</div>
      <div class="seasoncards">${missing.map((r) => `
        <a class="scard ghost" ${r.type === 'ANIME' ? `href="#/ani/${r.anilistId}"` : `href="${esc(r.url)}" target="_blank" rel="noopener"`} title="${r.type === 'ANIME' ? 'Details' : 'Open on AniList'}">
          ${r.cover ? `<img class="sposter" loading="lazy" src="${esc(r.cover)}" alt="">` : '<div class="sposter"></div>'}
          <div class="sbody">
            <div class="stitle"><span class="chip">${esc((r.format || r.type).replace(/_/g, ' '))}</span> ${esc(r.title)}</div>
            <div class="muted smeta">${esc(r.label)} · not in your library</div>
          </div></a>`).join('')}</div>` : ''}
  </div>`;
  box.querySelectorAll('.unlink').forEach((b) => b.addEventListener('click', async (e) => {
    e.preventDefault(); e.stopPropagation();
    await api(`/series/${seriesId}/related/${b.dataset.id}`, { method: 'DELETE' });
    renderRelated(seriesId, hideMissing ? true : skip, skipSeries);
  }));
  $('#linkBtn').addEventListener('click', () => openLinkPicker(seriesId, () => renderRelated(seriesId, hideMissing ? true : skip, skipSeries)));
  bindPosterSize();
}

function openLinkPicker(seriesId, onDone) {
  const ov = $('#overlay');
  const close = () => { ov.innerHTML = ''; };
  ov.innerHTML = `<div class="modal-bg"><div class="modal">
    <h2 style="margin-top:0">Link a series</h2>
    <p class="muted" style="margin-top:0">Connect this to a manga, anime or doujin in your library. It shows up in both places.</p>
    <div class="form-row" style="margin-top:0"><input type="search" id="lq" placeholder="Search your library…" autofocus></div>
    <div id="lres" style="margin-top:8px"></div>
    <div class="form-row" style="justify-content:flex-end"><button class="btn" id="lclose">Close</button></div></div></div>`;
  const box = $('#lres');
  let timer;
  const search = async () => {
    const q = $('#lq').value.trim();
    if (q.length < 2) { box.innerHTML = '<div class="muted">Type at least two letters.</div>'; return; }
    try {
      const rs = await api(`/series-search?q=${encodeURIComponent(q)}&exclude=${seriesId}`);
      box.innerHTML = rs.map((r) => `<div class="result" data-id="${r.id}">
        <img src="/api/series/${r.id}/cover" alt=""><div><b>${esc(r.title)}</b>
        <div class="muted">${esc(KIND_LABEL[r.kind] || r.kind)}${r.year ? ' · ' + r.year : ''}</div></div></div>`).join('')
        || '<div class="muted">No matches.</div>';
    } catch (e) { box.innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
  };
  $('#lq').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });
  box.addEventListener('click', async (e) => {
    const r = e.target.closest('.result'); if (!r) return;
    try { await api(`/series/${seriesId}/related`, { method: 'POST', body: { otherId: Number(r.dataset.id) } }); close(); onDone(); }
    catch (err) { toast(err.message, true); }
  });
  $('#lclose').addEventListener('click', close);
  $('.modal-bg').addEventListener('mousedown', (e) => e.target.classList.contains('modal-bg') && close());
  $('#lq').focus();
  search();
}

// ---------- searchable multi-select (genres & tags, studios) ----------
function makeMultiSelect(host, { options, selected = [], any = 'Any', placeholder = 'Type to filter…', onChange }) {
  const sel = new Set(selected);
  const byValue = new Map(options.map((o2) => [o2.value, o2]));
  host.classList.add('msel');
  host.innerHTML = `<button type="button" class="msel-btn"><span class="msel-label"></span><span class="msel-x hidden" title="Clear">✕</span><span class="msel-caret">▾</span></button>
    <div class="msel-pop hidden"><input type="search" class="msel-q" placeholder="${esc(placeholder)}"><div class="msel-list"></div></div>`;
  const btn = host.querySelector('.msel-btn'), pop = host.querySelector('.msel-pop');
  const q = host.querySelector('.msel-q'), list = host.querySelector('.msel-list'), lab = host.querySelector('.msel-label'), x = host.querySelector('.msel-x');
  const nameOf = (v) => byValue.get(v)?.label ?? v.slice(v.indexOf(':') + 1);
  const syncLabel = () => {
    lab.textContent = sel.size === 0 ? any : sel.size === 1 ? nameOf([...sel][0]) : `${sel.size} selected`;
    lab.classList.toggle('muted', sel.size === 0);
    x.classList.toggle('hidden', sel.size === 0);
  };
  const row = (o2) => `<label class="msel-opt"><input type="checkbox" data-v="${esc(o2.value)}" ${sel.has(o2.value) ? 'checked' : ''}>
    <span>${esc(o2.label)}</span><span class="muted">${o2.count ?? ''}</span></label>`;
  const draw = () => {
    const term = q.value.trim().toLowerCase();
    const pick = options.filter((o2) => sel.has(o2.value));
    const rest = options.filter((o2) => !sel.has(o2.value) && (!term || o2.label.toLowerCase().includes(term)));
    const groups = new Map();
    for (const o2 of rest.slice(0, 250)) { const g = o2.group || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(o2); }
    list.innerHTML = (pick.length ? `<div class="msel-grp">Selected</div>${pick.map(row).join('')}` : '')
      + [...groups].map(([g, items]) => `${g ? `<div class="msel-grp">${esc(g)}</div>` : ''}${items.map(row).join('')}`).join('')
      || '<div class="muted" style="padding:8px 10px">Nothing matches.</div>';
  };
  const open = (on) => { pop.classList.toggle('hidden', !on); if (on) { q.value = ''; draw(); q.focus(); } };
  btn.addEventListener('click', (e) => { if (e.target === x) return; open(pop.classList.contains('hidden')); });
  x.addEventListener('click', (e) => { e.stopPropagation(); sel.clear(); syncLabel(); draw(); onChange([...sel]); });
  q.addEventListener('input', draw);
  list.addEventListener('change', (e) => {
    const v = e.target.dataset.v; if (v === undefined) return;
    if (e.target.checked) sel.add(v); else sel.delete(v);
    syncLabel(); onChange([...sel]);
    const keep = list.scrollTop; draw(); list.scrollTop = keep;
  });
  document.addEventListener('mousedown', (e) => {
    if (!host.isConnected) return;
    if (!host.contains(e.target)) pop.classList.add('hidden');
  });
  syncLabel();
  return { clear: () => { sel.clear(); syncLabel(); }, set: (vals) => { sel.clear(); vals.forEach((v) => sel.add(v)); syncLabel(); } };
}

// ---------- library ----------
async function renderAnimeLibrary() {
  const [st, lib, contInit] = await Promise.all([api('/anime/status'), api('/anime/library'), api('/anime/continue').catch(() => [])]);
  if (!st.libraries.length) {
    view.innerHTML = `<div class="empty"><div class="big">🎬</div><h2>Anime section</h2>
      <p>Point it at a folder of anime episodes. Details and covers come from AniList, and you can watch right here on your PC or phone.</p>
      <a class="btn primary" href="#/settings">Add an anime folder</a></div>`;
    return;
  }
  let cont = contInit;
  // AniList-style filters: search, genres & tags, studio, year, season, format, airing status
  const FKEY = 'ms.anime.f';
  let F = { q: '', tags: [], studios: [], year: '', season: '', format: '', status: '' };
  try { F = { ...F, ...JSON.parse(sessionStorage.getItem(FKEY) || '{}') }; } catch { /* fresh */ }
  try { // a genre / tag / season clicked on a series page replaces the filters
    const xf = sessionStorage.getItem('ms.anime.facet'), xs = sessionStorage.getItem('ms.anime.season');
    if (xf || xs) {
      F = { q: '', tags: [], studios: [], year: '', season: '', format: '', status: '' };
      if (xf) F.tags.push(xf);
      if (xs) { const [y, sn] = xs.split(' '); F.year = y; F.season = sn; }
    }
    sessionStorage.removeItem('ms.anime.facet'); sessionStorage.removeItem('ms.anime.season');
  } catch { /* private mode */ }
  const saveF = () => { try { sessionStorage.setItem(FKEY, JSON.stringify(F)); } catch { /* private mode */ } };
  const countBy = (fn) => {
    const m = new Map();
    for (const x of lib) for (const k of new Set(fn(x) || [])) m.set(k, (m.get(k) || 0) + 1);
    return m;
  };
  const alpha = (a, b) => a.label.localeCompare(b.label);
  const tagOptions = [
    ...[...countBy((x) => x.genres)].map(([n, c]) => ({ value: `genres:${n}`, label: n, group: 'Genres', count: c })).sort(alpha),
    ...[...countBy((x) => x.tags)].map(([n, c]) => ({ value: `tags:${n}`, label: n, group: 'Tags', count: c })).sort(alpha),
  ];
  const studioOptions = [...countBy((x) => x.studios)].map(([n, c]) => ({ value: n, label: n, count: c })).sort(alpha);
  const years = [...countBy((x) => (x.airs || []).map((k) => k.split(' ')[0]))].sort((a, b) => b[0] - a[0]);
  const FORMAT_NAMES = { TV: 'TV Show', TV_SHORT: 'TV Short', MOVIE: 'Movie', SPECIAL: 'Special', OVA: 'OVA', ONA: 'ONA', MUSIC: 'Music' };
  const STATUS_NAMES = { RELEASING: 'Airing', FINISHED: 'Finished', NOT_YET_RELEASED: 'Not yet released', CANCELLED: 'Cancelled', HIATUS: 'Hiatus' };
  const formats = [...countBy((x) => x.formats)].sort((a, b) => b[1] - a[1]);
  const statuses = [...countBy((x) => x.statuses)].sort((a, b) => b[1] - a[1]);
  const sel = (id, label, opts, cur) => `<div class="fgroup"><label for="${id}">${label}</label>
    <select id="${id}"><option value="">Any</option>${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
  view.innerHTML = `
    <div id="scanSlot"></div>
    ${st.ffmpeg.ready ? '' : '<div class="banner-msg">⚠️ ffmpeg was not found on this server. Files your browser cannot play directly will not play until it is installed.</div>'}
    <div id="cont"></div>
    <div class="filterbar">
      <div class="fgroup"><label for="q">Search</label><input type="search" id="q" placeholder="${lib.length} anime…" value="${esc(F.q)}"></div>
      <div class="fgroup"><label>Genres &amp; Tags</label><div id="fTags"></div></div>
      <div class="fgroup"><label>Studio</label><div id="fStudio"></div></div>
      ${sel('fYear', 'Year', years.map(([y, c]) => [y, `${y} (${c})`]), F.year)}
      ${sel('fSeason', 'Season', ['WINTER', 'SPRING', 'SUMMER', 'FALL'].map((s2) => [s2, cap(s2)]), F.season)}
      ${sel('fFormat', 'Format', formats.map(([v, c]) => [v, `${FORMAT_NAMES[v] || v} (${c})`]), F.format)}
      ${sel('fStatus', 'Airing status', statuses.map(([v, c]) => [v, `${STATUS_NAMES[v] || v} (${c})`]), F.status)}
    </div>
    <div class="toolbar">
      <div class="chips" id="chips"></div>
      <span class="muted" id="fcount"></span>
      <button class="btn small hidden" id="fClear">✕ Clear filters</button>
      <select id="sort"><option value="title">Title</option><option value="added">Recently added</option><option value="read">Recently watched</option><option value="air">Newest season</option></select>
    </div>
    <div id="grid"></div>`;
  for (const x of lib) {
    x._h = `${x.title} ${x.romaji || ''} ${x.native || ''} ${x.folderName} ${(x.memberTitles || []).join(' ')} ${(x.genres || []).join(' ')} ${(x.tags || []).join(' ')}`.toLowerCase();
  }

  const renderCont = () => {
    $('#cont').innerHTML = cont.length ? `<h2 style="margin-top:0">Continue watching</h2><div class="row-scroll">
      ${cont.map((c, i) => `<a class="card" href="#/watch/${c.episodeId}" data-i="${i}">
        <div class="cover"><img loading="lazy" src="/api/series/${c.seriesId}/cover" alt="">
          <button class="more" title="More options (or right-click)">⋯</button>
          <button class="qtog" data-i="${i}" title="Mark this episode watched">✓ Watched</button>
          ${c.fraction ? `<div class="bar"><i style="width:${Math.min(100, c.fraction * 100)}%"></i></div>` : ''}</div>
        <div class="name">${esc(c.title)}</div><div class="sub">${esc(c.episodeTitle)}</div></a>`).join('')}</div>` : '';
  };
  renderCont();
  const reloadCont = async () => { cont = await api('/anime/continue').catch(() => []); renderCont(); };
  const reloadAll = () => route();
  $('#cont').addEventListener('click', async (e) => {
    const b = e.target.closest('.qtog'); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const c = cont[Number(b.dataset.i)];
    if (!c) return;
    try { await watchedApi.episode(c.episodeId, true); toast(`${c.epTitle} marked watched`); await reloadCont(); }
    catch (err) { toast(err.message, true); }
  });
  bindCtx($('#cont'), '.card', (el) => {
    const c = cont[Number(el.dataset.i)];
    if (!c) return [];
    return [
      { label: `▶ Play ${c.epTitle}`, run: () => { location.hash = `#/watch/${c.episodeId}`; } },
      { label: `✓ Mark ${c.epTitle} watched`, run: async () => { await watchedApi.episode(c.episodeId, true); await reloadCont(); toast(`${c.epTitle} marked watched`); } },
      c.last ? { label: `↺ Mark ${c.last.title} unwatched`, run: async () => { await watchedApi.episode(c.last.id, false); await reloadCont(); toast(`${c.last.title} marked unwatched`); } } : null,
      { sep: true },
      { label: '✓ Mark the whole show watched', run: async () => { await watchedApi.show(c.showId, true); reloadAll(); } },
      { label: '↺ Mark the whole show unwatched', run: async () => { await watchedApi.show(c.showId, false); reloadAll(); } },
      { label: '↗ Open series page', run: () => { location.hash = `#/anime/${c.seriesId}`; } },
      { sep: true },
      { label: '✕ Remove from Continue watching', danger: true, run: async () => { await watchedApi.hide(c.seriesId); await reloadCont(); } },
    ];
  });
  const FK = 'ms.filter.anime';
  const chips = [['all', 'All'], ['reading', 'In progress'], ['unread', 'Unwatched'], ['done', 'Completed'], ['match', 'Needs match']];
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
      if (F.tags.length && !F.tags.every((t) => { const i = t.indexOf(':'); return (x[t.slice(0, i)] || []).includes(t.slice(i + 1)); })) return false;
      if (F.studios.length && !F.studios.some((n) => (x.studios || []).includes(n))) return false;
      if (F.year || F.season) {
        const airs = x.airs || [];
        const ok = airs.some((k) => { const [y, sn] = k.split(' '); return (!F.year || y === F.year) && (!F.season || sn === F.season); })
          || (!airs.length && !F.season && F.year && String(x.year) === F.year);
        if (!ok) return false;
      }
      if (F.format && !(x.formats || []).includes(F.format)) return false;
      if (F.status && !(x.statuses || []).includes(F.status)) return false;
      return true;
    };
    let items = lib.filter(match);
    const active = !!(qq || F.tags.length || F.studios.length || F.year || F.season || F.format || F.status);
    $('#fClear').classList.toggle('hidden', !active);
    $('#fcount').textContent = active ? `${items.length} of ${lib.length}` : '';
    if (f === 'reading') items = items.filter((x) => x.readCount > 0 && x.readCount < x.chapterCount);
    if (f === 'unread') items = items.filter((x) => x.readCount === 0);
    if (f === 'done') items = items.filter((x) => x.chapterCount > 0 && x.readCount >= x.chapterCount);
    if (f === 'match') items = items.filter((x) => !x.anilistId || x.matchState === 'none' || x.matchState === 'missing');
    if (s === 'added') items.sort((a, b) => b.addedAt - a.addedAt);
    if (s === 'read') items.sort((a, b) => (b.lastRead || 0) - (a.lastRead || 0));
    if (s === 'air') items.sort((a, b) => (b.airKey || 0) - (a.airKey || 0));
    const cardHtml = (x) => {
      const left = x.chapterCount - x.readCount;
      return `<a class="card" href="#/${x.seasons || x.extras ? 'show' : 'anime'}/${x.id}" data-id="${x.id}">
        <div class="cover"><img loading="lazy" src="/api/series/${x.id}/cover" alt="">
          <button class="more" title="More options (or right-click)">⋯</button>
          ${left > 0 && x.readCount > 0 ? `<span class="badge">${left}</span>` : ''}
          ${!x.anilistId ? '<span class="badge warn">no match</span>' : ''}
          ${x.chapterCount ? `<button class="qtog" data-sid="${x.id}" title="${x.readCount >= x.chapterCount ? 'Mark all unwatched' : 'Mark all watched'}">${x.readCount >= x.chapterCount ? '↺ Unwatched' : '✓ Watched'}</button>` : ''}
          <div class="bar"><i style="width:${x.chapterCount ? (x.readCount / x.chapterCount) * 100 : 0}%"></i></div></div>
        <div class="name">${esc(x.title)}</div>
        <div class="sub">${x.seasons ? `${x.seasons} seasons · ` : ''}${x.extras ? `+${x.extras} movie/OVA · ` : ''}${x.chapterCount} ep${x.chapterCount === 1 ? '' : 's'}${x.year && !x.seasons && !x.extras ? ' · ' + x.year : ''}</div></a>`;
    };
    const unmatched = (x) => !x.anilistId;
    const main = items.filter((x) => !unmatched(x)), rest = items.filter(unmatched);
    $('#grid').innerHTML = (main.length ? `<div class="grid">${main.map(cardHtml).join('')}</div>` : (rest.length ? '' : '<div class="empty">Nothing matches.</div>'))
      + (rest.length ? `<h2 class="unmatched-h">Not matched yet <span class="muted">(${rest.length})</span></h2>
        <p class="muted" style="margin-top:-4px">These have no AniList details yet. Open one and use <b>Fix metadata</b> to match it, or run <b>Rescan &amp; re-match</b> in Settings.</p>
        <div class="grid">${rest.map(cardHtml).join('')}</div>` : '');
  };
  $('#sort').value = sessionStorage.getItem('ms.sort') || 'title';
  const tagsSel = makeMultiSelect($('#fTags'), {
    options: tagOptions, selected: F.tags, any: 'Any', placeholder: 'Search genres and tags…',
    onChange: (v) => { F.tags = v; saveF(); draw(); },
  });
  const studioSel = makeMultiSelect($('#fStudio'), {
    options: studioOptions, selected: F.studios, any: 'Any', placeholder: 'Search studios…',
    onChange: (v) => { F.studios = v; saveF(); draw(); },
  });
  const bindSel = (id, key) => $(id).addEventListener('change', (e) => { F[key] = e.target.value; saveF(); draw(); });
  bindSel('#fYear', 'year'); bindSel('#fSeason', 'season'); bindSel('#fFormat', 'format'); bindSel('#fStatus', 'status');
  $('#fClear').addEventListener('click', () => {
    F = { q: '', tags: [], studios: [], year: '', season: '', format: '', status: '' };
    saveF();
    $('#q').value = '';
    for (const id of ['#fYear', '#fSeason', '#fFormat', '#fStatus']) $(id).value = '';
    tagsSel.clear(); studioSel.clear();
    draw();
  });
  drawChips(); draw();
  bindCtx($('#grid'), '.card', (el) => {
    const x = lib.find((v) => v.id === Number(el.dataset.id));
    if (!x) return [];
    const setAll = (watched) => async () => {
      await watchedApi.show(x.id, watched);
      x.readCount = watched ? x.chapterCount : 0;
      toast(`${x.title}: marked ${watched ? 'watched' : 'unwatched'}`);
      draw(); reloadCont();
    };
    const all = x.chapterCount > 0 && x.readCount >= x.chapterCount;
    return [
      { label: '↗ Open', run: () => { location.hash = `#/${x.seasons || x.extras ? 'show' : 'anime'}/${x.id}`; } },
      x.chapterCount && !all ? { label: '✓ Mark all watched', run: setAll(true) } : null,
      x.readCount > 0 ? { label: '↺ Mark all unwatched', run: setAll(false) } : null,
      x.readCount > 0 ? { label: '✕ Remove from Continue watching', run: async () => { await watchedApi.hide(x.id); reloadCont(); } } : null,
      x.siteUrl ? { sep: true } : null,
      x.siteUrl ? { label: 'AniList page ↗', run: () => window.open(x.siteUrl, '_blank', 'noopener') } : null,
    ];
  });
  $('#q').addEventListener('input', (e) => { F.q = e.target.value; saveF(); draw(); });
  $('#sort').addEventListener('change', (e) => { sessionStorage.setItem('ms.sort', e.target.value); draw(); });
  $('#chips').addEventListener('click', (e) => {
    const k = e.target.dataset.k; if (!k) return;
    sessionStorage.setItem(FK, k); drawChips(); draw();
  });
  $('#grid').addEventListener('click', async (e) => {
    const b = e.target.closest('.qtog'); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const item = lib.find((x) => x.id === Number(b.dataset.sid));
    const makeDone = item.readCount < item.chapterCount;
    try {
      await watchedApi.show(item.id, makeDone);
      item.readCount = makeDone ? item.chapterCount : 0;
      toast(`${item.title}: marked ${makeDone ? 'watched' : 'unwatched'}`);
      draw(); reloadCont();
    } catch (err) { toast(err.message, true); }
  });
  scanBanner(view, () => route());
}

// ---------- seasons strip (show page and season pages) ----------
const seasonWhen = (x) => (x.airSeason && x.airYear ? seasonLabel(x.airYear + ' ' + x.airSeason) : (x.airYear || x.year || ''));

function scardHtml(x) {
  const pct = x.episodes ? Math.round((x.watched / x.episodes) * 100) : 0;
  return `<a class="scard ${x.current ? 'on' : ''}" href="#/anime/${x.id}" data-sid="${x.id}">
    <img class="sposter" loading="lazy" src="/api/series/${x.id}/cover" alt="">
    <div class="sbody">
      <div class="stitle"><span class="chip ${x.current ? 'on' : ''}">${esc(x.label)}</span> ${esc(x.title)}</div>
      <div class="muted smeta">${esc([seasonWhen(x), x.format ? x.format.replace(/_/g, ' ') : '', `${x.episodes}${x.total && x.total !== x.episodes ? ' / ' + x.total : ''} ep`].filter(Boolean).join(' · '))}</div>
      ${x.description ? `<div class="sdesc">${esc(x.description)}</div>` : ''}
      <div class="sprog"><div class="sbar"><i style="width:${pct}%"></i></div><span class="muted">${x.watched}/${x.episodes} watched</span></div>
    </div>
    <button class="more" title="More options (or right-click)">⋯</button></a>`;
}

function ghostHtml(x, showId) {
  return `<a class="scard ghost" href="#/ani/${x.anilistId}${showId ? '/' + showId : ''}" title="Details (not in your library)">
    ${x.cover ? `<img class="sposter" loading="lazy" src="${esc(x.cover)}" alt="">` : '<div class="sposter"></div>'}
    <div class="sbody">
      <div class="stitle"><span class="chip">${esc(x.rank ? x.label : (x.format ? x.format.replace(/_/g, ' ') : x.label))}</span> ${esc(x.title)}</div>
      <div class="muted smeta">${esc([seasonWhen(x), x.format ? x.format.replace(/_/g, ' ') : '', x.episodes ? `${x.episodes} ep` : '', 'not in your library'].filter(Boolean).join(' · '))}</div>
      ${x.description ? `<div class="sdesc">${esc(x.description)}</div>` : ''}
    </div></a>`;
}

/** Seasons in AniList order (yours and the ones you are missing), then movies / OVAs / specials. */
function seasonStripHtml(owned, ghosts, showTitle, showId) {
  const main = [
    ...owned.filter((x) => !x.extra).map((x, i) => ({ r: x.rank ?? 1000 + i, html: scardHtml(x) })),
    ...ghosts.filter((x) => !x.extra).map((x, i) => ({ r: x.rank ?? 2000 + i, html: ghostHtml(x, showId) })),
  ].sort((a, b) => a.r - b.r);
  const extra = [...owned.filter((x) => x.extra).map(scardHtml), ...ghosts.filter((x) => x.extra).map((x) => ghostHtml(x, showId))];
  return (main.length ? `<div class="viewbar"><h2 style="margin:0;flex:1">Seasons <span class="muted">· ${esc(showTitle)}</span></h2>${posterSizerHtml()}</div>
      <div class="seasoncards">${main.map((m) => m.html).join('')}</div>` : '')
    + (extra.length ? `<div class="viewbar"><h2 style="margin:0;flex:1">Movies, OVAs &amp; specials</h2>${main.length ? '' : posterSizerHtml()}</div>
      <div class="seasoncards">${extra.join('')}</div>` : '');
}

function bindSeasonCtx(root, owned, redo) {
  bindCtx(root, '.scard', (el) => {
    const x = owned.find((v) => v.id === Number(el.dataset.sid));
    if (!x) return [];
    const done = x.episodes > 0 && x.watched >= x.episodes;
    const parent = (p) => async () => { await api(`/anime/series/${x.id}/parent`, { method: 'POST', body: { parentId: p } }); redo(); };
    return [
      { label: '↗ Open this season', run: () => { location.hash = `#/anime/${x.id}`; } },
      { label: done ? '↺ Mark season unwatched' : '✓ Mark season watched', run: async () => { await watchedApi.show(x.id, !done, 'season'); redo(); } },
      { sep: true },
      { label: `✎ Rename "${x.label}"…`, run: async () => {
        const v = prompt('Name in the season list (blank = automatic):', x.customLabel ? x.label : '');
        if (v === null) return;
        await api(`/anime/series/${x.id}/label`, { method: 'PUT', body: { label: v } });
        redo();
      } },
      x.root ? null : { label: 'Show on its own (not a season of this show)', run: parent(0) },
      x.manual ? { label: 'Back to automatic grouping', run: parent(null) } : null,
    ];
  });
}

// ---------- show landing page (all the seasons of one show) ----------
async function renderAnimeShow(id) {
  const sh = await api(`/anime/show/${id}`);
  if (sh.single) { location.replace(`#/anime/${sh.seriesId}`); return; }
  if (String(sh.id) !== String(id)) { location.replace(`#/show/${sh.id}`); return; }
  const have = sh.seasons.filter((x) => !x.extra).length;
  const total = have + sh.missing.filter((x) => !x.extra).length;
  const allDone = sh.episodes > 0 && sh.watched >= sh.episodes;
  view.innerHTML = `
    <a class="muted" href="#/anime">← Anime</a>
    <div class="hero" style="margin-top:8px">
      ${sh.banner ? `<div class="bg" style="background-image:url('${esc(sh.banner)}')"></div>` : ''}
      <div class="inner">
        <div class="poster"><img src="${esc(sh.poster || `/api/series/${sh.id}/cover`)}" alt=""></div>
        <div class="info">
          <h1>${esc(sh.title)}</h1>
          <div class="meta">
            <span>${have} season${have === 1 ? '' : 's'} in your library${total > have ? ` of ${total}` : ''}</span>
            ${sh.firstYear ? `<span>${sh.firstYear}${sh.lastYear && sh.lastYear !== sh.firstYear ? '–' + sh.lastYear : ''}</span>` : ''}
            <span>${sh.watched} / ${sh.episodes} episodes watched</span>
          </div>
          ${sh.genres.length ? `<div class="tags">${sh.genres.map((g) => `<span class="tag">${esc(g)}</span>`).join('')}</div>` : ''}
          ${sh.description ? `<div class="desc">${esc(sh.description)}</div>` : ''}
          <div class="actions">
            ${sh.next ? `<a class="btn primary" href="#/watch/${sh.next.episodeId}">${sh.next.started ? '▶ Continue' : '▶ Start watching'} · ${esc(sh.next.title)}</a>` : ''}
            <button class="btn" id="shName">✎ Name this show…</button>
            <button class="btn" id="shAdd">＋ Add seasons…</button>
            <button class="btn" id="shAll">${allDone ? 'Mark all unwatched' : 'Mark all watched'}</button>
            ${sh.siteUrl ? `<a class="btn" href="${esc(sh.siteUrl)}" target="_blank" rel="noopener">AniList ↗</a>` : ''}
          </div>
        </div>
      </div>
    </div>
    <div id="seasons"></div>
    <div id="related"></div>`;
  $('#seasons').innerHTML = seasonStripHtml(sh.seasons, sh.missing, sh.title, sh.id);
  bindPosterSize();
  bindSeasonCtx($('#seasons'), sh.seasons, () => renderAnimeShow(id));
  // what the cards above already show (the show's own seasons and movies) is not listed again
  renderRelated(sh.id, sh.missing.map((g) => g.anilistId), sh.seasons.map((x) => x.id));
  $('#shName').addEventListener('click', async () => {
    const v = prompt('Name of the whole show (blank = automatic):', sh.named ? sh.title : '');
    if (v === null) return;
    await api(`/anime/series/${sh.id}/show-title`, { method: 'PUT', body: { title: v } });
    renderAnimeShow(id);
  });
  $('#shAdd').addEventListener('click', () => pickAnime({
    title: 'Add seasons', note: `Search, tick every series that belongs to ${sh.title} (a season, movie or OVA) and add them together.`,
    exclude: sh.seasons.map((x) => x.id), multi: true,
    onPick: async (pids) => {
      for (const pid of pids) await api(`/anime/series/${pid}/parent`, { method: 'POST', body: { parentId: sh.id } });
      toast(`${pids.length} added`); renderAnimeShow(id);
    },
  }));
  $('#shAll').addEventListener('click', async () => {
    await watchedApi.show(sh.id, !allDone);
    renderAnimeShow(id);
  });
}

// ---------- an AniList entry you do not have (a season, movie or OVA of a show) ----------
async function renderAnimeAni(id) {
  const showId = location.hash.split('/')[3];
  const a = await api(`/anime/anilist/${id}`);
  if (a.ownedId) { location.replace(`#/anime/${a.ownedId}`); return; }
  const when = a.season && a.year ? seasonLabel(a.year + ' ' + a.season) : (a.year || '');
  view.innerHTML = `
    <a class="muted" href="#/anime">← Anime</a>
    ${showId ? `<a class="btn small backbtn" href="#/show/${esc(showId)}">⤺ Back to the main page</a>` : '<button class="btn small backbtn" id="aniBack">⤺ Back</button>'}
    <div class="hero" style="margin-top:8px">
      ${a.banner ? `<div class="bg" style="background-image:url('${esc(a.banner)}')"></div>` : ''}
      <div class="inner">
        <div class="poster">${a.cover ? `<img src="${esc(a.cover)}" alt="">` : ''}</div>
        <div class="info">
          <h1>${esc(a.title)}</h1>
          <div class="alt">${esc([a.native, a.romaji !== a.title ? a.romaji : ''].filter(Boolean).join(' · '))}</div>
          <div class="meta">
            <span>Not in your library</span>
            ${a.format ? `<span>${esc(a.format.replace(/_/g, ' '))}</span>` : ''}
            ${when ? `<span>${esc(String(when))}</span>` : ''}
            ${a.episodes ? `<span>${a.episodes} episode${a.episodes === 1 ? '' : 's'}</span>` : ''}
            ${a.status ? `<span>${esc(a.status.replace(/_/g, ' ').toLowerCase())}</span>` : ''}
            ${a.score ? `<span>★ ${a.score}%</span>` : ''}
            ${a.studios.length ? `<span>${esc(a.studios.slice(0, 3).join(', '))}</span>` : ''}
          </div>
          ${a.genres.length ? `<div class="tags">${a.genres.map((g) => `<span class="tag">${esc(g)}</span>`).join('')}</div>` : ''}
          ${a.description ? `<div class="desc">${esc(a.description)}</div>` : ''}
          <div class="actions">
            ${a.siteUrl ? `<a class="btn" href="${esc(a.siteUrl)}" target="_blank" rel="noopener">AniList ↗</a>` : ''}
          </div>
          <p class="muted" style="margin-top:12px">You don't have files for this one yet. Right-click episodes of the show and choose
            <b>⇄ Move to…</b> to put files here, or add the folder to your anime library.</p>
        </div>
      </div>
    </div>`;
  $('#aniBack')?.addEventListener('click', () => (history.length > 1 ? history.back() : (location.hash = '#/anime')));
}

// ---------- series ----------
async function renderAnimeSeries(id) {
  const [s, cfg] = await Promise.all([api(`/anime/series/${id}`), api('/anilist/status').catch(() => ({}))]);
  if (s.mergedInto) { location.replace(`#/anime/${s.mergedInto}`); return; } // this folder is shown under its main entry
  const eps = s.episodes;
  const doneCount = eps.filter((e) => e.completed).length;
  const next = eps.find((e) => !e.completed) || eps[0];
  const resume = eps.find((e) => !e.completed && e.position > 5) || next;
  const started = eps.some((e) => e.completed || e.position > 5);
  let reversed = sessionStorage.getItem('ms.rev.anime') === '1';
  // files moved into an entry that only exists on AniList are its episodes; elsewhere moved files sit with the extras
  const regular = eps.filter((e) => !e.special && (!e.moved || s.virtual)), specials = eps.filter((e) => e.special || (e.moved && !s.virtual));

  view.innerHTML = `
    <a class="muted" href="#/anime">← Anime</a>${s.seasons ? ` <a class="btn small backbtn" href="#/show/${s.show.id}">⤺ ${esc(s.show.title)} · main page</a>` : ''}
    <div class="hero" style="margin-top:8px">
      ${s.banner ? `<div class="bg" style="background-image:url('${esc(s.banner)}')"></div>` : ''}
      <div class="inner">
        <div class="poster"><img src="/api/series/${s.id}/cover" alt=""></div>
        <div class="info">
          <h1>${esc(s.title)}</h1>
          <div class="alt">${esc([s.native, s.romaji !== s.title ? s.romaji : ''].filter(Boolean).join(' · '))}</div>
          <div class="meta">
            ${s.status ? `<span>${esc(s.status.replace(/_/g, ' ').toLowerCase())}</span>` : ''}
            ${s.format ? `<span>${esc(s.format.replace(/_/g, ' '))}</span>` : ''}
            ${s.airSeason && s.airYear ? `<a class="metalink" href="#/anime" data-season="${s.airYear} ${s.airSeason}" title="Everything in your library from this season">${seasonLabel(s.airYear + ' ' + s.airSeason)}</a>`
              : s.year ? `<span>${s.year}</span>` : ''}
            ${s.score ? `<span>★ ${s.score}%</span>` : ''}
            ${s.chaptersTotal ? `<span>${s.chaptersTotal} episodes</span>` : ''}
            ${s.authors.length ? `<span>${esc(s.authors.slice(0, 3).join(', '))}</span>` : ''}
          </div>
          ${s.genres.length || s.tags?.length ? `<div class="tags">${s.genres.map((g) => `<a class="tag genre" href="#/anime" data-facet="genres:${esc(g)}">${esc(g)}</a>`).join('')}
            ${(s.tags || []).map((g, i) => `<a class="tag soft ${i >= 10 ? 'xtag hidden' : ''}" href="#/anime" data-facet="tags:${esc(g)}">${esc(g)}</a>`).join('')}
            ${(s.tags || []).length > 10 ? `<button class="tag soft" id="moreTags">+${s.tags.length - 10} tags</button>` : ''}</div>` : ''}
          ${s.edited?.length ? '<div class="muted" style="margin-bottom:8px">✎ Includes your manual edits</div>' : ''}
          ${s.sources?.length ? `<div class="muted" style="margin-bottom:8px" title="${esc(s.sources.map((x) => x.path).join('\n'))}">
            Combines ${s.sources.length + 1} folders of this show (same AniList entry), duplicates hidden.
            <button class="linkbtn" id="split" style="margin-left:6px">Split apart</button></div>` : ''}
          ${s.description ? `<div class="desc">${esc(s.description)}</div>` : ''}
          <div class="actions">
            ${next ? `<a class="btn primary" href="#/watch/${resume.id}">${started ? '▶ Continue' : '▶ Start watching'}</a>` : ''}
            <button class="btn" id="match">🛠 Fix metadata${s.anilistId ? '' : ' · Match on AniList'}</button>
            <button class="btn" id="seasonMenu" title="Group this with other seasons, rename, split">🗂 Seasons ▾</button>
            ${s.anilistId ? '<button class="btn" id="refresh">↻ Refresh info</button>' : ''}
            ${s.siteUrl ? `<a class="btn" href="${esc(s.siteUrl)}" target="_blank" rel="noopener">AniList ↗</a>` : ''}
            <button class="btn" id="rescan" title="Re-read this series' folder after renaming or adding files">↻ Rescan files</button>
            <button class="btn" id="markAll">${doneCount === eps.length ? 'Mark all unwatched' : 'Mark all watched'}</button>
          </div>
          <div id="al"></div>
        </div>
      </div>
    </div>
    <div id="seasons"></div>
    <div id="collection"></div>
    <div id="related"></div>
    <div class="viewbar">
      <h2 id="listTitle" style="margin:0;flex:1">Episodes <span class="muted">(${doneCount}/${eps.length} watched)</span></h2>
      <button class="btn small" id="selMode" title="Pick several files to move or mark">☑ Select</button>
      <button class="btn small" id="rev">${reversed ? '↑ First episode first' : '↓ Newest first'}</button>
    </div>
    <div class="eplist" id="eps" style="margin-top:10px"></div>
    <div class="selbar hidden" id="selbar"></div>`;

  // inside a season of a show the other seasons, movies and unowned items stay on the show's main page
  renderRelated(id, s.seasons ? true : (s.missing || []).map((g) => g.anilistId));

  let selMode = false;
  const selected = new Set();
  let lastPick = null;
  const row = (e) => `
    <a class="ep ${e.completed ? 'done' : ''}${selected.has(e.id) ? ' picked' : ''}" href="#/watch/${e.id}" data-id="${e.id}">
      ${selMode ? `<input type="checkbox" class="sel" tabindex="-1" ${selected.has(e.id) ? 'checked' : ''}>` : ''}
      <div class="ep-th"><img loading="lazy" src="/api/anime/episodes/${e.id}/thumb" alt="" onerror="this.style.visibility='hidden'">
        ${e.duration ? `<span class="dur">${fmtTime(e.duration)}</span>` : ''}
        ${!e.completed && e.position > 5 && e.duration ? `<div class="bar"><i style="width:${Math.min(100, (e.position / e.duration) * 100)}%"></i></div>` : ''}
        ${e.completed ? '<span class="tick">✓</span>' : ''}</div>
      <div class="et"><div class="en">${esc(e.title)}${e.name ? ` <span class="enm">· ${esc(e.name)}</span>` : ''}</div>
        <div class="muted">${e.completed ? 'Watched' : e.position > 5 ? `Resume at ${fmtTime(e.position)}` : ''}</div></div>
      <button class="btn small tog" data-id="${e.id}" data-w="${e.completed ? 0 : 1}" title="${e.completed ? 'Mark unwatched' : 'Mark watched'}">${e.completed ? '↺ Unwatched' : '✓ Watched'}</button>
      <button class="more" title="More options (or right-click)">⋯</button>
    </a>`;
  // sections: seasons, plus the breaks you added by hand (S3 Part 1 / Part 2)
  let markers = [...(s.sections || [])];
  const sectionsOf = (list) => {
    const multi = new Set(list.map((e) => e.season ?? 1)).size > 1;
    const out = [];
    for (const e of list) {
      const sn = e.season ?? 1;
      let mi = -1;
      markers.forEach((m, i) => { if (m.season === sn && e.number != null && m.number <= e.number && (mi < 0 || m.number >= markers[mi].number)) mi = i; });
      const key = `${sn}:${mi}`;
      let cur = out[out.length - 1];
      if (!cur || cur.key !== key) {
        const has = markers.some((m) => m.season === sn);
        cur = { key, season: sn, label: mi >= 0 ? markers[mi].label : (multi ? `Season ${sn}` : (has ? 'Part 1' : '')), eps: [] };
        out.push(cur);
      }
      cur.eps.push(e);
    }
    return out;
  };
  const saveMarkers = async (next) => {
    next.sort((a, b) => a.season - b.season || a.number - b.number);
    const r = await api(`/anime/series/${id}/sections`, { method: 'PUT', body: { sections: next } });
    markers = r.sections || next;
    drawList();
  };
  const drawList = () => {
    const ordered = (l) => (reversed ? [...l].reverse() : l);
    const secs = sectionsOf(regular);
    const heads = secs.length > 1 || !!secs[0]?.label;
    const body = ordered(secs).map((sec) => (heads
      ? `<div class="gaprow sect" data-sec="${esc(sec.key)}">${esc(sec.label || 'Episodes')} <span class="muted">· ${sec.eps.filter((e) => e.completed).length}/${sec.eps.length} watched</span>
          <button class="more" title="Section options (or right-click)">⋯</button></div>` : '') + ordered(sec.eps).map(row).join('')).join('');
    $('#eps').innerHTML = (body || (specials.length ? '' : '<div class="empty">No video files found in this folder.</div>'))
      + (specials.length ? `<div class="gaprow">Specials &amp; extras</div>${ordered(specials).map(row).join('')}` : '');
  };
  drawList();

  $('#eps').addEventListener('click', async (e) => {
    const b = e.target.closest('.tog'); if (!b) return;
    e.preventDefault();
    await watchedApi.episode(b.dataset.id, b.dataset.w === '1');
    renderAnimeSeries(id);
  });
  const moveEpisodes = (list) => {
    const ov = $('#overlay');
    const close = () => { ov.innerHTML = ''; };
    const ids = list.map((x) => x.id);
    const label = list.length === 1 ? list[0].title : `${list.length} files`;
    const send = async (body, msg) => {
      try {
        await api('/anime/episodes/move', { method: 'POST', body: { ids, showId: s.show.id, ...body } });
        toast(msg || 'Moved');
        close(); selected.clear(); selMode = false;
        renderAnimeSeries(id);
      } catch (err) { toast(err.message, true); }
    };
    const owned = (s.seasons || []).filter((t) => !t.current);
    const ghosts = s.missing || [];
    const cardRow = (attrs, img, title, sub) => `<div class="result" ${attrs}><img src="${esc(img)}" alt=""><div><b>${esc(title)}</b><div class="muted">${esc(sub)}</div></div></div>`;
    ov.innerHTML = `<div class="modal-bg"><div class="modal">
      <h2 style="margin-top:0">Move ${esc(label)}</h2>
      <p class="muted" style="margin-top:0">Choose where it shows up. The files stay where they are. Entries that are not in your library yet are created from AniList.</p>
      ${owned.length ? `<div class="muted">In this show</div><div id="mvown">${owned.map((t) => cardRow(`data-sid="${t.id}"`, `/api/series/${t.id}/cover`, `${t.label} · ${t.title}`, `${t.episodes} file${t.episodes === 1 ? '' : 's'}`)).join('')}</div>` : ''}
      ${ghosts.length ? `<div class="muted" style="margin-top:10px">Known on AniList, not in your library yet</div><div id="mvgh">${ghosts.map((g) => cardRow(`data-aid="${g.anilistId}"`, g.cover || '', `${g.rank ? g.label : (g.format || g.label)} · ${g.title}`, [seasonWhen(g), g.format ? g.format.replace(/_/g, ' ') : '', g.episodes ? `${g.episodes} ep` : ''].filter(Boolean).join(' · '))).join('')}</div>` : ''}
      <div class="muted" style="margin-top:10px">Search AniList</div>
      <div class="form-row" style="margin-top:4px"><input type="search" id="mvq" placeholder="An OVA, a movie, another season, a spin-off…"></div>
      <div id="mvres"></div>
      <div class="form-row">
        <button class="btn" id="mvother">Another series in my library…</button>
        <button class="btn" id="mvback" ${list.some((x) => x.moved) ? '' : 'disabled'}>↩ Put back where found</button>
        <span style="flex:1"></span><button class="btn" id="mvclose">Close</button></div></div></div>`;
    ov.querySelector('.modal').addEventListener('click', (e) => {
      const r = e.target.closest('.result'); if (!r) return;
      if (r.dataset.sid) send({ seriesId: Number(r.dataset.sid) });
      else if (r.dataset.aid) send({ anilistId: Number(r.dataset.aid) }, 'Moved (added to your library)');
    });
    let timer;
    $('#mvq').addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = $('#mvq').value.trim();
        const box = $('#mvres');
        if (q.length < 2) { box.innerHTML = ''; return; }
        box.innerHTML = '<div class="muted">Searching…</div>';
        try {
          const rs = await api(`/anime/search?q=${encodeURIComponent(q)}`);
          box.innerHTML = rs.map((r) => cardRow(`data-aid="${r.id}"`, r.cover || '', r.title, [r.year, r.format ? r.format.replace(/_/g, ' ') : '', r.chapters ? `${r.chapters} ep` : ''].filter(Boolean).join(' · '))).join('')
            || '<div class="muted">No matches.</div>';
        } catch (err) { box.innerHTML = `<div class="muted">${esc(err.message)}</div>`; }
      }, 350);
    });
    $('#mvother').addEventListener('click', () => pickAnime({
      title: `Move ${label} to…`, note: 'Pick the series these files belong to.', exclude: [id],
      onPick: (pid) => send({ seriesId: pid }),
    }));
    $('#mvback').addEventListener('click', () => send({ seriesId: null }, 'Put back'));
    $('#mvclose').addEventListener('click', close);
    $('.modal-bg').addEventListener('mousedown', (e) => e.target.classList.contains('modal-bg') && close());
  };

  // pick several files (☑ Select): move them, or mark them
  const drawSel = () => {
    const bar = $('#selbar');
    bar.classList.toggle('hidden', !selMode);
    $('#selMode').classList.toggle('primary', selMode);
    if (!selMode) { bar.innerHTML = ''; return; }
    const n = selected.size;
    bar.innerHTML = `<b>${n} selected</b>
      <button class="btn small" id="selAll">${n === eps.length ? 'None' : 'All'}</button>
      <button class="btn primary small" id="selMove" ${n ? '' : 'disabled'}>⇄ Move to…</button>
      <button class="btn small" id="selW" ${n ? '' : 'disabled'}>✓ Watched</button>
      <button class="btn small" id="selU" ${n ? '' : 'disabled'}>↺ Unwatched</button>
      <button class="btn small" id="selDone">Done</button>`;
    $('#selAll').addEventListener('click', () => {
      if (selected.size === eps.length) selected.clear(); else eps.forEach((x) => selected.add(x.id));
      drawList(); drawSel();
    });
    $('#selMove').addEventListener('click', () => moveEpisodes(eps.filter((x) => selected.has(x.id))));
    const mark = (w) => async () => { await watchedApi.bulk([...selected], w); selected.clear(); selMode = false; renderAnimeSeries(id); };
    $('#selW').addEventListener('click', mark(true));
    $('#selU').addEventListener('click', mark(false));
    $('#selDone').addEventListener('click', () => { selMode = false; selected.clear(); drawList(); drawSel(); });
  };
  $('#selMode').addEventListener('click', () => { selMode = !selMode; if (!selMode) selected.clear(); drawList(); drawSel(); });
  $('#eps').addEventListener('click', (e) => {
    if (!selMode) return;
    const r = e.target.closest('.ep');
    if (!r || e.target.closest('.more, .tog')) return;
    e.preventDefault(); e.stopPropagation();
    const pid = Number(r.dataset.id);
    const order = [...$('#eps').querySelectorAll('.ep')].map((a) => Number(a.dataset.id));
    if (e.shiftKey && lastPick != null && order.includes(lastPick)) {
      const [a, b] = [order.indexOf(lastPick), order.indexOf(pid)].sort((x, y) => x - y);
      for (const x of order.slice(a, b + 1)) selected.add(x);
    } else if (selected.has(pid)) selected.delete(pid); else selected.add(pid);
    lastPick = pid;
    drawList(); drawSel();
  }, true);
  bindCtx($('#eps'), '.ep, .sect', (el) => {
    const redo = () => renderAnimeSeries(id);
    if (el.classList.contains('sect')) {
      const sec = sectionsOf(regular).find((x) => x.key === el.dataset.sec);
      if (!sec) return [];
      const ids = sec.eps.map((x) => x.id);
      const all = sec.eps.every((x) => x.completed);
      const mi = Number(sec.key.split(':')[1]);
      const m = mi >= 0 ? markers[mi] : null;
      return [
        { label: all ? '↺ Mark this section unwatched' : '✓ Mark this section watched', run: async () => { await watchedApi.bulk(ids, !all); redo(); } },
        m ? { sep: true } : null,
        m ? { label: `✎ Rename "${m.label}"…`, run: async () => {
          const v = prompt('Name of this section:', m.label); if (v === null || !v.trim()) return;
          await saveMarkers(markers.map((x) => (x === m ? { ...x, label: v.trim() } : x)));
        } } : null,
        m ? { label: '✂ Remove this break (merge with the section above)', danger: true, run: () => saveMarkers(markers.filter((x) => x !== m)) } : null,
      ];
    }
    const ep = eps.find((x) => x.id === Number(el.dataset.id));
    if (!ep) return [];
    const at = regular.indexOf(ep);
    const mark = markers.find((m) => m.season === (ep.season ?? 1) && m.number === ep.number);
    return [
      { label: '▶ Play', run: () => { location.hash = `#/watch/${ep.id}`; } },
      { label: ep.completed ? '↺ Mark unwatched' : '✓ Mark watched', run: async () => { await watchedApi.episode(ep.id, !ep.completed); redo(); } },
      at > 0 ? { label: '✓ Mark everything up to here watched', run: async () => { await watchedApi.bulk(regular.slice(0, at + 1).map((x) => x.id), true); redo(); } } : null,
      at >= 0 && at < regular.length - 1 ? { label: '↺ Mark everything from here unwatched', run: async () => { await watchedApi.bulk(regular.slice(at).map((x) => x.id), false); redo(); } } : null,
      { sep: true },
      { label: selMode && selected.has(ep.id) && selected.size > 1 ? `⇄ Move ${selected.size} selected files…` : '⇄ Move to another season / movie / OVA…',
        run: () => moveEpisodes(selMode && selected.has(ep.id) ? eps.filter((x) => selected.has(x.id)) : [ep]) },
      ep.moved ? { label: '↩ Put back where it was found', run: async () => {
        await api(`/anime/episodes/${ep.id}/move`, { method: 'POST', body: { seriesId: null } }); redo();
      } } : null,
      { sep: true },
      { label: '📂 Show in folder', run: () => revealFile('anime/episodes', ep.id) },
      { label: 'ⓘ Properties', run: () => showEpisodeProperties(ep.id) },
      ep.special || ep.moved || ep.number == null ? null : { sep: true },
      ep.special || ep.moved || ep.number == null ? null
        : mark ? { label: `✂ Remove section break "${mark.label}"`, run: () => saveMarkers(markers.filter((m) => m !== mark)) }
          : at > 0 ? { label: '✂ Start a new section here…', run: async () => {
            const n = markers.filter((m) => m.season === (ep.season ?? 1)).length + 2;
            const v = prompt('Name of the new section (it starts at this episode):', `Part ${n}`);
            if (v === null) return;
            await saveMarkers([...markers, { season: ep.season ?? 1, number: ep.number, label: v.trim() || `Part ${n}` }]);
          } } : null,
    ];
  });

  // seasons of this show, each with its own poster and description
  if (!s.seasons && s.missing?.length) {
    $('#seasons').innerHTML = seasonStripHtml([], s.missing || [], s.show.title, s.show.id);
    bindPosterSize();
    bindSeasonCtx($('#seasons'), s.seasons || [], () => renderAnimeSeries(id));
  }
  $('#seasonMenu').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const showId = s.show.id;
    const memberIds = (s.seasons || []).map((x) => x.id);
    openCtx(r.left, r.bottom + 4, [
      { label: '＋ Add seasons to this show…', run: () => pickAnime({
        title: 'Add seasons', note: `Search, tick every series that belongs to ${s.show.title} (a season, movie or OVA) and add them together.`,
        exclude: [...memberIds, id], multi: true,
        onPick: async (pids) => {
          for (const pid of pids) await api(`/anime/series/${pid}/parent`, { method: 'POST', body: { parentId: showId } });
          toast(`${pids.length} added`); renderAnimeSeries(id);
        },
      }) },
      s.seasons ? { label: '✎ Name this show…', run: async () => {
        const v = prompt('Name of the whole show (blank = first entry\'s title):', s.show.named ? s.show.title : '');
        if (v === null) return;
        await api(`/anime/series/${s.show.id}/show-title`, { method: 'PUT', body: { title: v } });
        renderAnimeSeries(id);
      } } : null,
      { label: '↗ Make this a season of another show…', run: () => pickAnime({
        title: 'Make this a season of…', note: `Pick the show that ${s.title} belongs to.`,
        exclude: [...memberIds, id],
        onPick: async (pid) => {
          const r2 = await api(`/anime/series/${id}/parent`, { method: 'POST', body: { parentId: pid } });
          toast('Grouped'); location.hash = `#/anime/${r2.rootId}`;
        },
      }) },
      s.seasons ? { label: '✎ Rename this season…', run: async () => {
        const cur = s.seasons.find((x) => x.current);
        const v = prompt('Name in the season list (blank = automatic):', cur?.customLabel ? cur.label : '');
        if (v === null) return;
        await api(`/anime/series/${id}/label`, { method: 'PUT', body: { label: v } });
        renderAnimeSeries(id);
      } } : null,
      s.seasons && s.show.id !== id ? { label: 'Show on its own (not a season of this show)', run: async () => {
        await api(`/anime/series/${id}/parent`, { method: 'POST', body: { parentId: 0 } }); renderAnimeSeries(id);
      } } : null,
      s.parentId !== null && s.parentId !== undefined ? { label: 'Back to automatic grouping', run: async () => {
        await api(`/anime/series/${id}/parent`, { method: 'POST', body: { parentId: null } }); renderAnimeSeries(id);
      } } : null,
    ]);
  });
  // genre / tag / season chips open the library filtered by them
  view.querySelector('.hero').addEventListener('click', (e) => {
    const more = e.target.closest('#moreTags');
    if (more) { view.querySelectorAll('.xtag').forEach((t) => t.classList.remove('hidden')); more.remove(); return; }
    const t = e.target.closest('[data-facet],[data-season]'); if (!t) return;
    try {
      sessionStorage.setItem('ms.anime.facet', t.dataset.facet || '');
      sessionStorage.setItem('ms.anime.season', t.dataset.season || '');
      sessionStorage.setItem('ms.filter.anime', 'all');
    } catch { /* private mode */ }
  });
  $('#rev').addEventListener('click', () => {
    reversed = !reversed; sessionStorage.setItem('ms.rev.anime', reversed ? '1' : '0');
    $('#rev').textContent = reversed ? '↑ First episode first' : '↓ Newest first'; drawList();
  });
  $('#markAll').addEventListener('click', async () => {
    await watchedApi.show(id, doneCount !== eps.length, 'season');
    renderAnimeSeries(id);
  });
  $('#match').addEventListener('click', () => openMatchModal(s, () => renderAnimeSeries(id)));
  $('#split')?.addEventListener('click', async () => {
    if (!confirm('Show these folders as separate series again?')) return;
    await api(`/anime/series/${id}/split`, { method: 'POST' });
    toast('Split apart');
    location.hash = '#/anime';
  });
  $('#refresh')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api(`/series/${id}/refresh`, { method: 'POST' });
      const t = await api(`/anime/series/${id}/titles`, { method: 'POST' }).catch(() => null);
      if (t) toast(t.titles ? `Episode titles: ${t.titles} found` : 'No online episode titles found for this one');
      renderAnimeSeries(id);
    }
    catch (err) { toast(err.message, true); e.target.disabled = false; }
  });
  $('#rescan').addEventListener('click', async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try {
      const r = await api(`/anime/series/${id}/rescan`, { method: 'POST' });
      const bits = [`${r.episodes} episode${r.episodes === 1 ? '' : 's'}`];
      if (r.added) bits.push(`${r.added} new`);
      if (r.removed) bits.push(`${r.removed} gone`);
      if (r.moved) bits.push(`${r.moved} renamed, progress kept`);
      toast(`Rescanned: ${bits.join(' · ')}`);
      renderAnimeSeries(id);
    } catch (err) {
      b.disabled = false;
      if (err.message.includes('not at its old location') && confirm(`${err.message}\n\nScan your libraries now so MangaSoft can find it again?`)) {
        await api('/scan', { method: 'POST', body: {} });
        toast('Scanning libraries…');
        watchScan(() => route());
      } else toast(err.message, true);
    }
  });

  // which episodes of the season you have (numbers come from the file names)
  if (cfg.showMissing !== false && s.chaptersTotal && regular.length) {
    // numbers as AniList counts them: with several seasons in one entry, S2 carries on after S1
    const have = new Set(regular.map((e) => Math.floor(e.abs ?? e.number ?? -1)));
    const gone = [];
    for (let n = 1; n <= s.chaptersTotal; n++) if (!have.has(n)) gone.push(n);
    const ranges = [];
    for (const n of gone) {
      const last = ranges[ranges.length - 1];
      if (last && last[1] === n - 1) last[1] = n; else ranges.push([n, n]);
    }
    const text = ranges.map(([a, b]) => (a === b ? a : `${a}–${b}`)).join(', ');
    $('#collection').innerHTML = `<div class="panel collection" style="margin-top:0"><b>Your collection</b>
      <div><b>Episodes</b> ${Math.min(have.size, s.chaptersTotal)} / ${s.chaptersTotal}
        ${gone.length ? `<span class="muted">· missing ${esc(text.length > 120 ? text.slice(0, 120) + ' …' : text)}</span>` : '<span class="muted">· complete</span>'}</div>
      ${s.status === 'RELEASING' ? '<div class="muted" style="font-size:12.5px;margin-top:6px">Still airing, so more episodes appear over time.</div>' : ''}</div>`;
  }

  // AniList list status
  if (s.anilistId) {
    const box = $('#al');
    try {
      const r = await api(`/series/${id}/anilist`);
      if (!r.connected) {
        box.innerHTML = '<div class="al-box muted">Connect AniList in <a href="#/settings">Settings</a> to track what you watch.</div>';
      } else {
        const e = r.entry;
        const labels = { CURRENT: 'Watching', PLANNING: 'Plan to watch', COMPLETED: 'Completed', PAUSED: 'On hold', DROPPED: 'Dropped', REPEATING: 'Re-watching' };
        box.innerHTML = `<div class="al-box">
          <span><b>AniList:</b> ${e ? `${labels[e.status] || e.status} · ${e.progress}${s.chaptersTotal ? ' / ' + s.chaptersTotal : ''} ep` : 'not on your list'}</span>
          <select id="alStatus">
            ${e ? '' : '<option value="">Add to list…</option>'}
            ${Object.entries(labels).map(([k, l]) => `<option value="${k}" ${e?.status === k ? 'selected' : ''}>${l}</option>`).join('')}
          </select></div>`;
        $('#alStatus').addEventListener('change', async (ev) => {
          if (!ev.target.value) return;
          try { await api(`/series/${id}/anilist`, { method: 'POST', body: { status: ev.target.value } }); toast('AniList updated'); renderAnimeSeries(id); }
          catch (err) { toast(err.message, true); }
        });
      }
    } catch (err) { box.innerHTML = `<div class="al-box muted">AniList: ${esc(err.message)}</div>`; }
  }
}

// ---------- player ----------
async function renderWatch(id) {
  const ep = await api(`/anime/episodes/${id}`);
  const al = await api('/anilist/status').catch(() => ({ connected: false }));
  document.body.classList.add('reading');
  $('#nav').classList.add('hidden');
  view.classList.add('hidden');

  const canSync = al.connected && ep.series.anilistId && !ep.special && ep.number != null;
  let synced = false, hls = null, mode = '', forceTranscode = false, popOpen = false, subStyleOpen = false, styleTimer = null, assInst = null;
  let ended = false, countdown = null, saveTimer = null, idleTimer = null, lastSaved = 0, token = 0;

  const ov = $('#overlay');
  ov.innerHTML = `
    <div class="player" id="player">
      <video id="vid" playsinline controls preload="auto"></video>
      <div class="pbar" id="pbar">
        <a class="btn small" href="#/anime/${ep.series.id}" title="Back (Esc)">←</a>
        <div class="title"><b>${esc(ep.series.title)}</b> <span class="muted">· ${esc(ep.title)}${ep.name ? ' · ' + esc(ep.name) : ''}</span></div>
        <span class="pmode" id="pmode"></span>
        ${canSync ? '<button class="btn small" id="alBtn"><span class="al-label"></span><span class="hidden-label">＋</span></button>' : ''}
        <button class="btn small" id="prevEp" ${ep.prevId ? '' : 'disabled'} title="Previous episode (P)">⏮</button>
        <button class="btn small" id="nextEp" ${ep.nextId ? '' : 'disabled'} title="Next episode (N)">⏭</button>
        <button class="btn small" id="gear" title="Audio, subtitles & quality">⚙</button>
      </div>
      <button class="skip hidden" id="skip">Skip intro ⏭</button>
      <div class="pstatus hidden" id="pstat"></div>
      <div class="pnext hidden" id="pnext"></div>
      <div id="ppop"></div>
    </div>`;
  // keep element handles: media events can still fire after the page has been replaced
  const player = $('#player'), vid = $('#vid'), skipBtn = $('#skip'), pstat = $('#pstat'), pnext = $('#pnext'), pmode = $('#pmode');
  const status = (msg, err = false) => {
    pstat.classList.toggle('hidden', !msg);
    pstat.classList.toggle('err', err);
    pstat.innerHTML = msg ? (err ? `⚠️ ${esc(msg)}` : `<div class="spinner"></div> ${esc(msg)}`) : '';
  };

  // ----- choose tracks -----
  const sel = { audio: 0, sub: null, burn: animePrefs.burn, height: animePrefs.height };
  (() => {
    const wantA = langKey(animePrefs.audioLang);
    const a = ep.audio.find((t) => langKey(t.lang) === wantA) || ep.audio.find((t) => t.default) || ep.audio[0];
    sel.audio = a ? a.ord : 0;
    if (animePrefs.subs) {
      const wantS = langKey(animePrefs.subLang);
      const audioIsSubLang = a && langKey(a.lang) === wantS;
      const cands = ep.subs.filter((t) => langKey(t.lang) === wantS);
      const pick = audioIsSubLang ? cands.find((t) => t.forced) : (cands.find((t) => !t.forced && t.text) || cands.find((t) => !t.forced) || cands[0]);
      sel.sub = pick ? pick.ord : null;
    }
  })();
  const subTrack = () => (sel.sub == null ? null : ep.subs.find((t) => t.ord === sel.sub) || null);
  const burning = () => {
    const t = subTrack();
    if (!t || !ep.ffmpeg.ready) return false;
    return (sel.burn || !t.text) && (t.text ? ep.ffmpeg.libass : !t.external);
  };

  // ----- playback -----
  const teardown = () => {
    if (assInst) { try { assInst.destroy(); } catch { /* gone */ } assInst = null; }
    if (hls) { hls.destroy(); hls = null; }
    vid.removeAttribute('src');
    for (const t of [...vid.querySelectorAll('track')]) t.remove();
    vid.load();
  };

  async function start(pos = 0) {
    const my = ++token;
    teardown();
    ended = false;
    status('Getting your video ready…');
    const burn = burning();
    const direct = ep.directPlay && sel.audio === 0 && !burn && !sel.height && !forceTranscode && !(subTrack() && !subTrack().text);
    try {
      if (direct) {
        mode = 'direct';
        vid.src = `/api/anime/episodes/${ep.id}/file`;
        vid.addEventListener('loadedmetadata', () => { if (pos > 1) vid.currentTime = pos; }, { once: true });
      } else {
        const q = new URLSearchParams({ audio: sel.audio, height: sel.height || 0 });
        if (sel.sub != null && burn) { q.set('sub', sel.sub); q.set('burn', '1'); const sty = subStyleParam(); if (sty) q.set('sty', sty); }
        if (forceTranscode) q.set('transcode', '1');
        const s = await api(`/anime/episodes/${ep.id}/session?${q}`);
        if (my !== token) return;
        mode = s.mode;
        const Hls = await loadHls().catch(() => null);
        if (my !== token) return;
        if (Hls && Hls.isSupported()) {
          hls = new Hls({ startPosition: pos > 1 ? pos : -1, maxBufferLength: 40, backBufferLength: 30, enableWorker: true });
          let recovered = false;
          hls.on(Hls.Events.ERROR, (_e, data) => {
            if (!data.fatal) return;
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; hls.recoverMediaError(); return; }
            status(data.type === Hls.ErrorTypes.NETWORK_ERROR
              ? 'Lost the connection to the server while loading the video.' : `Playback error (${data.details}).`, true);
          });
          hls.loadSource(s.url);
          hls.attachMedia(vid);
        } else if (vid.canPlayType('application/vnd.apple.mpegurl')) {
          vid.src = s.url;
          vid.addEventListener('loadedmetadata', () => { if (pos > 1) vid.currentTime = pos; }, { once: true });
        } else {
          throw new Error('This browser cannot play the converted video stream.');
        }
      }
      showMode();
      attachSoftSub(burn, my);
      vid.play().catch(() => { /* needs a tap on some phones */ });
    } catch (e) { status(e.message, true); }
  }

  // the browser's subtitle layer follows the chosen look (and the video's size)
  const cueStyle = document.createElement('style');
  cueStyle.id = 'cueStyle';
  document.head.append(cueStyle);
  const applyCue = () => { cueStyle.textContent = subCueCss(vid.clientHeight || vid.videoHeight); };
  applyCue();
  if (window.ResizeObserver) { const ro = new ResizeObserver(applyCue); ro.observe(vid); }
  vid.addEventListener('loadedmetadata', applyCue);

  async function attachSoftSub(burn, my) {
    const t = subTrack();
    if (!t || burn || !t.text) return;
    // styled (ASS) tracks: libass in the browser, with the fonts embedded in the file
    if (animePrefs.sub.useAss && ['ass', 'ssa'].includes(String(t.codec).toLowerCase())) {
      try {
        const mod = await import('/vendor/jassub/jassub.js');
        const fonts = await api(`/anime/episodes/${ep.id}/fonts`).catch(() => []);
        if (my !== token) return;
        const inst = new mod.default({
          video: vid, subUrl: `/api/anime/episodes/${ep.id}/subs/${t.ord}.ass`, fonts: fonts.map((x) => x.url),
          workerUrl: '/vendor/jassub/worker.js',
          wasmUrl: '/vendor/jassub-dist/wasm/jassub-worker.wasm', modernWasmUrl: '/vendor/jassub-dist/wasm/jassub-worker-modern.wasm',
          availableFonts: { 'liberation sans': '/vendor/jassub-dist/default.woff2' },
        });
        assInst = inst;
        await inst.ready;
        if (my !== token) { try { inst.destroy(); } catch { /* gone */ } if (assInst === inst) assInst = null; }
        return;
      } catch { assInst = null; /* this browser cannot do it: plain subtitles below */ }
    }
    const tr = document.createElement('track');
    tr.kind = 'subtitles'; tr.label = t.label; tr.srclang = (langKey(t.lang) || 'en').slice(0, 2);
    tr.src = `/api/anime/episodes/${ep.id}/subs/${t.ord}.vtt`;
    tr.default = true;
    vid.append(tr);
    tr.addEventListener('load', () => { if (tr.track) tr.track.mode = 'showing'; });
    if (tr.track) tr.track.mode = 'showing';
  }

  function showMode() {
    const burn = burning();
    const text = mode === 'direct' ? 'Direct play'
      : mode === 'remux' ? 'Converting · video copied'
      : `Converting${burn ? ' · subtitles burned in' : ''}${sel.height ? ` · ${sel.height}p` : ''}`;
    pmode.textContent = text;
  }

  vid.addEventListener('playing', () => status(''));
  vid.addEventListener('waiting', () => { if (!vid.paused) status('Buffering…'); });
  vid.addEventListener('canplay', () => status(''));
  vid.addEventListener('error', () => {
    if (mode === 'direct' && !forceTranscode) { // the browser could not play the file itself: convert instead
      forceTranscode = true;
      start(vid.currentTime || 0);
    } else if (mode) status('This video could not be played.', true);
  });

  // ----- progress, AniList, next episode -----
  const dur = () => (Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : ep.duration);
  function save({ beacon = false } = {}) {
    const d = dur(), p = vid.currentTime;
    if (!d || !Number.isFinite(p) || p < 1) return;
    const body = JSON.stringify({ episodeId: ep.id, position: p, duration: d, completed: p / d >= 0.9 || ended });
    lastSaved = Date.now();
    if (beacon) fetch('/api/anime/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    else api('/anime/progress', { method: 'POST', body: JSON.parse(body) }).catch(() => {});
  }
  const alNo = ep.anilistNumber ?? Math.floor(ep.number);
  const alLabel = () => (synced ? `✓ AniList: ep ${alNo}` : `＋ Mark ep ${alNo} watched on AniList`);
  const paintAl = () => {
    if (!$('#alBtn')) return;
    $('#alBtn .al-label').textContent = alLabel();
    $('#alBtn .hidden-label').textContent = synced ? '✓' : '＋';
  };
  async function markOnAniList({ silent = false } = {}) {
    if (!canSync || synced) return;
    try {
      const r = await api('/anime/anilist/progress', { method: 'POST', body: { episodeId: ep.id } });
      synced = true; paintAl();
      const of = ep.series.episodesTotal ? ` / ${ep.series.episodesTotal}` : '';
      toast(r.changed ? `✓ AniList updated: ${r.previous} → ${r.entry.progress}${of}` : `AniList already at episode ${r.entry.progress}${of}`);
    } catch (e) { if (!silent) toast(e.message, true); }
  }
  if (canSync) paintAl();
  $('#alBtn')?.addEventListener('click', () => markOnAniList());

  let autoSynced = false;
  vid.addEventListener('timeupdate', () => {
    if (Date.now() - lastSaved > 10_000 && !vid.paused) save();
    const d = dur();
    if (!autoSynced && d && vid.currentTime / d >= 0.9) {
      autoSynced = true;
      if (al.autoSync) markOnAniList({ silent: true });
    }
    const intro = ep.intro;
    skipBtn.classList.toggle('hidden', !(intro && vid.currentTime >= intro.start && vid.currentTime < intro.end - 1));
  });
  vid.addEventListener('pause', () => save());
  vid.addEventListener('ended', () => {
    ended = true; save();
    if (al.autoSync && !autoSynced) { autoSynced = true; markOnAniList({ silent: true }); }
    if (animePrefs.autoNext && ep.nextId) {
      let n = 8;
      const box = pnext;
      const paint = () => { box.innerHTML = `<div>Next episode in ${n}s</div><div class="actions" style="justify-content:center;margin-top:8px">
        <button class="btn primary small" id="goNext">▶ Play now</button><button class="btn small" id="stayHere">Cancel</button></div>`; };
      box.classList.remove('hidden'); paint();
      countdown = setInterval(() => {
        if (--n <= 0) { clearInterval(countdown); location.hash = `#/watch/${ep.nextId}`; } else paint();
      }, 1000);
      box.onclick = (e) => {
        if (e.target.id === 'goNext') { clearInterval(countdown); location.hash = `#/watch/${ep.nextId}`; }
        if (e.target.id === 'stayHere') { clearInterval(countdown); box.classList.add('hidden'); }
      };
    }
  });
  skipBtn.addEventListener('click', () => { if (ep.intro) vid.currentTime = ep.intro.end; });
  $('#prevEp').addEventListener('click', () => ep.prevId && (location.hash = `#/watch/${ep.prevId}`));
  $('#nextEp').addEventListener('click', () => ep.nextId && (location.hash = `#/watch/${ep.nextId}`));

  // ----- settings popup -----
  function drawPop() {
    const pop = $('#ppop');
    if (!popOpen) { pop.innerHTML = ''; return; }
    const t = subTrack();
    const imageOnly = t && !t.text && !t.external;
    pop.innerHTML = `<div class="rpop ppop">
      ${ep.audio.length > 1 ? `<label>Audio</label><select id="pAudio">${ep.audio.map((a) =>
        `<option value="${a.ord}" ${a.ord === sel.audio ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}</select>` : ''}
      <label>Subtitles</label>
      <select id="pSub"><option value="">Off</option>${ep.subs.map((s) =>
        `<option value="${s.ord}" ${s.ord === sel.sub ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>
      <label style="display:flex;gap:8px;align-items:flex-start;margin-top:12px;color:var(--text);font-size:13.5px">
        <input type="checkbox" id="pBurn" ${burning() ? 'checked' : ''} ${!t || imageOnly || !ep.ffmpeg.ready || !ep.ffmpeg.libass ? 'disabled' : ''} style="margin-top:3px">
        <span>Burn subtitles into the picture
          <span class="muted" style="display:block;font-size:12px">${imageOnly ? 'This track is made of images, so it is always burned in.'
            : !ep.ffmpeg.ready || !ep.ffmpeg.libass ? 'Needs ffmpeg with subtitle support on the server.'
            : 'Keeps styled signs and typesetting exactly as authored. Uses more server CPU than plain subtitles.'}</span></span></label>
      <details id="pStyle" ${subStyleOpen ? 'open' : ''} style="margin-top:12px"><summary style="cursor:pointer">Subtitle style</summary>${subStyleHtml('ps')}</details>
      <label>Quality</label>
      <select id="pH"><option value="0">Original</option>${[1080, 720, 480, 360].map((h) =>
        `<option value="${h}" ${sel.height === h ? 'selected' : ''}>${h}p (converted)</option>`).join('')}</select>
      <label style="display:flex;gap:8px;align-items:center;margin-top:12px;color:var(--text);font-size:13.5px">
        <input type="checkbox" id="pNext" ${animePrefs.autoNext ? 'checked' : ''}> Play next episode automatically</label>
      <div class="muted" style="font-size:12px;margin-top:10px">${esc(vid.videoWidth ? `${vid.videoWidth}×${vid.videoHeight} · ` : '')}${esc(ep.video ? ep.video.codec.toUpperCase() : '')}
        ${mode === 'direct' ? '' : ' → H.264'}</div>
    </div>`;
    const reload = () => { const p = vid.currentTime; start(p); drawPop(); };
    $('#pAudio')?.addEventListener('change', (e) => {
      sel.audio = Number(e.target.value);
      const a = ep.audio.find((x) => x.ord === sel.audio); if (a?.lang) animePrefs.audioLang = langKey(a.lang);
      saveAnimePrefs(); reload();
    });
    $('#pSub').addEventListener('change', (e) => {
      sel.sub = e.target.value === '' ? null : Number(e.target.value);
      animePrefs.subs = sel.sub != null;
      const s2 = subTrack(); if (s2?.lang) animePrefs.subLang = langKey(s2.lang);
      saveAnimePrefs(); reload();
    });
    $('#pBurn').addEventListener('change', (e) => { sel.burn = e.target.checked; animePrefs.burn = sel.burn; saveAnimePrefs(); reload(); });
    $('#pH').addEventListener('change', (e) => { sel.height = Number(e.target.value); animePrefs.height = sel.height; saveAnimePrefs(); reload(); });
    $('#pNext').addEventListener('change', (e) => { animePrefs.autoNext = e.target.checked; saveAnimePrefs(); });
    $('#pStyle').addEventListener('toggle', (e) => { subStyleOpen = e.target.open; });
    bindSubStyle('ps', (key) => {
      applyCue();
      if (key === 'useAss') { const p = vid.currentTime; start(p); return; }
      // a burned-in track has to be re-encoded to change; wait until the sliders settle
      if (burning() && (animePrefs.sub.applyBurn || key === 'applyBurn' || key === 'reset')) {
        clearTimeout(styleTimer);
        styleTimer = setTimeout(() => { const p = vid.currentTime; start(p); }, 900);
      }
    });
  }
  $('#gear').addEventListener('click', (e) => { e.stopPropagation(); popOpen = !popOpen; drawPop(); });
  player.addEventListener('click', (e) => {
    if (popOpen && !e.target.closest('.ppop') && !e.target.closest('#gear')) { popOpen = false; drawPop(); }
  });

  // ----- chrome: auto-hiding top bar, keys, fullscreen -----
  const wake = () => {
    player.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!vid.paused && !popOpen) player.classList.add('idle'); }, 3000);
  };
  ['mousemove', 'touchstart', 'keydown'].forEach((ev) => player.addEventListener(ev, wake, { passive: true }));
  vid.addEventListener('pause', wake);
  wake();
  const toggleFs = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else (player.requestFullscreen?.() || vid.webkitEnterFullscreen?.());
  };
  vid.addEventListener('dblclick', toggleFs);
  const onKey = (e) => {
    if (e.target.matches('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case ' ': case 'k': e.preventDefault(); vid.paused ? vid.play() : vid.pause(); break;
      case 'ArrowRight': e.preventDefault(); vid.currentTime = Math.min(dur() || 1e9, vid.currentTime + 10); break;
      case 'ArrowLeft': e.preventDefault(); vid.currentTime = Math.max(0, vid.currentTime - 10); break;
      case 'l': vid.currentTime += 10; break;
      case 'j': vid.currentTime = Math.max(0, vid.currentTime - 10); break;
      case 'ArrowUp': e.preventDefault(); vid.volume = Math.min(1, vid.volume + 0.1); break;
      case 'ArrowDown': e.preventDefault(); vid.volume = Math.max(0, vid.volume - 0.1); break;
      case 'm': vid.muted = !vid.muted; break;
      case 'f': toggleFs(); break;
      case 'c': if (ep.subs.length) { sel.sub = sel.sub == null ? ep.subs.find((t) => t.text)?.ord ?? ep.subs[0].ord : null; start(vid.currentTime); drawPop(); } break;
      case 'n': if (ep.nextId) location.hash = `#/watch/${ep.nextId}`; break;
      case 'p': if (ep.prevId) location.hash = `#/watch/${ep.prevId}`; break;
      case 'Escape': if (!document.fullscreenElement) location.hash = `#/anime/${ep.series.id}`; break;
      default: return;
    }
  };
  document.addEventListener('keydown', onKey);

  const onUnload = () => save({ beacon: true });
  window.addEventListener('pagehide', onUnload);
  saveTimer = setInterval(() => { if (!vid.paused) save(); }, 15_000);

  const prevCleanup = cleanup;
  cleanup = () => {
    save({ beacon: true });
    token++; // abandon any start() still in flight
    clearInterval(saveTimer); clearInterval(countdown); clearTimeout(idleTimer);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('pagehide', onUnload);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    teardown();
    prevCleanup?.();
  };

  if (ep.error) { status(ep.error, true); return; }
  const resumeAt = !ep.completed && ep.position > 10 && ep.position < (ep.duration || 1e9) - 30 ? ep.position : 0;
  start(resumeAt);
}

// ---------- settings panel ----------
function animeSettingsHtml(an) {
  const f = an.ffmpeg;
  const encoders = { libx264: 'CPU (x264) - works everywhere', h264_nvenc: 'NVIDIA GPU (NVENC)', h264_qsv: 'Intel GPU (Quick Sync)', h264_amf: 'AMD GPU (AMF)', h264_videotoolbox: 'Apple (VideoToolbox)' };
  const langOpts = (cur) => LANG_CHOICES.map(([k, n]) => `<option value="${k}" ${langKey(cur) === k ? 'selected' : ''}>${n}</option>`).join('');
  return `
    <div class="panel"><h2>Anime section</h2>
      <p class="muted" style="margin-top:0">Folders of video files, kept separate from manga. Each folder becomes a series (a “Season 2” sub-folder
        becomes its own entry so it can match its own AniList page); loose files become single-file series. Details come from AniList.</p>
      <div id="anLibs">${an.libraries.map((l) => `<div class="list-row"><span style="flex:1">${esc(l)}</span>
        <button class="btn small" data-scan="${esc(l)}" title="Check just this folder for new or changed files">↻ Scan</button>
        <button class="btn small danger" data-anrm="${esc(l)}">Remove</button></div>`).join('') || '<div class="muted">No folders yet.</div>'}</div>
      <div class="form-row"><input type="text" id="newAn" placeholder="e.g. D:\\Anime"><button class="btn primary" id="addAn">Add folder</button></div>
      <p class="muted" style="margin:12px 0 0">${f.ready
        ? `✓ ffmpeg ${esc(f.version || '')} found${f.libass ? ' · subtitle burn-in available' : ' · ⚠️ this build has no subtitle burn-in (libass)'}.`
        : '⚠️ ffmpeg was not found. Install ffmpeg (or run <code class="k">npm install</code> in the MangaSoft folder) so videos can be converted for your browser.'}</p>
      ${f.ready ? `<div class="form-row" style="align-items:center"><label for="anEnc" style="flex:0 0 auto">Convert video with</label>
        <select id="anEnc" style="flex:0 1 auto">${['libx264', ...f.encoders.filter((e) => e !== 'libx264')].map((e) =>
          `<option value="${e}" ${an.encoder === e ? 'selected' : ''}>${esc(encoders[e] || e)}</option>`).join('')}</select></div>
        <p class="muted" style="margin:4px 0 0">Only used when a file cannot be played as-is. H.264 files are copied untouched whenever possible.
          Pick a GPU option only if this machine has that GPU; if it fails MangaSoft falls back to the CPU.</p>` : ''}
      <label style="display:block;margin-top:12px"><input type="checkbox" id="anGroup" ${an.groupSeasons !== false ? 'checked' : ''}> Group the seasons of a show into one entry (S1, S2, S3… in a bar on its page; found from AniList's sequels)</label>
      <label style="display:block;margin-top:8px"><input type="checkbox" id="anAlt" ${an.groupAlt !== false ? 'checked' : ''}> Also group separate series AniList marks as alternatives of each other (Precure, Fate…) under the earliest one</label>
      <h3 style="margin:18px 0 6px;font-size:14px">On this device</h3>
      <div class="form-row" style="align-items:center;margin-top:0">
        <label style="flex:0 0 auto">Audio</label><select id="anAudio" style="flex:0 1 auto">${langOpts(animePrefs.audioLang)}</select>
        <label style="flex:0 0 auto">Subtitles</label><select id="anSubLang" style="flex:0 1 auto">${langOpts(animePrefs.subLang)}</select>
      </div>
      <label style="display:block;margin-top:10px"><input type="checkbox" id="anSubs" ${animePrefs.subs ? 'checked' : ''}> Show subtitles by default</label>
      <label style="display:block;margin-top:6px"><input type="checkbox" id="anBurn" ${animePrefs.burn ? 'checked' : ''}> Burn subtitles into the picture by default <span class="muted">(uses more CPU; image-based subtitles are always burned in)</span></label>
      <label style="display:block;margin-top:6px"><input type="checkbox" id="anNext" ${animePrefs.autoNext ? 'checked' : ''}> Play the next episode automatically</label>
      <h3 style="margin:18px 0 6px;font-size:14px">Subtitle appearance</h3>
      ${subStyleHtml('as')}
    </div>`;
}

function bindAnimeSettings(refresh, scanLib) {
  $('#anLibs').addEventListener('click', scanLib);
  $('#anLibs').addEventListener('click', async (e) => {
    const p = e.target.dataset.anrm; if (!p) return;
    await api('/anime/libraries', { method: 'DELETE', body: { path: p } }); refresh(); refreshNav();
  });
  $('#addAn').addEventListener('click', async () => {
    try { await api('/anime/libraries', { method: 'POST', body: { path: $('#newAn').value } }); refresh(); refreshNav(); }
    catch (e) { toast(e.message, true); }
  });
  $('#anAlt').addEventListener('change', async (e) => {
    await api('/anime/settings', { method: 'PUT', body: { groupAlt: e.target.checked } });
    toast(e.target.checked ? 'Alternatives grouped' : 'Alternatives shown separately');
  });
  $('#anGroup').addEventListener('change', async (e) => {
    await api('/anime/settings', { method: 'PUT', body: { groupSeasons: e.target.checked } });
    toast(e.target.checked ? 'Seasons grouped' : 'Seasons shown separately');
  });
  $('#anEnc')?.addEventListener('change', (e) => api('/anime/settings', { method: 'PUT', body: { encoder: e.target.value } }).catch((err) => toast(err.message, true)));
  const pref = (id, key, num) => $(id).addEventListener('change', (e) => {
    animePrefs[key] = e.target.type === 'checkbox' ? e.target.checked : (num ? Number(e.target.value) : e.target.value);
    saveAnimePrefs();
  });
  bindSubStyle('as');
  pref('#anAudio', 'audioLang'); pref('#anSubLang', 'subLang'); pref('#anSubs', 'subs'); pref('#anBurn', 'burn'); pref('#anNext', 'autoNext');
}
