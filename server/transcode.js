import fs from 'node:fs';
import { assToVtt } from './asssub.js';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DATA_DIR, db, getSetting } from './db.js';
import { ffInfo, run, gate, probe as ffprobe } from './ffmpeg.js';

/**
 * Playback: direct play for browser-friendly files, otherwise HLS made on the fly by ffmpeg.
 * - "remux": H.264 is copied untouched into keyframe-aligned segments (cheap, original quality).
 * - "transcode": video is re-encoded on a fixed 6 s grid (HEVC / 10-bit / burned-in subtitles / smaller size).
 * The playlist lists every segment up front, so seeking works anywhere: a request for a segment that
 * is not there yet restarts ffmpeg at that point (the same idea Jellyfin uses).
 */

export const SEG = 6;
const ROOT = path.join(DATA_DIR, 'transcode');
fs.rmSync(ROOT, { recursive: true, force: true }); // leftovers of a previous run
fs.mkdirSync(ROOT, { recursive: true });

// ffmpeg processes that outlived a crashed/killed server would keep encoding whole files: stop them at startup
const PID_FILE = path.join(DATA_DIR, 'ffmpeg-pids.json');
const livePids = new Set();
const writePids = () => { try { fs.writeFileSync(PID_FILE, JSON.stringify([...livePids])); } catch { /* best effort */ } };
(function reapOrphans() {
  let pids = [];
  try { pids = JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); } catch { /* none */ }
  for (const pid of pids) {
    try {
      const name = process.platform === 'win32'
        ? spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }).stdout
        : spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).stdout;
      if (/ffmpeg/i.test(name || '')) process.kill(pid, 'SIGKILL');
    } catch { /* already gone */ }
  }
  try { fs.rmSync(PID_FILE, { force: true }); } catch { /* ignore */ }
})();

const TEXT_SUBS = new Set(['ass', 'ssa', 'subrip', 'srt', 'webvtt', 'mov_text', 'text', 'microdvd', 'sami', 'subviewer']);
const exists = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- tracks ----------

const LANG = { jpn: 'Japanese', ja: 'Japanese', eng: 'English', en: 'English', spa: 'Spanish', es: 'Spanish', fre: 'French', fra: 'French',
  fr: 'French', ger: 'German', deu: 'German', de: 'German', ita: 'Italian', por: 'Portuguese', pt: 'Portuguese', rus: 'Russian',
  chi: 'Chinese', zho: 'Chinese', kor: 'Korean', ara: 'Arabic', ind: 'Indonesian', und: 'Unknown' };
const langName = (l) => (l ? LANG[l] || l.toUpperCase() : 'Unknown');

export function sidecarSubs(file) {
  const dir = path.dirname(file), stem = path.basename(file, path.extname(file));
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => /\.(srt|ass|ssa|vtt)$/i.test(n) && n.toLowerCase().startsWith(stem.toLowerCase()))
    .sort()
    .map((n) => {
      const tag = n.slice(stem.length).replace(/\.(srt|ass|ssa|vtt)$/i, '').replace(/^[. _-]+/, '');
      return { file: path.join(dir, n), name: n, lang: tag.split(/[. _-]/)[0].toLowerCase() || null, tag };
    });
}

/** Audio and subtitle choices as the player shows them (ordinals are per type, matching ffmpeg's 0:a:N / 0:s:N). */
export function tracksOf(probe, file) {
  const audio = probe.streams.filter((s) => s.type === 'audio').map((s, ord) => ({
    ord, lang: s.lang, codec: s.codec, channels: s.channels, default: s.default,
    label: [langName(s.lang), s.title && !/^audio$/i.test(s.title) ? s.title : '', s.channels > 2 ? `${s.channels - 1}.1` : '', s.codec?.toUpperCase()].filter(Boolean).join(' · '),
  }));
  const internal = probe.streams.filter((s) => s.type === 'subtitle');
  const subs = internal.map((s, ord) => ({
    ord, lang: s.lang, codec: s.codec, text: TEXT_SUBS.has(s.codec), forced: s.forced, default: s.default, external: false,
    label: [langName(s.lang), s.title || '', s.forced ? 'forced' : '', TEXT_SUBS.has(s.codec) ? '' : `(${s.codec}, image)`].filter(Boolean).join(' · '),
  }));
  sidecarSubs(file).forEach((x, j) => subs.push({
    ord: internal.length + j, lang: x.lang, codec: path.extname(x.name).slice(1).toLowerCase(), text: true, forced: false, default: false,
    external: true, label: [langName(x.lang), x.tag && x.tag !== x.lang ? x.tag : '', 'external file'].filter(Boolean).join(' · '),
  }));
  return { audio, subs };
}

