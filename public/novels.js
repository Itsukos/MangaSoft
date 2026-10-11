// ---------- light novels: series page, reader and settings ----------
// Loaded before app.js; uses its globals ($, view, api, esc, toast, route, bindCtx, openProperties, revealFile, …).

const NV_THEMES = {
  dark: { name: 'Dark', bg: '#16121b', fg: '#e9e4ef', link: '#ff9ec0' },
  black: { name: 'Black', bg: '#000000', fg: '#cfcfcf', link: '#ff9ec0' },
  sepia: { name: 'Sepia', bg: '#f4ecd8', fg: '#433422', link: '#9a4a24' },
  light: { name: 'Light', bg: '#ffffff', fg: '#1d1d1f', link: '#c2185b' },
};
const NV_FONTS = {
  serif: ['Serif', 'Georgia, "Noto Serif", "Times New Roman", serif'],
  sans: ['Sans', '"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif'],
  mono: ['Mono', 'ui-monospace, Consolas, "Courier New", monospace'],
};
const NV_DEFAULT = { theme: 'dark', font: 'serif', size: 19, lh: 1.75, width: 720, justify: false };
const novelPrefs = (() => {
  try { return { ...NV_DEFAULT, ...JSON.parse(localStorage.getItem('ms.novel') || '{}') }; } catch { return { ...NV_DEFAULT }; }
})();
const saveNovelPrefs = () => { try { localStorage.setItem('ms.novel', JSON.stringify(novelPrefs)); } catch { /* private mode */ } };

