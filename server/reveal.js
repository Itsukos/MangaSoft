import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** True when the request comes from this very machine (the file manager would open on the right screen). */
export function isLocalRequest(req) {
  const a = req.socket?.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/** Open the system file manager with the file selected (or the folder opened). */
export function reveal(file) {
  try {
    const isDir = fs.statSync(file).isDirectory();
    let cmd, args;
    if (process.platform === 'win32') { cmd = 'explorer.exe'; args = isDir ? [file] : [`/select,${file}`]; }
    else if (process.platform === 'darwin') { cmd = 'open'; args = isDir ? [file] : ['-R', file]; }
    else { cmd = 'xdg-open'; args = [isDir ? file : path.dirname(file)]; }
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    p.on('error', () => { /* no file manager here */ });
    p.unref();
    return true;
  } catch { return false; }
}