// ---------- decisions ----------

const DIRECT_EXT = new Set(['.mp4', '.m4v', '.webm']);
const DIRECT_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis']);

export function videoOf(probe) {
  return probe.streams.find((s) => s.type === 'video' && !s.attached) || null;
}

/** Can the browser play the file itself (no ffmpeg at all)? Only with the file's own first audio track and no burn-in. */
export function canDirectPlay(probe, file) {
  const v = videoOf(probe);
  if (!v || !DIRECT_EXT.has(path.extname(file).toLowerCase())) return false;
  const vOk = (v.codec === 'h264' && (!v.pixFmt || v.pixFmt === 'yuv420p')) || ['vp8', 'vp9', 'av1'].includes(v.codec);
  const a = probe.streams.filter((s) => s.type === 'audio');
  return vOk && (!a.length || DIRECT_AUDIO.has(a[0].codec));
}

const canRemux = (probe) => {
  const v = videoOf(probe);
  return !!v && v.codec === 'h264' && (!v.pixFmt || v.pixFmt === 'yuv420p');
};

// A burned-in style travels in the key as "<size>_<text rrggbb>_<outline 0-3>_<shadow 0-3>_<n | box rrggbb>_<box opacity>"
const STYLE_RE = /^(\d{2,3})_([0-9a-f]{6})_([0-3])_([0-3])_(n|[0-9a-f]{6})_(\d{1,3})$/;
export const parseStyle = (s) => {
  const m = STYLE_RE.exec(String(s || ''));
  return m ? { size: Math.min(250, Math.max(50, +m[1])), color: m[2], outline: +m[3], shadow: +m[4], bg: m[5], bgOpacity: Math.min(100, +m[6]) } : null;
};

export function makeKey({ audio = 0, sub = null, burn = false, height = 0, mode = 't', style = null }) {
  return `a${audio}-s${sub ?? 'n'}-b${burn ? 1 : 0}-h${height}-m${mode}${style ? `-y${style}` : ''}`;
}
export function parseKey(key) {
  const m = /^a(\d{1,2})-s(\d{1,3}|n)-b([01])-h(\d{0,4})-m([rt])(?:-y([0-9a-f_n]{14,26}))?$/.exec(key);
  if (!m) return null;
  const style = m[6] ? parseStyle(m[6]) : null;
  if (m[6] && !style) return null;
  return { audio: +m[1], sub: m[2] === 'n' ? null : +m[2], burn: m[3] === '1', height: +m[4] || 0, mode: m[5], style };
}

/** libass force_style for a chosen look; sizes are relative to the script's own resolution. */
function forceStyle(st, resY) {
  const bgr = (hex) => (hex.slice(4, 6) + hex.slice(2, 4) + hex.slice(0, 2)).toUpperCase();
  const col = (hex, alpha = 0) => `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${bgr(hex)}&`;
  const size = Math.round(resY * 0.07 * st.size / 100);
  const parts = [`FontSize=${size}`, `PrimaryColour=${col(st.color)}`];
  if (st.bg !== 'n') {
    parts.push('BorderStyle=3', `OutlineColour=${col(st.bg, Math.round(255 - st.bgOpacity * 2.55))}`, 'Outline=3', 'Shadow=0', 'BackColour=&HFF000000&');
  } else {
    parts.push('BorderStyle=1', 'OutlineColour=&H00000000&', `Outline=${st.outline}`, `Shadow=${st.shadow}`, 'BackColour=&H99000000&');
  }
  return parts.join(',');
}

