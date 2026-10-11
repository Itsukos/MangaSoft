/**
 * ASS/SSA subtitles -> WebVTT for the browser's own subtitle layer.
 *
 * ffmpeg's plain conversion keeps the raw typesetting as text: vector drawings ("m 1398.4 596.8 l 1643 595…"),
 * {comments}, karaoke tags and several stacked copies of one line. This converter instead:
 *   - drops drawing events (signs drawn as shapes) and every {override block} / {comment},
 *   - keeps italics / bold, line breaks, and where a line sits on screen (\pos, \an, \move),
 *   - merges identical events (the shadow / outline layers typesetters stack on top of each other).
 * Fully styled signs and karaoke are only faithful when the subtitles are burned in.
 */

const num = (s) => Number(s);

function parseTime(t) {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})[.:](\d{1,3})$/.exec(String(t).trim());
  if (!m) return null;
  const frac = m[4].length === 3 ? num(m[4]) / 1000 : num(m[4]) / (10 ** m[4].length);
  return num(m[1]) * 3600 + num(m[2]) * 60 + num(m[3]) + frac;
}

function vttTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Split "Dialogue: a,b,c,Text, with commas" into `count` fields (the last keeps its commas). */
function fields(line, count) {
  const out = [];
  let rest = line;
  for (let i = 0; i < count - 1; i++) {
    const at = rest.indexOf(',');
    if (at < 0) { out.push(rest); rest = ''; continue; }
    out.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  out.push(rest);
  return out;
}

export function assToVtt(source) {
  const lines = String(source).replace(/^﻿/, '').split(/\r?\n/);
  let section = '';
  let resX = 384, resY = 288;
  let styleFmt = [], eventFmt = [];
  const styles = new Map();
  const events = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) { section = sec[1].toLowerCase(); continue; }
    if (section === 'script info') {
      const m = /^(PlayResX|PlayResY)\s*:\s*(\d+)/i.exec(line);
      if (m) { if (m[1].toLowerCase() === 'playresx') resX = num(m[2]); else resY = num(m[2]); }
    } else if (section.includes('styles')) {
      if (/^format\s*:/i.test(line)) styleFmt = line.slice(line.indexOf(':') + 1).split(',').map((x) => x.trim().toLowerCase());
      else if (/^style\s*:/i.test(line) && styleFmt.length) {
        const v = fields(line.slice(line.indexOf(':') + 1).trim(), styleFmt.length);
        const row = Object.fromEntries(styleFmt.map((k, i) => [k, (v[i] ?? '').trim()]));
        styles.set(row.name, { align: num(row.alignment) || 2, italic: num(row.italic) !== 0 && row.italic !== '', bold: num(row.bold) !== 0 && row.bold !== '' });
      }
    } else if (section === 'events') {
      if (/^format\s*:/i.test(line)) eventFmt = line.slice(line.indexOf(':') + 1).split(',').map((x) => x.trim().toLowerCase());
      else if (/^dialogue\s*:/i.test(line) && eventFmt.length) {
        const v = fields(line.slice(line.indexOf(':') + 1).replace(/^\s/, ''), eventFmt.length);
        const row = Object.fromEntries(eventFmt.map((k, i) => [k, v[i] ?? '']));
        events.push(row);
      }
    }
  }

  const cues = [];
  const seen = new Set();
  for (const ev of events) {
    const start = parseTime(ev.start), end = parseTime(ev.end);
    if (start == null || end == null || end <= start) continue;
    const style = styles.get((ev.style || '').trim().replace(/^\*/, '')) || { align: 2, italic: false, bold: false };
    let an = style.align;
    let pos = null;
    let drawing = false;
    let clipped = false;
    let italic = style.italic, bold = style.bold;
    let text = '';
    let open = { i: false, b: false };
    const setFmt = () => {
      // keep <i>/<b> properly nested: close both, reopen what is on
      if (open.i || open.b) text += (open.i ? '</i>' : '') + (open.b ? '</b>' : '');
      open = { i: false, b: false };
      if (italic) { text += '<i>'; open.i = true; }
      if (bold) { text += '<b>'; open.b = true; }
    };
    let started = false;
    const body = String(ev.text ?? '');
    const re = /\{([^}]*)\}|([^{]+)|\{/g;
    let m;
    while ((m = re.exec(body))) {
      if (m[1] !== undefined) {
        // an override block; a block with no backslash is a comment
        const tags = m[1];
        let t;
        const tagRe = /\\(an|pos|move|iclip|clip|p|i|b)\s*(\([^)]*\)|-?[\d.]+)?/g;
        let changed = false;
        while ((t = tagRe.exec(tags))) {
          const [, name, arg] = t;
          if (name === 'clip' || name === 'iclip') clipped = true;
          else if (name === 'an' && arg) an = clamp(num(arg), 1, 9);
          else if (name === 'pos' || name === 'move') {
            const n = (arg || '').replace(/[()]/g, '').split(',').map((x) => num(x.trim()));
            if (n.length >= 2 && Number.isFinite(n[0]) && Number.isFinite(n[1])) pos = { x: n[0], y: n[1] };
          } else if (name === 'p') drawing = num(arg) > 0;
          else if (name === 'i' && arg !== undefined && !arg.startsWith('(')) { italic = num(arg) === 1; changed = true; }
          else if (name === 'b' && arg !== undefined && !arg.startsWith('(')) { bold = num(arg) === 1 || num(arg) >= 600; changed = true; }
        }
        if (changed && started) setFmt();
      } else if (m[2] !== undefined && !drawing) {
        if (!started) { started = true; setFmt(); }
        text += esc(m[2].replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' '));
      }
    }
    if (open.i || open.b) text += (open.i ? '</i>' : '') + (open.b ? '</b>' : '');
    const plain = text.replace(/<[^>]+>/g, '').replace(/&amp;|&lt;|&gt;/g, 'x').trim();
    if (!plain) continue;
    // a line of numbers and path letters is a drawing that slipped through without \p
    if (/^[mlbspnc\d\s.\-]+$/i.test(plain) && /\d/.test(plain) && /[ml]\s+-?\d/.test(plain)) continue;
    // typeset art: clipped reveals and one-letter pieces of an animated title are not readable on their own
    if (pos && (clipped || plain.length <= 2)) continue;
    text = text.split('\n').map((l) => l.trim()).filter(Boolean).join('\n').replace(/-->/g, '- >');
    const key = `${start.toFixed(2)}|${end.toFixed(2)}|${text}`;
    if (seen.has(key)) continue; // outline / shadow copies of the same line
    seen.add(key);

    const col = (an - 1) % 3; // 0 left, 1 centre, 2 right
    const rowKind = an <= 3 ? 'bottom' : an <= 6 ? 'middle' : 'top';
    const set = [];
    if (pos && resX > 0 && resY > 0) {
      const x = clamp(pos.x / resX * 100, 0, 100), y = clamp(pos.y / resY * 100, 0, 100);
      set.push(`line:${y.toFixed(1)}%`, `line-align:${rowKind === 'bottom' ? 'end' : rowKind === 'middle' ? 'center' : 'start'}`);
      const size = col === 1 ? Math.min(100, 2 * Math.min(x, 100 - x)) : col === 0 ? 100 - x : x;
      set.push(`position:${x.toFixed(1)}%`, `size:${clamp(size, 12, 100).toFixed(0)}%`);
      set.push(`align:${col === 0 ? 'left' : col === 2 ? 'right' : 'center'}`);
    } else if (rowKind === 'top') set.push('line:6%', 'line-align:start');
    else if (rowKind === 'middle') set.push('line:50%', 'line-align:center');
    cues.push({ start, end, text, set: set.join(' ') });
  }

  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  const out = ['WEBVTT', ''];
  for (const c of cues) {
    out.push(`${vttTime(c.start)} --> ${vttTime(c.end)}${c.set ? ' ' + c.set : ''}`, c.text, '');
  }
  return out.join('\n');
}