// ---------- series page ----------
async function renderNovelSeries(s) {
  const id = s.id;
  const read = s.chapters.filter((c) => c.completed).length;
  const resume = s.chapters.find((c) => !c.completed && c.page > 0) || s.chapters.find((c) => !c.completed) || s.chapters[0];
  const started = s.chapters.some((c) => c.completed || c.page > 0);
  const tags = s.tags || [];
  view.innerHTML = `
    <a class="muted" href="#/novels">← Novels</a>
    <div class="hero">
      ${s.banner ? `<div class="bg" style="background-image:url('${esc(s.banner)}')"></div>` : ''}
      <div class="inner">
        <div class="poster"><img src="/api/series/${s.id}/cover" alt=""></div>
        <div class="info">
          <h1>${esc(s.title)}</h1>
          <div class="alt">${esc([s.native, s.romaji !== s.title ? s.romaji : ''].filter(Boolean).join(' · '))}</div>
          <div class="meta">
            ${s.status ? `<span>${esc(s.status.replace(/_/g, ' ').toLowerCase())}</span>` : ''}
            <span>Light novel</span>
            ${s.year ? `<span>${s.year}</span>` : ''}
            ${s.score ? `<span>★ ${s.score}%</span>` : ''}
            ${s.volumesTotal ? `<span>${s.volumesTotal} volumes</span>` : ''}
            ${s.authors.length ? `<span>${esc(s.authors.slice(0, 3).join(', '))}</span>` : ''}
          </div>
          ${s.genres.length || tags.length ? `<div class="tags">${s.genres.map((g) => `<a class="tag genre" href="#/novels" data-facet="tags:genres:${esc(g)}">${esc(g)}</a>`).join('')}
            ${tags.map((g, i) => `<a class="tag soft ${i >= 10 ? 'xtag hidden' : ''}" href="#/novels" data-facet="tags:tags:${esc(g)}">${esc(g)}</a>`).join('')}
            ${tags.length > 10 ? `<button class="tag soft" id="moreTags">+${tags.length - 10} tags</button>` : ''}</div>` : ''}
          ${s.edited?.length ? '<div class="muted" style="margin-bottom:8px">✎ Includes your manual edits</div>' : ''}
          ${s.description ? `<div class="desc">${esc(s.description)}</div>` : ''}
          <div class="actions">
            ${resume ? `<a class="btn primary" href="#/read/${resume.id}">${started ? '▶ Continue' : '▶ Start reading'}${resume.title ? ` · ${esc(resume.title)}` : ''}</a>` : ''}
            <button class="btn" id="match">🛠 Fix metadata${s.anilistId ? '' : ' · Match on AniList'}</button>
            ${s.anilistId ? '<button class="btn" id="refresh">↻ Refresh info</button>' : ''}
            ${s.siteUrl ? `<a class="btn" href="${esc(s.siteUrl)}" target="_blank" rel="noopener">AniList ↗</a>` : ''}
            <button class="btn" id="rescan" title="Re-read this folder after adding or renaming files">↻ Rescan files</button>
            <button class="btn" id="markAll">${read === s.chapters.length ? 'Mark all unread' : 'Mark all read'}</button>
          </div>
        </div>
      </div>
    </div>
    <div id="related"></div>
    <div class="viewbar"><h2 style="margin:0;flex:1">Volumes <span class="muted">(${read}/${s.chapters.length} read)</span></h2>
      <label class="sizer" title="Cover size"><span class="muted">▫</span><input type="range" id="volSize" min="90" max="320" step="10"><span class="muted">▣</span></label></div>
    <div id="gal" class="vgrid" style="margin-top:12px"></div>`;
  renderRelated(id);

  $('#gal').innerHTML = `<div class="grid">${s.chapters.map((c) => {
    const frac = c.completed ? 1 : (c.pageCount ? c.page / c.pageCount : 0);
    return `<a class="card" href="#/read/${c.id}" data-id="${c.id}">
      <div class="cover"><img loading="lazy" src="/api/chapters/${c.id}/cover" alt="">
        <button class="more" title="More options (or right-click)">⋯</button>
        ${c.completed ? '<span class="badge done">✓ Read</span>' : ''}
        <button class="qtog" data-id="${c.id}" data-read="${c.completed ? 0 : 1}">${c.completed ? '↺ Unread' : '✓ Read'}</button>
        <div class="bar"><i style="width:${Math.round(frac * 100)}%"></i></div></div>
      <div class="name">${esc(c.title)}</div>
      <div class="sub">${c.pageCount ? `${c.pageCount} sections` : 'unreadable'}</div></a>`;
  }).join('') || '<div class="empty">No EPUB files found in this folder.</div>'}</div>`;

  const sizeSaved = Number(localStorage.getItem('ms.volSize'));
  const start = sizeSaved >= 90 && sizeSaved <= 320 ? sizeSaved : (window.innerWidth < 640 ? 110 : 150);
  $('#volSize').value = start; $('#gal').style.setProperty('--vol-size', `${start}px`);
  $('#volSize').addEventListener('input', (e) => { $('#gal').style.setProperty('--vol-size', `${e.target.value}px`); localStorage.setItem('ms.volSize', e.target.value); });

  const mark = (ids, readIt) => api('/chapters/read-bulk', { method: 'POST', body: { ids, read: readIt } });
  $('#gal').addEventListener('click', async (e) => {
    const b = e.target.closest('.qtog'); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    try { await mark([Number(b.dataset.id)], b.dataset.read === '1'); renderSeries(id); } catch (err) { toast(err.message, true); }
  });
  bindCtx($('#gal'), '.card', (el) => {
    const c = s.chapters.find((x) => x.id === Number(el.dataset.id));
    if (!c) return [];
    const at = s.chapters.indexOf(c);
    return [
      { label: '▶ Read', run: () => { location.hash = `#/read/${c.id}`; } },
      { label: c.completed ? '↺ Mark unread' : '✓ Mark read', run: async () => { await mark([c.id], !c.completed); renderSeries(id); } },
      at > 0 ? { label: '✓ Mark everything up to here read', run: async () => { await mark(s.chapters.slice(0, at + 1).map((x) => x.id), true); renderSeries(id); } } : null,
      { sep: true },
      { label: '📂 Show in folder', run: () => revealFile('chapters', c.id) },
      { label: 'ⓘ Properties', run: async () => {
        const p = await api(`/chapters/${c.id}/properties`);
        openProperties(p.name, [
          ['Series', p.series], ['Volume', p.title], ['Type', p.type], ['Sections', p.pages], ['Size', fmtBytes(p.size)],
          ['Folder', p.folder], ['Modified', fmtDate(p.modified)],
          ['Read', p.read ? 'Yes' : p.page > 0 ? `In progress (section ${p.page + 1})` : 'No'],
          ['Status', p.exists ? '' : 'File not found at this location'],
        ], { base: 'chapters', id: c.id, path: p.path });
      } },
    ];
  });

  view.querySelector('.hero').addEventListener('click', (e) => {
    const more = e.target.closest('#moreTags');
    if (more) { view.querySelectorAll('.xtag').forEach((t) => t.classList.remove('hidden')); more.remove(); return; }
    const t = e.target.closest('[data-facet]'); if (!t) return;
    try { sessionStorage.setItem('ms.facet.novel', t.dataset.facet.replace(/^tags:/, '')); } catch { /* private mode */ }
  });
  $('#match').addEventListener('click', () => openMatchModal(s, () => renderSeries(id)));
  $('#refresh')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { await api(`/series/${id}/refresh`, { method: 'POST' }); renderSeries(id); } catch (err) { toast(err.message, true); e.target.disabled = false; }
  });
  $('#rescan').addEventListener('click', async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try {
      const r = await api(`/series/${id}/rescan`, { method: 'POST' });
      toast(`Rescanned: ${r.chapters} volume${r.chapters === 1 ? '' : 's'}${r.added ? ` · ${r.added} new` : ''}${r.removed ? ` · ${r.removed} gone` : ''}`);
      renderSeries(id);
    } catch (err) { b.disabled = false; toast(err.message, true); }
  });
  $('#markAll').addEventListener('click', async () => {
    await api(`/series/${id}/read-all`, { method: 'POST', body: { read: read !== s.chapters.length } });
    renderSeries(id);
  });
}

