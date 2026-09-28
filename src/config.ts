import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

export const VERSION = '0.1.0';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const EDITS_ONLY_BYTES = 2 * 1024 ** 3;
/** Batas jumlah file sebelum workspace pindah ke mode edits-only. Bisa diubah untuk tes. */
export const editsOnlyFiles = () => Number(process.env.TURNBACK_MAX_FILES || 100_000);

export const LOCK_TIMEOUT_MS = 30_000;
export const LOCK_STALE_MS = 60_000;
export const WARM_WAIT_MS = 30_000;
export const GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const RETENTION = { days: 7, turns: 50 };

/** Direktori yang bisa dibangun ulang, tidak pernah di-snapshot atau disentuh restore. */
export const EXCLUDED_DIRS = new Set([
  '.git', '.turnback', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build',
  'target', '.next', '.nuxt', '.cache', 'coverage', '.turbo', '.gradle',
]);

export const dataHome = () => process.env.TURNBACK_HOME || path.join(homedir(), '.turnback');

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** Kunci path yang stabil lintas penulisan (Windows: huruf kecil, garis miring maju). */
export function pathKey(p: string): string {
  const abs = path.resolve(p);
  return process.platform === 'win32' ? abs.replaceAll('\\', '/').toLowerCase() : abs;
}

const roots = new Map<string, string>();

/** Root workspace: toplevel git kalau ada, selain itu cwd. */
export function workspaceRoot(cwd: string): string {
  const cached = roots.get(cwd);
  if (cached) return cached;
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 1500 });
  const root = path.resolve(r.status === 0 ? r.stdout.trim() : cwd);
  roots.set(cwd, root);
  return root;
}

/** Folder data Turnback untuk satu workspace. */
export const workspaceDataDir = (root: string) => path.join(dataHome(), sha256(pathKey(root)).slice(0, 24));

export function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