/** Pick remux or transcode for the requested options. */
export function modeFor(probe, { burn, height, forceTranscode }) {
  return !forceTranscode && !burn && !height && canRemux(probe) ? 'r' : 't';
}

// ---------- keyframes (for remuxing) ----------

const kfGate = gate(2);

export async function keyframesOf(ep) {
  if (ep.kf) { try { return JSON.parse(ep.kf); } catch { /* recompute */ } }
  const bin = ffInfo().ffprobe;
  const buf = await kfGate(() => run(bin, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,dts_time,flags', '-of', 'csv=p=0', ep.path], { timeout: 10 * 60 * 1000, maxOut: 256 * 1024 * 1024 }));
  const times = [];
  for (const line of buf.toString('utf8').split('\n')) {
    const p = line.trim().split(',');
    if (p.length < 3 || !p[2].includes('K')) continue;
    const t = parseFloat(p[0]) || parseFloat(p[1]);
    if (Number.isFinite(t)) times.push(Math.max(0, Math.round(t * 1000) / 1000));
  }
  times.sort((a, b) => a - b);
  const uniq = times.filter((t, i) => i === 0 || t - times[i - 1] > 0.001);
  db.prepare('UPDATE episodes SET kf = ? WHERE id = ?').run(JSON.stringify(uniq), ep.id);
  return uniq;
}

/** Segment start times for a mode. Remux cuts only where the source has keyframes. */
export function boundaries(mode, duration, keyframes) {
  if (mode === 'r' && keyframes?.length) {
    const b = [0];
    let last = 0;
    for (const t of keyframes) {
      if (t - last >= SEG - 0.25 && t < duration - 0.5) { b.push(t); last = t; }
    }
    return b;
  }
  const n = Math.max(1, Math.ceil(duration / SEG));
  return Array.from({ length: n }, (_, i) => i * SEG);
}

export function playlist(bounds, duration) {
  const durs = bounds.map((s, i) => (i + 1 < bounds.length ? bounds[i + 1] : duration) - s);
  const target = Math.ceil(Math.max(SEG, ...durs));
  return ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD',
    ...durs.flatMap((d, i) => [`#EXTINF:${Math.max(0.001, d).toFixed(3)},`, `${i}.ts`]), '#EXT-X-ENDLIST', ''].join('\n');
}

// ---------- subtitles (extract once, reuse for burn-in and for soft tracks) ----------

const subGate = gate(2);
const subJobs = new Map();

function subDir(ep) {
  const d = path.join(ROOT, 'subs', `${ep.id}-${ep.mtime || 0}`);
  fs.mkdirSync(path.join(d, 'fonts'), { recursive: true });
  return d;
}

/** Fonts embedded in the file (anime ASS styles rely on them). Best effort, once per episode. */
export function ensureFonts(ep, probe) {
  const dir = subDir(ep);
  const marker = path.join(dir, 'fonts', '.done');
  if (exists(marker)) return Promise.resolve(dir);
  const key = `fonts:${ep.id}`;
  if (subJobs.has(key)) return subJobs.get(key);
  const p = (async () => {
    if (probe.streams.some((s) => s.type === 'attachment') || /matroska/.test(probe.container)) {
      // ffmpeg dumps attachments, then complains that no output was given: that error is expected
      await run(ffInfo().ffmpeg, ['-y', '-hide_banner', '-loglevel', 'quiet', '-dump_attachment:t', '', '-i', ep.path], { cwd: path.join(dir, 'fonts'), timeout: 120000 }).catch(() => {});
    }
    fs.writeFileSync(marker, '1');
    return dir;
  })().finally(() => subJobs.delete(key));
  subJobs.set(key, p);
  return p;
}

/** Make sub-<ord>.ass (and .vtt on demand) for a text subtitle track. Returns the directory that holds it. */
export async function textSub(ep, probe, ord) {
  const { subs } = tracksOf(probe, ep.path);
  const t = subs[ord];
  if (!t || !t.text) throw Object.assign(new Error('That subtitle track cannot be read as text'), { status: 400 });
  const dir = await ensureFonts(ep, probe);
  const out = path.join(dir, `sub-${ord}.ass`);
  if (exists(out)) return dir;
  const key = `sub:${ep.id}:${ord}`;
  if (subJobs.has(key)) { await subJobs.get(key); return dir; }
  const internalCount = probe.streams.filter((s) => s.type === 'subtitle').length;
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  if (t.external) args.push('-i', sidecarSubs(ep.path)[ord - internalCount].file);
  else args.push('-i', ep.path, '-map', `0:s:${ord}`);
  args.push('-c:s', 'ass', out + '.tmp.ass');
  const p = subGate(() => run(ffInfo().ffmpeg, args, { timeout: 5 * 60 * 1000 }))
    .then(() => fs.renameSync(out + '.tmp.ass', out))
    .finally(() => subJobs.delete(key));
  subJobs.set(key, p);
  await p;
  return dir;
}

export async function vttFor(ep, probe, ord) {
  const dir = await textSub(ep, probe, ord);
  const vtt = path.join(dir, `sub-${ord}.v2.vtt`);
  if (!exists(vtt)) {
    // our own converter: drops vector drawings / comments / stacked copies and keeps where lines sit
    const text = fs.readFileSync(path.join(dir, `sub-${ord}.ass`), 'utf8');
    fs.writeFileSync(vtt + '.tmp', assToVtt(text));
    fs.renameSync(vtt + '.tmp', vtt);
  }
  return vtt;
}

// ---------- sessions & jobs ----------

const sessions = new Map(); // `${epId}/${key}` -> session
const MAX_JOBS = 3;

function encoderArgs(enc) {
  switch (enc) {
    case 'h264_nvenc': return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-profile:v', 'high'];
    case 'h264_qsv': return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '23'];
    case 'h264_amf': return ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '22', '-qp_p', '24'];
    case 'h264_videotoolbox': return ['-c:v', 'h264_videotoolbox', '-b:v', '6M'];
    default: return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-profile:v', 'high', '-level', '4.2'];
  }
}

