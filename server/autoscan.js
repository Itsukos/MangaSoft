import fs from 'node:fs';
import path from 'node:path';
import { getSetting, setSetting } from './db.js';

/**
 * Automatic scanning of the library folders (manga, doujin and anime):
 *   - on a timer (every N minutes), and
 *   - when files change in a folder (a short quiet period after the last change, so a big copy is scanned once).
 * File-change events only work reliably for local disks; the timer is the safety net for network shares.
 */

export const DEFAULTS = { enabled: true, minutes: 60, watch: true };

export const settings = () => ({ ...DEFAULTS, ...(getSetting('auto_scan', {}) || {}) });

export function saveSettings(patch) {
  const cur = settings();
  const next = { ...cur };
  if ('enabled' in patch) next.enabled = !!patch.enabled;
  if ('watch' in patch) next.watch = !!patch.watch;
  if ('minutes' in patch) {
    const m = Math.round(Number(patch.minutes));
    if (!Number.isFinite(m) || m < 5 || m > 7 * 24 * 60) throw Object.assign(new Error('Pick between 5 minutes and 7 days'), { status: 400 });
    next.minutes = m;
  }
  setSetting('auto_scan', next);
  return next;
}

const QUIET_MS = 20_000;
let api = null;
const watchers = new Map(); // folder -> FSWatcher
const timers = new Map(); // folder -> debounce timer
let lastRun = Date.now();
let lastReason = null;

const libraries = () => [...getSetting('libraries', []), ...getSetting('doujin_libraries', []), ...getSetting('anime_libraries', []), ...getSetting('novel_libraries', [])]
  .map((p) => path.resolve(p));

const idle = () => !api.scanState.running && !api.busy();

function trigger(lib) {
  clearTimeout(timers.get(lib));
  const go = () => {
    timers.delete(lib);
    if (!settings().enabled) return;
    if (!idle()) { timers.set(lib, setTimeout(go, 30_000)); return; } // something else is running: try again shortly
    lastRun = Date.now();
    lastReason = 'files changed';
    api.runScan({ library: lib });
  };
  timers.set(lib, setTimeout(go, QUIET_MS));
}

/** Start or stop file watchers so they match the folders and settings. */
function sync() {
  const s = settings();
  const want = new Set(s.enabled && s.watch ? libraries() : []);
  for (const [lib, w] of watchers) {
    if (want.has(lib)) continue;
    try { w.close(); } catch { /* gone */ }
    watchers.delete(lib);
  }
  for (const lib of want) {
    if (watchers.has(lib)) continue;
    try {
      const w = fs.watch(lib, { recursive: true, persistent: false }, (_ev, name) => {
        const n = String(name || '');
        if (/(^|[\\/])\./.test(n) || /\.(tmp|part|crdownload|!qb|filepart)$/i.test(n)) return; // hidden / unfinished files
        trigger(lib);
      });
      w.on('error', () => { try { w.close(); } catch { /* gone */ } watchers.delete(lib); });
      watchers.set(lib, w);
    } catch { /* this folder cannot be watched (offline, or not supported here): the timer still covers it */ }
  }
}

export function status() {
  const s = settings();
  return {
    ...s, watching: watchers.size, folders: libraries().length,
    lastScan: api?.scanState.result?.at || null, lastReason,
  };
}

/** Called once at startup. runScan / scanState from the scanner; busy() says whether something else is working. */
export function startAutoScan({ runScan, scanState, busy = () => false }) {
  api = { runScan, scanState, busy };
  const tick = () => {
    try { sync(); } catch { /* ignore */ }
    const s = settings();
    if (!s.enabled) return;
    const last = Math.max(lastRun, scanState.result?.at || 0);
    if (Date.now() - last >= s.minutes * 60_000 && idle()) {
      lastRun = Date.now();
      lastReason = 'timer';
      runScan();
    }
  };
  setTimeout(tick, 5_000).unref?.();
  setInterval(tick, 60_000).unref?.();
}

/** Re-read the settings now (after the user changed them). */
export function reconfigure() {
  try { sync(); } catch { /* ignore */ }
}
