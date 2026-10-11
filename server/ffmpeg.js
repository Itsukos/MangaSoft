import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Find a working binary: explicit env var, then one on PATH (apt / Docker), then the bundled npm one. */
function locate(envVar, name, bundled) {
  const works = (bin) => {
    try { return spawnSync(bin, ['-version'], { timeout: 8000, windowsHide: true }).status === 0; } catch { return false; }
  };
  const candidates = [process.env[envVar], name, bundled()].filter(Boolean);
  return candidates.find(works) || null;
}

const ffmpegPath = locate('FFMPEG_PATH', 'ffmpeg', () => { try { return require('ffmpeg-static'); } catch { return null; } });
const ffprobePath = locate('FFPROBE_PATH', 'ffprobe', () => { try { return require('@ffprobe-installer/ffprobe').path; } catch { return null; } });

function capture(bin, args) {
  try { return spawnSync(bin, args, { timeout: 15000, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).stdout || ''; }
  catch { return ''; }
}

const info = { ffmpeg: ffmpegPath, ffprobe: ffprobePath, version: null, libass: false, encoders: [] };
if (ffmpegPath) {
  info.version = (capture(ffmpegPath, ['-version']).match(/version (\S+)/) || [])[1] || null;
  info.libass = /\bsubtitles\b/.test(capture(ffmpegPath, ['-hide_banner', '-filters']));
  const enc = capture(ffmpegPath, ['-hide_banner', '-encoders']);
  info.encoders = ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox'].filter((e) => new RegExp(`\\s${e}\\s`).test(enc));
}

export const ffInfo = () => ({ ...info });
export const ready = () => !!(info.ffmpeg && info.ffprobe);

/** Run a binary to completion, collecting output. Rejects with the tail of stderr on a non-zero exit. */
export function run(bin, args, { cwd, timeout = 0, maxOut = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, windowsHide: true });
    const out = []; let outLen = 0, err = '';
    let timer = timeout ? setTimeout(() => p.kill('SIGKILL'), timeout) : null;
    p.stdout.on('data', (d) => { if (outLen < maxOut) { out.push(d); outLen += d.length; } });
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(Object.assign(new Error(err.trim().split('\n').slice(-3).join(' | ') || `exit ${code}`), { code }));
    });
  });
}

/** Small concurrency gate so a page full of thumbnails does not start dozens of ffmpeg processes. */
export function gate(limit) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= limit || !waiting.length) return;
    active++;
    waiting.shift()();
  };
  return (fn) => new Promise((resolve, reject) => {
    waiting.push(() => Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); }));
    next();
  });
}

export async function probe(file) {
  if (!info.ffprobe) throw new Error('ffprobe is not available');
  const buf = await run(info.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', file], { timeout: 60000 });
  const j = JSON.parse(buf.toString('utf8'));
  const f = j.format || {};
  const streams = (j.streams || []).map((s) => ({
    index: s.index, type: s.codec_type, codec: s.codec_name, profile: s.profile || null,
    lang: (s.tags?.language || '').toLowerCase() || null, title: s.tags?.title || null,
    default: !!s.disposition?.default, forced: !!s.disposition?.forced,
    width: s.width || null, height: s.height || null, pixFmt: s.pix_fmt || null,
    channels: s.channels || null, bits: Number(s.bits_per_raw_sample) || null,
    attached: !!s.disposition?.attached_pic,
  }));
  let duration = Number(f.duration) || 0;
  if (!duration) duration = Math.max(0, ...(j.streams || []).map((s) => Number(s.duration) || 0));
  return {
    duration, container: f.format_name || '', size: Number(f.size) || null, bitrate: Number(f.bit_rate) || null,
    startTime: Number(f.start_time) || 0,
    streams,
    chapters: (j.chapters || []).map((c) => ({ start: Number(c.start_time), end: Number(c.end_time), title: c.tags?.title || '' })),
  };
}
