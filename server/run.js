import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Supervisor: runs the server as a child process so updates can be applied safely between runs.
 *
 *  - child exits 75  -> an update was staged (data/updates/staged.json): swap the program files, restart
 *  - new version crashes within 45s of starting -> restore the backup and start the old version
 *  - anything else   -> exit with the same code (so Docker / the tray notice a real failure)
 *
 * Only program files are ever replaced (see ITEMS). The data folder, node_modules and your media
 * folders are never touched.
 */

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.MANGASOFT_DATA || path.join(APP, 'data');
const UPD = path.join(DATA, 'updates');
const STAGED = path.join(UPD, 'staged.json');
const PENDING = path.join(UPD, 'pending.json');
const FAILED = path.join(UPD, 'failed.json');
const RESTART_CODE = 75;
const ITEMS = ['server', 'public', 'package.json', 'package-lock.json', 'README.md', 'start.bat', 'tray.ps1', 'MangaSoft.vbs'];

const log = (...a) => console.log('[supervisor]', ...a);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });

function moveItem(from, to) {
  rmrf(to);
  try { fs.renameSync(from, to); } catch { fs.cpSync(from, to, { recursive: true }); rmrf(from); }
}

function copyItems(srcDir, dstDir) {
  for (const it of ITEMS) {
    const s = path.join(srcDir, it);
    if (!fs.existsSync(s)) continue;
    const d = path.join(dstDir, it);
    rmrf(d);
    fs.cpSync(s, d, { recursive: true });
  }
}

const depsOf = (dir) => {
  const p = readJson(path.join(dir, 'package.json'));
  return JSON.stringify([p?.dependencies || {}, p?.optionalDependencies || {}]);
};

function npmInstall() {
  log('dependencies changed - running npm install');
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: APP, stdio: 'inherit', shell: process.platform === 'win32',
  });
  return r.status === 0;
}

function rollback(reason) {
  const pending = readJson(PENDING);
  if (!pending?.backup || !fs.existsSync(pending.backup)) { log('no backup to restore'); rmrf(PENDING); return false; }
  log(`rolling back to ${pending.from}: ${reason}`);
  const newDeps = depsOf(APP);
  copyItems(pending.backup, APP);
  if (depsOf(APP) !== newDeps) npmInstall();
  fs.writeFileSync(FAILED, JSON.stringify({ version: pending.to, reason, at: Date.now() }));
  rmrf(PENDING);
  return true;
}

function applyStaged() {
  const staged = readJson(STAGED);
  rmrf(STAGED);
  if (!staged?.dir || !fs.existsSync(staged.dir)) { log('staged update missing - continuing with current version'); return; }
  const from = readJson(path.join(APP, 'package.json'))?.version || '?';
  const backup = path.join(UPD, 'backup', from);
  try {
    rmrf(path.join(UPD, 'backup'));
    fs.mkdirSync(backup, { recursive: true });
    copyItems(APP, backup);

    const oldDeps = depsOf(APP);
    for (const it of ITEMS) {
      const s = path.join(staged.dir, it);
      if (fs.existsSync(s)) moveItem(s, path.join(APP, it));
    }
    fs.writeFileSync(PENDING, JSON.stringify({ from, to: staged.version, backup, at: Date.now() }));
    if (depsOf(APP) !== oldDeps && !npmInstall()) { rollback('npm install failed'); return; }
    log(`updated ${from} -> ${staged.version}`);
  } catch (e) {
    log('update failed while applying:', e.message);
    if (!rollback(e.message)) copyItems(backup, APP);
  } finally {
    rmrf(staged.dir);
  }
}

let child = null;
let startedAt = 0;
let stopping = false;

function start() {
  startedAt = Date.now();
  child = spawn(process.execPath, ['--no-warnings', path.join(APP, 'server', 'index.js')], {
    stdio: 'inherit',
    env: { ...process.env, MANGASOFT_SUPERVISED: '1' },
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) process.exit(code ?? 0);
    if (code === RESTART_CODE) {
      if (fs.existsSync(STAGED)) applyStaged();
      return start();
    }
    if (code !== 0 && fs.existsSync(PENDING) && Date.now() - startedAt < 45_000) {
      if (rollback(`new version exited with code ${code} shortly after starting`)) return start();
    }
    process.exit(code ?? (signal ? 1 : 0));
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stopping = true; if (child) child.kill(sig); else process.exit(0); });
}

fs.mkdirSync(UPD, { recursive: true });
if (fs.existsSync(STAGED)) applyStaged(); // an update was staged but the process was stopped before swapping
start();