// ---------- reader ----------
async function renderNovelReader(ch) {
  document.body.classList.add('reading');
  $('#nav').classList.add('hidden');
  view.classList.add('hidden');

  const info = await api(`/novels/${ch.id}/info`);
  const sections = info.sections;
  const total = sections.length;
  if (!total) throw new Error('This EPUB has no readable sections');
  const resPath = (i) => `/api/novels/${ch.id}/res/${sections[i].split('/').map(encodeURIComponent).join('/')}`;

  let idx = Math.min(Math.max(0, ch.completed ? 0 : ch.page), total - 1);
  let restore = ch.completed ? 0 : (ch.pos || 0); // fraction of the section to scroll to once it has loaded
  let pendingFrag = '';
  let saveTimer = null;
  let ready = false;

  const ov = $('#overlay');
  ov.innerHTML = `
    <div class="reader nvr" id="nvr">
      <div class="rbar">
        <a class="btn small" href="#/series/${ch.series.id}" title="Back (Esc)">←</a>
        <div class="title"><b>${esc(ch.series.title)}</b> <span class="muted">· ${esc(ch.title)}</span></div>
        <span class="pg" id="nvPg"></span>
        <button class="btn small" id="nvToc" title="Contents">☰</button>
        <button class="btn small" id="nvPrevVol" ${ch.prevId ? '' : 'disabled'} title="Previous volume">⏮</button>
        <button class="btn small" id="nvNextVol" ${ch.nextId ? '' : 'disabled'} title="Next volume">⏭</button>
        <button class="btn small" id="nvGear" title="Reading settings">Aa</button>
      </div>
      <div id="nvPop"></div>
      <div class="rstage nv-stage" id="nvStage" tabindex="0">
        <iframe id="nvFrame" class="nv-frame" sandbox="allow-same-origin" title="${esc(ch.title)}"></iframe>
        <div class="nv-nav">
          <button class="btn" id="nvPrev">← Previous</button>
          <span class="muted" id="nvPos"></span>
          <button class="btn primary" id="nvNext">Next →</button>
        </div>
      </div>
      <div id="nvDrawer" class="nv-drawer hidden"></div>
    </div>`;
  const root = $('#nvr'), stage = $('#nvStage'), frame = $('#nvFrame');

  const theme = () => NV_THEMES[novelPrefs.theme] || NV_THEMES.dark;
  const paintShell = () => {
    const t = theme();
    root.style.setProperty('--nv-bg', t.bg);
    root.style.setProperty('--nv-fg', t.fg);
    root.dataset.nvTheme = novelPrefs.theme;
    stage.style.background = t.bg;
  };
  const paintDoc = () => {
    const doc = frame.contentDocument;
    if (!doc?.documentElement) return;
    const t = theme(), r = doc.documentElement.style;
    r.setProperty('--nv-bg', t.bg); r.setProperty('--nv-fg', t.fg); r.setProperty('--nv-link', t.link);
    r.setProperty('--nv-font', NV_FONTS[novelPrefs.font]?.[1] || NV_FONTS.serif[1]);
    r.setProperty('--nv-size', `${novelPrefs.size}px`);
    r.setProperty('--nv-lh', String(novelPrefs.lh));
    r.setProperty('--nv-width', `${novelPrefs.width}px`);
    r.setProperty('--nv-align', novelPrefs.justify ? 'justify' : 'left');
  };
  const fit = () => {
    const doc = frame.contentDocument;
    if (!doc?.documentElement) return;
    const body = doc.body;
    const h = Math.ceil(Math.max(body.scrollHeight, body.getBoundingClientRect().bottom + (doc.defaultView?.scrollY || 0)));
    frame.style.height = `${Math.max(h, stage.clientHeight - 90)}px`;
  };
  const frac = () => {
    const max = stage.scrollHeight - stage.clientHeight;
    return max > 4 ? Math.min(1, Math.max(0, stage.scrollTop / max)) : 1;
  };
  const scrollToFrac = (f) => { stage.scrollTop = f * Math.max(0, stage.scrollHeight - stage.clientHeight); };

  const label = () => {
    $('#nvPg').textContent = `${idx + 1} / ${total}`;
    $('#nvPos').textContent = `Section ${idx + 1} of ${total}`;
    $('#nvPrev').disabled = idx === 0;
    $('#nvNext').textContent = idx >= total - 1 ? '✓ Finish volume' : 'Next →';
  };

  const save = (extra = {}) => {
    clearTimeout(saveTimer);
    if (!ready) return Promise.resolve();
    const f = frac();
    const completed = idx >= total - 1 && f > 0.96;
    return api('/progress', { method: 'POST', body: { chapterId: ch.id, page: idx, pos: f, completed: completed || !!extra.completed } }).catch(() => {});
  };
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => save(), 700); };

  const open = (i, { frag = '', at = 0 } = {}) => {
    idx = Math.min(Math.max(0, i), total - 1);
    restore = at; pendingFrag = frag;
    ready = false;
    frame.style.visibility = 'hidden';
    frame.src = resPath(idx);
    label();
  };

  frame.addEventListener('load', () => {
    const doc = frame.contentDocument;
    if (!doc) return;
    paintDoc();
    doc.documentElement.style.overflow = 'hidden';
    fit();
    doc.addEventListener('load', () => { fit(); }, true); // images finishing
    try { new ResizeObserver(() => { fit(); }).observe(doc.body); } catch { /* old browser */ }
    doc.addEventListener('click', onDocClick);
    doc.addEventListener('keydown', onKey);
    requestAnimationFrame(() => {
      fit();
      if (pendingFrag) {
        const el = doc.getElementById(pendingFrag) || doc.getElementsByName(pendingFrag)[0];
        stage.scrollTop = el ? frame.offsetTop + el.getBoundingClientRect().top : 0;
      } else if (restore > 0) scrollToFrac(restore);
      else stage.scrollTop = 0;
      frame.style.visibility = 'visible';
      ready = true;
      saveSoon();
    });
  });

  function onDocClick(e) {
    const a = e.target.closest?.('a');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href') || '';
    if (/^(https?:|mailto:)/i.test(href)) { window.open(href, '_blank', 'noopener'); return; }
    let u;
    try { u = new URL(href, new URL(resPath(idx), location.origin)); } catch { return; }
    const prefix = `/api/novels/${ch.id}/res/`;
    const frag = decodeURIComponent(u.hash.replace(/^#/, ''));
    if (!u.pathname.startsWith(prefix)) return;
    const target = decodeURIComponent(u.pathname.slice(prefix.length));
    const i = sections.indexOf(target);
    if (i < 0) return;
    if (i === idx) {
      const el = frag && (frame.contentDocument.getElementById(frag) || frame.contentDocument.getElementsByName(frag)[0]);
      if (el) stage.scrollTop = frame.offsetTop + el.getBoundingClientRect().top;
      return;
    }
    open(i, { frag });
  }

  // --- navigation ---
  const volumeDone = async () => {
    await save({ completed: true });
    if (ch.nextId) location.hash = `#/read/${ch.nextId}`; else location.hash = `#/series/${ch.series.id}`;
  };
  const next = () => (idx >= total - 1 ? volumeDone() : (save().then(() => open(idx + 1))));
  const prev = () => (idx > 0 ? save().then(() => open(idx - 1)) : null);
  $('#nvNext').addEventListener('click', next);
  $('#nvPrev').addEventListener('click', prev);
  $('#nvPrevVol').addEventListener('click', () => ch.prevId && (location.hash = `#/read/${ch.prevId}`));
  $('#nvNextVol').addEventListener('click', () => ch.nextId && (location.hash = `#/read/${ch.nextId}`));
  stage.addEventListener('scroll', saveSoon, { passive: true });

  function onKey(e) {
    if (e.target?.matches?.('input, textarea, select')) return;
    if (e.key === 'Escape') {
      if (!$('#nvDrawer').classList.contains('hidden') || $('#nvPop').innerHTML) { $('#nvDrawer').classList.add('hidden'); $('#nvPop').innerHTML = ''; return; }
      save().then(() => { location.hash = `#/series/${ch.series.id}`; });
    } else if (e.key === 'ArrowRight' && !e.altKey) next();
    else if (e.key === 'ArrowLeft' && !e.altKey) prev();
  }
  window.addEventListener('keydown', onKey);

  // --- contents ---
  const drawer = $('#nvDrawer');
  const drawToc = () => {
    const toc = info.toc.length ? info.toc : sections.map((p, i) => ({ title: `Section ${i + 1}`, index: i, frag: '', depth: 0 }));
    let curAt = -1;
    toc.forEach((t, i) => { if (t.index <= idx) curAt = i; });
    drawer.innerHTML = `<div class="nv-drawer-in"><div class="viewbar"><b style="flex:1">Contents</b><button class="btn small" id="nvTocClose">✕</button></div>
      ${toc.map((t, i) => `<button class="nv-toc ${i === curAt ? 'cur' : ''}" data-i="${t.index}" data-f="${esc(t.frag)}" style="padding-left:${12 + t.depth * 16}px">${esc(t.title)}</button>`).join('')}</div>`;
    const cur = drawer.querySelector('.cur');
    cur?.scrollIntoView({ block: 'center' });
  };
  $('#nvToc').addEventListener('click', () => { drawer.classList.toggle('hidden'); if (!drawer.classList.contains('hidden')) drawToc(); });
  drawer.addEventListener('click', (e) => {
    if (e.target.id === 'nvTocClose' || e.target === drawer) { drawer.classList.add('hidden'); return; }
    const b = e.target.closest('.nv-toc'); if (!b) return;
    drawer.classList.add('hidden');
    save().then(() => open(Number(b.dataset.i), { frag: b.dataset.f }));
  });

  // --- reading settings ---
  const pop = $('#nvPop');
  const drawPop = () => {
    pop.innerHTML = `<div class="nv-pop">
      <div class="seg nv-themes">${Object.entries(NV_THEMES).map(([k, t]) => `<button data-theme="${k}" class="${novelPrefs.theme === k ? 'on' : ''}" style="background:${t.bg};color:${t.fg}">${t.name}</button>`).join('')}</div>
      <label>Font <select id="nvFont">${Object.entries(NV_FONTS).map(([k, f]) => `<option value="${k}" ${novelPrefs.font === k ? 'selected' : ''}>${f[0]}</option>`).join('')}</select></label>
      <label>Text size <span class="muted" id="nvSizeV">${novelPrefs.size}px</span><input type="range" id="nvSize" min="13" max="32" step="1" value="${novelPrefs.size}"></label>
      <label>Line spacing <span class="muted" id="nvLhV">${novelPrefs.lh}</span><input type="range" id="nvLh" min="1.2" max="2.4" step="0.05" value="${novelPrefs.lh}"></label>
      <label>Page width <span class="muted" id="nvWV">${novelPrefs.width}px</span><input type="range" id="nvW" min="420" max="1100" step="20" value="${novelPrefs.width}"></label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="nvJust" ${novelPrefs.justify ? 'checked' : ''}> Justify text</label>
    </div>`;
  };
  const apply = () => { saveNovelPrefs(); paintShell(); const f = frac(); paintDoc(); fit(); scrollToFrac(f); };
  $('#nvGear').addEventListener('click', () => { if (pop.innerHTML) pop.innerHTML = ''; else drawPop(); });
  pop.addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme]'); if (!b) return;
    novelPrefs.theme = b.dataset.theme; apply(); drawPop();
  });
  pop.addEventListener('input', (e) => {
    const v = e.target;
    if (v.id === 'nvFont') novelPrefs.font = v.value;
    else if (v.id === 'nvSize') { novelPrefs.size = Number(v.value); $('#nvSizeV').textContent = `${v.value}px`; }
    else if (v.id === 'nvLh') { novelPrefs.lh = Number(v.value); $('#nvLhV').textContent = v.value; }
    else if (v.id === 'nvW') { novelPrefs.width = Number(v.value); $('#nvWV').textContent = `${v.value}px`; }
    else if (v.id === 'nvJust') novelPrefs.justify = v.checked;
    else return;
    apply();
  });

  const onResize = () => fit();
  window.addEventListener('resize', onResize);
  cleanup = () => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    clearTimeout(saveTimer);
    if (ready) {
      const f = frac();
      fetch('/api/progress', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chapterId: ch.id, page: idx, pos: f, completed: idx >= total - 1 && f > 0.96 }) }).catch(() => {});
    }
  };

  paintShell();
  open(idx, { at: restore });
  stage.focus();
}