export function getSession(ep, probe, key, opts, bounds) {
  const id = `${ep.id}/${key}`;
  let s = sessions.get(id);
  if (!s) {
    const dir = path.join(ROOT, `${ep.id}-${key}`);
    fs.mkdirSync(dir, { recursive: true });
    s = { id, ep, probe, key, opts, bounds, dir, job: null, lastUsed: Date.now(), cpuOnly: false };
    sessions.set(id, s);
  }
  s.lastUsed = Date.now();
  return s;
}

function killJob(job) {
  if (job && !job.exited) { try { job.proc.kill('SIGKILL'); } catch { /* gone */ } }
}

async function buildArgs(s, n) {
  const { ep, probe, opts, bounds } = s;
  const info = ffInfo();
  const start = bounds[n];
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  // -ss counts from the file's first timestamp (often slightly negative); landing exactly on a keyframe
  // needs that offset added, or ffmpeg picks the keyframe before it
  if (start > 0) args.push('-ss', (opts.mode === 'r' ? start + 0.002 - Math.min(0, probe.startTime ?? -0.1) : start).toFixed(3));
  args.push('-i', ep.path, '-map_chapters', '-1', '-sn', '-dn');
  const aud = probe.streams.filter((x) => x.type === 'audio');
  // cut points: absolute times (the muxer sees them after -output_ts_offset), a hair early so the keyframe itself
  // qualifies. The muxer indexes the list by segment number, so it always holds every segment's end, from the first.
  const times = [];
  for (let i = 1; i < bounds.length; i++) times.push((bounds[i] - 0.02).toFixed(3));
  let cwd = s.dir;

  if (opts.mode === 'r') {
    args.push('-map', '0:v:0', '-c:v', 'copy');
  } else {
    const vf = [];
    let complex = null;
    const sub = opts.burn && opts.sub != null ? tracksOf(probe, ep.path).subs[opts.sub] : null;
    if (sub && sub.text) {
      cwd = await textSub(ep, probe, opts.sub);
      let forced = '';
      if (opts.style) {
        let resY = 288;
        try { resY = Number(/PlayResY\s*:\s*(\d+)/i.exec(fs.readFileSync(path.join(cwd, `sub-${opts.sub}.ass`), 'utf8').slice(0, 4000))?.[1]) || 288; } catch { /* default */ }
        forced = `:force_style='${forceStyle(opts.style, resY)}'`;
      }
      vf.push(`setpts=PTS+${start.toFixed(3)}/TB`, `subtitles=sub-${opts.sub}.ass:fontsdir=fonts${forced}`, 'setpts=PTS-STARTPTS');
    } else if (sub && !sub.external) {
      complex = `[0:v:0][0:s:${opts.sub}]overlay[ov]`; // image subtitles (PGS / VobSub)
    }
    if (opts.height) vf.push(`scale=-2:'min(${opts.height},ih)'`);
    vf.push('format=yuv420p');
    const enc = s.cpuOnly ? 'libx264' : (getSetting('anime_encoder', 'libx264'));
    if (complex) {
      args.push('-filter_complex', `${complex};[ov]${vf.join(',')}[v]`, '-map', '[v]');
    } else {
      args.push('-map', '0:v:0', '-vf', vf.join(','));
    }
    args.push(...encoderArgs(info.encoders.includes(enc) ? enc : 'libx264'), '-force_key_frames', `expr:gte(t,n_forced*${SEG})`);
  }
  if (aud.length) {
    args.push('-map', `0:a:${Math.min(opts.audio, aud.length - 1)}`, '-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  }
  args.push('-output_ts_offset', String(start), '-f', 'segment', '-segment_format', 'mpegts', '-segment_start_number', String(n),
    '-segment_times', times.length ? times.join(',') : '9999999', '-reset_timestamps', '0', path.join(s.dir, '%d.ts'));
  return { args, cwd };
}

async function startJob(s, n) {
  if (s.job && !s.job.exited) {
    killJob(s.job);
    await Promise.race([s.job.done, sleep(4000)]); // its half-written segment is removed on exit
  }
  // cap concurrent encodes: stop the least recently used other session
  const running = [...sessions.values()].filter((x) => x !== s && x.job && !x.job.exited).sort((a, b) => a.lastUsed - b.lastUsed);
  while (running.length >= MAX_JOBS) killJob(running.shift().job);

  const { args, cwd } = await buildArgs(s, n);
  // from here on every segment >= n comes from this job (older leftovers would be indistinguishable from half-written ones)
  for (const f of fs.readdirSync(s.dir)) {
    const m = /^(\d+)\.ts$/.exec(f);
    if (m && +m[1] >= n) fs.rmSync(path.join(s.dir, f), { force: true });
  }
  const proc = spawn(ffInfo().ffmpeg, args, { cwd, windowsHide: true });
  const job = { proc, start: n, exited: false, code: null, err: '' };
  if (proc.pid) { livePids.add(proc.pid); writePids(); }
  job.done = new Promise((resolve) => {
    proc.stderr.on('data', (d) => { job.err = (job.err + d).slice(-3000); });
    proc.on('error', (e) => { job.exited = true; job.code = -1; job.err += e.message; resolve(); });
    proc.on('close', (code) => {
      job.exited = true; job.code = code;
      if (proc.pid) { livePids.delete(proc.pid); writePids(); }
      if (code !== 0) { // killed mid-write: the newest segment is incomplete
        const last = job.start + produced(s, job) - 1;
        if (last >= job.start) fs.rmSync(segFile(s, last), { force: true });
      }
      resolve();
    });
  });
  s.job = job;
  return job;
}

const segFile = (s, n) => path.join(s.dir, `${n}.ts`);

/** A segment is finished once the next one exists (or ffmpeg has ended). */
function complete(s, job, n) {
  if (!exists(segFile(s, n))) return false;
  return exists(segFile(s, n + 1)) || (!!job?.exited && job.code === 0);
}

function produced(s, job) {
  let k = job.start;
  while (exists(segFile(s, k))) k++;
  return k - job.start;
}

/** The running job if it will reach segment n soon, otherwise a fresh one starting there (one start at a time per session). */
async function jobFor(s, n) {
  while (s.lock) await s.lock.catch(() => {});
  const j = s.job;
  if (j && !j.exited && n >= j.start && n <= j.start + produced(s, j) + 3) return j;
  s.lock = startJob(s, n);
  try { return await s.lock; } finally { s.lock = null; }
}

export async function ensureSegment(s, n) {
  if (n < 0 || n >= s.bounds.length) return null;
  s.lastUsed = Date.now();
  s.lastSeg = n;
  for (let attempt = 0; attempt < 2; attempt++) {
    // a segment finished earlier stays valid (half-written ones are removed when their job is stopped)
    const cur = s.job;
    if (exists(segFile(s, n)) && (exists(segFile(s, n + 1)) || !cur || (cur.exited && cur.code === 0))) return segFile(s, n);
    const job = await jobFor(s, n);

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      s.lastUsed = Date.now();
      if (complete(s, job, n)) return segFile(s, n);
      if (job.exited) {
        await sleep(60); // let the filesystem settle
        if (exists(segFile(s, n))) return segFile(s, n);
        break;
      }
      await sleep(60);
    }
    // a hardware encoder that fails to start: fall back to the CPU once
    const failedFast = job.exited && job.code !== 0 && produced(s, job) === 0;
    if (failedFast && !s.cpuOnly && s.opts.mode === 't' && getSetting('anime_encoder', 'libx264') !== 'libx264') {
      s.cpuOnly = true;
      continue;
    }
    if (job.exited && job.code !== 0) throw new Error(`ffmpeg: ${job.err.trim().split('\n').slice(-2).join(' | ') || `exit ${job.code}`}`);
    killJob(job);
    return null;
  }
  return null;
}

const AHEAD = 30;  // segments an encoder may run in front of the player before it is stopped (restarted on demand)
const KEEP_BEHIND = 40;

// keep disk use and CPU in check while someone watches
setInterval(() => {
  for (const s of sessions.values()) {
    if (s.lastSeg == null) continue;
    const j = s.job;
    if (j && !j.exited && j.start + produced(s, j) > s.lastSeg + AHEAD) killJob(j);
    let names = [];
    try { names = fs.readdirSync(s.dir); } catch { continue; }
    for (const f of names) {
      const m = /^(d+).ts$/.exec(f);
      if (m && +m[1] < s.lastSeg - KEEP_BEHIND && !(j && !j.exited && +m[1] >= j.start)) fs.rmSync(path.join(s.dir, f), { force: true });
    }
  }
}, 5000).unref();

// idle housekeeping: stop encoders nobody is watching, drop old output
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.job && !s.job.exited && now - s.lastUsed > 90_000) killJob(s.job);
    if (now - s.lastUsed > 20 * 60_000) {
      killJob(s.job);
      sessions.delete(id);
      fs.rm(s.dir, { recursive: true, force: true }, () => {});
    }
  }
}, 30_000).unref();

export function stopAll() {
  for (const s of sessions.values()) killJob(s.job);
}
process.on('exit', stopAll);

// ---------- thumbnails ----------

const thumbGate = gate(2);
const THUMBS = path.join(DATA_DIR, 'thumbs');
fs.mkdirSync(THUMBS, { recursive: true });

export async function thumbFor(ep, { width = 480 } = {}) {
  const out = path.join(THUMBS, `ep-${ep.id}-${ep.mtime || 0}-${width}.jpg`);
  if (exists(out)) return out;
  const at = ep.duration ? Math.min(Math.max(ep.duration * 0.2, 5), ep.duration - 1) : 60;
  await thumbGate(() => run(ffInfo().ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, at)), '-i', ep.path,
    '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '5', out + '.tmp.jpg'], { timeout: 60000 }));
  fs.renameSync(out + '.tmp.jpg', out);
  return out;
}

export { ffprobe };
