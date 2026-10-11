import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import StreamZip from 'node-stream-zip';
import { DATA_DIR, getSetting } from './db.js';

/**
 * Self-update from an update server (see update-server/). Flow:
 *   check  -> GET <url>/latest.json
 *   stage  -> download zip, verify sha256 AND an Ed25519 signature made with the publisher's private key,
 *             unpack to data/updates/staging
 *   apply  -> exit(75); the supervisor (run.js) swaps program files, restarts, and rolls back on failure
 * Media folders and the data folder are never part of an update.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(here, '..');
const UPD = path.join(DATA_DIR, 'updates');
const RESTART_CODE = 75;

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return d; } };
export const currentVersion = readJson(path.join(APP_DIR, 'package.json'), {}).version || '0.0.0';
const publicKey = (() => { try { return crypto.createPublicKey(fs.readFileSync(path.join(here, 'update-public.pem'))); } catch { return null; } })();
export const supervised = process.env.MANGASOFT_SUPERVISED === '1';

const state = { checking: false, available: null, lastChecked: null, error: null, stage: 'idle', progress: 0 };

export function updateUrl() {
  const raw = getSetting('update_url') || process.env.MANGASOFT_UPDATE_URL || readJson(path.join(here, 'update-config.json'), {}).url || '';
  return String(raw).trim().replace(/\/latest\.json$/i, '').replace(/\/+$/, '');
}

const cmp = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
};

export function status() {
  const failed = readJson(path.join(UPD, 'failed.json'));
  return {
    version: currentVersion, url: updateUrl(), autoUpdate: getSetting('auto_update', true),
    available: state.available, lastChecked: state.lastChecked, error: state.error, stage: state.stage, progress: state.progress,
    supervised, signed: !!publicKey,
    failedVersion: failed?.version || null, failedReason: failed?.reason || null,
  };
}

export async function check() {
  const base = updateUrl();
  if (!base) { state.error = 'No update server set'; state.available = null; return status(); }
  if (state.checking) return status();
  state.checking = true;
  try {
    const res = await fetch(`${base}/latest.json`, { headers: { 'User-Agent': `MangaSoft/${currentVersion}` }, signal: AbortSignal.timeout(15000) });
    if (res.status === 404) { // the server is fine, the publisher just hasn't released anything yet
      state.available = null;
      state.error = null;
      return status();
    }
    if (!res.ok) throw new Error(`Update server answered ${res.status}`);
    const info = await res.json();
    if (!/^\d+\.\d+\.\d+$/.test(info.version) || !/^[A-Za-z0-9._-]+\.zip$/.test(info.file || '')
      || !/^[a-f0-9]{64}$/.test(info.sha256 || '') || !info.signature) throw new Error('Update server returned an invalid release record');
    state.available = cmp(info.version, currentVersion) > 0 ? info : null;
    state.error = null;
  } catch (e) {
    state.error = `Could not check for updates: ${e.message}`;
  } finally {
    state.checking = false;
    state.lastChecked = Date.now();
  }
  return status();
}

/** Download, verify and unpack the available release. Throws on any problem; nothing is changed until restart. */
export async function stage() {
  const info = state.available;
  if (!info) throw new Error('No update available');
  if (!publicKey) throw new Error('This build has no update signing key, so it cannot verify updates');
  if (!supervised) throw new Error('MangaSoft was not started through its launcher, so it cannot restart itself. Start it with start.bat, the tray app, or Docker.');
  state.stage = 'downloading'; state.progress = 0;
  try {
    await fsp.mkdir(UPD, { recursive: true });
    const res = await fetch(`${updateUrl()}/releases/${info.file}`, { headers: { 'User-Agent': `MangaSoft/${currentVersion}` } });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const chunks = []; let got = 0;
    for await (const c of res.body) {
      chunks.push(c); got += c.length;
      if (got > 200 * 1024 * 1024) throw new Error('Update is unexpectedly large');
      state.progress = info.size ? Math.min(1, got / info.size) : 0;
    }
    const buf = Buffer.concat(chunks);

    state.stage = 'verifying';
    if (crypto.createHash('sha256').update(buf).digest('hex') !== info.sha256) throw new Error('Download is corrupted (checksum mismatch)');
    if (!crypto.verify(null, buf, publicKey, Buffer.from(info.signature, 'base64'))) {
      throw new Error('Update signature is not valid - refusing to install');
    }

    const zipFile = path.join(UPD, info.file);
    const dir = path.join(UPD, 'staging');
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.writeFile(zipFile, buf);
    const zip = new StreamZip.async({ file: zipFile });
    try {
      for (const e of Object.values(await zip.entries())) {
        const n = e.name.replace(/\\/g, '/');
        if (n.startsWith('/') || n.split('/').includes('..') || /^[a-z]:/i.test(n)) throw new Error('Update contains an unsafe path');
      }
      await fsp.mkdir(dir, { recursive: true });
      await zip.extract(null, dir);
    } finally { await zip.close().catch(() => {}); }
    await fsp.rm(zipFile, { force: true });

    const pkg = readJson(path.join(dir, 'package.json'), {});
    if (pkg.version !== info.version || !fs.existsSync(path.join(dir, 'server', 'index.js')) || !fs.existsSync(path.join(dir, 'public', 'index.html'))) {
      throw new Error('Update package is incomplete');
    }
    await fsp.writeFile(path.join(UPD, 'staged.json'), JSON.stringify({ version: info.version, dir, at: Date.now() }));
    state.stage = 'ready';
  } catch (e) {
    state.stage = 'idle';
    await fsp.rm(path.join(UPD, 'staging'), { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

/** Stage the update, then exit so the supervisor can swap files and restart. */
export async function installNow() {
  await stage();
  setTimeout(() => process.exit(RESTART_CODE), 800);
}

/** Called once the new version has been up for a while: it is considered good, so drop the pending marker. */
export function confirmBoot() {
  const pending = path.join(UPD, 'pending.json');
  if (!fs.existsSync(pending)) return;
  setTimeout(() => { fsp.rm(pending, { force: true }).catch(() => {}); }, 25_000).unref?.();
}

/** Background check every few hours; installs by itself only when enabled and the server is idle. */
export function startScheduler(isIdle) {
  const tick = async () => {
    if (!updateUrl()) return;
    await check();
    const a = state.available;
    if (!a || !getSetting('auto_update', true) || !supervised) return;
    if (status().failedVersion === a.version) return; // that version failed on this machine before
    if (state.stage !== 'idle' || !isIdle()) return;
    try { await installNow(); } catch (e) { state.error = `Update failed: ${e.message}`; }
  };
  setTimeout(tick, 45_000).unref?.();
  setInterval(tick, 6 * 3600 * 1000).unref?.();
}