// ---------- settings ----------
function novelSettingsHtml(nv) {
  return `
    <div class="panel"><h2>Light novel section</h2>
      <p class="muted" style="margin-top:0">Folders of <b>.epub</b> files, kept separate from manga. Each folder becomes a series and every EPUB in it a volume
        (a single .epub also works). Details come from AniList, and reading happens right in the browser with your position remembered.</p>
      <div id="nvLibs">${nv.libraries.map((l) => `<div class="list-row"><span style="flex:1">${esc(l)}</span>
        <button class="btn small" data-scan="${esc(l)}" title="Check just this folder for new or changed files">↻ Scan</button>
        <button class="btn small danger" data-nvrm="${esc(l)}">Remove</button></div>`).join('') || '<div class="muted">No folders yet.</div>'}</div>
      <div class="form-row"><input type="text" id="newNv" placeholder="e.g. D:\\Light Novels"><button class="btn primary" id="addNv">Add folder</button></div>
    </div>`;
}

function bindNovelSettings(refresh, scanLib) {
  $('#nvLibs').addEventListener('click', scanLib);
  $('#nvLibs').addEventListener('click', async (e) => {
    const p = e.target.dataset.nvrm; if (!p) return;
    await api('/novels/libraries', { method: 'DELETE', body: { path: p } }); refresh(); refreshNav();
  });
  $('#addNv').addEventListener('click', async () => {
    try { await api('/novels/libraries', { method: 'POST', body: { path: $('#newNv').value } }); refresh(); refreshNav(); }
    catch (e) { toast(e.message, true); }
  });
}
